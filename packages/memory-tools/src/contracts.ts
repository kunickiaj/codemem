/**
 * Memory tool contracts shared by every thin host (OpenCode plugin, pi
 * extension). Names, descriptions, and input schemas mirror the MCP server
 * registrations in packages/mcp-server/src/tools/*; the parity test in
 * packages/mcp-server/src/tool-contract-parity.test.ts fails CI on drift.
 *
 * This module has no runtime dependencies and never imports @codemem/core.
 */

import {
	anyOf,
	boolean,
	integer,
	integerArray,
	type JsonSchema,
	number,
	type ObjectSchema,
	object,
	string,
	stringArray,
	stringEnum,
	withDefault,
} from "./json-schema.js";

export const MEMORY_TOOL_NAMES = [
	"memory_search",
	"memory_search_index",
	"memory_explain",
	"memory_recent",
	"memory_pack",
	"memory_timeline",
	"memory_expand",
	"memory_get",
	"memory_get_observations",
	"memory_remember",
	"memory_forget",
	"memory_distill_candidates",
	"memory_schema",
	"memory_learn",
] as const;

export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

/** Retrieval-ledger surface recorded for one tool call; null for tools that never record. */
export type RetrievalSurface =
	| "mcp_search"
	| "mcp_search_index"
	| "mcp_explain"
	| "mcp_recent"
	| "mcp_pack"
	| "mcp_timeline"
	| "mcp_expand"
	| "mcp_get"
	| "mcp_get_observations";

/**
 * How a tool resolves `project` when the caller omits it.
 * - `caller`: default to the calling host's project (stdio MCP uses CODEMEM_PROJECT, then server cwd).
 * - `env`: writes honor CODEMEM_PROJECT only; they never inherit the directory-derived project.
 * - `none`: ID-addressed tools never inherit any default project.
 */
export type ProjectScoping = "caller" | "env" | "none";

export interface MemoryToolContract {
	readonly name: MemoryToolName;
	readonly description: string;
	readonly input: ObjectSchema;
	readonly surface: RetrievalSurface | null;
	readonly projectScoping: ProjectScoping;
	/** Tools that read or write relative to the caller's directory (session cwd, AGENTS.md). */
	readonly sendsDirectory: boolean;
}

/** Memory kinds `memory_remember` accepts; mirrors core REMEMBER_MEMORY_KINDS. */
export const REMEMBER_MEMORY_KINDS = [
	"discovery",
	"change",
	"feature",
	"bugfix",
	"refactor",
	"decision",
	"exploration",
] as const;

const scopeFilterProperties: Record<string, JsonSchema> = {
	scope_id: string("Filter by a single sharing domain scope_id"),
	include_scope_ids: stringArray("Sharing domain scope_ids to include"),
	exclude_scope_ids: stringArray("Sharing domain scope_ids to exclude"),
};

/** Mirrors packages/mcp-server/src/schemas.ts filterSchema, in declaration order. */
export const FILTER_PROPERTIES: Record<string, JsonSchema> = {
	kind: string("Filter by memory kind"),
	project: string("Filter by project scope (matches sessions.project)"),
	...scopeFilterProperties,
	visibility: stringArray(),
	include_visibility: stringArray(),
	exclude_visibility: stringArray(),
	include_workspace_ids: stringArray(),
	exclude_workspace_ids: stringArray(),
	include_workspace_kinds: stringArray(),
	exclude_workspace_kinds: stringArray(),
	include_actor_ids: stringArray(),
	exclude_actor_ids: stringArray(),
	include_trust_states: stringArray(),
	exclude_trust_states: stringArray(),
	ownership_scope: string(),
	personal_first: anyOf([boolean(), string()]),
	trust_bias: string(),
	widen_shared_when_weak: anyOf([boolean(), string()]),
	widen_shared_min_personal_results: integer(),
	widen_shared_min_personal_score: number(),
};

export const FILTER_NAMES: readonly string[] = Object.keys(FILTER_PROPERTIES).toSorted();

const depthProperties = (beforeLabel: string, afterLabel: string): Record<string, JsonSchema> => ({
	depth_before: withDefault(integer({ minimum: 0, description: beforeLabel }), 3),
	depth_after: withDefault(integer({ minimum: 0, description: afterLabel }), 3),
});

const searchContract: MemoryToolContract = {
	name: "memory_search",
	description:
		"Keyword-search memories when you know exact terms or identifiers. Returns full body text for each match; use memory_search_index when you only need compact candidates.",
	input: object(
		{
			query: string("Search query"),
			limit: withDefault(integer({ minimum: 1, maximum: 50, description: "Max results" }), 5),
			...FILTER_PROPERTIES,
		},
		["query"],
	),
	surface: "mcp_search",
	projectScoping: "caller",
	sendsDirectory: false,
};

const searchIndexContract: MemoryToolContract = {
	name: "memory_search_index",
	description:
		"Keyword-search memories when you know exact terms or identifiers. Returns compact entries with IDs and titles, without bodies; expand selected IDs with memory_get or memory_get_observations.",
	input: object(
		{
			query: string("Search query"),
			limit: withDefault(integer({ minimum: 1, maximum: 50, description: "Max results" }), 8),
			...FILTER_PROPERTIES,
		},
		["query"],
	),
	surface: "mcp_search_index",
	projectScoping: "caller",
	sendsDirectory: false,
};

const explainContract: MemoryToolContract = {
	name: "memory_explain",
	description: "Explain search results with detailed scoring breakdown.",
	input: object({
		query: string("Search query"),
		ids: integerArray({ maxItems: 200, description: "Specific memory IDs to explain" }),
		limit: withDefault(integer({ minimum: 1, maximum: 50, description: "Max results" }), 10),
		include_pack_context: withDefault(boolean("Include formatted pack context"), false),
		...FILTER_PROPERTIES,
	}),
	surface: "mcp_explain",
	projectScoping: "caller",
	sendsDirectory: false,
};

const recentContract: MemoryToolContract = {
	name: "memory_recent",
	description: "Return recent memories, newest first.",
	input: object({
		limit: withDefault(integer({ minimum: 1, maximum: 100, description: "Max results" }), 8),
		...FILTER_PROPERTIES,
	}),
	surface: "mcp_recent",
	projectScoping: "caller",
	sendsDirectory: false,
};

const packContract: MemoryToolContract = {
	name: "memory_pack",
	description:
		"Build a formatted context block for a concept or task using keyword and semantic search when embeddings are available, with automatic keyword-only fallback. Use for conceptually relevant context; use memory_search or memory_search_index for exact identifiers.",
	input: object(
		{
			context: string("Context description to search for"),
			limit: integer({ minimum: 1, maximum: 50, description: "Max items to include" }),
			compact: boolean(
				"When true, render a scannable index of all items with full detail only for the top N (default 3). Saves tokens when broad overview matters more than per-item detail.",
			),
			compact_detail_count: integer({
				minimum: 0,
				maximum: 50,
				description: "Number of items to show in full detail in compact mode (default 3)",
			}),
			compression_mode: stringEnum(
				["off", "compact", "ids"],
				"Near-related compression mode: off disables it, compact applies only to compact rendering, ids applies in all modes. Defaults to CODEMEM_PACK_COMPRESSION or compact.",
			),
			...FILTER_PROPERTIES,
		},
		["context"],
	),
	surface: "mcp_pack",
	projectScoping: "caller",
	sendsDirectory: false,
};

const timelineContract: MemoryToolContract = {
	name: "memory_timeline",
	description: "Get a chronological window of memories around an anchor (by ID or query).",
	input: object({
		query: string("Search query to find anchor"),
		memory_id: integer({ description: "Anchor memory ID" }),
		...depthProperties("Items before anchor", "Items after anchor"),
		...FILTER_PROPERTIES,
	}),
	surface: "mcp_timeline",
	projectScoping: "caller",
	sendsDirectory: false,
};

const expandContract: MemoryToolContract = {
	name: "memory_expand",
	description: "Fetch memories by ID with surrounding timeline context.",
	input: object(
		{
			ids: {
				type: "array",
				items: anyOf([number(), string()]),
				maxItems: 200,
				description: "Memory IDs to expand",
			},
			...depthProperties("Timeline items before", "Timeline items after"),
			include_observations: withDefault(boolean("Include full observation details"), false),
			...FILTER_PROPERTIES,
		},
		["ids"],
	),
	surface: "mcp_expand",
	projectScoping: "caller",
	sendsDirectory: false,
};

const getContract: MemoryToolContract = {
	name: "memory_get",
	description:
		"Fetch one memory by exact ID. Does not inherit the default project; optional filters constrain the lookup, and a mismatch returns not_found.",
	input: object({ memory_id: integer({ description: "Memory ID" }), ...FILTER_PROPERTIES }, [
		"memory_id",
	]),
	surface: "mcp_get",
	projectScoping: "none",
	sendsDirectory: false,
};

const getObservationsContract: MemoryToolContract = {
	name: "memory_get_observations",
	description:
		"Fetch multiple memories by exact IDs. Does not inherit the default project. Missing or filtered-out IDs are omitted from results, not reported as not_found.",
	input: object(
		{
			ids: integerArray({ maxItems: 200, description: "Memory IDs to fetch" }),
			...FILTER_PROPERTIES,
		},
		["ids"],
	),
	surface: "mcp_get_observations",
	projectScoping: "none",
	sendsDirectory: false,
};

const rememberContract: MemoryToolContract = {
	name: "memory_remember",
	description: "Create a new memory. Use for milestones, decisions, and notable facts.",
	input: object(
		{
			kind: stringEnum(REMEMBER_MEMORY_KINDS, "Memory kind"),
			title: string("Short title"),
			body: string("Body text (high-signal content)"),
			confidence: withDefault(
				number({ minimum: 0, maximum: 1, description: "Confidence 0-1" }),
				0.5,
			),
			project: string("Project identifier"),
		},
		["kind", "title", "body"],
	),
	surface: null,
	projectScoping: "env",
	sendsDirectory: true,
};

const forgetContract: MemoryToolContract = {
	name: "memory_forget",
	description:
		"Soft-delete a memory by exact ID so it no longer appears in normal retrieval; this is not secure erasure. Does not inherit the default project; optional filters must match or the tool returns not_found.",
	input: object(
		{ memory_id: integer({ description: "Memory ID to forget" }), ...FILTER_PROPERTIES },
		["memory_id"],
	),
	surface: null,
	projectScoping: "none",
	sendsDirectory: false,
};

const distillContract: MemoryToolContract = {
	name: "memory_distill_candidates",
	description:
		"Mine recurring memories into reviewable context candidates. Reads project/user context files without modifying them and can call the optional observer when judge=true.",
	input: object({
		limit: withDefault(integer({ minimum: 1, maximum: 50, description: "Max candidates" }), 10),
		min_recurrence: withDefault(
			integer({ minimum: 1, maximum: 50, description: "Minimum member count per candidate" }),
			2,
		),
		all_projects: withDefault(boolean("Mine memories across all projects"), false),
		include_documented: withDefault(
			boolean("Include candidates already represented in context files"),
			false,
		),
		max_evidence_items: withDefault(
			integer({ minimum: 1, maximum: 20, description: "Evidence snippets per candidate" }),
			5,
		),
		judge: withDefault(
			boolean(
				"Judge candidates with the observer model and drop routine-activity clusters (on by default; falls back to unjudged output when no observer model is configured)",
			),
			true,
		),
		...FILTER_PROPERTIES,
	}),
	surface: null,
	projectScoping: "caller",
	sendsDirectory: true,
};

const schemaContract: MemoryToolContract = {
	name: "memory_schema",
	description: "Return the memory schema — kinds, fields, and available filters.",
	input: object({}),
	surface: null,
	projectScoping: "none",
	sendsDirectory: false,
};

const learnContract: MemoryToolContract = {
	name: "memory_learn",
	description: "Learn how to use codemem memory tools. Call this first if unfamiliar.",
	input: object({}),
	surface: null,
	projectScoping: "none",
	sendsDirectory: false,
};

export const MEMORY_TOOL_CONTRACTS: Readonly<Record<MemoryToolName, MemoryToolContract>> = {
	memory_search: searchContract,
	memory_search_index: searchIndexContract,
	memory_explain: explainContract,
	memory_recent: recentContract,
	memory_pack: packContract,
	memory_timeline: timelineContract,
	memory_expand: expandContract,
	memory_get: getContract,
	memory_get_observations: getObservationsContract,
	memory_remember: rememberContract,
	memory_forget: forgetContract,
	memory_distill_candidates: distillContract,
	memory_schema: schemaContract,
	memory_learn: learnContract,
};

export function listMemoryToolContracts(): readonly MemoryToolContract[] {
	return MEMORY_TOOL_NAMES.map((name) => MEMORY_TOOL_CONTRACTS[name]);
}
