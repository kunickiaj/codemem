#!/usr/bin/env node

/**
 * @codemem/cli — CLI entry point.
 *
 * Commands:
 *   codemem stats   → database statistics
 *   codemem search  → FTS5 memory search
 *   codemem pack    → context-aware memory pack
 *   codemem serve   → viewer server
 *   codemem mcp     → MCP stdio server
 */

import { VERSION } from "@codemem/core";
import { Command } from "commander";
import omelette from "omelette";
import { claudeHookIngestCommand } from "./commands/claude-hook-ingest.js";
import { dbCommand } from "./commands/db.js";
import { enqueueRawEventCommand } from "./commands/enqueue-raw-event.js";
import { exportMemoriesCommand } from "./commands/export-memories.js";
import { importMemoriesCommand } from "./commands/import-memories.js";
import { mcpCommand } from "./commands/mcp.js";
import { packCommand } from "./commands/pack.js";
import { recentCommand } from "./commands/recent.js";
import { searchCommand } from "./commands/search.js";
import { serveCommand } from "./commands/serve.js";
import { statsCommand } from "./commands/stats.js";
import { versionCommand } from "./commands/version.js";
import { helpStyle } from "./help-style.js";

// Shell completion (bash/zsh/fish)
const completion = omelette("codemem <command>");
completion.on("command", ({ reply }) => {
	reply([
		"claude-hook-ingest",
		"db",
		"export-memories",
		"import-memories",
		"stats",
		"recent",
		"search",
		"pack",
		"serve",
		"mcp",
		"enqueue-raw-event",
		"version",
		"help",
		"--help",
		"--version",
	]);
});
completion.init();

// `codemem --setup-completion` installs shell completion
if (process.argv.includes("--setup-completion")) {
	completion.setupShellInitFile();
	process.exit(0);
}
// `codemem --cleanup-completion` removes it
if (process.argv.includes("--cleanup-completion")) {
	completion.cleanupShellInitFile();
	process.exit(0);
}

const program = new Command();

program
	.name("codemem")
	.description("codemem — persistent memory for AI coding agents")
	.version(VERSION)
	.configureHelp(helpStyle);

program.addCommand(serveCommand);
program.addCommand(mcpCommand);
program.addCommand(claudeHookIngestCommand);
program.addCommand(dbCommand);
program.addCommand(exportMemoriesCommand);
program.addCommand(importMemoriesCommand);
program.addCommand(statsCommand);
program.addCommand(recentCommand);
program.addCommand(searchCommand);
program.addCommand(packCommand);
program.addCommand(enqueueRawEventCommand);
program.addCommand(versionCommand);

program.parse();
