import { Command } from "commander";
import { helpStyle } from "../help-style.js";

export const mcpCommand = new Command("mcp")
	.configureHelp(helpStyle)
	.description("Start the MCP stdio server")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.action(async (opts: { db?: string }) => {
		if (opts.db) process.env.CODEMEM_DB = opts.db;
		// Dynamic import — MCP server is its own entry point
		await import("@codemem/mcp");
	});
