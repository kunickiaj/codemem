/**
 * Pi extension config: ~/.config/codemem/config.json `pi.*` + CODEMEM_PI_* env.
 *
 * Thin client — does not import @codemem/core. Reads the JSON file directly.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PiToolsMode = "native" | "mcp-adapter";

export type PiExtensionConfig = {
	toolsMode: PiToolsMode;
	injectPrompts: boolean;
	fileContext: boolean;
	viewerHost: string;
	viewerPort: number;
	viewerEnabled: boolean;
	viewerAutoStart: boolean;
	rawEventsBackoffMs: number;
	rawEventsStatusCheckMs: number;
	injectLimit: number;
	injectTokenBudget: number;
	injectMaxChars: number;
	httpTimeoutMs: number;
};

const DEFAULTS: PiExtensionConfig = {
	toolsMode: "native",
	injectPrompts: true,
	fileContext: true,
	viewerHost: "127.0.0.1",
	viewerPort: 38888,
	viewerEnabled: true,
	viewerAutoStart: true,
	rawEventsBackoffMs: 10_000,
	rawEventsStatusCheckMs: 30_000,
	injectLimit: 8,
	injectTokenBudget: 800,
	injectMaxChars: 16_000,
	httpTimeoutMs: 5_000,
};

function envNotDisabled(value: string | undefined, fallbackWhenUnset: boolean): boolean {
	if (value == null || value.trim() === "") return fallbackWhenUnset;
	const normalized = value.trim().toLowerCase();
	return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

function envTruthy(value: string | undefined): boolean | null {
	if (value == null || value.trim() === "") return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
		return true;
	}
	if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
		return false;
	}
	return null;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function resolveConfigPath(): string {
	const override = process.env.CODEMEM_CONFIG?.trim();
	if (override) return expandHome(override);
	const configDir = process.env.XDG_CONFIG_HOME?.trim()
		? expandHome(process.env.XDG_CONFIG_HOME)
		: join(homedir(), ".config");
	const base = join(configDir, "codemem");
	for (const name of ["config.json", "config.jsonc"]) {
		const candidate = join(base, name);
		if (existsSync(candidate)) return candidate;
	}
	return join(base, "config.json");
}

function stripJsonc(text: string): string {
	// Minimal JSONC strip: // line comments and /* block comments */, keep strings intact.
	let out = "";
	let i = 0;
	let inString = false;
	let quote = "";
	let escaped = false;
	while (i < text.length) {
		const ch = text[i] ?? "";
		const next = text[i + 1] ?? "";
		if (inString) {
			out += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === quote) {
				inString = false;
			}
			i += 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			out += ch;
			i += 1;
			continue;
		}
		if (ch === "/" && next === "/") {
			i += 2;
			while (i < text.length && text[i] !== "\n") i += 1;
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
			i += 2;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

function readConfigFile(): Record<string, unknown> {
	const path = resolveConfigPath();
	if (!existsSync(path)) return {};
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(stripJsonc(raw)) as unknown;
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

function resolveToolsMode(fileValue: unknown, envValue: string | undefined): PiToolsMode {
	const env = envValue?.trim().toLowerCase();
	if (env === "mcp-adapter" || env === "mcp_adapter" || env === "adapter") return "mcp-adapter";
	if (env === "native") return "native";
	const file =
		typeof fileValue === "string" ? fileValue.trim().toLowerCase().replace(/_/g, "-") : "";
	if (file === "mcp-adapter" || file === "adapter") return "mcp-adapter";
	return "native";
}

function resolveBool(
	envValue: string | undefined,
	fileValue: unknown,
	defaultValue: boolean,
): boolean {
	const fromEnv = envTruthy(envValue);
	if (fromEnv != null) return fromEnv;
	if (typeof fileValue === "boolean") return fileValue;
	if (typeof fileValue === "string") {
		const t = envTruthy(fileValue);
		if (t != null) return t;
	}
	return defaultValue;
}

/**
 * Load extension config. Safe to call from the factory (sync file read only).
 */
export function loadPiExtensionConfig(env: NodeJS.ProcessEnv = process.env): PiExtensionConfig {
	const file = readConfigFile();
	const piBlock =
		file.pi != null && typeof file.pi === "object" && !Array.isArray(file.pi)
			? (file.pi as Record<string, unknown>)
			: {};

	return {
		toolsMode: resolveToolsMode(piBlock.tools_mode ?? piBlock.toolsMode, env.CODEMEM_PI_TOOLS_MODE),
		injectPrompts: resolveBool(
			env.CODEMEM_PI_INJECT_PROMPTS ?? env.CODEMEM_INJECT_CONTEXT,
			piBlock.inject_prompts ?? piBlock.injectPrompts,
			DEFAULTS.injectPrompts,
		),
		fileContext: resolveBool(
			env.CODEMEM_PI_FILE_CONTEXT,
			piBlock.file_context ?? piBlock.fileContext,
			DEFAULTS.fileContext,
		),
		viewerHost: (env.CODEMEM_VIEWER_HOST || DEFAULTS.viewerHost).trim() || DEFAULTS.viewerHost,
		viewerPort: parsePositiveInt(env.CODEMEM_VIEWER_PORT, DEFAULTS.viewerPort),
		viewerEnabled: envNotDisabled(env.CODEMEM_VIEWER, DEFAULTS.viewerEnabled),
		viewerAutoStart: envNotDisabled(env.CODEMEM_VIEWER_AUTO, DEFAULTS.viewerAutoStart),
		rawEventsBackoffMs: parsePositiveInt(
			env.CODEMEM_RAW_EVENTS_BACKOFF_MS,
			DEFAULTS.rawEventsBackoffMs,
		),
		rawEventsStatusCheckMs: parsePositiveInt(
			env.CODEMEM_RAW_EVENTS_STATUS_CHECK_MS,
			DEFAULTS.rawEventsStatusCheckMs,
		),
		injectLimit: parsePositiveInt(env.CODEMEM_INJECT_LIMIT, DEFAULTS.injectLimit),
		injectTokenBudget: parsePositiveInt(
			env.CODEMEM_INJECT_TOKEN_BUDGET,
			DEFAULTS.injectTokenBudget,
		),
		injectMaxChars: parsePositiveInt(env.CODEMEM_INJECT_MAX_CHARS, DEFAULTS.injectMaxChars),
		httpTimeoutMs: parsePositiveInt(env.CODEMEM_PI_HOOK_HTTP_TIMEOUT_MS, DEFAULTS.httpTimeoutMs),
	};
}

/** Test helper: defaults without touching the filesystem. */
export function defaultPiExtensionConfig(
	overrides: Partial<PiExtensionConfig> = {},
): PiExtensionConfig {
	return { ...DEFAULTS, ...overrides };
}
