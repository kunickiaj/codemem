import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { tableExists } from "./db.js";
import { collectOperationalStatus } from "./operational-status.js";
import { initTestSchema } from "./test-utils.js";

describe("collectOperationalStatus", () => {
	it("collects fixed aggregate operational evidence without exposing rows", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			if (tableExists(db, "memory_vectors")) db.exec("DROP TABLE memory_vectors");
			db.prepare(
				`INSERT INTO sync_daemon_state(id, last_error_at, last_ok_at, phase)
				 VALUES (1, '2026-08-11T12:00:00Z', '2026-08-11T11:00:00Z', 'needs_attention')`,
			).run();
			db.prepare(
				`INSERT INTO sync_peers(peer_device_id, created_at, last_error)
				 VALUES ('peer-1', '2026-08-11T10:00:00Z', 'private peer failure')`,
			).run();
			db.prepare(
				`INSERT INTO maintenance_jobs(kind, title, status, updated_at, error)
				 VALUES ('vector_model_migration', 'Vectors', 'failed', '2026-08-11T10:00:00Z', 'private vector failure')`,
			).run();
			db.prepare(
				`INSERT INTO raw_event_sessions(
					source, stream_id, opencode_session_id, last_received_event_seq,
					last_flushed_event_seq, updated_at
				 ) VALUES ('opencode', 'session-1', 'session-1', 3, 1, '2026-08-11T10:00:00Z')`,
			).run();
			for (const eventSeq of [2, 3]) {
				db.prepare(
					`INSERT INTO raw_events(source, stream_id, opencode_session_id, event_seq, event_type, payload_json, created_at)
					 VALUES ('opencode', 'session-1', 'session-1', ?, 'message', '{}', '2026-08-11T10:00:00Z')`,
				).run(eventSeq);
			}
			db.prepare(
				`INSERT INTO raw_event_flush_batches(
					id, source, stream_id, opencode_session_id, start_event_seq, end_event_seq,
					extractor_version, status, observer_error_code, created_at, updated_at
				 ) VALUES (1, 'opencode', 'session-1', 'session-1', 1, 3, 'v1', 'gave_up',
					'auth_failure', '2026-08-11T10:00:00Z', '2026-08-11T10:00:00Z')`,
			).run();
			db.prepare(
				`INSERT INTO raw_event_flush_batches(
					id, source, stream_id, opencode_session_id, start_event_seq, end_event_seq,
					extractor_version, status, observer_error_code, created_at, updated_at
				 ) VALUES (2, 'opencode', 'session-1', 'session-1', 4, 4, 'v1', 'failed',
					'rate_limited', '2026-08-11T10:00:00Z', '2026-08-11T10:00:00Z')`,
			).run();

			const result = collectOperationalStatus(db);

			expect(result).toEqual({
				sync: { available: true, daemon_error: true, needs_attention: true, peer_errors: 1 },
				maintenance: { state: "idle", running: 0, failed: 0 },
				semantic_index: { state: "failed", vector_table_present: false },
				raw_events: { available: true, pending: 2, failed_batches: 1 },
				observer: { available: true, failed_batches: 1, backoff_batches: 1 },
			});
			expect(JSON.stringify(result)).not.toContain("private");
			const afterRecentWindow = collectOperationalStatus(db, {
				recentFailureCutoff: "2026-08-12T10:00:00Z",
			});
			expect(afterRecentWindow.raw_events.failed_batches).toBe(0);
			expect(afterRecentWindow.observer).toEqual({
				available: true,
				failed_batches: 0,
				backoff_batches: 1,
			});
		} finally {
			db.close();
		}
	});

	it("reports daemon errors when the additive phase column is absent", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			db.exec("DROP TABLE sync_daemon_state");
			db.exec(
				`CREATE TABLE sync_daemon_state (
					id INTEGER PRIMARY KEY,
					last_error TEXT,
					last_traceback TEXT,
					last_error_at TEXT,
					last_ok_at TEXT
				)`,
			);
			db.prepare(
				`INSERT INTO sync_daemon_state(id, last_error_at, last_ok_at)
				 VALUES (1, '2026-08-11T12:00:00Z', '2026-08-11T11:00:00Z')`,
			).run();

			const result = collectOperationalStatus(db, { embeddingDisabled: true });
			expect(result.sync.daemon_error).toBe(true);
			expect(result.sync.needs_attention).toBe(false);
		} finally {
			db.close();
		}
	});

	it("tolerates optional tables being absent", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			if (tableExists(db, "memory_vectors")) db.exec("DROP TABLE memory_vectors");
			for (const table of [
				"maintenance_jobs",
				"sync_daemon_state",
				"sync_peers",
				"sync_attempts",
				"raw_event_flush_batches",
			]) {
				db.exec(`DROP TABLE ${table}`);
			}

			expect(collectOperationalStatus(db, { embeddingDisabled: true })).toEqual({
				sync: { available: false, daemon_error: false, needs_attention: false, peer_errors: 0 },
				maintenance: { state: "unknown", running: 0, failed: 0 },
				semantic_index: { state: "degraded", vector_table_present: false },
				raw_events: { available: false, pending: 0, failed_batches: 0 },
				observer: { available: false, failed_batches: 0, backoff_batches: 0 },
			});
		} finally {
			db.close();
		}
	});
});
