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

async function addPromptMessage(runtime, id, text) {
	const partID = id === "prompt-message" ? "prompt-part" : `${id}-part`;
	await runtime.handleEvent({
		type: "message.updated",
		sessionID: "child",
		messageInfo: {
			id,
			sessionID: "child",
			role: "user",
			agent: "explore",
			time: { created: 201 },
		},
	});
	await runtime.handleEvent({
		type: "message.part.updated",
		sessionID: "child",
		part: {
			id: partID,
			messageID: id,
			sessionID: "child",
			type: "text",
			text,
		},
	});
}

async function addPrompt(runtime) {
	await addPromptMessage(runtime, "prompt-message", promptText);
}

async function closePrompt(runtime, id) {
	await runtime.handleEvent({
		type: "message.updated",
		sessionID: "child",
		messageInfo: { id, sessionID: "child", role: "assistant" },
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

async function addToolResult(runtime, { id = "tool-call", path = "src/queue.ts" } = {}) {
	await runtime.handleToolResult(
		{
			sessionID: "child",
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

function stubBlockedFirstDelivery(posted, blocked) {
	let postCount = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			if (init?.method !== "POST") return statusResponse();
			postCount++;
			if (postCount === 1) {
				blocked.started.resolve();
				await blocked.release.promise;
			}
			posted.push(JSON.parse(init.body));
			return statusResponse();
		}),
	);
}

function stubSecondDeliveryFailure(posted, blocked) {
	let postCount = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			if (init?.method !== "POST") return statusResponse();
			postCount++;
			if (postCount === 2) {
				blocked.started.resolve();
				await blocked.release.promise;
				throw new Error("viewer unavailable");
			}
			posted.push(JSON.parse(init.body));
			return statusResponse();
		}),
	);
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
	it("captures a pending prompt before deletion closes its binding", async () => {
		const fixture = await createDeletionOrderFixture();
		const { delegation, homeDir, posted, runtime } = fixture;

		try {
			await addPrompt(runtime);
			await __v1AdapterTestUtils.dispatchV1Event(delegation, runtime, {
				type: "session.deleted",
				properties: { info: { id: "child" } },
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
