/**
 * Stats routes — GET /api/stats, GET /api/usage.
 *
 * Ports Python's viewer_routes/stats.py.
 */

import {
	buildFilterClausesWithContext,
	listMaintenanceJobs,
	type MemoryStore,
	VERSION,
} from "@codemem/core";
import { Hono } from "hono";

function maintenanceJobSortKey(job: {
	started_at: string | null;
	updated_at: string;
	kind: string;
}): [string, string] {
	return [job.started_at ?? job.updated_at, job.kind];
}

function sortActiveMaintenanceJobs<
	T extends { started_at: string | null; updated_at: string; kind: string },
>(jobs: T[]): T[] {
	return [...jobs].sort((a, b) => {
		const [aTime, aKind] = maintenanceJobSortKey(a);
		const [bTime, bKind] = maintenanceJobSortKey(b);
		if (aTime !== bTime) return aTime.localeCompare(bTime);
		return aKind.localeCompare(bKind);
	});
}

const MEMORY_ID_METADATA_KEYS = ["pack_item_ids", "added_ids", "removed_ids", "retained_ids"];

type UsageRow = {
	id: number;
	session_id: number | null;
	event: string;
	tokens_read: number;
	tokens_written: number;
	tokens_saved: number;
	created_at: string;
	metadata_json: Record<string, unknown> | null;
};

function toUsageRow(
	row: Record<string, unknown>,
	metadata: Record<string, unknown> | null,
): UsageRow {
	return {
		id: Number(row.id ?? 0),
		session_id: row.session_id == null ? null : Number(row.session_id),
		event: String(row.event ?? "pack"),
		tokens_read: Number(row.tokens_read ?? 0),
		tokens_written: Number(row.tokens_written ?? 0),
		tokens_saved: Number(row.tokens_saved ?? 0),
		created_at: String(row.created_at ?? ""),
		metadata_json: metadata,
	};
}

function visibleMemoryIds(store: MemoryStore, value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => (typeof item === "number" ? item : Number(item)))
		.filter((item) => Number.isInteger(item) && store.get(item) != null);
}

function sessionHasVisibleMemory(store: MemoryStore, sessionId: number): boolean {
	const filterResult = buildFilterClausesWithContext(
		{ session_id: sessionId },
		{
			actorId: store.actorId,
			deviceId: store.deviceId,
			enforceScopeVisibility: true,
		},
	);
	const clauses = ["memory_items.active = 1", ...filterResult.clauses];
	const row = store.db
		.prepare(`SELECT 1 AS found FROM memory_items WHERE ${clauses.join(" AND ")} LIMIT 1`)
		.get(...filterResult.params) as Record<string, unknown> | undefined;
	return row != null;
}

function usageRowVisible(store: MemoryStore, row: UsageRow): boolean {
	const packItemIds = row.metadata_json?.pack_item_ids;
	if (Array.isArray(packItemIds)) {
		if (packItemIds.length === 0) {
			return row.session_id != null && sessionHasVisibleMemory(store, row.session_id);
		}
		return visibleMemoryIds(store, packItemIds).length > 0;
	}
	return row.session_id != null && sessionHasVisibleMemory(store, row.session_id);
}

function sanitizePackUsageMetadata(
	store: MemoryStore,
	metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!metadata) return null;
	const sanitized = { ...metadata };
	for (const key of MEMORY_ID_METADATA_KEYS) {
		if (Array.isArray(sanitized[key])) {
			sanitized[key] = visibleMemoryIds(store, sanitized[key]);
		}
	}
	return sanitized;
}

function summarizeUsageEvents(rows: UsageRow[]): Record<string, unknown>[] {
	const byEvent = new Map<
		string,
		{
			event: string;
			total_tokens_read: number;
			total_tokens_written: number;
			total_tokens_saved: number;
			count: number;
		}
	>();
	for (const row of rows) {
		const summary = byEvent.get(row.event) ?? {
			event: row.event,
			total_tokens_read: 0,
			total_tokens_written: 0,
			total_tokens_saved: 0,
			count: 0,
		};
		summary.total_tokens_read += row.tokens_read;
		summary.total_tokens_written += row.tokens_written;
		summary.total_tokens_saved += row.tokens_saved;
		summary.count += 1;
		byEvent.set(row.event, summary);
	}
	return [...byEvent.values()].sort((a, b) => a.event.localeCompare(b.event));
}

function totalUsageEvents(rows: UsageRow[]): Record<string, unknown> {
	return rows.reduce(
		(acc, row) => ({
			tokens_read: Number(acc.tokens_read) + row.tokens_read,
			tokens_written: Number(acc.tokens_written) + row.tokens_written,
			tokens_saved: Number(acc.tokens_saved) + row.tokens_saved,
			count: Number(acc.count) + 1,
		}),
		{ tokens_read: 0, tokens_written: 0, tokens_saved: 0, count: 0 } as Record<string, unknown>,
	);
}

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

	// Keep completed jobs visible in /api/stats for a short window after
	// finished_at so the health UI has a chance to render success confirmation
	// for fast-completing backfills (often <1s). Failed jobs stay indefinitely.
	const RECENTLY_COMPLETED_WINDOW_MS = 120_000;

	app.get("/api/stats", (c) => {
		const store = getStore();
		const jobs = listMaintenanceJobs(store.db);
		const now = Date.now();
		const surfacedJobs = sortActiveMaintenanceJobs(
			jobs.filter((job) => {
				if (job.status === "pending" || job.status === "running" || job.status === "failed") {
					return true;
				}
				if (job.status === "completed" && job.finished_at) {
					const finished = Date.parse(job.finished_at);
					if (Number.isFinite(finished) && now - finished <= RECENTLY_COMPLETED_WINDOW_MS) {
						return true;
					}
				}
				return false;
			}),
		).map((job) => ({
			kind: job.kind,
			title: job.title,
			status: job.status,
			message: job.message,
			progress: job.progress,
			finished_at: job.finished_at,
			error: job.error,
		}));
		return c.json({
			...store.stats(),
			viewer_pid: process.pid,
			maintenance_jobs: surfacedJobs,
		});
	});

	app.get("/api/runtime", (c) => {
		return c.json({
			version: VERSION,
		});
	});

	app.get("/api/usage", (c) => {
		const store = getStore();
		{
			const projectFilter = c.req.query("project") || null;
			const loadUsageRows = (project?: string | null): UsageRow[] => {
				const rows = project
					? (store.db
							.prepare(
								`SELECT usage_events.id, usage_events.session_id, usage_events.event,
									usage_events.tokens_read, usage_events.tokens_written, usage_events.tokens_saved,
									usage_events.created_at, usage_events.metadata_json
								 FROM usage_events
								 JOIN sessions ON sessions.id = usage_events.session_id
								 WHERE sessions.project = ?
								 ORDER BY usage_events.created_at DESC`,
							)
							.all(project) as Record<string, unknown>[])
					: (store.db
							.prepare(
								`SELECT id, session_id, event, tokens_read, tokens_written, tokens_saved,
									created_at, metadata_json
								 FROM usage_events
								 ORDER BY created_at DESC`,
							)
							.all() as Record<string, unknown>[]);
				return rows
					.map((row) => toUsageRow(row, parseMetadataJson(row.metadata_json)))
					.filter((row) => usageRowVisible(store, row));
			};
			const globalRows = loadUsageRows();
			const filteredRows = projectFilter ? loadUsageRows(projectFilter) : null;
			const eventsGlobal = summarizeUsageEvents(globalRows);
			const totalsGlobal = totalUsageEvents(globalRows);
			const eventsFiltered = filteredRows ? summarizeUsageEvents(filteredRows) : null;
			const totalsFiltered = filteredRows ? totalUsageEvents(filteredRows) : null;
			const recentPacks = (filteredRows ?? globalRows)
				.filter((row) => row.event === "pack")
				.slice(0, 10)
				.map((row) => ({
					...row,
					metadata_json: sanitizePackUsageMetadata(store, row.metadata_json),
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
