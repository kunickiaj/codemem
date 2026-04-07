/**
 * Memory routes — observations, summaries, sessions, projects, pack, artifacts.
 */

import type { MemoryStore } from "@codemem/core";
import {
	buildFilterClausesWithContext,
	canonicalMemoryKind,
	fromJson,
	isSummaryLikeMemory as isCoreSummaryLikeMemory,
	parseStrictInteger,
	schema,
} from "@codemem/core";
import { desc, eq, inArray, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { queryInt } from "../helpers.js";

type StoreFactory = () => MemoryStore;

/**
 * Attach session project/cwd fields to memory items.
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

	const d = drizzle(store.db, { schema });
	const rows = d
		.select({
			id: schema.sessions.id,
			project: schema.sessions.project,
			cwd: schema.sessions.cwd,
		})
		.from(schema.sessions)
		.where(inArray(schema.sessions.id, sessionIds))
		.all();

	const bySession = new Map<number, { project: string; cwd: string }>();
	for (const row of rows) {
		const projectRaw = String(row.project ?? "").trim();
		const project = projectRaw ? projectBasename(projectRaw) : "";
		const cwd = String(row.cwd ?? "");
		bySession.set(row.id, { project, cwd });
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

function normalizeScope(raw: string | undefined): "mine" | "theirs" | undefined {
	const value = String(raw ?? "")
		.trim()
		.toLowerCase();
	if (value === "mine" || value === "theirs") return value;
	return undefined;
}

function queryMemoryPage(
	store: MemoryStore,
	options: {
		limit: number;
		offset: number;
		project?: string;
		scope?: "mine" | "theirs";
	},
): Record<string, unknown>[] {
	const filters: Record<string, unknown> = {};
	if (options.project) filters.project = options.project;
	if (options.scope) filters.ownership_scope = options.scope;

	const filterResult = buildFilterClausesWithContext(filters, {
		actorId: store.actorId,
		deviceId: store.deviceId,
	});
	const clauses = ["memory_items.active = 1", ...filterResult.clauses];
	const where = clauses.join(" AND ");
	const from = filterResult.joinSessions
		? "memory_items JOIN sessions ON sessions.id = memory_items.session_id"
		: "memory_items";

	const rows = store.db
		.prepare(
			`SELECT memory_items.* FROM ${from}
			 WHERE ${where}
			 ORDER BY memory_items.created_at DESC
			 LIMIT ? OFFSET ?`,
		)
		.all(...filterResult.params, options.limit + 1, options.offset) as Record<string, unknown>[];

	return rows.map((row) => ({
		...row,
		kind: canonicalMemoryKind((row.kind as string | null | undefined) ?? null, row.metadata_json),
		metadata_json: fromJson((row.metadata_json as string) ?? null),
	}));
}

function isSummaryLikeMemory(item: Record<string, unknown>): boolean {
	return isCoreSummaryLikeMemory({
		kind: item.kind as string | null | undefined,
		metadata: item.metadata_json,
	});
}

function selectMemoryPage(
	store: MemoryStore,
	options: {
		limit: number;
		offset: number;
		project?: string;
		scope?: "mine" | "theirs";
		matcher: (item: Record<string, unknown>) => boolean;
	},
): Record<string, unknown>[] {
	const pageSize = Math.max(options.limit + options.offset + 10, 50);
	let rawOffset = 0;
	const matched: Record<string, unknown>[] = [];

	while (matched.length < options.offset + options.limit + 1) {
		const page = queryMemoryPage(store, {
			limit: pageSize,
			offset: rawOffset,
			project: options.project,
			scope: options.scope,
		});
		if (page.length === 0) break;
		matched.push(...page.filter(options.matcher));
		if (page.length < pageSize) break;
		rawOffset += page.length;
	}

	return matched.slice(options.offset, options.offset + options.limit + 1);
}

export function memoryRoutes(getStore: StoreFactory) {
	const app = new Hono();

	// GET /api/sessions
	app.get("/api/sessions", (c) => {
		const store = getStore();
		{
			const limit = queryInt(c.req.query("limit"), 20);
			const d = drizzle(store.db, { schema });
			const rows = d
				.select()
				.from(schema.sessions)
				.orderBy(desc(schema.sessions.started_at))
				.limit(limit)
				.all();
			const items = rows.map((row) => ({
				...row,
				metadata_json: fromJson(row.metadata_json),
			}));
			return c.json({ items });
		}
	});

	// GET /api/projects
	app.get("/api/projects", (c) => {
		const store = getStore();
		{
			const d = drizzle(store.db, { schema });
			const rows = d
				.selectDistinct({ project: schema.sessions.project })
				.from(schema.sessions)
				.where(isNotNull(schema.sessions.project))
				.all();
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
	app.get("/api/memories", (c) => {
		const search = new URL(c.req.url).search;
		return c.redirect(`/api/observations${search}`, 301);
	});

	app.get("/api/observations", (c) => {
		const store = getStore();
		{
			const limit = Math.max(1, queryInt(c.req.query("limit"), 20));
			const offset = Math.max(0, queryInt(c.req.query("offset"), 0));
			const project = c.req.query("project") || undefined;
			const scope = normalizeScope(c.req.query("scope"));
			const items = selectMemoryPage(store, {
				limit,
				offset,
				project,
				scope,
				matcher: (item) => !isSummaryLikeMemory(item),
			});
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
			const scope = normalizeScope(c.req.query("scope"));
			const items = selectMemoryPage(store, {
				limit,
				offset,
				project,
				scope,
				matcher: (item) => isSummaryLikeMemory(item),
			});
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
			const countObservations = (scopeProject?: string) => {
				let offset = 0;
				let total = 0;
				while (true) {
					const page = queryMemoryPage(store, {
						limit: 200,
						offset,
						project: scopeProject,
					});
					if (page.length === 0) break;
					total += page.filter((item) => !isSummaryLikeMemory(item)).length;
					if (page.length < 200) break;
					offset += page.length;
				}
				return total;
			};
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
				observations = countObservations(project);
			} else {
				prompts = count("SELECT COUNT(*) AS total FROM user_prompts");
				artifacts = count("SELECT COUNT(*) AS total FROM artifacts");
				memories = count("SELECT COUNT(*) AS total FROM memory_items");
				observations = countObservations();
			}
			const total = prompts + artifacts + memories;
			return c.json({ total, memories, artifacts, prompts, observations });
		}
	});

	// GET /api/pack
	app.get("/api/pack", async (c) => {
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
			const filters: { project?: string } = {};
			if (project) filters.project = project;
			const pack = await store.buildMemoryPackAsync(context, limit, tokenBudget ?? null, filters);
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
			const d = drizzle(store.db, { schema });
			const rows = d
				.select()
				.from(schema.artifacts)
				.where(eq(schema.artifacts.session_id, sessionId))
				.all();
			return c.json({ items: rows });
		}
	});

	// POST /api/memories/visibility
	app.post("/api/memories/visibility", async (c) => {
		const store = getStore();
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid JSON" }, 400);
		}
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
