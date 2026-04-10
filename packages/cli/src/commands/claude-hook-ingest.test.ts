import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claudeHookIngestCommand,
	directEnqueue,
	ingestClaudeHookPayload,
} from "./claude-hook-ingest.js";

function createTempDbPath(): { dbPath: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "codemem-cli-claude-hook-"));
	const dbPath = join(dir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	return {
		dbPath,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("claude-hook-ingest command", () => {
	let sandboxDir: string;
	let stateDir: string;
	let lockDir: string;
	let queueDir: string;
	let pluginLogPath: string;
	const savedEnv: Record<string, string | undefined> = {};

	const sandboxedEnvKeys = [
		"CODEMEM_CLAUDE_HOOK_CONTEXT_DIR",
		"CODEMEM_CLAUDE_HOOK_LOCK_DIR",
		"CODEMEM_CLAUDE_HOOK_SPOOL_DIR",
		"CODEMEM_PLUGIN_LOG_PATH",
		"CODEMEM_PLUGIN_LOG",
		"CODEMEM_CLAUDE_HOOK_FLUSH",
		"CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP",
		"CODEMEM_CLAUDE_HOOK_LOCK_TTL_S",
		"CODEMEM_CLAUDE_HOOK_LOCK_GRACE_S",
	];

	beforeEach(() => {
		sandboxDir = mkdtempSync(join(tmpdir(), "codemem-cli-ingest-test-"));
		stateDir = join(sandboxDir, "state");
		lockDir = join(sandboxDir, "lock");
		queueDir = join(sandboxDir, "spool");
		pluginLogPath = join(sandboxDir, "plugin.log");
		for (const key of sandboxedEnvKeys) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR = stateDir;
		process.env.CODEMEM_CLAUDE_HOOK_LOCK_DIR = lockDir;
		process.env.CODEMEM_CLAUDE_HOOK_SPOOL_DIR = queueDir;
		process.env.CODEMEM_PLUGIN_LOG_PATH = pluginLogPath;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(sandboxDir, { recursive: true, force: true });
	});

	it("registers expected options and help text", () => {
		const longs = claudeHookIngestCommand.options.map((option) => option.long);
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--host");
		expect(longs).toContain("--port");

		const help = claudeHookIngestCommand.helpInformation();
		expect(help).toContain("HTTP first");
		expect(help).toContain("direct DB fallback");
	});

	it("returns HTTP result when viewer ingest succeeds", async () => {
		const result = await ingestClaudeHookPayload(
			{ hook_event_name: "SessionStart", session_id: "sess-http", cwd: "/tmp/demo" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 2, skipped: 1 }),
				directIngest: () => {
					throw new Error("direct ingest should not be called");
				},
				resolveDb: () => {
					throw new Error("resolveDb should not be called");
				},
			},
		);

		expect(result).toEqual({ inserted: 2, skipped: 1, via: "http" });
	});

	it("falls back to direct ingest when HTTP path fails", async () => {
		const result = await ingestClaudeHookPayload(
			{ hook_event_name: "SessionStart", session_id: "sess-direct", cwd: "/tmp/demo" },
			{ host: "127.0.0.1", port: 38888, db: "/tmp/custom.sqlite" },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => ({ inserted: 1, skipped: 0 }),
				resolveDb: () => "/tmp/resolved.sqlite",
			},
		);

		expect(result).toEqual({ inserted: 1, skipped: 0, via: "direct" });
	});

	it("direct enqueue inserts once and then deduplicates event_id", () => {
		const { dbPath, cleanup } = createTempDbPath();
		try {
			const payload = {
				hook_event_name: "SessionStart",
				session_id: "sess-dedup",
				timestamp: "2026-01-01T00:00:00Z",
				cwd: "/tmp/demo",
			};

			const first = directEnqueue(payload, dbPath);
			const second = directEnqueue(payload, dbPath);

			expect(first).toEqual({ inserted: 1, skipped: 0 });
			expect(second).toEqual({ inserted: 0, skipped: 0 });

			const db = connect(dbPath);
			try {
				const rawCount = db.prepare("SELECT COUNT(*) AS c FROM raw_events").get() as { c: number };
				const sessionCount = db.prepare("SELECT COUNT(*) AS c FROM raw_event_sessions").get() as {
					c: number;
				};
				expect(rawCount.c).toBe(1);
				expect(sessionCount.c).toBe(1);
			} finally {
				db.close();
			}
		} finally {
			cleanup();
		}
	});

	it("direct enqueue skips unsupported hook payloads gracefully", () => {
		const { dbPath, cleanup } = createTempDbPath();
		try {
			const result = directEnqueue(
				{ hook_event_name: "UnknownEvent", session_id: "sess-x" },
				dbPath,
			);
			expect(result).toEqual({ inserted: 0, skipped: 1 });
		} finally {
			cleanup();
		}
	});

	it("direct enqueue bootstraps fresh databases on demand", () => {
		// Fresh path without initTestSchema() — the failure mode Cowork sandbox
		// VMs hit when the hook fires before the MCP server finishes its own
		// MemoryStore construction. Without ensureSchemaBootstrapped this call
		// would throw "no such table: raw_events".
		const dir = mkdtempSync(join(tmpdir(), "codemem-cli-direct-bootstrap-"));
		const dbPath = join(dir, "fresh.sqlite");
		try {
			const result = directEnqueue(
				{
					hook_event_name: "SessionStart",
					session_id: "sess-fresh-bootstrap",
					timestamp: "2026-01-01T00:00:00Z",
					cwd: "/tmp/demo",
				},
				dbPath,
			);
			expect(result).toEqual({ inserted: 1, skipped: 0 });

			// Re-open through a plain connect() and verify the raw event actually
			// landed in the auto-bootstrapped schema.
			const db = connect(dbPath);
			try {
				const rawCount = db.prepare("SELECT COUNT(*) AS c FROM raw_events").get() as {
					c: number;
				};
				expect(rawCount.c).toBe(1);
			} finally {
				db.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe("durability layer", () => {
		it("drains spooled backlog on the HTTP-success path so a recovered viewer doesn't strand entries", async () => {
			// Pre-seed a payload from a previous failed run.
			mkdirSync(queueDir, { recursive: true });
			writeFileSync(
				join(queueDir, "hook-0000000001-pid-1.json"),
				JSON.stringify({
					hook_event_name: "Stop",
					session_id: "previously-spooled",
					tag: "queued",
				}),
				"utf8",
			);

			const httpCalls: Array<Record<string, unknown>> = [];
			const result = await ingestClaudeHookPayload(
				{ hook_event_name: "Stop", session_id: "fresh", tag: "fresh" },
				{ host: "127.0.0.1", port: 38888 },
				{
					httpIngest: async (payload) => {
						httpCalls.push(payload);
						return { ok: true, inserted: 1, skipped: 0 };
					},
					directIngest: () => {
						throw new Error("direct ingest should not be called when HTTP succeeds");
					},
					boundaryFlush: () => {},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);

			// Fresh payload still routed via HTTP.
			expect(result).toEqual({ inserted: 1, skipped: 0, via: "http" });
			// httpIngest called twice: once for the fresh payload, once for
			// the drained backlog entry.
			expect(httpCalls.map((p) => p.tag)).toEqual(["fresh", "queued"]);
			// Backlog entry consumed by the drainer.
			expect(readdirSync(queueDir)).toHaveLength(0);
		});

		it("skips backlog drain on HTTP success when spool is empty (no extra HTTP calls)", async () => {
			let httpCallCount = 0;
			const result = await ingestClaudeHookPayload(
				{ hook_event_name: "Stop", session_id: "no-backlog" },
				{ host: "127.0.0.1", port: 38888 },
				{
					httpIngest: async () => {
						httpCallCount++;
						return { ok: true, inserted: 1, skipped: 0 };
					},
					directIngest: () => {
						throw new Error("direct ingest should not be called");
					},
					boundaryFlush: () => {},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);
			expect(result.via).toBe("http");
			// Empty spool → exactly one httpIngest call (no drain pass).
			expect(httpCallCount).toBe(1);
		});

		it("treats HTTP `skipped > 0` (deterministic null envelope) as a successful no-op", async () => {
			// The viewer only returns {inserted:0, skipped:1} when
			// buildRawEventEnvelopeFromHook produces a null envelope — a
			// deterministic decision for payloads like a Stop event with no
			// assistant text. Retrying via the direct path would produce the
			// same null envelope and the same skip, so the ingest command
			// accepts this as a no-op success instead of triggering the
			// durability fallback.
			let directCalls = 0;
			const result = await ingestClaudeHookPayload(
				{ hook_event_name: "Stop", session_id: "sess-no-text" },
				{ host: "127.0.0.1", port: 38888 },
				{
					httpIngest: async () => ({ ok: true, inserted: 0, skipped: 1 }),
					directIngest: () => {
						directCalls++;
						return { inserted: 1, skipped: 0 };
					},
					boundaryFlush: () => {
						throw new Error("boundary flush should not run for Stop without flush envs");
					},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);
			expect(result).toEqual({ inserted: 0, skipped: 1, via: "http" });
			expect(directCalls).toBe(0);
		});

		it("spools the payload when both HTTP and direct ingest fail", async () => {
			const result = await ingestClaudeHookPayload(
				{
					hook_event_name: "Stop",
					session_id: "sess-spool",
					timestamp: "2026-04-09T00:00:00Z",
				},
				{ host: "127.0.0.1", port: 38888 },
				{
					httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
					directIngest: () => {
						throw new Error("simulated direct ingest failure");
					},
					resolveDb: () => "/tmp/never-used.sqlite",
				},
			);
			expect(result.via).toBe("spool");
			// One file landed in the spool dir.
			const queued = readdirSync(queueDir).filter((n) => n.endsWith(".json"));
			expect(queued).toHaveLength(1);
			// Plugin log captured the failure path.
			const logged = readFileSync(pluginLogPath, "utf8");
			expect(logged).toContain("spooled payload");
		});

		it("drains spooled payloads through the handler before processing the new payload", async () => {
			// Pre-seed two spool entries from earlier failed runs.
			mkdirSync(queueDir, { recursive: true });
			writeFileSync(
				join(queueDir, "hook-0000000001-pid-1.json"),
				JSON.stringify({
					hook_event_name: "Stop",
					session_id: "queued-1",
					tag: "queued-1",
				}),
				"utf8",
			);
			writeFileSync(
				join(queueDir, "hook-0000000002-pid-2.json"),
				JSON.stringify({
					hook_event_name: "Stop",
					session_id: "queued-2",
					tag: "queued-2",
				}),
				"utf8",
			);

			const httpCalls: Array<Record<string, unknown>> = [];
			const directCalls: Array<Record<string, unknown>> = [];

			const result = await ingestClaudeHookPayload(
				{
					hook_event_name: "Stop",
					session_id: "fresh",
					tag: "fresh",
				},
				{ host: "127.0.0.1", port: 38888 },
				{
					httpIngest: async (payload) => {
						httpCalls.push(payload);
						return { ok: false, inserted: 0, skipped: 0 };
					},
					directIngest: (payload) => {
						directCalls.push(payload);
						return { inserted: 1, skipped: 0 };
					},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);

			// Final outcome: fresh payload landed via direct.
			expect(result).toEqual({ inserted: 1, skipped: 0, via: "direct" });

			// Order of processing:
			// 1. Unlocked first http attempt with the fresh payload
			// 2. Drain http attempt for queued-1
			// 3. Drain direct fallback for queued-1
			// 4. Drain http attempt for queued-2
			// 5. Drain direct fallback for queued-2
			// 6. Locked second http attempt for fresh payload
			// 7. Locked direct fallback for fresh payload
			expect(httpCalls.map((p) => p.tag)).toEqual(["fresh", "queued-1", "queued-2", "fresh"]);
			expect(directCalls.map((p) => p.tag)).toEqual(["queued-1", "queued-2", "fresh"]);
			// Both queued files removed because the handler returned ok via direct.
			expect(readdirSync(queueDir)).toHaveLength(0);
		});

		it("force-flushes SessionEnd via direct ingest + boundary flush even when HTTP succeeded", async () => {
			const directCalls: Array<Record<string, unknown>> = [];
			const boundaryFlushCalls: Array<Record<string, unknown>> = [];
			const result = await ingestClaudeHookPayload(
				{ hook_event_name: "SessionEnd", session_id: "sess-end" },
				{ host: "127.0.0.1", port: 38888 },
				{
					httpIngest: async () => ({ ok: true, inserted: 0, skipped: 0 }),
					directIngest: (payload) => {
						directCalls.push(payload);
						return { inserted: 1, skipped: 0 };
					},
					boundaryFlush: (payload) => {
						boundaryFlushCalls.push(payload);
					},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);
			expect(result.via).toBe("http");
			// SessionEnd defaults to flushing → both the direct write-through
			// and the boundary flush hook fire exactly once.
			expect(directCalls).toHaveLength(1);
			expect(directCalls[0]?.hook_event_name).toBe("SessionEnd");
			expect(boundaryFlushCalls).toHaveLength(1);
			expect(boundaryFlushCalls[0]?.hook_event_name).toBe("SessionEnd");
		});

		it("Stop flush truth table: only fires when BOTH flush envs are truthy", async () => {
			const directCalls: Array<Record<string, unknown>> = [];
			const boundaryFlushCalls: Array<Record<string, unknown>> = [];
			const baseDeps = {
				httpIngest: async () => ({ ok: true, inserted: 0, skipped: 0 }),
				directIngest: (payload: Record<string, unknown>) => {
					directCalls.push(payload);
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: (payload: Record<string, unknown>) => {
					boundaryFlushCalls.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			};
			const stopPayload = { hook_event_name: "Stop", session_id: "sess-stop" };
			const ingestStop = () =>
				ingestClaudeHookPayload(stopPayload, { host: "127.0.0.1", port: 38888 }, baseDeps);

			// Cell 1: neither env set → no flush.
			await ingestStop();
			expect(directCalls).toHaveLength(0);
			expect(boundaryFlushCalls).toHaveLength(0);

			// Cell 2: CODEMEM_CLAUDE_HOOK_FLUSH alone → still no flush.
			process.env.CODEMEM_CLAUDE_HOOK_FLUSH = "1";
			await ingestStop();
			expect(directCalls).toHaveLength(0);
			expect(boundaryFlushCalls).toHaveLength(0);

			// Cell 3: CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP alone (no FLUSH) → no flush.
			delete process.env.CODEMEM_CLAUDE_HOOK_FLUSH;
			process.env.CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP = "1";
			await ingestStop();
			expect(directCalls).toHaveLength(0);
			expect(boundaryFlushCalls).toHaveLength(0);

			// Cell 4: both set → flush.
			process.env.CODEMEM_CLAUDE_HOOK_FLUSH = "1";
			process.env.CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP = "1";
			await ingestStop();
			expect(directCalls).toHaveLength(1);
			expect(boundaryFlushCalls).toHaveLength(1);
		});
	});
});
