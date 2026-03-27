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

	const parseMetadataJson = (value: unknown): Record<string, unknown> | null => {
		if (typeof value !== "string" || !value.trim()) return null;
		try {
			return JSON.parse(value) as Record<string, unknown>;
		} catch {
			return null;
		}
	};

	app.get("/api/stats", (c) => {
		const store = getStore();
		return c.json({
			...store.stats(),
			viewer_pid: process.pid,
		});
	});

	app.get("/api/usage", (c) => {
		const store = getStore();
		{
			const projectFilter = c.req.query("project") || null;
			const recentPacksQuery = projectFilter
				? store.db.prepare(
						`SELECT usage_events.id, usage_events.session_id, usage_events.event,
						usage_events.tokens_read, usage_events.tokens_written, usage_events.tokens_saved,
						usage_events.created_at, usage_events.metadata_json
					 FROM usage_events
					 JOIN sessions ON sessions.id = usage_events.session_id
					 WHERE usage_events.event = 'pack' AND sessions.project = ?
					 ORDER BY usage_events.created_at DESC
					 LIMIT 10`,
					)
				: store.db.prepare(
						`SELECT id, session_id, event, tokens_read, tokens_written, tokens_saved, created_at, metadata_json
					 FROM usage_events
					 WHERE event = 'pack'
					 ORDER BY created_at DESC
					 LIMIT 10`,
					);
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
			const recentPacksRaw = (
				projectFilter ? recentPacksQuery.all(projectFilter) : recentPacksQuery.all()
			) as Record<string, unknown>[];
			const recentPacks = recentPacksRaw.map((row) => ({
				id: Number(row.id ?? 0),
				session_id: row.session_id == null ? null : Number(row.session_id),
				event: String(row.event ?? "pack"),
				tokens_read: Number(row.tokens_read ?? 0),
				tokens_written: Number(row.tokens_written ?? 0),
				tokens_saved: Number(row.tokens_saved ?? 0),
				created_at: String(row.created_at ?? ""),
				metadata_json: parseMetadataJson(row.metadata_json),
			}));

			return c.json({
				project: projectFilter,
				events: projectFilter ? eventsFiltered : eventsGlobal,
				totals: projectFilter ? totalsFiltered : totalsGlobal,
				events_global: eventsGlobal,
				totals_global: totalsGlobal,
				events_filtered: eventsFiltered,
				totals_filtered: totalsFiltered,
				recent_packs: recentPacks,
			});
		}
	});

	return app;
}
