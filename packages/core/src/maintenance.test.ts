import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	backfillTagsText,
	getRawEventStatus,
	getReliabilityMetrics,
	initDatabase,
	retryRawEventFailures,
	vacuumDatabase,
} from "./maintenance.js";
import { initTestSchema } from "./test-utils.js";

function createDbPath(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-maintenance-"));
	return join(dir, `${name}.sqlite`);
}

function seedMaintenanceDb(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		initTestSchema(db);
		db.exec(`
			INSERT INTO sessions(id, started_at, cwd, project, user, tool_version) VALUES
			  (1, '2026-03-01T10:00:00Z', '/tmp/repo', 'codemem', 'adam', 'test');
			INSERT INTO raw_event_sessions(
				source, stream_id, opencode_session_id, cwd, project, started_at,
				last_seen_ts_wall_ms, last_received_event_seq, last_flushed_event_seq, updated_at
			) VALUES (
				'opencode', 'sess-1', 'sess-1', '/tmp/repo', 'codemem', '2026-03-01T10:00:00Z',
				1000, 4, 1, '2026-03-01T10:10:00Z'
			);
			INSERT INTO raw_events(source, stream_id, opencode_session_id, event_id, event_seq, event_type, ts_wall_ms, payload_json, created_at) VALUES
			  ('opencode', 'sess-1', 'sess-1', 'e1', 1, 'tool.execute.after', 1000, '{}', '2026-03-01T10:00:01Z'),
			  ('opencode', 'sess-1', 'sess-1', 'e2', 2, 'tool.execute.after', 1001, '{}', '2026-03-01T10:00:02Z'),
			  ('opencode', 'sess-1', 'sess-1', 'e3', 3, 'tool.execute.after', 1002, '{}', '2026-03-01T10:00:03Z'),
			  ('opencode', 'sess-1', 'sess-1', 'e4', 4, 'tool.execute.after', 1003, '{}', '2026-03-01T10:00:04Z');
			INSERT INTO raw_event_flush_batches(
				source, stream_id, opencode_session_id, start_event_seq, end_event_seq,
				extractor_version, status, error_message, updated_at, created_at
			) VALUES (
				'opencode', 'sess-1', 'sess-1', 2, 4,
				'raw_events_v1', 'failed', 'boom', '2026-03-01T10:10:00Z', '2026-03-01T10:05:00Z'
			);
		`);
	} finally {
		db.close();
	}
}

describe("maintenance", () => {
	it("returns raw event backlog status", () => {
		const dbPath = createDbPath("status");
		seedMaintenanceDb(dbPath);

		const result = getRawEventStatus(dbPath, 10);

		expect(result.totals).toEqual({ pending: 3, sessions: 1 });
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.session_stream_id).toBe("sess-1");
		expect(result.items[0]?.project).toBe("codemem");
	});

	it("requeues failed raw event batches", () => {
		const dbPath = createDbPath("retry");
		seedMaintenanceDb(dbPath);

		const result = retryRawEventFailures(dbPath, 10);
		expect(result.retried).toBe(1);

		const db = new Database(dbPath, { readonly: true });
		try {
			const row = db
				.prepare("SELECT status, error_message FROM raw_event_flush_batches LIMIT 1")
				.get() as {
				status: string;
				error_message: string | null;
			};
			expect(row).toEqual({ status: "pending", error_message: null });
		} finally {
			db.close();
		}
	});

	it("initializes and vacuums a schema-ready database", () => {
		const dbPath = createDbPath("init-vacuum");
		seedMaintenanceDb(dbPath);

		const init = initDatabase(dbPath);
		expect(init.path).toBe(dbPath);
		expect(init.sizeBytes).toBeGreaterThan(0);

		const vacuum = vacuumDatabase(dbPath);
		expect(vacuum.path).toBe(dbPath);
		expect(vacuum.sizeBytes).toBeGreaterThan(0);
	});

	it("reports max retry depth from raw_event_flush_batches.attempt_count", () => {
		const dbPath = createDbPath("retry-depth");
		seedMaintenanceDb(dbPath);

		const db = new Database(dbPath);
		try {
			db.prepare("UPDATE raw_event_flush_batches SET attempt_count = ? WHERE id = 1").run(4);
			db.prepare(
				`INSERT INTO raw_event_flush_batches(
					source, stream_id, opencode_session_id, start_event_seq, end_event_seq,
					extractor_version, status, updated_at, created_at, attempt_count
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"opencode",
				"sess-2",
				"sess-2",
				1,
				1,
				"raw_events_v1",
				"completed",
				"2026-03-01T11:00:00Z",
				"2026-03-01T10:59:00Z",
				2,
			);
		} finally {
			db.close();
		}

		const metrics = getReliabilityMetrics(dbPath);
		expect(metrics.counts.retry_depth_max).toBe(3);
	});

	it("backfills tags_text for memories with empty tags", () => {
		const dbPath = createDbPath("backfill-tags");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, cwd, project, user, tool_version) VALUES
				  (1, '2026-03-01T10:00:00Z', '/tmp/repo', 'codemem', 'adam', 'test');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, tags_text, active,
					created_at, updated_at, concepts, files_modified, import_key
				) VALUES
					(1, 1, 'feature', 'Auth login flow', 'body', '', 1,
					 '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', '["authentication"]', '["src/auth/login.ts"]', 'k1');
			`);
		} finally {
			db.close();
		}

		const dbRw = new Database(dbPath);
		try {
			const result = backfillTagsText(dbRw, {});
			expect(result).toEqual({ checked: 1, updated: 1, skipped: 0 });

			const row = dbRw.prepare("SELECT tags_text FROM memory_items WHERE id = 1").get() as {
				tags_text: string;
			};
			expect(row.tags_text).toContain("feature");
			expect(row.tags_text).toContain("authentication");
			expect(row.tags_text).toContain("login-ts");
		} finally {
			dbRw.close();
		}
	});

	it("supports backfill-tags dry-run mode", () => {
		const dbPath = createDbPath("backfill-tags-dry-run");
		const db = new Database(dbPath);
		try {
			initTestSchema(db);
			db.exec(`
				INSERT INTO sessions(id, started_at, cwd, project, user, tool_version) VALUES
				  (1, '2026-03-01T10:00:00Z', '/tmp/repo', 'codemem', 'adam', 'test');
				INSERT INTO memory_items(
					id, session_id, kind, title, body_text, tags_text, active,
					created_at, updated_at, import_key
				) VALUES
					(1, 1, 'feature', 'Needs tags', 'body', '', 1,
					 '2026-03-01T10:00:00Z', '2026-03-01T10:00:00Z', 'k1');
			`);

			const result = backfillTagsText(db, { dryRun: true });
			expect(result).toEqual({ checked: 1, updated: 1, skipped: 0 });

			const row = db.prepare("SELECT tags_text FROM memory_items WHERE id = 1").get() as {
				tags_text: string;
			};
			expect(row.tags_text).toBe("");
		} finally {
			db.close();
		}
	});
});
