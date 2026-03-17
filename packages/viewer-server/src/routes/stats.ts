/**
 * Stats routes — GET /api/stats, GET /api/usage.
 *
 * Ports Python's viewer_routes/stats.py.
 */

import type { MemoryStore } from "@codemem/core";
import { Hono } from "hono";

/**
 * Create stats routes. The store factory is called per-request to get a
 * fresh connection (matching the Python viewer pattern).
 */
export function statsRoutes(getStore: () => MemoryStore) {
	const app = new Hono();

	app.get("/api/stats", (c) => {
		const store = getStore();
		return c.json(store.stats());
	});

	app.get("/api/usage", (c) => {
		const store = getStore();
		{
			const projectFilter = c.req.query("project") || null;
			const eventsGlobal = store.db
				.prepare(
					`SELECT event,
						SUM(tokens_read) AS total_tokens_read,
						SUM(tokens_written) AS total_tokens_written,
						SUM(tokens_saved) AS total_tokens_saved,
						COUNT(*) AS count
					 FROM usage_events GROUP BY event ORDER BY event`,
				)
				.all() as Record<string, unknown>[];
			const totalsGlobal = store.db
				.prepare(
					`SELECT COALESCE(SUM(tokens_read),0) AS tokens_read,
						COALESCE(SUM(tokens_written),0) AS tokens_written,
						COALESCE(SUM(tokens_saved),0) AS tokens_saved,
						COUNT(*) AS count
					 FROM usage_events`,
				)
				.get() as Record<string, unknown>;
			let eventsFiltered: Record<string, unknown>[] | null = null;
			let totalsFiltered: Record<string, unknown> | null = null;
			if (projectFilter) {
				eventsFiltered = store.db
					.prepare(
						`SELECT event,
							SUM(tokens_read) AS total_tokens_read,
							SUM(tokens_written) AS total_tokens_written,
							SUM(tokens_saved) AS total_tokens_saved,
							COUNT(*) AS count
						 FROM usage_events
						 JOIN sessions ON sessions.id = usage_events.session_id
						 WHERE sessions.project = ?
						 GROUP BY event ORDER BY event`,
					)
					.all(projectFilter) as Record<string, unknown>[];
				totalsFiltered = store.db
					.prepare(
						`SELECT COALESCE(SUM(tokens_read),0) AS tokens_read,
							COALESCE(SUM(tokens_written),0) AS tokens_written,
							COALESCE(SUM(tokens_saved),0) AS tokens_saved,
							COUNT(*) AS count
						 FROM usage_events
						 JOIN sessions ON sessions.id = usage_events.session_id
						 WHERE sessions.project = ?`,
					)
					.get(projectFilter) as Record<string, unknown>;
			}
			return c.json({
				project: projectFilter,
				events: projectFilter ? eventsFiltered : eventsGlobal,
				totals: projectFilter ? totalsFiltered : totalsGlobal,
				events_global: eventsGlobal,
				totals_global: totalsGlobal,
				events_filtered: eventsFiltered,
				totals_filtered: totalsFiltered,
				recent_packs: [],
			});
		}
	});

	return app;
}
