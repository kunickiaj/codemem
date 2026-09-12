/**
 * Tool-exposed memory filter contract.
 *
 * Single source of truth for the filter keys and value types accepted by both
 * memory tool surfaces: the MCP server tool schemas (pinned to this catalog by
 * an exact parity test in @codemem/mcp-server) and the viewer-server HTTP
 * routes (validated directly against this catalog). Keeping one catalog means
 * a filter added here cannot be silently omitted from either surface, so
 * exclusion filters can never fail open and return broader results than the
 * client requested.
 *
 * Insertion order mirrors the MCP tool schema key order.
 */

export type MemoryFilterFieldType =
	| "string"
	| "string-array"
	| "int"
	| "number"
	| "boolean-or-string";

export const MEMORY_FILTER_FIELD_TYPES = {
	kind: "string",
	project: "string",
	scope_id: "string",
	include_scope_ids: "string-array",
	exclude_scope_ids: "string-array",
	visibility: "string-array",
	include_visibility: "string-array",
	exclude_visibility: "string-array",
	include_workspace_ids: "string-array",
	exclude_workspace_ids: "string-array",
	include_workspace_kinds: "string-array",
	exclude_workspace_kinds: "string-array",
	include_actor_ids: "string-array",
	exclude_actor_ids: "string-array",
	include_trust_states: "string-array",
	exclude_trust_states: "string-array",
	ownership_scope: "string",
	personal_first: "boolean-or-string",
	trust_bias: "string",
	widen_shared_when_weak: "boolean-or-string",
	widen_shared_min_personal_results: "int",
	widen_shared_min_personal_score: "number",
} as const satisfies Record<string, MemoryFilterFieldType>;

export type MemoryFilterName = keyof typeof MEMORY_FILTER_FIELD_TYPES;

/** Sorted filter names exposed by memory_schema on both surfaces. */
export const MEMORY_FILTER_NAMES = Object.keys(
	MEMORY_FILTER_FIELD_TYPES,
).toSorted() as MemoryFilterName[];

/** Check a raw request value against a filter field's declared type. */
export function memoryFilterValueMatchesType(
	value: unknown,
	fieldType: MemoryFilterFieldType,
): boolean {
	switch (fieldType) {
		case "string":
			return typeof value === "string";
		case "string-array":
			return Array.isArray(value) && value.every((item) => typeof item === "string");
		case "int":
			return typeof value === "number" && Number.isInteger(value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean-or-string":
			return typeof value === "boolean" || typeof value === "string";
	}
}
