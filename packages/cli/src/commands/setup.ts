/**
 * codemem setup — one-command installation for OpenCode plugin + MCP config.
 *
 * Replaces Python's install_plugin_cmd + install_mcp_cmd.
 *
 * What it does:
 * 1. Adds "@codemem/opencode-plugin" to the plugin array in ~/.config/opencode/opencode.jsonc
 * 2. Adds/updates the MCP entry in ~/.config/opencode/opencode.jsonc
 * 3. For Claude Code: installs MCP config and guides marketplace plugin install
 * 4. For Codex: MCP + hooks via CODEX_HOME
 * 5. For pi: packages entry + observer derivation + optional MCP adapter surface
 *
 * Designed to be safe to run repeatedly (idempotent unless --force).
 */

import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import {
	describePiObserverStatus,
	readCodememConfigFile,
	resolvePiAgentDir,
	resolvePiObserverConfig,
	VERSION,
	writeCodememConfigFile,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	loadJsoncConfig,
	resolveOpencodeConfigPath,
	writeJsonConfig,
	writeJsonConfigWithBackup,
} from "./setup-config.js";

function opencodeConfigDir(): string {
	return join(homedir(), ".config", "opencode");
}

function claudeConfigDir(): string {
	return join(homedir(), ".claude");
}

/** Resolve the Codex home directory, honoring CODEX_HOME. */
export function codexConfigDir(): string {
	return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** Resolve the pi agent directory, honoring PI_CODING_AGENT_DIR. */
export function piConfigDir(): string {
	return resolvePiAgentDir();
}

/** The npm package name used in the OpenCode plugin array. */
const OPENCODE_PLUGIN_SPEC = "@codemem/opencode-plugin";
const LEGACY_OPENCODE_PLUGIN_SPECS = ["codemem", "@kunickiaj/codemem"];

/** npm packages: entry prefix for the pi extension (version is appended). */
const PI_EXTENSION_NPM_NAME = "@codemem/pi-extension";
const PI_EXTENSION_NPM_PREFIX = `npm:${PI_EXTENSION_NPM_NAME}@`;
const PI_MCP_ADAPTER_MARKER = "pi-mcp-adapter";

/** Codemem stdio MCP server entry written to pi's mcp.json under --pi-mcp. */
const PI_MCP_CODEMEM_ENTRY = {
	command: "npx",
	args: ["-y", "codemem", "mcp"],
} as const;

// ---------------------------------------------------------------------------
// Legacy migration helpers
// ---------------------------------------------------------------------------

/** Remove legacy copied plugin JS file from ~/.config/opencode/plugins/codemem.js */
function migrateLegacyOpencodePlugin(): void {
	const legacyPlugin = join(opencodeConfigDir(), "plugins", "codemem.js");
	const legacyCompat = join(opencodeConfigDir(), "lib", "compat.js");
	if (existsSync(legacyPlugin)) {
		try {
			rmSync(legacyPlugin);
			p.log.step("Removed legacy copied plugin: ~/.config/opencode/plugins/codemem.js");
		} catch {
			p.log.warn("Could not remove legacy plugin file — remove manually if needed");
		}
	}
	if (existsSync(legacyCompat)) {
		try {
			rmSync(legacyCompat);
			p.log.step("Removed legacy compat lib: ~/.config/opencode/lib/compat.js");
		} catch {
			// Non-fatal.
		}
	}
}

/** Detect and upgrade legacy uvx/uv-based MCP entries in OpenCode config. */
function migrateLegacyOpencodeMcp(config: Record<string, unknown>): boolean {
	const mcpConfig = config.mcp as Record<string, unknown> | undefined;
	if (!mcpConfig || typeof mcpConfig !== "object") return false;
	const entry = mcpConfig.codemem as Record<string, unknown> | undefined;
	if (!entry || typeof entry !== "object") return false;

	const command = entry.command;
	const isLegacy =
		(Array.isArray(command) &&
			command.some((arg) => typeof arg === "string" && (arg === "uvx" || arg === "uv"))) ||
		(typeof command === "string" && (command === "uvx" || command === "uv"));

	if (isLegacy) {
		p.log.step("Upgrading legacy uvx MCP entry to npx");
		mcpConfig.codemem = {
			type: "local",
			command: ["npx", "codemem", "mcp"],
			enabled: true,
		};
		return true;
	}
	return false;
}

/** Detect and upgrade legacy uvx-based MCP entries in Claude settings. */
function migrateLegacyClaudeMcp(settings: Record<string, unknown>): boolean {
	const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
	if (!mcpServers || typeof mcpServers !== "object") return false;
	const entry = mcpServers.codemem as Record<string, unknown> | undefined;
	if (!entry || typeof entry !== "object") return false;

	const command = entry.command;
	const args = entry.args;
	const isLegacy =
		(typeof command === "string" && (command === "uvx" || command === "uv")) ||
		(Array.isArray(args) &&
			args.some(
				(arg) => typeof arg === "string" && (arg.startsWith("codemem==") || arg === "uvx"),
			));

	if (isLegacy) {
		p.log.step("Upgrading legacy uvx Claude MCP entry to npx");
		mcpServers.codemem = {
			command: "npx",
			args: ["-y", "codemem", "mcp"],
		};
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Install functions
// ---------------------------------------------------------------------------

function installPlugin(force: boolean): boolean {
	// Clean up legacy copied plugin files first.
	migrateLegacyOpencodePlugin();

	const configPath = resolveOpencodeConfigPath(opencodeConfigDir());
	let config: Record<string, unknown>;
	try {
		config = loadJsoncConfig(configPath);
	} catch (err) {
		p.log.error(
			`Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	let plugins = config.plugin as unknown;
	if (!Array.isArray(plugins)) {
		plugins = [];
	}

	const isManagedPluginSpec = (entry: unknown): entry is string =>
		typeof entry === "string" &&
		[OPENCODE_PLUGIN_SPEC, ...LEGACY_OPENCODE_PLUGIN_SPECS].some(
			(spec) => entry === spec || entry.startsWith(`${spec}@`),
		);

	const hasCanonicalSpec = (plugins as string[]).some(
		(entry) =>
			typeof entry === "string" &&
			(entry === OPENCODE_PLUGIN_SPEC || entry.startsWith(`${OPENCODE_PLUGIN_SPEC}@`)),
	);
	const hasLegacySpec = (plugins as string[]).some(
		(entry) =>
			typeof entry === "string" &&
			LEGACY_OPENCODE_PLUGIN_SPECS.some((spec) => entry === spec || entry.startsWith(`${spec}@`)),
	);

	if (hasCanonicalSpec && !hasLegacySpec && !force) {
		p.log.info(`Plugin "${OPENCODE_PLUGIN_SPEC}" already in plugin array`);
		return true;
	}

	plugins = (plugins as string[]).filter((entry) => !isManagedPluginSpec(entry));
	if (hasLegacySpec) {
		p.log.step("Removed legacy OpenCode plugin spec(s): codemem / @kunickiaj/codemem");
	}

	(plugins as string[]).push(OPENCODE_PLUGIN_SPEC);
	config.plugin = plugins;

	try {
		writeJsonConfig(configPath, config);
		p.log.success(`Plugin "${OPENCODE_PLUGIN_SPEC}" added to ${configPath}`);
	} catch (err) {
		p.log.error(
			`Failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	return true;
}

function installMcp(force: boolean): boolean {
	const configPath = resolveOpencodeConfigPath(opencodeConfigDir());
	let config: Record<string, unknown>;
	try {
		config = loadJsoncConfig(configPath);
	} catch (err) {
		p.log.error(
			`Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	let mcpConfig = config.mcp as Record<string, unknown> | undefined;
	if (mcpConfig == null || typeof mcpConfig !== "object" || Array.isArray(mcpConfig)) {
		mcpConfig = {};
	}

	// Auto-upgrade legacy uvx-based MCP entries.
	const migrated = migrateLegacyOpencodeMcp(config);

	if ("codemem" in mcpConfig && !force && !migrated) {
		p.log.info(`MCP entry already exists in ${configPath}`);
		return true;
	}

	if (!migrated) {
		mcpConfig.codemem = {
			type: "local",
			command: ["npx", "codemem", "mcp"],
			enabled: true,
		};
		config.mcp = mcpConfig;
	}

	try {
		writeJsonConfig(configPath, config);
		p.log.success(`MCP entry installed: ${configPath}`);
	} catch (err) {
		p.log.error(
			`Failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	return true;
}

function isClaudeHooksPluginInstalled(): boolean {
	// Check if the marketplace hooks plugin is installed by looking for
	// the hooks directory — NOT for MCP config (which we write ourselves).
	const pluginDir = join(claudeConfigDir(), "plugins", "codemem");
	if (existsSync(pluginDir)) return true;
	// Also check for hook scripts installed by the marketplace plugin.
	const hooksJson = join(pluginDir, "hooks", "hooks.json");
	if (existsSync(hooksJson)) return true;
	return false;
}

function installClaudeMcp(force: boolean): boolean {
	const settingsPath = join(claudeConfigDir(), "settings.json");
	let settings: Record<string, unknown>;
	try {
		settings = loadJsoncConfig(settingsPath);
	} catch {
		settings = {};
	}

	let mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
	if (mcpServers == null || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
		mcpServers = {};
	}

	// Auto-upgrade legacy uvx-based Claude MCP entries.
	const migrated = migrateLegacyClaudeMcp(settings);

	if ("codemem" in mcpServers && !force && !migrated) {
		p.log.info(`Claude MCP entry already exists in ${settingsPath}`);
	} else {
		if (!migrated) {
			mcpServers.codemem = {
				command: "npx",
				args: ["-y", "codemem", "mcp"],
			};
			settings.mcpServers = mcpServers;
		}

		try {
			writeJsonConfig(settingsPath, settings);
			p.log.success(`Claude MCP entry installed: ${settingsPath}`);
		} catch (err) {
			p.log.error(
				`Failed to write ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	// Guide marketplace plugin install for hooks integration.
	if (!isClaudeHooksPluginInstalled() || force) {
		p.log.info("To install the Claude Code hooks plugin, run in Claude Code:");
		p.log.info("  /plugin marketplace add kunickiaj/codemem");
		p.log.info("  /plugin install codemem");
		p.log.info("");
		p.log.info("To update an existing install:");
		p.log.info("  /plugin marketplace update codemem-marketplace");
	} else {
		p.log.info("Claude Code hooks plugin appears to be installed");
	}

	return true;
}

// ---------------------------------------------------------------------------
// Codex install (direct config files — no marketplace plugin required)
// ---------------------------------------------------------------------------

/** The MCP server table appended to Codex config.toml. */
const CODEX_MCP_BLOCK = [
	"[mcp_servers.codemem]",
	'command = "npx"',
	'args = ["-y", "codemem", "mcp"]',
	"startup_timeout_sec = 30",
	"tool_timeout_sec = 60",
].join("\n");

// Detect an existing codemem MCP table in config.toml text. Tolerates TOML
// whitespace around brackets/dots and a quoted key, and avoids false-matching
// sibling tables like `[mcp_servers.codemem-foo]` (the optional quote is matched
// symmetrically via the backreference, so `codemem` must be followed by `]`).
const CODEX_MCP_TABLE_RE = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*("?)codemem\1[ \t]*\]/m;

/** A single Codex command-hook entry. */
interface CodexHookCommand {
	type: "command";
	command: string;
	timeout: number;
	statusMessage: string;
}

/** A matcher group containing an ordered list of command hooks. */
interface CodexHookGroup {
	hooks: CodexHookCommand[];
}

/** Marker substring identifying codemem-owned hook commands. */
const CODEMEM_HOOK_MARKER = "codemem codex-hook-";

/**
 * Resolve how Codex hooks should invoke codemem. Prefer a direct `codemem` call
 * when it's on PATH (fast — no per-hook resolution); fall back to `npx -y codemem`
 * only when codemem isn't installed (e.g. setup was run via `npx codemem setup`),
 * so capture/recall still work without a global install. Mirrors the plugin
 * wrapper's `codemem`-first / `npx` fallback model.
 */
export function codememCodexHookBase(): string {
	return codememOnPath() ? "codemem" : "npx -y codemem";
}

/**
 * Build the codemem-owned hook groups keyed by Codex event name, given the
 * resolved command base (`codemem` or `npx -y codemem`). Timeouts are ceilings,
 * not expected runtimes; npx gets more headroom to absorb a cold resolve.
 */
export function buildCodememCodexHookGroups(base: string): Record<string, CodexHookGroup[]> {
	const isNpx = base !== "codemem";
	const ingestTimeout = isNpx ? 30 : 10;
	const injectTimeout = isNpx ? 20 : 10;
	const ingest: CodexHookCommand = {
		type: "command",
		command: `${base} codex-hook-ingest`,
		timeout: ingestTimeout,
		statusMessage: "codemem",
	};
	return {
		SessionStart: [{ hooks: [{ ...ingest }] }],
		UserPromptSubmit: [
			{
				hooks: [
					{
						type: "command",
						command: `${base} codex-hook-ingest`,
						timeout: ingestTimeout,
						statusMessage: "codemem capture",
					},
					{
						type: "command",
						command: `${base} codex-hook-inject`,
						timeout: injectTimeout,
						statusMessage: "codemem recall",
					},
				],
			},
		],
		PostToolUse: [{ hooks: [{ ...ingest }] }],
		Stop: [{ hooks: [{ ...ingest }] }],
	};
}

/** True if a matcher group contains a codemem-owned hook command. */
function isCodememHookGroup(group: unknown): boolean {
	if (group == null || typeof group !== "object") return false;
	const hooks = (group as { hooks?: unknown }).hooks;
	if (!Array.isArray(hooks)) return false;
	return hooks.some(
		(h) =>
			h != null &&
			typeof h === "object" &&
			typeof (h as { command?: unknown }).command === "string" &&
			(h as { command: string }).command.includes(CODEMEM_HOOK_MARKER),
	);
}

/**
 * True if a resolved bin path is a transient npx/dlx cache bin. When setup runs
 * via `npx -y codemem setup --codex-only`, npx exposes this package's bin on PATH for
 * the duration of the run, then removes it — so Codex would later fail to find a
 * bare `codemem`. Such paths must NOT count as "on PATH" for hook command baking.
 */
export function isTransientNpxBinPath(resolved: string): boolean {
	return /[/\\]_npx[/\\]/.test(resolved) || /[/\\]\.pnpm[/\\]dlx[/\\]/.test(resolved);
}

/**
 * Detect whether a durable `codemem` resolves on PATH (excluding a transient
 * npx/dlx bin that vanishes after this process exits).
 */
function codememOnPath(): boolean {
	try {
		const out = execFileSync(process.platform === "win32" ? "where" : "which", ["codemem"], {
			encoding: "utf-8",
		});
		const resolved = out
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean);
		if (!resolved) return false;
		return !isTransientNpxBinPath(resolved);
	} catch {
		return false;
	}
}

/**
 * Append the codemem MCP server table to Codex config.toml without rewriting
 * unrelated content. Returns true on success.
 */
function installCodexMcp(codexHome: string, force: boolean): boolean {
	const configPath = join(codexHome, "config.toml");
	const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";

	if (CODEX_MCP_TABLE_RE.test(existing)) {
		if (force) {
			p.log.info(
				`Codex MCP entry already exists in ${configPath} — left as-is (TOML is not rewritten in place)`,
			);
		} else {
			p.log.info(`Codex MCP entry already exists in ${configPath}`);
		}
		return true;
	}

	// Back up an existing file before appending.
	if (existsSync(configPath)) {
		try {
			copyFileSync(configPath, `${configPath}.codemem.bak`);
		} catch {
			// Non-fatal: continue without a backup rather than blocking install.
		}
	}

	let next = existing;
	if (next.length > 0 && !next.endsWith("\n\n")) {
		next += next.endsWith("\n") ? "\n" : "\n\n";
	}
	next += `${CODEX_MCP_BLOCK}\n`;

	try {
		writeFileSync(configPath, next, "utf-8");
		p.log.success(`Codex MCP entry installed: ${configPath}`);
	} catch (err) {
		p.log.error(
			`Failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
	return true;
}

/**
 * Write/merge codemem hook registrations into Codex hooks.json, preserving any
 * unrelated user hooks. Returns true on success.
 */
function installCodexHooks(codexHome: string, force: boolean): boolean {
	const hooksPath = join(codexHome, "hooks.json");

	let config: Record<string, unknown> = {};
	if (existsSync(hooksPath)) {
		try {
			config = JSON.parse(readFileSync(hooksPath, "utf-8")) as Record<string, unknown>;
		} catch (err) {
			p.log.error(
				`Failed to parse ${hooksPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
			p.log.info(
				`Leaving ${hooksPath} untouched. Fix or remove the file, then re-run \`codemem setup --codex-only\`.`,
			);
			return false;
		}
	}

	let hooks = config.hooks as Record<string, unknown> | undefined;
	if (hooks == null || typeof hooks !== "object" || Array.isArray(hooks)) {
		hooks = {};
	}

	const ours = buildCodememCodexHookGroups(codememCodexHookBase());
	let changed = false;

	for (const [event, ourGroups] of Object.entries(ours)) {
		const current = hooks[event];
		const existingGroups: unknown[] = Array.isArray(current) ? [...current] : [];
		const hasCodemem = existingGroups.some(isCodememHookGroup);

		if (hasCodemem && !force) {
			// Already present — leave as-is (idempotent).
			continue;
		}

		// Drop only codemem-owned groups; preserve unrelated user hooks.
		const preserved = existingGroups.filter((g) => !isCodememHookGroup(g));
		hooks[event] = [...preserved, ...ourGroups];
		changed = true;
	}

	if (!changed && !force) {
		p.log.info(`Codex hooks already configured in ${hooksPath}`);
		config.hooks = hooks;
		return true;
	}

	config.hooks = hooks;

	// Back up an existing hooks.json before overwriting.
	if (existsSync(hooksPath)) {
		try {
			copyFileSync(hooksPath, `${hooksPath}.codemem.bak`);
		} catch {
			// Non-fatal.
		}
	}

	try {
		mkdirSync(codexHome, { recursive: true });
		writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
		p.log.success(`Codex hooks installed: ${hooksPath}`);
	} catch (err) {
		p.log.error(
			`Failed to write ${hooksPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
	return true;
}

/**
 * Configure Codex via direct config files (MCP in config.toml + hooks in
 * hooks.json) without relying on the Codex plugin marketplace. Idempotent;
 * honors CODEX_HOME. Returns true on success.
 */
export function installCodex(force: boolean): boolean {
	const codexHome = codexConfigDir();
	try {
		mkdirSync(codexHome, { recursive: true });
	} catch (err) {
		p.log.error(
			`Failed to create Codex home ${codexHome}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	if (codememOnPath()) {
		p.log.info("Codex hooks will call `codemem` directly (found on PATH).");
	} else {
		p.log.info(
			"`codemem` is not on PATH, so Codex hooks will run via `npx -y codemem` (works without a global install). For lower hook latency: npm i -g codemem",
		);
	}

	let ok = true;
	ok = installCodexMcp(codexHome, force) && ok;
	ok = installCodexHooks(codexHome, force) && ok;
	return ok;
}

// ---------------------------------------------------------------------------
// Pi install (packages entry + observer derivation + optional MCP adapter)
// ---------------------------------------------------------------------------

export type InstallPiOptions = {
	force?: boolean;
	/** Opt into writing pi mcp.json + flipping pi.tools_mode to mcp-adapter. */
	piMcp?: boolean;
	/** Absolute (or cwd-resolved) local path written instead of the npm packages spec. */
	piExtensionPath?: string;
};

/** Build the packages: entry for the pi extension (npm pin or local path). */
export function buildPiExtensionPackageSpec(
	extensionPath?: string,
	version: string = VERSION,
): string {
	if (extensionPath?.trim()) {
		const raw = extensionPath.trim();
		return isAbsolute(raw) ? raw : resolve(raw);
	}
	return `${PI_EXTENSION_NPM_PREFIX}${version}`;
}

/** True when a packages: entry refers to @codemem/pi-extension (any version/path form). */
export function isPiExtensionPackageEntry(entry: unknown): boolean {
	if (typeof entry !== "string" || !entry.trim()) return false;
	const value = entry.trim();
	if (value === `npm:${PI_EXTENSION_NPM_NAME}` || value.startsWith(PI_EXTENSION_NPM_PREFIX)) {
		return true;
	}
	if (value === PI_EXTENSION_NPM_NAME || value.startsWith(`${PI_EXTENSION_NPM_NAME}@`)) {
		return true;
	}
	// Local-path dogfood entries end with the package folder name.
	return (
		/(?:^|[/\\])@codemem[/\\]pi-extension(?:[/\\]|$)/.test(value) ||
		/(?:^|[/\\])packages[/\\]pi-extension(?:[/\\]|$)/.test(value)
	);
}

/** True when entry is an npm: pin for @codemem/pi-extension (versioned or bare). */
function isNpmPiExtensionPackageEntry(entry: unknown): boolean {
	if (typeof entry !== "string" || !entry.trim()) return false;
	const value = entry.trim();
	return value === `npm:${PI_EXTENSION_NPM_NAME}` || value.startsWith(PI_EXTENSION_NPM_PREFIX);
}

function piBinaryOnPath(): boolean {
	try {
		const out = execFileSync(process.platform === "win32" ? "where" : "which", ["pi"], {
			encoding: "utf-8",
		});
		return Boolean(
			out
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find(Boolean),
		);
	} catch {
		return false;
	}
}

/** True when path exists and has non-whitespace content (real install marker). */
function isNonEmptyFile(path: string): boolean {
	try {
		if (!existsSync(path)) return false;
		return readFileSync(path, "utf-8").trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * Detect pi via `pi` on PATH, or an agent dir that contains real install
 * markers (non-empty settings.json or auth.json). A bare empty ~/.pi/agent
 * directory must not count — users (and tests) create that path incidentally.
 * Honors PI_CODING_AGENT_DIR.
 */
export function isPiDetected(): boolean {
	if (piBinaryOnPath()) return true;
	const dir = piConfigDir();
	if (!existsSync(dir)) return false;
	return isNonEmptyFile(join(dir, "settings.json")) || isNonEmptyFile(join(dir, "auth.json"));
}

/** Detect pi-mcp-adapter via packages: entry or extensions/ directory name. */
export function isPiMcpAdapterDetected(piDir: string = piConfigDir()): boolean {
	const settingsPath = join(piDir, "settings.json");
	if (existsSync(settingsPath)) {
		try {
			const settings = loadJsoncConfig(settingsPath);
			const packages = settings.packages;
			if (Array.isArray(packages)) {
				const found = packages.some(
					(entry) => typeof entry === "string" && entry.includes(PI_MCP_ADAPTER_MARKER),
				);
				if (found) return true;
			}
		} catch {
			// Fall through to extensions/ probe; parse failure is handled at write time.
		}
	}

	const extensionsDir = join(piDir, "extensions");
	if (!existsSync(extensionsDir)) return false;
	try {
		const entries = readdirSync(extensionsDir, { withFileTypes: true });
		return entries.some((entry) => {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
			const name = entry.name.toLowerCase();
			return name.includes("mcp-adapter") || name.includes("mcp_adapter");
		});
	} catch {
		return false;
	}
}

/**
 * Idempotently ensure the pi extension packages: entry is present in
 * settings.json. Backs up before write; aborts on parse failure.
 */
function installPiExtensionPackage(piDir: string, force: boolean, extensionPath?: string): boolean {
	const settingsPath = join(piDir, "settings.json");
	const desired = buildPiExtensionPackageSpec(extensionPath);

	let settings: Record<string, unknown>;
	if (existsSync(settingsPath)) {
		try {
			settings = loadJsoncConfig(settingsPath);
		} catch (err) {
			p.log.error(
				`Failed to parse ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
			p.log.info(
				`Leaving ${settingsPath} untouched. Fix or remove the file, then re-run \`codemem setup --pi-only\`.`,
			);
			return false;
		}
	} else {
		settings = {};
	}

	let packages = settings.packages as unknown;
	if (!Array.isArray(packages)) {
		packages = [];
	}

	const list = packages as unknown[];
	const existingIdx = list.findIndex((entry) => isPiExtensionPackageEntry(entry));
	const existing = existingIdx >= 0 ? list[existingIdx] : undefined;

	if (existing != null && !force) {
		// Equal pin → no-op. Stale npm version pin → fall through and upgrade.
		// Local-path / non-npm entries are never touched without --force.
		const shouldUpgrade = isNpmPiExtensionPackageEntry(existing) && existing !== desired;
		if (!shouldUpgrade) {
			p.log.info(`Pi extension package already configured in ${settingsPath}`);
			return true;
		}
	}

	const next = list.filter((entry) => !isPiExtensionPackageEntry(entry));
	next.push(desired);
	settings.packages = next;

	try {
		mkdirSync(piDir, { recursive: true });
		writeJsonConfigWithBackup(settingsPath, settings);
		p.log.success(
			existing != null
				? `Pi extension package updated: ${desired}`
				: `Pi extension package added: ${desired}`,
		);
	} catch (err) {
		p.log.error(
			`Failed to write ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
	return true;
}

/**
 * Derive unset observer_* keys from pi config and ensure pi.tools_mode default.
 * Never persists API keys or tokens from pi auth.
 */
function wirePiCodememConfig(opts: { toolsMode: "native" | "mcp-adapter" }): boolean {
	let existing: Record<string, unknown>;
	try {
		existing = readCodememConfigFile();
	} catch (err) {
		p.log.error(
			`Failed to read codemem config: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	const next: Record<string, unknown> = { ...existing };
	const updated: string[] = [];

	// Nested pi.* block (tools_mode).
	const existingPi =
		existing.pi != null && typeof existing.pi === "object" && !Array.isArray(existing.pi)
			? { ...(existing.pi as Record<string, unknown>) }
			: {};
	const piBlock = { ...existingPi };
	if (opts.toolsMode === "mcp-adapter") {
		if (piBlock.tools_mode !== "mcp-adapter") {
			piBlock.tools_mode = "mcp-adapter";
			updated.push("pi.tools_mode");
		}
	} else if (piBlock.tools_mode == null || piBlock.tools_mode === "") {
		piBlock.tools_mode = "native";
		updated.push("pi.tools_mode");
	}
	next.pi = piBlock;

	// Observer derivation — only fill unset keys; never copy secrets.
	// Key names match ObserverClient config mappings in packages/core/src/observer-client.ts
	// (observer_provider / observer_model / observer_base_url / observer_openai_use_responses).
	const envProvider = process.env.CODEMEM_OBSERVER_PROVIDER?.trim();
	const envModel = process.env.CODEMEM_OBSERVER_MODEL?.trim();
	const envBaseUrl = process.env.CODEMEM_OBSERVER_BASE_URL?.trim();
	const envUseResponses = process.env.CODEMEM_OBSERVER_OPENAI_USE_RESPONSES?.trim();

	const fileProvider =
		typeof existing.observer_provider === "string" ? existing.observer_provider.trim() : "";
	const fileModel =
		typeof existing.observer_model === "string" ? existing.observer_model.trim() : "";
	const fileBaseUrl =
		typeof existing.observer_base_url === "string" ? existing.observer_base_url.trim() : "";
	// Boolean file key: present (true/false) counts as set; absent/null is unset.
	const fileHasUseResponses = existing.observer_openai_use_responses != null;

	const needsProvider = !envProvider && !fileProvider;
	const needsModel = !envModel && !fileModel;
	const needsBaseUrl = !envBaseUrl && !fileBaseUrl;
	const needsUseResponses = !envUseResponses && !fileHasUseResponses;

	if (needsProvider || needsModel || needsBaseUrl || needsUseResponses) {
		const resolved = resolvePiObserverConfig();
		p.log.info(`Pi observer: ${describePiObserverStatus(resolved)}`);
		if (resolved.ok) {
			if (needsProvider) {
				next.observer_provider = resolved.provider;
				updated.push("observer_provider");
			}
			if (needsModel) {
				next.observer_model = resolved.model;
				updated.push("observer_model");
			}
			if (needsBaseUrl && resolved.baseUrl) {
				next.observer_base_url = resolved.baseUrl;
				updated.push("observer_base_url");
			}
			// Persist wire-transport flag so openai-responses providers keep Responses API
			// (ObserverClient reads observer_openai_use_responses / CODEMEM_OBSERVER_OPENAI_USE_RESPONSES).
			if (needsUseResponses) {
				next.observer_openai_use_responses = resolved.openAIUseResponses;
				updated.push("observer_openai_use_responses");
			}
			// Intentionally never write resolved.apiKey (or any credential).
		} else if (!fileProvider && !fileModel && !envProvider && !envModel) {
			p.log.info(
				"Extraction model left unconfigured — set observer_provider/observer_model when ready.",
			);
		}
	} else {
		p.log.info("Existing codemem observer config left unchanged");
	}

	// Never introduce credentials. `next` started as a shallow copy of `existing`,
	// so a pre-existing user-supplied observer_api_key is preserved untouched;
	// resolvePiObserverConfig's apiKey is intentionally never copied here.
	if (updated.length === 0) {
		return true;
	}

	try {
		const saved = writeCodememConfigFile(next);
		p.log.success(`Codemem config updated (${updated.join(", ")}): ${saved}`);
	} catch (err) {
		p.log.error(
			`Failed to write codemem config: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
	return true;
}

/**
 * Opt-in MCP surface for pi via pi-mcp-adapter. Writes mcp.json only when the
 * adapter is detected; otherwise explains the prerequisite and writes nothing.
 */
function installPiMcp(
	piDir: string,
	force: boolean,
): {
	ok: boolean;
	wrote: boolean;
	adapterPresent: boolean;
} {
	const adapterPresent = isPiMcpAdapterDetected(piDir);
	if (!adapterPresent) {
		p.log.warn(
			"MCP in pi requires the pi-mcp-adapter package. Install it (e.g. `pi install npm:pi-mcp-adapter`), then re-run `codemem setup --pi-only --pi-mcp`.",
		);
		return { ok: true, wrote: false, adapterPresent: false };
	}

	const mcpPath = join(piDir, "mcp.json");
	let mcp: Record<string, unknown>;
	if (existsSync(mcpPath)) {
		try {
			mcp = loadJsoncConfig(mcpPath);
		} catch (err) {
			p.log.error(
				`Failed to parse ${mcpPath}: ${err instanceof Error ? err.message : String(err)}`,
			);
			p.log.info(
				`Leaving ${mcpPath} untouched. Fix or remove the file, then re-run with --pi-mcp.`,
			);
			return { ok: false, wrote: false, adapterPresent: true };
		}
	} else {
		mcp = {};
	}

	let servers = mcp.mcpServers as Record<string, unknown> | undefined;
	if (servers == null || typeof servers !== "object" || Array.isArray(servers)) {
		servers = {};
	}

	if ("codemem" in servers && !force) {
		p.log.info(`Pi MCP entry already exists in ${mcpPath}`);
		return { ok: true, wrote: false, adapterPresent: true };
	}

	servers.codemem = { ...PI_MCP_CODEMEM_ENTRY };
	mcp.mcpServers = servers;

	try {
		mkdirSync(piDir, { recursive: true });
		writeJsonConfigWithBackup(mcpPath, mcp);
		p.log.success(`Pi MCP entry installed: ${mcpPath}`);
	} catch (err) {
		p.log.error(`Failed to write ${mcpPath}: ${err instanceof Error ? err.message : String(err)}`);
		return { ok: false, wrote: false, adapterPresent: true };
	}
	return { ok: true, wrote: true, adapterPresent: true };
}

/**
 * Configure pi: packages entry, observer derivation, optional MCP adapter surface.
 * Idempotent; honors PI_CODING_AGENT_DIR. Returns true on success.
 */
export function installPi(options: InstallPiOptions = {}): boolean {
	const force = options.force ?? false;
	const piDir = piConfigDir();

	try {
		mkdirSync(piDir, { recursive: true });
	} catch (err) {
		p.log.error(
			`Failed to create pi agent dir ${piDir}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	p.log.info(`Pi agent directory: ${piDir}`);

	// Packages entry is required; abort the rest on parse/write failure so we
	// never partially configure observer/MCP against a broken settings.json.
	if (!installPiExtensionPackage(piDir, force, options.piExtensionPath)) {
		return false;
	}

	let ok = true;
	let toolsMode: "native" | "mcp-adapter" = "native";
	if (options.piMcp) {
		const mcpResult = installPiMcp(piDir, force);
		ok = mcpResult.ok && ok;
		if (mcpResult.adapterPresent && mcpResult.ok) {
			// Adapter present: flip tools_mode even when the mcp entry was already there.
			toolsMode = "mcp-adapter";
		}
	}
	// Default run writes no MCP config (spec: opt-in only).

	ok = wirePiCodememConfig({ toolsMode }) && ok;

	if (ok) {
		p.log.info("Pi next steps:");
		p.log.info("  - Start (or restart) pi to load the extension package");
		if (!options.piMcp) {
			p.log.info("  - Optional MCP surface: install pi-mcp-adapter, then re-run with --pi-mcp");
		}
		p.log.info(
			"  - To disable: remove the @codemem/pi-extension entry from pi settings.json packages",
		);
	}

	return ok;
}

export const setupCommand = new Command("setup")
	.configureHelp(helpStyle)
	.description("Install codemem plugin + MCP config for OpenCode, Claude Code, Codex, and pi")
	.option("--force", "overwrite existing installations")
	.option("--opencode-only", "only install for OpenCode")
	.option("--claude-only", "only install for Claude Code")
	.option("--codex-only", "only install for Codex")
	.option("--pi-only", "only install for pi")
	.option("--pi-mcp", "opt into pi MCP adapter surface (requires pi-mcp-adapter)")
	.option(
		"--pi-extension-path <path>",
		"dev: write a local path packages entry instead of the npm pin",
	)
	.action(
		(opts: {
			force?: boolean;
			opencodeOnly?: boolean;
			claudeOnly?: boolean;
			codexOnly?: boolean;
			piOnly?: boolean;
			piMcp?: boolean;
			piExtensionPath?: string;
		}) => {
			p.intro(`codemem setup v${VERSION}`);
			const force = opts.force ?? false;
			let ok = true;

			const onlyFlag = Boolean(
				opts.opencodeOnly || opts.claudeOnly || opts.codexOnly || opts.piOnly,
			);

			const doOpencode = opts.opencodeOnly || !onlyFlag;
			const doClaude = opts.claudeOnly || !onlyFlag;
			// With no only-flag, Codex runs only when a Codex home is detected.
			const doCodex = opts.codexOnly || (!onlyFlag && existsSync(codexConfigDir()));
			// With no only-flag, pi runs only when pi is detected (PATH or agent dir).
			const doPi = opts.piOnly || (!onlyFlag && isPiDetected());

			if (doOpencode) {
				p.log.step("Installing OpenCode plugin...");
				ok = installPlugin(force) && ok;
				p.log.step("Installing OpenCode MCP config...");
				ok = installMcp(force) && ok;
			}

			if (doClaude) {
				p.log.step("Installing Claude Code MCP config...");
				ok = installClaudeMcp(force) && ok;
			}

			if (doCodex) {
				p.log.step("Configuring Codex (MCP + hooks)...");
				ok = installCodex(force) && ok;
				p.log.info("Codex next steps:");
				p.log.info("  - Restart Codex to load the new configuration");
				p.log.info("  - On first run, approve the one-time prompt to trust the codemem hooks");
				p.log.info("  - MCP recall works immediately (no trust prompt required)");
			}

			if (doPi) {
				p.log.step("Configuring pi (extension package + observer)...");
				ok =
					installPi({
						force,
						piMcp: opts.piMcp,
						piExtensionPath: opts.piExtensionPath,
					}) && ok;
			}

			if (ok) {
				p.outro("Setup complete — restart your editor to load the plugin");
			} else {
				p.outro("Setup completed with warnings");
				process.exitCode = 1;
			}
		},
	);
