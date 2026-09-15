import {
	compareDiagnostics,
	getScopeIdentity,
	isMeasuredCategory,
	type LintDiagnostic,
	parseBiomeDiagnostics,
} from "./lint-diagnostics.js";

type UnknownRecord = Record<string, unknown>;

export interface ChangedPath {
	status: "added" | "deleted" | "modified" | "renamed";
	beforePath?: string;
	afterPath?: string;
	beforeSource?: string;
	afterSource?: string;
}

export interface PolicyViolation {
	kind: "coverage" | "rule-level" | "threshold" | "suppression";
	message: string;
	path?: string;
}

export interface RatchetComparison {
	regressions: LintDiagnostic[];
	policyViolations: PolicyViolation[];
	baseDiagnosticCount: number;
	headDiagnosticCount: number;
}

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function parseSummary(output: string): UnknownRecord {
	const parsed: unknown = JSON.parse(output);
	if (!isRecord(parsed) || !isRecord(parsed.summary) || !Array.isArray(parsed.diagnostics)) {
		throw new Error("Biome JSON does not match the pinned reporter schema");
	}
	const summary = parsed.summary;
	for (const field of ["errors", "warnings", "infos", "diagnosticsNotPrinted"]) {
		if (typeof summary[field] !== "number") {
			throw new Error(`Biome JSON summary is missing numeric ${field}`);
		}
	}
	if (summary.diagnosticsNotPrinted !== 0) {
		throw new Error("Biome JSON omitted diagnostics; comparison would be incomplete");
	}
	const reported =
		(summary.errors as number) + (summary.warnings as number) + (summary.infos as number);
	if (reported !== parsed.diagnostics.length) {
		throw new Error("Biome JSON diagnostic count does not match its summary");
	}
	for (const diagnostic of parsed.diagnostics) {
		if (
			!isRecord(diagnostic) ||
			typeof diagnostic.category !== "string" ||
			!diagnostic.category.startsWith("lint/")
		) {
			throw new Error("Biome emitted a non-lint diagnostic; comparison is ambiguous");
		}
	}
	return parsed;
}

export function parsePinnedBiomeReport(
	output: string,
	source?: (path: string | undefined) => string | undefined,
): LintDiagnostic[] {
	parseSummary(output);
	return parseBiomeDiagnostics(output, source).map((diagnostic) => {
		if (!diagnostic.path) throw new Error("Biome diagnostic has no path; comparison is ambiguous");
		if (isMeasuredCategory(diagnostic.category) && diagnostic.measuredValue === undefined) {
			throw new Error(`Biome diagnostic has no measured value: ${diagnostic.category}`);
		}
		return { ...diagnostic, path: normalizePath(diagnostic.path) };
	});
}

function diagnosticsForPath(
	diagnostics: LintDiagnostic[],
	path: string | undefined,
): LintDiagnostic[] {
	if (!path) return [];
	const normalized = normalizePath(path);
	return diagnostics.filter((diagnostic) => diagnostic.path === normalized);
}

function assertUnambiguousMeasuredPairing(
	before: LintDiagnostic[],
	after: LintDiagnostic[],
	path: string,
): void {
	const categories = new Set(
		[...before, ...after].map((diagnostic) => diagnostic.category).filter(isMeasuredCategory),
	);
	for (const category of categories) {
		const categoryBefore = before.filter((diagnostic) => diagnostic.category === category);
		const categoryAfter = after.filter((diagnostic) => diagnostic.category === category);
		if (categoryBefore.length <= 1 && categoryAfter.length <= 1) continue;
		const identities = [...categoryBefore, ...categoryAfter].map(
			(diagnostic) => diagnostic.scopeIdentity,
		);
		const beforeIdentities = categoryBefore.map((diagnostic) => diagnostic.scopeIdentity);
		const afterIdentities = categoryAfter.map((diagnostic) => diagnostic.scopeIdentity);
		if (
			identities.some((identity) => !identity) ||
			new Set(beforeIdentities).size !== beforeIdentities.length ||
			new Set(afterIdentities).size !== afterIdentities.length
		) {
			throw new Error(`Ambiguous ${category} function identity in ${path}`);
		}
	}
}

export function compareChangedDiagnostics(
	baseDiagnostics: LintDiagnostic[],
	headDiagnostics: LintDiagnostic[],
	changes: ChangedPath[],
): LintDiagnostic[] {
	const regressions: LintDiagnostic[] = [];
	for (const change of changes) {
		if (!change.afterPath) continue;
		const before = diagnosticsForPath(baseDiagnostics, change.beforePath);
		const after = diagnosticsForPath(headDiagnostics, change.afterPath);
		assertUnambiguousMeasuredPairing(before, after, change.afterPath);
		regressions.push(
			...compareDiagnostics(before, after).map((diagnostic) => ({
				...diagnostic,
				path: normalizePath(change.afterPath as string),
			})),
		);
	}
	return regressions;
}

function parseConfig(value: string, label: string): UnknownRecord {
	const parsed: unknown = JSON.parse(value);
	if (!isRecord(parsed)) throw new Error(`${label} Biome config is not an object`);
	return parsed;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function severity(value: unknown): number | undefined {
	let level: unknown;
	if (typeof value === "string") level = value;
	else if (isRecord(value)) level = value.level;
	if (level === "off") return 0;
	if (level === "info") return 1;
	if (level === "warn") return 2;
	if (level === "error") return 3;
	return undefined;
}

function flattenRules(value: unknown, prefix = ""): Map<string, unknown> {
	const rules = new Map<string, unknown>();
	if (!isRecord(value)) return rules;
	for (const [key, setting] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (severity(setting) !== undefined) {
			rules.set(path, setting);
			continue;
		}
		for (const [childPath, child] of flattenRules(setting, path)) rules.set(childPath, child);
	}
	return rules;
}

function threshold(setting: unknown): number | undefined {
	if (!isRecord(setting) || !isRecord(setting.options)) return undefined;
	for (const key of ["maxAllowedComplexity", "maxLines"]) {
		if (typeof setting.options[key] === "number") return setting.options[key];
	}
	return undefined;
}

function ruleOptions(setting: unknown): UnknownRecord | undefined {
	if (!isRecord(setting) || !isRecord(setting.options)) return undefined;
	const options = { ...setting.options };
	delete options.maxAllowedComplexity;
	delete options.maxLines;
	return options;
}

interface SourceComment {
	text: string;
	start: number;
	end: number;
}

function skipQuotedString(source: string, start: number, quote: string): number {
	for (let index = start + 1; index < source.length; index += 1) {
		if (source[index] === "\\") index += 1;
		else if (source[index] === quote) return index + 1;
	}
	return source.length;
}

function canStartRegex(source: string, index: number): boolean {
	const prefix = source.slice(0, index).trimEnd();
	if (!prefix) return true;
	const previous = prefix.at(-1) ?? "";
	if ("([{:;,=!?&|+-*%^~<>".includes(previous)) return true;
	if (previous === ")" && followsControlFlowHeader(prefix)) return true;
	const keyword = prefix.match(/([A-Za-z_$][\w$]*)$/)?.[1];
	return Boolean(
		keyword &&
			[
				"await",
				"case",
				"delete",
				"do",
				"else",
				"in",
				"of",
				"return",
				"throw",
				"typeof",
				"void",
				"yield",
			].includes(keyword),
	);
}

function followsControlFlowHeader(prefix: string): boolean {
	const openingParentheses: number[] = [];
	const comments: SourceComment[] = [];
	for (let index = 0; index < prefix.length; index += 1) {
		if (prefix[index] === "(") {
			openingParentheses.push(index);
			continue;
		}
		if (prefix[index] === ")") {
			const opening = openingParentheses.pop();
			if (index !== prefix.length - 1 || opening === undefined) continue;
			const keyword = prefix
				.slice(0, opening)
				.trimEnd()
				.match(/([A-Za-z_$][\w$]*)$/)?.[1];
			return Boolean(keyword && ["for", "if", "while", "with"].includes(keyword));
		}
		index = scanCodeToken(prefix, index, comments) - 1;
	}
	return false;
}

function skipRegex(source: string, start: number): number {
	const match = source
		.slice(start)
		.match(/^\/(?:\\[\s\S]|\[(?:\\[\s\S]|[^\]\\\r\n])*\]|[^/\\[\r\n])*\/[A-Za-z]*/u);
	return match ? start + match[0].length : start + 1;
}

function scanSlash(source: string, index: number, comments: SourceComment[]): number | undefined {
	const next = source[index + 1];
	if (next === "/" || next === "*") {
		const comment = scanComment(source, index, next === "*");
		comments.push(comment);
		return comment.end;
	}
	return canStartRegex(source, index) ? skipRegex(source, index) : undefined;
}

function scanTemplate(source: string, start: number, comments: SourceComment[]): number {
	for (let index = start; index < source.length; index += 1) {
		if (source[index] === "\\") index += 1;
		else if (source[index] === "`") return index + 1;
		else if (source[index] === "$" && source[index + 1] === "{") {
			index = scanCode(source, index + 2, comments, { stopAtBrace: true }) - 1;
		}
	}
	return source.length;
}

function scanComment(source: string, start: number, multiline: boolean): SourceComment {
	const boundary = multiline ? source.indexOf("*/", start + 2) : source.indexOf("\n", start + 2);
	const end = boundary === -1 ? source.length : boundary + (multiline ? 2 : 0);
	return { text: source.slice(start, end), start, end };
}

function scanCodeToken(source: string, index: number, comments: SourceComment[]): number {
	const current = source[index];
	if (current === "/") return scanSlash(source, index, comments) ?? index + 1;
	if (current === '"' || current === "'") return skipQuotedString(source, index, current);
	if (current === "`") return scanTemplate(source, index + 1, comments);
	if (current === "{") return scanCode(source, index + 1, comments, { stopAtBrace: true });
	return index + 1;
}

function scanCode(
	source: string,
	start: number,
	comments: SourceComment[],
	options: { stopAtBrace: boolean },
): number {
	for (let index = start; index < source.length; index += 1) {
		if (source[index] === "}" && options.stopAtBrace) return index + 1;
		index = scanCodeToken(source, index, comments) - 1;
	}
	return source.length;
}

function sourceComments(source: string): SourceComment[] {
	const comments: SourceComment[] = [];
	scanCode(source, 0, comments, { stopAtBrace: false });
	return comments;
}

function suppressionDirectives(source: string | undefined): string[] {
	if (!source) return [];
	const directives: string[] = [];
	for (const comment of sourceComments(source)) {
		const directive = comment.text.match(
			/^(?:\/\/|\/\*)\s*(biome-ignore(?:-all|-start|-end)?\b[^\n*]*)/,
		)?.[1];
		if (!directive) continue;
		const normalized = directive.trim().replace(/\s+/g, " ");
		const line = source.slice(0, comment.start).split("\n").length;
		const scope = getScopeIdentity(source, line) ?? "";
		const anchor = source
			.slice(comment.end)
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line && !line.startsWith("//") && !line.startsWith("/*"));
		directives.push(`${normalized}|${scope}|${anchor ?? ""}`);
	}
	return directives;
}

interface BroadSuppressionRange {
	identity: string;
	start: number;
	end: number;
}

interface JsxTag {
	name: string;
	closing: boolean;
	selfClosing: boolean;
	end: number;
}

function jsxTag(source: string, start: number): JsxTag | undefined {
	const prefix = source.slice(start).match(/^<(\/)?([A-Za-z][\w:.-]*)/);
	if (!prefix) return undefined;
	const comments: SourceComment[] = [];
	for (let index = start + prefix[0].length; index < source.length; index += 1) {
		const current = source[index];
		if (current === ">") {
			return {
				name: prefix[2] as string,
				closing: Boolean(prefix[1]),
				selfClosing: source.slice(start, index).trimEnd().endsWith("/"),
				end: index + 1,
			};
		}
		index = scanCodeToken(source, index, comments) - 1;
	}
	return undefined;
}

function jsxNodeEnd(source: string, start: number): number | undefined {
	const root = jsxTag(source, start);
	if (!root || root.closing || root.selfClosing) return root?.end;
	let depth = 1;
	for (let index = root.end; index < source.length; index += 1) {
		if (source[index] === "{") {
			index = scanCode(source, index + 1, [], { stopAtBrace: true }) - 1;
			continue;
		}
		if (source[index] !== "<") continue;
		const tag = jsxTag(source, index);
		if (!tag) continue;
		index = tag.end - 1;
		if (tag.name !== root.name || tag.selfClosing) continue;
		depth += tag.closing ? -1 : 1;
		if (depth === 0) return tag.end;
	}
	return undefined;
}

function nextNodeStart(source: string, start: number): number {
	for (let index = start; index < source.length; index += 1) {
		if (/\s/u.test(source[index] ?? "")) continue;
		if (source[index] !== "/" || !["/", "*"].includes(source[index + 1] ?? "")) return index;
		index = scanComment(source, index, source[index + 1] === "*").end - 1;
	}
	return source.length;
}

function ordinarySuppressionRanges(source: string | undefined): BroadSuppressionRange[] {
	if (!source) return [];
	const ranges: BroadSuppressionRange[] = [];
	for (const comment of sourceComments(source)) {
		const directive = comment.text.match(/^(?:\/\/|\/\*)\s*(biome-ignore\b[^\n*]*)/)?.[1];
		if (!directive) continue;
		const commentEndsJsxExpression =
			comment.text.startsWith("/*") &&
			source[comment.start - 1] === "{" &&
			source[comment.end] === "}";
		const start = nextNodeStart(source, comment.end + (commentEndsJsxExpression ? 1 : 0));
		const comments: SourceComment[] = [];
		const jsxEnd = jsxNodeEnd(source, start);
		let end = jsxEnd ?? source.length;
		for (let index = start; jsxEnd === undefined && index < source.length; index += 1) {
			const current = source[index];
			if (current === ";") {
				end = index + 1;
				break;
			}
			if (current === "{") {
				end = scanCode(source, index + 1, comments, { stopAtBrace: true });
				break;
			}
			index = scanCodeToken(source, index, comments) - 1;
		}
		const normalized = directive.trim().replace(/\s+/g, " ");
		const line = source.slice(0, comment.start).split("\n").length;
		const scope = getScopeIdentity(source, line) ?? "";
		const anchor = source
			.slice(comment.end)
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line && !line.startsWith("//") && !line.startsWith("/*"));
		ranges.push({ identity: `${normalized}|${scope}|${anchor ?? ""}`, start, end });
	}
	return ranges;
}

function broadSuppressionIdentity(
	source: string,
	comment: SourceComment,
	directive: string,
): string {
	const normalized = directive.trim().replace(/\s+/g, " ");
	const line = source.slice(0, comment.start).split("\n").length;
	const scope = getScopeIdentity(source, line) ?? "";
	return `${normalized}|${scope}`;
}

function broadSuppressionRanges(source: string | undefined): BroadSuppressionRange[] {
	if (!source) return [];
	const ranges: BroadSuppressionRange[] = [];
	const starts: Array<Omit<BroadSuppressionRange, "end">> = [];
	for (const comment of sourceComments(source)) {
		const directive = comment.text.match(
			/^(?:\/\/|\/\*)\s*(biome-ignore(?:-all|-start|-end)?\b[^\n*]*)/,
		)?.[1];
		if (!directive) continue;
		const identity = broadSuppressionIdentity(source, comment, directive);
		if (directive.startsWith("biome-ignore-all")) {
			ranges.push({ identity, start: 0, end: source.length });
			continue;
		}
		if (directive.startsWith("biome-ignore-start")) {
			starts.push({ identity, start: comment.end });
			continue;
		}
		if (!directive.startsWith("biome-ignore-end")) continue;
		const start = starts.pop();
		if (start) ranges.push({ ...start, end: comment.start });
	}
	for (const start of starts) ranges.push({ ...start, end: source.length });
	return ranges;
}

function previousDiagonal(v: Map<number, number>, diagonal: number, distance: number): number {
	if (
		diagonal === -distance ||
		(diagonal !== distance && (v.get(diagonal - 1) ?? -1) < (v.get(diagonal + 1) ?? -1))
	) {
		return diagonal + 1;
	}
	return diagonal - 1;
}

function backtrackChangedLines(
	trace: Array<Map<number, number>>,
	before: string[],
	after: string[],
): boolean[] {
	const changed = after.map(() => true);
	let beforeIndex = before.length;
	let afterIndex = after.length;
	for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
		const diagonal = beforeIndex - afterIndex;
		const previous = previousDiagonal(trace[distance] ?? new Map(), diagonal, distance);
		const previousBefore = trace[distance]?.get(previous) ?? 0;
		const previousAfter = previousBefore - previous;
		while (beforeIndex > previousBefore && afterIndex > previousAfter) {
			changed[afterIndex - 1] = false;
			beforeIndex -= 1;
			afterIndex -= 1;
		}
		if (distance === 0) break;
		if (beforeIndex === previousBefore) afterIndex -= 1;
		else beforeIndex -= 1;
	}
	return changed;
}

function changedLineFlags(before: string, after: string): boolean[] {
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");
	let frontier = new Map<number, number>([[1, 0]]);
	const trace: Array<Map<number, number>> = [];
	for (let distance = 0; distance <= beforeLines.length + afterLines.length; distance += 1) {
		trace.push(new Map(frontier));
		const next = new Map<number, number>();
		for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
			const previous = previousDiagonal(frontier, diagonal, distance);
			let beforeIndex = (frontier.get(previous) ?? 0) + (previous === diagonal - 1 ? 1 : 0);
			let afterIndex = beforeIndex - diagonal;
			while (
				beforeIndex < beforeLines.length &&
				afterIndex < afterLines.length &&
				beforeLines[beforeIndex] === afterLines[afterIndex]
			) {
				beforeIndex += 1;
				afterIndex += 1;
			}
			next.set(diagonal, beforeIndex);
			if (beforeIndex >= beforeLines.length && afterIndex >= afterLines.length) {
				return backtrackChangedLines(trace, beforeLines, afterLines);
			}
		}
		frontier = next;
	}
	return afterLines.map(() => true);
}

function changedAfterRanges(before: string, after: string): Array<{ start: number; end: number }> {
	const lines = after.split("\n");
	const offsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		offsets.push(offset);
		offset += line.length + 1;
	}
	const ranges: Array<{ start: number; end: number }> = [];
	const changed = changedLineFlags(before, after);
	for (let index = 0; index < changed.length; index += 1) {
		if (!changed[index]) continue;
		const start = offsets[index] ?? after.length;
		while (changed[index + 1]) index += 1;
		const end = offsets[index + 1] ?? after.length;
		if (end > start) ranges.push({ start, end });
	}
	return ranges;
}

function editsCoveredByExistingBroadSuppression(change: ChangedPath): boolean {
	if (change.beforeSource === undefined || change.afterSource === undefined) return false;
	const changed = changedAfterRanges(change.beforeSource, change.afterSource);
	const existing = new Set(
		broadSuppressionRanges(change.beforeSource).map((suppression) => suppression.identity),
	);
	return broadSuppressionRanges(change.afterSource).some(
		(suppression) =>
			existing.has(suppression.identity) &&
			changed.some((range) => range.start < suppression.end && range.end > suppression.start),
	);
}

function editsCoveredByExistingOrdinarySuppression(change: ChangedPath): boolean {
	if (change.beforeSource === undefined || change.afterSource === undefined) return false;
	const changed = changedAfterRanges(change.beforeSource, change.afterSource);
	const existing = new Set(
		ordinarySuppressionRanges(change.beforeSource).map((suppression) => suppression.identity),
	);
	return ordinarySuppressionRanges(change.afterSource).some(
		(suppression) =>
			existing.has(suppression.identity) &&
			changed.some((range) => range.start < suppression.end && range.end > suppression.start),
	);
}

function coverageViolations(base: UnknownRecord, head: UnknownRecord): PolicyViolation[] {
	const baseFileControls = isRecord(base.files) ? base.files : undefined;
	const headFileControls = isRecord(head.files) ? head.files : undefined;
	const baseFiles = stringArray(baseFileControls?.includes);
	const headFiles = stringArray(headFileControls?.includes);
	const violations: PolicyViolation[] = [];
	if (
		!Array.isArray(baseFileControls?.includes) &&
		Array.isArray(headFileControls?.includes) &&
		headFiles.some((include) => !include.startsWith("!"))
	) {
		violations.push({
			kind: "coverage",
			message: "Biome includes added to default coverage; explicit coverage review required",
		});
	}
	for (const include of baseFiles) {
		if (!headFiles.includes(include)) {
			violations.push({ kind: "coverage", message: `Biome include removed: ${include}` });
		}
	}
	for (const include of headFiles) {
		if (include.startsWith("!") && !baseFiles.includes(include)) {
			violations.push({ kind: "coverage", message: `Biome exclusion added: ${include}` });
		}
	}
	return violations;
}

function isLinterDisabled(base: UnknownRecord, head: UnknownRecord): boolean {
	if (isRecord(base.linter) && base.linter.enabled === false) return false;
	return isRecord(head.linter) && head.linter.enabled === false;
}

function usesImplicitRulePreset(config: UnknownRecord): boolean {
	return (
		isRecord(config.linter) &&
		isRecord(config.linter.rules) &&
		["all", "recommended"].includes(String(config.linter.rules.preset))
	);
}

function newRuleViolations(
	base: UnknownRecord,
	baseRules: Map<string, unknown>,
	headRules: Map<string, unknown>,
): PolicyViolation[] {
	return [...headRules].flatMap(([rule, headSetting]) => {
		if (baseRules.has(rule)) return [];
		const headSeverity = severity(headSetting);
		if (headSeverity === 0) {
			return [{ kind: "rule-level" as const, message: `Biome rule explicitly disabled: ${rule}` }];
		}
		if (!usesImplicitRulePreset(base)) return [];
		if (ruleOptions(headSetting) !== undefined) {
			return [
				{
					kind: "rule-level" as const,
					message: `Biome rule options changed; explicit policy review required: ${rule}`,
				},
			];
		}
		if (headSeverity === undefined || headSeverity >= 3) return [];
		return [{ kind: "rule-level" as const, message: `Biome preset rule weakened: ${rule}` }];
	});
}

function isRuleWeakening(
	baseSeverity: number | undefined,
	headSeverity: number | undefined,
): boolean {
	if (baseSeverity === 0 && headSeverity === undefined) return false;
	return headSeverity === undefined || (baseSeverity !== undefined && headSeverity < baseSeverity);
}

function ruleViolations(base: UnknownRecord, head: UnknownRecord): PolicyViolation[] {
	if (isLinterDisabled(base, head)) {
		return [{ kind: "rule-level", message: "Biome linter disabled" }];
	}
	const baseRules = flattenRules(isRecord(base.linter) ? base.linter.rules : undefined);
	const headRules = flattenRules(isRecord(head.linter) ? head.linter.rules : undefined);
	const violations: PolicyViolation[] = [];
	for (const [rule, baseSetting] of baseRules) {
		const headSetting = headRules.get(rule);
		const baseSeverity = severity(baseSetting);
		const headSeverity = severity(headSetting);
		if (isRuleWeakening(baseSeverity, headSeverity)) {
			violations.push({ kind: "rule-level", message: `Biome rule weakened or removed: ${rule}` });
			continue;
		}
		const baseThreshold = threshold(baseSetting);
		const headThreshold = threshold(headSetting);
		if (
			baseThreshold !== undefined &&
			(headThreshold === undefined || headThreshold > baseThreshold)
		) {
			violations.push({ kind: "threshold", message: `Biome threshold increased: ${rule}` });
		}
		if (JSON.stringify(ruleOptions(baseSetting)) !== JSON.stringify(ruleOptions(headSetting))) {
			violations.push({
				kind: "rule-level",
				message: `Biome rule options changed; explicit policy review required: ${rule}`,
			});
		}
	}
	return [...violations, ...newRuleViolations(base, baseRules, headRules)];
}

function withoutKeys(record: UnknownRecord | undefined, keys: string[]): UnknownRecord {
	if (!record) return {};
	return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

function unsupportedPolicyViolations(base: UnknownRecord, head: UnknownRecord): PolicyViolation[] {
	const baseFiles = isRecord(base.files) ? base.files : undefined;
	const headFiles = isRecord(head.files) ? head.files : undefined;
	const baseLinter = isRecord(base.linter) ? base.linter : undefined;
	const headLinter = isRecord(head.linter) ? head.linter : undefined;
	const controls = [
		["Biome VCS policy", base.vcs, head.vcs],
		[
			"Biome file controls",
			withoutKeys(baseFiles, ["includes"]),
			withoutKeys(headFiles, ["includes"]),
		],
		[
			"Biome linter controls",
			withoutKeys(baseLinter, ["enabled", "rules"]),
			withoutKeys(headLinter, ["enabled", "rules"]),
		],
		["Biome configuration inheritance", base.extends, head.extends],
	] as const;
	return controls.flatMap(([label, before, after]) => {
		if (JSON.stringify(before) === JSON.stringify(after)) return [];
		return [
			{ kind: "coverage" as const, message: `${label} changed; explicit policy review required` },
		];
	});
}

function lintAffectingTopLevelControls(config: UnknownRecord): UnknownRecord {
	const ignored = new Set([
		"$schema",
		"assist",
		"extends",
		"files",
		"formatter",
		"linter",
		"overrides",
		"vcs",
	]);
	return Object.fromEntries(
		Object.entries(config)
			.filter(([key]) => !ignored.has(key))
			.map(([key, value]) => [key, isRecord(value) ? withoutKeys(value, ["formatter"]) : value]),
	);
}

function topLevelPolicyViolations(base: UnknownRecord, head: UnknownRecord): PolicyViolation[] {
	if (
		JSON.stringify(lintAffectingTopLevelControls(base)) ===
		JSON.stringify(lintAffectingTopLevelControls(head))
	) {
		return [];
	}
	return [
		{
			kind: "coverage",
			message: "Biome language or top-level controls changed; explicit policy review required",
		},
	];
}

function extendsPaths(config: UnknownRecord): string[] {
	const values =
		typeof config.extends === "string" ? [config.extends] : stringArray(config.extends);
	return values.filter((value) => value.startsWith(".")).map(normalizePath);
}

function inheritedPolicyViolations(
	base: UnknownRecord,
	head: UnknownRecord,
	changes: ChangedPath[],
): PolicyViolation[] {
	const references = new Set([...extendsPaths(base), ...extendsPaths(head)]);
	if (references.size === 0) return [];
	return changes.flatMap((change) => {
		const changedPath = normalizePath(change.afterPath ?? change.beforePath ?? "");
		const isJsonConfig = changedPath.endsWith(".json") || changedPath.endsWith(".jsonc");
		if (!references.has(changedPath) && !isJsonConfig) return [];
		return [
			{
				kind: "coverage" as const,
				message: "Inherited Biome policy changed; explicit policy review required",
				path: changedPath,
			},
		];
	});
}

function flattenRuleControls(value: unknown, prefix = ""): Map<string, unknown> {
	const controls = new Map<string, unknown>();
	if (!isRecord(value)) return controls;
	for (const [key, setting] of Object.entries(value)) {
		const controlPath = prefix ? `${prefix}.${key}` : key;
		if (severity(setting) !== undefined) continue;
		if (!isRecord(setting)) {
			controls.set(controlPath, setting);
			continue;
		}
		for (const [childPath, child] of flattenRuleControls(setting, controlPath)) {
			controls.set(childPath, child);
		}
	}
	return controls;
}

function ruleControlViolations(base: UnknownRecord, head: UnknownRecord): PolicyViolation[] {
	const baseRules = isRecord(base.linter) && isRecord(base.linter.rules) ? base.linter.rules : {};
	const headRules = isRecord(head.linter) && isRecord(head.linter.rules) ? head.linter.rules : {};
	const baseControls = flattenRuleControls(baseRules);
	const headControls = flattenRuleControls(headRules);
	const controlPaths = new Set([...baseControls.keys(), ...headControls.keys()]);
	return [...controlPaths].flatMap((controlPath) => {
		if (
			JSON.stringify(baseControls.get(controlPath)) ===
			JSON.stringify(headControls.get(controlPath))
		) {
			return [];
		}
		return [
			{
				kind: "rule-level" as const,
				message: `Biome rule control changed; explicit policy review required: ${controlPath}`,
			},
		];
	});
}

function lintOverrides(config: UnknownRecord): unknown[] {
	if (!Array.isArray(config.overrides)) return [];
	return config.overrides.flatMap((override) => {
		if (!isRecord(override)) return [];
		return [
			Object.fromEntries(
				Object.entries(override)
					.filter(([key]) => key !== "assist" && key !== "formatter")
					.map(([key, value]) => [
						key,
						isRecord(value) ? withoutKeys(value, ["formatter"]) : value,
					]),
			),
		];
	});
}

function overrideViolations(base: UnknownRecord, head: UnknownRecord): PolicyViolation[] {
	if (JSON.stringify(lintOverrides(base)) === JSON.stringify(lintOverrides(head))) return [];
	return [
		{
			kind: "rule-level",
			message: "Biome lint overrides changed; explicit policy review required",
		},
	];
}

function suppressionViolations(changes: ChangedPath[]): PolicyViolation[] {
	return changes.flatMap((change) => {
		const violations: PolicyViolation[] = [];
		const remaining = suppressionDirectives(change.afterSource);
		for (const previous of suppressionDirectives(change.beforeSource)) {
			const match = remaining.indexOf(previous);
			if (match !== -1) remaining.splice(match, 1);
		}
		if (remaining.length > 0) {
			violations.push({
				kind: "suppression" as const,
				message: `${remaining.length} Biome suppression directive${remaining.length === 1 ? "" : "s"} added or changed`,
				path: change.afterPath,
			});
		}
		if (editsCoveredByExistingBroadSuppression(change)) {
			violations.push({
				kind: "suppression",
				message: "Code changed under an existing broad Biome suppression",
				path: change.afterPath,
			});
		}
		if (editsCoveredByExistingOrdinarySuppression(change)) {
			violations.push({
				kind: "suppression",
				message: "Code changed under an existing Biome suppression",
				path: change.afterPath,
			});
		}
		return violations;
	});
}

function ignoreFileViolations(changes: ChangedPath[]): PolicyViolation[] {
	return changes.flatMap((change) => {
		const changedPath = change.afterPath ?? change.beforePath;
		if (
			!changedPath ||
			(!changedPath.endsWith(".gitignore") && !changedPath.endsWith(".ignore")) ||
			change.beforeSource === change.afterSource
		) {
			return [];
		}
		return [
			{
				kind: "coverage" as const,
				message: "Git ignore policy changed; explicit coverage review required",
				path: changedPath,
			},
		];
	});
}

function sourceLookup(
	changes: ChangedPath[],
	side: "before" | "after",
): (path: string | undefined) => string | undefined {
	const sources = new Map<string, string | undefined>();
	for (const change of changes) {
		const sourcePath = side === "before" ? change.beforePath : change.afterPath;
		if (sourcePath) sources.set(normalizePath(sourcePath), change[`${side}Source`]);
	}
	return (diagnosticPath) =>
		diagnosticPath ? sources.get(normalizePath(diagnosticPath)) : undefined;
}

export function compareBiomePolicy(
	baseConfigText: string,
	headConfigText: string,
	changes: ChangedPath[],
): PolicyViolation[] {
	const base = parseConfig(baseConfigText, "Base");
	const head = parseConfig(headConfigText, "Head");
	return [
		...coverageViolations(base, head),
		...unsupportedPolicyViolations(base, head),
		...topLevelPolicyViolations(base, head),
		...inheritedPolicyViolations(base, head, changes),
		...ruleControlViolations(base, head),
		...ruleViolations(base, head),
		...overrideViolations(base, head),
		...ignoreFileViolations(changes),
		...suppressionViolations(changes),
	];
}

export function compareBiomeReports(input: {
	baseOutput: string;
	headOutput: string;
	baseConfigText: string;
	headConfigText: string;
	changes: ChangedPath[];
}): RatchetComparison {
	const baseDiagnostics = parsePinnedBiomeReport(
		input.baseOutput,
		sourceLookup(input.changes, "before"),
	);
	const headDiagnostics = parsePinnedBiomeReport(
		input.headOutput,
		sourceLookup(input.changes, "after"),
	);
	return {
		regressions: compareChangedDiagnostics(baseDiagnostics, headDiagnostics, input.changes),
		policyViolations: compareBiomePolicy(input.baseConfigText, input.headConfigText, input.changes),
		baseDiagnosticCount: baseDiagnostics.length,
		headDiagnosticCount: headDiagnostics.length,
	};
}
