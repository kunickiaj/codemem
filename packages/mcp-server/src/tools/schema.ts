import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonContent } from "../content.js";
import { MEMORY_KINDS } from "../memory-kinds.js";
import { filterNames } from "../schemas.js";

export function registerSchemaTools(server: McpServer): void {
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
				filters: filterNames,
			});
		},
	);
}
