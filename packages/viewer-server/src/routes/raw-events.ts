/**
 * Raw events routes — GET /api/raw-events, GET /api/raw-events/status.
 *
 * Ports Python's viewer_routes/raw_events.py (GET handlers only).
 * POST handlers for raw event ingestion are not yet ported.
 */

import type { MemoryStore } from "@codemem/core";
import { Hono } from "hono";
import { queryInt } from "../helpers.js";

type StoreFactory = () => MemoryStore;

export function rawEventsRoutes(getStore: StoreFactory) {
	const app = new Hono();

	// GET /api/raw-events (compat endpoint for stats panel)
	app.get("/api/raw-events", (c) => {
		const store = getStore();
		{
			// Pending = events received but not yet flushed to the observer.
			// Matches Python's raw_event_backlog calculation.
			const row = store.db
				.prepare(
					`SELECT COALESCE(SUM(last_received_event_seq - last_flushed_event_seq), 0) AS pending,
						COUNT(*) AS sessions
					 FROM raw_event_sessions
					 WHERE last_received_event_seq > last_flushed_event_seq`,
				)
				.get() as Record<string, unknown>;
			return c.json({
				pending: Number(row.pending ?? 0),
				sessions: Number(row.sessions ?? 0),
			});
		}
	});

	// GET /api/raw-events/status
	app.get("/api/raw-events/status", (c) => {
		const store = getStore();
		{
			const limit = queryInt(c.req.query("limit"), 25);
			const rows = store.db
				.prepare(
					`SELECT source, stream_id, opencode_session_id, cwd, project,
						started_at, last_seen_ts_wall_ms,
						last_received_event_seq, last_flushed_event_seq, updated_at
					 FROM raw_event_sessions
					 ORDER BY updated_at DESC
					 LIMIT ?`,
				)
				.all(limit) as Record<string, unknown>[];
			const items = rows.map((row) => {
				const streamId = String(row.stream_id ?? row.opencode_session_id ?? "");
				return {
					...row,
					session_stream_id: streamId,
					session_id: streamId,
				};
			});
			const totals = store.db
				.prepare(
					`SELECT COUNT(*) AS pending,
						COUNT(DISTINCT opencode_session_id) AS sessions
					 FROM raw_events`,
				)
				.get() as Record<string, unknown>;
			return c.json({
				items,
				totals: {
					pending: Number(totals.pending ?? 0),
					sessions: Number(totals.sessions ?? 0),
				},
				ingest: {
					available: false,
					mode: "not_implemented",
					reason: "POST /api/raw-events not yet ported to TS viewer-server",
				},
			});
		}
	});

	return app;
}
