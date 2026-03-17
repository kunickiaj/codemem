/**
 * Observer status route — port of codemem/viewer_routes/observer_status.py.
 *
 * GET /api/observer-status — observer runtime + credential status
 *
 * Most of this depends on Python-only runtime state (observer instance,
 * raw event sweeper, credential probing). Stubbed until those are ported.
 */

import { Hono } from "hono";
import type { ViewerVariables } from "../middleware.js";

const app = new Hono<{ Variables: ViewerVariables }>();

// TODO: Port observer runtime status, credential probing, and queue state.
// Python source: codemem/viewer_routes/observer_status.py (67 lines)
// Depends on: plugin_ingest.OBSERVER, observer.probe_available_credentials(),
//   store.raw_event_backlog_totals(), store.latest_raw_event_flush_failure(),
//   RAW_EVENT_SWEEPER.auth_backoff_status()
app.get("/api/observer-status", (c) => {
	return c.json({
		active: null,
		available_credentials: {},
		latest_failure: null,
		queue: {
			pending: 0,
			sessions: 0,
			auth_backoff_active: false,
			auth_backoff_remaining_s: 0,
		},
	});
});

export default app;
