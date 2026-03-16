#!/usr/bin/env node

/**
 * @codemem/mcp-server — MCP stdio server.
 *
 * Runs as a separate process spawned by the host (OpenCode/Claude).
 * Owns its own better-sqlite3 connection. Communicates via stdio JSON-RPC.
 *
 * Port of codemem/mcp_server.py — all 13 tools.
 */

import {
	DEFAULT_DB_PATH,
	type MemoryFilters,
	type MemoryItemResponse,
	MemoryStore,
	toJson,
	VERSION,
} from "@codemem/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

const MEMORY_KINDS: Record<string, string> = {
	discovery: "Something learned about the codebase, architecture, or tools",
	change: "A code change that was made",
	feature: "A new feature that was implemented",
	bugfix: "A bug that was found and fixed",
	refactor: "Code that was refactored or restructured",
	decision: "A design or architecture decision",
	exploration: "An experiment or investigation (may not have shipped)",
};

// ---------------------------------------------------------------------------
// Shared zod filter schema (spread into each tool that accepts filters)
// ---------------------------------------------------------------------------

const filterSchema = {
	kind: z.string().optional().describe("Filter by memory kind"),
	include_visibility: z.array(z.string()).optional(),
	exclude_visibility: z.array(z.string()).optional(),
	include_workspace_ids: z.array(z.string()).optional(),
	exclude_workspace_ids: z.array(z.string()).optional(),
	include_workspace_kinds: z.array(z.string()).optional(),
	exclude_workspace_kinds: z.array(z.string()).optional(),
	include_actor_ids: z.array(z.string()).optional(),
	exclude_actor_ids: z.array(z.string()).optional(),
	include_trust_states: z.array(z.string()).optional(),
	exclude_trust_states: z.array(z.string()).optional(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a MemoryFilters object from raw tool params, dropping undefined keys. */
function buildFilters(raw: Record<string, unknown>): MemoryFilters | undefined {
	const filters: MemoryFilters = {};
	let hasAny = false;
	for (const key of Object.keys(filterSchema)) {
		const val = raw[key];
		if (val !== undefined && val !== null) {
			(filters as Record<string, unknown>)[key] = val;
			hasAny = true;
		}
	}
	return hasAny ? filters : undefined;
}

/** Wrap a JSON result into the MCP text content envelope. */
function jsonContent(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

/** Wrap an error message into the MCP text content envelope. */
function errorContent(message: string) {
	return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}

/** ISO timestamp. */
function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Deduplicate and validate an array of IDs.
 * Returns [validIds, invalidIdStrings] — mirrors Python _dedupe_ordered_ids.
 */
function dedupeOrderedIds(ids: unknown[]): [number[], string[]] {
	const deduped: number[] = [];
	const seen = new Set<number>();
	const invalid: string[] = [];

	for (const raw of ids) {
		if (typeof raw === "boolean" || typeof raw === "object") {
			invalid.push(String(raw));
			continue;
		}
		const parsed = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			invalid.push(String(raw));
			continue;
		}
		if (seen.has(parsed)) continue;
		seen.add(parsed);
		deduped.push(parsed);
	}
	return [deduped, invalid];
}

/**
 * Fetch multiple memory items by ID. Returns items in ID order, skipping
 * missing IDs. Implemented directly since MemoryStore doesn't have getMany.
 */
function getMany(store: MemoryStore, ids: number[]): MemoryItemResponse[] {
	if (ids.length === 0) return [];
	const results: MemoryItemResponse[] = [];
	for (const id of ids) {
		const item = store.get(id);
		if (item) results.push(item);
	}
	return results;
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

async function main() {
	const dbPath = process.env.CODEMEM_DB ?? DEFAULT_DB_PATH;
	const store = new MemoryStore(dbPath);

	const server = new McpServer({ name: "codemem", version: VERSION });

	// -------------------------------------------------------------------
	// 1. memory_search
	// -------------------------------------------------------------------
	server.tool(
		"memory_search",
		"Search memories by text query. Returns full body text for each match.",
		{
			query: z.string().describe("Search query"),
			limit: z.number().int().min(1).max(50).default(5).describe("Max results"),
			...filterSchema,
		},
		async (args) => {
			try {
				const filters = buildFilters(args);
				const items = store.search(args.query, args.limit, filters);
				return jsonContent({
					items: items.map((m) => ({
						id: m.id,
						title: m.title,
						kind: m.kind,
						body: m.body_text,
						confidence: m.confidence,
						score: m.score,
						session_id: m.session_id,
						metadata: m.metadata,
					})),
				});
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	// -------------------------------------------------------------------
	// 2. memory_search_index
	// -------------------------------------------------------------------
	server.tool(
		"memory_search_index",
		"Search memories by text query. Returns compact index entries (no body) for browsing.",
		{
			query: z.string().describe("Search query"),
			limit: z.number().int().min(1).max(50).default(8).describe("Max results"),
			...filterSchema,
		},
		async (args) => {
			try {
				const filters = buildFilters(args);
				const items = store.search(args.query, args.limit, filters);
				return jsonContent({
					items: items.map((m) => ({
						id: m.id,
						kind: m.kind,
						title: m.title,
						score: m.score,
						created_at: m.created_at,
						session_id: m.session_id,
						metadata: m.metadata,
					})),
				});
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	// -------------------------------------------------------------------
	// 3. memory_timeline
	// -------------------------------------------------------------------
	server.tool(
		"memory_timeline",
		"Get a chronological window of memories around an anchor (by ID or query).",
		{
			query: z.string().optional().describe("Search query to find anchor"),
			memory_id: z.number().int().optional().describe("Anchor memory ID"),
			depth_before: z.number().int().min(0).default(3).describe("Items before anchor"),
			depth_after: z.number().int().min(0).default(3).describe("Items after anchor"),
			...filterSchema,
		},
		async (args) => {
			try {
				const filters = buildFilters(args);
				const items = store.timeline(
					args.query ?? null,
					args.memory_id ?? null,
					args.depth_before,
					args.depth_after,
					filters,
				);
				return jsonContent({ items });
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	// -------------------------------------------------------------------
	// 4. memory_explain
	// -------------------------------------------------------------------
	server.tool(
		"memory_explain",
		"Explain search results with detailed scoring breakdown.",
		{
			query: z.string().optional().describe("Search query"),
			ids: z.array(z.number().int()).optional().describe("Specific memory IDs to explain"),
			limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
			include_pack_context: z.boolean().default(false).describe("Include formatted pack context"),
			...filterSchema,
		},
		async (args) => {
			try {
				const filters = buildFilters(args);
				const result = store.explain(args.query ?? null, args.ids ?? null, args.limit, filters);
				return jsonContent(result);
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	// -------------------------------------------------------------------
	// 5. memory_expand
	// -------------------------------------------------------------------
	server.tool(
		"memory_expand",
		"Fetch memories by ID with surrounding timeline context.",
		{
			ids: z.array(z.union([z.number(), z.string()])).describe("Memory IDs to expand"),
			depth_before: z.number().int().min(0).default(3).describe("Timeline items before"),
			depth_after: z.number().int().min(0).default(3).describe("Timeline items after"),
			include_observations: z.boolean().default(false).describe("Include full observation details"),
			project: z.string().optional().describe("Project scope (not yet implemented in TS)"),
		},
		async (args) => {
			try {
				const [orderedIds, invalidIds] = dedupeOrderedIds(args.ids);
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
				const anchors: MemoryItemResponse[] = [];
				const timelineItems: MemoryItemResponse[] = [];
				const timelineSeen = new Set<number>();

				for (const memoryId of orderedIds) {
					const item = store.get(memoryId);
					if (!item || !item.active) {
						missingNotFound.push(memoryId);
						continue;
					}

					anchors.push(item);

					const expanded = store.timeline(null, memoryId, args.depth_before, args.depth_after);
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

				// Collect full observations if requested
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
					observations = getMany(store, observationIds);
				}

				return jsonContent({
					anchors,
					timeline: timelineItems,
					observations,
					missing_ids: missingNotFound,
					errors,
					metadata: {
						project: args.project ?? null,
						requested_ids_count: orderedIds.length,
						returned_anchor_count: anchors.length,
						timeline_count: timelineItems.length,
						include_observations: args.include_observations,
					},
				});
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	// -------------------------------------------------------------------
	// 6. memory_get
	// -------------------------------------------------------------------
	server.tool(
		"memory_get",
		"Fetch a single memory item by ID.",
		{
			memory_id: z.number().int().describe("Memory ID"),
		},
		async (args) => {
			try {
				const item = store.get(args.memory_id);
				if (!item) return errorContent("not_found");
				return jsonContent(item);
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	// -------------------------------------------------------------------
	// 7. memory_get_observations
	// -------------------------------------------------------------------
	server.tool(
		"memory_get_observations",
		"Fetch multiple memory items by their IDs.",
		{
			ids: z.array(z.number().int()).describe("Memory IDs to fetch"),
		},
		async (args) => {
			try {
				const items = getMany(store, args.ids);
				return jsonContent({ items });
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	// -------------------------------------------------------------------
	// 8. memory_recent
	// -------------------------------------------------------------------
	server.tool(
		"memory_recent",
		"Return recent memories, newest first.",
		{
			limit: z.number().int().min(1).max(100).default(8).describe("Max results"),
			...filterSchema,
		},
		async (args) => {
			try {
				const filters = buildFilters(args);
				const items = store.recent(args.limit, filters);
				return jsonContent({ items });
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	// -------------------------------------------------------------------
	// 9. memory_pack
	// -------------------------------------------------------------------
	server.tool(
		"memory_pack",
		"Build a formatted memory pack from search results — quick one-shot context block.",
		{
			context: z.string().describe("Context description to search for"),
			limit: z.number().int().min(1).max(50).optional().describe("Max items to include"),
			...filterSchema,
		},
		async (args) => {
			try {
				const filters = buildFilters(args);
				const result = store.buildMemoryPack(args.context, args.limit ?? undefined, null, filters);
				return jsonContent(result);
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	// -------------------------------------------------------------------
	// 10. memory_remember
	// -------------------------------------------------------------------
	server.tool(
		"memory_remember",
		"Create a new memory. Use for milestones, decisions, and notable facts.",
		{
			kind: z.string().describe(`Memory kind: ${Object.keys(MEMORY_KINDS).join(", ")}`),
			title: z.string().describe("Short title"),
			body: z.string().describe("Body text (high-signal content)"),
			confidence: z.number().min(0).max(1).default(0.5).describe("Confidence 0-1"),
			project: z.string().optional().describe("Project identifier"),
		},
		async (args) => {
			try {
				// Create a transient session for MCP-originated memories.
				// TS store doesn't have startSession/endSession yet, so
				// we insert the session row directly.
				const now = nowIso();
				const user = process.env.USER ?? "unknown";
				const cwd = process.cwd();
				const project = args.project ?? process.env.CODEMEM_PROJECT ?? null;

				const sessionInfo = store.db
					.prepare(
						`INSERT INTO sessions(started_at, ended_at, cwd, project, user, tool_version, metadata_json)
						 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(now, now, cwd, project, user, "mcp-ts", toJson({ mcp: true }));
				const sessionId = Number(sessionInfo.lastInsertRowid);

				const memId = store.remember(sessionId, args.kind, args.title, args.body, args.confidence);

				// End the session
				store.db
					.prepare("UPDATE sessions SET ended_at = ?, metadata_json = ? WHERE id = ?")
					.run(nowIso(), toJson({ mcp: true }), sessionId);

				return jsonContent({ id: memId });
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	// -------------------------------------------------------------------
	// 11. memory_forget
	// -------------------------------------------------------------------
	server.tool(
		"memory_forget",
		"Soft-delete a memory item. Use for incorrect or sensitive data.",
		{
			memory_id: z.number().int().describe("Memory ID to forget"),
		},
		async (args) => {
			try {
				store.forget(args.memory_id);
				return jsonContent({ status: "ok" });
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	// -------------------------------------------------------------------
	// 12. memory_schema
	// -------------------------------------------------------------------
	server.tool(
		"memory_schema",
		"Return the memory schema — kinds, fields, and available filters.",
		{},
		async () => {
			return jsonContent({
				kinds: Object.keys(MEMORY_KINDS),
				kind_descriptions: MEMORY_KINDS,
				fields: {
					title: "short text",
					body: "long text",
					subtitle: "short text",
					facts: "list<string>",
					narrative: "long text",
					concepts: "list<string>",
					files_read: "list<string>",
					files_modified: "list<string>",
					prompt_number: "int",
				},
				filters: [
					"kind",
					"session_id",
					"since",
					"project",
					"include_actor_ids",
					"exclude_actor_ids",
					"include_visibility",
					"exclude_visibility",
					"include_workspace_ids",
					"exclude_workspace_ids",
					"include_workspace_kinds",
					"exclude_workspace_kinds",
				],
			});
		},
	);

	// -------------------------------------------------------------------
	// 13. memory_learn
	// -------------------------------------------------------------------
	server.tool(
		"memory_learn",
		"Learn how to use codemem memory tools. Call this first if unfamiliar.",
		{},
		async () => {
			return jsonContent({
				intro: "Use this tool when you're new to codemem or unsure when to recall/persist.",
				client_hint: "If you are unfamiliar with codemem, call memory.learn first.",
				recall: {
					when: [
						"Start of a task or when the user references prior work.",
						"When you need background context, decisions, or recent changes.",
					],
					how: [
						"Use memory.search_index to get compact candidates.",
						"Use memory.timeline to expand around a promising memory.",
						"Use memory.get_observations for full details only when needed.",
						"Use memory.pack for quick one-shot context blocks.",
						"Use the project filter unless the user requests cross-project context.",
					],
					examples: [
						'memory.search_index("billing cache bug", limit=5)',
						"memory.timeline(memory_id=123)",
						"memory.get_observations([123, 456])",
					],
				},
				persistence: {
					when: [
						"Milestones (task done, key decision, new facts learned).",
						"Notable regressions or follow-ups that should be remembered.",
					],
					how: [
						"Use memory.remember with kind decision/observation/note.",
						"Keep titles short and bodies high-signal.",
						"ALWAYS pass the project parameter if known.",
					],
					examples: [
						'memory.remember(kind="decision", title="Switch to async cache", body="...why...", project="my-service")',
						'memory.remember(kind="observation", title="Fixed retry loop", body="...impact...", project="my-service")',
					],
				},
				forget: {
					when: [
						"Accidental or sensitive data stored in memory items.",
						"Obsolete or incorrect items that should no longer surface.",
					],
					how: [
						"Call memory.forget(id) to mark the item inactive.",
						"Prefer forgetting over overwriting to preserve auditability.",
					],
					examples: ["memory.forget(123)"],
				},
				prompt_hint:
					"At task start: call memory.search_index; during work: memory.timeline + memory.get_observations; at milestones: memory.remember.",
				recommended_system_prompt: [
					"Trigger policy (1-liner): If the user references prior work or starts a task,",
					"immediately call memory.search_index; then use memory.timeline + memory.get_observations;",
					"at milestones, call memory.remember; use memory.forget for incorrect/sensitive items.",
					"",
					"System prompt:",
					"You have access to codemem MCP tools. If unfamiliar, call memory.learn first.",
					"",
					"Recall:",
					"- Start of any task: call memory.search_index with a concise task query.",
					'- If prior work is referenced ("as before", "last time", "we already did…", "regression"),',
					"  call memory.search_index or memory.timeline.",
					"- Use memory.get_observations only after filtering IDs.",
					"- Prefer project-scoped queries unless the user asks for cross-project.",
					"",
					"Persistence:",
					"- On milestones (task done, key decision, new facts learned), call memory.remember.",
					"- Use kind=decision for tradeoffs, kind=observation for outcomes, kind=note for small useful facts.",
					"- Keep titles short and bodies high-signal.",
					"- ALWAYS pass the project parameter if known.",
					"",
					"Safety:",
					"- Use memory.forget(id) for incorrect or sensitive items.",
					"",
					"Examples:",
					'- memory.search_index("billing cache bug")',
					"- memory.timeline(memory_id=123)",
					"- memory.get_observations([123, 456])",
					'- memory.remember(kind="decision", title="Use async cache", body="Chose async cache to avoid lock contention in X.", project="my-service")',
					'- memory.remember(kind="observation", title="Fixed retry loop", body="Root cause was Y; added guard in Z.", project="my-service")',
					"- memory.forget(123)",
				].join("\n"),
			});
		},
	);

	// -------------------------------------------------------------------
	// Connect and handle shutdown
	// -------------------------------------------------------------------
	const transport = new StdioServerTransport();

	const shutdown = () => {
		try {
			store.close();
		} catch {
			// Best effort — process is exiting
		}
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	await server.connect(transport);
}

main().catch((err) => {
	console.error("codemem MCP server failed to start:", err);
	process.exit(1);
});
