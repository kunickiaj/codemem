/**
 * codemem setup — one-command installation for OpenCode plugin + MCP config.
 *
 * Replaces Python's install_plugin_cmd + install_mcp_cmd.
 *
 * What it does:
 * 1. Adds "@codemem/opencode-plugin" to the plugin array in ~/.config/opencode/opencode.jsonc
 * 2. Adds/updates the MCP entry in ~/.config/opencode/opencode.jsonc
 * 3. For Claude Code: installs MCP config and guides marketplace plugin install
 *
 * Designed to be safe to run repeatedly (idempotent unless --force).
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { VERSION } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { loadJsoncConfig, resolveOpencodeConfigPath, writeJsonConfig } from "./setup-config.js";

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

/** The npm package name used in the OpenCode plugin array. */
const OPENCODE_PLUGIN_SPEC = "@codemem/opencode-plugin";
const LEGACY_OPENCODE_PLUGIN_SPECS = ["codemem", "@kunickiaj/codemem"];

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

function isExactStringArray(value: unknown, expected: string[]): boolean {
	return (
		Array.isArray(value) &&
		value.length === expected.length &&
		value.every((entry, index) => entry === expected[index])
	);
}

/** Detect and upgrade legacy uvx/uv or managed single-package MCP entries in OpenCode config. */
export function migrateLegacyOpencodeMcp(config: Record<string, unknown>): boolean {
	const mcpConfig = config.mcp as Record<string, unknown> | undefined;
	if (!mcpConfig || typeof mcpConfig !== "object") return false;
	const entry = mcpConfig.codemem as Record<string, unknown> | undefined;
	if (!entry || typeof entry !== "object") return false;

	const command = entry.command;
	const isLegacyUv =
		(Array.isArray(command) &&
			command.some((arg) => typeof arg === "string" && (arg === "uvx" || arg === "uv"))) ||
		(typeof command === "string" && (command === "uvx" || command === "uv"));
	const isManagedSinglePackageNpx =
		isExactStringArray(command, ["npx", "-y", "codemem", "mcp"]) ||
		isExactStringArray(command, ["npx", "codemem", "mcp"]);

	if (isLegacyUv || isManagedSinglePackageNpx) {
		p.log.step("Upgrading managed MCP entry to the current npm launcher");
		const launcher = codememMcpLauncher();
		mcpConfig.codemem = {
			...entry,
			command: [launcher.command, ...launcher.args],
		};
		return true;
	}
	return false;
}

/** Detect and upgrade legacy uvx or managed single-package MCP entries in Claude settings. */
export function migrateLegacyClaudeMcp(settings: Record<string, unknown>): boolean {
	const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
	if (!mcpServers || typeof mcpServers !== "object") return false;
	const entry = mcpServers.codemem as Record<string, unknown> | undefined;
	if (!entry || typeof entry !== "object") return false;

	const command = entry.command;
	const args = entry.args;
	const isLegacyUv =
		(typeof command === "string" && (command === "uvx" || command === "uv")) ||
		(Array.isArray(args) &&
			args.some(
				(arg) => typeof arg === "string" && (arg.startsWith("codemem==") || arg === "uvx"),
			));
	const isManagedSinglePackageNpx =
		command === "npx" && isExactStringArray(args, ["-y", "codemem", "mcp"]);

	if (isLegacyUv || isManagedSinglePackageNpx) {
		p.log.step("Upgrading managed Claude MCP entry to the current npm launcher");
		const launcher = codememMcpLauncher();
		mcpServers.codemem = {
			...entry,
			command: launcher.command,
			args: launcher.args,
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
		const launcher = codememMcpLauncher();
		mcpConfig.codemem = {
			type: "local",
			command: [launcher.command, ...launcher.args],
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
			const launcher = codememMcpLauncher();
			mcpServers.codemem = {
				command: launcher.command,
				args: launcher.args,
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
function codexMcpBlock(): string {
	const launcher = codememMcpLauncher();
	const args = launcher.args.map((arg) => JSON.stringify(arg)).join(", ");
	return [
		"[mcp_servers.codemem]",
		`command = ${JSON.stringify(launcher.command)}`,
		`args = [${args}]`,
		"startup_timeout_sec = 30",
		"tool_timeout_sec = 60",
	].join("\n");
}

// Detect an existing codemem MCP table in config.toml text. Tolerates TOML
// whitespace around brackets/dots and a quoted key, and avoids false-matching
// sibling tables like `[mcp_servers.codemem-foo]` (the optional quote is matched
// symmetrically via the backreference, so `codemem` must be followed by `]`).
const CODEX_MCP_TABLE_RE = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*("?)codemem\1[ \t]*\]/m;

function migrateManagedCodexMcp(existing: string): string | null {
	const tableMatch = CODEX_MCP_TABLE_RE.exec(existing);
	if (!tableMatch || tableMatch.index == null) return null;
	const blockStart = tableMatch.index;
	const nextTable = /^[ \t]*\[/gm;
	nextTable.lastIndex = blockStart + tableMatch[0].length;
	const nextMatch = nextTable.exec(existing);
	const blockEnd = nextMatch?.index ?? existing.length;
	const block = existing.slice(blockStart, blockEnd);
	const commandPattern = /^([ \t]*command[ \t]*=[ \t]*)"npx"([ \t]*(?:#.*)?)$/m;
	const argsPattern =
		/^([ \t]*args[ \t]*=[ \t]*)\[[ \t]*"-y"[ \t]*,[ \t]*"codemem"[ \t]*,[ \t]*"mcp"[ \t]*\]([ \t]*(?:#.*)?)$/m;
	if (!commandPattern.test(block) || !argsPattern.test(block)) return null;

	const launcher = codememMcpLauncher();
	const args = launcher.args.map((arg) => JSON.stringify(arg)).join(", ");
	const migrated = block
		.replace(commandPattern, `$1${JSON.stringify(launcher.command)}$2`)
		.replace(argsPattern, `$1[${args}]$2`);
	return `${existing.slice(0, blockStart)}${migrated}${existing.slice(blockEnd)}`;
}

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
 * when it's on PATH (fast — no per-hook resolution); fall back to an `npx`
 * invocation that requests both `codemem` and `@codemem/embeddings` when codemem
 * isn't installed (e.g. setup was run via `npx codemem setup`). The paired
 * runtime keeps the local-store inject path (codex-hook-inject) able to embed
 * instead of degrading to FTS. Mirrors the MCP launcher's two-package model.
 */
export function codememCodexHookBase(): string {
	if (codememOnPath(true)) return "codemem";
	return "npx -y --package codemem --package @codemem/embeddings codemem";
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
 * True if a resolved bin path is a transient/project-local bin that will not be
 * on PATH for the globally-configured MCP hosts (OpenCode/Claude/Codex).
 *
 * - `_npx` / `.pnpm/dlx`: npx/dlx caches exposed only for the duration of a
 *   `npx -y codemem setup` run, then removed.
 * - `node_modules/.bin`: a project-local install exposed only while setup runs
 *   through `npm exec` / `pnpm exec` / a package script. The global hosts do not
 *   inherit that project-local PATH, so baking a bare `codemem` command would
 *   later fail to resolve.
 *
 * Such paths must NOT count as "on PATH" for launcher/hook command baking.
 */
export function isTransientNpxBinPath(resolved: string): boolean {
	return (
		/[/\\]_npx[/\\]/.test(resolved) ||
		/[/\\]\.pnpm[/\\]dlx[/\\]/.test(resolved) ||
		/[/\\]node_modules[/\\]\.bin[/\\]/.test(resolved)
	);
}

/** Parse a semver core (major.minor.patch) plus optional prerelease tail. */
function parseSetupSemver(
	version: string,
): { core: [number, number, number]; prerelease: boolean } | null {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version.trim());
	if (!match) return null;
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: version.includes("-"),
	};
}

/**
 * True when a durable `codemem --version` output should be trusted to launch
 * `codemem mcp` directly. Mirrors the OpenCode plugin's runner check: accept the
 * exact build version, or a clean (non-prerelease) release at least as new as
 * this build. This prevents baking a bare launcher that later resolves to an
 * older global install sitting alongside the transient npx bin.
 */
function isDurableCodememVersionTrusted(versionOutput: string): boolean {
	if (versionOutput === VERSION) return true;
	const candidate = parseSetupSemver(versionOutput);
	const current = parseSetupSemver(VERSION);
	if (!candidate || !current || candidate.prerelease) return false;
	for (let i = 0; i < 3; i++) {
		const c = candidate.core[i] ?? 0;
		const v = current.core[i] ?? 0;
		if (c > v) return true;
		if (c < v) return false;
	}
	return true;
}

/**
 * Detect whether a durable `codemem` resolves on PATH (excluding a transient
 * npx/dlx bin that vanishes after this process exits). When `requireTrustedVersion`
 * is set, the durable binary must also report a version compatible with this
 * build before it is trusted, so setup never bakes a bare launcher that resolves
 * to a stale global install.
 */
function codememOnPath(requireTrustedVersion = false): boolean {
	try {
		const command = process.platform === "win32" ? "where" : "which";
		const args = process.platform === "win32" ? ["codemem"] : ["-a", "codemem"];
		const out = execFileSync(command, args, { encoding: "utf-8" });
		const durable = out
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.filter((candidate) => !isTransientNpxBinPath(candidate));
		if (durable.length === 0) return false;
		if (!requireTrustedVersion) return true;
		// Validate only the FIRST durable candidate: once the transient npx bin
		// disappears, shell resolution runs that binary, so a later trusted
		// install must not authorize baking a bare launcher that would instead
		// execute an earlier, stale durable install.
		const [firstDurable] = durable;
		if (firstDurable == null) return false;
		const version = probeDurableCodememVersion(firstDurable);
		return version != null && isDurableCodememVersionTrusted(version);
	} catch {
		return false;
	}
}

/**
 * Run `<binary> --version`, returning trimmed stdout or null on failure. On
 * Windows a global npm install resolves to a `.cmd`/`.bat` shim that Node's
 * shell-less execFileSync cannot execute directly, so invoke it through
 * `cmd.exe /c` there; POSIX binaries run directly.
 */
function probeDurableCodememVersion(binaryPath: string): string | null {
	try {
		const output =
			process.platform === "win32"
				? execFileSync("cmd.exe", ["/c", binaryPath, "--version"], {
						encoding: "utf-8",
						timeout: 3000,
						stdio: ["ignore", "pipe", "ignore"],
					})
				: execFileSync(binaryPath, ["--version"], {
						encoding: "utf-8",
						timeout: 3000,
						stdio: ["ignore", "pipe", "ignore"],
					});
		return output.trim();
	} catch {
		return null;
	}
}

export function codememMcpLauncher(onPath = codememOnPath(true)): {
	command: string;
	args: string[];
} {
	return onPath
		? { command: "codemem", args: ["mcp"] }
		: {
				command: "npx",
				args: ["-y", "--package", "codemem", "--package", "@codemem/embeddings", "codemem", "mcp"],
			};
}

/**
 * Append the codemem MCP server table to Codex config.toml without rewriting
 * unrelated content. Returns true on success.
 */
function installCodexMcp(codexHome: string, force: boolean): boolean {
	const configPath = join(codexHome, "config.toml");
	const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";

	if (CODEX_MCP_TABLE_RE.test(existing)) {
		const migrated = migrateManagedCodexMcp(existing);
		if (migrated != null) {
			try {
				copyFileSync(configPath, `${configPath}.codemem.bak`);
			} catch {
				// Non-fatal: continue without a backup rather than blocking migration.
			}
			try {
				writeFileSync(configPath, migrated, "utf-8");
				p.log.success(`Codex MCP entry upgraded: ${configPath}`);
				return true;
			} catch (err) {
				p.log.error(
					`Failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
				);
				return false;
			}
		}
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
	next += `${codexMcpBlock()}\n`;

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

	const hookBase = codememCodexHookBase();
	const ours = buildCodememCodexHookGroups(hookBase);
	// The exact command strings the current base produces. A previously generated
	// hook whose commands differ (e.g. an old single-package `npx -y codemem
	// codex-hook-*` before the embedding-runtime split) must be migrated even on a
	// non-force rerun, so compatibility fallback keeps semantic retrieval.
	const currentCommands = new Set(
		Object.values(ours).flatMap((groups) =>
			groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
		),
	);
	const groupNeedsMigration = (group: unknown): boolean => {
		if (!isCodememHookGroup(group)) return false;
		const hooksList = (group as { hooks?: unknown }).hooks;
		if (!Array.isArray(hooksList)) return false;
		// Only inspect codemem-OWNED commands (marker-bearing). An unrelated user
		// command sharing the group must not, by being absent from currentCommands,
		// mark the whole group stale — that would drop the user's hook on a plain
		// rerun. A codemem command that no longer matches the current base is stale.
		return hooksList.some((hook) => {
			if (hook == null || typeof hook !== "object") return false;
			const command = (hook as { command?: unknown }).command;
			if (typeof command !== "string") return false;
			return command.includes(CODEMEM_HOOK_MARKER) && !currentCommands.has(command);
		});
	};
	let changed = false;

	const isCodememOwnedHook = (hook: unknown): boolean =>
		hook != null &&
		typeof hook === "object" &&
		typeof (hook as { command?: unknown }).command === "string" &&
		(hook as { command: string }).command.includes(CODEMEM_HOOK_MARKER);

	// Remove codemem-owned commands from a group while preserving any unrelated
	// user hooks. Returns null when the group has no non-codemem hooks left.
	const stripCodememHooks = (group: unknown): unknown => {
		if (!isCodememHookGroup(group)) return group;
		const hooksList = (group as { hooks?: unknown }).hooks;
		if (!Array.isArray(hooksList)) return null;
		const preservedHooks = hooksList.filter((hook) => !isCodememOwnedHook(hook));
		if (preservedHooks.length === 0) return null;
		return { ...(group as Record<string, unknown>), hooks: preservedHooks };
	};

	for (const [event, ourGroups] of Object.entries(ours)) {
		const current = hooks[event];
		const existingGroups: unknown[] = Array.isArray(current) ? [...current] : [];
		const hasCodemem = existingGroups.some(isCodememHookGroup);
		const needsMigration = existingGroups.some(groupNeedsMigration);

		if (hasCodemem && !force && !needsMigration) {
			// Already present with the current command base — leave as-is.
			continue;
		}

		// Preserve unrelated user hooks, including any that share a group with a
		// codemem command, then append our current codemem groups.
		const preserved = existingGroups
			.map((group) => stripCodememHooks(group))
			.filter((group) => group != null);
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

	if (codememOnPath(true)) {
		p.log.info("Codex hooks will call `codemem` directly (found on PATH).");
	} else {
		const globalInstallCommand =
			process.platform === "linux"
				? "env ONNXRUNTIME_NODE_INSTALL=skip npm install -g codemem @codemem/embeddings"
				: "npm install -g codemem @codemem/embeddings";
		p.log.info(
			`\`codemem\` is not on PATH, so Codex hooks will run via \`npx -y --package codemem --package @codemem/embeddings codemem\` (works without a global install). For lower hook latency: ${globalInstallCommand}`,
		);
	}

	let ok = true;
	ok = installCodexMcp(codexHome, force) && ok;
	ok = installCodexHooks(codexHome, force) && ok;
	return ok;
}

export const setupCommand = new Command("setup")
	.configureHelp(helpStyle)
	.description("Install codemem plugin + MCP config for OpenCode and Claude Code")
	.option("--force", "overwrite existing installations")
	.option("--opencode-only", "only install for OpenCode")
	.option("--claude-only", "only install for Claude Code")
	.option("--codex-only", "only install for Codex")
	.action(
		(opts: {
			force?: boolean;
			opencodeOnly?: boolean;
			claudeOnly?: boolean;
			codexOnly?: boolean;
		}) => {
			p.intro(`codemem setup v${VERSION}`);
			const force = opts.force ?? false;
			let ok = true;

			const onlyFlag = Boolean(opts.opencodeOnly || opts.claudeOnly || opts.codexOnly);

			const doOpencode = opts.opencodeOnly || !onlyFlag;
			const doClaude = opts.claudeOnly || !onlyFlag;
			// With no only-flag, Codex runs only when a Codex home is detected.
			const doCodex = opts.codexOnly || (!onlyFlag && existsSync(codexConfigDir()));

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

			if (ok) {
				p.outro("Setup complete — restart your editor to load the plugin");
			} else {
				p.outro("Setup completed with warnings");
				process.exitCode = 1;
			}
		},
	);
