import { statSync } from "node:fs";
import { assertSchemaReady, connect, type Database, resolveDbPath } from "./db.js";

export interface RawEventStatusItem {
	source: string;
	stream_id: string;
	opencode_session_id: string | null;
	cwd: string | null;
	project: string | null;
	started_at: string | null;
	last_seen_ts_wall_ms: number | null;
	last_received_event_seq: number;
	last_flushed_event_seq: number;
	updated_at: string;
	session_stream_id: string;
	session_id: string;
}

export interface RawEventStatusResult {
	items: RawEventStatusItem[];
	totals: { pending: number; sessions: number };
	ingest: { available: true; mode: "stream_queue"; max_body_bytes: number };
}

function withDb<T>(dbPath: string | undefined, fn: (db: Database, resolvedPath: string) => T): T {
	const resolvedPath = resolveDbPath(dbPath);
	const db = connect(resolvedPath);
	try {
		assertSchemaReady(db);
		return fn(db, resolvedPath);
	} finally {
		db.close();
	}
}

export function initDatabase(dbPath?: string): { path: string; sizeBytes: number } {
	return withDb(dbPath, (_db, resolvedPath) => {
		const stats = statSync(resolvedPath);
		return { path: resolvedPath, sizeBytes: stats.size };
	});
}

export function vacuumDatabase(dbPath?: string): { path: string; sizeBytes: number } {
	return withDb(dbPath, (db, resolvedPath) => {
		db.exec("VACUUM");
		const stats = statSync(resolvedPath);
		return { path: resolvedPath, sizeBytes: stats.size };
	});
}

export function getRawEventStatus(dbPath?: string, limit = 25): RawEventStatusResult {
	return withDb(dbPath, (db) => {
		const rows = db
			.prepare(
				`WITH max_events AS (
					SELECT source, stream_id, MAX(event_seq) AS max_seq
					FROM raw_events
					GROUP BY source, stream_id
				)
				SELECT s.source, s.stream_id, s.opencode_session_id, s.cwd, s.project,
					s.started_at, s.last_seen_ts_wall_ms,
					s.last_received_event_seq, s.last_flushed_event_seq, s.updated_at
				FROM raw_event_sessions s
				JOIN max_events e ON e.source = s.source AND e.stream_id = s.stream_id
				WHERE e.max_seq > s.last_flushed_event_seq
				ORDER BY s.updated_at DESC
				 LIMIT ?`,
			)
			.all(limit) as Array<Record<string, unknown>>;

		const items = rows.map((row) => {
			const streamId = String(row.stream_id ?? row.opencode_session_id ?? "");
			return {
				source: String(row.source ?? "opencode"),
				stream_id: streamId,
				opencode_session_id:
					row.opencode_session_id == null ? null : String(row.opencode_session_id),
				cwd: row.cwd == null ? null : String(row.cwd),
				project: row.project == null ? null : String(row.project),
				started_at: row.started_at == null ? null : String(row.started_at),
				last_seen_ts_wall_ms:
					row.last_seen_ts_wall_ms == null ? null : Number(row.last_seen_ts_wall_ms),
				last_received_event_seq: Number(row.last_received_event_seq ?? -1),
				last_flushed_event_seq: Number(row.last_flushed_event_seq ?? -1),
				updated_at: String(row.updated_at ?? ""),
				session_stream_id: streamId,
				session_id: streamId,
			};
		});

		const totalsRow = db
			.prepare(
				`WITH max_events AS (
					SELECT source, stream_id, MAX(event_seq) AS max_seq
					FROM raw_events
					GROUP BY source, stream_id
				)
				SELECT
					COUNT(1) AS sessions,
					SUM(e.max_seq - s.last_flushed_event_seq) AS pending
				FROM raw_event_sessions s
				JOIN max_events e ON e.source = s.source AND e.stream_id = s.stream_id
				WHERE e.max_seq > s.last_flushed_event_seq`,
			)
			.get() as { sessions: number | null; pending: number | null } | undefined;

		return {
			items,
			totals: {
				pending: Number(totalsRow?.pending ?? 0),
				sessions: Number(totalsRow?.sessions ?? 0),
			},
			ingest: {
				available: true,
				mode: "stream_queue",
				max_body_bytes: 2_000_000,
			},
		};
	});
}

export function retryRawEventFailures(dbPath?: string, limit = 25): { retried: number } {
	return withDb(dbPath, (db) => {
		const now = new Date().toISOString();
		const result = db
			.prepare(
				`WITH candidates AS (
					SELECT id
					FROM raw_event_flush_batches
					WHERE status IN ('failed', 'error')
					ORDER BY updated_at ASC
					LIMIT ?
				)
				UPDATE raw_event_flush_batches
				SET status = 'pending',
					updated_at = ?,
					error_message = NULL,
					error_type = NULL,
					observer_provider = NULL,
					observer_model = NULL,
					observer_runtime = NULL
				WHERE id IN (SELECT id FROM candidates)`,
			)
			.run(limit, now);
		return { retried: result.changes };
	});
}
