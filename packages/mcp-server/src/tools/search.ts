import type { MemoryResult } from "@codemem/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withMcpRetrieval } from "../mcp-retrieval-ledger.js";
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
		async (args, extra) => {
			return withMcpRetrieval(
				context,
				{
					surface: "mcp_search",
					toolName: "memory_search",
					toolArguments: args,
					query: args.query,
					limit: args.limit,
					resolveFilters: () => buildFilters(args, defaultProject()),
					requestId: extra?.requestId,
					sourceSessionId: extra?.sessionId,
					invocationIdentity: extra?.signal,
				},
				(filters) => {
					const items = store.search(args.query, args.limit, filters);
					return {
						value: {
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
						},
						memoryIds: items.map((item) => item.id),
						filters,
					};
				},
			);
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
		async (args, extra) => {
			return withMcpRetrieval(
				context,
				{
					surface: "mcp_search_index",
					toolName: "memory_search_index",
					toolArguments: args,
					query: args.query,
					limit: args.limit,
					resolveFilters: () => buildFilters(args, defaultProject()),
					requestId: extra?.requestId,
					sourceSessionId: extra?.sessionId,
					invocationIdentity: extra?.signal,
				},
				(filters) => {
					const items = store.search(args.query, args.limit, filters);
					return {
						value: {
							items: items.map((m: MemoryResult) => ({
								id: m.id,
								kind: m.kind,
								title: m.title,
								score: m.score,
								created_at: m.created_at,
								session_id: m.session_id,
								metadata: m.metadata,
							})),
						},
						memoryIds: items.map((item) => item.id),
						filters,
					};
				},
			);
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
		async (args, extra) => {
			return withMcpRetrieval(
				context,
				{
					surface: "mcp_explain",
					toolName: "memory_explain",
					toolArguments: args,
					query: args.query,
					limit: args.limit,
					resolveFilters: () => buildFilters(args, defaultProject()),
					requestId: extra?.requestId,
					sourceSessionId: extra?.sessionId,
					invocationIdentity: extra?.signal,
				},
				(filters) => {
					const result = store.explain(args.query ?? null, args.ids ?? null, args.limit, filters, {
						includePackContext: args.include_pack_context,
					});
					const fatalInputError = result.errors.some(
						(error) => error.code === "INVALID_ARGUMENT" && error.field === "query",
					);
					return {
						value: result,
						memoryIds: result.items.map((item) => item.id),
						filters,
						retrievalStatus: fatalInputError ? ("failed" as const) : undefined,
					};
				},
			);
		},
	);

	server.tool(
		"memory_recent",
		"Return recent memories, newest first.",
		{
			limit: z.number().int().min(1).max(100).default(8).describe("Max results"),
			...filterSchema,
		},
		async (args, extra) => {
			return withMcpRetrieval(
				context,
				{
					surface: "mcp_recent",
					toolName: "memory_recent",
					toolArguments: args,
					limit: args.limit,
					resolveFilters: () => buildFilters(args, defaultProject()),
					requestId: extra?.requestId,
					sourceSessionId: extra?.sessionId,
					invocationIdentity: extra?.signal,
				},
				(filters) => {
					const items = store.recent(args.limit, filters);
					return { value: { items }, memoryIds: items.map((item) => item.id), filters };
				},
			);
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
		async (args, extra) => {
			return withMcpRetrieval(
				context,
				{
					surface: "mcp_pack",
					toolName: "memory_pack",
					toolArguments: args,
					query: args.context,
					limit: args.limit ?? null,
					resolveFilters: () => buildFilters(args, defaultProject()),
					requestId: extra?.requestId,
					sourceSessionId: extra?.sessionId,
					invocationIdentity: extra?.signal,
				},
				async (filters) => {
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
					return { value: result, memoryIds: result.item_ids, filters };
				},
			);
		},
	);
}
