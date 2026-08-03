import { storeVectors } from "@codemem/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorContent, jsonContent } from "../content.js";
import { withMcpRetrieval } from "../mcp-retrieval-ledger.js";
import {
	forgetMemoryForMcp,
	getManyForMcp,
	getMemoryForMcp,
	rememberMemoryForMcp,
} from "../memory-access.js";
import { buildFilters } from "../project-scope.js";
import { filterSchema, memoryKindSchema } from "../schemas.js";
import type { ToolRegistrationContext } from "../tool-context.js";

export function registerItemTools(server: McpServer, context: ToolRegistrationContext): void {
	const { envProject, store } = context;

	server.tool(
		"memory_get",
		"Fetch a single memory item by ID.",
		{
			memory_id: z.number().int().describe("Memory ID"),
			...filterSchema,
		},
		async (args, extra) => {
			// Direct-ID ops do not inherit the server default project. Callers already
			// have an exact ID; cwd/env should not silently scope the lookup.
			return withMcpRetrieval(
				context,
				{
					surface: "mcp_get",
					toolName: "memory_get",
					toolArguments: args,
					limit: 1,
					resolveFilters: () => buildFilters(args, null),
					requestId: extra?.requestId,
					sourceSessionId: extra?.sessionId,
					invocationIdentity: extra?.signal,
				},
				(filters) => {
					const item = getMemoryForMcp(store, args.memory_id, filters);
					return item
						? { value: item, memoryIds: [item.id], filters }
						: { value: null, memoryIds: [], error: "not_found", filters };
				},
			);
		},
	);

	server.tool(
		"memory_get_observations",
		"Fetch multiple memory items by their IDs.",
		{
			ids: z.array(z.number().int()).max(200).describe("Memory IDs to fetch"),
			...filterSchema,
		},
		async (args, extra) => {
			return withMcpRetrieval(
				context,
				{
					surface: "mcp_get_observations",
					toolName: "memory_get_observations",
					toolArguments: args,
					limit: args.ids.length,
					resolveFilters: () => buildFilters(args, null),
					requestId: extra?.requestId,
					sourceSessionId: extra?.sessionId,
					invocationIdentity: extra?.signal,
				},
				(filters) => {
					const items = getManyForMcp(store, args.ids, filters);
					return { value: { items }, memoryIds: items.map((item) => item.id), filters };
				},
			);
		},
	);

	server.tool(
		"memory_remember",
		"Create a new memory. Use for milestones, decisions, and notable facts.",
		{
			kind: memoryKindSchema.describe("Memory kind"),
			title: z.string().describe("Short title"),
			body: z.string().describe("Body text (high-signal content)"),
			confidence: z.number().min(0).max(1).default(0.5).describe("Confidence 0-1"),
			project: z.string().optional().describe("Project identifier"),
		},
		async (args) => {
			try {
				// Writes never inherit the server default project. They only honor an
				// explicit `project` input or CODEMEM_PROJECT; otherwise project stays null.
				const result = rememberMemoryForMcp(store, args, {
					envProject: envProject(),
				});

				try {
					await storeVectors(store.db, result.memId, result.title, result.body);
				} catch {
					// Memory writes should succeed even if embeddings are unavailable.
				}

				return jsonContent({ id: result.memId });
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);

	server.tool(
		"memory_forget",
		"Soft-delete a memory item. Use for incorrect or sensitive data.",
		{
			memory_id: z.number().int().describe("Memory ID to forget"),
			...filterSchema,
		},
		async (args) => {
			try {
				if (!forgetMemoryForMcp(store, args.memory_id, buildFilters(args, null))) {
					return errorContent("not_found");
				}
				return jsonContent({ status: "ok" });
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);
}
