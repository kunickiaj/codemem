/**
 * Assembled root command tree — single source of truth shared by the runtime
 * entrypoint (`index.ts`) and the command-tree parity tests.
 *
 * `index.ts` stays the only module with import-time side effects (omelette
 * completion init, `program.parse()`); everything here is side-effect free
 * until `registerRootCommands` is called.
 */

import type { Command } from "commander";
import { claudeHookFileContextCommand } from "./commands/claude-hook-file-context.js";
import { claudeHookIngestCommand } from "./commands/claude-hook-ingest.js";
import { claudeHookInjectCommand } from "./commands/claude-hook-inject.js";
import { codexHookIngestCommand } from "./commands/codex-hook-ingest.js";
import { codexHookInjectCommand } from "./commands/codex-hook-inject.js";
import { configCommand } from "./commands/config.js";
import { coordinatorCommand } from "./commands/coordinator.js";
import { diagnosticsCommand } from "./commands/diagnostics.js";
import { distillCommand } from "./commands/distill.js";
import { enqueueRawEventCommand } from "./commands/enqueue-raw-event.js";
import { maintenanceCommand } from "./commands/maintenance.js";
import { mcpCommand } from "./commands/mcp.js";
import { memoryCommand } from "./commands/memory.js";
import { memoryToolCommand } from "./commands/memory-tool.js";
import { packCommand, promptPackLedgerCommand } from "./commands/pack.js";
import { piHookIngestCommand } from "./commands/pi-hook-ingest.js";
import { piHookInjectCommand } from "./commands/pi-hook-inject.js";
import { piSessionSearchCommand } from "./commands/pi-session-search.js";
import { recentCommand } from "./commands/recent.js";
import { searchCommand } from "./commands/search.js";
import { serveCommand } from "./commands/serve.js";
import { serviceCommand } from "./commands/service.js";
import { sessionCommand } from "./commands/session.js";
import { setupCommand } from "./commands/setup.js";
import { statsCommand } from "./commands/stats.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { updateCommand } from "./commands/update.js";
import { versionCommand } from "./commands/version.js";

const publicCommands = [
	memoryCommand,
	sessionCommand,
	serviceCommand,
	statusCommand,
	syncCommand,
	coordinatorCommand,
	maintenanceCommand,
	diagnosticsCommand,
	configCommand,
	setupCommand,
	updateCommand,
	mcpCommand,
];

export const ROOT_COMPLETION_COMMANDS = [
	...publicCommands.map((command) => command.name()),
	"help",
	"--help",
	"--version",
];

/** Completion entries that are not registered Commander commands. */
export const COMPLETION_ONLY_TOKENS = ["--help", "--version"] as const;

/** Register every root command (visible and hidden) on the given program. */
export function registerRootCommands(program: Command): Command {
	for (const command of publicCommands) program.addCommand(command);
	// Persisted launchers and previously installed integrations still call these
	// entrypoints. New callers use the public groups above.
	for (const command of [
		serveCommand,
		packCommand,
		recentCommand,
		searchCommand,
		statsCommand,
		distillCommand,
		piSessionSearchCommand,
		versionCommand,
	]) {
		program.addCommand(command, { hidden: true });
	}
	// Adapter plumbing remains executable for packaged and stale-client
	// compatibility, but it is not part of the human-facing command surface.
	program.addCommand(claudeHookInjectCommand, { hidden: true });
	program.addCommand(claudeHookIngestCommand, { hidden: true });
	program.addCommand(claudeHookFileContextCommand, { hidden: true });
	program.addCommand(codexHookInjectCommand, { hidden: true });
	program.addCommand(codexHookIngestCommand, { hidden: true });
	program.addCommand(piHookInjectCommand, { hidden: true });
	program.addCommand(piHookIngestCommand, { hidden: true });
	program.addCommand(promptPackLedgerCommand, { hidden: true });
	// Thin-host fallback when the viewer is unreachable; see memory-tool.ts.
	program.addCommand(memoryToolCommand, { hidden: true });
	program.addCommand(enqueueRawEventCommand, { hidden: true });
	return program;
}
