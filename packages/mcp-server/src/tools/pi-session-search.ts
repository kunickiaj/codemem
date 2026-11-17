import { type PiSessionSearchResponse, searchPiSessions } from "@codemem/core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorContent, jsonContent } from "../content.js";
import type { ToolRegistrationContext } from "../tool-context.js";
import { toolAnnotations, toolOutputSchemas } from "../tool-contracts.js";

const sessionSearchInputSchema = z.object({
	query: z.string().describe("Free-text search over stored Pi user/assistant session text"),
	project: z
		.string()
		.optional()
		.describe("Project label; defaults to the server's resolved project (cwd/CODEMEM_PROJECT)"),
	session_id: z.string().optional().describe("Pi session id, narrowing the effective project"),
	limit: z.number().int().min(1).max(20).default(10).describe("Max results"),
	snippet_chars: z
		.number()
		.int()
		.min(100)
		.max(4000)
		.default(1200)
		.describe("Per-result snippet cap in chars"),
});

export function registerSessionSearchTools(
	server: McpServer,
	context: ToolRegistrationContext,
): void {
	const { defaultProject, store } = context;

	server.registerTool(
		"memory_session_search",
		{
			description:
				"Search stored Pi session transcripts by free-text query. Matches raw user and assistant text only — never memories, extracted metadata, or tool payloads — most-recent-first, with bounded snippets and optional project/session filters. Empty results are not an error; pre-install history needs `codemem session import`.",
			inputSchema: sessionSearchInputSchema,
			outputSchema: toolOutputSchemas.memory_session_search,
			annotations: toolAnnotations.memory_session_search,
		},
		async (args) => {
			const query = args.query;
			if (!query.trim()) return errorContent("query required");
			// Resolve the default lazily per call (CODEMEM_PROJECT / cwd). An explicit
			// project wins; session_id only narrows within that effective project.
			const explicitProject = typeof args.project === "string" ? args.project.trim() : "";
			const response: PiSessionSearchResponse = searchPiSessions(store.db, query, {
				project: explicitProject || defaultProject(),
				session_id: args.session_id,
				limit: args.limit,
				snippet_chars: args.snippet_chars,
			});
			return jsonContent(response);
		},
	);
}
