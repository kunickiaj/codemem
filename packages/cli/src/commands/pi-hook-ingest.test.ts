import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directEnqueuePiHook, ingestPiHookPayload, piHookIngestCommand } from "./pi-hook-ingest.js";

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
	let savedSpoolDir: string | undefined;
	let savedLockDir: string | undefined;
	beforeEach(() => {
		sandboxDir = mkdtempSync(join(tmpdir(), "codemem-cli-pi-command-"));
		savedSpoolDir = process.env.CODEMEM_PI_HOOK_SPOOL_DIR;
		savedLockDir = process.env.CODEMEM_PI_HOOK_LOCK_DIR;
		process.env.CODEMEM_PI_HOOK_SPOOL_DIR = join(sandboxDir, "spool");
		process.env.CODEMEM_PI_HOOK_LOCK_DIR = join(sandboxDir, "lock");
	});
	afterEach(() => {
		if (savedSpoolDir === undefined) delete process.env.CODEMEM_PI_HOOK_SPOOL_DIR;
		else process.env.CODEMEM_PI_HOOK_SPOOL_DIR = savedSpoolDir;
		if (savedLockDir === undefined) delete process.env.CODEMEM_PI_HOOK_LOCK_DIR;
		else process.env.CODEMEM_PI_HOOK_LOCK_DIR = savedLockDir;
		rmSync(sandboxDir, { recursive: true, force: true });
	});

	it("registers expected options and help text", () => {
		const longs = piHookIngestCommand.options.map((option) => option.long);
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--host");
		expect(longs).toContain("--port");

		const help = piHookIngestCommand.helpInformation();
		expect(help).toContain("durable HTTP queue");
		expect(help).toContain("local spool fallback");
	});

	it("returns HTTP result when viewer ingest succeeds", async () => {
		const httpPayloads: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-http", cwd: "/tmp/demo" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async (payload) => {
					httpPayloads.push(payload);
					return { ok: true, inserted: 2, skipped: 1 };
				},
				directIngest: () => {
					throw new Error("direct ingest should not be called");
				},
				resolveDb: () => "/tmp/resolved.sqlite",
			},
		);

		expect(result).toEqual({ inserted: 2, skipped: 1, via: "http" });
		// P1 fix: HTTP payloads carry the requested db_path + identity_target.
		expect(httpPayloads).toHaveLength(1);
		expect(httpPayloads[0]?.db_path).toBe("/tmp/resolved.sqlite");
		expect(httpPayloads[0]?.identity_target).toEqual(expect.any(Object));
	});

	it("spools without direct ingest when HTTP transport fails", async () => {
		let directCalls = 0;
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-direct", cwd: "/tmp/demo" },
			{ host: "127.0.0.1", port: 38888, db: "/tmp/custom.sqlite" },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => {
					directCalls += 1;
					return { inserted: 1, skipped: 0 };
				},
				resolveDb: () => "/tmp/resolved.sqlite",
			},
		);

		expect(result).toEqual({ inserted: 0, skipped: 0, via: "spool" });
		expect(directCalls).toBe(0);
	});

	it("spools a viewer target conflict without retry or direct ingest", async () => {
		let httpCalls = 0;
		let directCalls = 0;
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-mismatch", cwd: "/tmp/demo" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => {
					httpCalls++;
					return { ok: false, inserted: 0, skipped: 0, targetMismatch: true };
				},
				directIngest: () => {
					directCalls += 1;
					return { inserted: 1, skipped: 0 };
				},
				resolveDb: () => "/tmp/resolved.sqlite",
			},
		);

		expect(result).toEqual({ inserted: 0, skipped: 0, via: "spool" });
		expect(httpCalls).toBe(1);
		expect(directCalls).toBe(0);
	});
});

describe("pi-hook-ingest direct enqueue identity", () => {
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
			expect(second).toEqual({ inserted: 0, skipped: 1 });

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
});

describe("pi-hook-ingest direct enqueue schema", () => {
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
});
