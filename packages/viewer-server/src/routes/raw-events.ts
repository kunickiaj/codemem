/**
 * Raw events routes — port of codemem/viewer_routes/raw_events.py.
 *
 * GET  /api/raw-events        — backlog totals (compat for stats panel)
 * GET  /api/raw-events/status — full backlog with session details
 * POST /api/raw-events        — ingest raw events
 * POST /api/claude-hooks      — ingest Claude hook payloads
 *
 * The raw event ingestion and backlog management depends on store methods
 * not yet ported to TS (raw_event_backlog, record_raw_events_batch, etc.).
 * GET routes are stubbed; POST routes will need the full ingest pipeline.
 */

import type { MemoryStore } from "@codemem/core";
import { Hono } from "hono";
import type { ViewerVariables } from "../middleware.js";

const app = new Hono<{ Variables: ViewerVariables }>();

// TODO: Port raw_event_backlog(), raw_event_backlog_totals() to TS store
// Python source: codemem/viewer_routes/raw_events.py lines 94-119
app.get("/api/raw-events", (c) => {
	const store = c.get("store") as MemoryStore;
	// Return minimal totals structure — backlog queries not yet ported
	try {
		const row = store.db
			.prepare(
				`SELECT COUNT(*) AS pending,
				        COUNT(DISTINCT opencode_session_id) AS sessions
				 FROM raw_events`,
			)
			.get() as { pending: number; sessions: number } | undefined;
		return c.json({
			pending: row?.pending ?? 0,
			sessions: row?.sessions ?? 0,
		});
	} catch {
		return c.json({ pending: 0, sessions: 0 });
	}
});

app.get("/api/raw-events/status", (c) => {
	const store = c.get("store") as MemoryStore;
	void store;
	// TODO: Port raw_event_backlog() with session aliases to TS store
	// Python source: codemem/viewer_routes/raw_events.py lines 96-115
	return c.json({
		items: [],
		totals: { pending: 0, sessions: 0 },
		ingest: {
			available: false,
			mode: "not_implemented",
			max_body_bytes: 1048576,
		},
	});
});

// TODO: Port raw event ingestion (POST /api/raw-events)
// Python source: codemem/viewer_routes/raw_events.py lines 248-470
// Depends on: store.record_raw_events_batch(), store.update_raw_event_session_meta(),
//   _resolve_session_stream_id(), strip_private_obj(), flusher.note_activity()
app.post("/api/raw-events", (c) => {
	return c.json({ error: "not yet implemented" }, 501);
});

// TODO: Port Claude hooks ingestion (POST /api/claude-hooks)
// Python source: codemem/viewer_routes/raw_events.py lines 176-246
// Depends on: build_raw_event_envelope_from_hook(), store.record_raw_event()
app.post("/api/claude-hooks", (c) => {
	return c.json({ error: "not yet implemented" }, 501);
});

export default app;
