/**
 * Memory routes — observations, summaries, sessions, projects, pack, artifacts.
 */

import type { MemoryFilters, MemoryStore } from "@codemem/core";
import {
	buildFilterClausesWithContext,
	canonicalMemoryKind,
	fromJson,
	isSummaryLikeMemory as isCoreSummaryLikeMemory,
	parseStrictInteger,
	schema,
} from "@codemem/core";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { queryInt } from "../helpers.js";

type StoreFactory = () => MemoryStore;

type OwnershipContext = {
	actorId: string;
	claimedPeerIds: Set<string>;
	deviceId: string;
	legacyActorIds: Set<string>;
};

function cleanOwnershipValue(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function buildOwnershipContext(store: MemoryStore): OwnershipContext {
	const claimedPeerIds = new Set(store.sameActorPeerIds());
	return {
		actorId: store.actorId,
		claimedPeerIds,
		deviceId: store.deviceId,
		legacyActorIds: new Set(Array.from(claimedPeerIds, (peerId) => `legacy-sync:${peerId}`)),
	};
}

function memoryOwnedBySelf(
	row: Record<string, unknown>,
	ownership: OwnershipContext,
	metadata = fromJson((row.metadata_json as string) ?? null),
): boolean {
	const meta = metadata as Record<string, unknown>;
	const actorId = cleanOwnershipValue(row.actor_id) ?? cleanOwnershipValue(meta.actor_id);
	if (actorId === ownership.actorId) return true;

	const deviceId =
		cleanOwnershipValue(row.origin_device_id) ?? cleanOwnershipValue(meta.origin_device_id);
	if (deviceId === ownership.deviceId) return true;
	if (deviceId && ownership.claimedPeerIds.has(deviceId)) return true;
	if (actorId && ownership.legacyActorIds.has(actorId)) return true;

	return false;
}

function serializeMemoryRow(
	ownership: OwnershipContext,
	row: Record<string, unknown>,
): Record<string, unknown> {
	const metadata = fromJson((row.metadata_json as string) ?? null);
	const item = {
		...row,
		kind: canonicalMemoryKind((row.kind as string | null | undefined) ?? null, row.metadata_json),
		metadata_json: metadata,
	};
	return {
		...item,
		owned_by_self: memoryOwnedBySelf(row, ownership, metadata),
	};
}

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

function buildViewerMemoryFilters(store: MemoryStore, filters?: MemoryFilters | null) {
	return buildFilterClausesWithContext(filters, {
		actorId: store.actorId,
		deviceId: store.deviceId,
		enforceScopeVisibility: true,
	});
}

function countVisibleMemoryRows(store: MemoryStore, filters?: MemoryFilters | null): number {
	const filterResult = buildViewerMemoryFilters(store, filters);
	const clauses = ["memory_items.active = 1", ...filterResult.clauses];
	const from = filterResult.joinSessions
		? "memory_items JOIN sessions ON sessions.id = memory_items.session_id"
		: "memory_items";
	const row = store.db
		.prepare(`SELECT COUNT(*) AS total FROM ${from} WHERE ${clauses.join(" AND ")}`)
		.get(...filterResult.params) as Record<string, unknown> | undefined;
	return Number(row?.total ?? 0);
}

function sessionAllowsArtifactAccess(store: MemoryStore, sessionId: number): boolean {
	const visibleCount = countVisibleMemoryRows(store, { session_id: sessionId });
	if (visibleCount === 0) return false;
	const row = store.db
		.prepare(
			`SELECT COUNT(*) AS total FROM memory_items
			 WHERE session_id = ? AND active = 1`,
		)
		.get(sessionId) as Record<string, unknown> | undefined;
	return visibleCount === Number(row?.total ?? 0);
}

function countVisiblePromptRows(store: MemoryStore, project?: string | null): number {
	const filterResult = buildViewerMemoryFilters(store, null);
	const clauses = [
		"user_prompts.session_id IS NOT NULL",
		`EXISTS (
			SELECT 1 FROM memory_items
			WHERE memory_items.session_id = user_prompts.session_id
			  AND memory_items.active = 1
			  AND ${filterResult.clauses.join(" AND ")}
		)`,
	];
	const params: unknown[] = [...filterResult.params];
	if (project) {
		clauses.unshift("user_prompts.project = ?");
		params.unshift(project);
	}
	const row = store.db
		.prepare(`SELECT COUNT(*) AS total FROM user_prompts WHERE ${clauses.join(" AND ")}`)
		.get(...params) as Record<string, unknown> | undefined;
	return Number(row?.total ?? 0);
}

function countVisibleArtifactRows(store: MemoryStore, project?: string | null): number {
	const filterResult = buildViewerMemoryFilters(store, null);
	const clauses = [
		`EXISTS (
			SELECT 1 FROM memory_items
			WHERE memory_items.session_id = artifacts.session_id
			  AND memory_items.active = 1
			  AND ${filterResult.clauses.join(" AND ")}
		)`,
	];
	const params: unknown[] = [...filterResult.params];
	const from = project
		? "artifacts JOIN sessions ON sessions.id = artifacts.session_id"
		: "artifacts";
	if (project) {
		clauses.unshift("sessions.project = ?");
		params.unshift(project);
	}
	const row = store.db
		.prepare(`SELECT COUNT(*) AS total FROM ${from} WHERE ${clauses.join(" AND ")}`)
		.get(...params) as Record<string, unknown> | undefined;
	return Number(row?.total ?? 0);
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
	const filters: MemoryFilters = {};
	if (options.project) filters.project = options.project;
	if (options.scope) filters.ownership_scope = options.scope;

	const filterResult = buildViewerMemoryFilters(store, filters);
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

	const ownership = buildOwnershipContext(store);
	return rows.map((row) => serializeMemoryRow(ownership, row));
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
			const filterResult = buildViewerMemoryFilters(store, null);
			const clauses = [
				"memory_items.session_id = sessions.id",
				"memory_items.active = 1",
				...filterResult.clauses,
			];
			const rows = store.db
				.prepare(
					`SELECT sessions.* FROM sessions
					 WHERE EXISTS (SELECT 1 FROM memory_items WHERE ${clauses.join(" AND ")})
					 ORDER BY sessions.started_at DESC
					 LIMIT ?`,
				)
				.all(...filterResult.params, limit) as Record<string, unknown>[];
			const items = rows.map((row) => ({
				...row,
				metadata_json: fromJson((row.metadata_json as string | null | undefined) ?? null),
			}));
			return c.json({ items });
		}
	});

	// GET /api/projects
	app.get("/api/projects", (c) => {
		const store = getStore();
		{
			const filterResult = buildViewerMemoryFilters(store, null);
			const clauses = [
				"memory_items.session_id = sessions.id",
				"memory_items.active = 1",
				"sessions.project IS NOT NULL",
				...filterResult.clauses,
			];
			const rows = store.db
				.prepare(
					`SELECT DISTINCT sessions.project AS project FROM sessions
					 JOIN memory_items ON memory_items.session_id = sessions.id
					 WHERE ${clauses.join(" AND ")}`,
				)
				.all(...filterResult.params) as Record<string, unknown>[];
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
				prompts = countVisiblePromptRows(store, project);
				artifacts = countVisibleArtifactRows(store, project);
				memories = countVisibleMemoryRows(store, { project });
				observations = countObservations(project);
			} else {
				prompts = countVisiblePromptRows(store);
				artifacts = countVisibleArtifactRows(store);
				memories = countVisibleMemoryRows(store);
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

	app.post("/api/pack/trace", async (c) => {
		const store = getStore();
		const parsed = await c.req.json().catch(() => Symbol.for("invalid-json"));
		if (parsed === Symbol.for("invalid-json")) {
			return c.json({ error: "invalid json body" }, 400);
		}
		const body = parsed as {
			context?: unknown;
			limit?: unknown;
			token_budget?: unknown;
			project?: unknown;
			working_set_files?: unknown;
		} | null;
		const context = typeof body?.context === "string" ? body.context.trim() : "";
		if (!context) {
			return c.json({ error: "context required" }, 400);
		}
		const limit =
			body?.limit == null
				? 10
				: typeof body.limit === "number" && Number.isInteger(body.limit) && body.limit >= 1
					? body.limit
					: null;
		if (limit == null) {
			return c.json({ error: "limit must be a positive int" }, 400);
		}
		let tokenBudget: number | null = null;
		if (body?.token_budget != null) {
			if (
				typeof body.token_budget !== "number" ||
				!Number.isInteger(body.token_budget) ||
				body.token_budget < 0
			) {
				return c.json({ error: "token_budget must be int" }, 400);
			}
			tokenBudget = body.token_budget;
		}
		const project = typeof body?.project === "string" && body.project.trim() ? body.project : null;
		if (body?.working_set_files != null && !Array.isArray(body.working_set_files)) {
			return c.json({ error: "working_set_files must be an array of strings" }, 400);
		}
		if (
			Array.isArray(body?.working_set_files) &&
			body.working_set_files.some((value) => typeof value !== "string")
		) {
			return c.json({ error: "working_set_files must be an array of strings" }, 400);
		}
		const workingSetFiles = Array.isArray(body?.working_set_files) ? body.working_set_files : [];
		const filters: { project?: string; working_set_paths?: string[] } = {};
		if (project) filters.project = project;
		if (workingSetFiles.length > 0) filters.working_set_paths = workingSetFiles;
		const trace = await store.buildMemoryPackTraceAsync(context, limit, tokenBudget, filters);
		return c.json(trace);
	});

	// GET /api/memory
	app.get("/api/memory", (c) => {
		const store = getStore();
		{
			const limit = queryInt(c.req.query("limit"), 20);
			const kind = c.req.query("kind") || undefined;
			const project = c.req.query("project") || undefined;
			const filters: MemoryFilters = {};
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
			if (!sessionAllowsArtifactAccess(store, sessionId)) {
				return c.json({ error: "session not found" }, 404);
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
		if (!store.get(memoryId)) {
			return c.json({ error: "memory not found" }, 404);
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

	// POST /api/memories/project
	app.post("/api/memories/project", async (c) => {
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
		const project = String(body.project ?? "").trim();
		if (!project) {
			return c.json({ error: "project must be a non-empty string" }, 400);
		}
		if (!store.get(memoryId)) {
			return c.json({ error: "memory not found" }, 404);
		}
		try {
			const result = store.moveMemoryProject(memoryId, project);
			return c.json(result);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("not found")) return c.json({ error: msg }, 404);
			if (msg.includes("not owned")) return c.json({ error: msg }, 403);
			return c.json({ error: msg }, 400);
		}
	});

	// POST /api/memories/forget
	app.post("/api/memories/forget", async (c) => {
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
		if (!store.get(memoryId)) {
			return c.json({ error: "memory not found" }, 404);
		}

		const row = drizzle(store.db, { schema })
			.select()
			.from(schema.memoryItems)
			.where(eq(schema.memoryItems.id, memoryId))
			.get();
		if (!row) {
			return c.json({ error: "memory not found" }, 404);
		}
		const ownership = buildOwnershipContext(store);
		if (!memoryOwnedBySelf(row, ownership)) {
			return c.json({ error: "memory not owned by this device" }, 403);
		}
		if (Number(row.active ?? 1) === 0 || row.deleted_at != null) {
			return c.json({ status: "ok" });
		}

		try {
			store.forget(memoryId);
			return c.json({ status: "ok" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("not found")) return c.json({ error: msg }, 404);
			if (msg.includes("not owned")) return c.json({ error: msg }, 403);
			if (msg.includes("sync_rebootstrap_in_progress")) return c.json({ error: msg }, 409);
			return c.json({ error: msg }, 400);
		}
	});

	return app;
}
