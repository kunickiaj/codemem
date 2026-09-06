import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Plugin, PluginOptions } from "@opencode-ai/plugin";

const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const MEASURED_CATEGORIES = new Set([
	"lint/complexity/noExcessiveCognitiveComplexity",
	"lint/complexity/noExcessiveLinesPerFunction",
]);
const DIAGNOSTIC_LIMIT = 10;
const SNAPSHOT_LIMIT = 100;
const WARNING = "[lint-feedback] Lint check failed; the edit was preserved.";
const liveChildren = new Set<ChildProcess>();

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (process.platform === "win32" && child.pid) {
		const systemRoot = process.env.SystemRoot?.trim();
		if (systemRoot && path.isAbsolute(systemRoot)) {
			const result = spawnSync(
				path.join(systemRoot, "System32", "taskkill.exe"),
				["/PID", String(child.pid), "/T", "/F"],
				{ stdio: "ignore", windowsHide: true },
			);
			if (!result.error && result.status === 0) return;
		}
	}
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// The process group may already have exited; fall back to the direct child.
		}
	}
	child.kill(signal);
}

export function killLiveChildren(): void {
	for (const child of liveChildren) killProcessTree(child, "SIGKILL");
	liveChildren.clear();
}

process.once("exit", killLiveChildren);

export interface LintFeedbackOptions extends PluginOptions {
	command?: string[];
	timeoutMs?: number;
}

export interface LintDiagnostic {
	category: string;
	description: string;
	path?: string;
	line?: number;
	column?: number;
	offset?: number;
	sourceText?: string;
	measuredValue?: number;
}

interface ApplyPatchPath {
	operation: "Add" | "Update" | "Delete";
	path: string;
	moveTo?: string;
}

interface TouchedFile {
	beforePath?: string;
	afterPath: string;
}

interface Snapshot {
	diagnosticsByPath: Map<string, LintDiagnostic[]>;
	failed: boolean;
}

interface HookInput {
	tool: string;
	sessionID: string;
	callID: string;
	args?: Record<string, unknown>;
}

interface BeforeOutput {
	args: unknown;
}

interface AfterOutput {
	output: string;
}

interface HookDependencies {
	worktree: string;
	command: [string, ...string[]];
	timeoutMs: number;
	runDiagnostics: (relativePath: string) => Promise<LintDiagnostic[]>;
	fileExists: (relativePath: string) => Promise<boolean>;
}

type UnknownRecord = Record<string, unknown>;

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

export function parseBiomeDiagnostics(output: string, sourceCode?: string): LintDiagnostic[] {
	const parsed: unknown = JSON.parse(output);
	if (!isRecord(parsed) || !Array.isArray(parsed.diagnostics)) {
		throw new Error("Biome output has no diagnostics array");
	}

	return parsed.diagnostics.flatMap((raw): LintDiagnostic[] => {
		if (!isRecord(raw) || typeof raw.category !== "string" || !raw.category.startsWith("lint/"))
			return [];
		const location = isRecord(raw.location) ? raw.location : {};
		const description =
			typeof raw.description === "string" ? raw.description : getText(raw.message);
		const position = getPosition(location);
		const diagnosticPath = getDiagnosticPath(location);
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

function measuredCandidateIndexes(
	previous: LintDiagnostic,
	diagnostics: LintDiagnostic[],
): number[] {
	const allIndexes = diagnostics.map((_, index) => index);
	if (!previous.sourceText) return allIndexes;
	const sameSource = diagnostics.flatMap((diagnostic, index) =>
		diagnostic.sourceText === previous.sourceText ? [index] : [],
	);
	return sameSource.length > 0 ? sameSource : allIndexes;
}

function compareMeasured(before: LintDiagnostic[], after: LintDiagnostic[]): LintDiagnostic[] {
	const unmatched = [...after];
	const regressions: LintDiagnostic[] = [];
	for (const previous of before) {
		if (unmatched.length === 0) break;
		const candidateIndexes = measuredCandidateIndexes(previous, unmatched);
		let nearestIndex = candidateIndexes[0] ?? 0;
		for (const index of candidateIndexes.slice(1)) {
			const candidate = unmatched[index];
			const nearest = unmatched[nearestIndex];
			if (
				candidate &&
				nearest &&
				diagnosticDistance(previous, candidate) < diagnosticDistance(previous, nearest)
			) {
				nearestIndex = index;
			}
		}
		const current = unmatched.splice(nearestIndex, 1)[0];
		if (current && (current.measuredValue ?? 0) > (previous.measuredValue ?? 0))
			regressions.push(current);
	}
	return [...regressions, ...unmatched];
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

function compareCountOnly(before: LintDiagnostic[], after: LintDiagnostic[]): LintDiagnostic[] {
	const unmatched = [...after];
	for (const previous of before) {
		const sameDescription = unmatched
			.map((diagnostic, index) => ({ diagnostic, index }))
			.filter(({ diagnostic }) => diagnostic.description === previous.description)
			.filter(
				({ diagnostic }) =>
					!previous.sourceText ||
					!diagnostic.sourceText ||
					diagnostic.sourceText === previous.sourceText,
			);
		const candidateIndexes = sameDescription.map(({ index }) => index);
		const firstCandidate = candidateIndexes[0];
		if (firstCandidate === undefined) continue;
		let nearestIndex = firstCandidate;
		for (const index of candidateIndexes.slice(1)) {
			const candidate = unmatched[index];
			const nearest = unmatched[nearestIndex];
			if (
				candidate &&
				nearest &&
				diagnosticDistance(previous, candidate) < diagnosticDistance(previous, nearest)
			) {
				nearestIndex = index;
			}
		}
		unmatched.splice(nearestIndex, 1);
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
		if (MEASURED_CATEGORIES.has(category)) {
			regressions.push(...compareMeasured(previous, current));
			continue;
		}
		regressions.push(...compareCountOnly(previous, current));
	}
	return regressions;
}

export function parseApplyPatchPaths(patchText: string): ApplyPatchPath[] {
	const lines = patchText.split(/\r?\n/);
	const paths: ApplyPatchPath[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index]?.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
		const operation = match?.[1] as ApplyPatchPath["operation"] | undefined;
		const sourcePath = match?.[2]?.trim();
		if (!operation || !sourcePath) continue;
		const moveMatch =
			operation === "Update" ? lines[index + 1]?.match(/^\*\*\* Move to: (.+)$/) : undefined;
		const moveTo = moveMatch?.[1]?.trim();
		paths.push({ operation, path: sourcePath, ...(moveTo ? { moveTo } : {}) });
	}
	return paths;
}

export function resolveWorktreePath(worktree: string, candidate: string): string | undefined {
	if (candidate.startsWith("-")) return undefined;
	const absoluteWorktree = path.resolve(worktree);
	const absoluteCandidate = path.resolve(absoluteWorktree, candidate);
	const relative = path.relative(absoluteWorktree, absoluteCandidate);
	if (
		!relative ||
		relative.startsWith(`..${path.sep}`) ||
		relative === ".." ||
		path.isAbsolute(relative)
	) {
		return undefined;
	}
	if (!SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase())) return undefined;
	const normalized = relative.split(path.sep).join("/");
	return isConfiguredLintPath(normalized) ? normalized : undefined;
}

function isConfiguredLintPath(relativePath: string): boolean {
	// Keep this allowlist synchronized with biome.json files.includes; the focused test enforces the mirror.
	if (/^packages\/.+\/src\/.+\.(?:js|ts|tsx)$/.test(relativePath)) return true;
	if (/^packages\/.+\/vite\.config\.ts$/.test(relativePath)) return true;
	if (
		/^plugins\/(?:claude|codex)\/scripts\/(?:ingest-hook|user-prompt-hook)\.mjs$/.test(relativePath)
	)
		return true;
	if (relativePath === "scripts/ci-workflow.test.mjs") return true;
	return relativePath === "vitest.config.ts";
}

function getPathArgument(args: UnknownRecord): string | undefined {
	for (const field of ["filePath", "file_path", "path"] as const) {
		if (typeof args[field] === "string") return args[field];
	}
	return undefined;
}

function getApplyPatchTouchedFiles(args: UnknownRecord, worktree: string): TouchedFile[] {
	const patchText = [args.patchText, args.patch, args.text].find(
		(value) => typeof value === "string",
	);
	if (typeof patchText !== "string") return [];
	const files = new Map<string, TouchedFile>();
	for (const item of parseApplyPatchPaths(patchText)) {
		if (item.operation === "Delete") continue;
		const afterPath = resolveWorktreePath(worktree, item.moveTo ?? item.path);
		if (!afterPath) continue;
		const beforePath = resolveWorktreePath(worktree, item.path);
		files.set(afterPath, { ...(beforePath ? { beforePath } : {}), afterPath });
	}
	return [...files.values()];
}

function getTouchedFiles(tool: string, args: UnknownRecord, worktree: string): TouchedFile[] {
	if (tool === "apply_patch") return getApplyPatchTouchedFiles(args, worktree);
	if (tool !== "edit" && tool !== "write") return [];
	const candidate = getPathArgument(args);
	const resolved = candidate ? resolveWorktreePath(worktree, candidate) : undefined;
	return resolved ? [{ beforePath: resolved, afterPath: resolved }] : [];
}

export function getTouchedPaths(tool: string, args: UnknownRecord, worktree: string): string[] {
	return getTouchedFiles(tool, args, worktree).map((item) => item.afterPath);
}

function formatDiagnostic(diagnostic: LintDiagnostic): string {
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

function appendOutput(output: AfterOutput, message: string): void {
	output.output = output.output ? `${output.output}\n\n${message}` : message;
}

function callKey(input: Pick<HookInput, "sessionID" | "callID">): string {
	return `${input.sessionID}\u0000${input.callID}`;
}

export function createLintFeedbackHooks(dependencies: HookDependencies) {
	const snapshots = new Map<string, Snapshot>();
	const warnedSessions = new Set<string>();

	return {
		"tool.execute.before": async (input: HookInput, output: BeforeOutput): Promise<void> => {
			const args = isRecord(output.args) ? output.args : {};
			const files = getTouchedFiles(input.tool, args, dependencies.worktree);
			if (files.length === 0) return;

			const diagnosticsByPath = new Map<string, LintDiagnostic[]>();
			let failed = false;
			await Promise.all(
				files.map(async ({ beforePath, afterPath }) => {
					try {
						if (!beforePath) {
							diagnosticsByPath.set(afterPath, []);
							return;
						}
						const exists = await dependencies.fileExists(beforePath);
						diagnosticsByPath.set(
							afterPath,
							exists ? await dependencies.runDiagnostics(beforePath) : [],
						);
					} catch {
						failed = true;
					}
				}),
			);
			if (snapshots.size >= SNAPSHOT_LIMIT) {
				const oldest = snapshots.keys().next().value;
				if (oldest) snapshots.delete(oldest);
			}
			snapshots.set(callKey(input), { diagnosticsByPath, failed });
		},

		"tool.execute.after": async (input: HookInput, output: AfterOutput): Promise<void> => {
			const key = callKey(input);
			const snapshot = snapshots.get(key);
			snapshots.delete(key);
			if (!snapshot) return;

			const regressions: LintDiagnostic[] = [];
			let failed = snapshot.failed;
			await Promise.all(
				Array.from(snapshot.diagnosticsByPath, async ([relativePath, before]) => {
					try {
						if (!(await dependencies.fileExists(relativePath))) return;
						const after = await dependencies.runDiagnostics(relativePath);
						regressions.push(...compareDiagnostics(before, after));
					} catch {
						failed = true;
					}
				}),
			);

			if (regressions.length > 0) appendOutput(output, formatFeedback(regressions));
			if (failed && !warnedSessions.has(input.sessionID)) {
				warnedSessions.add(input.sessionID);
				appendOutput(output, WARNING);
			}
		},
		dispose: async (): Promise<void> => {
			snapshots.clear();
			warnedSessions.clear();
			killLiveChildren();
		},
	};
}

async function runCommand(
	command: [string, ...string[]],
	relativePath: string,
	worktree: string,
	timeoutMs: number,
): Promise<string> {
	const [executable, ...args] = command;
	const child = spawn(executable, [...args, "--", relativePath], {
		cwd: worktree,
		detached: process.platform !== "win32",
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	liveChildren.add(child);
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
	child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

	return await new Promise<string>((resolve, reject) => {
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			killProcessTree(child, "SIGTERM");
			forceKillTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 250);
			reject(new Error(`Lint command timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			reject(error);
		});
		child.once("close", (code) => {
			liveChildren.delete(child);
			clearTimeout(timer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			const text = Buffer.concat(stdout).toString("utf8");
			if (text) return resolve(text);
			reject(new Error(Buffer.concat(stderr).toString("utf8") || `Lint command exited ${code}`));
		});
	});
}

function validCommand(value: unknown): value is [string, ...string[]] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => typeof item === "string" && item.length > 0)
	);
}

async function isInsideWorktree(worktree: string, relativePath: string): Promise<boolean> {
	try {
		const [canonicalWorktree, canonicalFile] = await Promise.all([
			realpath(worktree),
			realpath(path.join(worktree, relativePath)),
		]);
		const relative = path.relative(canonicalWorktree, canonicalFile);
		return (
			Boolean(relative) &&
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative)
		);
	} catch {
		return false;
	}
}

export const LintFeedbackPlugin: Plugin = async ({ worktree }, options?: PluginOptions) => {
	const settings = options as LintFeedbackOptions | undefined;
	if (!validCommand(settings?.command)) return {};
	const [executable, ...args] = settings.command;
	const command: [string, ...string[]] = [executable, ...args];
	const timeoutMs =
		typeof settings.timeoutMs === "number" &&
		Number.isFinite(settings.timeoutMs) &&
		settings.timeoutMs > 0
			? settings.timeoutMs
			: 10_000;

	return createLintFeedbackHooks({
		worktree,
		command,
		timeoutMs,
		fileExists: async (relativePath) => isInsideWorktree(worktree, relativePath),
		runDiagnostics: async (relativePath) => {
			const [output, sourceCode] = await Promise.all([
				runCommand(command, relativePath, worktree, timeoutMs),
				readFile(path.join(worktree, relativePath), "utf8"),
			]);
			return parseBiomeDiagnostics(output, sourceCode);
		},
	});
};

export default LintFeedbackPlugin;
