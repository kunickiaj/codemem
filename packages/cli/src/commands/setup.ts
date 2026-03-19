/**
 * codemem setup — one-command installation for OpenCode plugin + MCP config.
 *
 * Replaces Python's install_plugin_cmd + install_mcp_cmd.
 *
 * What it does:
 * 1. Copies the plugin file to ~/.config/opencode/plugin/codemem.js
 * 2. Adds/updates the MCP entry in ~/.config/opencode/opencode.json
 * 3. Copies the compat lib to ~/.config/opencode/lib/compat.js
 *
 * Designed to be safe to run repeatedly (idempotent unless --force).
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

/**
 * Find the plugin source file — walk up from this module's location
 * to find the .opencode/plugins/codemem.js in the package tree.
 */
function findPluginSource(): string | null {
	let dir = dirname(import.meta.url.replace("file://", ""));
	for (let i = 0; i < 6; i++) {
		const candidate = join(dir, ".opencode", "plugins", "codemem.js");
		if (existsSync(candidate)) return candidate;
		const nmCandidate = join(dir, "node_modules", "codemem", ".opencode", "plugins", "codemem.js");
		if (existsSync(nmCandidate)) return nmCandidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function findCompatSource(): string | null {
	let dir = dirname(import.meta.url.replace("file://", ""));
	for (let i = 0; i < 6; i++) {
		const candidate = join(dir, ".opencode", "lib", "compat.js");
		if (existsSync(candidate)) return candidate;
		const nmCandidate = join(dir, "node_modules", "codemem", ".opencode", "lib", "compat.js");
		if (existsSync(nmCandidate)) return nmCandidate;
		const legacyCandidate = join(
			dir,
			"node_modules",
			"@kunickiaj",
			"codemem",
			".opencode",
			"lib",
			"compat.js",
		);
		if (existsSync(legacyCandidate)) return legacyCandidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function installPlugin(force: boolean): boolean {
	const source = findPluginSource();
	if (!source) {
		p.log.error("Plugin file not found in package tree");
		return false;
	}

	const destDir = join(opencodeConfigDir(), "plugins");
	const dest = join(destDir, "codemem.js");

	if (existsSync(dest) && !force) {
		p.log.info(`Plugin already installed at ${dest}`);
	} else {
		mkdirSync(destDir, { recursive: true });
		copyFileSync(source, dest);
		p.log.success(`Plugin installed: ${dest}`);
	}

	// Always install/update compat lib (plugin imports ../lib/compat.js)
	const compatSource = findCompatSource();
	if (compatSource) {
		const compatDir = join(opencodeConfigDir(), "lib");
		mkdirSync(compatDir, { recursive: true });
		copyFileSync(compatSource, join(compatDir, "compat.js"));
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

	if ("codemem" in mcpConfig && !force) {
		p.log.info(`MCP entry already exists in ${configPath}`);
		return true;
	}

	mcpConfig.codemem = {
		type: "local",
		command: ["npx", "codemem", "mcp"],
		enabled: true,
	};
	config.mcp = mcpConfig;

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

	if ("codemem" in mcpServers && !force) {
		p.log.info(`Claude MCP entry already exists in ${settingsPath}`);
		return true;
	}

	mcpServers.codemem = {
		command: "npx",
		args: ["codemem", "mcp"],
	};
	settings.mcpServers = mcpServers;

	try {
		writeJsonConfig(settingsPath, settings);
		p.log.success(`Claude MCP entry installed: ${settingsPath}`);
	} catch (err) {
		p.log.error(
			`Failed to write ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
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
