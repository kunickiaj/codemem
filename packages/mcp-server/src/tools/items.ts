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
import { toolAnnotations, toolOutputSchemas } from "../tool-contracts.js";

const getInputSchema = {
	memory_id: z.number().int().describe("Memory ID"),
	...filterSchema,
};

const getObservationsInputSchema = {
	ids: z.array(z.number().int()).max(200).describe("Memory IDs to fetch"),
	...filterSchema,
};

const rememberInputSchema = {
	kind: memoryKindSchema.describe("Memory kind"),
	title: z.string().describe("Short title"),
	body: z.string().describe("Body text (high-signal content)"),
	confidence: z.number().min(0).max(1).default(0.5).describe("Confidence 0-1"),
	project: z.string().optional().describe("Project identifier"),
};

const forgetInputSchema = {
	memory_id: z.number().int().describe("Memory ID to forget"),
	...filterSchema,
};

function registerGetTool(server: McpServer, context: ToolRegistrationContext): void {
	server.registerTool(
		"memory_get",
		{
			description:
				"Fetch one memory by exact ID. Does not inherit the default project; optional filters constrain the lookup, and a mismatch returns not_found.",
			inputSchema: getInputSchema,
			outputSchema: toolOutputSchemas.memory_get,
			annotations: toolAnnotations.memory_get,
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
					const item = getMemoryForMcp(context.store, args.memory_id, filters);
					return item
						? { value: item, memoryIds: [item.id], filters }
						: { value: null, memoryIds: [], error: "not_found", filters };
				},
			);
		},
	);
}

function registerGetObservationsTool(server: McpServer, context: ToolRegistrationContext): void {
	server.registerTool(
		"memory_get_observations",
		{
			description:
				"Fetch multiple memories by exact IDs. Does not inherit the default project. Missing or filtered-out IDs are omitted from results, not reported as not_found.",
			inputSchema: getObservationsInputSchema,
			outputSchema: toolOutputSchemas.memory_get_observations,
			annotations: toolAnnotations.memory_get_observations,
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
					const items = getManyForMcp(context.store, args.ids, filters);
					return { value: { items }, memoryIds: items.map((item) => item.id), filters };
				},
			);
		},
	);
}

function registerRememberTool(server: McpServer, context: ToolRegistrationContext): void {
	server.registerTool(
		"memory_remember",
		{
			description: "Create a new memory. Use for milestones, decisions, and notable facts.",
			inputSchema: rememberInputSchema,
			outputSchema: toolOutputSchemas.memory_remember,
			annotations: toolAnnotations.memory_remember,
		},
		async (args) => {
			try {
				// Writes never inherit the server default project. They only honor an
				// explicit `project` input or CODEMEM_PROJECT; otherwise project stays null.
				const result = rememberMemoryForMcp(context.store, args, {
					envProject: context.envProject(),
				});

				try {
					await storeVectors(context.store.db, result.memId, result.title, result.body);
				} catch {
					// Memory writes should succeed even if embeddings are unavailable.
				}

				return jsonContent({ id: result.memId });
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);
}

function registerForgetTool(server: McpServer, context: ToolRegistrationContext): void {
	server.registerTool(
		"memory_forget",
		{
			description:
				"Soft-delete a memory by exact ID so it no longer appears in normal retrieval; this is not secure erasure. Does not inherit the default project; optional filters must match or the tool returns not_found.",
			inputSchema: forgetInputSchema,
			outputSchema: toolOutputSchemas.memory_forget,
			annotations: toolAnnotations.memory_forget,
		},
		async (args) => {
			try {
				if (!forgetMemoryForMcp(context.store, args.memory_id, buildFilters(args, null))) {
					return errorContent("not_found");
				}
				return jsonContent({ status: "ok" });
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);
}

export function registerItemTools(server: McpServer, context: ToolRegistrationContext): void {
	registerGetTool(server, context);
	registerGetObservationsTool(server, context);
	registerRememberTool(server, context);
	registerForgetTool(server, context);
}
