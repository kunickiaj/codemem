import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	createFileContextRunner,
	FILE_CONTEXT_TRANSPORT_MAX_BYTES,
	FILE_CONTEXT_TRANSPORT_PROFILE,
	type FileContextResult,
	MemoryStore,
	type RefQueryResult,
	type RetrievalSurfaceRecordInput,
	resolveDbPath,
	resolveHookProject,
} from "@codemem/core";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, type DbOpts, resolveDbOpt } from "../shared-options.js";
import { runClaudeFileContextTransport } from "./claude-hook-file-context-transport.js";
import { logHookEvent } from "./claude-hook-plugin-log.js";

type FileContextOpts = DbOpts & { transportProfile?: boolean; transport?: boolean };

type FileContextDeps = {
	queryByFile?: (
		dbPath: string,
		relativePath: string,
		project: string | null,
		limit: number,
	) => RefQueryResult[];
	resolveDb?: typeof resolveDbPath;
	statFile?: typeof statFile;
	createStore?: (dbPath: string) => MemoryStore;
	recordAttempt?: (dbPath: string, input: RetrievalSurfaceRecordInput) => void;
	updateDelivery?: (dbPath: string, attemptId: string, status: "handed_off" | "failed") => void;
	now?: () => Date;
	createAttemptId?: () => string;
};

const FILE_GATE_MIN_BYTES = 1500;
// Small configs and infra files bypass the size gate because past decisions
// about them remain useful even when the whole file fits in a few lines.
const SMALL_FILE_BYPASS_PATTERNS: RegExp[] = [
	/\.(json|jsonc|toml|ya?ml)$/i,
	/\.env(\.|$)/i,
	/(^|\/)dockerfile(\.|$)/i,
	/\.config\.(js|ts|mjs|cjs|json)$/i,
];

function emitJson(value: FileContextResult): void {
	console.log(JSON.stringify(value));
}

function emitError(value: { error: string; message: string }): void {
	// Errors go to stderr so a non-zero exit from `codemem` doesn't poison
	// the bash hook's stdout when it falls back to `npx -y codemem ...`.
	process.stderr.write(`${JSON.stringify(value)}\n`);
}

function continueResult(): FileContextResult {
	return { continue: true };
}

function envNotDisabled(value: string | undefined): boolean {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

function envTruthy(value: string | undefined): boolean {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	return value;
}

function extractFilePath(payload: Record<string, unknown>): string | null {
	const toolInput = payload.tool_input;
	if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
		return null;
	}
	const filePath = (toolInput as Record<string, unknown>).file_path;
	return typeof filePath === "string" && filePath.trim() ? filePath.trim() : null;
}

type StatResult = { sizeBytes: number; mtimeMs: number } | null;

function statFile(absPath: string): StatResult {
	try {
		const stat = statSync(absPath);
		return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
	} catch {
		return null;
	}
}

function resolveProject(payload: Record<string, unknown>): string | null {
	const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
	return resolveHookProject(cwd, payload.project);
}

function sourceSessionId(payload: Record<string, unknown>): string | null {
	const value = payload.session_id;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fileContextStore(opts: FileContextOpts, deps: FileContextDeps) {
	let resolvedDbPath: string | null = null;
	let activeStore: MemoryStore | null = null;
	const dbPath = () => {
		resolvedDbPath ??= (deps.resolveDb ?? resolveDbPath)(resolveDbOpt(opts));
		return resolvedDbPath;
	};
	return {
		dbPath,
		getStore: () => {
			activeStore ??= (deps.createStore ?? ((path) => new MemoryStore(path)))(dbPath());
			return activeStore;
		},
		finish: (result: FileContextResult) => {
			try {
				activeStore?.close();
			} catch {
				// Cleanup happens after attribution and must not suppress valid hook output.
			}
			activeStore = null;
			return result;
		},
	};
}

function fileContextRunner(
	payload: Record<string, unknown>,
	store: ReturnType<typeof fileContextStore>,
	deps: FileContextDeps,
) {
	const findByFile = deps.queryByFile;
	const recordAttempt = deps.recordAttempt;
	const updateDelivery = deps.updateDelivery;
	return createFileContextRunner({
		getStore: store.getStore,
		sourceSessionId: sourceSessionId(payload),
		ledgerEnabled: () => envNotDisabled(process.env.CODEMEM_RETRIEVAL_LEDGER || "1"),
		now: deps.now,
		createAttemptId: deps.createAttemptId,
		log: logHookEvent,
		...(findByFile
			? {
					findByFile: (path, options) =>
						findByFile(store.dbPath(), path, options.project ?? null, options.limit),
				}
			: {}),
		...(recordAttempt ? { recordAttempt: (input) => recordAttempt(store.dbPath(), input) } : {}),
		...(updateDelivery
			? { updateDelivery: (attemptId, status) => updateDelivery(store.dbPath(), attemptId, status) }
			: {}),
	});
}

function fileContextPath(
	filePath: string,
	payload: Record<string, unknown>,
): { absolutePath: string; relativePath: string } | null {
	const cwd = typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd();
	const expandedPath = expandHome(filePath);
	const absolutePath = isAbsolute(expandedPath) ? expandedPath : resolve(cwd, expandedPath);
	const relativePath = relative(cwd, absolutePath).split(sep).join("/");
	// Reject parent traversal without rejecting in-repo basenames like ..hidden.
	// isAbsolute catches the Windows cross-drive result from relative().
	const escapesCwd =
		relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath);
	if (!relativePath || escapesCwd) {
		logHookEvent(
			`file_context.skip reason=outside_cwd path=${JSON.stringify(filePath)} cwd=${JSON.stringify(cwd)}`,
		);
		return null;
	}
	return { absolutePath, relativePath };
}

export async function buildClaudeFileContext(
	payload: Record<string, unknown>,
	opts: FileContextOpts,
	deps: FileContextDeps = {},
): Promise<FileContextResult> {
	if (envTruthy(process.env.CODEMEM_PLUGIN_IGNORE)) return continueResult();
	const filePath = extractFilePath(payload);
	if (!filePath) return continueResult();
	const store = fileContextStore(opts, deps);
	const runner = fileContextRunner(payload, store, deps);
	if (!envNotDisabled(process.env.CODEMEM_FILE_CONTEXT || "1")) {
		return store.finish(runner.skip({ reason: "file_context_disabled" }));
	}
	const path = fileContextPath(filePath, payload);
	if (!path) return store.finish(runner.skip({ reason: "outside_cwd" }));
	const { absolutePath, relativePath } = path;
	const minBytes = Number.parseInt(
		process.env.CODEMEM_FILE_CONTEXT_MIN_BYTES ?? `${FILE_GATE_MIN_BYTES}`,
		10,
	);
	const minBytesEffective =
		Number.isFinite(minBytes) && minBytes >= 0 ? minBytes : FILE_GATE_MIN_BYTES;
	const stat = (deps.statFile ?? statFile)(absolutePath);
	if (!stat) {
		logHookEvent(`file_context.skip reason=stat_failed path=${JSON.stringify(relativePath)}`);
		return store.finish(runner.skip({ reason: "stat_failed", repositoryPaths: [relativePath] }));
	}
	const bypassSizeGate = SMALL_FILE_BYPASS_PATTERNS.some((p) => p.test(relativePath));
	if (stat.sizeBytes < minBytesEffective && !bypassSizeGate) {
		logHookEvent(
			`file_context.skip reason=below_size_gate path=${JSON.stringify(relativePath)} size=${stat.sizeBytes} gate=${minBytesEffective}`,
		);
		return store.finish(
			runner.skip({ reason: "below_size_gate", repositoryPaths: [relativePath] }),
		);
	}
	return store.finish(
		runner.run({ relativePath, project: resolveProject(payload), fileMtimeMs: stat.mtimeMs }),
	);
}

const claudeHookFileContextCmd = new Command("claude-hook-file-context")
	.configureHelp(helpStyle)
	.description(
		"Return Claude PreToolUse:Read additionalContext from per-file observation timeline",
	);

addDbOption(claudeHookFileContextCmd);
claudeHookFileContextCmd.addOption(new Option("--transport-profile").hideHelp());
claudeHookFileContextCmd.addOption(new Option("--transport").hideHelp());

export const claudeHookFileContextCommand = claudeHookFileContextCmd.action(
	async (opts: FileContextOpts) => {
		if (opts.transportProfile) {
			process.stdout.write(`${JSON.stringify(FILE_CONTEXT_TRANSPORT_PROFILE)}\n`);
			return;
		}
		let raw = "";
		for await (const chunk of process.stdin) {
			raw += String(chunk);
			if (opts.transport && Buffer.byteLength(raw) > FILE_CONTEXT_TRANSPORT_MAX_BYTES) {
				emitError({ error: "parse_error", message: "transport payload too large" });
				process.exitCode = 1;
				return;
			}
		}
		const trimmed = raw.trim();
		if (!trimmed) {
			if (opts.transport) {
				process.stdout.write(
					`${JSON.stringify({ error: "parse_error", message: "transport request required" })}\n`,
				);
				process.exitCode = 1;
				return;
			}
			emitJson(continueResult());
			return;
		}

		let payload: Record<string, unknown>;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
				emitError({ error: "parse_error", message: "payload must be a JSON object" });
				process.exitCode = 1;
				return;
			}
			payload = parsed as Record<string, unknown>;
		} catch {
			emitError({ error: "parse_error", message: "invalid JSON" });
			process.exitCode = 1;
			return;
		}

		await emitFileContext(payload, opts);
	},
);

async function emitFileContext(payload: Record<string, unknown>, opts: FileContextOpts) {
	try {
		if (opts.transport) {
			process.stdout.write(`${JSON.stringify(runClaudeFileContextTransport(payload, opts))}\n`);
			return;
		}
		emitJson(await buildClaudeFileContext(payload, opts));
	} catch {
		emitError({ error: "file_context_failed", message: "file context unavailable" });
		process.exitCode = 1;
	}
}

export type { FileContextResult };
