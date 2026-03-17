/**
 * Memory routes — port of codemem/viewer_routes/memory.py.
 *
 * Routes:
 *   GET  /api/memories     — list observations (alias for /api/observations)
 *   GET  /api/observations — paginated observations by kind
 *   GET  /api/summaries    — paginated session summaries
 *   GET  /api/memory       — recent memories with optional kind/project filter
 *   GET  /api/sessions     — recent sessions
 *   GET  /api/session      — aggregate counts for a project
 *   GET  /api/projects     — distinct project names
 *   GET  /api/artifacts    — artifacts for a session
 *   GET  /api/pack         — build memory pack
 *   POST /api/memories/visibility — update memory visibility
 */

import {
	fromJson,
	type MemoryFilters,
	type MemoryItemResponse,
	type MemoryStore,
} from "@codemem/core";
import { Hono } from "hono";
import type { ViewerVariables } from "../middleware.js";

const app = new Hono<{ Variables: ViewerVariables }>();

// ---------------------------------------------------------------------------
// Helpers — mirrors Python's _attach_session_fields / _attach_ownership_fields
// ---------------------------------------------------------------------------

interface MemoryWithSessionFields extends MemoryItemResponse {
	project?: string;
	cwd?: string;
	owned_by_self?: boolean;
}

/**
 * Attach session project/cwd to memory items.
 * Python source: codemem/viewer_routes/memory.py lines 15-62
 */
function attachSessionFields(store: MemoryStore, items: MemoryWithSessionFields[]): void {
	const sessionIds: number[] = [];
	const seen = new Set<number>();
	for (const item of items) {
		const sid = item.session_id;
		if (sid == null || seen.has(sid)) continue;
		seen.add(sid);
		sessionIds.push(sid);
	}
	if (sessionIds.length === 0) return;

	const placeholders = sessionIds.map(() => "?").join(", ");
	const rows = store.db
		.prepare(`SELECT id, project, cwd FROM sessions WHERE id IN (${placeholders})`)
		.all(...sessionIds) as Array<{ id: number; project: string | null; cwd: string | null }>;

	const bySession = new Map<number, { project: string; cwd: string }>();
	for (const row of rows) {
		const project = (row.project ?? "").trim();
		// Python uses store._project_basename — just take the last path segment
		const basename = project ? (project.split("/").pop() ?? project) : "";
		bySession.set(row.id, { project: basename, cwd: row.cwd ?? "" });
	}

	for (const item of items) {
		const fields = bySession.get(item.session_id);
		if (!fields) continue;
		item.project ??= fields.project;
		item.cwd ??= fields.cwd;
	}
}

/**
 * Attach ownership flags to memory items.
 * Python source: codemem/viewer_routes/memory.py lines 65-67
 */
function attachOwnershipFields(store: MemoryStore, items: MemoryWithSessionFields[]): void {
	for (const item of items) {
		// Mirrors Python's memory_owned_by_self: checks origin_device_id
		item.owned_by_self = !item.origin_device_id || item.origin_device_id === store.deviceId;
	}
}

/**
 * Apply scope filter to memory filters.
 * Python source: codemem/viewer_routes/memory.py lines 70-83
 */
function applyScopeFilter(
	store: MemoryStore,
	baseFilters: MemoryFilters | undefined,
	scope: string | null,
): { filters: MemoryFilters; valid: boolean } {
	const normalized = (scope ?? "all").trim().toLowerCase();
	if (!["all", "mine", "theirs", "shared"].includes(normalized)) {
		return { filters: {}, valid: false };
	}
	const filters: MemoryFilters = { ...(baseFilters ?? {}) };
	if (normalized === "mine") {
		// TODO: ownership_scope filter not yet in TS buildFilterClauses
		// Python source: codemem/viewer_routes/memory.py line 78
	} else if (normalized === "theirs") {
		// TODO: ownership_scope filter not yet in TS buildFilterClauses
	} else if (normalized === "shared") {
		filters.include_visibility = ["shared"];
	}
	void store; // used by ownership_scope once ported
	return { filters, valid: true };
}

// ---------------------------------------------------------------------------
// Observation kinds (memories minus session_summary)
// ---------------------------------------------------------------------------

const OBSERVATION_KINDS = [
	"bugfix",
	"change",
	"decision",
	"discovery",
	"exploration",
	"feature",
	"refactor",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeInt(value: string | undefined, fallback: number): number {
	if (value == null) return fallback;
	const n = Number.parseInt(value, 10);
	return Number.isNaN(n) ? fallback : n;
}

function intParam(
	c: { req: { query: (k: string) => string | undefined } },
	key: string,
	fallback: number,
): number | null {
	const raw = c.req.query(key);
	if (raw == null) return fallback;
	const n = Number.parseInt(raw, 10);
	if (Number.isNaN(n)) return null; // signal parse error
	return n;
}

// ---------------------------------------------------------------------------
// GET routes
// ---------------------------------------------------------------------------

app.get("/api/memories", (c) => {
	// Compatibility endpoint — redirect logic to /api/observations
	const url = new URL(c.req.url);
	url.pathname = "/api/observations";
	return c.redirect(url.pathname + url.search, 307);
});

app.get("/api/observations", (c) => {
	const store = c.get("store") as MemoryStore;
	const limit = intParam(c, "limit", 20);
	const offset = intParam(c, "offset", 0);
	if (limit === null || offset === null) {
		return c.json({ error: "limit and offset must be int" }, 400);
	}
	const clampedLimit = Math.max(1, limit);
	const clampedOffset = Math.max(0, offset);

	const project = c.req.query("project") ?? null;
	const scope = c.req.query("scope") ?? "all";

	const baseFilters: MemoryFilters | undefined = project ? { project } : undefined;
	const { filters, valid } = applyScopeFilter(store, baseFilters, scope);
	if (!valid) return c.json({ error: "invalid_scope" }, 400);

	const items = store.recentByKinds(OBSERVATION_KINDS, clampedLimit + 1, filters, clampedOffset);
	const hasMore = items.length > clampedLimit;
	const page = hasMore ? items.slice(0, clampedLimit) : items;
	const enriched = page as MemoryWithSessionFields[];
	attachSessionFields(store, enriched);
	attachOwnershipFields(store, enriched);

	return c.json({
		items: enriched,
		pagination: {
			limit: clampedLimit,
			offset: clampedOffset,
			next_offset: hasMore ? clampedOffset + page.length : null,
			has_more: hasMore,
		},
	});
});

app.get("/api/summaries", (c) => {
	const store = c.get("store") as MemoryStore;
	const limit = intParam(c, "limit", 50);
	const offset = intParam(c, "offset", 0);
	if (limit === null || offset === null) {
		return c.json({ error: "limit and offset must be int" }, 400);
	}
	const clampedLimit = Math.max(1, limit);
	const clampedOffset = Math.max(0, offset);

	const project = c.req.query("project") ?? null;
	const scope = c.req.query("scope") ?? "all";

	const baseFilters: MemoryFilters = { kind: "session_summary" };
	if (project) baseFilters.project = project;
	const { filters, valid } = applyScopeFilter(store, baseFilters, scope);
	if (!valid) return c.json({ error: "invalid_scope" }, 400);

	const items = store.recent(clampedLimit + 1, filters, clampedOffset);
	const hasMore = items.length > clampedLimit;
	const page = hasMore ? items.slice(0, clampedLimit) : items;
	const enriched = page as MemoryWithSessionFields[];
	attachSessionFields(store, enriched);
	attachOwnershipFields(store, enriched);

	return c.json({
		items: enriched,
		pagination: {
			limit: clampedLimit,
			offset: clampedOffset,
			next_offset: hasMore ? clampedOffset + page.length : null,
			has_more: hasMore,
		},
	});
});

app.get("/api/memory", (c) => {
	const store = c.get("store") as MemoryStore;
	const limit = safeInt(c.req.query("limit"), 20);
	const kind = c.req.query("kind") ?? null;
	const project = c.req.query("project") ?? null;
	const scope = c.req.query("scope") ?? "all";

	const baseFilters: MemoryFilters = {};
	if (kind) baseFilters.kind = kind;
	if (project) baseFilters.project = project;
	const { filters, valid } = applyScopeFilter(
		store,
		Object.keys(baseFilters).length > 0 ? baseFilters : undefined,
		scope,
	);
	if (!valid) return c.json({ error: "invalid_scope" }, 400);

	const items = store.recent(limit, filters) as MemoryWithSessionFields[];
	attachSessionFields(store, items);
	attachOwnershipFields(store, items);

	return c.json({ items });
});

app.get("/api/sessions", (c) => {
	const store = c.get("store") as MemoryStore;
	const limit = safeInt(c.req.query("limit"), 20);

	// TODO: Port allSessions() to TS store
	// Python source: codemem/viewer_routes/memory.py lines 91-98
	const rows = store.db
		.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
		.all(limit) as Array<Record<string, unknown>>;

	const items = rows.map((row) => ({
		...row,
		metadata_json: fromJson(row.metadata_json as string | null),
	}));

	return c.json({ items });
});

app.get("/api/projects", (c) => {
	const store = c.get("store") as MemoryStore;

	// TODO: Port allSessions() / _project_basename() to TS store
	// Python source: codemem/viewer_routes/memory.py lines 100-114
	const rows = store.db
		.prepare("SELECT project FROM sessions WHERE project IS NOT NULL AND project != ''")
		.all() as Array<{ project: string }>;

	const projects = [
		...new Set(
			rows
				.map((r) => r.project.trim())
				.filter((p) => p && !p.toLowerCase().startsWith("fatal:"))
				.map((p) => p.split("/").pop() ?? p)
				.filter(Boolean),
		),
	].sort();

	return c.json({ projects });
});

app.get("/api/session", (c) => {
	const store = c.get("store") as MemoryStore;
	const project = c.req.query("project") ?? null;

	// Aggregate counts — mirrors Python codemem/viewer_routes/memory.py lines 198-258
	const count = (sql: string, params: unknown[] = []): number => {
		const row = store.db.prepare(sql).get(...params) as { total: number } | undefined;
		return row?.total ?? 0;
	};

	let prompts: number;
	let artifacts: number;
	let memories: number;
	let observations: number;

	if (project) {
		prompts = count("SELECT COUNT(*) AS total FROM user_prompts WHERE project = ?", [project]);
		artifacts = count(
			`SELECT COUNT(*) AS total FROM artifacts
			 JOIN sessions ON sessions.id = artifacts.session_id
			 WHERE sessions.project = ?`,
			[project],
		);
		memories = count(
			`SELECT COUNT(*) AS total FROM memory_items
			 JOIN sessions ON sessions.id = memory_items.session_id
			 WHERE sessions.project = ?`,
			[project],
		);
		observations = count(
			`SELECT COUNT(*) AS total FROM memory_items
			 JOIN sessions ON sessions.id = memory_items.session_id
			 WHERE kind != 'session_summary' AND sessions.project = ?`,
			[project],
		);
	} else {
		prompts = count("SELECT COUNT(*) AS total FROM user_prompts");
		artifacts = count("SELECT COUNT(*) AS total FROM artifacts");
		memories = count("SELECT COUNT(*) AS total FROM memory_items");
		observations = count(
			"SELECT COUNT(*) AS total FROM memory_items WHERE kind != 'session_summary'",
		);
	}

	return c.json({
		total: prompts + artifacts + memories,
		memories,
		artifacts,
		prompts,
		observations,
	});
});

app.get("/api/artifacts", (c) => {
	const store = c.get("store") as MemoryStore;
	const sessionId = c.req.query("session_id");
	if (!sessionId) {
		return c.json({ error: "session_id required" }, 400);
	}
	const sid = Number.parseInt(sessionId, 10);
	if (Number.isNaN(sid)) {
		return c.json({ error: "session_id must be int" }, 400);
	}

	// TODO: Port sessionArtifacts() to TS store
	// Python source: codemem/viewer_routes/memory.py lines 322-330
	const rows = store.db
		.prepare("SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC")
		.all(sid) as Array<Record<string, unknown>>;

	return c.json({ items: rows });
});

app.get("/api/pack", (c) => {
	const store = c.get("store") as MemoryStore;
	const context = c.req.query("context") ?? "";
	if (!context) {
		return c.json({ error: "context required" }, 400);
	}

	const limitRaw = c.req.query("limit");
	const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
	if (limitRaw && (limit == null || Number.isNaN(limit))) {
		return c.json({ error: "limit must be int" }, 400);
	}

	const tokenBudgetRaw = c.req.query("token_budget");
	let tokenBudget: number | null = null;
	if (tokenBudgetRaw && tokenBudgetRaw !== "") {
		tokenBudget = Number.parseInt(tokenBudgetRaw, 10);
		if (Number.isNaN(tokenBudget)) {
			return c.json({ error: "token_budget must be int" }, 400);
		}
	}

	const project = c.req.query("project") ?? null;
	const scope = c.req.query("scope") ?? "all";
	const baseFilters: MemoryFilters | undefined = project ? { project } : undefined;
	const { filters, valid } = applyScopeFilter(store, baseFilters, scope);
	if (!valid) return c.json({ error: "invalid_scope" }, 400);

	const pack = store.buildMemoryPack(context, limit, tokenBudget, filters);
	return c.json(pack);
});

// ---------------------------------------------------------------------------
// POST routes
// ---------------------------------------------------------------------------

app.post("/api/memories/visibility", async (c) => {
	const store = c.get("store") as MemoryStore;
	let payload: Record<string, unknown>;
	try {
		payload = await c.req.json();
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}

	const memoryId = payload.memory_id;
	const visibility = payload.visibility;

	if (memoryId == null || typeof memoryId !== "number") {
		return c.json({ error: "memory_id must be int" }, 400);
	}
	if (typeof visibility !== "string" || !["private", "shared"].includes(visibility.trim())) {
		return c.json({ error: "visibility must be private or shared" }, 400);
	}

	try {
		const item = store.updateMemoryVisibility(memoryId, visibility.trim());
		const enriched = item as MemoryWithSessionFields;
		enriched.owned_by_self =
			!enriched.origin_device_id || enriched.origin_device_id === store.deviceId;
		return c.json({ item: enriched });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg === "memory not found") {
			return c.json({ error: "memory not found" }, 404);
		}
		if (msg.includes("not owned")) {
			return c.json({ error: "memory not owned by self" }, 403);
		}
		return c.json({ error: msg }, 400);
	}
});

export default app;
