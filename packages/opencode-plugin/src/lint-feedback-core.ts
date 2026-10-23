import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Plugin, PluginOptions } from "@opencode-ai/plugin";
import {
	compareDiagnostics,
	formatFeedback,
	type LintDiagnostic,
	parseBiomeDiagnostics,
} from "./lint-diagnostics.js";

export {
	compareDiagnostics,
	formatFeedback,
	type LintDiagnostic,
	parseBiomeDiagnostics,
	parseMeasuredValue,
} from "./lint-diagnostics.js";

const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
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

export interface LintFeedbackInvocation {
	tool: string;
	sessionID: string;
	callID: string;
	args?: unknown;
}

export interface LintFeedbackController {
	before(input: LintFeedbackInvocation): Promise<void>;
	after(input: LintFeedbackInvocation): Promise<string | undefined>;
	discard(input: Pick<LintFeedbackInvocation, "sessionID" | "callID">): void;
	dispose(): Promise<void>;
}

interface HookDependencies {
	worktree: string;
	command: [string, ...string[]];
	timeoutMs: number;
	runDiagnostics: (relativePath: string, signal?: AbortSignal) => Promise<LintDiagnostic[]>;
	fileExists: (relativePath: string) => Promise<boolean>;
	disposeDiagnostics?: () => void;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
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
	if (/^packages\/opencode-plugin\/\.opencode\/(?:lib|plugins)\/.+\.js$/.test(relativePath)) {
		return true;
	}
	if (/^\.opencode\/plugins\/.+\.js$/.test(relativePath)) return true;
	if (/^packages\/.+\/vite\.config\.ts$/.test(relativePath)) return true;
	if (/^packages\/ui\/playwright[^/]*\.config\.ts$/.test(relativePath)) return true;
	if (/^packages\/ui\/visual\/.+\.ts$/.test(relativePath)) return true;
	if (/^packages\/ui\/scripts\/visual-[^/]*\.mjs$/.test(relativePath)) return true;
	if (relativePath === "plugins/claude/scripts/pre-read-hook.mjs") return true;
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
	if (tool === "apply_patch" || tool === "patch") return getApplyPatchTouchedFiles(args, worktree);
	if (tool !== "edit" && tool !== "write") return [];
	const candidate = getPathArgument(args);
	const resolved = candidate ? resolveWorktreePath(worktree, candidate) : undefined;
	return resolved ? [{ beforePath: resolved, afterPath: resolved }] : [];
}

export function getTouchedPaths(tool: string, args: UnknownRecord, worktree: string): string[] {
	return getTouchedFiles(tool, args, worktree).map((item) => item.afterPath);
}

function appendOutput(output: AfterOutput, message: string): void {
	output.output = output.output ? `${output.output}\n\n${message}` : message;
}

function callKey(input: Pick<HookInput, "sessionID" | "callID">): string {
	return `${input.sessionID}\u0000${input.callID}`;
}

async function captureSnapshot(
	input: LintFeedbackInvocation,
	dependencies: HookDependencies,
	signal: AbortSignal,
): Promise<Snapshot | undefined> {
	if (signal.aborted) return undefined;
	const args = isRecord(input.args) ? input.args : {};
	const files = getTouchedFiles(input.tool, args, dependencies.worktree);
	if (files.length === 0) return undefined;
	const diagnosticsByPath = new Map<string, LintDiagnostic[]>();
	let failed = false;
	await Promise.all(
		files.map(async ({ beforePath, afterPath }) => {
			try {
				if (signal.aborted) return;
				if (!beforePath) {
					diagnosticsByPath.set(afterPath, []);
					return;
				}
				const exists = await dependencies.fileExists(beforePath);
				if (signal.aborted) return;
				diagnosticsByPath.set(
					afterPath,
					exists ? await dependencies.runDiagnostics(beforePath, signal) : [],
				);
			} catch {
				failed = true;
			}
		}),
	);
	return { diagnosticsByPath, failed };
}

async function inspectAfter(
	snapshot: Snapshot,
	dependencies: HookDependencies,
	signal: AbortSignal,
): Promise<{ regressions: LintDiagnostic[]; failed: boolean }> {
	const regressions: LintDiagnostic[] = [];
	let failed = snapshot.failed;
	await Promise.all(
		Array.from(snapshot.diagnosticsByPath, async ([relativePath, before]) => {
			try {
				if (signal.aborted) return;
				if (!(await dependencies.fileExists(relativePath))) return;
				if (signal.aborted) return;
				const after = await dependencies.runDiagnostics(relativePath, signal);
				regressions.push(...compareDiagnostics(before, after));
			} catch {
				failed = true;
			}
		}),
	);
	return { regressions, failed };
}

export function createLintFeedbackController(
	dependencies: HookDependencies,
): LintFeedbackController {
	const snapshots = new Map<string, Snapshot>();
	const warnedSessions = new Set<string>();
	const cancellation = new AbortController();
	let active = true;

	return {
		before: async (input): Promise<void> => {
			if (!active) return;
			const snapshot = await captureSnapshot(input, dependencies, cancellation.signal);
			if (!active || !snapshot) return;
			if (snapshots.size >= SNAPSHOT_LIMIT) {
				const oldest = snapshots.keys().next().value;
				if (oldest) snapshots.delete(oldest);
			}
			snapshots.set(callKey(input), snapshot);
		},

		after: async (input): Promise<string | undefined> => {
			if (!active) return undefined;
			const key = callKey(input);
			const snapshot = snapshots.get(key);
			snapshots.delete(key);
			if (!snapshot) return undefined;

			const { regressions, failed } = await inspectAfter(
				snapshot,
				dependencies,
				cancellation.signal,
			);
			if (!active) return undefined;
			const messages: string[] = [];
			if (regressions.length > 0) messages.push(formatFeedback(regressions));
			if (failed && !warnedSessions.has(input.sessionID)) {
				warnedSessions.add(input.sessionID);
				messages.push(WARNING);
			}
			return messages.length > 0 ? messages.join("\n\n") : undefined;
		},
		discard: (input): void => {
			snapshots.delete(callKey(input));
		},
		dispose: async (): Promise<void> => {
			active = false;
			cancellation.abort();
			snapshots.clear();
			warnedSessions.clear();
			dependencies.disposeDiagnostics?.();
		},
	};
}

export function createLintFeedbackHooks(dependencies: HookDependencies) {
	const controller = createLintFeedbackController(dependencies);
	return {
		"tool.execute.before": async (input: HookInput, output: BeforeOutput): Promise<void> => {
			await controller.before({ ...input, args: output.args });
		},
		"tool.execute.after": async (input: HookInput, output: AfterOutput): Promise<void> => {
			const message = await controller.after(input);
			if (message) appendOutput(output, message);
		},
		dispose: controller.dispose,
	};
}

async function runCommand(
	command: [string, ...string[]],
	relativePath: string,
	worktree: string,
	timeoutMs: number,
	ownerChildren: Set<ChildProcess>,
	signal?: AbortSignal,
): Promise<string> {
	if (signal?.aborted) throw new Error("Lint command cancelled");
	const [executable, ...args] = command;
	const child = spawn(executable, [...args, "--", relativePath], {
		cwd: worktree,
		detached: process.platform !== "win32",
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	liveChildren.add(child);
	ownerChildren.add(child);
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
	child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

	return await new Promise<string>((resolve, reject) => {
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			killProcessTree(child, "SIGKILL");
			reject(new Error("Lint command cancelled"));
		};
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => {
			killProcessTree(child, "SIGTERM");
			forceKillTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 250);
			reject(new Error(`Lint command timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.once("error", (error) => {
			liveChildren.delete(child);
			ownerChildren.delete(child);
			signal?.removeEventListener("abort", abort);
			clearTimeout(timer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			reject(error);
		});
		child.once("close", (code) => {
			liveChildren.delete(child);
			ownerChildren.delete(child);
			signal?.removeEventListener("abort", abort);
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

export function createWorktreeLintFeedbackController(
	worktree: string,
	options?: PluginOptions,
): LintFeedbackController | undefined {
	const settings = options as LintFeedbackOptions | undefined;
	if (!validCommand(settings?.command)) return undefined;
	const [executable, ...args] = settings.command;
	const command: [string, ...string[]] = [executable, ...args];
	const timeoutMs =
		typeof settings.timeoutMs === "number" &&
		Number.isFinite(settings.timeoutMs) &&
		settings.timeoutMs > 0
			? settings.timeoutMs
			: 10_000;
	const ownerChildren = new Set<ChildProcess>();

	return createLintFeedbackController({
		worktree,
		command,
		timeoutMs,
		fileExists: async (relativePath) => isInsideWorktree(worktree, relativePath),
		runDiagnostics: async (relativePath, signal) => {
			const [output, sourceCode] = await Promise.all([
				runCommand(command, relativePath, worktree, timeoutMs, ownerChildren, signal),
				readFile(path.join(worktree, relativePath), "utf8"),
			]);
			return parseBiomeDiagnostics(output, sourceCode);
		},
		disposeDiagnostics: () => {
			for (const child of ownerChildren) killProcessTree(child, "SIGKILL");
			ownerChildren.clear();
		},
	});
}

export const LintFeedbackPlugin: Plugin = async ({ worktree }, options?: PluginOptions) => {
	const controller = createWorktreeLintFeedbackController(worktree, options);
	if (!controller) return {};
	return {
		"tool.execute.before": async (input: HookInput, output: BeforeOutput) => {
			await controller.before({ ...input, args: output.args });
		},
		"tool.execute.after": async (input: HookInput, output: AfterOutput) => {
			const message = await controller.after(input);
			if (message) appendOutput(output, message);
		},
		dispose: controller.dispose,
	};
};

export default LintFeedbackPlugin;
