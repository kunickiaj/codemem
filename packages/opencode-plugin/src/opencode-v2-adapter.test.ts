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

function makeRuntime() {
	return {
		deactivate: vi.fn(),
		dispose: vi.fn(async () => undefined),
		handleEvent: vi.fn(async () => undefined),
		handleToolResult: vi.fn(async () => undefined),
		reportDiagnostic: vi.fn(async () => undefined),
	};
}

function makeContext(
	events: readonly unknown[] = [],
	options: { eventError?: Error; hookError?: Error; stuck?: boolean; stuckDispose?: boolean } = {},
) {
	const aborted = { value: false };
	const hookDispose = vi.fn(async () => {
		if (options.stuckDispose) await new Promise(() => {});
	});
	let toolHook: ((input: unknown) => Promise<void>) | undefined;
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
		tool: {
			hook: vi.fn(async (_name: string, callback: (input: unknown) => Promise<void>) => {
				if (options.hookError) throw options.hookError;
				toolHook = callback;
				return { dispose: hookDispose };
			}),
		},
	};
	return { aborted, context, hookDispose, invokeTool: (input: unknown) => toolHook?.(input) };
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
	it("disposes the runtime after partial setup failure", async () => {
		const runtime = makeRuntime();
		const fixture = makeContext([], { hookError: new Error("hook unavailable") });
		const setup = adapter.createOpenCodeV2Adapter({ createRuntime: async () => runtime });

		await expect(setup(fixture.context)).rejects.toThrow("hook unavailable");
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
		expect(waitForRegistrationTask).toHaveBeenCalledOnce();
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
			tool: {
				hook: vi.fn(async () => ({ dispose: vi.fn(async () => undefined) })),
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
