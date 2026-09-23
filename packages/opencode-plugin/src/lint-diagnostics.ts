const MEASURED_CATEGORIES = new Set([
	"lint/complexity/noExcessiveCognitiveComplexity",
	"lint/complexity/noExcessiveLinesPerFunction",
]);

const DIAGNOSTIC_LIMIT = 10;

type UnknownRecord = Record<string, unknown>;

export interface LintDiagnostic {
	category: string;
	description: string;
	path?: string;
	line?: number;
	column?: number;
	offset?: number;
	sourceText?: string;
	scopeIdentity?: string;
	measuredValue?: number;
}

type SourceLookup = string | ((path: string | undefined) => string | undefined);

export function isMeasuredCategory(category: string): boolean {
	return MEASURED_CATEGORIES.has(category);
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}

function getText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(getText).join(" ");
	if (!isRecord(value)) return "";
	if (typeof value.content === "string") return value.content;
	if (typeof value.text === "string") return value.text;
	return Object.values(value).map(getText).join(" ");
}

function getSpanStart(location: UnknownRecord): number | undefined {
	if (Array.isArray(location.span) && typeof location.span[0] === "number") return location.span[0];
	if (!isRecord(location.span)) return undefined;
	if (typeof location.span.start === "number") return location.span.start;
	return typeof location.span.offset === "number" ? location.span.offset : undefined;
}

function getSpanEnd(location: UnknownRecord): number | undefined {
	if (Array.isArray(location.span) && typeof location.span[1] === "number") return location.span[1];
	if (!isRecord(location.span)) return undefined;
	if (typeof location.span.end === "number") return location.span.end;
	return typeof location.span.length === "number" && typeof location.span.offset === "number"
		? location.span.offset + location.span.length
		: undefined;
}

function getSourceText(location: UnknownRecord): string | undefined {
	if (typeof location.sourceCode !== "string") return undefined;
	const start = getSpanStart(location);
	const end = getSpanEnd(location);
	if (start === undefined || end === undefined) return undefined;
	return Buffer.from(location.sourceCode).subarray(start, end).toString("utf8");
}

function getPositionIndex(sourceCode: string, line: number, column: number): number | undefined {
	let index = 0;
	for (let currentLine = 1; currentLine < line; currentLine += 1) {
		const newline = sourceCode.indexOf("\n", index);
		if (newline === -1) return undefined;
		index = newline + 1;
	}
	return index + Math.max(column - 1, 0);
}

function getSourceTextFromPositions(
	location: UnknownRecord,
	sourceCode?: string,
): string | undefined {
	if (!sourceCode) return undefined;
	const start = isRecord(location.start) ? location.start : undefined;
	const end = isRecord(location.end) ? location.end : undefined;
	if (typeof start?.line !== "number" || typeof start.column !== "number") return undefined;
	const startIndex = getPositionIndex(sourceCode, start.line, start.column);
	if (startIndex === undefined) return undefined;
	const endIndex =
		typeof end?.line === "number" && typeof end.column === "number"
			? getPositionIndex(sourceCode, end.line, end.column)
			: sourceCode.indexOf("\n", startIndex);
	return sourceCode.slice(
		startIndex,
		endIndex === -1 || endIndex === undefined ? sourceCode.length : endIndex,
	);
}

function positionFromByteOffset(
	sourceCode: string,
	offset: number,
): { line: number; column: number } {
	const prefix = Buffer.from(sourceCode).subarray(0, offset).toString("utf8");
	const lines = prefix.split("\n");
	return {
		line: lines.length,
		column: Array.from(lines.at(-1) ?? "").length + 1,
	};
}

function getPosition(location: UnknownRecord): { line?: number; column?: number; offset?: number } {
	const start = isRecord(location.start) ? location.start : undefined;
	const offset = getSpanStart(location);
	if (
		typeof start?.line !== "number" &&
		offset !== undefined &&
		typeof location.sourceCode === "string"
	) {
		return { ...positionFromByteOffset(location.sourceCode, offset), offset };
	}
	return {
		line: typeof start?.line === "number" ? start.line : undefined,
		column: typeof start?.column === "number" ? start.column : undefined,
		offset,
	};
}

function getDiagnosticPath(location: UnknownRecord): string | undefined {
	if (typeof location.path === "string") return location.path;
	return isRecord(location.path) && typeof location.path.file === "string"
		? location.path.file
		: undefined;
}

function sourceForPath(
	source: SourceLookup | undefined,
	path: string | undefined,
): string | undefined {
	return typeof source === "function" ? source(path) : source;
}

function skipQuotedSource(source: string, start: number, quote: string): number {
	for (let index = start + 1; index < source.length; index += 1) {
		if (source[index] === "\\") index += 1;
		else if (source[index] === quote) return index + 1;
	}
	return source.length;
}

function skipSourceComment(source: string, start: number, multiline: boolean): number {
	const closing = multiline ? source.indexOf("*/", start + 2) : source.indexOf("\n", start + 2);
	if (closing === -1) return source.length;
	return closing + (multiline ? 2 : 1);
}

function sourceTokenEnd(source: string, index: number): number | undefined {
	const current = source[index] ?? "";
	if (current === '"' || current === "'" || current === "`") {
		return skipQuotedSource(source, index, current);
	}
	if (current !== "/" || !["/", "*"].includes(source[index + 1] ?? "")) return undefined;
	return skipSourceComment(source, index, source[index + 1] === "*");
}

interface ClassScopeState {
	classes: Array<{ name: string; depth: number }>;
	pendingClass: { name: string; parentheses: number; brackets: number } | undefined;
	braceDepth: number;
	parentheses: number;
	brackets: number;
}

function classDeclarationName(
	source: string,
	index: number,
	identifier: string,
): string | undefined {
	if (identifier !== "class") return undefined;
	const remainder = source.slice(index + identifier.length);
	const name = remainder.match(/^\s+([A-Za-z_$][\w$]*)/u)?.[1];
	return name === "extends" ? undefined : name;
}

function updateClassNesting(state: ClassScopeState, current: string): void {
	if (current === "(") state.parentheses += 1;
	else if (current === ")") state.parentheses = Math.max(0, state.parentheses - 1);
	else if (current === "[") state.brackets += 1;
	else if (current === "]") state.brackets = Math.max(0, state.brackets - 1);
	else if (current === "{") {
		state.braceDepth += 1;
		if (
			state.pendingClass?.parentheses === state.parentheses &&
			state.pendingClass.brackets === state.brackets
		) {
			state.classes.push({ name: state.pendingClass.name, depth: state.braceDepth });
			state.pendingClass = undefined;
		}
	} else if (current === "}") {
		if (state.classes.at(-1)?.depth === state.braceDepth) state.classes.pop();
		state.braceDepth = Math.max(0, state.braceDepth - 1);
	}
}

function classNameAtLine(sourceCode: string, line: number): string {
	const source = sourceCode.split("\n").slice(0, line).join("\n");
	const state: ClassScopeState = {
		classes: [],
		pendingClass: undefined,
		braceDepth: 0,
		parentheses: 0,
		brackets: 0,
	};

	for (let index = 0; index < source.length; index += 1) {
		const current = source[index] ?? "";
		const tokenEnd = sourceTokenEnd(source, index);
		if (tokenEnd !== undefined) {
			index = tokenEnd - 1;
			continue;
		}
		if (/[A-Za-z_$]/u.test(current)) {
			const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/u)?.[0] ?? "";
			const name = classDeclarationName(source, index, identifier);
			if (name) {
				state.pendingClass = {
					name,
					parentheses: state.parentheses,
					brackets: state.brackets,
				};
			}
			index += identifier.length - 1;
			continue;
		}
		updateClassNesting(state, current);
	}
	return state.classes.at(-1)?.name ?? "";
}

/** Recognize literal route handlers; other call shapes retain the conservative fallback. */
function routeScopeAtLine(source: string, lineStart: number, lineEnd: number) {
	const braces: Array<{ identity: string; start: number } | undefined> = [];
	for (let index = 0; index < lineEnd; index += 1) {
		const tokenEnd = sourceTokenEnd(source, index);
		if (tokenEnd !== undefined) {
			index = tokenEnd - 1;
			continue;
		}
		const route = source
			.slice(index)
			.match(
				/^([\w$]+)\.(get|post|put|patch|delete|options|head|all)\(\s*(["'])([^"'\\\r\n]*)\3\s*,\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function\s*[\w$]*\s*\([^)]*\))\s*\{/,
			);
		if (route) {
			const owner = { identity: `route:${route[1]}.${route[2]}:${route[4]}`, start: index };
			if (index >= lineStart) return { ...owner, direct: true };
			braces.push(owner);
			index += route[0].length - 1;
			continue;
		}
		if (source[index] === "{") braces.push(undefined);
		if (source[index] === "}") braces.pop();
	}
	const owner = braces.findLast((entry) => entry !== undefined);
	return owner ? { ...owner, direct: false } : undefined;
}

function testCallbackScopeAtLine(line: string): string | undefined {
	const match = line.match(
		/^\s*(it|test|describe)(?:\.(?:only|skip))?\(\s*(["'`])([^"'`\\\r\n]+)\2\s*,\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*\{/,
	);
	return match ? `:${match[1]}:${match[3]}` : undefined;
}

function nearestScopeIdentity(lines: string[], prefix: string): string | undefined {
	for (const sourceLine of lines.toReversed()) {
		const functionMatch = sourceLine.match(/\bfunction\s+([\w$]+)/);
		if (functionMatch?.[1]) return `${prefix}:function:${functionMatch[1]}`;
		const bindingMatch = sourceLine.match(/\b(?:const|let|var)\s+([\w$]+)\s*=/);
		if (bindingMatch?.[1]) return `${prefix}:binding:${bindingMatch[1]}`;
		const methodMatch = sourceLine.match(/^\s*(?:async\s+)?(?:get\s+|set\s+)?([\w$]+)\s*\(/);
		if (methodMatch?.[1] && !["if", "for", "switch", "while"].includes(methodMatch[1])) {
			return `${prefix}:method:${methodMatch[1]}`;
		}
	}
	return undefined;
}

export function getScopeIdentity(
	sourceCode: string | undefined,
	line: number | undefined,
): string | undefined {
	if (!sourceCode || !line) return undefined;
	let precedingLines = sourceCode.split("\n").slice(0, line);
	const lineEnd = precedingLines.join("\n").length;
	const lineStart = lineEnd - (precedingLines.at(-1)?.length ?? 0);
	const route = routeScopeAtLine(sourceCode, lineStart, lineEnd);
	if (route?.direct) return `${route.identity}:handler`;
	if (!route) {
		const test = testCallbackScopeAtLine(precedingLines.at(-1) ?? "");
		if (test) return test;
	}
	if (route) precedingLines = sourceCode.slice(route.start, lineEnd).split("\n");
	const className = classNameAtLine(sourceCode, line);
	const prefix = route?.identity ?? className;
	return nearestScopeIdentity(precedingLines, prefix);
}

export function parseMeasuredValue(category: string, text: string): number | undefined {
	if (category.endsWith("noExcessiveCognitiveComplexity")) {
		const match = text.match(/complexity(?:\s+score)?(?:\s+(?:of|is|from)|:)?\s+(\d+)/i);
		return match ? Number(match[1]) : undefined;
	}
	if (category.endsWith("noExcessiveLinesPerFunction")) {
		const match = text.match(
			/(?:has|contains)\s+(\d+)\s+lines?|lines?\s*\((\d+)\)|(\d+)\s+lines?/i,
		);
		const value = match?.slice(1).find((item) => item !== undefined);
		return value ? Number(value) : undefined;
	}
	return undefined;
}

export function parseBiomeDiagnostics(output: string, source?: SourceLookup): LintDiagnostic[] {
	const parsed: unknown = JSON.parse(output);
	if (!isRecord(parsed) || !Array.isArray(parsed.diagnostics)) {
		throw new Error("Biome output has no diagnostics array");
	}

	return parsed.diagnostics.flatMap((raw): LintDiagnostic[] => {
		if (!isRecord(raw) || typeof raw.category !== "string" || !raw.category.startsWith("lint/")) {
			return [];
		}
		const location = isRecord(raw.location) ? raw.location : {};
		const description =
			typeof raw.description === "string" ? raw.description : getText(raw.message);
		const position = getPosition(location);
		const diagnosticPath = getDiagnosticPath(location);
		const sourceCode = sourceForPath(source, diagnosticPath);
		const measuredValue =
			parseMeasuredValue(raw.category, getText([description, raw.message])) ??
			parseMeasuredValue(raw.category, getText([raw.advices, raw.advice]));
		return [
			{
				category: raw.category,
				description,
				path: diagnosticPath,
				line: position.line,
				column: position.column,
				offset: position.offset,
				sourceText: getSourceText(location) ?? getSourceTextFromPositions(location, sourceCode),
				scopeIdentity: getScopeIdentity(sourceCode, position.line),
				measuredValue,
			},
		];
	});
}

function groupDiagnostics(diagnostics: LintDiagnostic[]): Map<string, LintDiagnostic[]> {
	const groups = new Map<string, LintDiagnostic[]>();
	for (const diagnostic of diagnostics) {
		const group = groups.get(diagnostic.category) ?? [];
		group.push(diagnostic);
		groups.set(diagnostic.category, group);
	}
	return groups;
}

function diagnosticDistance(before: LintDiagnostic, after: LintDiagnostic): number {
	if (before.offset !== undefined && after.offset !== undefined) {
		return Math.abs(before.offset - after.offset);
	}
	if (before.line === undefined || after.line === undefined) return 0;
	const lineDistance = Math.abs(before.line - after.line);
	const columnDistance =
		before.column === undefined || after.column === undefined
			? 0
			: Math.abs(before.column - after.column);
	return lineDistance * 1_000 + columnDistance;
}

function candidateIndexes(
	previous: LintDiagnostic,
	diagnostics: LintDiagnostic[],
	allowRenameFallback: boolean,
): number[] {
	const exactScope = diagnostics.flatMap((diagnostic, index) =>
		diagnostic.scopeIdentity && diagnostic.scopeIdentity === previous.scopeIdentity ? [index] : [],
	);
	if (exactScope.length > 0) return exactScope;
	const exactSource = diagnostics.flatMap((diagnostic, index) =>
		diagnostic.sourceText && diagnostic.sourceText === previous.sourceText ? [index] : [],
	);
	if (exactSource.length > 0 && (!previous.scopeIdentity || exactSource.length === 1))
		return exactSource;
	if (previous.scopeIdentity && (!allowRenameFallback || diagnostics.length !== 1)) return [];
	return diagnostics.map((_, index) => index);
}

function nearestCandidate(
	previous: LintDiagnostic,
	diagnostics: LintDiagnostic[],
	allowRenameFallback: boolean,
): number | undefined {
	const indexes = candidateIndexes(previous, diagnostics, allowRenameFallback);
	let nearest = indexes[0];
	for (const index of indexes.slice(1)) {
		if (nearest === undefined) return index;
		const candidate = diagnostics[index];
		const current = diagnostics[nearest];
		if (
			candidate &&
			current &&
			diagnosticDistance(previous, candidate) < diagnosticDistance(previous, current)
		) {
			nearest = index;
		}
	}
	return nearest;
}

function compareMeasured(before: LintDiagnostic[], after: LintDiagnostic[]): LintDiagnostic[] {
	const unmatched = [...after];
	const regressions: LintDiagnostic[] = [];
	const allowRenameFallback = before.length === 1 && after.length === 1;
	for (const previous of before) {
		const nearest = nearestCandidate(previous, unmatched, allowRenameFallback);
		if (nearest === undefined) {
			if (unmatched.length === 0) break;
			continue;
		}
		const current = unmatched.splice(nearest, 1)[0];
		if (current && (current.measuredValue ?? 0) > (previous.measuredValue ?? 0)) {
			regressions.push(current);
		}
	}
	return [...regressions, ...unmatched];
}

function compareCountOnly(before: LintDiagnostic[], after: LintDiagnostic[]): LintDiagnostic[] {
	const unmatched = [...after];
	for (const previous of before) {
		const candidates = unmatched.flatMap((diagnostic, index) => {
			if (diagnostic.description !== previous.description) return [];
			if (
				previous.scopeIdentity &&
				diagnostic.scopeIdentity &&
				diagnostic.scopeIdentity !== previous.scopeIdentity
			) {
				return [];
			}
			if (
				previous.sourceText &&
				diagnostic.sourceText &&
				diagnostic.sourceText !== previous.sourceText
			) {
				return [];
			}
			return [index];
		});
		let nearest = candidates[0];
		for (const index of candidates.slice(1)) {
			if (nearest === undefined) break;
			const candidate = unmatched[index];
			const current = unmatched[nearest];
			if (
				candidate &&
				current &&
				diagnosticDistance(previous, candidate) < diagnosticDistance(previous, current)
			) {
				nearest = index;
			}
		}
		if (nearest !== undefined) unmatched.splice(nearest, 1);
	}
	return unmatched;
}

export function compareDiagnostics(
	before: LintDiagnostic[],
	after: LintDiagnostic[],
): LintDiagnostic[] {
	const beforeByCategory = groupDiagnostics(before);
	const afterByCategory = groupDiagnostics(after);
	const regressions: LintDiagnostic[] = [];
	for (const [category, current] of afterByCategory) {
		const previous = beforeByCategory.get(category) ?? [];
		regressions.push(
			...(isMeasuredCategory(category)
				? compareMeasured(previous, current)
				: compareCountOnly(previous, current)),
		);
	}
	return regressions;
}

export function formatDiagnostic(diagnostic: LintDiagnostic): string {
	const value = diagnostic.measuredValue === undefined ? "" : ` (${diagnostic.measuredValue})`;
	let position = "";
	if (diagnostic.line) {
		position = `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}`;
	} else if (diagnostic.offset !== undefined) {
		position = `@byte ${diagnostic.offset}`;
	}
	const location = diagnostic.path ? `${diagnostic.path}${position} — ` : "";
	return `- ${location}${diagnostic.category}${value}: ${diagnostic.description}`;
}

export function formatFeedback(diagnostics: LintDiagnostic[], limit = DIAGNOSTIC_LIMIT): string {
	const visible = diagnostics.slice(0, limit);
	const remaining = diagnostics.length - visible.length;
	const suffix =
		remaining > 0 ? `\n- …and ${remaining} more regression${remaining === 1 ? "" : "s"}.` : "";
	return `[lint-feedback] New or worsened diagnostics:\n${visible.map(formatDiagnostic).join("\n")}${suffix}\nFix local regressions now. Do not broadly refactor legacy code.`;
}
