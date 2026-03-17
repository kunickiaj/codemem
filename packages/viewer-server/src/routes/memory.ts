/**
 * Memory routes — observations, summaries, sessions, projects, pack, artifacts.
 *
 * Ports Python's viewer_routes/memory.py.
 */

import type { MemoryStore } from "@codemem/core";
import { fromJson, parseStrictInteger } from "@codemem/core";
import { Hono } from "hono";
import { queryInt } from "../helpers.js";

type StoreFactory = () => MemoryStore;

/**
 * Attach session project/cwd fields to memory items.
 * Mirrors Python's _attach_session_fields().
 */
function attachSessionFields(store: MemoryStore, items: Record<string, unknown>[]): void {
	const sessionIds: number[] = [];
	const seen = new Set<number>();
	for (const item of items) {
		const value = item.session_id;
		if (value == null) continue;
		const sid = Number(value);
		if (Number.isNaN(sid) || seen.has(sid)) continue;
		seen.add(sid);
		sessionIds.push(sid);
	}
	if (sessionIds.length === 0) return;

	const placeholders = sessionIds.map(() => "?").join(", ");
	const rows = store.db
		.prepare(`SELECT id, project, cwd FROM sessions WHERE id IN (${placeholders})`)
		.all(...sessionIds) as Record<string, unknown>[];

	const bySession = new Map<number, { project: string; cwd: string }>();
	for (const row of rows) {
		const sid = Number(row.id);
		const projectRaw = String(row.project ?? "").trim();
		const project = projectRaw ? projectBasename(projectRaw) : "";
		const cwd = String(row.cwd ?? "");
		bySession.set(sid, { project, cwd });
	}

	for (const item of items) {
		const sid = Number(item.session_id);
		if (Number.isNaN(sid)) continue;
		const fields = bySession.get(sid);
		if (!fields) continue;
		item.project ??= fields.project;
		item.cwd ??= fields.cwd;
	}
}

/**
 * Extract the basename of a project path.
 * Strips "fatal:" prefixed values.
 */
function projectBasename(raw: string): string {
	if (raw.toLowerCase().startsWith("fatal:")) return "";
	const parts = raw.replace(/\\/g, "/").split("/");
	return parts[parts.length - 1] ?? raw;
}

export function memoryRoutes(getStore: StoreFactory) {
	const app = new Hono();

	// GET /api/sessions
	app.get("/api/sessions", (c) => {
		const store = getStore();
		{
			const limit = queryInt(c.req.query("limit"), 20);
			const rows = store.db
				.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
				.all(limit) as Record<string, unknown>[];
			const items = rows.map((row) => ({
				...row,
				metadata_json: fromJson(row.metadata_json as string | null),
			}));
			return c.json({ items });
		}
	});

	// GET /api/projects
	app.get("/api/projects", (c) => {
		const store = getStore();
		{
			const rows = store.db
				.prepare("SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL")
				.all() as Record<string, unknown>[];
			const projects = [
				...new Set(
					rows
						.map((r) => String(r.project ?? "").trim())
						.filter((p) => p && !p.toLowerCase().startsWith("fatal:"))
						.map((p) => projectBasename(p))
						.filter(Boolean),
				),
			].sort();
			return c.json({ projects });
		}
	});

	// GET /api/observations (aliased from /api/memories)
	app.get("/api/memories", (c) => c.redirect("/api/observations", 301));

	app.get("/api/observations", (c) => {
		const store = getStore();
		{
			const limit = Math.max(1, queryInt(c.req.query("limit"), 20));
			const offset = Math.max(0, queryInt(c.req.query("offset"), 0));
			const project = c.req.query("project") || undefined;
			const kinds = [
				"bugfix",
				"change",
				"decision",
				"discovery",
				"exploration",
				"feature",
				"refactor",
			];
			const filters: Record<string, unknown> = {};
			if (project) filters.project = project;

			const items = store.recentByKinds(kinds, limit + 1, filters, offset);
			const hasMore = items.length > limit;
			const result = hasMore ? items.slice(0, limit) : items;
			const asRecords = result as unknown as Record<string, unknown>[];
			attachSessionFields(store, asRecords);
			return c.json({
				items: asRecords,
				pagination: {
					limit,
					offset,
					next_offset: hasMore ? offset + result.length : null,
					has_more: hasMore,
				},
			});
		}
	});

	// GET /api/summaries
	app.get("/api/summaries", (c) => {
		const store = getStore();
		{
			const limit = Math.max(1, queryInt(c.req.query("limit"), 50));
			const offset = Math.max(0, queryInt(c.req.query("offset"), 0));
			const project = c.req.query("project") || undefined;
			const filters: Record<string, unknown> = { kind: "session_summary" };
			if (project) filters.project = project;

			const items = store.recent(limit + 1, filters, offset);
			const hasMore = items.length > limit;
			const result = hasMore ? items.slice(0, limit) : items;
			const asRecords = result as unknown as Record<string, unknown>[];
			attachSessionFields(store, asRecords);
			return c.json({
				items: asRecords,
				pagination: {
					limit,
					offset,
					next_offset: hasMore ? offset + result.length : null,
					has_more: hasMore,
				},
			});
		}
	});

	// GET /api/session (aggregate counts)
	app.get("/api/session", (c) => {
		const store = getStore();
		{
			const project = c.req.query("project") || null;
			const count = (sql: string, ...params: unknown[]): number => {
				const row = store.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
				return Number(row?.total ?? 0);
			};

			let prompts: number;
			let artifacts: number;
			let memories: number;
			let observations: number;
			if (project) {
				prompts = count("SELECT COUNT(*) AS total FROM user_prompts WHERE project = ?", project);
				artifacts = count(
					`SELECT COUNT(*) AS total FROM artifacts
					 JOIN sessions ON sessions.id = artifacts.session_id
					 WHERE sessions.project = ?`,
					project,
				);
				memories = count(
					`SELECT COUNT(*) AS total FROM memory_items
					 JOIN sessions ON sessions.id = memory_items.session_id
					 WHERE sessions.project = ?`,
					project,
				);
				observations = count(
					`SELECT COUNT(*) AS total FROM memory_items
					 JOIN sessions ON sessions.id = memory_items.session_id
					 WHERE kind != 'session_summary' AND sessions.project = ?`,
					project,
				);
			} else {
				prompts = count("SELECT COUNT(*) AS total FROM user_prompts");
				artifacts = count("SELECT COUNT(*) AS total FROM artifacts");
				memories = count("SELECT COUNT(*) AS total FROM memory_items");
				observations = count(
					"SELECT COUNT(*) AS total FROM memory_items WHERE kind != 'session_summary'",
				);
			}
			const total = prompts + artifacts + memories;
			return c.json({ total, memories, artifacts, prompts, observations });
		}
	});

	// GET /api/pack
	app.get("/api/pack", (c) => {
		const store = getStore();
		{
			const context = c.req.query("context") || "";
			if (!context) {
				return c.json({ error: "context required" }, 400);
			}
			const limit = queryInt(c.req.query("limit"), 10);
			const tokenBudgetStr = c.req.query("token_budget");
			let tokenBudget: number | undefined;
			if (tokenBudgetStr) {
				tokenBudget = parseStrictInteger(tokenBudgetStr) ?? undefined;
				if (tokenBudget === undefined) {
					return c.json({ error: "token_budget must be int" }, 400);
				}
			}
			const project = c.req.query("project") || undefined;
			const filters: Record<string, unknown> = {};
			if (project) filters.project = project;
			const pack = store.buildMemoryPack(context, limit, tokenBudget ?? null, filters);
			return c.json(pack);
		}
	});

	// GET /api/memory
	app.get("/api/memory", (c) => {
		const store = getStore();
		{
			const limit = queryInt(c.req.query("limit"), 20);
			const kind = c.req.query("kind") || undefined;
			const project = c.req.query("project") || undefined;
			const filters: Record<string, unknown> = {};
			if (kind) filters.kind = kind;
			if (project) filters.project = project;
			const items = store.recent(limit, filters);
			const asRecords = items as unknown as Record<string, unknown>[];
			attachSessionFields(store, asRecords);
			return c.json({ items: asRecords });
		}
	});

	// GET /api/artifacts
	app.get("/api/artifacts", (c) => {
		const store = getStore();
		{
			const sessionIdStr = c.req.query("session_id");
			if (!sessionIdStr) {
				return c.json({ error: "session_id required" }, 400);
			}
			const sessionId = parseStrictInteger(sessionIdStr);
			if (sessionId == null) {
				return c.json({ error: "session_id must be int" }, 400);
			}
			const rows = store.db
				.prepare("SELECT * FROM artifacts WHERE session_id = ?")
				.all(sessionId) as Record<string, unknown>[];
			return c.json({ items: rows });
		}
	});

	// POST /api/memories/visibility
	app.post("/api/memories/visibility", async (c) => {
		const store = getStore();
		const body = await c.req.json<Record<string, unknown>>();
		const memoryId = parseStrictInteger(
			typeof body.memory_id === "string" ? body.memory_id : String(body.memory_id ?? ""),
		);
		if (memoryId == null || memoryId <= 0) {
			return c.json({ error: "memory_id must be int" }, 400);
		}
		const visibility = String(body.visibility ?? "").trim();
		if (visibility !== "private" && visibility !== "shared") {
			return c.json({ error: "visibility must be private or shared" }, 400);
		}
		try {
			const item = store.updateMemoryVisibility(memoryId, visibility);
			return c.json({ item });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("not found")) return c.json({ error: msg }, 404);
			if (msg.includes("not owned")) return c.json({ error: msg }, 403);
			return c.json({ error: msg }, 400);
		}
	});

	return app;
}
