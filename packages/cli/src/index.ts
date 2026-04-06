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
import { claudeHookInjectCommand } from "./commands/claude-hook-inject.js";
import { configCommand } from "./commands/config.js";
import { coordinatorCommand } from "./commands/coordinator.js";
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
		"claude-hook-inject",
		"claude-hook-ingest",
		"config",
		"coordinator",
		"db",
		"embed",
		"enqueue-raw-event",
		"export-memories",
		"import-memories",
		"mcp",
		"memory",
		"pack",
		"recent",
		"search",
		"serve",
		"setup",
		"stats",
		"sync",
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

// --- Memory subcommands: export/import registered under `memory` group ---
// Per cli-design-conventions.md, export/import belong under their noun group.
// The top-level export-memories/import-memories remain as compatibility aliases.
//
// We create thin wrapper commands that replicate the same argument/option shape
// and delegate to the original command's parseAsync with synthetic argv.
// This avoids accessing Commander internals while keeping a single source of
// truth for the action logic in the original command modules.
{
	const memExport = new Command("export")
		.description("Export memories to a JSON file for sharing or backup")
		.argument("<output>", "output file path (use '-' for stdout)")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--project <project>", "filter by project")
		.option("--all-projects", "export all projects")
		.option("--include-inactive", "include deactivated memories")
		.option("--since <iso>", "only export memories created after this ISO timestamp")
		.configureHelp(helpStyle)
		.allowUnknownOption(true)
		.allowExcessArguments(true)
		.action(async () => {
			// Forward to the original command by re-parsing the raw argv tail.
			// `memory export <args>` → `export-memories <args>`
			const idx = process.argv.indexOf("export");
			const tail = idx >= 0 ? process.argv.slice(idx + 1) : [];
			await exportMemoriesCommand.parseAsync(["node", "export-memories", ...tail]);
		});

	const memImport = new Command("import")
		.description("Import memories from an exported JSON file")
		.argument("<inputFile>", "input JSON file (use '-' for stdin)")
		.option("--db <path>", "database path")
		.option("--db-path <path>", "database path")
		.option("--remap-project <path>", "remap all projects to this path on import")
		.option("--dry-run", "preview import without writing")
		.configureHelp(helpStyle)
		.allowUnknownOption(true)
		.allowExcessArguments(true)
		.action(async () => {
			const idx = process.argv.indexOf("import");
			const tail = idx >= 0 ? process.argv.slice(idx + 1) : [];
			await importMemoriesCommand.parseAsync(["node", "import-memories", ...tail]);
		});

	memoryCommand.addCommand(memExport);
	memoryCommand.addCommand(memImport);
}

program.addCommand(serveCommand);
program.addCommand(configCommand);
program.addCommand(coordinatorCommand);
program.addCommand(mcpCommand);
program.addCommand(claudeHookInjectCommand);
program.addCommand(claudeHookIngestCommand);
program.addCommand(dbCommand);
program.addCommand(exportMemoriesCommand);
program.addCommand(importMemoriesCommand);
program.addCommand(statsCommand);
program.addCommand(embedCommand);
program.addCommand(recentCommand);
program.addCommand(searchCommand);
program.addCommand(packCommand);
// Deprecated top-level aliases — use `memory show`, `memory forget`, `memory remember` instead.
// These are hidden from --help and shell completion but still functional for backwards compat.
program.addCommand(showMemoryCommand, { hidden: true });
program.addCommand(forgetMemoryCommand, { hidden: true });
program.addCommand(rememberMemoryCommand, { hidden: true });
program.addCommand(memoryCommand);
program.addCommand(syncCommand);
program.addCommand(setupCommand);
program.addCommand(enqueueRawEventCommand);
program.addCommand(versionCommand);

program.parse();
