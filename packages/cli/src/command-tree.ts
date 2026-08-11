/**
 * Assembled root command tree — single source of truth shared by the runtime
 * entrypoint (`index.ts`) and the command-tree parity tests.
 *
 * `index.ts` stays the only module with import-time side effects (omelette
 * completion init, `program.parse()`); everything here is side-effect free
 * until `registerRootCommands` is called.
 */

import { Command } from "commander";
import { claudeHookFileContextCommand } from "./commands/claude-hook-file-context.js";
import { claudeHookIngestCommand } from "./commands/claude-hook-ingest.js";
import { claudeHookInjectCommand } from "./commands/claude-hook-inject.js";
import { codexHookIngestCommand } from "./commands/codex-hook-ingest.js";
import { codexHookInjectCommand } from "./commands/codex-hook-inject.js";
import { configCommand } from "./commands/config.js";
import { coordinatorCommand } from "./commands/coordinator.js";
import { dbCommand } from "./commands/db.js";
import { distillCommand } from "./commands/distill.js";
import { embedCommand } from "./commands/embed.js";
import { enqueueRawEventCommand } from "./commands/enqueue-raw-event.js";
import { exportMemoriesCommand } from "./commands/export-memories.js";
import { importMemoriesCommand } from "./commands/import-memories.js";
import { maintenanceCommand } from "./commands/maintenance.js";
import { mcpCommand } from "./commands/mcp.js";
import {
	forgetMemoryCommand,
	memoryCommand,
	rememberMemoryCommand,
	showMemoryCommand,
} from "./commands/memory.js";
import { packCommand, promptPackLedgerCommand } from "./commands/pack.js";
import { recentCommand } from "./commands/recent.js";
import { searchCommand } from "./commands/search.js";
import { serveCommand } from "./commands/serve.js";
import { setupCommand } from "./commands/setup.js";
import { statsCommand } from "./commands/stats.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { versionCommand } from "./commands/version.js";
import { helpStyle } from "./help-style.js";

export const ROOT_COMPLETION_COMMANDS = [
	"claude-hook-file-context",
	"claude-hook-inject",
	"claude-hook-ingest",
	"codex-hook-inject",
	"codex-hook-ingest",
	"config",
	"coordinator",
	"db",
	"distill",
	"embed",
	"enqueue-raw-event",
	"export-memories",
	"import-memories",
	"maintenance",
	"mcp",
	"memory",
	"pack",
	"recent",
	"search",
	"serve",
	"setup",
	"stats",
	"status",
	"sync",
	"version",
	"help",
	"--help",
	"--version",
] as const;

/** Completion entries that are not registered Commander commands. */
export const COMPLETION_ONLY_TOKENS = ["--help", "--version"] as const;

/**
 * True when the CLI process was invoked through the named top-level
 * compatibility alias (first non-flag token of the real argv). Forwarding
 * wrappers such as `memory export` re-parse the alias command with synthetic
 * argv, so this stays false for canonical invocations.
 */
export function invokedAsTopLevelAlias(
	name: string,
	argv: readonly string[] = process.argv.slice(2),
): boolean {
	for (const token of argv) {
		if (token === "--") return false;
		if (!token.startsWith("-")) return token === name;
	}
	return false;
}

function registerMemoryGroupWrappers(): void {
	// Idempotence guard: module singletons must not accumulate duplicate
	// subcommands if the tree is assembled more than once (e.g. in tests).
	if (memoryCommand.commands.some((command) => command.name() === "export")) return;

	// Per cli-design-conventions.md, export/import belong under their noun
	// group. The top-level export-memories/import-memories remain as warned
	// compatibility aliases.
	//
	// Slice the forwarded argv tail starting from the `memory <sub>` token pair
	// rather than the first raw occurrence of the subcommand name. Anchoring on
	// the `memory` group token first guarantees the subcommand token we slice
	// from is the actual subcommand position, so a positional argument that
	// happens to be literally "export" or "import" cannot shift the tail.
	const forwardedTail = (subcommand: "export" | "import"): string[] => {
		const argv = process.argv.slice(2);
		const groupIdx = argv.indexOf("memory");
		const searchFrom = groupIdx >= 0 ? groupIdx + 1 : 0;
		const subIdx = argv.indexOf(subcommand, searchFrom);
		return subIdx >= 0 ? argv.slice(subIdx + 1) : [];
	};

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
			await exportMemoriesCommand.parseAsync([
				"node",
				"export-memories",
				...forwardedTail("export"),
			]);
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
			await importMemoriesCommand.parseAsync([
				"node",
				"import-memories",
				...forwardedTail("import"),
			]);
		});

	memoryCommand.addCommand(memExport);
	memoryCommand.addCommand(memImport);
}

/** Register every root command (visible and hidden) on the given program. */
export function registerRootCommands(program: Command): Command {
	registerMemoryGroupWrappers();

	program.addCommand(serveCommand);
	program.addCommand(configCommand);
	program.addCommand(coordinatorCommand);
	program.addCommand(mcpCommand);
	program.addCommand(claudeHookInjectCommand);
	program.addCommand(claudeHookIngestCommand);
	program.addCommand(claudeHookFileContextCommand);
	program.addCommand(codexHookInjectCommand);
	program.addCommand(codexHookIngestCommand);
	program.addCommand(dbCommand);
	program.addCommand(distillCommand);
	// Warned compatibility aliases — visible for their first warned release;
	// hide from help and completion in a later release (see export-memories.ts).
	program.addCommand(exportMemoriesCommand);
	program.addCommand(importMemoriesCommand);
	program.addCommand(statsCommand);
	program.addCommand(statusCommand);
	program.addCommand(maintenanceCommand);
	program.addCommand(embedCommand);
	program.addCommand(recentCommand);
	program.addCommand(searchCommand);
	program.addCommand(packCommand);
	program.addCommand(promptPackLedgerCommand, { hidden: true });
	// Deprecated top-level aliases — use `memory show`, `memory forget`,
	// `memory remember` instead. Hidden from --help and shell completion but
	// still functional for backwards compat.
	program.addCommand(showMemoryCommand, { hidden: true });
	program.addCommand(forgetMemoryCommand, { hidden: true });
	program.addCommand(rememberMemoryCommand, { hidden: true });
	program.addCommand(memoryCommand);
	program.addCommand(syncCommand);
	program.addCommand(setupCommand);
	program.addCommand(enqueueRawEventCommand);
	program.addCommand(versionCommand);
	return program;
}
