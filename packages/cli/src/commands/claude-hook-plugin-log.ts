/**
 * Append-only plugin failure log used by both `claude-hook-inject` and
 * `claude-hook-ingest` to record errors that don't justify crashing the
 * hook command itself.
 *
 * Behavior:
 * - Default log path is `~/.codemem/plugin.log`.
 * - `CODEMEM_PLUGIN_LOG_PATH` (preferred) or `CODEMEM_PLUGIN_LOG` may
 *   override the path. Boolean-shaped values (`0/1/true/false/yes/no/on/off`
 *   and empty) are treated as toggles, not paths, so the default is used.
 * - All I/O is best-effort: failures are swallowed.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const BOOLEAN_TOGGLE_VALUES = new Set(["", "0", "false", "off", "1", "true", "yes", "on", "no"]);

function expandHome(value: string): string {
	const home = process.env.HOME?.trim() || homedir();
	if (value === "~") return home;
	if (value.startsWith("~/")) return join(home, value.slice(2));
	return value;
}

export function pluginLogPath(): string {
	const raw = process.env.CODEMEM_PLUGIN_LOG_PATH ?? process.env.CODEMEM_PLUGIN_LOG ?? "";
	const normalized = raw.trim().toLowerCase();
	if (BOOLEAN_TOGGLE_VALUES.has(normalized)) {
		return expandHome("~/.codemem/plugin.log");
	}
	return expandHome(raw.trim());
}

/**
 * Append a single timestamped line to the plugin log. Best-effort: any
 * filesystem error is swallowed so a logging failure can never bubble up
 * into a Claude hook crash.
 */
export function logHookFailure(message: string): void {
	const path = pluginLogPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${new Date().toISOString()} ${message}\n`, { encoding: "utf8" });
	} catch {
		// best-effort
	}
}
