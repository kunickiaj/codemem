/**
 * Memory tool-support routes — HTTP twins of MCP tools that the viewer
 * previously lacked (remember, timeline, expand, schema, search_index,
 * explain, distill_candidates). Used by thin clients (pi extension, CLI)
 * that prefer HTTP over opening the store in-process.
 *
 * Behavioral contracts mirror packages/mcp-server/src/tools/* against the
 * same @codemem/core MemoryStore APIs. No dependency on @codemem/mcp.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	DistillContextDocument,
	MemoryFilters,
	MemoryItemResponse,
	MemoryResult,
	MemoryStore,
} from "@codemem/core";
import {
	buildDistillReport,
	dedupeOrderedIds,
	judgeDistillReport,
	ObserverClient,
	parseStrictInteger,
	projectMatchesFilter,
	resolveProject,
	resolveProjectRoot,
	storeVectors,
	toJson,
} from "@codemem/core";
import { Hono } from "hono";
import { queryInt } from "../helpers.js";

type StoreFactory = () => MemoryStore;

/** Same kind catalog the MCP memory_schema tool exposes. */
const MEMORY_KINDS: Record<string, string> = {
	discovery: "Something learned about the codebase, architecture, or tools",
	change: "A code change that was made",
	feature: "A new feature that was implemented",
	bugfix: "A bug that was found and fixed",
	refactor: "Code that was refactored or restructured",
	decision: "A design or architecture decision",
	exploration: "An experiment or investigation (may not have shipped)",
};

const ALLOWED_REMEMBER_KINDS = new Set(Object.keys(MEMORY_KINDS));

/** Filter names exposed by memory_schema (sorted, matches MCP filterSchema keys). */
const SCHEMA_FILTER_NAMES = [
	"exclude_actor_ids",
	"exclude_scope_ids",
	"exclude_trust_states",
	"exclude_visibility",
	"exclude_workspace_ids",
	"exclude_workspace_kinds",
	"include_actor_ids",
	"include_scope_ids",
	"include_trust_states",
	"include_visibility",
	"include_workspace_ids",
	"include_workspace_kinds",
	"kind",
	"ownership_scope",
	"personal_first",
	"project",
	"scope_id",
	"trust_bias",
	"visibility",
	"widen_shared_min_personal_results",
	"widen_shared_min_personal_score",
	"widen_shared_when_weak",
].toSorted();

const SCHEMA_FIELDS = {
	title: "short text",
	body: "long text",
	subtitle: "short text",
	facts: "list<string>",
	narrative: "long text",
	concepts: "list<string>",
	files_read: "list<string>",
	files_modified: "list<string>",
	prompt_number: "int",
};

function cleanProject(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function resolveWriteProject(input: {
	project?: string | null;
	envProject?: string | null;
}): string | null {
	return cleanProject(input.project) ?? cleanProject(input.envProject) ?? null;
}

/**
 * Build MemoryFilters from a raw args object (query or body).
 *
 * Project scoping matches existing viewer routes (pack/memory/forget): only an
 * explicit `project` arg applies. Unlike MCP tools, the viewer does not inject
 * cwd/CODEMEM_PROJECT as an implicit default — the server process cwd is not a
 * reliable client project signal. Callers (pi extension, CLI) pass project when
 * they want scope.
 */
function buildFilters(
	raw: Record<string, unknown>,
	defaultProject: string | null = null,
): MemoryFilters | undefined {
	const filters: MemoryFilters = {};
	let hasAny = false;

	const explicitProject = typeof raw.project === "string" ? cleanProject(raw.project) : undefined;
	// Only fall back to defaultProject when the caller omitted `project` entirely
	// (expand uses defaultProject=null for blank-string clear; see expand route).
	const resolvedProject =
		explicitProject !== undefined
			? explicitProject || undefined
			: cleanProject(defaultProject) || undefined;
	if (resolvedProject) {
		filters.project = resolvedProject;
		hasAny = true;
	}

	for (const key of [
		"kind",
		"visibility",
		"scope_id",
		"include_scope_ids",
		"exclude_scope_ids",
		"include_visibility",
		"exclude_visibility",
		"include_workspace_ids",
		"exclude_workspace_ids",
		"include_workspace_kinds",
		"exclude_workspace_kinds",
		"include_actor_ids",
		"exclude_actor_ids",
		"include_trust_states",
		"exclude_trust_states",
		"ownership_scope",
		"personal_first",
		"trust_bias",
		"widen_shared_when_weak",
		"widen_shared_min_personal_results",
		"widen_shared_min_personal_score",
	] as const) {
		const val = raw[key];
		if (val !== undefined && val !== null) {
			(filters as Record<string, unknown>)[key] = val;
			hasAny = true;
		}
	}

	return hasAny ? filters : undefined;
}

/**
 * Parse MemoryFilters from a GET query string.
 *
 * Full filter surface (arrays / booleans / numbers matching MCP filterSchema)
 * is accepted via a single JSON-encoded `filters` query param so GET stays
 * ergonomic without multi-value keys. Top-level `project` and `kind` remain
 * as convenience aliases for existing callers and override the same keys in
 * the JSON object when both are present.
 *
 * Example:
 *   /api/memories/search_index?query=foo&filters={"include_visibility":["private"]}
 */
function parseGetFilters(
	queryGetter: (name: string) => string | undefined,
): { ok: true; filters: MemoryFilters | undefined } | { ok: false; error: string } {
	const filterRaw: Record<string, unknown> = {};

	const filtersParam = queryGetter("filters");
	if (filtersParam != null && filtersParam.trim() !== "") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(filtersParam);
		} catch {
			return { ok: false, error: "filters must be valid JSON" };
		}
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ok: false, error: "filters must be a JSON object" };
		}
		Object.assign(filterRaw, parsed as Record<string, unknown>);
	}

	// Top-level convenience aliases (backward compatible with project+kind only).
	const project = queryGetter("project");
	const kind = queryGetter("kind");
	if (project != null) filterRaw.project = project;
	if (kind != null) filterRaw.kind = kind;

	return { ok: true, filters: buildFilters(filterRaw) };
}

function getMemoryForAccess(
	store: MemoryStore,
	memoryId: number,
	filters?: MemoryFilters,
): MemoryItemResponse | null {
	const rows = store.timeline(null, memoryId, 0, 0, filters ?? null);
	return rows.find((row) => row.id === memoryId) ?? null;
}

function getManyForAccess(
	store: MemoryStore,
	ids: number[],
	filters?: MemoryFilters,
): MemoryItemResponse[] {
	if (ids.length === 0) return [];
	const results: MemoryItemResponse[] = [];
	for (const id of ids) {
		const item = getMemoryForAccess(store, id, filters);
		if (item) results.push(item);
	}
	return results;
}

function clampInt(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function parseOptionalInt(value: unknown): number | null {
	if (value == null) return null;
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "string") return parseStrictInteger(value);
	return null;
}

function parseJsonBody(
	body: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
	if (body == null || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "payload must be an object" };
	}
	return { ok: true, value: body as Record<string, unknown> };
}

function rememberMemory(
	store: MemoryStore,
	input: {
		kind: string;
		title: string;
		body: string;
		confidence: number;
		project?: string | null;
	},
): { memId: number; title: string; body: string } {
	return store.db.transaction(() => {
		const now = new Date().toISOString();
		const user = process.env.USER ?? "unknown";
		const cwd = process.cwd();
		const project = resolveWriteProject({
			project: input.project,
			envProject: process.env.CODEMEM_PROJECT,
		});

		const sessionInfo = store.db
			.prepare(
				`INSERT INTO sessions(started_at, ended_at, cwd, project, user, tool_version, metadata_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(now, now, cwd, project, user, "viewer-api", toJson({ viewer: true }));
		const sessionId = Number(sessionInfo.lastInsertRowid);

		const memId = store.remember(sessionId, input.kind, input.title, input.body, input.confidence);
		if (!getMemoryForAccess(store, memId)) {
			throw new Error("unauthorized_scope");
		}

		store.db
			.prepare("UPDATE sessions SET ended_at = ?, metadata_json = ? WHERE id = ?")
			.run(new Date().toISOString(), toJson({ viewer: true }), sessionId);

		return { memId, title: input.title, body: input.body };
	})();
}

function readContextFile(
	path: string,
	displayPath: string,
	scope: DistillContextDocument["scope"],
): DistillContextDocument | null {
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	return text.trim() ? { path: displayPath, text, scope } : null;
}

function loadDefaultContextDocuments(
	includeProjectContext: boolean,
	cwd = process.cwd(),
): DistillContextDocument[] {
	const projectRoot = resolveProjectRoot(cwd) ?? cwd;
	const documents = [
		includeProjectContext
			? readContextFile(join(projectRoot, "AGENTS.md"), "AGENTS.md", "project")
			: null,
		readContextFile(
			join(homedir(), ".config", "opencode", "AGENTS.md"),
			"~/.config/opencode/AGENTS.md",
			"user",
		),
	];
	return documents.filter((document): document is DistillContextDocument => document != null);
}

function shouldIncludeProjectContext(
	args: { all_projects?: boolean; project?: unknown },
	defaultProject: string | null,
): boolean {
	if (args.all_projects) return false;
	const currentProject = resolveProject(process.cwd());
	if (!currentProject) return false;
	const explicitProject = typeof args.project === "string" ? args.project.trim() : "";
	const targetProject = explicitProject
		? resolveProject(process.cwd(), explicitProject)
		: defaultProject;
	if (!targetProject) return false;
	return projectMatchesFilter(targetProject, currentProject);
}

function buildDistillFilters(
	args: { all_projects?: boolean } & Record<string, unknown>,
	defaultProject: string | null,
): MemoryFilters | undefined {
	if (args.all_projects && typeof args.project === "string" && args.project.trim()) {
		throw new Error("project cannot be combined with all_projects");
	}
	return buildFilters(args, args.all_projects ? null : defaultProject);
}

function mapSearchIndexItem(m: MemoryResult) {
	return {
		id: m.id,
		kind: m.kind,
		title: m.title,
		score: m.score,
		created_at: m.created_at,
		session_id: m.session_id,
		metadata: m.metadata,
	};
}

function expandMemories(
	store: MemoryStore,
	args: {
		ids: unknown[];
		depth_before: number;
		depth_after: number;
		include_observations: boolean;
		filters?: MemoryFilters;
	},
) {
	const resolvedProject = args.filters?.project ?? null;
	const { ordered: orderedIds, invalid: invalidIds } = dedupeOrderedIds(args.ids);
	const errors: Array<Record<string, unknown>> = [];

	if (invalidIds.length > 0) {
		errors.push({
			code: "INVALID_ARGUMENT",
			field: "ids",
			message: "some ids are not valid integers",
			ids: invalidIds,
		});
	}

	const missingNotFound: number[] = [];
	const missingProjectMismatch: number[] = [];
	const missingFilterMismatch: number[] = [];
	const anchors: MemoryItemResponse[] = [];
	const timelineItems: MemoryItemResponse[] = [];
	const timelineSeen = new Set<number>();
	const sessionProjects = new Map<number, string | null>();

	for (const memoryId of orderedIds) {
		const item = store.get(memoryId);
		if (!item?.active) {
			missingNotFound.push(memoryId);
			continue;
		}

		const sessionId = item.session_id;
		if (resolvedProject && sessionId > 0) {
			if (!sessionProjects.has(sessionId)) {
				const row = store.db
					.prepare("SELECT project FROM sessions WHERE id = ? LIMIT 1")
					.get(sessionId) as { project: string | null } | undefined;
				sessionProjects.set(sessionId, typeof row?.project === "string" ? row.project : null);
			}
			if (!projectMatchesFilter(resolvedProject, sessionProjects.get(sessionId) ?? null)) {
				missingProjectMismatch.push(memoryId);
				continue;
			}
		} else if (resolvedProject && sessionId <= 0) {
			missingProjectMismatch.push(memoryId);
			continue;
		}

		const expanded = store.timeline(
			null,
			memoryId,
			args.depth_before,
			args.depth_after,
			args.filters,
		);
		const anchor = expanded.find((expandedItem) => expandedItem.id === memoryId);
		if (!anchor) {
			missingFilterMismatch.push(memoryId);
			continue;
		}

		anchors.push(anchor);
		for (const expandedItem of expanded) {
			const expandedId = expandedItem.id;
			if (expandedId <= 0 || timelineSeen.has(expandedId)) continue;
			timelineSeen.add(expandedId);
			timelineItems.push(expandedItem);
		}
	}

	if (missingNotFound.length > 0) {
		errors.push({
			code: "NOT_FOUND",
			field: "ids",
			message: "some requested ids were not found",
			ids: missingNotFound,
		});
	}
	if (missingProjectMismatch.length > 0) {
		errors.push({
			code: "PROJECT_MISMATCH",
			field: "project",
			message: "some requested ids are outside the requested project scope",
			ids: missingProjectMismatch,
		});
	}
	if (missingFilterMismatch.length > 0) {
		errors.push({
			code: "FILTER_MISMATCH",
			field: "filters",
			message: "some requested ids are outside the requested filters",
			ids: missingFilterMismatch,
		});
	}

	let observations: MemoryItemResponse[] = [];
	if (args.include_observations) {
		const observationSeen = new Set<number>();
		const observationIds: number[] = [];
		for (const item of [...anchors, ...timelineItems]) {
			if (item.id > 0 && !observationSeen.has(item.id)) {
				observationSeen.add(item.id);
				observationIds.push(item.id);
			}
		}
		observations = getManyForAccess(store, observationIds, args.filters);
	}

	return {
		anchors,
		timeline: timelineItems,
		observations,
		missing_ids: orderedIds.filter(
			(memoryId: number) =>
				missingNotFound.includes(memoryId) ||
				missingProjectMismatch.includes(memoryId) ||
				missingFilterMismatch.includes(memoryId),
		),
		errors,
		metadata: {
			project: resolvedProject,
			requested_ids_count: orderedIds.length,
			returned_anchor_count: anchors.length,
			timeline_count: timelineItems.length,
			include_observations: args.include_observations,
		},
	};
}

export function memoryToolRoutes(getStore: StoreFactory) {
	const app = new Hono();

	// POST /api/memories/remember — twin of memory_remember
	app.post("/api/memories/remember", async (c) => {
		const store = getStore();
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid JSON" }, 400);
		}
		const parsed = parseJsonBody(body);
		if (!parsed.ok) return c.json({ error: parsed.error }, 400);
		const args = parsed.value;

		const kind = typeof args.kind === "string" ? args.kind.trim().toLowerCase() : "";
		if (!kind || !ALLOWED_REMEMBER_KINDS.has(kind)) {
			return c.json(
				{
					error: `kind must be one of: ${[...ALLOWED_REMEMBER_KINDS].join(", ")}`,
				},
				400,
			);
		}
		const title = typeof args.title === "string" ? args.title : "";
		const bodyText = typeof args.body === "string" ? args.body : "";
		if (!title.trim()) return c.json({ error: "title is required" }, 400);
		if (!bodyText.trim()) return c.json({ error: "body is required" }, 400);

		let confidence = 0.5;
		if (args.confidence != null) {
			if (typeof args.confidence !== "number" || Number.isNaN(args.confidence)) {
				return c.json({ error: "confidence must be a number" }, 400);
			}
			confidence = Math.min(1, Math.max(0, args.confidence));
		}
		const project = typeof args.project === "string" ? args.project : undefined;

		try {
			const result = rememberMemory(store, {
				kind,
				title,
				body: bodyText,
				confidence,
				project,
			});
			try {
				await storeVectors(store.db, result.memId, result.title, result.body);
			} catch {
				// Memory writes should succeed even if embeddings are unavailable.
			}
			return c.json({ id: result.memId });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("Invalid memory kind")) return c.json({ error: msg }, 400);
			if (msg === "unauthorized_scope") return c.json({ error: msg }, 403);
			return c.json({ error: msg }, 400);
		}
	});

	// GET /api/memories/timeline — twin of memory_timeline
	// Full filter surface via JSON `filters` query param (MCP filterSchema parity).
	app.get("/api/memories/timeline", (c) => {
		const store = getStore();
		const query = c.req.query("query") || undefined;
		const memoryIdRaw = c.req.query("memory_id");
		const memoryId =
			memoryIdRaw != null && memoryIdRaw !== "" ? parseStrictInteger(memoryIdRaw) : null;
		if (memoryIdRaw != null && memoryIdRaw !== "" && memoryId == null) {
			return c.json({ error: "memory_id must be int" }, 400);
		}
		const depthBefore = clampInt(queryInt(c.req.query("depth_before"), 3), 0, 100);
		const depthAfter = clampInt(queryInt(c.req.query("depth_after"), 3), 0, 100);

		const parsedFilters = parseGetFilters((name) => c.req.query(name));
		if (!parsedFilters.ok) return c.json({ error: parsedFilters.error }, 400);

		const items = store.timeline(
			query ?? null,
			memoryId,
			depthBefore,
			depthAfter,
			parsedFilters.filters,
		);
		return c.json({ items });
	});

	// POST /api/memories/expand — twin of memory_expand
	app.post("/api/memories/expand", async (c) => {
		const store = getStore();
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid JSON" }, 400);
		}
		const parsed = parseJsonBody(body);
		if (!parsed.ok) return c.json({ error: parsed.error }, 400);
		const args = parsed.value;

		if (!Array.isArray(args.ids)) {
			return c.json({ error: "ids must be an array" }, 400);
		}
		if (args.ids.length > 200) {
			return c.json({ error: "ids must contain at most 200 entries" }, 400);
		}

		const depthBeforeRaw = parseOptionalInt(args.depth_before);
		const depthAfterRaw = parseOptionalInt(args.depth_after);
		const depthBefore = clampInt(depthBeforeRaw ?? 3, 0, 100);
		const depthAfter = clampInt(depthAfterRaw ?? 3, 0, 100);
		const includeObservations =
			typeof args.include_observations === "boolean"
				? args.include_observations
				: Boolean(args.include_observations);

		// Explicit blank project clears scoping (MCP expand parity). Viewer routes
		// do not inject a cwd default project; only an explicit non-blank project scopes.
		const filters = buildFilters(args, null);

		const value = expandMemories(store, {
			ids: args.ids,
			depth_before: depthBefore,
			depth_after: depthAfter,
			include_observations: includeObservations,
			filters,
		});
		return c.json(value);
	});

	// GET /api/memories/schema — twin of memory_schema
	app.get("/api/memories/schema", (c) => {
		return c.json({
			kinds: Object.keys(MEMORY_KINDS),
			kind_descriptions: MEMORY_KINDS,
			fields: SCHEMA_FIELDS,
			filters: SCHEMA_FILTER_NAMES,
		});
	});

	// GET /api/memories/search_index — twin of memory_search_index
	// Full filter surface via JSON `filters` query param (MCP filterSchema parity).
	app.get("/api/memories/search_index", (c) => {
		const store = getStore();
		const query = c.req.query("query") ?? "";
		if (!query.trim()) {
			return c.json({ error: "query required" }, 400);
		}
		const limit = clampInt(queryInt(c.req.query("limit"), 8), 1, 50);
		const parsedFilters = parseGetFilters((name) => c.req.query(name));
		if (!parsedFilters.ok) return c.json({ error: parsedFilters.error }, 400);
		const items = store.search(query, limit, parsedFilters.filters).map(mapSearchIndexItem);
		return c.json({ items });
	});

	// POST /api/memories/explain — twin of memory_explain
	app.post("/api/memories/explain", async (c) => {
		const store = getStore();
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid JSON" }, 400);
		}
		const parsed = parseJsonBody(body);
		if (!parsed.ok) return c.json({ error: parsed.error }, 400);
		const args = parsed.value;

		const query = typeof args.query === "string" ? args.query : null;
		let ids: number[] | null = null;
		if (args.ids != null) {
			if (!Array.isArray(args.ids)) {
				return c.json({ error: "ids must be an array" }, 400);
			}
			if (args.ids.length > 200) {
				return c.json({ error: "ids must contain at most 200 entries" }, 400);
			}
			const { ordered, invalid } = dedupeOrderedIds(args.ids);
			if (invalid.length > 0) {
				return c.json({ error: "some ids are not valid integers", ids: invalid }, 400);
			}
			ids = ordered;
		}
		const limit = clampInt(parseOptionalInt(args.limit) ?? 10, 1, 50);
		const includePackContext =
			typeof args.include_pack_context === "boolean"
				? args.include_pack_context
				: Boolean(args.include_pack_context);
		const filters = buildFilters(args);

		const result = store.explain(query, ids, limit, filters, {
			includePackContext,
		});
		return c.json(result);
	});

	// POST /api/memories/distill_candidates — twin of memory_distill_candidates
	app.post("/api/memories/distill_candidates", async (c) => {
		const store = getStore();
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid JSON" }, 400);
		}
		const parsed = parseJsonBody(body);
		if (!parsed.ok) return c.json({ error: parsed.error }, 400);
		const args = parsed.value;

		const limit = clampInt(parseOptionalInt(args.limit) ?? 10, 1, 50);
		const minRecurrence = clampInt(parseOptionalInt(args.min_recurrence) ?? 2, 1, 50);
		const allProjects =
			typeof args.all_projects === "boolean" ? args.all_projects : Boolean(args.all_projects);
		const includeDocumented =
			typeof args.include_documented === "boolean"
				? args.include_documented
				: Boolean(args.include_documented);
		const maxEvidenceItems = clampInt(parseOptionalInt(args.max_evidence_items) ?? 5, 1, 20);
		// Judge defaults ON (MCP parity); explicit false disables.
		const judge =
			args.judge === undefined
				? true
				: typeof args.judge === "boolean"
					? args.judge
					: Boolean(args.judge);

		try {
			// Prefer explicit project / CODEMEM_PROJECT for context docs; no cwd default.
			const resolvedDefaultProject =
				cleanProject(typeof args.project === "string" ? args.project : null) ??
				cleanProject(process.env.CODEMEM_PROJECT);
			const filterArgs = { ...args, all_projects: allProjects };
			const filters = buildDistillFilters(filterArgs, resolvedDefaultProject);
			const kinds = typeof args.kind === "string" && args.kind.trim() ? [args.kind] : undefined;
			const fetchLimit = judge ? Math.min(limit * 3, limit + 20) : limit;

			let result = await buildDistillReport(store, {
				candidate: {
					includeDocumented,
					maxEvidenceItems,
				},
				contextDocuments: loadDefaultContextDocuments(
					shouldIncludeProjectContext(
						{ all_projects: allProjects, project: args.project },
						resolvedDefaultProject,
					),
				),
				corpus: { filters: filters ?? null, kinds },
				limit: fetchLimit,
				minRecurrence,
			});

			if (judge) {
				try {
					const client = new ObserverClient();
					result = await judgeDistillReport(result, async (system, user) => {
						const response = await client.observe(system, user);
						return response.raw;
					});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					result = {
						...result,
						metadata: { ...result.metadata, judged: false, judge_error: message },
					};
				}
				if (result.candidates.length > limit) {
					result = {
						...result,
						candidates: result.candidates.slice(0, limit),
						metadata: { ...result.metadata, candidate_count: limit },
					};
				}
			}

			return c.json(result);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ error: msg }, 400);
		}
	});

	return app;
}
