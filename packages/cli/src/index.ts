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
import { ROOT_COMPLETION_COMMANDS, registerRootCommands } from "./command-tree.js";
import { helpStyle } from "./help-style.js";

type CompletionWithScriptGenerators = ReturnType<typeof omelette> & {
	generateCompletionCode: () => string;
	generateCompletionCodeFish: () => string;
};

// Shell completion (bash/zsh/fish)
const completion = omelette("codemem <command>") as CompletionWithScriptGenerators;
completion.on("command", ({ reply }) => {
	reply([...ROOT_COMPLETION_COMMANDS]);
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
	.enablePositionalOptions()
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

registerRootCommands(program);

program.parse();
