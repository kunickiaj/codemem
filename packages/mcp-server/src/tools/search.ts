import type { MemoryResult } from "@codemem/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorContent, jsonContent } from "../content.js";
import { buildFilters } from "../project-scope.js";
import { filterSchema } from "../schemas.js";
import type { ToolRegistrationContext } from "../tool-context.js";

export function registerSearchTools(server: McpServer, context: ToolRegistrationContext): void {
	const { defaultProject, store } = context;

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
				const filters = buildFilters(args, defaultProject());
				const items = store.search(args.query, args.limit, filters);
				return jsonContent({
					items: items.map((m: MemoryResult) => ({
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
				const filters = buildFilters(args, defaultProject());
				const items = store.search(args.query, args.limit, filters);
				return jsonContent({
					items: items.map((m: MemoryResult) => ({
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

	server.tool(
		"memory_explain",
		"Explain search results with detailed scoring breakdown.",
		{
			query: z.string().optional().describe("Search query"),
			ids: z.array(z.number().int()).max(200).optional().describe("Specific memory IDs to explain"),
			limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
			include_pack_context: z.boolean().default(false).describe("Include formatted pack context"),
			...filterSchema,
		},
		async (args) => {
			try {
				const filters = buildFilters(args, defaultProject());
				const result = store.explain(args.query ?? null, args.ids ?? null, args.limit, filters, {
					includePackContext: args.include_pack_context,
				});
				return jsonContent(result);
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	server.tool(
		"memory_recent",
		"Return recent memories, newest first.",
		{
			limit: z.number().int().min(1).max(100).default(8).describe("Max results"),
			...filterSchema,
		},
		async (args) => {
			try {
				const filters = buildFilters(args, defaultProject());
				const items = store.recent(args.limit, filters);
				return jsonContent({ items });
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	server.tool(
		"memory_pack",
		"Build a formatted memory pack from search results — quick one-shot context block.",
		{
			context: z.string().describe("Context description to search for"),
			limit: z.number().int().min(1).max(50).optional().describe("Max items to include"),
			compact: z
				.boolean()
				.optional()
				.describe(
					"When true, render a scannable index of all items with full detail only for the top N (default 3). Saves tokens when broad overview matters more than per-item detail.",
				),
			compact_detail_count: z
				.number()
				.int()
				.min(0)
				.max(50)
				.optional()
				.describe("Number of items to show in full detail in compact mode (default 3)"),
			compression_mode: z
				.enum(["off", "compact", "ids"])
				.optional()
				.describe(
					"Near-related compression mode: off disables it, compact applies only to compact rendering, ids applies in all modes. Defaults to CODEMEM_PACK_COMPRESSION or compact.",
				),
			...filterSchema,
		},
		async (args) => {
			try {
				const filters = buildFilters(args, defaultProject());
				const renderOptions =
					args.compact || args.compact_detail_count != null || args.compression_mode != null
						? {
								compact: args.compact ?? (args.compact_detail_count != null ? true : undefined),
								compactDetailCount: args.compact_detail_count,
								compressionMode: args.compression_mode,
							}
						: undefined;
				const result = await store.buildMemoryPackAsync(
					args.context,
					args.limit ?? undefined,
					null,
					filters,
					renderOptions,
				);
				return jsonContent(result);
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);
}
