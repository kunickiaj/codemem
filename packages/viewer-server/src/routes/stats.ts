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

type UsageVisibility = {
	visibleMemoryIds: Set<number>;
	visibleSessionIds: Set<number>;
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

function metadataMemoryIds(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => (typeof item === "number" ? item : Number(item)))
		.filter((item) => Number.isInteger(item) && item > 0);
}

function chunkNumbers(values: number[], chunkSize = 500): number[][] {
	const chunks: number[][] = [];
	for (let start = 0; start < values.length; start += chunkSize) {
		chunks.push(values.slice(start, start + chunkSize));
	}
	return chunks;
}

function visibleMemoryIdSet(store: MemoryStore, memoryIds: Set<number>): Set<number> {
	if (memoryIds.size === 0) return new Set();
	const filterResult = buildFilterClausesWithContext(null, {
		actorId: store.actorId,
		deviceId: store.deviceId,
		enforceScopeVisibility: true,
	});
	const visibleIds = new Set<number>();
	for (const chunk of chunkNumbers([...memoryIds])) {
		const placeholders = chunk.map(() => "?").join(", ");
		const clauses = [
			"memory_items.active = 1",
			`memory_items.id IN (${placeholders})`,
			...filterResult.clauses,
		];
		const rows = store.db
			.prepare(`SELECT memory_items.id FROM memory_items WHERE ${clauses.join(" AND ")}`)
			.all(...chunk, ...filterResult.params) as Array<{ id: number }>;
		for (const row of rows) visibleIds.add(Number(row.id));
	}
	return visibleIds;
}

function visibleSessionIdSet(store: MemoryStore, sessionIds: Set<number>): Set<number> {
	if (sessionIds.size === 0) return new Set();
	const filterResult = buildFilterClausesWithContext(null, {
		actorId: store.actorId,
		deviceId: store.deviceId,
		enforceScopeVisibility: true,
	});
	const visibleIds = new Set<number>();
	for (const chunk of chunkNumbers([...sessionIds])) {
		const placeholders = chunk.map(() => "?").join(", ");
		const clauses = [
			"memory_items.active = 1",
			`memory_items.session_id IN (${placeholders})`,
			...filterResult.clauses,
		];
		const rows = store.db
			.prepare(
				`SELECT DISTINCT memory_items.session_id AS session_id
				 FROM memory_items
				 WHERE ${clauses.join(" AND ")}`,
			)
			.all(...chunk, ...filterResult.params) as Array<{ session_id: number | null }>;
		for (const row of rows) {
			if (typeof row.session_id === "number") visibleIds.add(row.session_id);
		}
	}
	return visibleIds;
}

function buildUsageVisibility(store: MemoryStore, rows: UsageRow[]): UsageVisibility {
	const memoryIds = new Set<number>();
	const sessionIds = new Set<number>();
	for (const row of rows) {
		if (typeof row.session_id === "number") sessionIds.add(row.session_id);
		for (const key of MEMORY_ID_METADATA_KEYS) {
			for (const memoryId of metadataMemoryIds(row.metadata_json?.[key])) {
				memoryIds.add(memoryId);
			}
		}
	}
	return {
		visibleMemoryIds: visibleMemoryIdSet(store, memoryIds),
		visibleSessionIds: visibleSessionIdSet(store, sessionIds),
	};
}

function usageRowVisible(row: UsageRow, visibility: UsageVisibility): boolean {
	const rowSessionVisible =
		row.session_id == null || visibility.visibleSessionIds.has(row.session_id);
	const packItemIds = row.metadata_json?.pack_item_ids;
	if (Array.isArray(packItemIds)) {
		if (packItemIds.length === 0) {
			return row.session_id != null && visibility.visibleSessionIds.has(row.session_id);
		}
		return (
			rowSessionVisible &&
			metadataMemoryIds(packItemIds).some((memoryId) => visibility.visibleMemoryIds.has(memoryId))
		);
	}
	return row.session_id != null && visibility.visibleSessionIds.has(row.session_id);
}

function sanitizePackUsageMetadata(
	metadata: Record<string, unknown> | null,
	visibility: UsageVisibility,
): Record<string, unknown> | null {
	if (!metadata) return null;
	const sanitized = { ...metadata };
	for (const key of MEMORY_ID_METADATA_KEYS) {
		if (Array.isArray(sanitized[key])) {
			sanitized[key] = metadataMemoryIds(sanitized[key]).filter((memoryId) =>
				visibility.visibleMemoryIds.has(memoryId),
			);
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

type UsagePayload = Record<string, unknown>;

interface UsageCacheEntry {
	payload: UsagePayload;
	expiresAtMs: number;
}

/**
 * Short-lived cache for the computed /api/usage payload.
 *
 * The health dot polls /api/usage on every 5s refresh regardless of the
 * active tab, and the computation scans the full usage_events table to apply
 * scope visibility before aggregating. The resulting token totals are
 * cumulative dashboard figures, so a few seconds of staleness is acceptable
 * in exchange for collapsing the repeated full-table scan on the polling
 * loop. Keyed by db path + scope identity + project filter so distinct
 * stores/projects never share an entry.
 */
const usagePayloadCache = new Map<string, UsageCacheEntry>();
const USAGE_PAYLOAD_CACHE_MS = 10_000;

/**
 * Cheap fingerprint of the state that drives scope visibility
 * (`scope_memberships` / `replication_scopes`). Folding this into the usage
 * cache key ensures a membership/scope status change — e.g. a revocation —
 * invalidates any cached payload immediately instead of letting a device keep
 * reading a scope it can no longer see for up to the TTL. These tables are
 * small, so the aggregate is negligible next to the usage_events scan the
 * cache exists to avoid. Fails safe: any error forces a unique value so the
 * request bypasses the cache and recomputes visibility from scratch.
 */
function scopeVisibilityGeneration(store: MemoryStore): string {
	try {
		const row = store.db
			.prepare(
				`SELECT
					(SELECT COUNT(*) FROM scope_memberships) AS m_count,
					(SELECT COUNT(*) FROM scope_memberships WHERE status = 'active') AS m_active,
					(SELECT COALESCE(MAX(updated_at), '') FROM scope_memberships) AS m_updated,
					(SELECT COALESCE(MAX(membership_epoch), 0) FROM scope_memberships) AS m_epoch,
					(SELECT COUNT(*) FROM replication_scopes) AS s_count,
					(SELECT COUNT(*) FROM replication_scopes WHERE status = 'active') AS s_active,
					(SELECT COALESCE(MAX(updated_at), '') FROM replication_scopes) AS s_updated`,
			)
			.get() as Record<string, unknown> | undefined;
		if (!row) return "no-scope-state";
		return [
			row.m_count,
			row.m_active,
			row.m_updated,
			row.m_epoch,
			row.s_count,
			row.s_active,
			row.s_updated,
		].join(":");
	} catch {
		// Fail safe: bypass the cache rather than risk serving a payload
		// computed under stale visibility rules.
		return `bypass-${Date.now()}-${Math.random()}`;
	}
}

function usageCacheKey(store: MemoryStore, projectFilter: string | null): string {
	const visibilityGeneration = scopeVisibilityGeneration(store);
	return `${store.dbPath}|${store.actorId}|${store.deviceId}|${projectFilter ?? ""}|${visibilityGeneration}`;
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
			const cacheKey = usageCacheKey(store, projectFilter);
			const nowMs = Date.now();
			const cached = usagePayloadCache.get(cacheKey);
			if (cached && nowMs < cached.expiresAtMs) {
				return c.json(cached.payload);
			}
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
				return rows.map((row) => toUsageRow(row, parseMetadataJson(row.metadata_json)));
			};
			const loadedGlobalRows = loadUsageRows();
			const globalVisibility = buildUsageVisibility(store, loadedGlobalRows);
			const globalRows = loadedGlobalRows.filter((row) => usageRowVisible(row, globalVisibility));
			const loadedFilteredRows = projectFilter ? loadUsageRows(projectFilter) : null;
			const filteredVisibility = loadedFilteredRows
				? buildUsageVisibility(store, loadedFilteredRows)
				: null;
			const filteredRows = loadedFilteredRows
				? loadedFilteredRows.filter((row) =>
						usageRowVisible(row, filteredVisibility ?? globalVisibility),
					)
				: null;
			const eventsGlobal = summarizeUsageEvents(globalRows);
			const totalsGlobal = totalUsageEvents(globalRows);
			const eventsFiltered = filteredRows ? summarizeUsageEvents(filteredRows) : null;
			const totalsFiltered = filteredRows ? totalUsageEvents(filteredRows) : null;
			const recentVisibility = filteredVisibility ?? globalVisibility;
			const recentPacks = (filteredRows ?? globalRows)
				.filter((row) => row.event === "pack")
				.slice(0, 10)
				.map((row) => ({
					...row,
					metadata_json: sanitizePackUsageMetadata(row.metadata_json, recentVisibility),
				}));

			const payload: UsagePayload = {
				project: projectFilter,
				events: projectFilter ? eventsFiltered : eventsGlobal,
				totals: projectFilter ? totalsFiltered : totalsGlobal,
				events_global: eventsGlobal,
				totals_global: totalsGlobal,
				events_filtered: eventsFiltered,
				totals_filtered: totalsFiltered,
				recent_packs: recentPacks,
			};
			usagePayloadCache.set(cacheKey, {
				payload,
				expiresAtMs: Date.now() + USAGE_PAYLOAD_CACHE_MS,
			});
			return c.json(payload);
		}
	});

	return app;
}
