/**
 * Same plugin log as `packages/cli/src/commands/claude-hook-plugin-log.ts`.
 * The extension cannot import the CLI package. Keep the path rules in step
 * with that file so `inject.pack.ok source=pi` lands in one log.
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
	if (BOOLEAN_TOGGLE_VALUES.has(normalized)) return expandHome("~/.codemem/plugin.log");
	return expandHome(raw.trim());
}

/** `inject.pack.ok source=pi` line previously written only by `pi-hook-inject`. */
export function logPiInjectPack(fields: {
	origin: "local" | "viewer";
	items: number;
	packTokens: number;
	queryLen: number;
	empty: boolean;
	project: string | null;
}): void {
	const parts = [
		"inject.pack.ok",
		"source=pi",
		`origin=${fields.origin}`,
		`items=${fields.items}`,
		`pack_tokens=${fields.packTokens}`,
		`query_len=${fields.queryLen}`,
		`empty=${fields.empty ? "true" : "false"}`,
	];
	if (fields.project) parts.push(`project=${JSON.stringify(fields.project)}`);
	try {
		const path = pluginLogPath();
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${new Date().toISOString()} ${parts.join(" ")}\n`, { encoding: "utf8" });
	} catch {
		// best-effort
	}
}
