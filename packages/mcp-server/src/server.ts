import { type MemoryStore, VERSION } from "@codemem/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveDefaultProject } from "./project-scope.js";
import type { CodememMcpServerOptions, ToolRegistrationContext } from "./tool-context.js";
import { registerItemTools } from "./tools/items.js";
import { registerLearnTools } from "./tools/learn.js";
import { registerSchemaTools } from "./tools/schema.js";
import { registerSearchTools } from "./tools/search.js";
import { registerTimelineTools } from "./tools/timeline.js";

export function createCodememMcpServer(
	store: MemoryStore,
	options: CodememMcpServerOptions = {},
): McpServer {
	const server = new McpServer({ name: "codemem", version: VERSION });
	const context: ToolRegistrationContext = {
		store,
		// Resolve lazily per call so long-running servers pick up the current
		// CODEMEM_PROJECT / process.cwd() rather than the value at construction.
		defaultProject: () => {
			if (options.resolveDefaultProject) return options.resolveDefaultProject();
			if (options.defaultProject !== undefined) return options.defaultProject;
			return resolveDefaultProject();
		},
		envProject: () =>
			options.envProject !== undefined ? options.envProject : (process.env.CODEMEM_PROJECT ?? null),
	};

	registerSearchTools(server, context);
	registerTimelineTools(server, context);
	registerItemTools(server, context);
	registerSchemaTools(server);
	registerLearnTools(server);

	return server;
}
