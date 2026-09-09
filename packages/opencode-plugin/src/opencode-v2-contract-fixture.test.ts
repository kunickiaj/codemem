import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "@opencode/plugin";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	type ContractRecord,
	defineOpenCodeV2ContractFixture,
	hasUnambiguousRequestIdentity,
	OPEN_CODE_V2_CONTRACT_VERSION,
	summarizeEvent,
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
		app: { name: "opencode", version: OPEN_CODE_V2_CONTRACT_VERSION, channel: "beta" },
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
	it("keeps the CLI and plugin API on the exact matching beta", async () => {
		// Arrange
		const manifest = JSON.parse(
			await readFile(path.join(repositoryRoot, "packages/opencode-plugin/package.json"), "utf8"),
		);

		// Act
		const versions = [
			manifest.devDependencies["@opencode/cli"],
			manifest.devDependencies["@opencode/plugin"],
		];

		// Assert
		expect(versions).toEqual([OPEN_CODE_V2_CONTRACT_VERSION, OPEN_CODE_V2_CONTRACT_VERSION]);
	});

	it("rejects a moving beta range", () => {
		// Arrange
		const invalidPins = ["beta", "^0.0.0-beta-19296"];

		// Act
		const exact = invalidPins.filter((version) => version === OPEN_CODE_V2_CONTRACT_VERSION);

		// Assert
		expect(exact).toEqual([]);
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
		messages: [],
		tools: {},
		generation: {},
		providerOptions: {} as Record<string, unknown>,
	};
	const cleanup = await plugin.setup(fixture.context);
	await invoke(fixture.sessionHooks, "prompt", {
		sessionID: "session-a",
		messageID: "message-a",
	});
	await invoke(fixture.sessionHooks, "context", contextInput);
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

describe("OpenCode 2 executable fixture", () => {
	it("observes location, options, storage, events, hooks, tools, and deterministic cleanup", async () => {
		// Arrange
		const expectedEventFamilies = ["generic", "session", "message", "tool"];

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
					generationMutable: true,
					hasAgent: true,
					hasKind: false,
					hasMessageID: false,
					hasModel: true,
					hasSessionID: true,
					messagesMutable: true,
					model: { providerID: "provider", modelID: "model" },
					sessionID: "session-a",
					systemMutable: true,
					toolsMutable: true,
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
					declaredName: "mem-status",
					effectiveID: null,
				}),
				expect.objectContaining({ phase: "event.end", aborted: true }),
				expect.objectContaining({ phase: "cleanup", disposed: 8 }),
			]),
		);
		expect(fixture.storage.size).toBe(0);
		expect(contextInput.providerOptions.codememContract).toBe(true);
		expect(fixture.aborted.value).toBe(true);
		expect(fixture.disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
		const eventRecords = records.filter((record) => record.phase === "event");
		expect(eventRecords.map((record) => record.family)).toEqual(expectedEventFamilies);
		expect(JSON.stringify(eventRecords)).not.toContain("must-not-be-recorded");
	});

	it("disposes completed registrations when setup fails", async () => {
		// Arrange
		const fixture = makeContext({ failToolHook: true });
		const plugin = defineOpenCodeV2ContractFixture();

		// Act
		const setup = plugin.setup(fixture.context);

		// Assert
		await expect(setup).rejects.toThrow("hook unavailable");
		expect(fixture.disposals).toHaveLength(6);
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
	it("distinguishes requests whose public session identities do not overlap", () => {
		// Arrange
		const kinds = ["primary", "compaction", "title", "generate"] as const;
		const requests = kinds.map((kind) => ({
			sessionID: `session-${kind}`,
			agent: "agent",
			model: "model",
		}));

		// Act
		const safe = hasUnambiguousRequestIdentity(requests);

		// Assert
		expect(safe).toBe(true);
	});

	it("cannot distinguish request kinds that share one public session identity", () => {
		// Arrange
		const identity = { sessionID: "session-a", agent: "agent-a", model: "model-a" };
		const requests = [
			{ ...identity, kind: "primary" },
			{ ...identity, kind: "compaction" },
			{ ...identity, kind: "title" },
			{ ...identity, kind: "generate" },
		];

		// Act
		const safe = hasUnambiguousRequestIdentity(requests);

		// Assert
		expect(safe).toBe(false);
	});

	it("rejects correlation for concurrent or retried requests sharing the public identity", () => {
		// Arrange
		const identity = { sessionID: "session-a", agent: "agent-a", model: "model-a" };
		const overlapping = [identity, identity];

		// Act
		const safe = hasUnambiguousRequestIdentity(overlapping);

		// Assert
		expect(safe).toBe(false);
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
