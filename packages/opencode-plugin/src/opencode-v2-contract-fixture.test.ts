import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "@opencode/plugin";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	type ContractRecord,
	defineOpenCodeV2ContractFixture,
	latestUserMessageID,
	OPEN_CODE_V2_CONTRACT_VERSION,
	summarizeEvent,
	userMessageIDs,
} from "./opencode-v2-contract-fixture.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

type HookCallback = (input: never) => Promise<void> | void;

function makeRegistration(dispose = vi.fn(async () => undefined)) {
	return { dispose };
}

function makeEvents(
	events: readonly unknown[],
	aborted: { value: boolean },
	fixtureOptions: { abortWithError?: boolean; eventError?: Error },
) {
	return async function* subscribe(subscriberOptions?: { signal?: AbortSignal }) {
		for (const event of events) yield event as never;
		if (fixtureOptions.eventError) throw fixtureOptions.eventError;
		await new Promise<void>((resolve, reject) => {
			const finishAbort = () => {
				aborted.value = true;
				if (fixtureOptions.abortWithError) {
					reject(new DOMException("event stream aborted", "AbortError"));
					return;
				}
				resolve();
			};
			if (subscriberOptions?.signal?.aborted) {
				finishAbort();
				return;
			}
			subscriberOptions?.signal?.addEventListener("abort", finishAbort, { once: true });
		});
	};
}

function makeContext(
	options: { abortWithError?: boolean; eventError?: Error; failToolHook?: boolean } = {},
) {
	const sessionHooks = new Map<string, HookCallback>();
	const toolHooks = new Map<string, HookCallback>();
	const disposals: Array<ReturnType<typeof vi.fn>> = [];
	const aborted = { value: false };
	const storage = new Map<string, unknown>();
	const effectiveTools: Array<{ id: string; name: string }> = [];
	const register = async (
		hooks: Map<string, HookCallback>,
		name: string,
		callback: HookCallback,
	) => {
		if (options.failToolHook && name === "execute.after") throw new Error("hook unavailable");
		hooks.set(name, callback);
		const dispose = vi.fn(async () => undefined);
		disposals.push(dispose);
		return makeRegistration(dispose);
	};
	const context = {
		app: { name: "opencode", version: OPEN_CODE_V2_CONTRACT_VERSION, channel: "stable" },
		location: {
			directory: "/fixture/project-worktree",
			workspaceID: "workspace-fixture",
			project: {
				id: "project-fixture",
				directory: "/fixture/project",
				canonical: "/fixture/project",
			},
		},
		options: { contract: true },
		event: {
			subscribe: makeEvents(
				[
					{ type: "server.connected" },
					{ type: "session.created", properties: { id: "redacted" } },
					{
						type: "session.inbox.enqueued",
						data: {
							sessionID: "session-a",
							inboxID: "message-a",
							item: { type: "user", payload: { text: "must-not-be-recorded" } },
						},
					},
					{
						type: "session.step.ended",
						data: {
							sessionID: "session-a",
							assistantMessageID: "message-b",
							finish: "stop",
							tokens: { input: 1, output: 1 },
						},
					},
					{ type: "session.execution.succeeded", data: { sessionID: "session-a" } },
					{ type: "session.execution.failed", data: { sessionID: "session-a" } },
					{ type: "session.execution.interrupted", data: { sessionID: "session-a" } },
					{ type: "message.updated", properties: { content: "must-not-be-recorded" } },
					{ type: "tool.updated", properties: { result: "must-not-be-recorded" } },
				],
				aborted,
				options,
			),
		},
		session: {
			hook: (name: string, callback: HookCallback) => register(sessionHooks, name, callback),
		},
		tool: {
			hook: (name: string, callback: HookCallback) => register(toolHooks, name, callback),
			transform: async (callback: (editor: unknown) => void) => {
				callback({
					add: (tool: { name: string }) => {
						effectiveTools.push({ id: "not-exposed-during-transform", name: tool.name });
					},
					list: () => [],
				});
				const dispose = vi.fn(async () => undefined);
				disposals.push(dispose);
				return makeRegistration(dispose);
			},
		},
		storage: {
			get: async (key: string) => storage.get(key),
			set: async (key: string, value: unknown) => {
				storage.set(key, value);
			},
			remove: async (key: string) => {
				storage.delete(key);
			},
		},
	} as unknown as Plugin.Context;
	return { aborted, context, disposals, effectiveTools, sessionHooks, storage, toolHooks };
}

async function invoke(hooks: Map<string, HookCallback>, name: string, input: unknown) {
	const callback = hooks.get(name);
	expect(callback, `missing ${name} callback`).toBeTypeOf("function");
	await callback?.(input as never);
}

async function runCleanup(cleanup: Awaited<ReturnType<Plugin.Plugin["setup"]>>) {
	expect(cleanup).toBeTypeOf("function");
	if (cleanup) await cleanup();
}

describe("pinned OpenCode 2 package contract", () => {
	it("keeps the CLI and plugin API on one exact release without tag or range syntax", async () => {
		// Arrange
		const manifest = JSON.parse(
			await readFile(path.join(repositoryRoot, "packages/opencode-plugin/package.json"), "utf8"),
		);
		const fixtureManifest = JSON.parse(
			await readFile(
				path.join(repositoryRoot, "packages/opencode-plugin/v2-contract-fixture/package.json"),
				"utf8",
			),
		);

		// Act
		const versions = [
			manifest.devDependencies["@opencode/cli"],
			manifest.devDependencies["@opencode/plugin"],
			fixtureManifest.peerDependencies["@opencode/plugin"],
		];

		// Assert
		expect(versions).toEqual(Array.from({ length: 3 }, () => OPEN_CODE_V2_CONTRACT_VERSION));
		expect(versions.every((version) => /^\d+\.\d+\.\d+$/u.test(version))).toBe(true);
	});

	it("types the public context without undocumented diagnostics or request identity", () => {
		// Arrange
		type Context = Plugin.Context;

		// Act
		type ContextKeys = keyof Context;
		type AppKeys = keyof Context["app"];

		// Assert
		expectTypeOf<"location">().toExtend<ContextKeys>();
		expectTypeOf<"storage">().toExtend<ContextKeys>();
		expectTypeOf<"log">().not.toExtend<AppKeys>();
		expectTypeOf<"toast">().not.toExtend<ContextKeys>();
		expectTypeOf<Context["tool"]["reload"]>().toBeFunction();
		expectTypeOf<Context["vcs"]["reload"]>().toBeFunction();
		expectTypeOf<Context["worktree"]["reload"]>().toBeFunction();
	});
});

async function executeLifecycleContract() {
	const records: ContractRecord[] = [];
	const fixture = makeContext();
	const plugin = defineOpenCodeV2ContractFixture((record) => {
		records.push(record);
	});
	const contextInput = {
		sessionID: "session-a",
		agent: "agent-a",
		model: { providerID: "provider", modelID: "model" },
		system: [],
		messages: [
			{ id: "message-old", role: "user", content: [] },
			{ id: "message-assistant", role: "assistant", content: [] },
			{ id: "message-a", role: "user", content: [] },
		],
		tools: {},
		options: {} as Record<string, unknown>,
	};
	const cleanup = await plugin.setup(fixture.context);
	await invoke(fixture.sessionHooks, "prompt", {
		sessionID: "session-a",
		messageID: "message-a",
	});
	await invoke(fixture.sessionHooks, "context", contextInput);
	await invoke(fixture.sessionHooks, "compaction", {
		...contextInput,
		options: {},
		result: undefined,
	});
	await invoke(fixture.sessionHooks, "generate", { ...contextInput, options: {} });
	await invoke(fixture.sessionHooks, "title", {
		sessionID: contextInput.sessionID,
		model: contextInput.model,
		system: [],
		messages: [{ id: "title-message", role: "user", content: [] }],
		options: {},
		result: undefined,
	});
	const requestHeaders: Record<string, string> = {};
	await invoke(fixture.sessionHooks, "model.request", {
		sessionID: "session-a",
		agent: "agent-a",
		model: { providerID: "provider", modelID: "model" },
		kind: "compaction",
		headers: requestHeaders,
	});
	const request = new Request("https://example.invalid", { headers: requestHeaders });
	await invoke(fixture.sessionHooks, "http.request", {
		sessionID: "session-a",
		agent: "agent-a",
		model: { providerID: "provider", modelID: "model" },
		kind: "compaction",
		request,
	});
	await invoke(fixture.sessionHooks, "http.response", {
		sessionID: "session-a",
		agent: "agent-a",
		model: { providerID: "provider", modelID: "model" },
		kind: "compaction",
		request,
		response: new Response(),
	});
	await invoke(fixture.sessionHooks, "retry", {
		sessionID: "session-a",
		agent: "agent-a",
		model: { providerID: "provider", modelID: "model" },
		attempt: 2,
		decision: { retry: false },
	});
	await invoke(fixture.toolHooks, "execute.after", {
		status: "completed",
		id: "call-a",
		messageID: "message-a",
		sessionID: "session-a",
		agent: "agent-a",
		tool: "mem-status",
		input: {},
		result: { content: "contract-ok" },
	});
	await runCleanup(cleanup);
	return { contextInput, fixture, records };
}

function expectCapturedEventShapes(records: ContractRecord[]) {
	const eventRecords = records.filter((record) => record.phase === "event");
	expect(eventRecords.map((record) => record.family)).toEqual([
		"generic",
		"session",
		"session",
		"session",
		"session",
		"session",
		"session",
		"message",
		"tool",
	]);
	expect(eventRecords).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: "session.inbox.enqueued",
				hasInboxID: true,
				hasSessionID: true,
				hasTextPayload: true,
				isUserItem: true,
			}),
			expect.objectContaining({
				type: "session.step.ended",
				finish: "stop",
				hasAssistantMessageID: true,
				hasFinish: true,
				hasSessionID: true,
				hasTokens: true,
			}),
			expect.objectContaining({ type: "session.execution.succeeded", hasSessionID: true }),
			expect.objectContaining({ type: "session.execution.failed", hasSessionID: true }),
			expect.objectContaining({ type: "session.execution.interrupted", hasSessionID: true }),
		]),
	);
	expect(JSON.stringify(eventRecords)).not.toContain("must-not-be-recorded");
}

describe("OpenCode 2 executable fixture", () => {
	it("observes location, options, storage, events, hooks, tools, and deterministic cleanup", async () => {
		// Act
		const { contextInput, fixture, records } = await executeLifecycleContract();

		// Assert
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					phase: "setup",
					directory: "/fixture/project-worktree",
					projectCanonical: "/fixture/project",
					optionKeys: ["contract"],
					hasLog: false,
					hasToast: false,
				}),
				expect.objectContaining({ phase: "storage", removed: true, valueMatches: true }),
				expect.objectContaining({
					phase: "prompt",
					hasMessageID: true,
					hasSessionID: true,
					messageID: "message-a",
					sessionID: "session-a",
				}),
				expect.objectContaining({
					phase: "context",
					agent: "agent-a",
					alreadyMarked: false,
					hasAgent: true,
					hasModel: true,
					hasSessionID: true,
					latestUserMessageID: "message-a",
					messagesMutable: true,
					model: { providerID: "provider", modelID: "model" },
					optionsMutable: true,
					sessionID: "session-a",
					systemMutable: true,
					toolsMutable: true,
					userMessageIDs: ["message-old", "message-a"],
				}),
				expect.objectContaining({
					phase: "compaction",
					alreadyMarked: false,
					hasAgent: true,
					optionsMutable: true,
				}),
				expect.objectContaining({
					phase: "generate",
					alreadyMarked: false,
					hasAgent: true,
					optionsMutable: true,
				}),
				expect.objectContaining({
					phase: "title",
					alreadyMarked: false,
					hasAgent: false,
					optionsMutable: true,
				}),
				expect.objectContaining({ phase: "model.request", kind: "compaction" }),
				expect.objectContaining({
					phase: "http.request",
					kind: "compaction",
					kindHeader: "compaction",
				}),
				expect.objectContaining({
					phase: "http.response",
					kind: "compaction",
					kindHeader: "compaction",
				}),
				expect.objectContaining({
					phase: "retry",
					attempt: 2,
					retry: false,
					hasKind: false,
					hasRequestID: false,
				}),
				expect.objectContaining({
					phase: "tool.execute.after",
					status: "completed",
					hasAgent: true,
					hasCallID: true,
					hasInput: true,
					hasMessageID: true,
					hasSessionID: true,
					hasTool: true,
				}),
				expect.objectContaining({
					phase: "tool.transform",
					declaredName: "contract-probe",
					effectiveID: null,
				}),
				expect.objectContaining({ phase: "event.end", aborted: true }),
				expect.objectContaining({ phase: "cleanup", disposed: 11 }),
			]),
		);
		expect(fixture.storage.size).toBe(0);
		expect(contextInput.options.codememContract).toBe(true);
		expect(fixture.aborted.value).toBe(true);
		expect(fixture.disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
		expectCapturedEventShapes(records);
	});
});

describe("OpenCode 2 fixture cleanup", () => {
	it("disposes completed registrations when setup fails", async () => {
		// Arrange
		const fixture = makeContext({ failToolHook: true });
		const plugin = defineOpenCodeV2ContractFixture();

		// Act
		const setup = plugin.setup(fixture.context);

		// Assert
		await expect(setup).rejects.toThrow("hook unavailable");
		expect(fixture.disposals).toHaveLength(9);
		expect(fixture.disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
	});

	it("defers event-stream failures to cleanup without skipping disposal", async () => {
		// Arrange
		const fixture = makeContext({ eventError: new Error("event stream failed") });
		const plugin = defineOpenCodeV2ContractFixture();

		// Act
		const cleanup = await plugin.setup(fixture.context);

		// Assert
		await expect(runCleanup(cleanup)).rejects.toThrow("event stream failed");
		expect(fixture.disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
	});

	it("records event families without prompt or tool-result content", () => {
		// Arrange
		const events = [
			{ type: "server.connected" },
			{ type: "session.created", properties: { title: "private" } },
			{ type: "message.updated", properties: { content: "private" } },
			{ type: "tool.updated", properties: { result: "private" } },
		];

		// Act
		const summaries = events.map(summarizeEvent);

		// Assert
		expect(summaries.map((summary) => summary.family)).toEqual([
			"generic",
			"session",
			"message",
			"tool",
		]);
		expect(JSON.stringify(summaries)).not.toContain("private");
	});
});

describe("OpenCode 2 event stream cancellation", () => {
	it("reports completion when cancellation throws AbortError", async () => {
		// Arrange
		const records: ContractRecord[] = [];
		const fixture = makeContext({ abortWithError: true });
		const plugin = defineOpenCodeV2ContractFixture((record) => {
			records.push(record);
		});
		const cleanup = await plugin.setup(fixture.context);

		// Act
		await runCleanup(cleanup);

		// Assert
		expect(records).toContainEqual(expect.objectContaining({ phase: "event.end", aborted: true }));
	});
});

describe("OpenCode 2 request and tool contracts", () => {
	it("retains durable user message IDs in transcript order", () => {
		// Arrange
		const messages = [
			{ id: "user-a", role: "user" },
			{ id: "assistant-a", role: "assistant" },
			{ id: "user-b", role: "user" },
		];

		// Act
		const ids = userMessageIDs(messages);

		// Assert
		expect(ids).toEqual(["user-a", "user-b"]);
	});

	it("keys a coalesced turn by the latest durable user message ID", () => {
		// Arrange
		const transcript = [
			{ id: "user-a", role: "user" },
			{ id: "user-b", role: "user" },
		];

		// Act
		const messageID = latestUserMessageID(transcript);

		// Assert
		expect(messageID).toBe("user-b");
	});

	it("does not invent an identity when the transcript has no durable user ID", () => {
		// Arrange
		const transcript = [{ id: "assistant-a", role: "assistant" }, { role: "user" }];

		// Act
		const messageID = latestUserMessageID(transcript);

		// Assert
		expect(messageID).toBeNull();
	});

	it("reports both completed and failed tool variants", async () => {
		// Arrange
		const records: ContractRecord[] = [];
		const fixture = makeContext();
		const plugin = defineOpenCodeV2ContractFixture((record) => {
			records.push(record);
		});
		const cleanup = await plugin.setup(fixture.context);

		// Act
		await invoke(fixture.toolHooks, "execute.after", {
			status: "completed",
			id: "call-success",
			messageID: "message-success",
		});
		await invoke(fixture.toolHooks, "execute.after", {
			status: "error",
			id: "call-failure",
			messageID: "message-failure",
		});
		await runCleanup(cleanup);

		// Assert
		expect(
			records
				.filter((record) => record.phase === "tool.execute.after")
				.map((record) => record.status),
		).toEqual(["completed", "error"]);
	});
});
