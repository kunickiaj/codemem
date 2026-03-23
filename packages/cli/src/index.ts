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
import { embedCommand } from "./commands/embed.js";
import { enqueueRawEventCommand } from "./commands/enqueue-raw-event.js";
import { exportMemoriesCommand } from "./commands/export-memories.js";
import { importMemoriesCommand } from "./commands/import-memories.js";
import { mcpCommand } from "./commands/mcp.js";
import {
	forgetMemoryCommand,
	memoryCommand,
	rememberMemoryCommand,
	showMemoryCommand,
} from "./commands/memory.js";
import { packCommand } from "./commands/pack.js";
import { recentCommand } from "./commands/recent.js";
import { searchCommand } from "./commands/search.js";
import { serveCommand } from "./commands/serve.js";
import { setupCommand } from "./commands/setup.js";
import { statsCommand } from "./commands/stats.js";
import { syncCommand } from "./commands/sync.js";
import { versionCommand } from "./commands/version.js";
import { helpStyle } from "./help-style.js";

type CompletionWithScriptGenerators = ReturnType<typeof omelette> & {
	generateCompletionCode: () => string;
	generateCompletionCodeFish: () => string;
};

// Shell completion (bash/zsh/fish)
const completion = omelette("codemem <command>") as CompletionWithScriptGenerators;
completion.on("command", ({ reply }) => {
	reply([
		"claude-hook-ingest",
		"db",
		"embed",
		"export-memories",
		"forget",
		"memory",
		"import-memories",
		"setup",
		"show",
		"sync",
		"stats",
		"recent",
		"remember",
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

function hasRootFlag(flag: string): boolean {
	for (const arg of process.argv.slice(2)) {
		if (arg === "--") return false;
		if (arg === flag) return true;
		if (!arg.startsWith("-")) return false;
	}
	return false;
}

function getShellCompletionScript(): string {
	const shellPath = process.env.SHELL ?? "";
	if (shellPath.includes("fish")) {
		return completion.generateCompletionCodeFish();
	}
	return completion.generateCompletionCode();
}

const program = new Command();

program
	.name("codemem")
	.description("codemem — persistent memory for AI coding agents")
	.option("--install-completion", "install shell completion")
	.option("--show-completion", "show shell completion install guidance")
	.version(VERSION)
	.configureHelp(helpStyle);

if (hasRootFlag("--setup-completion") || hasRootFlag("--install-completion")) {
	completion.setupShellInitFile();
	process.exit(0);
}

if (hasRootFlag("--show-completion")) {
	console.log(getShellCompletionScript());
	process.exit(0);
}

if (hasRootFlag("--cleanup-completion")) {
	completion.cleanupShellInitFile();
	process.exit(0);
}

program.addCommand(serveCommand);
program.addCommand(mcpCommand);
program.addCommand(claudeHookIngestCommand);
program.addCommand(dbCommand);
program.addCommand(exportMemoriesCommand);
program.addCommand(importMemoriesCommand);
program.addCommand(statsCommand);
program.addCommand(embedCommand);
program.addCommand(recentCommand);
program.addCommand(searchCommand);
program.addCommand(packCommand);
program.addCommand(showMemoryCommand);
program.addCommand(forgetMemoryCommand);
program.addCommand(rememberMemoryCommand);
program.addCommand(memoryCommand);
program.addCommand(syncCommand);
program.addCommand(setupCommand);
program.addCommand(enqueueRawEventCommand);
program.addCommand(versionCommand);

program.parse();
