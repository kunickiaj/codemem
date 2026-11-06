import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicReplaceConfigFile, type ConfigFileMetadata } from "@codemem/core";
import {
	applyEdits,
	createScanner,
	type FormattingOptions,
	findNodeAtLocation,
	type JSONPath,
	modify,
	type Node,
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

// First plugin release that registers the memory tools itself by default.
const OPENCODE_NATIVE_TOOLS_SINCE = [0, 48, 0] as const;

/**
 * The version pin on the codemem plugin entry, unless that pin is known to
 * include the plugin's built-in memory tools. Setup keeps the per-project MCP
 * entry for any returned pin: a configured MCP server takes precedence over the
 * built-in tools, so keeping it is safe, while removing it for an older plugin
 * would leave OpenCode without memory tools.
 *
 * Known to include the tools: no pin, a dist-tag such as `@latest`, an exact
 * version of 0.48.0 or later, or a `^`, `~` or `>=` range whose full lower bound
 * is 0.48.0 or later. Every other pin, including partial ones such as `0.47`,
 * `~0.47` or `0.47.x`, is treated as possibly older.
 */
export function pinnedOpencodePluginWithoutNativeTools(
	config: Record<string, unknown>,
): string | null {
	const plugins: unknown[] = Array.isArray(config.plugin) ? config.plugin : [];
	for (const entry of plugins) {
		if (typeof entry !== "string" || !entry.startsWith(`${OPENCODE_PLUGIN_SPEC}@`)) continue;
		const pin = entry.slice(OPENCODE_PLUGIN_SPEC.length + 1).trim();
		if (!pinIncludesNativeTools(pin)) return pin;
	}
	return null;
}

const DIST_TAG = /^[A-Za-z][\w.-]*$/;
const LOWER_BOUNDED_VERSION = /^(?:\^|~|>=|=|v)?\s*(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

function pinIncludesNativeTools(pin: string): boolean {
	if (pin === "") return true;
	// Versions first: a tag pattern would also match a `v0.47.4` pin.
	const match = LOWER_BOUNDED_VERSION.exec(pin);
	if (match) {
		const version = [Number(match[1]), Number(match[2]), Number(match[3])];
		// A prerelease of the first native release may predate the change.
		return !comparesBelowNativeTools(version, { prerelease: Boolean(match[4]) });
	}
	// Anything starting with v and a digit is a version npm would parse, never a tag.
	return DIST_TAG.test(pin) && !/^v\d/i.test(pin);
}

function comparesBelowNativeTools(version: number[], { prerelease }: { prerelease: boolean }) {
	for (const [index, floor] of OPENCODE_NATIVE_TOOLS_SINCE.entries()) {
		const part = version[index] ?? 0;
		if (part !== floor) return part < floor;
	}
	return prerelease;
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

function rejectDuplicateKeys(node: Node): void {
	if (node.type === "object") {
		const keys = new Set<string>();
		for (const property of node.children ?? []) {
			const keyNode = property.children?.[0];
			const key = keyNode?.value;
			if (!keyNode || typeof key !== "string") continue;
			if (keys.has(key))
				throw new Error(`Duplicate JSONC key "${key}" at offset ${keyNode.offset}`);
			keys.add(key);
		}
	}
	for (const child of node.children ?? []) rejectDuplicateKeys(child);
}

function parseJsoncConfig(raw: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const parsed: unknown = parse(raw, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const first = errors[0] as ParseError;
		throw new Error(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
	}
	if (!isRecord(parsed)) throw new Error("OpenCode config must be a JSON object");
	const tree = parseTree(raw, [], { allowTrailingComma: true });
	if (tree) rejectDuplicateKeys(tree);
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
	if (change.value !== undefined) {
		const appended = appendObjectProperty(raw, change);
		if (appended !== undefined) return appended;
	} else {
		const removed = removeObjectProperty(raw, change.path);
		if (removed !== undefined) return removed;
	}
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
	if (JSON.stringify(before) === JSON.stringify(after)) return false;
	const expected = [...before.filter((entry) => !isManagedPlugin(entry)), OPENCODE_PLUGIN_SPEC];
	return JSON.stringify(after) === JSON.stringify(expected);
}

function removePluginEntry(raw: string, index: number): string {
	const tree = parseTree(raw);
	const pluginNode = tree ? findNodeAtLocation(tree, ["plugin"]) : undefined;
	const entry = pluginNode?.children?.[index];
	const nextEntry = pluginNode?.children?.[index + 1];
	if (!pluginNode || !entry) {
		return applyChange(raw, { path: ["plugin", index], value: undefined }, { format: false });
	}

	const scanner = createScanner(raw);
	scanner.setPosition(entry.offset + entry.length);
	const boundary = nextEntry?.offset ?? pluginNode.offset + pluginNode.length - 1;
	while (scanner.getPosition() < boundary) {
		scanner.scan();
		const token = raw.slice(
			scanner.getTokenOffset(),
			scanner.getTokenOffset() + scanner.getTokenLength(),
		);
		if (token !== ",") continue;
		const end = scanner.getTokenOffset() + scanner.getTokenLength();
		return applyEdits(raw, [{ offset: entry.offset, length: end - entry.offset, content: "" }]);
	}
	return applyEdits(raw, [{ offset: entry.offset, length: entry.length, content: "" }]);
}

function hasCommaToken(raw: string, start: number, end: number): boolean {
	const scanner = createScanner(raw);
	scanner.setPosition(start);
	while (scanner.getPosition() < end) {
		scanner.scan();
		const tokenStart = scanner.getTokenOffset();
		if (raw.slice(tokenStart, tokenStart + scanner.getTokenLength()) === ",") return true;
	}
	return false;
}

function findCommaOffset(raw: string, start: number, end: number): number | undefined {
	const scanner = createScanner(raw);
	scanner.setPosition(start);
	while (scanner.getPosition() < end) {
		scanner.scan();
		if (scanner.getTokenLength() === 0) return undefined;
		const tokenStart = scanner.getTokenOffset();
		if (tokenStart >= end) return undefined;
		if (raw[tokenStart] === ",") return tokenStart;
	}
	return undefined;
}

/** Cut [start, end), widening to the whole line when nothing else is on it. */
function cutText(raw: string, start: number, end: number): string {
	const lineStart = raw.lastIndexOf("\n", start - 1) + 1;
	const lineEnd = raw.indexOf("\n", end);
	const ownsLine =
		raw.slice(lineStart, start).trim() === "" &&
		lineEnd !== -1 &&
		raw.slice(end, lineEnd).trim() === "";
	const from = ownsLine ? lineStart : start;
	const to = ownsLine ? lineEnd + 1 : end;
	return applyEdits(raw, [{ offset: from, length: to - from, content: "" }]);
}

/**
 * Remove an object property as a text cut. jsonc-parser's `modify` leaves a
 * dangling comma (invalid JSONC) when the only property has a trailing comma,
 * and its formatting option reflows sibling properties. This cuts the property,
 * its comma, and its line when nothing else is on it, so siblings and comments
 * keep their text. Returns undefined when the path is not an object property.
 */
function removeObjectProperty(raw: string, path: JSONPath): string | undefined {
	const tree = parseTree(raw, [], { allowTrailingComma: true });
	const parentNode = tree ? findNodeAtLocation(tree, path.slice(0, -1)) : undefined;
	const siblings = parentNode?.type === "object" ? (parentNode.children ?? []) : [];
	const index = siblings.findIndex((property) => property.children?.[0]?.value === path.at(-1));
	const property = siblings[index];
	if (!parentNode || !property) return undefined;

	const propertyEnd = property.offset + property.length;
	const boundary = siblings[index + 1]?.offset ?? parentNode.offset + parentNode.length - 1;
	const trailingComma = findCommaOffset(raw, propertyEnd, boundary);
	if (trailingComma !== undefined) return cutText(raw, property.offset, trailingComma + 1);

	// Last property without a trailing comma: drop the comma that precedes it.
	const previous = siblings[index - 1];
	const leadingComma = previous
		? findCommaOffset(raw, previous.offset + previous.length, property.offset)
		: undefined;
	if (leadingComma !== undefined) {
		return applyEdits(raw, [
			{ offset: leadingComma, length: propertyEnd - leadingComma, content: "" },
		]);
	}
	return cutText(raw, property.offset, propertyEnd);
}

/** True when the JSONC value at `path` contains a line or block comment. */
export function jsoncValueHasComments(raw: string, path: JSONPath): boolean {
	const tree = parseTree(raw, [], { allowTrailingComma: true });
	const node = tree ? findNodeAtLocation(tree, path) : undefined;
	if (!node) return false;
	const scanner = createScanner(raw);
	scanner.setPosition(node.offset);
	const end = node.offset + node.length;
	while (scanner.getPosition() < end) {
		scanner.scan();
		const length = scanner.getTokenLength();
		if (length === 0) return false;
		const tokenStart = scanner.getTokenOffset();
		const prefix = raw.slice(tokenStart, tokenStart + 2);
		if (prefix === "//" || prefix === "/*") return true;
	}
	return false;
}

function appendObjectProperty(raw: string, change: ConfigChange): string | undefined {
	const key = change.path.at(-1);
	if (typeof key !== "string") return undefined;
	const tree = parseTree(raw);
	if (!tree || findNodeAtLocation(tree, change.path)) return undefined;
	const parentNode = findNodeAtLocation(tree, change.path.slice(0, -1));
	const lastProperty = parentNode?.children?.at(-1);
	if (parentNode?.type !== "object" || !lastProperty) return undefined;
	const serializedValue = JSON.stringify(change.value, null, formattingOptions.tabSize);
	if (serializedValue === undefined) return undefined;

	const propertyEnd = lastProperty.offset + lastProperty.length;
	const closeOffset = parentNode.offset + parentNode.length - 1;
	const hasTrailingComma = hasCommaToken(raw, propertyEnd, closeOffset);
	const commaEdit = hasTrailingComma ? [] : [{ offset: propertyEnd, length: 0, content: "," }];
	const lineStart = raw.lastIndexOf("\n", lastProperty.offset - 1) + 1;
	const indent = raw.slice(lineStart, lastProperty.offset).match(/^[\t ]*/)?.[0] ?? "";
	const eol = raw.includes("\r\n") ? "\r\n" : "\n";
	const value = serializedValue.replaceAll("\n", `${eol}${indent}`);
	const property = `${JSON.stringify(key)}: ${value}${hasTrailingComma ? "," : ""}`;
	const closeLineStart = raw.lastIndexOf("\n", closeOffset - 1) + 1;
	const closesOnOwnLine = raw.slice(closeLineStart, closeOffset).trim() === "";
	const insertionEdit = closesOnOwnLine
		? { offset: closeLineStart, length: 0, content: `${indent}${property}${eol}` }
		: { offset: closeOffset, length: 0, content: ` ${property}` };
	return applyEdits(raw, [...commaEdit, insertionEdit]);
}

function appendManagedPlugin(raw: string, pluginNode: Node, lastChild: Node): string {
	const childEnd = lastChild.offset + lastChild.length;
	const closeOffset = pluginNode.offset + pluginNode.length - 1;
	const hasTrailingComma = hasCommaToken(raw, childEnd, closeOffset);
	const commaEdit = hasTrailingComma ? [] : [{ offset: childEnd, length: 0, content: "," }];
	const serializedPlugin = JSON.stringify(OPENCODE_PLUGIN_SPEC);
	const lineStart = raw.lastIndexOf("\n", lastChild.offset - 1) + 1;
	const indent = raw.slice(lineStart, lastChild.offset).match(/^[\t ]*/)?.[0] ?? "";
	const eol = raw.includes("\r\n") ? "\r\n" : "\n";
	const closeLineStart = raw.lastIndexOf("\n", closeOffset - 1) + 1;
	const closesOnOwnLine = raw.slice(closeLineStart, closeOffset).trim() === "";
	const insertionEdit = closesOnOwnLine
		? {
				offset: closeLineStart,
				length: 0,
				content: `${indent}${serializedPlugin}${hasTrailingComma ? "," : ""}${eol}`,
			}
		: {
				offset: closeOffset,
				length: 0,
				content: ` ${serializedPlugin}${hasTrailingComma ? "," : ""}`,
			};
	return applyEdits(raw, [...commaEdit, insertionEdit]);
}

function updateManagedPlugins(raw: string, plugins: unknown[]): string {
	let updated = raw;
	for (let index = plugins.length - 1; index >= 0; index--) {
		if (!isManagedPlugin(plugins[index])) continue;
		updated = removePluginEntry(updated, index);
	}
	const tree = parseTree(updated);
	const pluginNode = tree ? findNodeAtLocation(tree, ["plugin"]) : undefined;
	const children = pluginNode?.children ?? [];
	const lastChild = children.at(-1);
	if (!pluginNode || !lastChild) {
		return applyEdits(
			updated,
			modify(updated, ["plugin", children.length], OPENCODE_PLUGIN_SPEC, {
				isArrayInsertion: true,
			}),
		);
	}
	return appendManagedPlugin(updated, pluginNode, lastChild);
}

function configMetadata(path: string): ConfigFileMetadata | undefined {
	if (!existsSync(path)) return undefined;
	const stats = statSync(path);
	return { mode: stats.mode & 0o777, uid: stats.uid, gid: stats.gid };
}

function backupConfig(path: string, raw: string): void {
	atomicReplaceConfigFile(`${path}.codemem.bak`, raw, 0o600, undefined, undefined, {
		followSymlink: false,
	});
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
	if (exists && createBackup) backupConfig(path, raw);
	atomicReplaceConfigFile(path, output, configMetadata(path));
	return true;
}

/**
 * Write JSON config after copying any existing file to `<path>.codemem.bak`.
 * Backup failure is non-fatal (write still proceeds).
 */
export function writeJsonConfigWithBackup(path: string, data: Record<string, unknown>): void {
	if (existsSync(path)) {
		try {
			copyFileSync(path, `${path}.codemem.bak`);
		} catch {
			// Non-fatal: continue without a backup rather than blocking install.
		}
	}
	writeJsonConfig(path, data);
}
