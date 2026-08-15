import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directEnqueuePiHook, ingestPiHookPayload, piHookIngestCommand } from "./pi-hook-ingest.js";
import { spoolPiHookPayload } from "./pi-hook-ingest-spool.js";

function createTempDbPath(): { dbPath: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "codemem-cli-pi-hook-"));
	const dbPath = join(dir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	return {
		dbPath,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("pi-hook-ingest command", () => {
	let sandboxDir: string;
	let lockDir: string;
	let queueDir: string;
	let pluginLogPath: string;
	const savedEnv: Record<string, string | undefined> = {};

	const sandboxedEnvKeys = [
		"CODEMEM_PI_HOOK_LOCK_DIR",
		"CODEMEM_PI_HOOK_SPOOL_DIR",
		"CODEMEM_PLUGIN_LOG_PATH",
		"CODEMEM_PLUGIN_LOG",
		"CODEMEM_PI_HOOK_LOCK_TTL_S",
		"CODEMEM_PI_HOOK_LOCK_GRACE_S",
	];

	beforeEach(() => {
		sandboxDir = mkdtempSync(join(tmpdir(), "codemem-cli-pi-ingest-test-"));
		lockDir = join(sandboxDir, "lock");
		queueDir = join(sandboxDir, "spool");
		pluginLogPath = join(sandboxDir, "plugin.log");
		for (const key of sandboxedEnvKeys) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.CODEMEM_PI_HOOK_LOCK_DIR = lockDir;
		process.env.CODEMEM_PI_HOOK_SPOOL_DIR = queueDir;
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
		const longs = piHookIngestCommand.options.map((option) => option.long);
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--host");
		expect(longs).toContain("--port");

		const help = piHookIngestCommand.helpInformation();
		expect(help).toContain("HTTP first");
		expect(help).toContain("direct DB fallback");
	});

	it("returns HTTP result when viewer ingest succeeds", async () => {
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-http", cwd: "/tmp/demo" },
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
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-direct", cwd: "/tmp/demo" },
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
				piEvent: "session_start",
				sessionId: "sess-dedup",
				timestamp: "2026-01-01T00:00:00Z",
				cwd: "/tmp/demo",
			};

			const first = directEnqueuePiHook(payload, dbPath);
			const second = directEnqueuePiHook(payload, dbPath);

			expect(first).toEqual({ inserted: 1, skipped: 0 });
			expect(second).toEqual({ inserted: 0, skipped: 0 });

			const db = connect(dbPath);
			try {
				const raw = db.prepare("SELECT source, event_type, payload_json FROM raw_events").get() as {
					source: string;
					event_type: string;
					payload_json: string;
				};
				expect(raw.source).toBe("pi");
				expect(raw.event_type).toBe("pi.hook");
				expect(JSON.parse(raw.payload_json)._adapter.source).toBe("pi");

				const session = db
					.prepare("SELECT source FROM raw_event_sessions WHERE stream_id = ?")
					.get("sess-dedup") as { source: string };
				expect(session.source).toBe("pi");

				const opencodeCount = db
					.prepare("SELECT COUNT(*) AS c FROM raw_events WHERE source = 'opencode'")
					.get() as { c: number };
				expect(opencodeCount.c).toBe(0);
			} finally {
				db.close();
			}
		} finally {
			cleanup();
		}
	});

	it("direct enqueue skips unsupported and flush-only payloads gracefully", () => {
		const { dbPath, cleanup } = createTempDbPath();
		try {
			const unsupported = directEnqueuePiHook(
				{ piEvent: "before_agent_start", sessionId: "sess-x" },
				dbPath,
			);
			expect(unsupported).toEqual({ inserted: 0, skipped: 1 });

			const flushOnly = directEnqueuePiHook(
				{ piEvent: "session_before_compact", sessionId: "sess-x" },
				dbPath,
			);
			expect(flushOnly).toEqual({ inserted: 0, skipped: 1 });
		} finally {
			cleanup();
		}
	});

	it("direct enqueue starts a new stream sequence at zero to match the store path", () => {
		const { dbPath, cleanup } = createTempDbPath();
		try {
			directEnqueuePiHook(
				{
					piEvent: "session_start",
					sessionId: "sess-seq",
					timestamp: "2026-05-29T01:00:00Z",
					cwd: "/tmp/demo",
				},
				dbPath,
			);
			const db = connect(dbPath);
			try {
				const row = db
					.prepare("SELECT event_seq FROM raw_events WHERE stream_id = ?")
					.get("sess-seq") as { event_seq: number };
				expect(row.event_seq).toBe(0);
				const session = db
					.prepare(
						"SELECT last_received_event_seq, last_flushed_event_seq FROM raw_event_sessions WHERE stream_id = ?",
					)
					.get("sess-seq") as {
					last_received_event_seq: number;
					last_flushed_event_seq: number;
				};
				expect(session.last_received_event_seq).toBe(0);
				expect(session.last_flushed_event_seq).toBe(-1);
			} finally {
				db.close();
			}
		} finally {
			cleanup();
		}
	});

	it("direct enqueue bootstraps fresh databases on demand", () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-cli-pi-direct-bootstrap-"));
		const dbPath = join(dir, "fresh.sqlite");
		try {
			const result = directEnqueuePiHook(
				{
					piEvent: "session_start",
					sessionId: "sess-fresh-bootstrap",
					timestamp: "2026-01-01T00:00:00Z",
					cwd: "/tmp/demo",
				},
				dbPath,
			);
			expect(result).toEqual({ inserted: 1, skipped: 0 });

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
			mkdirSync(queueDir, { recursive: true });
			writeFileSync(
				join(queueDir, "hook-0000000001-pid-1.json"),
				JSON.stringify({
					piEvent: "session_start",
					sessionId: "previously-spooled",
					tag: "queued",
				}),
				"utf8",
			);

			const httpCalls: Array<Record<string, unknown>> = [];
			const result = await ingestPiHookPayload(
				{ piEvent: "session_start", sessionId: "fresh", tag: "fresh" },
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

			expect(result).toEqual({ inserted: 1, skipped: 0, via: "http" });
			expect(httpCalls.map((p) => p.tag)).toEqual(["fresh", "queued"]);
			expect(readdirSync(queueDir)).toHaveLength(0);
		});

		it("skips backlog drain on HTTP success when spool is empty (no extra HTTP calls)", async () => {
			let httpCallCount = 0;
			const result = await ingestPiHookPayload(
				{ piEvent: "session_start", sessionId: "no-backlog" },
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
			expect(httpCallCount).toBe(1);
		});

		it("treats HTTP skipped as a successful no-op without direct fallback", async () => {
			let directCalls = 0;
			const result = await ingestPiHookPayload(
				{ piEvent: "session_before_compact", sessionId: "sess-compact" },
				{ host: "127.0.0.1", port: 38888 },
				{
					httpIngest: async () => ({ ok: true, inserted: 0, skipped: 1 }),
					directIngest: () => {
						directCalls++;
						return { inserted: 0, skipped: 1 };
					},
					// boundary flush still runs for compact — that is intentional
					boundaryFlush: () => {},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);
			expect(result).toEqual({ inserted: 0, skipped: 1, via: "http" });
			// Boundary path writes through direct once; the non-boundary retry does not.
			expect(directCalls).toBe(1);
		});

		it("spools the payload when both HTTP and direct ingest fail", async () => {
			const result = await ingestPiHookPayload(
				{
					piEvent: "session_start",
					sessionId: "sess-spool",
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
			const queued = readdirSync(queueDir).filter((n) => n.endsWith(".json"));
			expect(queued).toHaveLength(1);
			const logged = readFileSync(pluginLogPath, "utf8");
			expect(logged).toContain("spooled payload");
		});

		it("drains spooled payloads through the handler before processing the new payload", async () => {
			mkdirSync(queueDir, { recursive: true });
			writeFileSync(
				join(queueDir, "hook-0000000001-pid-1.json"),
				JSON.stringify({
					piEvent: "session_start",
					sessionId: "queued-1",
					tag: "queued-1",
				}),
				"utf8",
			);
			writeFileSync(
				join(queueDir, "hook-0000000002-pid-2.json"),
				JSON.stringify({
					piEvent: "session_start",
					sessionId: "queued-2",
					tag: "queued-2",
				}),
				"utf8",
			);

			const httpCalls: Array<Record<string, unknown>> = [];
			const directCalls: Array<Record<string, unknown>> = [];

			const result = await ingestPiHookPayload(
				{
					piEvent: "session_start",
					sessionId: "fresh",
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

			expect(result).toEqual({ inserted: 1, skipped: 0, via: "direct" });
			expect(httpCalls.map((p) => p.tag)).toEqual(["fresh", "queued-1", "queued-2", "fresh"]);
			expect(directCalls.map((p) => p.tag)).toEqual(["queued-1", "queued-2", "fresh"]);
			expect(readdirSync(queueDir)).toHaveLength(0);
		});

		it("force-flushes session_shutdown via direct ingest + boundary flush even when HTTP succeeded", async () => {
			const directCalls: Array<Record<string, unknown>> = [];
			const boundaryFlushCalls: Array<Record<string, unknown>> = [];
			const result = await ingestPiHookPayload(
				{ piEvent: "session_shutdown", sessionId: "sess-end" },
				{ host: "127.0.0.1", port: 38888 },
				{
					httpIngest: async () => ({ ok: true, inserted: 1, skipped: 0 }),
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
			expect(directCalls).toHaveLength(1);
			expect(directCalls[0]?.piEvent).toBe("session_shutdown");
			expect(boundaryFlushCalls).toHaveLength(1);
			expect(boundaryFlushCalls[0]?.piEvent).toBe("session_shutdown");
		});

		it("force-flushes session_before_compact as observe-only boundary", async () => {
			const directCalls: Array<Record<string, unknown>> = [];
			const boundaryFlushCalls: Array<Record<string, unknown>> = [];
			const result = await ingestPiHookPayload(
				{ piEvent: "session_before_compact", sessionId: "sess-compact" },
				{ host: "127.0.0.1", port: 38888 },
				{
					httpIngest: async () => ({ ok: true, inserted: 0, skipped: 1 }),
					directIngest: (payload) => {
						directCalls.push(payload);
						return { inserted: 0, skipped: 1 };
					},
					boundaryFlush: (payload) => {
						boundaryFlushCalls.push(payload);
					},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);
			expect(result.via).toBe("http");
			expect(directCalls).toHaveLength(1);
			expect(boundaryFlushCalls).toHaveLength(1);
			expect(boundaryFlushCalls[0]?.piEvent).toBe("session_before_compact");
		});

		it("force-flushes boundary payload on lock-busy unlocked direct path", async () => {
			// Hold the lock with this process's live PID + fresh ts so
			// withPiHookIngestLock gives up with PiHookLockBusyError.
			mkdirSync(lockDir);
			writeFileSync(join(lockDir, "pid"), String(process.pid), "utf8");
			writeFileSync(join(lockDir, "ts"), String(Math.floor(Date.now() / 1000)), "utf8");
			writeFileSync(join(lockDir, "owner"), "external-owner", "utf8");

			const boundaryFlushCalls: Array<Record<string, unknown>> = [];
			const result = await ingestPiHookPayload(
				{ piEvent: "session_before_compact", sessionId: "sess-compact-busy" },
				{ host: "127.0.0.1", port: 38888 },
				{
					httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
					directIngest: () => ({ inserted: 0, skipped: 1 }),
					boundaryFlush: (payload) => {
						boundaryFlushCalls.push(payload);
					},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);

			expect(result.via).toBe("direct");
			// Compaction guarantee: lock contention must not skip the
			// boundary flush that would have run on the locked path.
			expect(boundaryFlushCalls).toHaveLength(1);
			expect(boundaryFlushCalls[0]?.piEvent).toBe("session_before_compact");
		});

		it("force-flushes boundary payload on locked spool path when direct fails", async () => {
			// DB write throws, spool succeeds under the lock — same class of
			// boundary-flush loss the lock-busy spool path already guards.
			const boundaryFlushCalls: Array<Record<string, unknown>> = [];
			const result = await ingestPiHookPayload(
				{ piEvent: "session_before_compact", sessionId: "sess-compact-spool" },
				{ host: "127.0.0.1", port: 38888 },
				{
					httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
					directIngest: () => {
						throw new Error("simulated db write failure");
					},
					boundaryFlush: (payload) => {
						boundaryFlushCalls.push(payload);
					},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);

			expect(result.via).toBe("spool");
			expect(boundaryFlushCalls).toHaveLength(1);
			expect(boundaryFlushCalls[0]?.piEvent).toBe("session_before_compact");
		});

		it("does not boundary-flush ordinary transcript events", async () => {
			const boundaryFlushCalls: Array<Record<string, unknown>> = [];
			await ingestPiHookPayload(
				{
					piEvent: "message_end",
					sessionId: "sess-msg",
					role: "user",
					text: "hello",
					entryId: "e1",
				},
				{ host: "127.0.0.1", port: 38888 },
				{
					httpIngest: async () => ({ ok: true, inserted: 1, skipped: 0 }),
					directIngest: () => {
						throw new Error("direct should not run");
					},
					boundaryFlush: (payload) => {
						boundaryFlushCalls.push(payload);
					},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);
			expect(boundaryFlushCalls).toHaveLength(0);
		});

		it("drains queued spool entries via direct fallback when the viewer stays down", async () => {
			const dbPath = join(sandboxDir, "fallback.sqlite");
			const db = connect(dbPath);
			initTestSchema(db);
			db.close();

			expect(
				spoolPiHookPayload({
					piEvent: "session_start",
					sessionId: "queued-stream",
					timestamp: "2026-05-29T01:00:00Z",
				}),
			).toBe(true);

			const result = await ingestPiHookPayload(
				{
					piEvent: "message_end",
					sessionId: "current-stream",
					role: "user",
					text: "hello",
					entryId: "e-current",
					timestamp: "2026-05-29T01:01:00Z",
				},
				{ host: "127.0.0.1", port: 38888, db: dbPath },
				{ httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }) },
			);

			expect(result).toEqual({ inserted: 1, skipped: 0, via: "direct" });
			expect(readdirSync(queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(0);
			const verify = connect(dbPath);
			try {
				const count = verify.prepare("SELECT COUNT(*) AS count FROM raw_events").get() as {
					count: number;
				};
				expect(count.count).toBe(2);
				const sources = verify
					.prepare("SELECT DISTINCT source AS source FROM raw_events")
					.all() as Array<{ source: string }>;
				expect(sources.map((r) => r.source)).toEqual(["pi"]);
			} finally {
				verify.close();
			}
		});
	});
});
