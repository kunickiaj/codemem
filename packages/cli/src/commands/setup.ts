/**
 * codemem setup — one-command installation for OpenCode plugin + MCP config.
 *
 * Replaces Python's install_plugin_cmd + install_mcp_cmd.
 *
 * What it does:
 * 1. Adds "codemem" to the plugin array in ~/.config/opencode/opencode.jsonc
 * 2. Adds/updates the MCP entry in ~/.config/opencode/opencode.jsonc
 * 3. For Claude Code: installs MCP config and guides marketplace plugin install
 *
 * Designed to be safe to run repeatedly (idempotent unless --force).
 */

import { existsSync, rmSync } from "node:fs";
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

/** The npm package name used in the OpenCode plugin array. */
const OPENCODE_PLUGIN_SPEC = "codemem";

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

	const hasCodemem = (plugins as string[]).some(
		(entry) =>
			typeof entry === "string" &&
			(entry === OPENCODE_PLUGIN_SPEC || entry.startsWith(`${OPENCODE_PLUGIN_SPEC}@`)),
	);

	if (hasCodemem && !force) {
		p.log.info(`Plugin "${OPENCODE_PLUGIN_SPEC}" already in plugin array`);
		return true;
	}

	if (hasCodemem && force) {
		// Remove existing entry so we can re-add the canonical one.
		plugins = (plugins as string[]).filter(
			(entry) =>
				typeof entry !== "string" ||
				(entry !== OPENCODE_PLUGIN_SPEC && !entry.startsWith(`${OPENCODE_PLUGIN_SPEC}@`)),
		);
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

export const setupCommand = new Command("setup")
	.configureHelp(helpStyle)
	.description("Install codemem plugin + MCP config for OpenCode and Claude Code")
	.option("--force", "overwrite existing installations")
	.option("--opencode-only", "only install for OpenCode")
	.option("--claude-only", "only install for Claude Code")
	.action((opts: { force?: boolean; opencodeOnly?: boolean; claudeOnly?: boolean }) => {
		p.intro(`codemem setup v${VERSION}`);
		const force = opts.force ?? false;
		let ok = true;

		if (!opts.claudeOnly) {
			p.log.step("Installing OpenCode plugin...");
			ok = installPlugin(force) && ok;
			p.log.step("Installing OpenCode MCP config...");
			ok = installMcp(force) && ok;
		}

		if (!opts.opencodeOnly) {
			p.log.step("Installing Claude Code MCP config...");
			ok = installClaudeMcp(force) && ok;
		}

		if (ok) {
			p.outro("Setup complete — restart your editor to load the plugin");
		} else {
			p.outro("Setup completed with warnings");
			process.exitCode = 1;
		}
	});
