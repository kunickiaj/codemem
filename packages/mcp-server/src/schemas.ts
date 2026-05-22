import { z } from "zod";

const scopeFilterSchema = {
	scope_id: z.string().optional().describe("Filter by a single sharing domain scope_id"),
	include_scope_ids: z.array(z.string()).optional().describe("Sharing domain scope_ids to include"),
	exclude_scope_ids: z.array(z.string()).optional().describe("Sharing domain scope_ids to exclude"),
};

export const filterSchema = {
	kind: z.string().optional().describe("Filter by memory kind"),
	project: z.string().optional().describe("Filter by project scope (matches sessions.project)"),
	...scopeFilterSchema,
	visibility: z.array(z.string()).optional(),
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
	ownership_scope: z.string().optional(),
	personal_first: z.union([z.boolean(), z.string()]).optional(),
	trust_bias: z.string().optional(),
	widen_shared_when_weak: z.union([z.boolean(), z.string()]).optional(),
	widen_shared_min_personal_results: z.number().int().optional(),
	widen_shared_min_personal_score: z.number().optional(),
};

export const memoryKindSchema = z.enum([
	"discovery",
	"change",
	"feature",
	"bugfix",
	"refactor",
	"decision",
	"exploration",
]);

export const filterNames = Object.keys(filterSchema).toSorted();
