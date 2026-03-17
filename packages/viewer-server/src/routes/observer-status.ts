/**
 * Observer status route — GET /api/observer-status.
 *
 * Ports Python's viewer_routes/observer_status.py.
 * Returns observer runtime info, credential availability, and queue status.
 *
 * NOTE: The Python observer runtime (probe_available_credentials, OBSERVER
 * singleton, RAW_EVENT_SWEEPER) is not yet available in TS. This route
 * returns stub data until those subsystems are ported.
 */

import { Hono } from "hono";

export function observerStatusRoutes() {
	const app = new Hono();

	app.get("/api/observer-status", (c) => {
		// Stub: return minimal structure matching Python's response shape.
		// Real implementation requires porting the observer runtime.
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

	return app;
}
