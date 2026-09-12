import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDelegationContext } from "../.opencode/lib/delegation-context.js";
import { loadRawEventSpoolEntries } from "../.opencode/lib/raw-event-spool.js";
import { createCodememRuntime } from "../.opencode/lib/runtime.js";

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

async function addPrompt(runtime) {
	await runtime.handleEvent({
		type: "message.updated",
		sessionID: "child",
		messageInfo: {
			id: "prompt-message",
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
			id: "prompt-part",
			messageID: "prompt-message",
			sessionID: "child",
			type: "text",
			text: promptText,
		},
	});
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

async function addToolResult(runtime) {
	await runtime.handleToolResult(
		{
			sessionID: "child",
			id: "tool-call",
			tool: "read",
			args: { filePath: "src/queue.ts" },
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
