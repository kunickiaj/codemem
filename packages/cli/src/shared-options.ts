/**
 * Shared CLI option builders.
 *
 * Defines standard flags once with consistent short forms, descriptions,
 * and hidden legacy aliases. Every command module should use these instead
 * of ad-hoc .option() calls.
 *
 * See docs/cli-design-conventions.md for the full spec.
 */

import type { Command } from "commander";
import { Option } from "commander";

// ---------------------------------------------------------------------------
// --db-path / -d  (with hidden --db alias)
// ---------------------------------------------------------------------------

/** Add -d/--db-path and hidden --db alias to a command. */
export function addDbOption(cmd: Command): Command {
	cmd.addOption(new Option("-d, --db-path <path>", "database path (overrides $CODEMEM_DB)"));
	// Hidden legacy alias
	cmd.addOption(new Option("--db <path>", "database path").hideHelp());
	return cmd;
}

/** Resolve the db path from parsed opts that may have --db or --db-path. */
export function resolveDbOpt(opts: { db?: string; dbPath?: string }): string | undefined {
	return opts.dbPath ?? opts.db;
}

// ---------------------------------------------------------------------------
// --config / -c
// ---------------------------------------------------------------------------

/** Add -c/--config to a command. */
export function addConfigOption(cmd: Command): Command {
	cmd.addOption(new Option("-c, --config <path>", "config file path (overrides $CODEMEM_CONFIG)"));
	return cmd;
}

// ---------------------------------------------------------------------------
// --json / -j
// ---------------------------------------------------------------------------

/** Add -j/--json to a command. */
export function addJsonOption(cmd: Command): Command {
	cmd.addOption(new Option("-j, --json", "output as JSON"));
	return cmd;
}

// ---------------------------------------------------------------------------
// Host / port (viewer — the default service)
// ---------------------------------------------------------------------------

/** Add --host and --port for the viewer/serve service. */
export function addViewerHostOptions(
	cmd: Command,
	defaults: { host?: string; port?: string } = {},
): Command {
	cmd.option("--host <host>", "viewer host", defaults.host ?? "127.0.0.1");
	cmd.option("--port <port>", "viewer port", defaults.port ?? "38888");
	return cmd;
}

// ---------------------------------------------------------------------------
// Hidden legacy aliases (accept silently, ignore)
// ---------------------------------------------------------------------------

/** Add hidden --user/--system Typer-era compatibility flags. */
export function addLegacyServiceFlags(cmd: Command): Command {
	cmd.addOption(new Option("--user", "accepted for compatibility").default(true).hideHelp());
	cmd.addOption(new Option("--system", "accepted for compatibility").hideHelp());
	return cmd;
}

// ---------------------------------------------------------------------------
// Deprecation warning helper
// ---------------------------------------------------------------------------

/** Emit a deprecation warning to stderr. */
export function emitDeprecationWarning(oldForm: string, newForm: string): void {
	console.error(`Warning: '${oldForm}' is deprecated, use '${newForm}' instead.`);
}

// ---------------------------------------------------------------------------
// Structured JSON error helper
// ---------------------------------------------------------------------------

/** Print a structured JSON error to stdout and set the exit code. */
export function emitJsonError(errorCode: string, message: string, exitCode = 1): void {
	console.log(JSON.stringify({ error: errorCode, message }));
	process.exitCode = exitCode;
}

// ---------------------------------------------------------------------------
// Common option type for action handlers
// ---------------------------------------------------------------------------

export interface DbOpts {
	db?: string;
	dbPath?: string;
}

export interface ConfigOpts {
	config?: string;
}

export interface JsonOpts {
	json?: boolean;
}

export interface ViewerHostOpts {
	host: string;
	port: string;
}
