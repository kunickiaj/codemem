import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const metadataSchema = z.record(z.string(), z.unknown());
// The column has a default but no NOT NULL constraint, and legacy rows can emit null.
const confidenceSchema = z.number().nullable();

const storedMemorySchema = z
	.object({
		id: z.number().int(),
		kind: z.string(),
		title: z.string(),
		body_text: z.string(),
		session_id: z.number().int().optional(),
		confidence: confidenceSchema.optional(),
		created_at: z.string().optional(),
		updated_at: z.string().optional(),
		metadata_json: metadataSchema.optional(),
	})
	.passthrough();

const searchMemorySchema = z
	.object({
		id: z.number().int(),
		kind: z.string(),
		title: z.string(),
		body: z.string(),
		confidence: confidenceSchema.optional(),
		score: z.number().optional(),
		session_id: z.number().int().optional(),
		metadata: metadataSchema.optional(),
	})
	.passthrough();

const indexMemorySchema = z
	.object({
		id: z.number().int(),
		kind: z.string(),
		title: z.string(),
		score: z.number(),
		created_at: z.string(),
		session_id: z.number().int(),
		metadata: metadataSchema,
	})
	.passthrough();

const errorDetailSchema = z
	.object({
		code: z.string(),
		field: z.string(),
		message: z.string(),
		ids: z.array(z.union([z.string(), z.number()])).optional(),
	})
	.passthrough();

const explainItemSchema = z
	.object({
		id: z.number().int(),
		kind: z.string(),
		title: z.string(),
		created_at: z.string(),
		project: z.string().nullable(),
		retrieval: z.object({ source: z.string(), rank: z.number().int().nullable() }).passthrough(),
		score: z
			.object({
				total: z.number().nullable(),
				components: z
					.object({
						base: z.number().nullable(),
						recency: z.number(),
						kind_bonus: z.number(),
						personal_bias: z.number(),
						semantic_boost: z.number().nullable(),
					})
					.passthrough(),
			})
			.passthrough(),
		role: z.object({ inferred: z.string(), reason: z.string() }).passthrough(),
		matches: z
			.object({ query_terms: z.array(z.string()), project_match: z.boolean().nullable() })
			.passthrough(),
		pack_context: z
			.object({ included: z.boolean().nullable(), section: z.string().nullable() })
			.passthrough()
			.nullable(),
	})
	.passthrough();

const packItemSchema = z
	.object({
		id: z.number().int(),
		kind: z.string(),
		title: z.string(),
		body: z.string(),
		confidence: confidenceSchema,
		metadata: metadataSchema,
	})
	.passthrough();

const stringListSectionSchema = z
	.object({
		when: z.array(z.string()),
		how: z.array(z.string()),
		examples: z.array(z.string()),
	})
	.passthrough();

export const toolOutputSchemas = {
	memory_search: z.object({ items: z.array(searchMemorySchema) }),
	memory_search_index: z.object({ items: z.array(indexMemorySchema) }),
	memory_explain: z.object({
		items: z.array(explainItemSchema),
		missing_ids: z.array(z.number().int()),
		errors: z.array(errorDetailSchema),
		metadata: z
			.object({
				query: z.string().nullable(),
				project: z.string().nullable(),
				requested_ids_count: z.number().int(),
				returned_items_count: z.number().int(),
				include_pack_context: z.boolean(),
				sanitized_query: z.string().optional(),
			})
			.passthrough(),
	}),
	memory_recent: z.object({ items: z.array(storedMemorySchema) }),
	memory_pack: z.object({
		context: z.string(),
		items: z.array(packItemSchema),
		item_ids: z.array(z.number().int()),
		pack_text: z.string(),
		metrics: z
			.object({
				total_items: z.number().int(),
				pack_tokens: z.number().int(),
				fallback_used: z.boolean(),
				limit: z.number().int(),
				project: z.string().nullable(),
				pack_item_ids: z.array(z.number().int()),
			})
			.passthrough(),
	}),
	memory_timeline: z.object({ items: z.array(storedMemorySchema) }),
	memory_expand: z.object({
		anchors: z.array(storedMemorySchema),
		timeline: z.array(storedMemorySchema),
		observations: z.array(storedMemorySchema),
		missing_ids: z.array(z.number().int()),
		errors: z.array(errorDetailSchema),
		metadata: z
			.object({
				project: z.string().nullable(),
				requested_ids_count: z.number().int(),
				returned_anchor_count: z.number().int(),
				timeline_count: z.number().int(),
				include_observations: z.boolean(),
			})
			.passthrough(),
	}),
	memory_get: storedMemorySchema,
	memory_get_observations: z.object({ items: z.array(storedMemorySchema) }),
	memory_remember: z.object({ id: z.number().int() }),
	memory_forget: z.object({ status: z.literal("ok") }),
	memory_distill_candidates: z.object({
		version: z.literal(1),
		candidates: z.array(
			z
				.object({
					scope: z.enum(["project", "user"]),
					suggested_target: z.string().nullable(),
					score: z.number(),
					recurrence: z.number().int(),
					projects: z.array(z.string()),
					member_ids: z.array(z.number().int()),
					representative_id: z.number().int(),
					concepts: z.array(z.string()),
					artifact_kind: z.enum(["context_fact", "skill"]),
					evidence: z.array(z.string()),
					draft_text: z.string().nullable(),
				})
				.passthrough(),
		),
		metadata: z
			.object({
				candidate_count: z.number().int(),
				cluster_count: z.number().int(),
				context_document_count: z.number().int(),
				corpus_count: z.number().int(),
				corpus_limit: z.number().int(),
				documented_cluster_count: z.number().int(),
				include_documented: z.boolean(),
				min_recurrence: z.number().int(),
			})
			.passthrough(),
	}),
	memory_schema: z.object({
		kinds: z.array(z.string()),
		kind_descriptions: z.record(z.string(), z.string()),
		fields: z.record(z.string(), z.string()),
		filters: z.array(z.string()),
	}),
	memory_learn: z.object({
		intro: z.string(),
		client_hint: z.string(),
		recall: stringListSectionSchema,
		persistence: stringListSectionSchema,
		forget: stringListSectionSchema,
		prompt_hint: z.string(),
		recommended_system_prompt: z.string(),
	}),
} as const;

// Incidental diagnostics and caches do not change the primary read operation.
const localReadAnnotations = {
	readOnlyHint: true,
	openWorldHint: false,
} satisfies ToolAnnotations;

// Pack/distill remain read-only while model loading or observer calls may access
// entities outside the local store.
const externalReadAnnotations = {
	readOnlyHint: true,
	openWorldHint: true,
} satisfies ToolAnnotations;

export const toolAnnotations = {
	memory_search: localReadAnnotations,
	memory_search_index: localReadAnnotations,
	memory_explain: localReadAnnotations,
	memory_recent: localReadAnnotations,
	memory_pack: externalReadAnnotations,
	memory_timeline: localReadAnnotations,
	memory_expand: localReadAnnotations,
	memory_get: localReadAnnotations,
	memory_get_observations: localReadAnnotations,
	// Remember is additive, but embedding generation can load external model assets.
	memory_remember: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	// Repeating a soft delete has no additional environmental effect.
	memory_forget: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	memory_distill_candidates: externalReadAnnotations,
	memory_schema: localReadAnnotations,
	memory_learn: localReadAnnotations,
} as const satisfies Record<keyof typeof toolOutputSchemas, ToolAnnotations>;
