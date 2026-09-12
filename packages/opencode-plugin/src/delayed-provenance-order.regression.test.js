import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDelegationContext } from "../.opencode/lib/delegation-context.js";
import { loadRawEventSpoolEntries } from "../.opencode/lib/raw-event-spool.js";
import { createCodememRuntime } from "../.opencode/lib/runtime.js";
import { __v1AdapterTestUtils } from "../.opencode/plugins/codemem.js";

const promptText = "Inspect retry ownership and report observed findings.";

function captureContext() {
	return {
		version: 1,
		host: "opencode-v1",
		origin: "delegated_brief",
		parent_session_id: "parent",
		child_session_id: "child",
		task_call_id: "task-call",
		message_id: "prompt-message",
		requested_agent: "explore",
		current_agent: "explore",
		brief_sha256: createHash("sha256").update(promptText).digest("hex"),
	};
}

function stubRuntimeEnvironment(homeDir, runner) {
	for (const [key, value] of Object.entries({
		HOME: homeDir,
		CODEMEM_RAW_EVENTS: "1",
		CODEMEM_VIEWER: "0",
		CODEMEM_VIEWER_AUTO: "0",
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
		CODEMEM_RUNNER: runner,
	})) {
		vi.stubEnv(key, value);
	}
}

async function createRuntime(homeDir, resolveCaptureContext, runner = "/usr/bin/true") {
	stubRuntimeEnvironment(homeDir, runner);
	return createCodememRuntime({
		location: {
			project: { name: "delayed-provenance", root: homeDir },
			directory: homeDir,
			worktree: homeDir,
		},
		host: { log: async () => undefined, notify: null, resolveCaptureContext },
	});
}

async function addPromptMessage(runtime, id, text, sessionID = "child") {
	const partID = id === "prompt-message" ? "prompt-part" : `${id}-part`;
	await runtime.handleEvent({
		type: "message.updated",
		sessionID,
		messageInfo: {
			id,
			sessionID,
			role: "user",
			agent: "explore",
			time: { created: 201 },
		},
	});
	await runtime.handleEvent({
		type: "message.part.updated",
		sessionID,
		part: {
			id: partID,
			messageID: id,
			sessionID,
			type: "text",
			text,
		},
	});
}

async function addPrompt(runtime) {
	await addPromptMessage(runtime, "prompt-message", promptText);
}

async function closePrompt(runtime, id, sessionID = "child") {
	await runtime.handleEvent({
		type: "message.updated",
		sessionID,
		messageInfo: { id, sessionID, role: "assistant" },
	});
}

async function capturePrompt(runtime, index) {
	await addPromptMessage(runtime, `prompt-${index}`, `Prompt ${index}`);
	await closePrompt(runtime, `boundary-${index}`);
}

async function addAssistant(runtime) {
	await runtime.handleEvent({
		type: "message.part.updated",
		sessionID: "child",
		part: {
			id: "assistant-part",
			messageID: "assistant-message",
			sessionID: "child",
			type: "text",
			text: "The queue retains retry ownership.",
		},
	});
	await runtime.handleEvent({
		type: "message.updated",
		sessionID: "child",
		messageInfo: {
			id: "assistant-message",
			sessionID: "child",
			role: "assistant",
			finish: "stop",
		},
	});
}

async function addToolResult(
	runtime,
	{ id = "tool-call", path = "src/queue.ts", sessionID = "child" } = {},
) {
	await runtime.handleToolResult(
		{
			sessionID,
			id,
			tool: "read",
			args: { filePath: path },
		},
		{ output: "Retry ownership remains in the pending queue.", error: null },
	);
}

function stubSuccessfulViewer(posted) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			if (init?.method === "POST") posted.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ ingest: { available: true } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
}

function statusResponse() {
	return new Response(JSON.stringify({ ingest: { available: true } }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function stubBlockedDeliveries(posted, blockedDeliveries, { failedPost = null } = {}) {
	let postCount = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			if (init?.method !== "POST") return statusResponse();
			postCount++;
			const blocked = blockedDeliveries[postCount - 1];
			if (blocked) {
				blocked.started.resolve();
				await blocked.release.promise;
			}
			if (postCount === failedPost) throw new Error("viewer unavailable");
			posted.push(JSON.parse(init.body));
			return statusResponse();
		}),
	);
}

function stubBlockedFirstDelivery(posted, blocked) {
	stubBlockedDeliveries(posted, [blocked]);
}

function stubSecondDeliveryFailure(posted, blocked) {
	stubBlockedDeliveries(posted, [null, blocked], { failedPost: 2 });
}

async function createDelayedOrderFixture() {
	const homeDir = await mkdtemp(join(tmpdir(), "codemem-delayed-order-"));
	const resolution = Promise.withResolvers();
	const resolveCaptureContext = vi.fn(() => resolution.promise);
	const posted = [];
	stubSuccessfulViewer(posted);
	const runtime = await createRuntime(homeDir, resolveCaptureContext);
	return { homeDir, resolution, resolveCaptureContext, posted, runtime };
}

async function createDeferredBoundaryFailureFixture() {
	const homeDir = await mkdtemp(join(tmpdir(), "codemem-deferred-owner-"));
	const blocked = [
		{ started: Promise.withResolvers(), release: Promise.withResolvers() },
		{ started: Promise.withResolvers(), release: Promise.withResolvers() },
	];
	stubBlockedDeliveries([], blocked, { failedPost: 2 });
	const runtime = await createRuntime(homeDir, undefined, "/usr/bin/false");
	await runtime.handleEvent({ type: "session.created", sessionID: "session-a" });
	await addToolResult(runtime, {
		id: "active-tool",
		path: "src/active-a.ts",
		sessionID: "session-a",
	});
	const activeFlush = runtime.handleEvent({ type: "session.idle", sessionID: "session-a" });
	await blocked[0].started.promise;
	await addToolResult(runtime, {
		id: "deferred-tool",
		path: "src/deferred-a.ts",
		sessionID: "session-a",
	});
	return { activeFlush, blocked, homeDir, runtime };
}

function createHangingDelegation() {
	const readSession = vi.fn(async () => new Promise(() => {}));
	const readMessage = vi.fn(async () => new Promise(() => {}));
	const delegation = createDelegationContext({
		readSession,
		readMessage,
		now: () => 200,
	});
	delegation.observe({
		type: "message.part.updated",
		properties: {
			part: {
				type: "tool",
				tool: "task",
				callID: "task-call",
				sessionID: "parent",
				state: {
					status: "running",
					time: { start: 200 },
					input: {
						subagent_type: "explore",
						description: "Inspect retries",
						prompt: promptText,
					},
					metadata: { parentSessionId: "parent", sessionId: "child" },
				},
			},
		},
	});
	return { delegation, readSession, readMessage };
}

function stubUnavailableViewer() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			if (init?.method === "GET") {
				return new Response(JSON.stringify({ ingest: { available: true } }), { status: 200 });
			}
			throw new Error("viewer unavailable");
		}),
	);
}

async function createSpoolFallbackFixture() {
	const homeDir = await mkdtemp(join(tmpdir(), "codemem-delayed-disposal-"));
	const metadata = createHangingDelegation();
	stubUnavailableViewer();
	const runtime = await createRuntime(homeDir, metadata.delegation.resolve, "/usr/bin/false");
	return { homeDir, runtime, ...metadata };
}

function createPromptSnapshot() {
	return {
		info: {
			id: "prompt-message",
			sessionID: "child",
			role: "user",
			agent: "explore",
			time: { created: 201 },
		},
		parts: [
			{
				id: "prompt-part",
				messageID: "prompt-message",
				sessionID: "child",
				type: "text",
				text: promptText,
			},
		],
	};
}

function observeDelegatedPrompt(delegation, snapshot) {
	delegation.observe({
		type: "message.part.updated",
		properties: {
			part: {
				type: "tool",
				tool: "task",
				callID: "task-call",
				sessionID: "parent",
				state: {
					status: "running",
					time: { start: 200 },
					input: {
						subagent_type: "explore",
						description: "Inspect retries",
						prompt: promptText,
					},
					metadata: { parentSessionId: "parent", sessionId: "child" },
				},
			},
		},
	});
	delegation.observePrompt(
		{ sessionID: "child", messageID: "prompt-message", agent: "explore" },
		{ message: snapshot.info, parts: snapshot.parts },
	);
}

function terminalTaskEvent(status) {
	return {
		type: "message.part.updated",
		properties: {
			part: {
				type: "tool",
				tool: "task",
				callID: "task-call",
				sessionID: "parent",
				state: { status, input: {}, error: status === "error" ? "task failed" : null },
			},
		},
	};
}

async function createDeletionOrderFixture() {
	const homeDir = await mkdtemp(join(tmpdir(), "codemem-deletion-order-"));
	const snapshot = createPromptSnapshot();
	const delegation = createDelegationContext({
		requirePromptSnapshot: true,
		readSession: async () => ({ id: "child", parentID: "parent" }),
		readMessage: async () => snapshot,
		now: () => 200,
	});
	observeDelegatedPrompt(delegation, snapshot);
	const posted = [];
	stubSuccessfulViewer(posted);
	const runtime = await createRuntime(homeDir, delegation.resolve);
	return { delegation, homeDir, posted, runtime };
}

async function createBlockedFlushFixture() {
	const homeDir = await mkdtemp(join(tmpdir(), "codemem-flush-rotation-"));
	const blocked = { started: Promise.withResolvers(), release: Promise.withResolvers() };
	const posted = [];
	stubBlockedFirstDelivery(posted, blocked);
	const runtime = await createRuntime(homeDir);
	return { blocked, homeDir, posted, runtime };
}

async function createPartialFailureFixture() {
	const homeDir = await mkdtemp(join(tmpdir(), "codemem-flush-partial-"));
	const blocked = { started: Promise.withResolvers(), release: Promise.withResolvers() };
	const posted = [];
	stubSecondDeliveryFailure(posted, blocked);
	const runtime = await createRuntime(homeDir, undefined, "/usr/bin/false");
	return { blocked, homeDir, runtime };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("raw-event ordering with delayed delegated provenance", () => {
	it("keeps the prompt before concurrent assistant and tool events", async () => {
		// Arrange
		const fixture = await createDelayedOrderFixture();
		const { homeDir, posted, resolution, resolveCaptureContext, runtime } = fixture;

		try {
			await addPrompt(runtime);

			// Act
			const promptBoundary = runtime.handleEvent({
				type: "message.updated",
				sessionID: "child",
				messageInfo: { id: "assistant-start", sessionID: "child", role: "assistant" },
			});
			const assistantEvents = addAssistant(runtime);
			const toolEvent = addToolResult(runtime);
			resolution.resolve(captureContext());
			await Promise.all([promptBoundary, assistantEvents, toolEvent]);
			await vi.waitFor(() => expect(posted).toHaveLength(3));

			// Assert
			expect(resolveCaptureContext).toHaveBeenCalledOnce();
			const events = posted.map((envelope) => ({
				type: envelope.event_type,
				identityPreserved: envelope.event_id === envelope.payload._raw_event_id,
				promptNumber: envelope.payload.prompt_number ?? null,
			}));
			expect(events[0]).toEqual({
				type: "user_prompt",
				identityPreserved: true,
				promptNumber: 1,
			});
			expect(events.slice(1).sort((left, right) => left.type.localeCompare(right.type))).toEqual([
				{ type: "assistant_message", identityPreserved: true, promptNumber: null },
				{ type: "tool.execute.after", identityPreserved: true, promptNumber: null },
			]);
		} finally {
			resolution.resolve(null);
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("V1 deletion ordering with delegated provenance", () => {
	it("captures a pending child prompt before parent deletion closes its binding", async () => {
		const fixture = await createDeletionOrderFixture();
		const { delegation, homeDir, posted, runtime } = fixture;

		try {
			await addPrompt(runtime);
			await __v1AdapterTestUtils.dispatchV1Event(delegation, runtime, {
				type: "session.deleted",
				properties: { info: { id: "parent" } },
			});
			await vi.waitFor(() => expect(posted).toHaveLength(1));

			expect(posted[0].capture_context).toMatchObject({
				origin: "delegated_brief",
				task_call_id: "task-call",
				message_id: "prompt-message",
			});
		} finally {
			delegation.dispose();
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("V1 terminal task ordering with delegated provenance", () => {
	it.each(["completed", "error"])(
		"captures a pending child prompt before a %s task update closes its binding",
		async (status) => {
			const fixture = await createDeletionOrderFixture();
			const { delegation, homeDir, posted, runtime } = fixture;

			try {
				await addPrompt(runtime);
				await __v1AdapterTestUtils.dispatchV1Event(delegation, runtime, terminalTaskEvent(status));
				await vi.waitFor(() =>
					expect(posted.some((envelope) => envelope.event_type === "user_prompt")).toBe(true),
				);

				const prompt = posted.find((envelope) => envelope.event_type === "user_prompt");
				expect(prompt?.capture_context).toMatchObject({
					origin: "delegated_brief",
					task_call_id: "task-call",
					message_id: "prompt-message",
				});
			} finally {
				delegation.dispose();
				await runtime.dispose();
				await rm(homeDir, { recursive: true, force: true });
			}
		},
	);
});

describe("detached raw-event flush ownership", () => {
	it("rotates context before blocked delivery and preserves newer activity", async () => {
		const fixture = await createBlockedFlushFixture();
		const { blocked, homeDir, posted, runtime } = fixture;
		try {
			await addPromptMessage(runtime, "old-prompt", "Old batch prompt");
			await closePrompt(runtime, "old-boundary");
			await blocked.started.promise;

			await addPromptMessage(runtime, "new-prompt", "/new next task");
			await closePrompt(runtime, "new-boundary");
			await addToolResult(runtime);

			expect(runtime.inspectSessionContext()).toEqual({
				firstPrompt: "/new next task",
				promptCount: 1,
				toolCount: 1,
				filesModified: [],
				filesRead: ["src/queue.ts"],
			});
			blocked.release.resolve();
			await vi.waitFor(() => expect(posted).toHaveLength(3));
			expect(runtime.inspectSessionContext().promptCount).toBe(1);
		} finally {
			blocked.release.resolve();
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("bounded raw-event delivery", () => {
	it("does not retain deliveries beyond the configured in-memory hard cap", async () => {
		// Arrange
		vi.stubEnv("CODEMEM_PLUGIN_MAX_EVENTS", "2");
		vi.stubEnv("CODEMEM_RAW_EVENTS_HARD_MAX", "2");
		const fixture = await createBlockedFlushFixture();
		const { blocked, homeDir, posted, runtime } = fixture;
		try {
			await addToolResult(runtime, { id: "tool-1" });
			await blocked.started.promise;

			// Act
			for (let index = 2; index <= 5; index++) {
				await addToolResult(runtime, { id: `tool-${index}` });
			}
			expect(runtime.inspectRawEventDeliveryCount()).toBe(2);
			blocked.release.resolve();
			await vi.waitFor(() => expect(runtime.inspectRawEventDeliveryCount()).toBe(0));

			// Assert
			expect(posted).toHaveLength(2);
			expect(runtime.inspectQueuedEventTypes()).toEqual([
				"tool.execute.after",
				"tool.execute.after",
			]);
		} finally {
			blocked.release.resolve();
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("admits an older capacity-deferred event before newer capture", async () => {
		vi.stubEnv("CODEMEM_PLUGIN_MAX_EVENTS", "2");
		vi.stubEnv("CODEMEM_RAW_EVENTS_HARD_MAX", "2");
		const fixture = await createBlockedFlushFixture();
		const { blocked, homeDir, posted, runtime } = fixture;
		try {
			await addToolResult(runtime, { id: "tool-1" });
			await blocked.started.promise;
			await addToolResult(runtime, { id: "tool-2" });
			await addToolResult(runtime, { id: "tool-3" });

			blocked.release.resolve();
			await vi.waitFor(() => expect(runtime.inspectRawEventDeliveryCount()).toBe(0));
			await addToolResult(runtime, { id: "tool-4" });
			await runtime.handleEvent({ type: "session.idle", sessionID: "child" });
			await vi.waitFor(() => expect(posted).toHaveLength(4));

			expect(posted.map((envelope) => envelope.payload.tool_call_id)).toEqual([
				"tool-1",
				"tool-2",
				"tool-3",
				"tool-4",
			]);
		} finally {
			blocked.release.resolve();
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("bounded detached raw-event flushes", () => {
	it("keeps at most one detached flush batch while delivery is blocked", async () => {
		// Arrange
		const fixture = await createBlockedFlushFixture();
		const { blocked, homeDir, posted, runtime } = fixture;
		const flushes = [];
		try {
			await addToolResult(runtime, { id: "tool-1" });
			flushes.push(runtime.handleEvent({ type: "session.idle", sessionID: "child" }));
			await blocked.started.promise;

			// Act
			for (let index = 2; index <= 5; index++) {
				await addToolResult(runtime, { id: `tool-${index}` });
				flushes.push(runtime.handleEvent({ type: "session.idle", sessionID: "child" }));
			}

			// Assert
			expect(runtime.inspectFlushingBatchCount()).toBe(1);
			blocked.release.resolve();
			await Promise.all(flushes);
			expect(posted).toHaveLength(5);
			expect(runtime.inspectQueuedEventTypes()).toEqual([]);
		} finally {
			blocked.release.resolve();
			await Promise.all(flushes);
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("bounds retained session-boundary batches while delivery is blocked", async () => {
		// Arrange
		vi.stubEnv("CODEMEM_PLUGIN_MAX_EVENTS", "2");
		vi.stubEnv("CODEMEM_RAW_EVENTS_HARD_MAX", "2");
		const fixture = await createBlockedFlushFixture();
		const { blocked, homeDir, runtime } = fixture;
		const boundaryFlushes = [];
		let activeFlush;
		try {
			await runtime.handleEvent({ type: "session.created", sessionID: "session-0" });
			await addToolResult(runtime, { id: "active-tool", sessionID: "session-0" });
			activeFlush = runtime.handleEvent({ type: "session.idle", sessionID: "session-0" });
			await blocked.started.promise;

			// Act
			for (let index = 1; index <= 5; index++) {
				const owner = `session-${index - 1}`;
				await addToolResult(runtime, { id: `boundary-tool-${index}`, sessionID: owner });
				boundaryFlushes.push(
					runtime.handleEvent({ type: "session.created", sessionID: `session-${index}` }),
				);
				await vi.waitFor(() => expect(runtime.inspectQueuedEventTypes()).toEqual([]));
			}
			await addToolResult(runtime, { id: "live-tool", sessionID: "session-5" });

			// Assert
			const retained = runtime.inspectPendingBoundaryEvents();
			expect(retained.length + runtime.inspectQueuedEvents().length).toBe(2);
			expect(retained.every((event) => event.owner === event.sessionID)).toBe(true);
		} finally {
			blocked.release.resolve();
			await Promise.all([activeFlush, ...boundaryFlushes].filter(Boolean));
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("raw-event session boundaries", () => {
	it("captures the prior session's final pending prompt before creating the next session", async () => {
		// Arrange
		const homeDir = await mkdtemp(join(tmpdir(), "codemem-pending-boundary-prompt-"));
		const posted = [];
		stubSuccessfulViewer(posted);
		const runtime = await createRuntime(homeDir);
		try {
			await runtime.handleEvent({ type: "session.created", sessionID: "session-a" });
			await addPromptMessage(runtime, "final-prompt", "Session A final prompt", "session-a");

			// Act
			await runtime.handleEvent({ type: "session.created", sessionID: "session-b" });
			await closePrompt(runtime, "session-a-boundary", "session-a");
			await addToolResult(runtime, { id: "session-b-tool", sessionID: "session-b" });
			await vi.waitFor(() => expect(posted).toHaveLength(2));

			// Assert
			const prompts = posted.filter((envelope) => envelope.event_type === "user_prompt");
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).toMatchObject({
				session_stream_id: "session-a",
				payload: { prompt_text: "Session A final prompt" },
			});
			expect(runtime.inspectSessionContext()).toMatchObject({
				firstPrompt: null,
				promptCount: 0,
				toolCount: 1,
			});
		} finally {
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("resets old context when deactivated before boundary detachment", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "codemem-deactivated-boundary-"));
		stubSuccessfulViewer([]);
		const runtime = await createRuntime(homeDir);
		try {
			await runtime.handleEvent({ type: "session.created", sessionID: "session-a" });
			await addToolResult(runtime, {
				id: "session-a-tool",
				path: "src/session-a.ts",
				sessionID: "session-a",
			});

			const boundary = runtime.handleEvent({ type: "session.created", sessionID: "session-b" });
			runtime.deactivate();
			await boundary;

			expect(runtime.inspectSessionContext()).toEqual({
				firstPrompt: null,
				promptCount: 0,
				toolCount: 0,
				filesModified: [],
				filesRead: [],
			});
		} finally {
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("raw-event session start ownership", () => {
	it("preserves session start during deferred boundary delivery", async () => {
		// Arrange
		const homeDir = await mkdtemp(join(tmpdir(), "codemem-deferred-session-start-"));
		const blocked = [
			{ started: Promise.withResolvers(), release: Promise.withResolvers() },
			{ started: Promise.withResolvers(), release: Promise.withResolvers() },
		];
		const posted = [];
		stubBlockedDeliveries(posted, blocked);
		const runtime = await createRuntime(homeDir);
		let boundaryFlush;
		let firstFlush;
		let toISOString;
		try {
			await addToolResult(runtime, { id: "tool-1" });
			firstFlush = runtime.handleEvent({ type: "session.idle", sessionID: "child" });
			await blocked[0].started.promise;
			await addToolResult(runtime, { id: "tool-2" });

			// Act
			const sessionStartObserved = Promise.withResolvers();
			const originalToISOString = Date.prototype.toISOString;
			toISOString = vi.spyOn(Date.prototype, "toISOString").mockImplementation(function () {
				const timestamp = originalToISOString.call(this);
				sessionStartObserved.resolve(timestamp);
				return timestamp;
			});
			boundaryFlush = runtime.handleEvent({ type: "session.created", sessionID: "next" });
			const newSessionStartedAt = await sessionStartObserved.promise;
			toISOString.mockRestore();
			blocked[0].release.resolve();
			await blocked[1].started.promise;
			await vi.waitFor(() => expect(runtime.inspectQueuedEventTypes()).toEqual([]));
			await addToolResult(runtime, { id: "tool-3", sessionID: "next" });
			blocked[1].release.resolve();
			await Promise.all([firstFlush, boundaryFlush]);
			await vi.waitFor(() => expect(posted).toHaveLength(3));

			// Assert
			const nextSessionEnvelope = posted.find(
				(envelope) => envelope.payload.tool_call_id === "tool-3",
			);
			expect(nextSessionEnvelope).toMatchObject({
				session_stream_id: "next",
				started_at: newSessionStartedAt,
			});
		} finally {
			toISOString?.mockRestore();
			for (const delivery of blocked) delivery.release.resolve();
			await Promise.all([firstFlush, boundaryFlush].filter(Boolean));
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("preserves the session start after an ordinary idle flush", async () => {
		// Arrange
		const homeDir = await mkdtemp(join(tmpdir(), "codemem-idle-session-start-"));
		const posted = [];
		stubSuccessfulViewer(posted);
		const runtime = await createRuntime(homeDir);
		try {
			await runtime.handleEvent({ type: "session.created", sessionID: "child" });
			await addToolResult(runtime, { id: "tool-1" });
			await vi.waitFor(() => expect(posted).toHaveLength(1));

			// Act
			await runtime.handleEvent({ type: "session.idle", sessionID: "child" });
			await addToolResult(runtime, { id: "tool-2" });
			await vi.waitFor(() => expect(posted).toHaveLength(2));

			// Assert
			expect(posted.map((envelope) => envelope.started_at)).toEqual([
				expect.any(String),
				posted[0].started_at,
			]);
		} finally {
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});

	it("preserves the session-start owner when a stale session is deleted", async () => {
		// Arrange
		const homeDir = await mkdtemp(join(tmpdir(), "codemem-stale-session-delete-"));
		const posted = [];
		stubSuccessfulViewer(posted);
		const runtime = await createRuntime(homeDir);
		const activeSessionStartedAt = "2026-09-12T12:00:00.000Z";
		let toISOString;
		try {
			await runtime.handleEvent({ type: "session.created", sessionID: "session-a" });
			toISOString = vi.spyOn(Date.prototype, "toISOString").mockReturnValue(activeSessionStartedAt);
			await runtime.handleEvent({ type: "session.created", sessionID: "session-b" });
			toISOString.mockRestore();
			await addToolResult(runtime, { id: "tool-a", sessionID: "session-a" });
			await vi.waitFor(() => expect(posted).toHaveLength(1));

			// Act
			await runtime.handleEvent({ type: "session.deleted", sessionID: "session-a" });
			await addToolResult(runtime, { id: "tool-b", sessionID: "session-b" });
			await vi.waitFor(() => expect(posted).toHaveLength(2));

			// Assert
			expect(posted[1]).toMatchObject({
				session_stream_id: "session-b",
				started_at: activeSessionStartedAt,
			});
		} finally {
			toISOString?.mockRestore();
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("raw-event disposal at delivery capacity", () => {
	it("spools a capacity-deferred event during disposal", async () => {
		// Arrange
		vi.stubEnv("CODEMEM_PLUGIN_MAX_EVENTS", "1");
		vi.stubEnv("CODEMEM_RAW_EVENTS_HARD_MAX", "1");
		const fixture = await createBlockedFlushFixture();
		const { blocked, homeDir, runtime } = fixture;
		try {
			await addToolResult(runtime, { id: "tool-1" });
			await blocked.started.promise;
			await addToolResult(runtime, { id: "tool-2" });

			// Act
			const disposal = runtime.dispose();
			blocked.release.resolve();
			await disposal;
			const spool = await loadRawEventSpoolEntries({ homeDir, limit: 10 });

			// Assert
			expect(spool.entries.map((entry) => entry.envelope.payload.tool_call_id)).toEqual(["tool-2"]);
		} finally {
			blocked.release.resolve();
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("prompt-threshold flush ownership", () => {
	it("rotates the threshold batch without waiting for blocked delivery", async () => {
		const fixture = await createBlockedFlushFixture();
		const { blocked, homeDir, posted, runtime } = fixture;
		try {
			await capturePrompt(runtime, 0);
			await blocked.started.promise;
			for (let index = 1; index < 15; index++) {
				await capturePrompt(runtime, index);
			}

			expect(runtime.inspectSessionContext().promptCount).toBe(0);
			blocked.release.resolve();
			await vi.waitFor(() => expect(posted).toHaveLength(15));
		} finally {
			blocked.release.resolve();
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("cross-session boundary failure", () => {
	it("does not merge a failed prior-session boundary into the new session", async () => {
		const fixture = await createDeferredBoundaryFailureFixture();
		const { activeFlush, blocked, homeDir, runtime } = fixture;
		let boundaryFlush;
		try {
			await addPromptMessage(runtime, "session-b-prompt", "Session B prompt", "session-b");
			boundaryFlush = runtime.handleEvent({ type: "session.created", sessionID: "session-b" });
			await vi.waitFor(() => expect(runtime.inspectQueuedEventTypes()).toEqual(["user_prompt"]));
			await addToolResult(runtime, {
				id: "new-tool",
				path: "src/session-b.ts",
				sessionID: "session-b",
			});
			blocked[0].release.resolve();
			await blocked[1].started.promise;
			blocked[1].release.resolve();
			await Promise.all([activeFlush, boundaryFlush]);

			expect(runtime.inspectQueuedEvents()).toEqual([
				{
					sessionID: "session-a",
					toolCallID: "deferred-tool",
					type: "tool.execute.after",
				},
				{
					sessionID: "session-b",
					toolCallID: null,
					type: "user_prompt",
				},
				{
					sessionID: "session-b",
					toolCallID: "new-tool",
					type: "tool.execute.after",
				},
			]);
			expect(runtime.inspectSessionContext()).toMatchObject({
				firstPrompt: "Session B prompt",
				promptCount: 1,
				toolCount: 1,
				filesRead: ["src/session-b.ts"],
			});
			await addPromptMessage(runtime, "session-b-prompt", "Session B prompt", "session-b");
			await closePrompt(runtime, "session-b-boundary", "session-b");
			expect(runtime.inspectQueuedPrompts()).toHaveLength(1);
		} finally {
			for (const delivery of blocked) delivery.release.resolve();
			await Promise.all([activeFlush, boundaryFlush].filter(Boolean));
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("partial raw-event flush failure", () => {
	it("contains partial delivery failure and restores its queue and context", async () => {
		const fixture = await createPartialFailureFixture();
		const { blocked, homeDir, runtime } = fixture;
		try {
			await addPrompt(runtime);
			await closePrompt(runtime, "prompt-boundary");
			await addToolResult(runtime, { id: "old-tool", path: "src/old.ts" });
			const flush = runtime.handleEvent({ type: "session.idle", sessionID: "child" });
			await blocked.started.promise;
			await addPromptMessage(runtime, "next-prompt", "Next context prompt");
			await closePrompt(runtime, "next-boundary");
			await addToolResult(runtime, { id: "next-tool", path: "src/new.ts" });
			blocked.release.resolve();
			await expect(flush).resolves.toBeUndefined();

			expect(runtime.inspectQueuedEventTypes()).toEqual([
				"tool.execute.after",
				"user_prompt",
				"tool.execute.after",
			]);
			expect(runtime.inspectSessionContext()).toMatchObject({
				firstPrompt: promptText,
				promptCount: 2,
				toolCount: 2,
				filesRead: expect.arrayContaining(["src/old.ts", "src/new.ts"]),
			});
		} finally {
			blocked.release.resolve();
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("deleted-session raw-event flush failure", () => {
	it("requeues deleted-session failures without merging stale context", async () => {
		const fixture = await createPartialFailureFixture();
		const { blocked, homeDir, runtime } = fixture;
		try {
			await runtime.handleEvent({ type: "session.created", sessionID: "session-a" });
			await addPromptMessage(runtime, "old-prompt", "Session A prompt", "session-a");
			await closePrompt(runtime, "old-boundary", "session-a");
			await addToolResult(runtime, {
				id: "old-tool",
				path: "src/session-a.ts",
				sessionID: "session-a",
			});
			await runtime.handleEvent({ type: "session.deleted", sessionID: "session-a" });
			const boundary = runtime.handleEvent({
				type: "session.created",
				sessionID: "session-b",
			});
			await blocked.started.promise;

			await addToolResult(runtime, {
				id: "new-tool",
				path: "src/session-b.ts",
				sessionID: "session-b",
			});
			blocked.release.resolve();
			await expect(boundary).resolves.toBeUndefined();

			expect(runtime.inspectQueuedEventTypes()).toEqual([
				"tool.execute.after",
				"tool.execute.after",
			]);
			expect(runtime.inspectSessionContext()).toMatchObject({
				firstPrompt: null,
				promptCount: 0,
				toolCount: 1,
				filesRead: ["src/session-b.ts"],
			});
		} finally {
			blocked.release.resolve();
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("throwing raw-event flush failure", () => {
	it("contains serialization failure and restores the detached prompt", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "codemem-flush-throw-"));
		stubSuccessfulViewer([]);
		const runtime = await createRuntime(homeDir, async () => ({ invalid: 1n }));
		try {
			await addPrompt(runtime);
			await expect(
				runtime.handleEvent({ type: "session.idle", sessionID: "child" }),
			).resolves.toBeUndefined();
			expect(runtime.inspectQueuedEventTypes()).toEqual(["user_prompt"]);
			expect(runtime.inspectSessionContext()).toMatchObject({
				firstPrompt: promptText,
				promptCount: 1,
			});
		} finally {
			await expect(runtime.dispose()).resolves.toBeUndefined();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("raw-event durability with delayed delegated provenance", () => {
	it("spools every event before disposal when provenance lookup times out", async () => {
		// Arrange
		vi.useFakeTimers();
		const fixture = await createSpoolFallbackFixture();
		const { delegation, homeDir, readMessage, readSession, runtime } = fixture;

		try {
			await addPrompt(runtime);

			// Act
			const flush = runtime.handleEvent({ type: "session.idle", sessionID: "child" });
			await Promise.resolve();
			await addAssistant(runtime);
			await addToolResult(runtime);
			await vi.advanceTimersByTimeAsync(200);
			await flush;
			await runtime.dispose();
			const spool = await loadRawEventSpoolEntries({ homeDir, limit: 10 });
			const prompt = spool.entries.find((entry) => entry.envelope.event_type === "user_prompt");

			// Assert
			expect({
				types: spool.entries.map((entry) => entry.envelope.event_type).sort(),
				promptHasProvenance: Object.hasOwn(prompt?.envelope ?? {}, "capture_context"),
				lookups: [readSession.mock.calls.length, readMessage.mock.calls.length],
			}).toEqual({
				types: ["assistant_message", "tool.execute.after", "user_prompt"],
				promptHasProvenance: false,
				lookups: [1, 1],
			});
		} finally {
			delegation.dispose();
			await vi.advanceTimersByTimeAsync(200);
			await runtime.dispose();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});
