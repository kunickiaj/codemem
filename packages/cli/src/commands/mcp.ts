import { Command } from "commander";

export const mcpCommand = new Command("mcp")
	.description("Start the MCP stdio server")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.action(async (opts: { db?: string }) => {
		if (opts.db) process.env.CODEMEM_DB = opts.db;
		// Dynamic import — MCP server is its own entry point
		await import("@codemem/mcp-server");
	});
