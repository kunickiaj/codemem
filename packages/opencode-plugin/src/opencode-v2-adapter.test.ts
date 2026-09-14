import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "@opencode/plugin";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

const recallIO = vi.hoisted(() => ({
	appendFile: vi.fn(async (_path: unknown, _data: unknown) => undefined),
	spawn: vi.fn(() => {
		throw new Error("Recall regression tests must not start subprocesses");
	}),
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execSync: vi.fn(() => "test-version"),
	spawn: recallIO.spawn,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	appendFile: recallIO.appendFile,
	mkdir: vi.fn(async () => undefined),
}));

const adapterUrl = pathToFileURL(
	path.resolve(import.meta.dirname, "../.opencode/lib/opencode-v2-adapter.js"),
).href;
const adapter = await import(adapterUrl);
const runtimeUrl = pathToFileURL(
	path.resolve(import.meta.dirname, "../.opencode/lib/runtime.js"),
).href;
const runtimeModule = await import(runtimeUrl);
const hostContractUrl = pathToFileURL(
	path.resolve(import.meta.dirname, "../.opencode/lib/host-contract.js"),
).href;
const hostContract = await import(hostContractUrl);

function makeRuntime() {
	return {
		deactivate: vi.fn(),
		dispose: vi.fn(async () => undefined),
		handleEvent: vi.fn(async () => undefined),
		handleToolResult: vi.fn(async () => undefined),
		reportDiagnostic: vi.fn(async () => undefined),
		transformMessages: vi.fn(
			async (
				_input: { sessionID?: string | null },
				_output: { messages?: Array<Record<string, unknown>> },
			): Promise<unknown> => ({ applied: false, surface: "message" }),
		),
		tools: {},
	};
}

const RECALL_TEXT = "[codemem context]\nRemember the adapter contract.";

function makeRecallRuntime() {
	const runtime = makeRuntime();
	runtime.transformMessages.mockImplementation(async (input, output) => {
		const messages = output.messages as Array<{
			info: { id?: string; role: string; sessionID?: string };
			parts: Array<Record<string, unknown>>;
		}>;
		const latestUser = messages.findLast((message) => message.info.role === "user");
		if (!latestUser?.info.id) return { applied: false, surface: "message" };
		latestUser.parts.push({
			id: `codemem-context-${latestUser.info.id}`,
			messageID: latestUser.info.id,
			metadata: { codemem: { attemptId: `attempt-${latestUser.info.id}` } },
			sessionID: input.sessionID,
			synthetic: true,
			text: RECALL_TEXT,
			type: "text",
		});
		return { applied: true, surface: "message" };
	});
	return runtime;
}

function userMessage(
	id: string | undefined,
	text: string,
): { id?: string; role: string; content: Array<Record<string, unknown>> } {
	return {
		...(id ? { id } : {}),
		role: "user",
		content: [{ type: "text", text }],
	};
}

function retainedRecallPart(messageID: string, text = RECALL_TEXT) {
	return {
		type: "text",
		text,
		metadata: {
			codemem: { v: 1, digest: "a".repeat(64), items: [] },
			codememPart: { v: 1, synthetic: true, id: `codemem-context-${messageID}` },
		},
	};
}

function recallText(message: { content: Array<Record<string, unknown>> } | undefined) {
	const part = message?.content.find((part) => {
		const metadata = part.metadata as Record<string, unknown> | undefined;
		return part.text === RECALL_TEXT && metadata?.codememPart != null;
	});
	return typeof part?.text === "string" ? part.text : undefined;
}

function makeContext(
	events: readonly unknown[] = [],
	options: {
		contextHookError?: Error;
		eventError?: Error;
		hookError?: Error;
		stuck?: boolean;
		stuckDispose?: boolean;
		stuckTransformDispose?: boolean;
		transformError?: Error;
	} = {},
) {
	const aborted = { value: false };
	const contextDispose = vi.fn(async () => undefined);
	const hookDispose = vi.fn(async () => {
		if (options.stuckDispose) await new Promise(() => {});
	});
	const transformDispose = vi.fn(async () => {
		if (options.stuckTransformDispose) await new Promise(() => {});
	});
	const addedTools: Array<Record<string, unknown>> = [];
	let contextHook: ((input: Record<string, unknown>) => Promise<void>) | undefined;
	let toolHook: ((input: unknown) => Promise<void>) | undefined;
	let toolTransform:
		| ((editor: { add: (tool: Record<string, unknown>) => void }) => void)
		| undefined;
	const context = {
		location: {
			directory: "/repo/worktree/nested",
			project: { id: "project", directory: "/repo/worktree", canonical: "/repo" },
		},
		event: {
			subscribe: async function* ({ signal }: { signal: AbortSignal }) {
				for (const event of events) yield event;
				if (options.eventError) throw options.eventError;
				if (options.stuck) await new Promise(() => {});
				await new Promise<void>((_resolve, reject) => {
					const abort = () => {
						aborted.value = true;
						reject(new DOMException("aborted", "AbortError"));
					};
					if (signal.aborted) abort();
					else signal.addEventListener("abort", abort, { once: true });
				});
			},
		},
		session: {
			hook: vi.fn(
				async (name: string, callback: (input: Record<string, unknown>) => Promise<void>) => {
					if (name === "context" && options.contextHookError) throw options.contextHookError;
					if (name === "context") contextHook = callback;
					return { dispose: contextDispose };
				},
			),
		},
		tool: {
			hook: vi.fn(async (_name: string, callback: (input: unknown) => Promise<void>) => {
				if (options.hookError) throw options.hookError;
				toolHook = callback;
				return { dispose: hookDispose };
			}),
			transform: vi.fn(
				async (callback: (editor: { add: (tool: Record<string, unknown>) => void }) => void) => {
					if (options.transformError) throw options.transformError;
					toolTransform = callback;
					callback({ add: (tool) => addedTools.push(tool) });
					return { dispose: transformDispose };
				},
			),
		},
	};
	return {
		aborted,
		addedTools,
		context,
		contextDispose,
		hookDispose,
		invokeContext: (input: Record<string, unknown>) => contextHook?.(input),
		invokeTool: (input: unknown) => toolHook?.(input),
		invokeTransform: () => toolTransform?.({ add: (tool) => addedTools.push(tool) }),
		transformDispose,
	};
}

type EventStream = Awaited<ReturnType<Plugin.Context["event"]["subscribe"]>>;
type OpenCodeEvent = EventStream extends AsyncIterable<infer Event> ? Event : never;
type InboxEvent = Extract<OpenCodeEvent, { type: "session.inbox.enqueued" }>;
type StepEndedEvent = Extract<OpenCodeEvent, { type: "session.step.ended" }>;
type ExecutionEvent = Extract<
	OpenCodeEvent,
	{ type: `session.execution.${"succeeded" | "failed" | "interrupted"}` }
>;

function assertToolHookContract(hook: Plugin.Context["tool"]["hook"]) {
	return hook("execute.after", (input) => {
		expectTypeOf(input.status).toEqualTypeOf<"completed" | "error">();
		expectTypeOf(input.sessionID).toBeString();
		expectTypeOf(input.tool).toBeString();
		if (input.status === "error") expectTypeOf(input.error).not.toBeNever();
	});
}

describe("pinned OpenCode 2 adapter types", () => {
	it("derives capture event and tool shapes from Plugin.Context", () => {
		expectTypeOf<InboxEvent["data"]>().toMatchTypeOf<{
			sessionID: string;
			inboxID: string;
			item: { type: string };
		}>();
		expectTypeOf<StepEndedEvent["data"]>().toMatchTypeOf<{
			sessionID: string;
			assistantMessageID: string;
			finish: string;
			tokens: object;
		}>();
		expectTypeOf<ExecutionEvent["data"]>().toMatchTypeOf<{ sessionID: string }>();
		expectTypeOf(assertToolHookContract).toBeFunction();
	});
});

describe("OpenCode 2 event translation", () => {
	it("normalizes user, assistant, usage, and lifecycle events", () => {
		const user = adapter.translateV2Event({
			id: "event-user",
			type: "session.inbox.enqueued",
			data: {
				sessionID: "session-1",
				inboxID: "message-user",
				item: { type: "user", payload: { text: "Ship it" } },
			},
		});
		const assistant = adapter.translateV2Event({
			id: "event-text",
			type: "session.text.ended",
			data: {
				sessionID: "session-1",
				assistantMessageID: "message-assistant",
				text: "Done",
			},
		});
		const usage = adapter.translateV2Event({
			type: "session.step.ended",
			data: {
				sessionID: "session-1",
				assistantMessageID: "message-assistant",
				finish: "stop",
				tokens: { input: 4, output: 2, cache: { read: 1, write: 0 } },
			},
		});

		expect(user.map((event: { type: string }) => event.type)).toEqual([
			"message.updated",
			"message.part.updated",
		]);
		expect(user[1].part.text).toBe("Ship it");
		expect(assistant.map((event: { type: string }) => event.type)).toEqual([
			"message.part.updated",
		]);
		expect(assistant[0].part.text).toBe("Done");
		expect(usage[0].messageInfo).toMatchObject({ role: "assistant", finish: true });
		expect(usage[0].messageInfo.tokens.output).toBe(2);
		expect(
			adapter.translateV2Event({
				type: "session.execution.succeeded",
				data: { sessionID: "session-1" },
			})[0].type,
		).toBe("session.idle");
	});

	it("allowlists events and accumulates usage until a terminal step", () => {
		const translator = adapter.createV2EventTranslator();
		const first = translator.translate({
			type: "session.step.ended",
			data: {
				sessionID: "session-1",
				assistantMessageID: "message-assistant",
				finish: "tool-calls",
				tokens: { input: 3, output: 2, reasoning: 1, cache: { read: 4, write: 1 } },
			},
		});
		const terminal = translator.translate({
			type: "session.step.ended",
			data: {
				sessionID: "session-1",
				assistantMessageID: "message-assistant",
				finish: "stop",
				tokens: { input: 5, output: 7, reasoning: 2, cache: { read: 6, write: 3 } },
			},
		});

		expect(first).toEqual([]);
		expect(terminal).toHaveLength(1);
		expect(terminal[0].usage).toEqual({
			input: 8,
			output: 9,
			cache: { read: 10, write: 4 },
		});
		expect(translator.translate({ type: "session.text.delta", data: { text: "ignored" } })).toEqual(
			[],
		);
		for (const finish of ["stop", "length", "content-filter", "error", "unknown"]) {
			const terminalTranslator = adapter.createV2EventTranslator();
			expect(
				terminalTranslator.translate({
					type: "session.step.ended",
					data: {
						sessionID: "session-terminal",
						assistantMessageID: `message-${finish}`,
						finish,
						tokens: { input: 1, output: 1 },
					},
				}),
			).toHaveLength(1);
		}
	});
});

describe("OpenCode 2 assistant continuation translation", () => {
	it("finalizes one cumulative assistant message after a tool continuation", () => {
		const translator = adapter.createV2EventTranslator();
		const beforeTool = translator.translate({
			id: "text-before-tool",
			type: "session.text.ended",
			data: {
				sessionID: "session-1",
				assistantMessageID: "message-assistant",
				text: "Checking. ",
			},
		});
		const toolStep = translator.translate({
			type: "session.step.ended",
			data: {
				sessionID: "session-1",
				assistantMessageID: "message-assistant",
				finish: "tool-calls",
				tokens: { input: 1, output: 1 },
			},
		});
		const afterTool = translator.translate({
			id: "text-after-tool",
			type: "session.text.ended",
			data: {
				sessionID: "session-1",
				assistantMessageID: "message-assistant",
				text: "Done.",
			},
		});
		const terminal = translator.translate({
			type: "session.step.ended",
			data: {
				sessionID: "session-1",
				assistantMessageID: "message-assistant",
				finish: "stop",
				tokens: { input: 2, output: 2 },
			},
		});

		expect(beforeTool).toHaveLength(1);
		expect(beforeTool[0].part.text).toBe("Checking. ");
		expect(toolStep).toEqual([]);
		expect(afterTool).toHaveLength(1);
		expect(afterTool[0].part.text).toBe("Checking. Done.");
		expect(terminal).toHaveLength(1);
		expect(terminal[0].messageInfo).toMatchObject({
			id: "message-assistant",
			role: "assistant",
			finish: true,
		});
	});

	it("clears unfinished assistant text when a session ends", () => {
		const translator = adapter.createV2EventTranslator();
		translator.translate({
			id: "stale-text",
			type: "session.text.ended",
			data: {
				sessionID: "session-1",
				assistantMessageID: "message-assistant",
				text: "Stale",
			},
		});
		translator.translate({
			type: "session.execution.interrupted",
			data: { sessionID: "session-1" },
		});

		const fresh = translator.translate({
			id: "fresh-text",
			type: "session.text.ended",
			data: {
				sessionID: "session-1",
				assistantMessageID: "message-assistant",
				text: "Fresh",
			},
		});

		expect(fresh[0].part.text).toBe("Fresh");
	});
});

describe("OpenCode 2 tool capture", () => {
	it("uses tool-call identity to distinguish otherwise identical captured events", () => {
		const createEvent = (toolCallID: string) =>
			runtimeModule.__testUtils.buildOpencodeAdapterEvent({
				sessionID: "session-1",
				event: {
					type: "tool.execute.after",
					tool: "read",
					args: { path: "/repo/file.ts" },
					result: "ok",
					error: null,
					tool_call_id: toolCallID,
					timestamp: "2026-09-10T12:00:00.000Z",
				},
			});

		expect(createEvent("tool-call-1").event_id).not.toBe(createEvent("tool-call-2").event_id);
	});
});

describe("OpenCode 2 notifications", () => {
	it("publishes runtime notices through the registered RPC bridge", async () => {
		const runtime = makeRuntime();
		const emit = vi.fn(async () => undefined);
		const rpcDispose = vi.fn(async () => undefined);
		let drain: (() => Promise<{ notices: unknown[] }>) | undefined;
		const fixture = makeContext();
		Object.assign(fixture.context, {
			rpc: {
				register: vi.fn(async (_definition, handlers) => {
					drain = handlers.drain;
					return { dispose: rpcDispose, events: { emit } };
				}),
			},
		});
		const createRuntime = vi.fn(
			async (_input: {
				host: {
					notify: ((notice: { message: string; variant: string }) => Promise<void>) | null;
				};
			}) => runtime,
		);
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime,
		});
		const cleanup = await setup(fixture.context);
		const notify = createRuntime.mock.calls[0]?.[0].host.notify;

		await notify?.({ message: "Context injected", variant: "success" });

		expect(emit).toHaveBeenCalledWith(
			"notice",
			expect.objectContaining({ message: "Context injected", variant: "success" }),
		);
		await expect(drain?.()).resolves.toEqual({
			notices: [expect.objectContaining({ message: "Context injected", variant: "success" })],
		});
		await cleanup?.();
		expect(rpcDispose).toHaveBeenCalledOnce();
	});
});

describe("OpenCode 2 memory tools", () => {
	it("registers shared memory tools with V2 schemas and results", async () => {
		const runtime = makeRuntime();
		const executeRecent = vi.fn(async ({ limit }: { limit?: number }) => `recent:${limit ?? 5}`);
		runtime.tools = {
			"mem-recent": {
				description: "Show recent codemem entries",
				args: { limit: { type: "number", optional: true } },
				execute: executeRecent,
			},
		};
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);
		const tool = fixture.addedTools[0] as {
			execute: (args: unknown) => Promise<unknown>;
			input: unknown;
			name: string;
			options: unknown;
		};

		expect(tool.name).toBe("mem-recent");
		expect(tool.input).toEqual({
			type: "object",
			properties: { limit: { type: "number" } },
			additionalProperties: false,
		});
		expect(tool.options).toEqual({ codemode: false });
		await expect(tool.execute({ limit: 3 })).resolves.toEqual({ content: "recent:3" });
		expect(executeRecent).toHaveBeenCalledWith({ limit: 3 });
		await cleanup?.();
		expect(fixture.transformDispose).toHaveBeenCalledOnce();
	});
});

describe("OpenCode 2 automatic recall", () => {
	it("translates synthetic recall context onto the latest identified user message", async () => {
		// Arrange
		const runtime = makeRecallRuntime();
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);
		const input = {
			sessionID: "session-1",
			messages: [
				userMessage("user-1", "First prompt"),
				{ id: "assistant-1", role: "assistant", content: [{ type: "text", text: "Reply" }] },
				userMessage("user-2", "Latest prompt"),
			],
		};

		// Act
		await fixture.invokeContext(input);

		// Assert
		expect(runtime.transformMessages).toHaveBeenCalledOnce();
		expect(runtime.transformMessages).toHaveBeenCalledWith(
			{ sessionID: "session-1" },
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({
						info: expect.objectContaining({
							id: "user-2",
							role: "user",
							sessionID: "session-1",
						}),
					}),
				]),
			}),
			{
				deferDeliveryConfirmation: true,
				enableSystemSurface: true,
				pruneAbsentCacheEntries: false,
				requireLatestUserMessageID: true,
				cacheSuccessfulEmpty: true,
			},
		);
		expect(recallText(input.messages[2])).toBe(RECALL_TEXT);
		expect(recallText(input.messages[0])).toBeUndefined();
		await cleanup?.();
	});

	it("replays byte-identical recall for retries and tool continuations of one user turn", async () => {
		// Arrange
		const runtime = makeRecallRuntime();
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);
		const makeTurn = (includeToolContinuation = false) => ({
			sessionID: "session-1",
			messages: [
				userMessage("user-1", "Recall this"),
				...(includeToolContinuation
					? [
							{
								id: "assistant-1",
								role: "assistant",
								content: [{ type: "tool-call", id: "call-1", name: "read", input: {} }],
							},
							{
								id: "tool-1",
								role: "tool",
								content: [
									{
										type: "tool-result",
										id: "call-1",
										name: "read",
										result: { type: "text", value: "ok" },
									},
								],
							},
						]
					: []),
			],
		});
		const initial = makeTurn();
		const retry = makeTurn();
		const continuation = makeTurn(true);

		// Act
		await fixture.invokeContext(initial);
		await fixture.invokeContext(retry);
		await fixture.invokeContext(continuation);

		// Assert
		const recalled = [initial, retry, continuation].map((turn) => recallText(turn.messages[0]));
		expect(runtime.transformMessages).toHaveBeenCalledTimes(3);
		expect(recalled).toEqual([RECALL_TEXT, RECALL_TEXT, RECALL_TEXT]);
		await cleanup?.();
	});

	it("serializes retries of one turn without blocking a different turn", async () => {
		const runtime = makeRuntime();
		let releaseFirst: (() => void) | undefined;
		const firstPending = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		runtime.transformMessages.mockImplementation(async (input) => {
			if (input.sessionID === "session-1") await firstPending;
			return { applied: false, surface: "message" };
		});
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);
		const first = fixture.invokeContext({
			sessionID: "session-1",
			messages: [userMessage("user-1", "First")],
		});
		const retry = fixture.invokeContext({
			sessionID: "session-1",
			messages: [userMessage("user-1", "Retry")],
		});
		const nextTurn = fixture.invokeContext({
			sessionID: "session-1",
			messages: [userMessage("user-2", "Next")],
		});

		await vi.waitFor(() => expect(runtime.transformMessages).toHaveBeenCalledTimes(2));
		expect(
			runtime.transformMessages.mock.calls.map(([, output]) => {
				const messages = output.messages as Array<{ info: { id?: string; role: string } }>;
				return messages.findLast((message) => message.info.role === "user")?.info.id;
			}),
		).toEqual(["user-1", "user-2"]);
		releaseFirst?.();
		await Promise.all([first, retry, nextTurn]);
		expect(runtime.transformMessages).toHaveBeenCalledTimes(3);
		await cleanup?.();
	});
});

describe("OpenCode 2 automatic recall turn safety", () => {
	it("treats a second identified user message as a new turn", async () => {
		// Arrange
		const runtime = makeRecallRuntime();
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);
		const firstTurn = {
			sessionID: "session-1",
			messages: [userMessage("user-1", "First prompt")],
		};
		const secondTurn = {
			sessionID: "session-1",
			messages: [
				userMessage("user-1", "First prompt"),
				{ id: "assistant-1", role: "assistant", content: [{ type: "text", text: "Reply" }] },
				userMessage("user-2", "Second prompt"),
			],
		};

		// Act
		await fixture.invokeContext(firstTurn);
		await fixture.invokeContext(secondTurn);

		// Assert
		expect(runtime.transformMessages).toHaveBeenCalledTimes(2);
		expect(recallText(firstTurn.messages[0])).toBe(RECALL_TEXT);
		expect(recallText(secondTurn.messages[0])).toBeUndefined();
		expect(recallText(secondTurn.messages[2])).toBe(RECALL_TEXT);
		await cleanup?.();
	});

	it("skips runtime recall when the latest user message has no ID", async () => {
		// Arrange
		const runtime = makeRecallRuntime();
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);
		const input = {
			sessionID: "session-1",
			messages: [userMessage("user-1", "Identified"), userMessage(undefined, "Unsafe latest")],
		};

		// Act
		await fixture.invokeContext(input);

		// Assert
		expect(runtime.transformMessages).toHaveBeenCalledWith(
			{ sessionID: "session-1" },
			expect.any(Object),
			{
				deferDeliveryConfirmation: true,
				enableSystemSurface: true,
				pruneAbsentCacheEntries: false,
				requireLatestUserMessageID: true,
				cacheSuccessfulEmpty: true,
			},
		);
		expect(input.messages.every((message) => recallText(message) === undefined)).toBe(true);
		await cleanup?.();
	});

	it("skips runtime recall when the latest user message ID is whitespace-only", async () => {
		const runtime = makeRecallRuntime();
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);
		const input = {
			sessionID: "session-1",
			messages: [userMessage("   ", "Unsafe latest")],
		};

		await fixture.invokeContext(input);

		const translated = runtime.transformMessages.mock.calls[0]?.[1].messages as Array<{
			info: { id?: string };
		}>;
		expect(translated[0]?.info.id).toBeUndefined();
		expect(recallText(input.messages[0])).toBeUndefined();
		await cleanup?.();
	});
});

describe("OpenCode 2 unidentified retained recall", () => {
	it("preserves marked context on an unidentified message", async () => {
		const runtime = makeRecallRuntime();
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);
		const retained = userMessage(undefined, "Unsafe latest");
		retained.content.push(retainedRecallPart("user-1"));
		const originalContent = structuredClone(retained.content);
		const input = {
			sessionID: "session-1",
			messages: [retained],
		};

		await fixture.invokeContext(input);

		expect(input.messages[0]?.content).toEqual(originalContent);
		await cleanup?.();
	});

	it("canonicalizes retained context before a later identified turn", async () => {
		const fixture = await makeRuntimeRecallFixture();
		try {
			const retainedText = runtimeModule.__testUtils.wrapInjectedContext(fixture.pack.pack_text);
			const retained = userMessage(undefined, "Historical prompt");
			retained.content.push({
				type: "text",
				text: retainedText,
				metadata: {
					codemem: {
						v: 1,
						digest: createHash("sha256").update(retainedText).digest("hex"),
						items: fixture.pack.rendered_items.map(({ id, fingerprint }) => ({ id, fingerprint })),
					},
					codememPart: { v: 1, synthetic: true, id: "codemem-context-user-1" },
				},
			});
			const originalContent = structuredClone(retained.content);
			const translated = adapter.translateV2Messages([retained], "session-1");

			expect(translated[0]?.info.id).toBeUndefined();
			expect(translated[0]?.parts[1]).toMatchObject({
				id: "codemem-context-user-1",
				messageID: null,
				sessionID: "session-1",
				synthetic: true,
			});

			const input = {
				sessionID: "session-1",
				messages: [retained, userMessage("user-2", "Next recall")],
			};
			await fixture.invokeContext(input);

			const request = fixture.retrieve.mock.calls[0]?.[0];
			expect(request?.context).not.toContain(retainedText);
			expect(injectedTexts(input.messages[1])).toEqual([]);
			expect(input.messages[0]?.content).toEqual(originalContent);
			expect(fixture.measurements()).toContainEqual(
				expect.objectContaining({ duplicates_omitted: 1 }),
			);
		} finally {
			await fixture.dispose();
		}
	});
});

describe("OpenCode 2 automatic recall surfaces and failures", () => {
	it("preserves retained recall when a later unidentified turn is skipped", async () => {
		const runtime = makeRecallRuntime();
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);
		const retained = userMessage("user-1", "Identified");
		retained.content.push(retainedRecallPart("user-1"));
		const input = {
			sessionID: "session-1",
			messages: [retained, userMessage(undefined, "Unsafe latest")],
		};

		await fixture.invokeContext(input);

		expect(recallText(input.messages[0])).toBe(RECALL_TEXT);
		expect(recallText(input.messages[1])).toBeUndefined();
		await cleanup?.();
	});

	it("does not promote a recall marker copied onto a different message", async () => {
		const translated = adapter.translateV2Messages(
			[
				{
					...userMessage("user-2", "New turn"),
					content: [retainedRecallPart("user-1")],
				},
			],
			"session-1",
		);

		expect(translated[0].parts).toEqual([]);
	});

	it("maps the legacy system surface onto V2 system parts", async () => {
		const runtime = makeRecallRuntime();
		runtime.transformMessages.mockImplementation(async (_input, output) => {
			const messages = output.messages as Array<{
				info: { id?: string; role: string };
				parts: Array<Record<string, unknown>>;
			}>;
			const latestUser = messages.findLast((message) => message.info.role === "user");
			latestUser?.parts.push({
				id: `codemem-context-${latestUser.info.id}`,
				metadata: { codemem: { v: 1, digest: "b".repeat(64), items: [] } },
				synthetic: true,
				text: RECALL_TEXT,
				type: "text",
			});
			return { applied: true, surface: "system" };
		});
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);
		const input = {
			sessionID: "session-1",
			system: [{ type: "text", text: "base system" }],
			messages: [userMessage("user-1", "Recall")],
		};

		await fixture.invokeContext(input);

		expect(input.system).toHaveLength(2);
		expect(input.system[1]).toMatchObject({ text: RECALL_TEXT, type: "text" });
		expect(recallText(input.messages[0])).toBeUndefined();
		await cleanup?.();
	});

	it("contains adapter translation failures without breaking the context hook", async () => {
		const runtime = makeRuntime();
		runtime.transformMessages.mockRejectedValueOnce(new Error("translation failed"));
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);

		await expect(
			fixture.invokeContext({
				sessionID: "session-1",
				messages: [userMessage("user-1", "Recall")],
			}),
		).resolves.toBeUndefined();
		expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_context_recall_failed");
		await cleanup?.();
	});

	it("marks deferred delivery failed when the host message array rejects mutation", async () => {
		const runtime = makeRecallRuntime();
		const completeDelivery = vi.fn();
		runtime.transformMessages.mockImplementationOnce(async (input, output) => {
			const messages = output.messages as Array<{
				info: { id?: string; role: string };
				parts: Array<Record<string, unknown>>;
			}>;
			const latestUser = messages.findLast((message) => message.info.role === "user");
			latestUser?.parts.push({
				id: `codemem-context-${latestUser.info.id}`,
				messageID: latestUser.info.id,
				sessionID: input.sessionID,
				synthetic: true,
				text: RECALL_TEXT,
				type: "text",
			});
			return { applied: true, completeDelivery, surface: "message" };
		});
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);
		const messages = Object.freeze([userMessage("user-1", "Recall")]);

		await expect(
			fixture.invokeContext({ sessionID: "session-1", messages }),
		).resolves.toBeUndefined();

		expect(completeDelivery).toHaveBeenCalledOnce();
		expect(completeDelivery).toHaveBeenCalledWith("failed");
		expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_context_recall_failed");
		await cleanup?.();
	});
});

describe("OpenCode 2 adapter lifecycle", () => {
	it("captures completed and failed tools without changing their outcomes", async () => {
		const runtime = makeRuntime();
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });
		const cleanup = await setup(fixture.context);

		await fixture.invokeTool({
			id: "tool-call-completed",
			status: "completed",
			sessionID: "session-1",
			tool: "read",
			input: { path: "/repo/worktree/file.ts" },
			result: { content: "ok" },
		});
		await fixture.invokeTool({
			id: "tool-call-failed",
			status: "error",
			sessionID: "session-1",
			tool: "read",
			input: { path: "/repo/worktree/missing.ts" },
			error: { message: "missing" },
		});
		await fixture.invokeTool({
			id: "tool-call-completed-repeat",
			status: "completed",
			sessionID: "session-1",
			tool: "read",
			input: { path: "/repo/worktree/file.ts" },
			result: { content: "ok" },
		});

		expect(runtime.handleToolResult).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ id: "tool-call-completed", tool: "read" }),
			{ output: "ok", error: null },
		);
		expect(runtime.handleToolResult).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ id: "tool-call-failed", tool: "read" }),
			{ output: null, error: { message: "missing" } },
		);
		expect(runtime.handleToolResult).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({ id: "tool-call-completed-repeat", tool: "read" }),
			{ output: "ok", error: null },
		);
		await cleanup?.();
	});

	it("preserves failed status when malformed input omits error details", () => {
		const translated = adapter.translateV2ToolResult({
			status: "error",
			sessionID: "session-1",
			tool: "read",
			input: {},
		});

		expect(translated.output).toEqual({
			output: null,
			error: {
				name: "CodememToolCaptureError",
				message: "OpenCode reported a failed tool without error details",
			},
		});
	});
});

describe("OpenCode 2 adapter lifecycle", () => {
	it("aborts event consumption and makes cleanup idempotent", async () => {
		const runtime = makeRuntime();
		const fixture = makeContext([{ type: "session.created", data: { sessionID: "session-1" } }]);
		const createRuntime = vi.fn(async () => runtime);
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime });
		const cleanup = await setup(fixture.context);
		await vi.waitFor(() => {
			expect(runtime.handleEvent).toHaveBeenCalledWith(
				expect.objectContaining({ type: "session.created", sessionID: "session-1" }),
			);
		});

		await Promise.all([cleanup?.(), cleanup?.()]);

		expect(fixture.aborted.value).toBe(true);
		expect(fixture.contextDispose).toHaveBeenCalledTimes(1);
		expect(fixture.hookDispose).toHaveBeenCalledTimes(1);
		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		expect(createRuntime).toHaveBeenCalledWith(
			expect.objectContaining({
				location: {
					project: {
						...fixture.context.location.project,
						root: fixture.context.location.project.canonical,
					},
					directory: "/repo/worktree/nested",
					worktree: "/repo/worktree",
				},
			}),
		);
	});

	it("contains stream and capture failures with content-free diagnostics", async () => {
		const runtime = makeRuntime();
		runtime.handleEvent.mockRejectedValueOnce(new Error("capture failed"));
		runtime.reportDiagnostic.mockImplementation(async () => new Promise(() => {}));
		const waitForDiagnosticTask = vi.fn(async () => false);
		const fixture = makeContext([{ type: "session.created", data: { sessionID: "session-1" } }], {
			eventError: new Error("stream failed"),
		});
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			waitForDiagnosticTask,
		});
		const cleanup = await setup(fixture.context);
		await vi.waitFor(() => {
			expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_event_stream_failed");
		});

		await expect(cleanup?.()).resolves.toBeUndefined();
		expect(waitForDiagnosticTask).toHaveBeenCalledTimes(2);
		expect(runtime.dispose).toHaveBeenCalledOnce();
		expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_event_capture_failed");
		expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_event_stream_failed");
	});

	it("reports tool capture failures without changing tool outcomes", async () => {
		const runtime = makeRuntime();
		runtime.handleToolResult.mockRejectedValueOnce(new Error("capture failed"));
		runtime.reportDiagnostic.mockImplementation(async () => new Promise(() => {}));
		const waitForDiagnosticTask = vi.fn(async () => false);
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			waitForDiagnosticTask,
		});
		const cleanup = await setup(fixture.context);

		await expect(
			fixture.invokeTool({
				status: "completed",
				sessionID: "session-1",
				tool: "read",
				input: {},
				result: { output: "ok" },
			}),
		).resolves.toBeUndefined();
		expect(waitForDiagnosticTask).toHaveBeenCalledOnce();
		expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_tool_capture_failed");
		await cleanup?.();
	});
});

describe("OpenCode 2 adapter capture ordering", () => {
	it("keeps later events behind a capture that exceeded the host timeout", async () => {
		const runtime = makeRuntime();
		let releaseFirstCapture: (() => void) | undefined;
		runtime.handleEvent.mockImplementationOnce(
			async () =>
				new Promise<undefined>((resolve) => {
					releaseFirstCapture = () => resolve(undefined);
				}),
		);
		const fixture = makeContext([
			{ type: "session.created", data: { sessionID: "session-1" } },
			{ type: "session.execution.succeeded", data: { sessionID: "session-1" } },
		]);
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			eventTaskTimeoutMs: 5,
		});
		const cleanup = await setup(fixture.context);
		await vi.waitFor(() => expect(runtime.handleEvent).toHaveBeenCalledOnce());

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(runtime.handleEvent).toHaveBeenCalledOnce();
		expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_event_capture_failed");

		releaseFirstCapture?.();
		await vi.waitFor(() => expect(runtime.handleEvent).toHaveBeenCalledTimes(2));
		await cleanup?.();
	});

	it("keeps tool captures behind an event that exceeded the host timeout", async () => {
		const runtime = makeRuntime();
		let releaseEventCapture: (() => void) | undefined;
		runtime.handleEvent.mockImplementationOnce(
			async () =>
				new Promise<undefined>((resolve) => {
					releaseEventCapture = () => resolve(undefined);
				}),
		);
		const fixture = makeContext([{ type: "session.created", data: { sessionID: "session-1" } }]);
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			eventTaskTimeoutMs: 5,
		});
		const cleanup = await setup(fixture.context);
		await vi.waitFor(() => expect(runtime.handleEvent).toHaveBeenCalledOnce());

		await fixture.invokeTool({
			status: "completed",
			sessionID: "session-1",
			tool: "read",
			input: {},
			result: { output: "ok" },
		});
		expect(runtime.handleToolResult).not.toHaveBeenCalled();

		releaseEventCapture?.();
		await vi.waitFor(() => expect(runtime.handleToolResult).toHaveBeenCalledOnce());
		await cleanup?.();
	});

	it("keeps events behind a tool capture that exceeded the host timeout", async () => {
		const runtime = makeRuntime();
		let releaseToolCapture: (() => void) | undefined;
		let releaseEvent: (() => void) | undefined;
		runtime.handleToolResult.mockImplementationOnce(
			async () =>
				new Promise<undefined>((resolve) => {
					releaseToolCapture = () => resolve(undefined);
				}),
		);
		const fixture = makeContext();
		fixture.context.event.subscribe = async function* ({ signal }: { signal: AbortSignal }) {
			await new Promise<void>((resolve) => {
				releaseEvent = resolve;
			});
			if (signal.aborted) return;
			yield { type: "session.created", data: { sessionID: "session-1" } };
		};
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			eventTaskTimeoutMs: 5,
		});
		const cleanup = await setup(fixture.context);

		await fixture.invokeTool({
			status: "completed",
			sessionID: "session-1",
			tool: "read",
			input: {},
			result: { output: "ok" },
		});
		releaseEvent?.();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(runtime.handleEvent).not.toHaveBeenCalled();

		releaseToolCapture?.();
		await vi.waitFor(() => expect(runtime.handleEvent).toHaveBeenCalledOnce());
		await cleanup?.();
	});
});

describe("OpenCode 2 adapter capture timeout", () => {
	it("bounds stalled tool capture without holding the host hook", async () => {
		const runtime = makeRuntime();
		let releaseCapture: (() => void) | undefined;
		runtime.handleToolResult.mockImplementation(
			async () =>
				new Promise<undefined>((resolve) => {
					releaseCapture = () => resolve(undefined);
				}),
		);
		const waitForCaptureTask = vi.fn(async () => false);
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			waitForCaptureTask,
		});
		const cleanup = await setup(fixture.context);

		await expect(
			fixture.invokeTool({
				status: "completed",
				sessionID: "session-1",
				tool: "read",
				input: {},
				result: { output: "ok" },
			}),
		).resolves.toBeUndefined();

		expect(waitForCaptureTask).toHaveBeenCalledOnce();
		expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_tool_capture_failed");
		releaseCapture?.();
		await cleanup?.();
	});
});

describe("OpenCode 2 adapter setup", () => {
	it("keeps every adapter diagnostic in the runtime allowlist", () => {
		expect(new Set(runtimeModule.__testUtils.adapterDiagnosticCodes)).toEqual(
			new Set(Object.values(hostContract.V2_ADAPTER_DIAGNOSTICS)),
		);
	});

	it("bounds each session replay cache while refreshing reused entries", () => {
		const cache = new Map<string, { text: string }>();
		const { MAX_MESSAGE_INJECTION_CACHE_ENTRIES, setSessionMessageInjectionCacheEntry } =
			runtimeModule.__testUtils;
		for (let index = 0; index < MAX_MESSAGE_INJECTION_CACHE_ENTRIES; index += 1) {
			setSessionMessageInjectionCacheEntry(cache, `message-${index}`, { text: `${index}` });
		}
		setSessionMessageInjectionCacheEntry(cache, "message-0", { text: "refreshed" });
		setSessionMessageInjectionCacheEntry(cache, "message-overflow", { text: "overflow" });

		expect(cache.size).toBe(MAX_MESSAGE_INJECTION_CACHE_ENTRIES);
		expect(cache.get("message-0")).toEqual({ text: "refreshed" });
		expect(cache.has("message-1")).toBe(false);
	});

	it("disposes the runtime when context-hook registration fails", async () => {
		const runtime = makeRuntime();
		const fixture = makeContext([], { contextHookError: new Error("context unavailable") });
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });

		await expect(setup(fixture.context)).rejects.toThrow("context unavailable");
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});

	it("disposes the context registration and runtime after a later hook fails", async () => {
		// Arrange
		const runtime = makeRuntime();
		const fixture = makeContext([], { hookError: new Error("hook unavailable") });
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });

		// Act
		await expect(setup(fixture.context)).rejects.toThrow("hook unavailable");

		// Assert
		expect(fixture.contextDispose).toHaveBeenCalledOnce();
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});

	it("disposes completed registrations when memory-tool setup fails", async () => {
		// Arrange
		const runtime = makeRuntime();
		const fixture = makeContext([], { transformError: new Error("transform unavailable") });
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });

		// Act
		await expect(setup(fixture.context)).rejects.toThrow("transform unavailable");

		// Assert
		expect(fixture.contextDispose).toHaveBeenCalledOnce();
		expect(fixture.hookDispose).toHaveBeenCalledOnce();
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});

	it("bounds registration disposal when memory-tool setup fails", async () => {
		const runtime = makeRuntime();
		runtime.reportDiagnostic.mockImplementation(async () => new Promise(() => {}));
		const waitForDiagnosticTask = vi.fn(async () => false);
		const waitForRegistrationTask = vi.fn(async () => false);
		const fixture = makeContext([], {
			stuckDispose: true,
			transformError: new Error("transform unavailable"),
		});
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			waitForDiagnosticTask,
			waitForRegistrationTask,
		});

		const result = await Promise.race([
			setup(fixture.context).then(
				() => "resolved",
				(error: Error) => error.message,
			),
			new Promise((resolve) => setTimeout(() => resolve("timed-out"), 25)),
		]);

		expect(result).toBe("transform unavailable");
		expect(waitForDiagnosticTask).toHaveBeenCalledOnce();
		expect(waitForRegistrationTask).toHaveBeenCalledTimes(2);
		expect(fixture.hookDispose).toHaveBeenCalledOnce();
		expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_registration_cleanup_timeout");
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});

	it("skips hook registration when the shared runtime rejects activation", async () => {
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => null });

		expect(await setup(fixture.context)).toBeUndefined();
		expect(fixture.context.tool.hook).not.toHaveBeenCalled();
	});
});

describe("OpenCode 2 adapter cleanup timeout", () => {
	it("bounds an in-flight context transform before disposing the runtime", async () => {
		const runtime = makeRuntime();
		let releaseContext: (() => void) | undefined;
		runtime.transformMessages.mockImplementation(
			async () =>
				new Promise((resolve) => {
					releaseContext = () => resolve({ applied: false, surface: "message" });
				}),
		);
		const waitForContextTask = vi.fn(async () => false);
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			waitForContextTask,
		});
		const cleanup = await setup(fixture.context);
		const contextTask = fixture.invokeContext({
			sessionID: "session-1",
			messages: [userMessage("user-1", "Recall")],
		});
		await vi.waitFor(() => expect(runtime.transformMessages).toHaveBeenCalledOnce());

		await cleanup?.();

		expect(waitForContextTask).toHaveBeenCalledOnce();
		expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_context_cleanup_timeout");
		expect(runtime.dispose).toHaveBeenCalledOnce();
		releaseContext?.();
		await contextTask;
	});

	it("deactivates the runtime before disposing around a stalled event handler", async () => {
		const runtime = makeRuntime();
		let releaseCapture: (() => void) | undefined;
		let active = true;
		runtime.deactivate.mockImplementation(() => {
			active = false;
		});
		runtime.handleEvent.mockImplementation(
			async () =>
				new Promise<undefined>((resolve) => {
					releaseCapture = () => {
						if (active) throw new Error("stale event handler remained active");
						resolve(undefined);
					};
				}),
		);
		const waitForCaptureTask = vi.fn(async () => false);
		const fixture = makeContext([{ type: "session.created", data: { sessionID: "session-1" } }]);
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			waitForCaptureTask,
		});
		const cleanup = await setup(fixture.context);
		await vi.waitFor(() => expect(runtime.handleEvent).toHaveBeenCalledOnce());

		await cleanup?.();
		releaseCapture?.();

		expect(runtime.deactivate).toHaveBeenCalledOnce();
		expect(runtime.deactivate.mock.invocationCallOrder[0]).toBeLessThan(
			runtime.dispose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
	});

	it("bounds stalled runtime disposal during cleanup", async () => {
		const runtime = makeRuntime();
		runtime.dispose.mockImplementation(async () => new Promise<undefined>(() => {}));
		const waitForRuntimeDisposalTask = vi.fn(async () => false);
		const fixture = makeContext();
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			waitForRuntimeDisposalTask,
		});
		const cleanup = await setup(fixture.context);

		const result = await Promise.race([
			cleanup?.().then(() => "completed"),
			new Promise((resolve) => setTimeout(() => resolve("timed-out"), 25)),
		]);

		expect(result).toBe("completed");
		expect(waitForRuntimeDisposalTask).toHaveBeenCalledOnce();
		expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_runtime_cleanup_timeout");
	});
});

describe("OpenCode 2 registration and stream cleanup timeout", () => {
	it("releases runtime ownership after bounded cleanup of a stuck registration", async () => {
		const runtime = makeRuntime();
		runtime.reportDiagnostic.mockImplementation(async () => new Promise(() => {}));
		const waitForDiagnosticTask = vi.fn(async () => false);
		const waitForRegistrationTask = vi.fn(async () => false);
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			waitForDiagnosticTask,
			waitForRegistrationTask,
		});
		const fixture = makeContext([], { stuckDispose: true });
		const cleanup = await setup(fixture.context);

		const result = await Promise.race([
			cleanup?.().then(() => "completed"),
			new Promise((resolve) => setTimeout(() => resolve("timed-out"), 25)),
		]);

		expect(result).toBe("completed");
		expect(waitForDiagnosticTask).toHaveBeenCalledOnce();
		expect(waitForRegistrationTask).toHaveBeenCalledTimes(3);
		expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_registration_cleanup_timeout");
		expect(runtime.dispose).toHaveBeenCalledOnce();
		await fixture.invokeTool({
			status: "completed",
			sessionID: "session-1",
			tool: "read",
			input: {},
			result: { output: "late" },
		});
		expect(runtime.handleToolResult).not.toHaveBeenCalled();
	});

	it("continues disposing hooks when the transform registration is stuck", async () => {
		const runtime = makeRuntime();
		let registrationWaits = 0;
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			waitForRegistrationTask: async (task: Promise<void>) => {
				registrationWaits += 1;
				if (registrationWaits === 1) return false;
				await task;
				return true;
			},
		});
		const fixture = makeContext([], { stuckTransformDispose: true });
		const cleanup = await setup(fixture.context);

		await cleanup?.();

		expect(fixture.transformDispose).toHaveBeenCalledOnce();
		expect(fixture.hookDispose).toHaveBeenCalledOnce();
		expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_registration_cleanup_timeout");
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});

	it("disables transformed memory tools before bounded cleanup returns", async () => {
		const runtime = makeRuntime();
		const executeRecent = vi.fn(async () => "recent");
		let releaseRegistrationWait: (() => void) | undefined;
		const registrationWait = new Promise<void>((resolve) => {
			releaseRegistrationWait = resolve;
		});
		runtime.tools = {
			"mem-recent": {
				description: "Show recent codemem entries",
				args: {},
				execute: executeRecent,
			},
		};
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			waitForRegistrationTask: async () => {
				await registrationWait;
				return false;
			},
		});
		const fixture = makeContext([], { stuckTransformDispose: true });
		const cleanup = await setup(fixture.context);
		const tool = fixture.addedTools[0] as { execute: (args: unknown) => Promise<unknown> };
		await expect(tool.execute({})).resolves.toEqual({ content: "recent" });

		const pendingCleanup = cleanup?.();
		fixture.invokeTransform();

		await expect(tool.execute({})).rejects.toThrow(
			"Codemem tool is unavailable after adapter cleanup",
		);
		expect(executeRecent).toHaveBeenCalledOnce();
		expect(fixture.addedTools).toHaveLength(1);
		releaseRegistrationWait?.();
		await pendingCleanup;
	});
});

describe("OpenCode 2 event stream cleanup timeout", () => {
	it("releases runtime ownership after bounded cleanup of a stuck stream", async () => {
		const firstRuntime = makeRuntime();
		firstRuntime.reportDiagnostic.mockImplementation(async () => new Promise(() => {}));
		const reloadedRuntime = makeRuntime();
		const runtimes = [firstRuntime, reloadedRuntime];
		const waitForDiagnosticTask = vi.fn(async () => false);
		const waitForEventTask = vi.fn(async () => false);
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: vi.fn(async () => runtimes.shift()),
			waitForDiagnosticTask,
			waitForEventTask,
		});
		const first = makeContext([], { stuck: true });
		const cleanup = await setup(first.context);

		await cleanup?.();
		const reloaded = makeContext();
		const reloadedCleanup = await setup(reloaded.context);
		const hookDisposeOrder = first.hookDispose.mock.invocationCallOrder[0];
		const runtimeDisposeOrder = firstRuntime.dispose.mock.invocationCallOrder[0];
		if (hookDisposeOrder === undefined || runtimeDisposeOrder === undefined) {
			throw new Error("Expected hook and runtime disposal calls");
		}

		expect(hookDisposeOrder).toBeLessThan(runtimeDisposeOrder);
		expect(waitForDiagnosticTask).toHaveBeenCalledOnce();
		expect(firstRuntime.reportDiagnostic).toHaveBeenCalledWith("v2_event_stream_cleanup_timeout");
		expect(reloaded.context.tool.hook).toHaveBeenCalled();
		await reloadedCleanup?.();
	});

	it("ignores a terminal step yielded after bounded cleanup completes", async () => {
		const runtime = makeRuntime();
		let releaseDelayedEvent: (() => void) | undefined;
		let markWaiting: (() => void) | undefined;
		let markDone: (() => void) | undefined;
		const waiting = new Promise<void>((resolve) => {
			markWaiting = resolve;
		});
		const done = new Promise<void>((resolve) => {
			markDone = resolve;
		});
		const context = {
			location: {
				directory: "/repo/worktree",
				project: { id: "project", directory: "/repo/worktree", canonical: "/repo" },
			},
			event: {
				subscribe: async function* () {
					try {
						yield {
							type: "session.step.ended",
							data: {
								sessionID: "session-1",
								assistantMessageID: "message-1",
								finish: "tool-calls",
								tokens: { input: 2, output: 1 },
							},
						};
						await new Promise<void>((resolve) => {
							releaseDelayedEvent = resolve;
							markWaiting?.();
						});
						yield {
							type: "session.step.ended",
							data: {
								sessionID: "session-1",
								assistantMessageID: "message-1",
								finish: "stop",
								tokens: { input: 3, output: 4 },
							},
						};
					} finally {
						markDone?.();
					}
				},
			},
			session: {
				hook: vi.fn(async () => ({ dispose: vi.fn(async () => undefined) })),
			},
			tool: {
				hook: vi.fn(async () => ({ dispose: vi.fn(async () => undefined) })),
				transform: vi.fn(async () => ({ dispose: vi.fn(async () => undefined) })),
			},
		};
		const setup = adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			waitForEventTask: async () => false,
		});
		const cleanup = await setup(context);
		await waiting;

		await cleanup?.();
		releaseDelayedEvent?.();
		await done;

		expect(runtime.handleEvent).not.toHaveBeenCalled();
		expect(runtime.dispose).toHaveBeenCalledOnce();
	});
});

function deferredRecall<Value>() {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((fulfill) => {
		resolve = fulfill;
	});
	return { promise, resolve };
}

function structuredRecallPack(items: Array<readonly [number, string]>) {
	let text = "## Summary\n";
	const renderedItems = items.map(([id, body]) => {
		const start = text.length;
		text += `[${id}] ${body}\n`;
		return {
			id,
			fingerprint: createHash("sha256").update(body).digest("hex"),
			spans: [{ start, end: text.length }],
		};
	});
	return {
		pack_text: text,
		rendered_items: renderedItems,
		items: renderedItems.map(({ id }) => ({ id })),
		metrics: { total_items: items.length },
	};
}

function injectedTexts(message: ReturnType<typeof userMessage> | undefined): string[] {
	return (message?.content ?? []).flatMap((part) => {
		const metadata = part.metadata as Record<string, unknown> | undefined;
		return metadata?.codememPart && typeof part.text === "string" ? [part.text] : [];
	});
}

interface RecallMeasurement {
	reason: string;
	new_tokens: number;
	retained_tokens: number;
	duplicates_omitted: number;
}

async function makeRuntimeRecallFixture(
	options: { surface?: "message" | "system"; retainedTokenBudget?: number } = {},
) {
	for (const [name, value] of Object.entries({
		CODEMEM_PLUGIN_IGNORE: "0",
		CODEMEM_RAW_EVENTS: "0",
		CODEMEM_VIEWER: "1",
		CODEMEM_VIEWER_AUTO: "0",
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
		CODEMEM_RUNNER: "codemem",
		CODEMEM_DB: "/repo/recall-test.sqlite",
		CODEMEM_PLUGIN_LOG: "/repo/recall-test.log",
		CODEMEM_PLUGIN_DEBUG: "0",
		CODEMEM_INJECT_CONTEXT: "1",
		CODEMEM_INJECT_SURFACE: options.surface ?? "message",
		CODEMEM_INJECT_TOKEN_BUDGET: "800",
		CODEMEM_INJECT_RETAINED_TOKEN_BUDGET: String(options.retainedTokenBudget ?? 0),
		CODEMEM_INJECT_HTTP_MAX_TIME_S: "60",
	})) {
		vi.stubEnv(name, value);
	}
	recallIO.appendFile.mockClear();
	recallIO.spawn.mockClear();
	const pack = structuredRecallPack([[1, "Remember the adapter contract."]]);
	const retrieve = vi.fn(async (_request: Record<string, unknown>) => pack);
	const ledger: Array<Record<string, unknown>> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname === "/api/prompt-pack-profile") {
				return Response.json({
					service: "codemem-viewer",
					protocol_version: 1,
					min_supported_protocol_version: 1,
					db_path: "/repo/recall-test.sqlite",
					identity_target: runtimeModule.__testUtils.buildViewerIdentityTarget(
						process.env,
						"/repo/worktree",
					),
				});
			}
			const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (url.pathname === "/api/pack") return Response.json(await retrieve(request));
			if (url.pathname === "/api/prompt-pack-ledger") {
				ledger.push(request);
				return Response.json({ ok: true });
			}
			throw new Error(`Unexpected mocked Viewer route: ${url.pathname}`);
		}),
	);
	const fixture = makeContext();
	const setup = adapter.createOpenCodeV2Adapter();
	const cleanup = await setup(fixture.context);
	return {
		...fixture,
		ledger,
		pack,
		retrieve,
		measurements: (): RecallMeasurement[] =>
			recallIO.appendFile.mock.calls.flatMap(([, data]) => {
				const line = String(data);
				const marker = "inject.recall ";
				const start = line.indexOf(marker);
				return start < 0 ? [] : [JSON.parse(line.slice(start + marker.length))];
			}),
		dispose: async () => {
			try {
				await cleanup?.();
				expect(recallIO.spawn).not.toHaveBeenCalled();
			} finally {
				vi.unstubAllGlobals();
				vi.unstubAllEnvs();
			}
		},
	};
}

describe("OpenCode 2 retained recall regression coverage", () => {
	it("reconstructs cached historical recall before skipping a latest user without an ID", async () => {
		const fixture = await makeRuntimeRecallFixture();
		try {
			const initial = { sessionID: "session-1", messages: [userMessage("user-1", "Recall")] };
			await fixture.invokeContext(initial);
			const delivered = injectedTexts(initial.messages[0]);
			expect(delivered).toHaveLength(1);
			const next = {
				sessionID: "session-1",
				messages: [userMessage("user-1", "Recall"), userMessage(undefined, "Unidentified turn")],
			};
			await fixture.invokeContext(next);

			expect(fixture.retrieve).toHaveBeenCalledOnce();
			expect(injectedTexts(next.messages[1])).toEqual([]);
			expect(injectedTexts(next.messages[0])).toEqual(delivered);
		} finally {
			await fixture.dispose();
		}
	});

	it("preserves a newer overlapping turn's replay entry under older-history cache pressure", async () => {
		const fixture = await makeRuntimeRecallFixture();
		const olderPack = deferredRecall<ReturnType<typeof structuredRecallPack>>();
		const olderStarted = deferredRecall<void>();
		fixture.retrieve.mockImplementationOnce(async () => {
			olderStarted.resolve();
			return olderPack.promise;
		});
		const history = () =>
			Array.from(
				{ length: runtimeModule.__testUtils.MAX_MESSAGE_INJECTION_CACHE_ENTRIES },
				(_, index) => {
					const message = userMessage(`history-${index}`, "Historical prompt");
					message.content.push(retainedRecallPart(`history-${index}`));
					return message;
				},
			);
		let olderTask: Promise<void> | undefined;
		try {
			olderTask = fixture.invokeContext({
				sessionID: "session-1",
				messages: [...history(), userMessage("older", "Older pending recall")],
			});
			await olderStarted.promise;
			const newer = {
				sessionID: "session-1",
				messages: [...history(), userMessage("newer", "Newer recall")],
			};
			await fixture.invokeContext(newer);
			const delivered = injectedTexts(newer.messages.at(-1));
			expect(delivered).toHaveLength(1);
			olderPack.resolve(structuredRecallPack([[2, "Older result"]]));
			await olderTask;
			const replay = { sessionID: "session-1", messages: [userMessage("newer", "Newer recall")] };
			await fixture.invokeContext(replay);

			expect(injectedTexts(replay.messages[0])).toEqual(delivered);
			expect(fixture.retrieve).toHaveBeenCalledTimes(2);
		} finally {
			olderPack.resolve(fixture.pack);
			await olderTask;
			await fixture.dispose();
		}
	});
});

describe("OpenCode 2 retained recall cleanup and handoff regressions", () => {
	it("does not mutate host messages or hand off a delayed transform after cleanup times out", async () => {
		const runtime = makeRecallRuntime();
		const transform = runtime.transformMessages.getMockImplementation();
		const release = deferredRecall<void>();
		const started = deferredRecall<void>();
		const completeDelivery = vi.fn();
		runtime.transformMessages.mockImplementation(async (input, output) => {
			started.resolve();
			await release.promise;
			await transform?.(input, output);
			return { applied: true, surface: "message", completeDelivery };
		});
		const fixture = makeContext();
		const waitForContextTask = vi.fn(async () => false);
		const cleanup = await adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
			waitForContextTask,
		})(fixture.context);
		const input = { sessionID: "session-1", messages: [userMessage("user-1", "Recall")] };
		const original = structuredClone(input.messages);
		const pending = fixture.invokeContext(input);
		try {
			await started.promise;
			await cleanup?.();
			expect(waitForContextTask).toHaveBeenCalledOnce();
			expect(runtime.deactivate).toHaveBeenCalledOnce();
			expect(runtime.dispose).toHaveBeenCalledOnce();
			expect(runtime.reportDiagnostic).toHaveBeenCalledWith("v2_context_cleanup_timeout");
			release.resolve();
			await pending;

			expect.soft(input.messages).toEqual(original);
			expect.soft(completeDelivery).not.toHaveBeenCalledWith("handed_off");
		} finally {
			release.resolve();
			await pending;
			await cleanup?.();
		}
	});

	it("retrieves fresh context on same-turn retry after the host handoff splice fails", async () => {
		const fixture = await makeRuntimeRecallFixture();
		try {
			const messages = Object.freeze([userMessage("user-1", "Recall")]);
			await fixture.invokeContext({ sessionID: "session-1", messages });
			await vi.waitFor(() => {
				expect(fixture.ledger).toContainEqual(
					expect.objectContaining({ action: "delivery", delivery_status: "failed" }),
				);
			});
			expect(injectedTexts(messages[0])).toEqual([]);
			const freshPack = structuredRecallPack([[2, "Fresh retrieval after rejected handoff"]]);
			fixture.retrieve.mockResolvedValue(freshPack);
			const retry = { sessionID: "session-1", messages: [userMessage("user-1", "Recall")] };
			await fixture.invokeContext(retry);

			expect.soft(fixture.retrieve.mock.calls.length).toBeGreaterThan(1);
			expect.soft(injectedTexts(retry.messages[0]).join("\n")).toContain("Fresh retrieval");
		} finally {
			await fixture.dispose();
		}
	});
});

describe("OpenCode 2 retained recall overlap regressions", () => {
	it.each(["ample", "tight"] as const)(
		"re-filters overlapping recall against newly retained memories with a %s token budget",
		async (budget) => {
			const oldFact = "Previously retained fact ".repeat(8);
			const oldPack = structuredRecallPack([[1, oldFact]]);
			const mixedPack = structuredRecallPack([
				[1, oldFact],
				[2, "New fact survives"],
			]);
			const newOnlyPack = structuredRecallPack([[2, "New fact survives"]]);
			const { estimateTokens, wrapInjectedContext } = runtimeModule.__testUtils;
			const retainedTokenBudget =
				budget === "tight"
					? estimateTokens(wrapInjectedContext(oldPack.pack_text)) +
						estimateTokens(wrapInjectedContext(newOnlyPack.pack_text))
					: 800;
			const fixture = await makeRuntimeRecallFixture({ retainedTokenBudget });
			const olderPack = deferredRecall<ReturnType<typeof structuredRecallPack>>();
			const newerPack = deferredRecall<ReturnType<typeof structuredRecallPack>>();
			const olderStarted = deferredRecall<void>();
			const newerStarted = deferredRecall<void>();
			fixture.retrieve
				.mockImplementationOnce(async () => {
					olderStarted.resolve();
					return olderPack.promise;
				})
				.mockImplementationOnce(async () => {
					newerStarted.resolve();
					return newerPack.promise;
				});
			let olderTask: Promise<void> | undefined;
			let newerTask: Promise<void> | undefined;
			try {
				const older = { sessionID: "session-1", messages: [userMessage("older", "First recall")] };
				olderTask = fixture.invokeContext(older);
				await olderStarted.promise;
				const newer = {
					sessionID: "session-1",
					messages: [userMessage("older", "First recall"), userMessage("newer", "Next recall")],
				};
				newerTask = fixture.invokeContext(newer);
				await newerStarted.promise;
				olderPack.resolve(oldPack);
				await olderTask;
				expect(injectedTexts(older.messages[0])).toHaveLength(1);
				newerPack.resolve(mixedPack);
				await newerTask;

				expect(fixture.retrieve).toHaveBeenCalledTimes(2);
				expect(injectedTexts(newer.messages[0])).toEqual(injectedTexts(older.messages[0]));
				const latestText = injectedTexts(newer.messages[1]).join("\n");
				expect.soft(latestText).not.toContain(oldFact);
				expect.soft(latestText).toContain("New fact survives");
			} finally {
				olderPack.resolve(oldPack);
				newerPack.resolve(mixedPack);
				await Promise.all([olderTask, newerTask]);
				await fixture.dispose();
			}
		},
	);
});

describe("OpenCode 2 retained recall reverse-order regression", () => {
	it("re-filters an older overlapping turn against a newer committed memory", async () => {
		const sharedFact = "Shared reverse-order memory";
		const sharedPack = structuredRecallPack([[1, sharedFact]]);
		const fixture = await makeRuntimeRecallFixture();
		const olderPack = deferredRecall<ReturnType<typeof structuredRecallPack>>();
		const newerPack = deferredRecall<ReturnType<typeof structuredRecallPack>>();
		const olderStarted = deferredRecall<void>();
		const newerStarted = deferredRecall<void>();
		fixture.retrieve
			.mockImplementationOnce(async () => {
				olderStarted.resolve();
				return olderPack.promise;
			})
			.mockImplementationOnce(async () => {
				newerStarted.resolve();
				return newerPack.promise;
			});
		let olderTask: Promise<void> | undefined;
		let newerTask: Promise<void> | undefined;
		try {
			const older = { sessionID: "session-1", messages: [userMessage("older", "First recall")] };
			olderTask = fixture.invokeContext(older);
			await olderStarted.promise;
			const newer = {
				sessionID: "session-1",
				messages: [userMessage("older", "First recall"), userMessage("newer", "Next recall")],
			};
			newerTask = fixture.invokeContext(newer);
			await newerStarted.promise;
			expect(fixture.retrieve).toHaveBeenCalledTimes(2);

			newerPack.resolve(sharedPack);
			await newerTask;
			const newerDelivery = injectedTexts(newer.messages[1]);
			expect(newerDelivery).toHaveLength(1);
			expect(newerDelivery[0]).toContain(sharedFact);

			olderPack.resolve(sharedPack);
			await olderTask;
			expect(injectedTexts(older.messages[0])).toEqual([]);

			const replay = {
				sessionID: "session-1",
				messages: [userMessage("older", "First recall"), userMessage("newer", "Next recall")],
			};
			await fixture.invokeContext(replay);

			expect(fixture.retrieve).toHaveBeenCalledTimes(2);
			expect(injectedTexts(replay.messages[0])).toEqual([]);
			expect(injectedTexts(replay.messages[1])).toEqual(newerDelivery);
			const replayText = replay.messages.flatMap(injectedTexts).join("\n");
			expect(replayText.split(sharedFact).length - 1).toBe(1);
		} finally {
			olderPack.resolve(sharedPack);
			newerPack.resolve(sharedPack);
			await Promise.all([olderTask, newerTask]);
			await fixture.dispose();
		}
	});
});

describe("OpenCode 2 retained recall deferred-publication regression", () => {
	it("serializes finalization after concurrent retrievals resolve together", async () => {
		const sharedFact = "Shared deferred-publication memory";
		const sharedPack = structuredRecallPack([[1, sharedFact]]);
		const fixture = await makeRuntimeRecallFixture();
		const olderPack = deferredRecall<ReturnType<typeof structuredRecallPack>>();
		const newerPack = deferredRecall<ReturnType<typeof structuredRecallPack>>();
		const olderStarted = deferredRecall<void>();
		const newerStarted = deferredRecall<void>();
		fixture.retrieve
			.mockImplementationOnce(async () => {
				olderStarted.resolve();
				return olderPack.promise;
			})
			.mockImplementationOnce(async () => {
				newerStarted.resolve();
				return newerPack.promise;
			});
		let olderTask: Promise<void> | undefined;
		let newerTask: Promise<void> | undefined;
		try {
			const older = { sessionID: "session-1", messages: [userMessage("older", "First recall")] };
			olderTask = fixture.invokeContext(older);
			await olderStarted.promise;
			const newer = {
				sessionID: "session-1",
				messages: [userMessage("older", "First recall"), userMessage("newer", "Next recall")],
			};
			newerTask = fixture.invokeContext(newer);
			await newerStarted.promise;
			expect(fixture.retrieve).toHaveBeenCalledTimes(2);

			newerPack.resolve(sharedPack);
			olderPack.resolve(sharedPack);
			await Promise.all([olderTask, newerTask]);

			const concurrentDelivery = newer.messages.flatMap(injectedTexts);
			expect(concurrentDelivery).toHaveLength(1);
			expect(concurrentDelivery[0]).toContain(sharedFact);

			const replay = {
				sessionID: "session-1",
				messages: [userMessage("older", "First recall"), userMessage("newer", "Next recall")],
			};
			await fixture.invokeContext(replay);

			const replayDelivery = replay.messages.flatMap(injectedTexts);
			const replayText = replayDelivery.join("\n");
			expect(replayText.split(sharedFact).length - 1).toBe(1);
		} finally {
			olderPack.resolve(sharedPack);
			newerPack.resolve(sharedPack);
			await Promise.all([olderTask, newerTask]);
			await fixture.dispose();
		}
	});
});

describe("OpenCode 2 retained recall delivery regressions", () => {
	it("records failed recall semantics instead of delivered tokens before a rejected V2 handoff", async () => {
		const fixture = await makeRuntimeRecallFixture();
		try {
			const messages = [userMessage("user-1", "Recall")];
			let beforeHandoff: RecallMeasurement[] = [];
			const splice = vi.spyOn(messages, "splice").mockImplementation(() => {
				beforeHandoff = fixture.measurements();
				throw new Error("Host rejected the handoff");
			});
			await fixture.invokeContext({ sessionID: "session-1", messages });
			expect(splice).toHaveBeenCalledOnce();
			await vi.waitFor(() => {
				expect(fixture.ledger).toContainEqual(
					expect.objectContaining({ action: "delivery", delivery_status: "failed" }),
				);
			});

			expect.soft(beforeHandoff.filter((entry) => entry.reason === "delivered")).toEqual([]);
			expect
				.soft(fixture.measurements())
				.toContainEqual(expect.objectContaining({ reason: "delivery_failed", new_tokens: 0 }));
			expect.soft(fixture.measurements().some((entry) => entry.new_tokens > 0)).toBe(false);

			splice.mockRestore();
			const retry = { sessionID: "session-1", messages: [userMessage("user-1", "Recall")] };
			await fixture.invokeContext(retry);
			expect(fixture.retrieve).toHaveBeenCalledTimes(2);
			expect(injectedTexts(retry.messages[0])).toHaveLength(1);
		} finally {
			await fixture.dispose();
		}
	});

	it("replaces retained markers in place among ordinary text and file parts", async () => {
		const runtime = makeRecallRuntime();
		const fixture = makeContext();
		const cleanup = await adapter.createOpenCodeV2Adapter({
			createRuntime: async () => runtime,
		})(fixture.context);
		try {
			const retained = userMessage("user-1", "Before retained context");
			retained.content.push(
				retainedRecallPart("user-1"),
				{ type: "text", text: "After retained context" },
				{ type: "file", mimeType: "text/plain", url: "file:///repo/example.txt" },
			);
			const originalParts = structuredClone(retained.content);
			const input = {
				sessionID: "session-1",
				messages: [retained, userMessage("user-2", "New context here")],
			};
			await fixture.invokeContext(input);

			expect(injectedTexts(input.messages[1])).toEqual([RECALL_TEXT]);
			expect(input.messages[1]?.content[0]).toEqual({ type: "text", text: "New context here" });
			expect(input.messages[0]?.content).toEqual(originalParts);
		} finally {
			await cleanup?.();
		}
	});
});

describe("OpenCode 2 retained recall system measurement regression", () => {
	it("excludes historical message-cache blocks absent from the V2 system handoff token count", async () => {
		const fixture = await makeRuntimeRecallFixture({ surface: "system" });
		try {
			const initial = {
				sessionID: "session-1",
				system: [{ type: "text", text: "Base system" }],
				messages: [userMessage("user-1", "First recall")],
			};
			await fixture.invokeContext(initial);
			expect(initial.system).toHaveLength(2);
			const latestPack = structuredRecallPack([[2, "Latest system context"]]);
			fixture.retrieve.mockResolvedValue(latestPack);
			const next = {
				sessionID: "session-1",
				system: [{ type: "text", text: "Base system" }],
				messages: [userMessage("user-1", "First recall"), userMessage("user-2", "Next recall")],
			};
			await fixture.invokeContext(next);
			expect(next.system).toHaveLength(2);
			expect(next.system[1]?.text).toContain("Latest system context");
			expect(next.system[1]?.text).not.toContain("Remember the adapter contract");
			expect(next.messages.flatMap(injectedTexts)).toEqual([]);
			await vi.waitFor(() => expect(fixture.measurements()).toHaveLength(2));
			const handedOffTokens = runtimeModule.__testUtils.estimateTokens(next.system[1]?.text);

			expect(fixture.measurements().at(-1)?.retained_tokens).toBe(handedOffTokens);
		} finally {
			await fixture.dispose();
		}
	});
});
