import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "@opencode/plugin";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

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
			},
		);
		expect(input.messages.every((message) => recallText(message) === undefined)).toBe(true);
		await cleanup?.();
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
