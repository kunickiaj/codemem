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
	OPENCODE_PLUGIN_SPEC,
	reconcileOpencodePluginConfig,
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

function isExactStringArray(value: unknown, expected: string[]): boolean {
	return (
		Array.isArray(value) &&
		value.length === expected.length &&
		value.every((entry, index) => entry === expected[index])
	);
}

/** Detect and upgrade legacy uvx/uv or managed single-package MCP entries in OpenCode config. */
export function migrateLegacyOpencodeMcp(
	config: Record<string, unknown>,
	{ launcher }: { launcher?: ReturnType<typeof codememMcpLauncher> } = {},
): boolean {
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
		const resolvedLauncher = launcher ?? codememMcpLauncher();
		mcpConfig.codemem = {
			...entry,
			command: [resolvedLauncher.command, ...resolvedLauncher.args],
		};
		return true;
	}
	return false;
}

/** Detect and upgrade legacy uvx or managed single-package MCP entries in Claude settings. */
export function migrateLegacyClaudeMcp(
	settings: Record<string, unknown>,
	{ launcher }: { launcher?: ReturnType<typeof codememMcpLauncher> } = {},
): boolean {
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
		const resolvedLauncher = launcher ?? codememMcpLauncher();
		mcpServers.codemem = {
			...entry,
			command: resolvedLauncher.command,
			args: resolvedLauncher.args,
		};
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Install functions
// ---------------------------------------------------------------------------

function installPlugin(force: boolean): { ok: boolean; wrote: boolean } {
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
		return { ok: false, wrote: false };
	}

	const result = reconcileOpencodePluginConfig(config, { force });
	if (!result.changed) {
		p.log.info(`Plugin "${OPENCODE_PLUGIN_SPEC}" already in plugin array`);
		return { ok: true, wrote: false };
	}

	if (result.removedLegacy) {
		p.log.step("Removed legacy OpenCode plugin spec(s): codemem / @kunickiaj/codemem");
	}

	try {
		const wrote = writeJsonConfig(configPath, result.config);
		p.log.success(`Plugin "${OPENCODE_PLUGIN_SPEC}" added to ${configPath}`);
		return { ok: true, wrote };
	} catch (err) {
		p.log.error(
			`Failed to write ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { ok: false, wrote: false };
	}
}

function installMcp(
	force: boolean,
	{ createBackup = true }: { createBackup?: boolean } = {},
): boolean {
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
		writeJsonConfig(configPath, config, { createBackup });
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
function codexMcpBlock(launcher: ReturnType<typeof codememMcpLauncher>): string {
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

function migrateManagedCodexMcp(
	existing: string,
	launcher: ReturnType<typeof codememMcpLauncher>,
): string | null {
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
export function codememCodexHookBase(onPath = codememOnPath(true)): string {
	if (onPath) return "codemem";
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
function installCodexMcp(
	codexHome: string,
	force: boolean,
	launcher: ReturnType<typeof codememMcpLauncher>,
): boolean {
	const configPath = join(codexHome, "config.toml");
	const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";

	if (CODEX_MCP_TABLE_RE.test(existing)) {
		const migrated = migrateManagedCodexMcp(existing, launcher);
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
	next += `${codexMcpBlock(launcher)}\n`;

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
function installCodexHooks(codexHome: string, force: boolean, hookBase: string): boolean {
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
interface InstallCodexOptions {
	onPath?: boolean;
}

export function installCodex(force: boolean, options: InstallCodexOptions = {}): boolean {
	const codexHome = codexConfigDir();
	try {
		mkdirSync(codexHome, { recursive: true });
	} catch (err) {
		p.log.error(
			`Failed to create Codex home ${codexHome}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	const onPath = options.onPath ?? codememOnPath(true);
	const launcher = codememMcpLauncher(onPath);
	const hookBase = codememCodexHookBase(onPath);
	if (onPath) {
		p.log.info("Codex hooks will call `codemem` directly (found on PATH).");
	} else {
		const globalInstallCommand =
			process.platform === "linux"
				? "env ONNXRUNTIME_NODE_INSTALL=skip npm install -g codemem"
				: "npm install -g codemem";
		p.log.info(
			`\`codemem\` is not on PATH, so Codex hooks will run via \`npx -y --package codemem --package @codemem/embeddings codemem\` (works without a global install). For lower hook latency: ${globalInstallCommand}`,
		);
	}

	let ok = true;
	ok = installCodexMcp(codexHome, force, launcher) && ok;
	ok = installCodexHooks(codexHome, force, hookBase) && ok;
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

function readPiJsoncOrAbort(path: string, untouchedHint: string): Record<string, unknown> | null {
	if (!existsSync(path)) return {};
	try {
		return loadJsoncConfig(path);
	} catch (err) {
		p.log.error(`Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
		p.log.info(`Leaving ${path} untouched. ${untouchedHint}`);
		return null;
	}
}

function shouldKeepExistingPiExtension(
	existing: unknown,
	force: boolean,
	desired: string,
): boolean {
	if (existing == null || force) return false;
	// Equal pin → keep. Stale npm version pin → upgrade. Local-path / non-npm
	// entries are never touched without --force.
	return !(isNpmPiExtensionPackageEntry(existing) && existing !== desired);
}

function writePiExtensionSettings(
	piDir: string,
	settingsPath: string,
	settings: Record<string, unknown>,
	existing: unknown,
	desired: string,
): boolean {
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
 * Idempotently ensure the pi extension packages: entry is present in
 * settings.json. Backs up before write; aborts on parse failure.
 */
function installPiExtensionPackage(piDir: string, force: boolean, extensionPath?: string): boolean {
	const settingsPath = join(piDir, "settings.json");
	const desired = buildPiExtensionPackageSpec(extensionPath);
	const settings = readPiJsoncOrAbort(
		settingsPath,
		"Fix or remove the file, then re-run `codemem setup --pi-only`.",
	);
	if (settings == null) return false;

	const list = Array.isArray(settings.packages) ? [...settings.packages] : [];
	const existing = list.find((entry) => isPiExtensionPackageEntry(entry));
	if (shouldKeepExistingPiExtension(existing, force, desired)) {
		p.log.info(`Pi extension package already configured in ${settingsPath}`);
		return true;
	}

	settings.packages = [...list.filter((entry) => !isPiExtensionPackageEntry(entry)), desired];
	return writePiExtensionSettings(piDir, settingsPath, settings, existing, desired);
}

function isOfficialObserverBaseUrl(url: string): boolean {
	const normalized = url.trim().replace(/\/+$/, "").toLowerCase();
	return (
		normalized === "https://api.openai.com" ||
		normalized === "https://api.openai.com/v1" ||
		normalized === "https://api.anthropic.com" ||
		normalized === "https://api.anthropic.com/v1"
	);
}

function nextPiToolsBlock(
	existing: Record<string, unknown>,
	toolsMode: "native" | "mcp-adapter",
): { piBlock: Record<string, unknown>; toolsModeUpdated: boolean } {
	const existingPi =
		existing.pi != null && typeof existing.pi === "object" && !Array.isArray(existing.pi)
			? { ...(existing.pi as Record<string, unknown>) }
			: {};
	const piBlock = { ...existingPi };
	if (toolsMode === "mcp-adapter") {
		if (piBlock.tools_mode === "mcp-adapter") return { piBlock, toolsModeUpdated: false };
		piBlock.tools_mode = "mcp-adapter";
		return { piBlock, toolsModeUpdated: true };
	}
	if (piBlock.tools_mode == null || piBlock.tools_mode === "") {
		piBlock.tools_mode = "native";
		return { piBlock, toolsModeUpdated: true };
	}
	return { piBlock, toolsModeUpdated: false };
}

function applyResolvedPiObserver(
	resolved: {
		provider: unknown;
		model: unknown;
		baseUrl?: string | null;
		openAIUseResponses?: boolean;
	},
	needs: {
		provider: boolean;
		model: boolean;
		baseUrl: boolean;
		useResponses: boolean;
		fileProvider: string;
		fileModel: string;
		envProvider: string | undefined;
		envModel: string | undefined;
	},
	next: Record<string, unknown>,
	updated: string[],
): void {
	// Tuple rule (mirrors core applyPiDerivedObserverFields): derive the full
	// provider/model/endpoint set only when both identity fields are unset, or
	// fill a missing model only when the explicit provider matches pi. Never
	// combine pi's model or endpoint with a different explicit provider.
	// Env overrides are temporary and, unlike core (which re-derives in
	// memory per run), setup persists: never write pi-derived identity while
	// a provider/model env override is active — it would strand the persisted
	// tuple next to the override's provider once the env is removed.
	if (needs.envProvider || needs.envModel) return;
	const explicitProvider = needs.fileProvider;
	if (explicitProvider) {
		if (needs.model && explicitProvider.toLowerCase() === String(resolved.provider).toLowerCase()) {
			next.observer_model = resolved.model;
			updated.push("observer_model");
		}
		return;
	}
	// Model set without a provider: leave provider unset so the client infers
	// it from the model instead of routing that model through pi.
	if (needs.fileModel) return;
	next.observer_provider = resolved.provider;
	updated.push("observer_provider");
	next.observer_model = resolved.model;
	updated.push("observer_model");
	// Official OpenAI/Anthropic URLs must stay unset: any non-empty
	// observer_base_url is treated as a custom gateway (disables default
	// Responses + tier routing). Persist only a real custom URL, and the
	// use_responses flag only then.
	const customBaseUrl =
		resolved.baseUrl && !isOfficialObserverBaseUrl(resolved.baseUrl) ? resolved.baseUrl : undefined;
	if (needs.baseUrl && customBaseUrl) {
		next.observer_base_url = customBaseUrl;
		updated.push("observer_base_url");
	}
	if (needs.useResponses && customBaseUrl) {
		next.observer_openai_use_responses = resolved.openAIUseResponses;
		updated.push("observer_openai_use_responses");
	}
}

function unsetObserverSlots(existing: Record<string, unknown>): {
	provider: boolean;
	model: boolean;
	baseUrl: boolean;
	useResponses: boolean;
	fileProvider: string;
	fileModel: string;
	envProvider: string | undefined;
	envModel: string | undefined;
} {
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
	return {
		provider: !envProvider && !fileProvider,
		model: !envModel && !fileModel,
		baseUrl: !envBaseUrl && !fileBaseUrl,
		useResponses: !envUseResponses && existing.observer_openai_use_responses == null,
		fileProvider,
		fileModel,
		envProvider,
		envModel,
	};
}

function fillUnsetObserverFromPi(
	existing: Record<string, unknown>,
	next: Record<string, unknown>,
	updated: string[],
): void {
	const needs = unsetObserverSlots(existing);
	if (!(needs.provider || needs.model || needs.baseUrl || needs.useResponses)) {
		p.log.info("Existing codemem observer config left unchanged");
		return;
	}
	const resolved = resolvePiObserverConfig();
	p.log.info(`Pi observer: ${describePiObserverStatus(resolved)}`);
	if (resolved.ok) {
		applyResolvedPiObserver(resolved, needs, next, updated);
		return;
	}
	if (!needs.fileProvider && !needs.fileModel && !needs.envProvider && !needs.envModel) {
		p.log.info(
			"Extraction model left unconfigured — set observer_provider/observer_model when ready.",
		);
	}
}

function writeUpdatedCodememConfig(next: Record<string, unknown>, updated: string[]): boolean {
	if (updated.length === 0) return true;
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
	const { piBlock, toolsModeUpdated } = nextPiToolsBlock(existing, opts.toolsMode);
	if (toolsModeUpdated) updated.push("pi.tools_mode");
	next.pi = piBlock;
	// Never introduce credentials. `next` started as a shallow copy of `existing`,
	// so a pre-existing user-supplied observer_api_key is preserved untouched;
	// resolvePiObserverConfig's apiKey is intentionally never copied here.
	fillUnsetObserverFromPi(existing, next, updated);
	return writeUpdatedCodememConfig(next, updated);
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
		// D3: import is explicit, never automatic during setup — unbounded latency
		// on large histories; the hint keeps backfill opt-in.
		p.log.info(
			"  - Pre-install pi session history is not imported automatically; backfill it with: codemem pi-import-sessions",
		);
	}

	return ok;
}

type SetupCommandOpts = {
	force?: boolean;
	opencodeOnly?: boolean;
	claudeOnly?: boolean;
	codexOnly?: boolean;
	piOnly?: boolean;
	piMcp?: boolean;
	piExtensionPath?: string;
};

function maybeInstallPi(opts: SetupCommandOpts, onlyFlag: boolean, force: boolean): boolean {
	if (!(opts.piOnly || (!onlyFlag && isPiDetected()))) return true;
	p.log.step("Configuring pi (extension package + observer)...");
	return installPi({
		force,
		piMcp: opts.piMcp,
		piExtensionPath: opts.piExtensionPath,
	});
}

function installOpencodeSetup(force: boolean): boolean {
	p.log.step("Installing OpenCode plugin...");
	const pluginResult = installPlugin(force);
	p.log.step("Installing OpenCode MCP config...");
	return pluginResult.ok && installMcp(force, { createBackup: !pluginResult.wrote });
}

function installClaudeSetup(force: boolean): boolean {
	p.log.step("Installing Claude Code MCP config...");
	return installClaudeMcp(force);
}

function installCodexSetup(force: boolean): boolean {
	p.log.step("Configuring Codex (MCP + hooks)...");
	const ok = installCodex(force);
	p.log.info("Codex next steps:");
	p.log.info("  - Restart Codex to load the new configuration");
	p.log.info("  - On first run, approve the one-time prompt to trust the codemem hooks");
	p.log.info("  - MCP recall works immediately (no trust prompt required)");
	return ok;
}

function runSetupInstalls(opts: SetupCommandOpts, force: boolean): boolean {
	const onlyFlag = Boolean(opts.opencodeOnly || opts.claudeOnly || opts.codexOnly || opts.piOnly);
	let ok = true;
	if (opts.opencodeOnly || !onlyFlag) ok = installOpencodeSetup(force) && ok;
	if (opts.claudeOnly || !onlyFlag) ok = installClaudeSetup(force) && ok;
	if (opts.codexOnly || (!onlyFlag && existsSync(codexConfigDir()))) {
		ok = installCodexSetup(force) && ok;
	}
	return maybeInstallPi(opts, onlyFlag, force) && ok;
}

function runSetup(opts: SetupCommandOpts): void {
	p.intro(`codemem setup v${VERSION}`);
	if (runSetupInstalls(opts, opts.force ?? false)) {
		p.outro("Setup complete — restart your editor to load the plugin");
		return;
	}
	p.outro("Setup completed with warnings");
	process.exitCode = 1;
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
	.action((opts: SetupCommandOpts) => {
		runSetup(opts);
	});
