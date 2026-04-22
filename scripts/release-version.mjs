#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const CORE_VERSION_RE = /^(export\s+const\s+VERSION\s*=\s*")([^"]+)(";\s*)$/m;
const CORE_TEST_VERSION_RE = /^(\s*expect\(VERSION\)\.toBe\(")([^"]+)("\);\s*)$/m;
const PLUGIN_PIN_RE = /^(const\s+PINNED_BACKEND_VERSION\s*=\s*")([^"]+)(";\s*)$/m;
const REQUIRED_REPO_MARKERS = [
	"packages/core/package.json",
	"packages/cli/package.json",
	"packages/opencode-plugin/package.json",
	"packages/mcp-server/package.json",
	"packages/viewer-server/package.json",
	"packages/core/src/index.ts",
	"packages/core/src/index.test.ts",
	"packages/cli/.opencode/plugins/codemem.js",
	"packages/opencode-plugin/.opencode/plugins/codemem.js",
	"plugins/claude/.claude-plugin/plugin.json",
	".claude-plugin/marketplace.json",
];

function validateSemver(version) {
	if (!SEMVER_RE.test(version)) {
		throw new Error(`Invalid version '${version}'. Expected format: X.Y.Z`);
	}
}

function isWithinRoot(root, candidate) {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && rel !== "..");
}

function resolveManagedPath(root, relativePath) {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(resolvedRoot, relativePath);
	if (!isWithinRoot(resolvedRoot, resolvedPath)) {
		throw new Error(`Managed path escapes repo root: ${relativePath}`);
	}
	return resolvedPath;
}

function ensureManagedRepoRoot(root) {
	const resolvedRoot = resolve(root);
	for (const marker of REQUIRED_REPO_MARKERS) {
		if (!existsSync(resolveManagedPath(resolvedRoot, marker))) {
			throw new Error(`Expected a codemem repo root with managed file: ${marker}`);
		}
	}
	return resolvedRoot;
}

function readText(path) {
	return readFileSync(path, "utf8");
}

function writeText(path, content) {
	writeFileSync(path, content, "utf8");
}

function loadJson(path, context) {
	const value = JSON.parse(readText(path));
	if (!value || Array.isArray(value) || typeof value !== "object") {
		throw new Error(`${context} must be an object`);
	}
	return value;
}

function expectObject(value, context) {
	if (!value || Array.isArray(value) || typeof value !== "object") {
		throw new Error(`${context} must be an object`);
	}
	return value;
}

function expectArray(value, context) {
	if (!Array.isArray(value)) {
		throw new Error(`${context} must be a list`);
	}
	return value;
}

function detectJsonIndent(text) {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trimStart();
		if (!trimmed || trimmed === line) {
			continue;
		}
		return line.slice(0, line.length - trimmed.length);
	}
	return "  ";
}

function dumpJson(payload, indent) {
	return `${JSON.stringify(payload, null, indent)}\n`;
}

function replaceSingle(text, regex, version, context) {
	if (!regex.test(text)) {
		throw new Error(context);
	}
	return text.replace(regex, `$1${version}$3`);
}

function extractSingle(text, regex, context) {
	const match = text.match(regex);
	if (!match) {
		throw new Error(context);
	}
	return match[2];
}

function extractPackageVersion(root, relativePath) {
	const value = loadJson(resolveManagedPath(root, relativePath), relativePath).version;
	if (typeof value !== "string") {
		throw new Error(`${relativePath} version must be text`);
	}
	return value;
}

function setPackageVersion(root, relativePath, version, writes, changed) {
	const path = resolveManagedPath(root, relativePath);
	const currentText = readText(path);
	const payload = loadJson(path, relativePath);
	if (payload.version === version) {
		return;
	}
	payload.version = version;
	writes.set(path, dumpJson(payload, detectJsonIndent(currentText)));
	changed.push(relativePath);
}

export function readVersions(root) {
	const repoRoot = ensureManagedRepoRoot(root);
	const claudePlugin = loadJson(
		resolveManagedPath(repoRoot, "plugins/claude/.claude-plugin/plugin.json"),
		"plugins/claude/.claude-plugin/plugin.json",
	);
	const marketplace = loadJson(
		resolveManagedPath(repoRoot, ".claude-plugin/marketplace.json"),
		".claude-plugin/marketplace.json",
	);
	const metadata = expectObject(
		marketplace.metadata,
		".claude-plugin/marketplace.json metadata",
	);
	const plugins = expectArray(
		marketplace.plugins,
		".claude-plugin/marketplace.json plugins",
	);
	const codememPlugin = plugins.find(
		(plugin) => plugin && !Array.isArray(plugin) && typeof plugin === "object" && plugin.name === "codemem",
	);
	if (!codememPlugin) {
		throw new Error(".claude-plugin/marketplace.json missing codemem plugin entry");
	}

	return {
		core_package: extractPackageVersion(repoRoot, "packages/core/package.json"),
		cli_package: extractPackageVersion(repoRoot, "packages/cli/package.json"),
		opencode_plugin_package: extractPackageVersion(repoRoot, "packages/opencode-plugin/package.json"),
		mcp_server_package: extractPackageVersion(repoRoot, "packages/mcp-server/package.json"),
		viewer_server_package: extractPackageVersion(repoRoot, "packages/viewer-server/package.json"),
		core_runtime: extractSingle(
			readText(resolveManagedPath(repoRoot, "packages/core/src/index.ts")),
			CORE_VERSION_RE,
			"Could not find VERSION export in packages/core/src/index.ts",
		),
		core_runtime_test: extractSingle(
			readText(resolveManagedPath(repoRoot, "packages/core/src/index.test.ts")),
			CORE_TEST_VERSION_RE,
			"Could not find VERSION assertion in packages/core/src/index.test.ts",
		),
		cli_plugin_pin: extractSingle(
			readText(resolveManagedPath(repoRoot, "packages/cli/.opencode/plugins/codemem.js")),
			PLUGIN_PIN_RE,
			"Could not find PINNED_BACKEND_VERSION in .opencode/plugin/codemem.js",
		),
		opencode_plugin_pin: extractSingle(
			readText(resolveManagedPath(repoRoot, "packages/opencode-plugin/.opencode/plugins/codemem.js")),
			PLUGIN_PIN_RE,
			"Could not find PINNED_BACKEND_VERSION in .opencode/plugin/codemem.js",
		),
		claude_plugin_manifest: String(claudePlugin.version ?? ""),
		marketplace_metadata: String(metadata.version ?? ""),
		marketplace_plugin: String(codememPlugin.version ?? ""),
	};
}

export function versionsAreAligned(snapshot) {
	const entries = Object.entries(snapshot);
	const invalid = entries.filter(([, value]) => typeof value !== "string" || !SEMVER_RE.test(value));
	const unique = [...new Set(entries.map(([, value]) => value))];
	if (unique.length <= 1 && invalid.length === 0) {
		return { aligned: true, details: [] };
	}

	const details = [];
	if (invalid.length > 0) {
		details.push("Invalid release version values detected:");
		for (const [key, value] of invalid) {
			details.push(`- ${key}: ${value}`);
		}
	}
	if (unique.length > 1) {
		details.push("Version drift detected:");
		for (const [key, value] of entries) {
			details.push(`- ${key}: ${value}`);
		}
	}
	return { aligned: false, details };
}

export function setVersion(root, version, { dryRun = false } = {}) {
	validateSemver(version);
	const repoRoot = ensureManagedRepoRoot(root);

	const changed = [];
	const writes = new Map();

	setPackageVersion(repoRoot, "packages/core/package.json", version, writes, changed);
	setPackageVersion(repoRoot, "packages/cli/package.json", version, writes, changed);
	setPackageVersion(repoRoot, "packages/opencode-plugin/package.json", version, writes, changed);
	setPackageVersion(repoRoot, "packages/mcp-server/package.json", version, writes, changed);
	setPackageVersion(repoRoot, "packages/viewer-server/package.json", version, writes, changed);

	const textUpdates = [
		{
			relativePath: "packages/core/src/index.ts",
			regex: CORE_VERSION_RE,
			missing: "Could not replace VERSION export in packages/core/src/index.ts",
		},
		{
			relativePath: "packages/core/src/index.test.ts",
			regex: CORE_TEST_VERSION_RE,
			missing: "Could not replace VERSION assertion in packages/core/src/index.test.ts",
		},
		{
			relativePath: "packages/cli/.opencode/plugins/codemem.js",
			regex: PLUGIN_PIN_RE,
			missing: "Could not replace PINNED_BACKEND_VERSION in .opencode/plugin/codemem.js",
		},
		{
			relativePath: "packages/opencode-plugin/.opencode/plugins/codemem.js",
			regex: PLUGIN_PIN_RE,
			missing: "Could not replace PINNED_BACKEND_VERSION in .opencode/plugin/codemem.js",
		},
	];

	for (const update of textUpdates) {
		const path = resolveManagedPath(repoRoot, update.relativePath);
		const current = readText(path);
		const next = replaceSingle(current, update.regex, version, update.missing);
		if (next !== current) {
			writes.set(path, next);
			changed.push(update.relativePath);
		}
	}

	const claudePluginPath = resolveManagedPath(repoRoot, "plugins/claude/.claude-plugin/plugin.json");
	const claudePluginText = readText(claudePluginPath);
	const claudePlugin = loadJson(claudePluginPath, "plugins/claude/.claude-plugin/plugin.json");
	if (claudePlugin.version !== version) {
		claudePlugin.version = version;
		writes.set(claudePluginPath, dumpJson(claudePlugin, detectJsonIndent(claudePluginText)));
		changed.push("plugins/claude/.claude-plugin/plugin.json");
	}

	const marketplacePath = resolveManagedPath(repoRoot, ".claude-plugin/marketplace.json");
	const marketplaceText = readText(marketplacePath);
	const marketplace = loadJson(marketplacePath, ".claude-plugin/marketplace.json");
	const metadata = expectObject(marketplace.metadata, ".claude-plugin/marketplace.json metadata");
	const plugins = expectArray(marketplace.plugins, ".claude-plugin/marketplace.json plugins");
	let codememEntries = 0;
	let marketplaceChanged = false;
	if (metadata.version !== version) {
		metadata.version = version;
		marketplaceChanged = true;
	}
	for (const plugin of plugins) {
		if (!plugin || Array.isArray(plugin) || typeof plugin !== "object" || plugin.name !== "codemem") {
			continue;
		}
		codememEntries += 1;
		if (plugin.version !== version) {
			plugin.version = version;
			marketplaceChanged = true;
		}
	}
	if (codememEntries === 0) {
		throw new Error(".claude-plugin/marketplace.json missing codemem plugin entry");
	}
	if (marketplaceChanged) {
		writes.set(marketplacePath, dumpJson(marketplace, detectJsonIndent(marketplaceText)));
		changed.push(".claude-plugin/marketplace.json");
	}

	if (!dryRun) {
		for (const [path, content] of writes) {
			writeText(path, content);
		}
	}

	return changed;
}

export function buildParserArgs(argv) {
	const args = [...argv];
	if (args[0] === "--") {
		args.shift();
	}
	const root = ensureManagedRepoRoot(process.cwd());
	const command = args[0];
	if (!command) {
		throw new Error("Usage: release-version.mjs <check|set> [version] [--dry-run]");
	}
	if (command === "check") {
		return { root, command };
	}
	if (command === "set") {
		const version = args[1];
		if (!version) {
			throw new Error("Usage: release-version.mjs set <version> [--dry-run]");
		}
		const dryRun = args.includes("--dry-run");
		return { root, command, version, dryRun };
	}
	throw new Error(`Unknown command: ${command}`);
}

export function main(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
	try {
		const parsed = buildParserArgs(argv);
		if (parsed.command === "check") {
			const snapshot = readVersions(parsed.root);
			const result = versionsAreAligned(snapshot);
			if (result.aligned) {
				stdout.write(`OK: release versions are aligned at ${snapshot.core_package}\n`);
				return 0;
			}
			for (const line of result.details) {
				stdout.write(`${line}\n`);
			}
			return 1;
		}

		const changed = setVersion(parsed.root, parsed.version, { dryRun: parsed.dryRun });
		if (changed.length > 0) {
			stdout.write(`${parsed.dryRun ? "would update" : "updated"} ${changed.length} file(s):\n`);
			for (const path of changed) {
				stdout.write(`- ${path}\n`);
			}
		} else {
			stdout.write("No version changes needed.\n");
		}
		if (parsed.dryRun) {
			stdout.write("Dry run complete; no files written.\n");
			return 0;
		}
		const result = versionsAreAligned(readVersions(parsed.root));
		if (result.aligned) {
			return 0;
		}
		for (const line of result.details) {
			stdout.write(`${line}\n`);
		}
		return 1;
	} catch (error) {
		stderr.write(`Error: ${error.message}\n`);
		return 2;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exitCode = main();
}
