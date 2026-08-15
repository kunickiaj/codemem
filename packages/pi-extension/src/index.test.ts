import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapPiEventPayload } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiExtensionConfig } from "./config.js";
import { defaultPiExtensionConfig } from "./config.js";
import codememPiExtension, {
	__setTestExecImpl,
	expectedToolNames,
	formatPiInjectionBlock,
	stableMessageEntryId,
} from "./index.js";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

function createMockPi() {
	const handlers = new Map<string, Handler[]>();
	const tools: Array<{ name: string; execute: (...args: unknown[]) => unknown }> = [];
	const appended: Array<{ type: string; data: unknown }> = [];

	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(def: { name: string; execute: (...args: unknown[]) => unknown }) {
			tools.push(def);
		},
		appendEntry(customType: string, data?: unknown) {
			appended.push({ type: customType, data });
		},
	};

	return { pi, handlers, tools, appended };
}

function createMockCtx(
	overrides: {
		sessionId?: string;
		cwd?: string;
		entries?: unknown[];
		signal?: AbortSignal;
		/** When set, getLeafEntry returns this value (including null). */
		leafEntry?: { id?: string; type?: string } | null;
	} = {},
) {
	const sessionId = overrides.sessionId ?? "sess-test-1";
	const cwd = overrides.cwd ?? "/tmp/codemem-pi-test";
	const leafEntry = Object.hasOwn(overrides, "leafEntry") ? overrides.leafEntry : null;
	return {
		cwd,
		signal: overrides.signal ?? new AbortController().signal,
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => overrides.entries ?? [],
			getLeafEntry: () => leafEntry,
			getSessionFile: () => null,
		},
		ui: {
			notify: vi.fn(),
		},
	};
}

describe("extension factory lifecycle", () => {
	afterEach(() => {
		__setTestExecImpl(null);
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("registers session + agent + tool handlers without starting daemons", () => {
		const { pi, handlers, tools } = createMockPi();
		codememPiExtension(pi as never);

		const expectedEvents = [
			"session_start",
			"session_shutdown",
			"message_end",
			"tool_call",
			"tool_result",
			"session_before_compact",
			"before_agent_start",
		];
		for (const name of expectedEvents) {
			expect(handlers.has(name), `missing handler for ${name}`).toBe(true);
		}
		expect(tools.map((t) => t.name).toSorted()).toEqual(expectedToolNames().toSorted());
	});

	it("skips native tools when tools_mode is mcp-adapter", () => {
		vi.stubEnv("CODEMEM_PI_TOOLS_MODE", "mcp-adapter");
		const { pi, tools } = createMockPi();
		codememPiExtension(pi as never);
		expect(tools).toHaveLength(0);
	});

	it("session_start re-keys state and persists cursor after ingest attempt", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		__setTestExecImpl(async () => ({
			stdout: JSON.stringify({ inserted: 1, skipped: 0, via: "cli" }),
			stderr: "",
		}));

		const { pi, handlers, appended } = createMockPi();
		codememPiExtension(pi as never);

		const ctx = createMockCtx({ sessionId: "sess-fork-9", cwd: "/work/app" });
		const startHandlers = handlers.get("session_start") ?? [];
		await startHandlers[0]?.({ type: "session_start", reason: "startup" }, ctx);

		expect(appended.some((e) => e.type === "codemem.cursor")).toBe(true);
		expect(ctx.sessionManager.getSessionId()).toBe("sess-fork-9");
	});

	it("session_before_compact handler never returns compaction", async () => {
		__setTestExecImpl(async () => ({ stdout: "{}", stderr: "" }));
		const { pi, handlers } = createMockPi();
		codememPiExtension(pi as never);
		const ctx = createMockCtx();
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		const result = await handlers.get("session_before_compact")?.[0]?.(
			{
				type: "session_before_compact",
				reason: "threshold",
				willRetry: false,
				signal: ctx.signal,
				preparation: {},
				branchEntries: [],
			},
			ctx,
		);
		expect(result).toBeUndefined();
		if (result && typeof result === "object") {
			expect(result).not.toHaveProperty("compaction");
		}
	});

	it("session_before_compact bypasses HTTP and calls CLI pi-hook-ingest; returns undefined", async () => {
		const execCalls: Array<{ args: string[]; stdin?: string }> = [];
		__setTestExecImpl(async (args, opts) => {
			execCalls.push({ args: [...args], stdin: opts?.stdin });
			return {
				stdout: JSON.stringify({ inserted: 0, skipped: 1, via: "cli" }),
				stderr: "",
			};
		});

		// HTTP looks healthy and would "succeed" with skipped:1 for flush-only —
		// the bug was treating that as done without ever flushing via CLI.
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/raw-events/status")) {
				return {
					ok: true,
					json: async () => ({ ingest: { available: true } }),
					text: async () => JSON.stringify({ ingest: { available: true } }),
				};
			}
			if (url.includes("/api/pi-hooks")) {
				return {
					ok: true,
					json: async () => ({ inserted: 0, skipped: 1 }),
					text: async () => JSON.stringify({ inserted: 0, skipped: 1 }),
				};
			}
			return {
				ok: false,
				status: 404,
				json: async () => ({}),
				text: async () => "",
			};
		});
		vi.stubGlobal("fetch", fetchMock);

		const { pi, handlers } = createMockPi();
		codememPiExtension(pi as never);
		const ctx = createMockCtx();
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		const piHooksBefore = fetchMock.mock.calls.filter((c) =>
			String(c[0]).includes("/api/pi-hooks"),
		).length;

		const result = await handlers.get("session_before_compact")?.[0]?.(
			{
				type: "session_before_compact",
				reason: "threshold",
				willRetry: false,
				signal: ctx.signal,
				preparation: {},
				branchEntries: [],
			},
			ctx,
		);

		expect(result).toBeUndefined();
		const compactCli = execCalls.filter((c) => c.args[0] === "pi-hook-ingest");
		expect(compactCli.length).toBeGreaterThanOrEqual(1);
		const last = compactCli[compactCli.length - 1];
		expect(last?.stdin).toBeTruthy();
		const body = JSON.parse(String(last?.stdin)) as { piEvent?: string };
		expect(body.piEvent).toBe("session_before_compact");

		const piHooksAfter = fetchMock.mock.calls.filter((c) =>
			String(c[0]).includes("/api/pi-hooks"),
		).length;
		expect(piHooksAfter).toBe(piHooksBefore);
	});

	it("two session_before_compact firings both send distinct CLI flushes", async () => {
		const compactPayloads: Array<Record<string, unknown>> = [];
		__setTestExecImpl(async (args, opts) => {
			if (args[0] === "pi-hook-ingest" && opts?.stdin) {
				const body = JSON.parse(opts.stdin) as Record<string, unknown>;
				if (body.piEvent === "session_before_compact") {
					compactPayloads.push(body);
				}
			}
			return {
				stdout: JSON.stringify({ inserted: 0, skipped: 1 }),
				stderr: "",
			};
		});

		const { pi, handlers, appended } = createMockPi();
		codememPiExtension(pi as never);
		const ctx = createMockCtx();
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		const compactEvent = {
			type: "session_before_compact",
			reason: "threshold",
			willRetry: false,
			signal: ctx.signal,
			preparation: {},
			branchEntries: [],
		};
		await handlers.get("session_before_compact")?.[0]?.(compactEvent, ctx);
		await handlers.get("session_before_compact")?.[0]?.(compactEvent, ctx);

		expect(compactPayloads).toHaveLength(2);
		expect(compactPayloads[0]?.entryId).not.toEqual(compactPayloads[1]?.entryId);
		// Flush signals must never land in the durable seen cursor.
		for (const entry of appended) {
			if (entry.type !== "codemem.cursor") continue;
			const data = entry.data as { seenEventKeys?: string[] };
			const keys = data.seenEventKeys ?? [];
			expect(keys.some((k) => k.includes("session_before_compact"))).toBe(false);
		}
	});

	it("failed ingest leaves event unseen so a retry is attempted", async () => {
		const execState = { fail: true, messageEndCalls: 0 };
		__setTestExecImpl(async (args, opts) => {
			if (args[0] === "pi-hook-ingest" && opts?.stdin) {
				const body = JSON.parse(opts.stdin) as { piEvent?: string };
				if (body.piEvent === "message_end") {
					execState.messageEndCalls += 1;
					if (execState.fail) throw new Error("cli down");
				}
			}
			return {
				stdout: JSON.stringify({ inserted: 1, skipped: 0 }),
				stderr: "",
			};
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);

		const { pi, handlers, appended } = createMockPi();
		codememPiExtension(pi as never);
		const ctx = createMockCtx({ sessionId: "sess-retry" });
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		const ts = 1_700_000_000_001;
		const expectedEntryId = stableMessageEntryId("sess-retry", "user", "please retry me", ts);
		const msgEvent = {
			type: "message_end",
			// Real pi-ai shape: role/content/timestamp only (no id/index).
			message: { role: "user", timestamp: ts, content: "please retry me" },
		};
		await handlers.get("message_end")?.[0]?.(msgEvent, ctx);
		expect(execState.messageEndCalls).toBe(1);

		// Failed delivery must not persist a cursor key for this event.
		const keysAfterFail = appended
			.filter((e) => e.type === "codemem.cursor")
			.flatMap((e) => {
				const data = e.data as { seenEventKeys?: string[] };
				return data.seenEventKeys ?? [];
			});
		expect(keysAfterFail.some((k) => k.includes(expectedEntryId))).toBe(false);

		// Same event fires again (or after resume without a durable mark) → retry.
		execState.fail = false;
		await handlers.get("message_end")?.[0]?.(msgEvent, ctx);
		expect(execState.messageEndCalls).toBe(2);

		const keysAfterOk = appended
			.filter((e) => e.type === "codemem.cursor")
			.flatMap((e) => {
				const data = e.data as { seenEventKeys?: string[] };
				return data.seenEventKeys ?? [];
			});
		expect(keysAfterOk.some((k) => k.includes(expectedEntryId))).toBe(true);

		// Third fire is suppressed by seen cursor.
		await handlers.get("message_end")?.[0]?.(msgEvent, ctx);
		expect(execState.messageEndCalls).toBe(2);
	});

	it("message_end entryId is a stable hash — never wall-clock, random, or leaf id", async () => {
		const entryIds: string[] = [];
		__setTestExecImpl(async (args, opts) => {
			if (args[0] === "pi-hook-ingest" && opts?.stdin) {
				const body = JSON.parse(opts.stdin) as { piEvent?: string; entryId?: string };
				if (body.piEvent === "message_end" && typeof body.entryId === "string") {
					entryIds.push(body.entryId);
				}
			}
			return {
				stdout: JSON.stringify({ inserted: 1, skipped: 0 }),
				stderr: "",
			};
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);

		const { pi, handlers } = createMockPi();
		codememPiExtension(pi as never);
		const ctx = createMockCtx({ sessionId: "sess-hash" });
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		const ts = 1_700_000_000_042;
		const msg = {
			type: "message_end",
			message: { role: "user", timestamp: ts, content: "deterministic please" },
		};
		await handlers.get("message_end")?.[0]?.(msg, ctx);

		// Force a second extension instance so the same content is ingested again
		// under a fresh seen set — entryId must match exactly (timestamp discriminator).
		const { pi: pi2, handlers: handlers2 } = createMockPi();
		codememPiExtension(pi2 as never);
		const ctx2 = createMockCtx({ sessionId: "sess-hash" });
		await handlers2.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx2);
		await handlers2.get("message_end")?.[0]?.(msg, ctx2);

		expect(entryIds).toHaveLength(2);
		expect(entryIds[0]).toBe(entryIds[1]);
		const expected = stableMessageEntryId("sess-hash", "user", "deterministic please", ts);
		expect(entryIds[0]).toBe(expected);
		expect(entryIds[0]).toMatch(/^msg-[0-9a-f]{24}$/);
		// Guard against the old Date.now()/Math.random() shape.
		expect(entryIds[0]).not.toMatch(/user-\d{10,}/);
		expect(entryIds[0]).not.toMatch(/[0-9]+-[a-z0-9]{4,}$/);
	});

	it("message_end never adopts getLeafEntry (codemem.cursor leaf is poisonous)", async () => {
		const entryIds: string[] = [];
		__setTestExecImpl(async (args, opts) => {
			if (args[0] === "pi-hook-ingest" && opts?.stdin) {
				const body = JSON.parse(opts.stdin) as { piEvent?: string; entryId?: string };
				if (body.piEvent === "message_end" && typeof body.entryId === "string") {
					entryIds.push(body.entryId);
				}
			}
			return {
				stdout: JSON.stringify({ inserted: 1, skipped: 0 }),
				stderr: "",
			};
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);

		const { pi, handlers } = createMockPi();
		codememPiExtension(pi as never);
		// Real lifecycle: message_end runs before the ending message is persisted, so
		// the leaf is often our own cursor custom entry from a prior ingest.
		const poisonedLeafId = "cursor-leaf-poison-99";
		const ctx = createMockCtx({
			sessionId: "sess-leaf-poison",
			leafEntry: { id: poisonedLeafId, type: "custom" },
		});
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		const ts = 1_700_000_000_100;
		await handlers.get("message_end")?.[0]?.(
			{
				type: "message_end",
				// No id/index — those fields do not exist on pi-ai UserMessage.
				message: { role: "user", timestamp: ts, content: "ignore the leaf" },
			},
			ctx,
		);

		expect(entryIds).toHaveLength(1);
		expect(entryIds[0]).not.toBe(poisonedLeafId);
		expect(entryIds[0]).toBe(
			stableMessageEntryId("sess-leaf-poison", "user", "ignore the leaf", ts),
		);
	});

	it("two identical user turns with distinct timestamps both ingest; same-timestamp retry dedupes", async () => {
		const messageEndPayloads: Array<{ entryId?: string; text?: string }> = [];
		__setTestExecImpl(async (args, opts) => {
			if (args[0] === "pi-hook-ingest" && opts?.stdin) {
				const body = JSON.parse(opts.stdin) as {
					piEvent?: string;
					entryId?: string;
					text?: string;
				};
				if (body.piEvent === "message_end") {
					messageEndPayloads.push({ entryId: body.entryId, text: body.text });
				}
			}
			return {
				stdout: JSON.stringify({ inserted: 1, skipped: 0 }),
				stderr: "",
			};
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);

		const { pi, handlers } = createMockPi();
		codememPiExtension(pi as never);
		// Simulate real pi: leaf is a prior codemem.cursor custom entry (poisonous if used).
		const ctx = createMockCtx({
			sessionId: "sess-lgtm",
			leafEntry: { id: "codemem-cursor-stale-leaf", type: "custom" },
		});
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		const handler = handlers.get("message_end")?.[0];
		// Two consecutive user turns saying "lgtm" — real messages have timestamps, not ids.
		await handler?.(
			{
				type: "message_end",
				message: { role: "user", timestamp: 1_700_000_001_001, content: "lgtm" },
			},
			ctx,
		);
		await handler?.(
			{
				type: "message_end",
				message: { role: "user", timestamp: 1_700_000_001_002, content: "lgtm" },
			},
			ctx,
		);

		expect(messageEndPayloads).toHaveLength(2);
		const id1 = messageEndPayloads[0]?.entryId;
		const id2 = messageEndPayloads[1]?.entryId;
		expect(id1).toBeTruthy();
		expect(id2).toBeTruthy();
		expect(id1).not.toBe(id2);
		expect(id1).not.toBe("codemem-cursor-stale-leaf");
		expect(id2).not.toBe("codemem-cursor-stale-leaf");
		expect(id1).toBe(stableMessageEntryId("sess-lgtm", "user", "lgtm", 1_700_000_001_001));
		expect(id2).toBe(stableMessageEntryId("sess-lgtm", "user", "lgtm", 1_700_000_001_002));

		// True retry of turn 1 (same timestamp object value) is suppressed by seen cursor.
		await handler?.(
			{
				type: "message_end",
				message: { role: "user", timestamp: 1_700_000_001_001, content: "lgtm" },
			},
			ctx,
		);
		expect(messageEndPayloads).toHaveLength(2);

		// No timestamp: per-session monotonic discriminator distinguishes identical content.
		await handler?.({ type: "message_end", message: { role: "user", content: "lgtm" } }, ctx);
		await handler?.({ type: "message_end", message: { role: "user", content: "lgtm" } }, ctx);
		expect(messageEndPayloads).toHaveLength(4);
		const fallbackIds = messageEndPayloads.slice(2).map((p) => p.entryId);
		expect(fallbackIds[0]).toBe(stableMessageEntryId("sess-lgtm", "user", "lgtm", "n:1"));
		expect(fallbackIds[1]).toBe(stableMessageEntryId("sess-lgtm", "user", "lgtm", "n:2"));
		expect(fallbackIds[0]).not.toBe(fallbackIds[1]);
		for (const id of fallbackIds) {
			expect(id).toMatch(/^msg-[0-9a-f]{24}$/);
			expect(id).not.toMatch(/user-\d{10,}/);
		}

		// Retry of the same no-timestamp message is NOT stable across firings (seq advances),
		// but a same-timestamp retry above already covers durable dedupe. Seq retry of the
		// exact prior seq id still dedupes if the caller reconstructs the same entryId
		// via a second fire with the same timestamp path only.
	});

	it("tool_call / tool_result identity keys on toolCallId (untouched by message_end redesign)", async () => {
		const toolPayloads: Array<{ piEvent?: string; toolCallId?: string; entryId?: string }> = [];
		__setTestExecImpl(async (args, opts) => {
			if (args[0] === "pi-hook-ingest" && opts?.stdin) {
				const body = JSON.parse(opts.stdin) as {
					piEvent?: string;
					toolCallId?: string;
					entryId?: string;
				};
				if (body.piEvent === "tool_call" || body.piEvent === "tool_result") {
					toolPayloads.push(body);
				}
			}
			return {
				stdout: JSON.stringify({ inserted: 1, skipped: 0 }),
				stderr: "",
			};
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);

		const { pi, handlers } = createMockPi();
		codememPiExtension(pi as never);
		const ctx = createMockCtx({
			sessionId: "sess-tools",
			leafEntry: { id: "should-not-appear", type: "custom" },
		});
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		await handlers.get("tool_call")?.[0]?.(
			{
				type: "tool_call",
				toolCallId: "tc-stable-7",
				toolName: "read",
				input: { path: "a.ts" },
			},
			ctx,
		);
		await handlers.get("tool_result")?.[0]?.(
			{
				type: "tool_result",
				toolCallId: "tc-stable-7",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
			ctx,
		);

		expect(toolPayloads).toHaveLength(2);
		expect(toolPayloads[0]).toMatchObject({
			piEvent: "tool_call",
			toolCallId: "tc-stable-7",
		});
		expect(toolPayloads[1]).toMatchObject({
			piEvent: "tool_result",
			toolCallId: "tc-stable-7",
		});
		// Must not fall back to leaf entry id.
		for (const p of toolPayloads) {
			expect(p.entryId).not.toBe("should-not-appear");
			expect(p.toolCallId).toBe("tc-stable-7");
		}

		// Retry of the same toolCallId is deduped by seen cursor.
		await handlers.get("tool_call")?.[0]?.(
			{
				type: "tool_call",
				toolCallId: "tc-stable-7",
				toolName: "read",
				input: { path: "a.ts" },
			},
			ctx,
		);
		expect(toolPayloads).toHaveLength(2);
	});

	it("session_start warns once when native mode + mcp.json codemem entry coexist", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "codemem-pi-mcp-warn-"));
		const piDir = join(tempRoot, "agent");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(
			join(piDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					codemem: { command: "npx", args: ["-y", "codemem", "mcp"] },
				},
			}),
			"utf8",
		);
		vi.stubEnv("PI_CODING_AGENT_DIR", piDir);
		__setTestExecImpl(async () => ({
			stdout: JSON.stringify({ inserted: 1, skipped: 0 }),
			stderr: "",
		}));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);

		try {
			const { pi, handlers } = createMockPi();
			codememPiExtension(pi as never);
			const ctx = createMockCtx();
			await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
			expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
			const msg = String(ctx.ui.notify.mock.calls[0]?.[0] ?? "");
			expect(msg).toMatch(/mcp\.json/i);
			expect(msg).toMatch(/tools_mode/i);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

describe("injection (before_agent_start)", () => {
	afterEach(() => {
		__setTestExecImpl(null);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("appends only systemPrompt (never message) on successful pack", async () => {
		vi.stubEnv("CODEMEM_PI_INJECT_PROMPTS", "1");
		const packText = "• past decision about auth";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/api/pack")) {
					return {
						ok: true,
						json: async () => ({
							pack_text: packText,
							items: [1],
							metrics: { pack_tokens: 10 },
						}),
						text: async () =>
							JSON.stringify({
								pack_text: packText,
								items: [1],
								metrics: { pack_tokens: 10 },
							}),
					};
				}
				if (url.includes("/api/raw-events/status")) {
					return {
						ok: true,
						json: async () => ({ ingest: { available: true } }),
						text: async () => JSON.stringify({ ingest: { available: true } }),
					};
				}
				return {
					ok: false,
					status: 404,
					json: async () => ({}),
					text: async () => "",
				};
			}),
		);

		const { pi, handlers } = createMockPi();
		codememPiExtension(pi as never);
		const ctx = createMockCtx();
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		const result = (await handlers.get("before_agent_start")?.[0]?.(
			{
				type: "before_agent_start",
				prompt: "how does auth work?",
				systemPrompt: "You are helpful.",
				systemPromptOptions: {},
			},
			ctx,
		)) as { systemPrompt?: string; message?: unknown } | undefined;

		expect(result).toBeDefined();
		expect(result?.message).toBeUndefined();
		expect(result?.systemPrompt).toContain("You are helpful.");
		expect(result?.systemPrompt).toContain("## codemem memories");
		expect(result?.systemPrompt).toContain(packText);
		expect(Object.keys(result ?? {}).toSorted()).toEqual(["systemPrompt"]);
	});

	it("returns undefined (no mutation) when pack empty / fetch fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("down");
			}),
		);
		__setTestExecImpl(async () => {
			throw new Error("cli missing");
		});

		const { pi, handlers } = createMockPi();
		codememPiExtension(pi as never);
		const ctx = createMockCtx();
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);

		const result = await handlers.get("before_agent_start")?.[0]?.(
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: "base",
				systemPromptOptions: {},
			},
			ctx,
		);
		expect(result).toBeUndefined();
	});

	it("formatPiInjectionBlock never produces a persistent message shape", () => {
		const block = formatPiInjectionBlock("x", 1000);
		expect(block).not.toMatch(/"customType"/);
		expect(typeof block).toBe("string");
	});
});

describe("tool execute fail-open", () => {
	afterEach(() => {
		__setTestExecImpl(null);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("every registered tool returns a result on transport failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("viewer down");
			}),
		);
		__setTestExecImpl(async () => {
			throw new Error("cli missing");
		});

		const { pi, tools } = createMockPi();
		codememPiExtension(pi as never);
		expect(tools.length).toBe(expectedToolNames().length);

		const signal = new AbortController().signal;
		for (const tool of tools) {
			const params = minimalParams(tool.name);
			const result = (await tool.execute("call-1", params, signal, undefined, {})) as {
				content?: unknown;
				details?: { isError?: boolean };
			};
			expect(result, tool.name).toBeDefined();
			expect(Array.isArray(result.content), tool.name).toBe(true);
			if (tool.name === "memory_learn") {
				expect(result.details?.isError).toBeFalsy();
			}
		}
	});
});

describe("config defaults", () => {
	it("default config is native tools + inject + file_context", () => {
		const cfg: PiExtensionConfig = defaultPiExtensionConfig();
		expect(cfg.toolsMode).toBe("native");
		expect(cfg.injectPrompts).toBe(true);
		expect(cfg.fileContext).toBe(true);
		expect(cfg.viewerPort).toBe(38888);
	});
});

describe("message_end payload feeds core adapter", () => {
	it("user message produces prompt event_id", () => {
		const payload = {
			piEvent: "message_end",
			sessionId: "s1",
			entryId: "e1",
			role: "user",
			text: "hi",
			cwd: "/x",
		};
		const adapter = mapPiEventPayload(payload);
		expect(adapter?.source).toBe("pi");
		expect(adapter?.event_type).toBe("prompt");
		expect(adapter?.event_id).toBe("pi:s1:e1");
	});
});

function minimalParams(name: string): Record<string, unknown> {
	switch (name) {
		case "memory_search":
		case "memory_search_index":
			return { query: "test" };
		case "memory_explain":
			return { query: "test" };
		case "memory_recent":
			return { limit: 3 };
		case "memory_pack":
			return { context: "test" };
		case "memory_get":
		case "memory_forget":
			return { memory_id: 1 };
		case "memory_get_observations":
			return { ids: [1] };
		case "memory_remember":
			return { kind: "discovery", title: "t", body: "b" };
		case "memory_learn":
		case "memory_schema":
			return {};
		case "memory_timeline":
			return { memory_id: 1 };
		case "memory_expand":
			return { ids: [1] };
		case "memory_distill_candidates":
			return { limit: 2 };
		default:
			return {};
	}
}
