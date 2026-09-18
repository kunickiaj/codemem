import { randomUUID } from "node:crypto";
import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { atomicReplaceConfigFile, type ConfigFileMetadata } from "@codemem/core";
import {
	applyEdits,
	type FormattingOptions,
	findNodeAtLocation,
	type JSONPath,
	modify,
	type ParseError,
	parse,
	parseTree,
	printParseErrorCode,
} from "jsonc-parser";

export const OPENCODE_PLUGIN_SPEC = "@codemem/opencode-plugin";
const LEGACY_OPENCODE_PLUGIN_SPECS = ["codemem", "@kunickiaj/codemem"];

function matchesPluginSpec(entry: unknown, spec: string): boolean {
	return typeof entry === "string" && (entry === spec || entry.startsWith(`${spec}@`));
}

export function reconcileOpencodePluginConfig(
	config: Record<string, unknown>,
	{ force }: { force: boolean },
): { config: Record<string, unknown>; changed: boolean; removedLegacy: boolean } {
	const plugins: unknown[] = Array.isArray(config.plugin) ? config.plugin : [];
	const isCanonicalSpec = (entry: unknown): boolean =>
		matchesPluginSpec(entry, OPENCODE_PLUGIN_SPEC);
	const isLegacySpec = (entry: unknown): boolean =>
		LEGACY_OPENCODE_PLUGIN_SPECS.some((spec) => matchesPluginSpec(entry, spec));
	const hasCanonicalSpec = plugins.some(isCanonicalSpec);
	const hasLegacySpec = plugins.some(isLegacySpec);

	if (hasCanonicalSpec && !hasLegacySpec && !force) {
		return { config, changed: false, removedLegacy: false };
	}

	const preserved = plugins.filter((entry) => !isCanonicalSpec(entry) && !isLegacySpec(entry));
	return {
		config: { ...config, plugin: [...preserved, OPENCODE_PLUGIN_SPEC] },
		changed: true,
		removedLegacy: hasLegacySpec,
	};
}

export function resolveOpencodeConfigPath(configDir: string): string {
	const jsonPath = join(configDir, "opencode.json");
	if (existsSync(jsonPath)) return jsonPath;
	const jsoncPath = join(configDir, "opencode.jsonc");
	if (existsSync(jsoncPath)) return jsoncPath;
	return jsoncPath;
}

export function loadJsoncConfig(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	return parseJsoncConfig(readFileSync(path, "utf-8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsoncConfig(raw: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const parsed: unknown = parse(raw, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const first = errors[0] as ParseError;
		throw new Error(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
	}
	if (!isRecord(parsed)) throw new Error("OpenCode config must be a JSON object");
	return parsed;
}

interface ConfigChange {
	path: JSONPath;
	value: unknown;
}

function collectChanges(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	path: JSONPath = [],
): ConfigChange[] {
	const changes: ConfigChange[] = [];
	for (const key of Object.keys(before)) {
		if (!Object.hasOwn(after, key)) changes.push({ path: [...path, key], value: undefined });
	}
	for (const [key, value] of Object.entries(after)) {
		const nextPath = [...path, key];
		const previous = before[key];
		if (isRecord(previous) && isRecord(value)) {
			changes.push(...collectChanges(previous, value, nextPath));
			continue;
		}
		if (JSON.stringify(previous) !== JSON.stringify(value)) {
			changes.push({ path: nextPath, value });
		}
	}
	return changes;
}

const formattingOptions: FormattingOptions = {
	insertSpaces: true,
	tabSize: 2,
	insertFinalNewline: true,
	keepLines: true,
};

function applyChange(
	raw: string,
	change: ConfigChange,
	{ format = true }: { format?: boolean } = {},
): string {
	const options = format ? { formattingOptions } : {};
	return applyEdits(raw, modify(raw, change.path, change.value, options));
}

function isManagedPlugin(entry: unknown): boolean {
	return (
		matchesPluginSpec(entry, OPENCODE_PLUGIN_SPEC) ||
		LEGACY_OPENCODE_PLUGIN_SPECS.some((spec) => matchesPluginSpec(entry, spec))
	);
}

function isManagedPluginUpdate(before: unknown, after: unknown): after is unknown[] {
	if (!Array.isArray(before) || !Array.isArray(after)) return false;
	const expected = [...before.filter((entry) => !isManagedPlugin(entry)), OPENCODE_PLUGIN_SPEC];
	return JSON.stringify(after) === JSON.stringify(expected);
}

function updateManagedPlugins(raw: string, plugins: unknown[]): string {
	let updated = raw;
	for (let index = plugins.length - 1; index >= 0; index--) {
		if (!isManagedPlugin(plugins[index])) continue;
		updated = applyChange(
			updated,
			{ path: ["plugin", index], value: undefined },
			{ format: false },
		);
	}
	const tree = parseTree(updated);
	const pluginNode = tree ? findNodeAtLocation(tree, ["plugin"]) : undefined;
	const children = pluginNode?.children ?? [];
	const edits = modify(updated, ["plugin", children.length], OPENCODE_PLUGIN_SPEC, {
		isArrayInsertion: true,
	});
	const lastChild = children.at(-1);
	if (
		!pluginNode ||
		!lastChild ||
		!updated.slice(pluginNode.offset, lastChild.offset).includes("\n")
	) {
		return applyEdits(updated, edits);
	}
	const lineStart = updated.lastIndexOf("\n", lastChild.offset - 1) + 1;
	const indent = updated.slice(lineStart, lastChild.offset).match(/^[\t ]*/)?.[0] ?? "";
	const eol = updated.includes("\r\n") ? "\r\n" : "\n";
	return applyEdits(
		updated,
		edits.map((edit) => ({
			...edit,
			content: edit.content.startsWith(",")
				? `,${eol}${indent}${edit.content.slice(1)}`
				: edit.content,
		})),
	);
}

function configMetadata(path: string): ConfigFileMetadata | undefined {
	if (!existsSync(path)) return undefined;
	const stats = statSync(path);
	return { mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid };
}

function backupConfig(path: string): void {
	const backupPath = `${path}.codemem.bak`;
	const temporaryPath = `${backupPath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		copyFileSync(path, temporaryPath, constants.COPYFILE_EXCL);
		renameSync(temporaryPath, backupPath);
	} catch (error) {
		rmSync(temporaryPath, { force: true });
		throw error;
	}
}

export function writeJsonConfig(
	path: string,
	data: Record<string, unknown>,
	{ createBackup = true }: { createBackup?: boolean } = {},
): boolean {
	mkdirSync(dirname(path), { recursive: true });
	const exists = existsSync(path);
	const raw = exists ? readFileSync(path, "utf-8") : "{}\n";
	const before = parseJsoncConfig(raw);
	let output = raw;
	const managedPluginUpdate = isManagedPluginUpdate(before.plugin, data.plugin);
	if (managedPluginUpdate) output = updateManagedPlugins(output, before.plugin as unknown[]);
	for (const change of collectChanges(before, data)) {
		if (managedPluginUpdate && change.path.length === 1 && change.path[0] === "plugin") continue;
		output = applyChange(output, change);
	}
	if (output === raw) return false;
	parseJsoncConfig(output);
	if (exists && createBackup) backupConfig(path);
	atomicReplaceConfigFile(path, output, configMetadata(path));
	return true;
}
