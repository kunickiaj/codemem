import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	codexHookIngestCommand,
	directEnqueueCodexHook,
	ingestCodexHookPayload,
} from "./codex-hook-ingest.js";
import { spoolCodexHookPayload } from "./codex-hook-ingest-spool.js";

const savedEnv: Record<string, string | undefined> = {};
let hermeticDir: string;

function setEnv(key: string, value: string | undefined): void {
	if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function createTempDbPath(): { dbPath: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "codemem-cli-codex-hook-"));
	const dbPath = join(dir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	return {
		dbPath,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("codex-hook-ingest command", () => {
	beforeEach(() => {
		// Keep lock/spool I/O hermetic so direct-fallback drains never touch
		// the developer's real ~/.codemem spool directory.
		hermeticDir = mkdtempSync(join(tmpdir(), "codemem-cli-codex-hermetic-"));
		setEnv("CODEMEM_CODEX_HOOK_LOCK_DIR", join(hermeticDir, "lock"));
		setEnv("CODEMEM_CODEX_HOOK_SPOOL_DIR", join(hermeticDir, "spool"));
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
			delete savedEnv[key];
		}
		rmSync(hermeticDir, { recursive: true, force: true });
	});

	it("registers expected options and help text", () => {
		const longs = codexHookIngestCommand.options.map((option) => option.long);
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--host");
		expect(longs).toContain("--port");

		const help = codexHookIngestCommand.helpInformation();
		expect(help).toContain("HTTP first");
		expect(help).toContain("direct DB fallback");
	});

	it("returns HTTP result when viewer ingest succeeds", async () => {
		const result = await ingestCodexHookPayload(
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
		const result = await ingestCodexHookPayload(
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

	it("spools payloads when HTTP and direct ingest fail", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-cli-codex-spool-"));
		try {
			setEnv("CODEMEM_CODEX_HOOK_LOCK_DIR", join(dir, "lock"));
			setEnv("CODEMEM_CODEX_HOOK_SPOOL_DIR", join(dir, "spool"));
			const result = await ingestCodexHookPayload(
				{ hook_event_name: "SessionStart", session_id: "sess-spool", cwd: "/tmp/demo" },
				{ host: "127.0.0.1", port: 38888, db: join(dir, "fallback.sqlite") },
				{
					httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
					directIngest: () => {
						throw new Error("database locked");
					},
				},
			);

			expect(result).toEqual({ inserted: 0, skipped: 0, via: "spool" });
			const queued = readdirSync(join(dir, "spool")).filter((name) => name.endsWith(".json"));
			expect(queued).toHaveLength(1);
			const spooled = JSON.parse(readFileSync(join(dir, "spool", queued[0] ?? ""), "utf8")) as {
				timestamp?: unknown;
			};
			expect(typeof spooled.timestamp).toBe("string");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not collide repeated timestamp-less payloads", async () => {
		const { dbPath, cleanup } = createTempDbPath();
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-05-29T01:00:00Z"));
			const first = await ingestCodexHookPayload(
				{ hook_event_name: "UserPromptSubmit", session_id: "sess-repeat", prompt: "continue" },
				{ host: "127.0.0.1", port: 38888, db: dbPath },
				{ httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }) },
			);
			const second = await ingestCodexHookPayload(
				{ hook_event_name: "UserPromptSubmit", session_id: "sess-repeat", prompt: "continue" },
				{ host: "127.0.0.1", port: 38888, db: dbPath },
				{ httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }) },
			);

			expect(first).toEqual({ inserted: 1, skipped: 0, via: "direct" });
			expect(second).toEqual({ inserted: 1, skipped: 0, via: "direct" });
			const db = connect(dbPath);
			try {
				const count = db.prepare("SELECT COUNT(*) AS count FROM raw_events").get() as {
					count: number;
				};
				expect(count.count).toBe(2);
			} finally {
				db.close();
			}
		} finally {
			vi.useRealTimers();
			cleanup();
		}
	});

	it("drains queued spool entries after HTTP recovers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-cli-codex-drain-"));
		try {
			setEnv("CODEMEM_CODEX_HOOK_LOCK_DIR", join(dir, "lock"));
			setEnv("CODEMEM_CODEX_HOOK_SPOOL_DIR", join(dir, "spool"));
			expect(spoolCodexHookPayload({ hook_event_name: "SessionStart", session_id: "queued" })).toBe(
				true,
			);
			const seen: string[] = [];
			const result = await ingestCodexHookPayload(
				{ hook_event_name: "SessionStart", session_id: "current" },
				{ host: "127.0.0.1", port: 38888, db: join(dir, "fallback.sqlite") },
				{
					httpIngest: async (payload) => {
						seen.push(String(payload.session_id));
						return { ok: true, inserted: 1, skipped: 0 };
					},
					directIngest: () => {
						throw new Error("direct ingest should not be called");
					},
				},
			);

			expect(result).toEqual({ inserted: 1, skipped: 0, via: "http" });
			expect(seen).toEqual(["current", "queued"]);
			expect(readdirSync(join(dir, "spool"))).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("drains queued spool entries via direct fallback when the viewer stays down", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-cli-codex-direct-drain-"));
		const dbPath = join(dir, "fallback.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		try {
			setEnv("CODEMEM_CODEX_HOOK_LOCK_DIR", join(dir, "lock"));
			setEnv("CODEMEM_CODEX_HOOK_SPOOL_DIR", join(dir, "spool"));
			expect(
				spoolCodexHookPayload({
					hook_event_name: "SessionStart",
					session_id: "queued-stream",
					timestamp: "2026-05-29T01:00:00Z",
				}),
			).toBe(true);

			const result = await ingestCodexHookPayload(
				{ hook_event_name: "UserPromptSubmit", session_id: "current-stream", prompt: "hello" },
				{ host: "127.0.0.1", port: 38888, db: dbPath },
				{ httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }) },
			);

			expect(result).toEqual({ inserted: 1, skipped: 0, via: "direct" });
			expect(readdirSync(join(dir, "spool")).filter((name) => name.endsWith(".json"))).toHaveLength(
				0,
			);
			const verify = connect(dbPath);
			try {
				const count = verify.prepare("SELECT COUNT(*) AS count FROM raw_events").get() as {
					count: number;
				};
				expect(count.count).toBe(2);
			} finally {
				verify.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("direct enqueue starts a new stream sequence at zero to match the store path", () => {
		const { dbPath, cleanup } = createTempDbPath();
		try {
			directEnqueueCodexHook(
				{
					hook_event_name: "SessionStart",
					session_id: "sess-seq",
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

	it("direct enqueue inserts once and deduplicates event_id", () => {
		const { dbPath, cleanup } = createTempDbPath();
		try {
			const payload = {
				hook_event_name: "SessionStart",
				session_id: "sess-dedup",
				timestamp: "2026-05-29T01:00:00Z",
				cwd: "/tmp/demo",
			};

			const first = directEnqueueCodexHook(payload, dbPath);
			const second = directEnqueueCodexHook(payload, dbPath);

			expect(first).toEqual({ inserted: 1, skipped: 0 });
			expect(second).toEqual({ inserted: 0, skipped: 0 });

			const db = connect(dbPath);
			try {
				const raw = db.prepare("SELECT source, event_type, payload_json FROM raw_events").get() as {
					source: string;
					event_type: string;
					payload_json: string;
				};
				expect(raw.source).toBe("codex");
				expect(raw.event_type).toBe("codex.hook");
				expect(JSON.parse(raw.payload_json)._adapter.source).toBe("codex");
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
			const result = directEnqueueCodexHook(
				{ hook_event_name: "PermissionRequest", session_id: "sess-x" },
				dbPath,
			);
			expect(result).toEqual({ inserted: 0, skipped: 1 });
		} finally {
			cleanup();
		}
	});

	it("direct enqueue bootstraps fresh databases on demand", () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-cli-codex-direct-bootstrap-"));
		const dbPath = join(dir, "fresh.sqlite");
		try {
			const result = directEnqueueCodexHook(
				{
					hook_event_name: "SessionStart",
					session_id: "sess-fresh-bootstrap",
					timestamp: "2026-05-29T01:00:00Z",
					cwd: "/tmp/demo",
				},
				dbPath,
			);
			expect(result).toEqual({ inserted: 1, skipped: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
