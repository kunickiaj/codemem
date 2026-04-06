import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, type DbOpts, resolveDbOpt } from "../shared-options.js";

const mcpCmd = new Command("mcp")
	.configureHelp(helpStyle)
	.description("Start the MCP stdio server");

addDbOption(mcpCmd);

export const mcpCommand = mcpCmd.action(async (opts: DbOpts) => {
	const dbPath = resolveDbOpt(opts);
	if (dbPath) process.env.CODEMEM_DB = dbPath;
	try {
		await import("@codemem/mcp");
	} catch (err) {
		console.error(
			`Failed to start MCP server: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exitCode = 1;
	}
});
