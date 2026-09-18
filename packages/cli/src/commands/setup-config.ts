import { randomUUID } from "node:crypto";
import {
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { atomicReplaceConfigFile, stripJsonComments, stripTrailingCommas } from "@codemem/core";

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
	const raw = readFileSync(path, "utf-8");
	return parseJsoncConfig(raw);
}

interface ValueSpan {
	start: number;
	end: number;
}

interface PropertySpan {
	key: string;
	start: number;
	value: ValueSpan;
}

function skipTrivia(text: string, offset: number): number {
	let index = offset;
	while (index < text.length) {
		if (/\s/.test(text[index] ?? "")) {
			index++;
			continue;
		}
		if (text.startsWith("//", index)) {
			const newline = text.indexOf("\n", index + 2);
			return newline === -1 ? text.length : skipTrivia(text, newline + 1);
		}
		if (text.startsWith("/*", index)) {
			const close = text.indexOf("*/", index + 2);
			return close === -1 ? text.length : skipTrivia(text, close + 2);
		}
		break;
	}
	return index;
}

function scanString(text: string, offset: number): number {
	let escaped = false;
	for (let index = offset + 1; index < text.length; index++) {
		const char = text[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') return index + 1;
	}
	return text.length;
}

function scanPrimitive(text: string, start: number): number {
	let index = start;
	while (index < text.length) {
		const char = text[index] ?? "";
		if (/\s/.test(char) || ",}]".includes(char)) break;
		if (text.startsWith("//", index) || text.startsWith("/*", index)) break;
		index++;
	}
	return index;
}

function skipComment(text: string, index: number): number | undefined {
	if (text.startsWith("//", index)) {
		const newline = text.indexOf("\n", index + 2);
		return newline === -1 ? text.length : newline + 1;
	}
	if (text.startsWith("/*", index)) {
		const close = text.indexOf("*/", index + 2);
		return close === -1 ? text.length : close + 2;
	}
	return undefined;
}

function scanComposite(text: string, start: number): number {
	const stack = [text[start] === "{" ? "}" : "]"];
	let index = start + 1;
	while (index < text.length && stack.length > 0) {
		if (text[index] === '"') {
			index = scanString(text, index);
			continue;
		}
		const afterComment = skipComment(text, index);
		if (afterComment !== undefined) {
			index = afterComment;
			continue;
		}
		if (text[index] === "{") stack.push("}");
		if (text[index] === "[") stack.push("]");
		if (text[index] === stack.at(-1)) stack.pop();
		index++;
	}
	return index;
}

function scanValue(text: string, offset: number): number {
	const start = skipTrivia(text, offset);
	if (text[start] === '"') return scanString(text, start);
	if (text[start] === "{" || text[start] === "[") return scanComposite(text, start);
	return scanPrimitive(text, start);
}

function listProperties(text: string, object: ValueSpan): PropertySpan[] {
	const properties: PropertySpan[] = [];
	let index = skipTrivia(text, object.start + 1);
	while (index < object.end - 1 && text[index] !== "}") {
		if (text[index] !== '"') break;
		const propertyStart = index;
		const keyEnd = scanString(text, index);
		const parsedKey = JSON.parse(text.slice(index, keyEnd)) as string;
		index = skipTrivia(text, keyEnd);
		if (text[index] !== ":") break;
		const valueStart = skipTrivia(text, index + 1);
		const valueEnd = scanValue(text, valueStart);
		properties.push({
			key: parsedKey,
			start: propertyStart,
			value: { start: valueStart, end: valueEnd },
		});
		index = skipTrivia(text, valueEnd);
		if (text[index] === ",") index = skipTrivia(text, index + 1);
	}
	return properties;
}

function findProperty(text: string, object: ValueSpan, key: string): ValueSpan | undefined {
	return listProperties(text, object).find((property) => property.key === key)?.value;
}

function findPath(text: string, path: string[]): ValueSpan | undefined {
	let span: ValueSpan = { start: skipTrivia(text, 0), end: text.length };
	for (const key of path) {
		if (text[span.start] !== "{") return undefined;
		const child = findProperty(text, span, key);
		if (!child) return undefined;
		span = child;
	}
	return span;
}

function findArrayElement(
	text: string,
	array: ValueSpan,
	targetIndex: number,
): ValueSpan | undefined {
	let index = skipTrivia(text, array.start + 1);
	let elementIndex = 0;
	while (index < array.end - 1 && text[index] !== "]") {
		const end = scanValue(text, index);
		if (elementIndex === targetIndex) return { start: index, end };
		index = skipTrivia(text, end);
		if (text[index] === ",") index = skipTrivia(text, index + 1);
		elementIndex++;
	}
	return undefined;
}

function listArrayValues(text: string, array: ValueSpan): ValueSpan[] {
	const values: ValueSpan[] = [];
	let index = skipTrivia(text, array.start + 1);
	while (index < array.end - 1 && text[index] !== "]") {
		const end = scanValue(text, index);
		values.push({ start: index, end });
		index = skipTrivia(text, end);
		if (text[index] === ",") index = skipTrivia(text, index + 1);
	}
	return values;
}

function assertUniqueKeysInValue(text: string, value: ValueSpan): void {
	if (text[value.start] === "{") {
		assertUniqueObjectKeys(text, value);
		return;
	}
	if (text[value.start] !== "[") return;
	for (const child of listArrayValues(text, value)) assertUniqueKeysInValue(text, child);
}

function assertUniqueObjectKeys(text: string, object: ValueSpan): void {
	const seen = new Set<string>();
	for (const property of listProperties(text, object)) {
		if (seen.has(property.key)) throw new Error(`Duplicate JSONC key: ${property.key}`);
		seen.add(property.key);
		assertUniqueKeysInValue(text, property.value);
	}
}

function assertTerminatedBlockComments(text: string): void {
	let index = 0;
	while (index < text.length) {
		if (text[index] === '"') {
			index = scanString(text, index);
			continue;
		}
		if (text.startsWith("//", index)) {
			const newline = text.indexOf("\n", index + 2);
			index = newline === -1 ? text.length : newline + 1;
			continue;
		}
		if (!text.startsWith("/*", index)) {
			index++;
			continue;
		}
		const close = text.indexOf("*/", index + 2);
		if (close === -1) throw new Error("Unterminated block comment in JSONC config");
		index = close + 2;
	}
}

function parseJsoncConfig(text: string): Record<string, unknown> {
	assertTerminatedBlockComments(text);
	const cleaned = stripTrailingCommas(stripJsonComments(text));
	const parsed = JSON.parse(cleaned) as unknown;
	if (!isRecord(parsed)) throw new Error("OpenCode config must be a JSON object");
	const rootStart = skipTrivia(text, 0);
	const root: ValueSpan = { start: rootStart, end: scanValue(text, rootStart) };
	assertUniqueObjectKeys(text, root);
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ConfigChange {
	path: string[];
	deleted: boolean;
}

function collectChanges(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	prefix: string[] = [],
): ConfigChange[] {
	const changes: ConfigChange[] = [];
	for (const [key, value] of Object.entries(after)) {
		const previous = before[key];
		if (JSON.stringify(previous) === JSON.stringify(value)) continue;
		if (isRecord(previous) && isRecord(value)) {
			changes.push(...collectChanges(previous, value, [...prefix, key]));
			continue;
		}
		changes.push({ path: [...prefix, key], deleted: false });
	}
	for (const key of Object.keys(before)) {
		if (Object.hasOwn(after, key)) continue;
		changes.push({ path: [...prefix, key], deleted: true });
	}
	return changes;
}

function valueAtPath(data: Record<string, unknown>, path: string[]): unknown {
	let value: unknown = data;
	for (const key of path) value = (value as Record<string, unknown>)[key];
	return value;
}

function formatValue(value: unknown, indent: string): string {
	const serialized = JSON.stringify(value, null, 2);
	if (serialized === undefined) throw new Error("Cannot serialize undefined JSONC value");
	return serialized.replaceAll("\n", `\n${indent}`);
}

function insertProperty(text: string, parent: ValueSpan, key: string, value: unknown): string {
	const multiline = text.slice(parent.start, parent.end).includes("\n");
	const lineStart = text.lastIndexOf("\n", parent.start) + 1;
	const parentIndent = text.slice(lineStart, parent.start).match(/^\s*/)?.[0] ?? "";
	const firstContent = skipTrivia(text, parent.start + 1);
	const firstLineStart = text.lastIndexOf("\n", firstContent) + 1;
	const existingIndent = text.slice(firstLineStart, firstContent).match(/^\s*/)?.[0];
	const childIndent =
		firstContent < parent.end - 1 ? existingIndent || `${parentIndent}\t` : `${parentIndent}\t`;
	const empty = text[firstContent] === "}";
	const rendered = formatValue(value, childIndent);
	const insertion = multiline
		? `\n${childIndent}${JSON.stringify(key)}: ${rendered}${empty ? "" : ","}`
		: `${JSON.stringify(key)}: ${rendered}${empty ? "" : ", "}`;
	return `${text.slice(0, parent.start + 1)}${insertion}${text.slice(parent.start + 1)}`;
}

function appendArrayValue(text: string, array: ValueSpan, value: unknown): string {
	const multiline = text.slice(array.start, array.end).includes("\n");
	const lineStart = text.lastIndexOf("\n", array.start) + 1;
	const parentIndent = text.slice(lineStart, array.start).match(/^\s*/)?.[0] ?? "";
	const firstContent = skipTrivia(text, array.start + 1);
	const firstLineStart = text.lastIndexOf("\n", firstContent) + 1;
	const existingIndent = text.slice(firstLineStart, firstContent).match(/^\s*/)?.[0];
	const childIndent =
		firstContent < array.end - 1 ? existingIndent || `${parentIndent}\t` : `${parentIndent}\t`;
	const empty = text[firstContent] === "]";
	const contentWithoutComments = stripJsonComments(text.slice(array.start + 1, array.end - 1));
	const separator = empty || contentWithoutComments.trimEnd().endsWith(",") ? "" : ",";
	const rendered = formatValue(value, childIndent);
	let insertion: string;
	if (multiline) {
		insertion = `${separator}\n${childIndent}${rendered}\n${parentIndent}`;
	} else if (empty) {
		insertion = rendered;
	} else {
		insertion = `${separator} ${rendered}`;
	}
	return `${text.slice(0, array.end - 1)}${insertion}${text.slice(array.end - 1)}`;
}

function isSingleAppend(before: unknown, after: unknown): after is unknown[] {
	return (
		Array.isArray(before) &&
		Array.isArray(after) &&
		after.length === before.length + 1 &&
		before.every((value, index) => JSON.stringify(value) === JSON.stringify(after[index]))
	);
}

function singleReplacementIndex(before: unknown, after: unknown): number | undefined {
	if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) {
		return undefined;
	}
	const changed = before.flatMap((value, index) =>
		JSON.stringify(value) === JSON.stringify(after[index]) ? [] : [index],
	);
	return changed.length === 1 ? changed[0] : undefined;
}

function isManagedPlugin(entry: unknown): boolean {
	return (
		matchesPluginSpec(entry, OPENCODE_PLUGIN_SPEC) ||
		LEGACY_OPENCODE_PLUGIN_SPECS.some((spec) => matchesPluginSpec(entry, spec))
	);
}

interface TextEdit {
	start: number;
	end: number;
	replacement: string;
}

function applyTextEdits(text: string, edits: TextEdit[]): string {
	let updated = text;
	for (const edit of edits.sort((left, right) => right.start - left.start)) {
		updated = `${updated.slice(0, edit.start)}${edit.replacement}${updated.slice(edit.end)}`;
	}
	return updated;
}

function replaceArrayElement(
	text: string,
	array: ValueSpan,
	before: unknown,
	after: unknown,
): string | undefined {
	const replacementIndex = singleReplacementIndex(before, after);
	if (replacementIndex === undefined || !Array.isArray(after)) return undefined;
	const element = findArrayElement(text, array, replacementIndex);
	if (!element) return undefined;
	const replacement = formatValue(after[replacementIndex], "");
	return `${text.slice(0, element.start)}${replacement}${text.slice(element.end)}`;
}

function arrayValueMapping(before: unknown[], after: unknown[]): Map<number, number> {
	const mapping = new Map<number, number>();
	const matchedBefore = new Set<number>();
	let afterStart = 0;
	for (const [beforeIndex, value] of before.entries()) {
		const afterIndex = after.findIndex(
			(candidate, index) =>
				index >= afterStart && JSON.stringify(candidate) === JSON.stringify(value),
		);
		if (afterIndex === -1) continue;
		mapping.set(afterIndex, beforeIndex);
		matchedBefore.add(beforeIndex);
		afterStart = afterIndex + 1;
	}
	const unmatchedBefore = before
		.map((_, index) => index)
		.filter((index) => !matchedBefore.has(index));
	const unmatchedAfter = after.map((_, index) => index).filter((index) => !mapping.has(index));
	for (const afterIndex of unmatchedAfter) {
		const beforeIndex = unmatchedBefore.shift();
		if (beforeIndex === undefined) break;
		mapping.set(afterIndex, beforeIndex);
	}
	return mapping;
}

function trailingComments(text: string): string[] {
	return text.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g) ?? [];
}

function commentsAroundBoundary(text: string): { trailing: string[]; leading: string[] } {
	const newline = text.search(/[\r\n]/);
	if (newline === -1) return { trailing: trailingComments(text), leading: [] };
	const comments = [...text.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g)];
	return {
		trailing: comments
			.filter((comment) => (comment.index ?? 0) < newline)
			.map((comment) => comment[0]),
		leading: comments
			.filter((comment) => (comment.index ?? 0) >= newline)
			.map((comment) => comment[0]),
	};
}

function arrayIndent(text: string, firstElement: ValueSpan): string {
	const firstLineStart = text.lastIndexOf("\n", firstElement.start) + 1;
	return text.slice(firstLineStart, firstElement.start).match(/^\s*/)?.[0] ?? "";
}

function commentTargetIndex(
	beforeIndex: number,
	before: unknown[],
	after: unknown[],
	mapping: Map<number, number>,
): number | undefined {
	for (const [afterIndex, mappedBeforeIndex] of mapping) {
		if (mappedBeforeIndex === beforeIndex) return afterIndex;
	}
	if (isManagedPlugin(before[beforeIndex])) {
		const managedIndex = after.findIndex(isManagedPlugin);
		if (managedIndex !== -1) return managedIndex;
	}
	const mappedEntries = [...mapping.entries()];
	const next = mappedEntries.find(([, mappedBeforeIndex]) => mappedBeforeIndex > beforeIndex);
	if (next) return next[0];
	return mappedEntries.findLast(([, mappedBeforeIndex]) => mappedBeforeIndex < beforeIndex)?.[0];
}

function expandEmptyArray(text: string, array: ValueSpan, values: unknown[]): string {
	let updated = text;
	let currentArray = array;
	for (const value of values) {
		const expanded = appendArrayValue(updated, currentArray, value);
		currentArray = {
			start: currentArray.start,
			end: currentArray.end + expanded.length - updated.length,
		};
		updated = expanded;
	}
	return updated;
}

function mapArrayComments(
	before: unknown[],
	after: unknown[],
	mapping: Map<number, number>,
	commentsByBeforeIndex: string[][],
): string[][] {
	const commentsByAfterIndex = after.map((): string[] => []);
	for (const [beforeIndex, comments] of commentsByBeforeIndex.entries()) {
		const targetIndex = commentTargetIndex(beforeIndex, before, after, mapping);
		if (targetIndex !== undefined) commentsByAfterIndex[targetIndex]?.push(...comments);
	}
	return commentsByAfterIndex;
}

function reconcileArrayElements(
	text: string,
	array: ValueSpan,
	before: unknown,
	after: unknown,
): string | undefined {
	if (!Array.isArray(before) || !Array.isArray(after)) return undefined;
	const elements = listArrayValues(text, array);
	if (elements.length !== before.length) return undefined;
	if (elements.length === 0) return expandEmptyArray(text, array, after);
	const multiline = text.slice(array.start, array.end).includes("\n");
	const separator = multiline ? `\n${arrayIndent(text, elements[0] as ValueSpan)}` : " ";
	const mapping = arrayValueMapping(before, after);
	const commentsByBeforeIndex = elements.map((): string[] => []);
	for (const [index, element] of elements.entries()) {
		const nextStart = elements[index + 1]?.start ?? array.end - 1;
		const comments = commentsAroundBoundary(text.slice(element.end, nextStart));
		commentsByBeforeIndex[index]?.push(...comments.trailing);
		if (index + 1 < elements.length) {
			commentsByBeforeIndex[index + 1]?.push(...comments.leading);
		} else {
			commentsByBeforeIndex[index]?.push(...comments.leading);
		}
	}
	const commentsByAfterIndex = mapArrayComments(before, after, mapping, commentsByBeforeIndex);
	const lastSuffix = text.slice((elements.at(-1) as ValueSpan).end, array.end - 1);
	const keepTrailingComma = stripJsonComments(lastSuffix).includes(",");
	const rendered = after.map((value, index) => {
		const comments = commentsByAfterIndex[index] ?? [];
		const comma = index < after.length - 1 || keepTrailingComma ? "," : "";
		const commentText = comments.length > 0 ? ` ${comments.join(" ")}` : "";
		return `${formatValue(value, "")}${comma}${commentText}`;
	});
	const firstElement = elements[0] as ValueSpan;
	const leading = text.slice(array.start + 1, firstElement.start);
	const lineStart = text.lastIndexOf("\n", array.start) + 1;
	const parentIndent = text.slice(lineStart, array.start).match(/^\s*/)?.[0] ?? "";
	const closing = multiline ? `\n${parentIndent}` : "";
	return `${text.slice(0, array.start + 1)}${leading}${rendered.join(separator)}${closing}${text.slice(array.end - 1)}`;
}

function updateExistingValue(
	text: string,
	span: ValueSpan,
	before: unknown,
	after: unknown,
): string {
	if (text[span.start] === "[") {
		if (isSingleAppend(before, after)) return appendArrayValue(text, span, after.at(-1));
		const replaced = replaceArrayElement(text, span, before, after);
		if (replaced !== undefined) return replaced;
		const reconciledElements = reconcileArrayElements(text, span, before, after);
		if (reconciledElements !== undefined) return reconciledElements;
	}
	const lineStart = text.lastIndexOf("\n", span.start) + 1;
	const indent = text.slice(lineStart, span.start).match(/^\s*/)?.[0] ?? "";
	return `${text.slice(0, span.start)}${formatValue(after, indent)}${text.slice(span.end)}`;
}

function deleteProperty(text: string, path: string[]): string {
	const parent = findPath(text, path.slice(0, -1));
	if (!parent) throw new Error(`Cannot locate JSONC parent for ${path.join(".")}`);
	const key = path.at(-1) ?? "";
	const property = listProperties(text, parent).find((candidate) => candidate.key === key);
	if (!property) throw new Error(`Cannot locate JSONC property ${path.join(".")}`);
	const preservedComments = trailingComments(text.slice(property.start, property.value.start));
	const edits: TextEdit[] = [
		{
			start: property.start,
			end: property.value.end,
			replacement: preservedComments.join(" "),
		},
	];
	const comma = skipTrivia(text, property.value.end);
	if (text[comma] === ",") edits.push({ start: comma, end: comma + 1, replacement: "" });
	return applyTextEdits(text, edits);
}

function updateJsoncText(
	raw: string,
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): string {
	let updated = raw;
	const changes = collectChanges(before, after).sort(
		(left, right) => right.path.length - left.path.length,
	);
	for (const change of changes) {
		const { path } = change;
		if (change.deleted) {
			updated = deleteProperty(updated, path);
			continue;
		}
		const span = findPath(updated, path);
		const value = valueAtPath(after, path);
		if (span) {
			const previous = valueAtPath(before, path);
			updated = updateExistingValue(updated, span, previous, value);
			continue;
		}
		const parent = findPath(updated, path.slice(0, -1));
		if (!parent) throw new Error(`Cannot update JSONC path ${path.join(".")}`);
		updated = insertProperty(updated, parent, path.at(-1) ?? "", value);
	}
	return updated;
}

export function writeJsonConfig(
	path: string,
	data: Record<string, unknown>,
	{ createBackup = true }: { createBackup?: boolean } = {},
): boolean {
	mkdirSync(dirname(path), { recursive: true });
	const pathStat = lstatSync(path, { throwIfNoEntry: false });
	if (pathStat?.isSymbolicLink()) {
		throw new Error(`Refusing to replace symlink-managed config: ${path}`);
	}
	const exists = pathStat !== undefined;
	const raw = exists ? readFileSync(path, "utf-8") : "{}\n";
	const before = exists ? loadJsoncConfig(path) : {};
	const output = updateJsoncText(raw, before, data);
	if (output === raw) return false;
	parseJsoncConfig(output);

	if (exists && createBackup) {
		const backupPath = `${path}.codemem.bak`;
		const temporaryBackupPath = `${backupPath}.tmp-${process.pid}-${randomUUID()}`;
		try {
			copyFileSync(path, temporaryBackupPath, constants.COPYFILE_EXCL);
			renameSync(temporaryBackupPath, backupPath);
		} catch (error) {
			rmSync(temporaryBackupPath, { force: true });
			throw error;
		}
	}
	const metadata = exists ? statSync(path) : undefined;
	atomicReplaceConfigFile(path, output, metadata);
	return true;
}
