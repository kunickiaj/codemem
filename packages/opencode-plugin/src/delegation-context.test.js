import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDelegationContext } from "../.opencode/lib/delegation-context.js";
import {
	loadRawEventSpoolEntries,
	writeRawEventSpoolEntry,
} from "../.opencode/lib/raw-event-spool.js";
import { __testUtils, createCodememRuntime } from "../.opencode/lib/runtime.js";

const text = "Investigate retry ownership and return actual findings.";
const prompt = { sessionID: "child", messageID: "msg-1", text };
const task = (callID = "call-1", agent = "explore") => ({
	type: "message.part.updated",
	properties: {
		part: {
			type: "tool",
			tool: "task",
			callID,
			sessionID: "parent",
			messageID: "parent-message",
			state: {
				status: "running",
				time: { start: 200 },
				input: { subagent_type: agent, description: "Inspect retries", prompt: text },
				metadata: {
					parentSessionId: "parent",
					sessionId: "child",
					model: { providerID: "test", modelID: "test" },
				},
			},
		},
	},
});
const message = (id = "msg-1") => ({
	info: { id, sessionID: "child", role: "user", agent: "explore", time: { created: 201 } },
	parts: [{ id: "part-1", sessionID: "child", messageID: id, type: "text", text }],
});
const fixture = (overrides = {}) =>
	createDelegationContext({
		readSession: async () => ({ id: "child", parentID: "parent" }),
		readMessage: async (_session, id) => message(id),
		now: () => 200,
		...overrides,
	});

describe("OpenCode task-specific capture bindings", () => {
	it("requires actual task metadata and binds only one child message", async () => {
		const binding = fixture();
		expect(await binding.resolve(prompt)).toBeNull();
		binding.observe(task());
		const context = await binding.resolve(prompt);
		expect(context).toMatchObject({
			origin: "delegated_brief",
			task_call_id: "call-1",
			message_id: "msg-1",
			requested_agent: "explore",
			current_agent: "explore",
		});
		binding.observe(task());
		expect(await binding.resolve(prompt)).toEqual(context);
		expect(await binding.resolve({ ...prompt, messageID: "msg-2" })).toBeNull();
		binding.observe(task("call-2"));
		expect(await binding.resolve({ ...prompt, messageID: "msg-2" })).toBeNull();
	});

	it.each(["agent", "parent", "text", "mixed", "synthetic", "old-message"])(
		"leaves mismatched %s provenance unknown",
		async (kind) => {
			const snapshot = message();
			if (kind === "agent") snapshot.info.agent = "parent-assistant";
			if (kind === "text") snapshot.parts[0].text += " extra";
			if (kind === "mixed") snapshot.parts.push({ type: "file", url: "file:///fixture" });
			if (kind === "synthetic") snapshot.parts[0].synthetic = true;
			if (kind === "old-message") snapshot.info.time.created = 99;
			const binding = fixture({
				readSession: async () => ({
					id: "child",
					parentID: kind === "parent" ? "other" : "parent",
				}),
				readMessage: async () => snapshot,
			});
			binding.observe(task());
			expect(await binding.resolve(prompt)).toBeNull();
		},
	);
});

describe("delegation binding lifecycle", () => {
	it("keeps completion and changed-call replays from resurrecting a binding", async () => {
		const binding = fixture();
		binding.observe(task());
		await binding.resolve(prompt);
		const completed = task();
		completed.properties.part.state.status = "completed";
		binding.observe(completed);
		binding.observe(task());
		expect(await binding.resolve({ ...prompt, messageID: "msg-2" })).toBeNull();
		binding.observe(task("call-2"));
		expect(await binding.resolve({ ...prompt, messageID: "msg-2" })).toMatchObject({
			task_call_id: "call-2",
			message_id: "msg-2",
		});
		const changed = fixture();
		changed.observe(task());
		changed.observe(task("call-1", "review"));
		changed.observe(task());
		expect(await changed.resolve(prompt)).toBeNull();
	});

	it("does not infer provenance after restart, disposal, or expiry", async () => {
		let time = 200;
		const binding = fixture({ now: () => time });
		binding.observe(task());
		time += 600_001;
		expect(await binding.resolve(prompt)).toBeNull();
		binding.observe(task());
		expect(await binding.resolve(prompt)).toBeNull();
		const restarted = fixture();
		expect(await restarted.resolve(prompt)).toBeNull();
		const oldTask = task();
		oldTask.properties.part.state.time.start = 199;
		restarted.observe(oldTask);
		expect(await restarted.resolve(prompt)).toBeNull();
		restarted.observe(task());
		restarted.dispose();
		expect(await restarted.resolve(prompt)).toBeNull();
	});
});

describe("delegation metadata timeout", () => {
	it("bounds slow metadata lookup and ignores its late completion", async () => {
		vi.useFakeTimers();
		try {
			const signals = [];
			const hangingRead = async (...args) => {
				signals.push(args.at(-1));
				return new Promise(() => {});
			};
			const binding = fixture({ readSession: hangingRead, readMessage: hangingRead });
			binding.observe(task());
			const result = binding.resolve(prompt);
			await vi.advanceTimersByTimeAsync(200);
			expect(await result).toBeNull();
			expect(signals).toHaveLength(2);
			expect(signals.every((signal) => signal.aborted)).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("delegation metadata cancellation", () => {
	it("aborts the remaining metadata read when its sibling rejects", async () => {
		// Arrange
		let messageSignal;
		const binding = fixture({
			readSession: async () => {
				throw new Error("session lookup failed");
			},
			readMessage: async (_sessionID, _messageID, signal) => {
				messageSignal = signal;
				return new Promise(() => {});
			},
		});
		binding.observe(task());

		// Act
		const result = await binding.resolve(prompt);

		// Assert
		expect(result).toBeNull();
		expect(messageSignal?.aborted).toBe(true);
	});
});

describe("delegation disposal cancellation", () => {
	it("aborts in-flight metadata reads when disposed", async () => {
		// Arrange
		vi.useFakeTimers();
		const signals = [];
		const hangingRead = async (...args) => {
			signals.push(args.at(-1));
			return new Promise(() => {});
		};
		const binding = fixture({ readSession: hangingRead, readMessage: hangingRead });
		binding.observe(task());
		const result = binding.resolve(prompt);
		let settled = false;
		void result.finally(() => {
			settled = true;
		});

		try {
			// Act
			await Promise.resolve();
			expect(signals).toHaveLength(2);
			binding.dispose();
			await Promise.resolve();

			// Assert
			expect(signals.every((signal) => signal.aborted)).toBe(true);
			expect(settled).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await vi.advanceTimersByTimeAsync(200);
			await result;
			vi.useRealTimers();
		}
	});
});

async function createCaptureRuntime(homeDir, binding, envelopes) {
	for (const [key, value] of Object.entries({
		HOME: homeDir,
		CODEMEM_RAW_EVENTS: "1",
		CODEMEM_VIEWER: "0",
		CODEMEM_VIEWER_AUTO: "0",
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
		CODEMEM_RUNNER: "/usr/bin/true",
	}))
		vi.stubEnv(key, value);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			if (init?.method === "POST") envelopes.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ ingest: { available: true } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
	return createCodememRuntime({
		location: {
			project: { name: "delegation-test", root: homeDir },
			directory: homeDir,
			worktree: homeDir,
		},
		host: { log: async () => {}, notify: null, resolveCaptureContext: binding.resolve },
	});
}

async function sendPrompt(runtime) {
	await runtime.handleEvent({
		type: "message.updated",
		sessionID: "child",
		messageInfo: message().info,
	});
	await runtime.handleEvent({
		type: "message.part.updated",
		sessionID: "child",
		part: message().parts[0],
	});
}

describe("delegation callback delivery ordering", () => {
	it.each(["before-message", "before-boundary", "after-capture", "missing"])(
		"freezes capture with metadata %s",
		async (order) => {
			const homeDir = await mkdtemp(join(tmpdir(), "codemem-callback-order-"));
			const binding = fixture();
			const envelopes = [];
			const runtime = await createCaptureRuntime(homeDir, binding, envelopes);
			try {
				if (order === "before-message") binding.observe(task());
				await sendPrompt(runtime);
				if (order === "before-boundary") binding.observe(task());
				const boundary = {
					type: "message.updated",
					sessionID: "child",
					messageInfo: { id: "assistant", sessionID: "child", role: "assistant" },
				};
				await runtime.handleEvent(boundary);
				await vi.waitFor(() => expect(envelopes).toHaveLength(1));
				if (order === "after-capture") binding.observe(task());
				await sendPrompt(runtime);
				await runtime.handleEvent(boundary);
				expect(envelopes).toHaveLength(1);
				expect(envelopes[0].payload.prompt_text).toBe(text);
				if (order === "before-message" || order === "before-boundary") {
					expect(envelopes[0].capture_context).toMatchObject({
						origin: "delegated_brief",
						message_id: "msg-1",
					});
				} else {
					expect(envelopes[0]).not.toHaveProperty("capture_context");
				}
			} finally {
				binding.dispose();
				await runtime.dispose();
				vi.unstubAllGlobals();
				vi.unstubAllEnvs();
				await rm(homeDir, { recursive: true, force: true });
			}
		},
	);
});

describe("delegation provenance persistence", () => {
	it("preserves envelope identity and provenance through spool round-trip", async () => {
		// Arrange
		const binding = fixture();
		binding.observe(task());
		const context = await binding.resolve(prompt);
		const options = {
			sessionID: "child",
			type: "user_prompt",
			payload: {
				type: "user_prompt",
				prompt_number: 1,
				prompt_text: text,
				timestamp: "2026-09-11T12:00:00.000Z",
			},
			nextEventId: () => "event-1",
			nowMs: 123,
			nowMono: 45.5,
			cwd: null,
			project: null,
			startedAt: null,
		};
		const original = __testUtils.buildRawEventEnvelope(options);
		const envelope = __testUtils.buildRawEventEnvelope({ ...options, captureContext: context });
		const { capture_context, ...rest } = envelope;
		expect(rest).toEqual(original);
		const homeDir = await mkdtemp(join(tmpdir(), "codemem-provenance-"));
		try {
			// Act
			await writeRawEventSpoolEntry({ envelope, homeDir });
			const loaded = await loadRawEventSpoolEntries({ homeDir });

			// Assert
			expect(loaded.entries[0].envelope).toEqual(envelope);
			expect(loaded.entries[0].envelope.capture_context).toEqual(capture_context);
			await expect(
				writeRawEventSpoolEntry({ envelope: { ...envelope, capture_context: null }, homeDir }),
			).rejects.toThrow("conflicts");
		} finally {
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("delegation binding race and bounds", () => {
	it("rejects a second matching call delivered during snapshot lookup", async () => {
		const snapshot = Promise.withResolvers();
		const binding = fixture({ readMessage: () => snapshot.promise });
		binding.observe(task());
		const result = binding.resolve(prompt);
		binding.observe(task("call-2"));
		snapshot.resolve(message());
		expect(await result).toBeNull();
	});

	it("does not evict replay guards to accept a new task at capacity", async () => {
		const readSession = vi.fn();
		const binding = fixture({ readSession });
		for (let index = 0; index < 128; index++) {
			const event = task(`call-${index}`);
			event.properties.part.state.metadata.sessionId = `other-child-${index}`;
			binding.observe(event);
		}
		binding.observe(task("overflow"));
		expect(await binding.resolve(prompt)).toBeNull();
		expect(readSession).not.toHaveBeenCalled();
	});
});

describe("delegation lookup disposal", () => {
	it("waits for in-flight capture preparation before declaring disposal durable", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "codemem-capture-disposal-"));
		const snapshot = Promise.withResolvers();
		const readMessage = vi.fn(() => snapshot.promise);
		const binding = fixture({ readMessage });
		const runtime = await createCaptureRuntime(homeDir, binding, []);
		let boundary;
		vi.useFakeTimers();
		try {
			binding.observe(task());
			await sendPrompt(runtime);
			boundary = runtime.handleEvent({ type: "session.idle", sessionID: "child" });
			await vi.waitFor(() => expect(readMessage).toHaveBeenCalledOnce());
			const settled = vi.fn();
			const disposal = runtime.dispose().then(settled);
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).not.toHaveBeenCalled();
			binding.dispose();
			snapshot.resolve(message());
			await disposal;
			const spool = await loadRawEventSpoolEntries({ homeDir });
			expect(spool.entries).toHaveLength(1);
			expect(spool.entries[0].envelope.payload.prompt_text).toBe(text);
			expect(spool.entries[0].envelope).not.toHaveProperty("capture_context");
		} finally {
			snapshot.resolve(message());
			await boundary;
			await runtime.dispose();
			vi.useRealTimers();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});
