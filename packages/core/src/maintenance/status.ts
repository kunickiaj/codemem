/* Raw-event status and retry helpers for the maintenance surface.
 *
 * Extracted verbatim from packages/core/src/maintenance.ts as part of
 * the maintenance/ split (tracked under codemem-ug38).
 */

import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema.js";
import type { RawEventStatusResult } from "./types.js";
import { withDb } from "./with-db.js";

export function getRawEventStatus(dbPath?: string, limit = 25): RawEventStatusResult {
	return withDb(dbPath, (db) => {
		const d = drizzle(db, { schema });
		const maxEvents = d
			.select({
				source: schema.rawEvents.source,
				stream_id: schema.rawEvents.stream_id,
				max_seq: sql<number>`MAX(${schema.rawEvents.event_seq})`.as("max_seq"),
			})
			.from(schema.rawEvents)
			.groupBy(schema.rawEvents.source, schema.rawEvents.stream_id)
			.as("max_events");

		const rows = d
			.select({
				source: schema.rawEventSessions.source,
				stream_id: schema.rawEventSessions.stream_id,
				opencode_session_id: schema.rawEventSessions.opencode_session_id,
				cwd: schema.rawEventSessions.cwd,
				project: schema.rawEventSessions.project,
				started_at: schema.rawEventSessions.started_at,
				last_seen_ts_wall_ms: schema.rawEventSessions.last_seen_ts_wall_ms,
				last_received_event_seq: schema.rawEventSessions.last_received_event_seq,
				last_flushed_event_seq: schema.rawEventSessions.last_flushed_event_seq,
				updated_at: schema.rawEventSessions.updated_at,
			})
			.from(schema.rawEventSessions)
			.innerJoin(
				maxEvents,
				and(
					eq(maxEvents.source, schema.rawEventSessions.source),
					eq(maxEvents.stream_id, schema.rawEventSessions.stream_id),
				),
			)
			.where(gt(maxEvents.max_seq, schema.rawEventSessions.last_flushed_event_seq))
			.orderBy(sql`${schema.rawEventSessions.updated_at} DESC`)
			.limit(limit)
			.all();

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

		const totalsRow = d
			.select({
				sessions: sql<number>`COUNT(1)`,
				pending: sql<
					number | null
				>`SUM(${maxEvents.max_seq} - ${schema.rawEventSessions.last_flushed_event_seq})`,
			})
			.from(schema.rawEventSessions)
			.innerJoin(
				maxEvents,
				and(
					eq(maxEvents.source, schema.rawEventSessions.source),
					eq(maxEvents.stream_id, schema.rawEventSessions.stream_id),
				),
			)
			.where(gt(maxEvents.max_seq, schema.rawEventSessions.last_flushed_event_seq))
			.get();

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
		const d = drizzle(db, { schema });
		const now = new Date().toISOString();
		return db.transaction(() => {
			const candidateIds = d
				.select({ id: schema.rawEventFlushBatches.id })
				.from(schema.rawEventFlushBatches)
				.where(inArray(schema.rawEventFlushBatches.status, ["failed", "error"]))
				.orderBy(schema.rawEventFlushBatches.updated_at)
				.limit(limit)
				.all()
				.map((row) => Number(row.id));

			if (candidateIds.length === 0) return { retried: 0 };

			const result = d
				.update(schema.rawEventFlushBatches)
				.set({
					status: "pending",
					updated_at: now,
					error_message: null,
					error_type: null,
					observer_provider: null,
					observer_model: null,
					observer_runtime: null,
					observer_auth_source: null,
					observer_auth_type: null,
					observer_error_code: null,
					observer_error_message: null,
				})
				.where(
					and(
						inArray(schema.rawEventFlushBatches.id, candidateIds),
						inArray(schema.rawEventFlushBatches.status, ["failed", "error"]),
					),
				)
				.run();

			return { retried: Number(result.changes ?? 0) };
		})();
	});
}
