import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { MemoryStore, type RefQueryResult, resolveDbPath, resolveHookProject } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, type DbOpts, resolveDbOpt } from "../shared-options.js";
import { logHookEvent } from "./claude-hook-plugin-log.js";

type FileContextResult = {
	continue?: true;
	hookSpecificOutput?: {
		hookEventName: "PreToolUse";
		permissionDecision: "allow";
		additionalContext: string;
	};
};

type FileContextOpts = DbOpts;

type FileContextDeps = {
	queryByFile?: typeof queryByFile;
	resolveDb?: typeof resolveDbPath;
	statFile?: typeof statFile;
};

const FILE_GATE_MIN_BYTES = 1500;
const FETCH_LIMIT = 40;
const DISPLAY_LIMIT = 15;
// Mtime tolerance — observations from within ~5 minutes of the file's
// mtime are treated as fresh enough to surface without a staleness
// header. Smaller than this we'd false-positive on routine edits;
// larger and branch switches read clean.
const MTIME_FRESH_TOLERANCE_MS = 5 * 60 * 1000;

// Small but high-signal file extensions: configs and infra files are
// load-bearing for past decisions even at <1500 bytes, so bypass the
// size gate for them.
const SMALL_FILE_BYPASS_PATTERNS: RegExp[] = [
	/\.(json|jsonc|toml|ya?ml)$/i,
	/\.env(\.|$)/i,
	/(^|\/)dockerfile(\.|$)/i,
	/\.config\.(js|ts|mjs|cjs|json)$/i,
];

const KIND_ICONS: Record<string, string> = {
	decision: "⚖️",
	bugfix: "🔴",
	feature: "🟢",
	refactor: "🔄",
	discovery: "🔵",
	change: "✅",
	exploration: "🔬",
};

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

function parseJsonArray(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

function normalizePathForCompare(path: string): string {
	return path.replace(/\\/g, "/");
}

type ScoredObservation = { row: RefQueryResult; score: number; idx: number };

function scoreRow(row: RefQueryResult, normalizedTarget: string, idx: number): ScoredObservation {
	const filesModified = parseJsonArray(row.files_modified);
	const inModified = filesModified.some((f) => normalizePathForCompare(f) === normalizedTarget);

	// Specificity is "did this session focus on the target file?"
	// `files_read` is dominated by the agent crawling the repo for
	// context, so it shouldn't dilute that signal — score by
	// files_modified only.
	let score = 0;
	if (inModified) score += 2;
	if (filesModified.length <= 1) score += 2;
	else if (filesModified.length <= 3) score += 1;

	return { row, score, idx };
}

function scoreAndDedupe(
	rows: RefQueryResult[],
	targetPath: string,
	limit: number,
): RefQueryResult[] {
	const normalizedTarget = normalizePathForCompare(targetPath);
	const scored = rows.map((row, idx) => scoreRow(row, normalizedTarget, idx));

	// Dedupe by session keeping the highest-scoring observation per
	// session. Tiebreak on smaller idx — `findByFile` returns rows
	// ORDER BY created_at DESC so a smaller idx means more recent.
	const bestPerSession = new Map<number, ScoredObservation>();
	for (const item of scored) {
		const existing = bestPerSession.get(item.row.session_id);
		if (
			!existing ||
			item.score > existing.score ||
			(item.score === existing.score && item.idx < existing.idx)
		) {
			bestPerSession.set(item.row.session_id, item);
		}
	}

	const deduped = Array.from(bestPerSession.values());
	deduped.sort((a, b) => b.score - a.score || a.idx - b.idx);
	return deduped.slice(0, limit).map((s) => s.row);
}

function compactTime(timeStr: string): string {
	return timeStr.toLowerCase().replace(" am", "a").replace(" pm", "p");
}

function formatTime(epochMs: number): string {
	return new Date(epochMs).toLocaleString("en-US", {
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
}

function formatDate(epochMs: number): string {
	return new Date(epochMs).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function formatTimeline(
	rows: RefQueryResult[],
	filePath: string,
	staleness: { fileMtimeMs: number; newestObservationMs: number } | null,
): string {
	const safePath = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	const enriched = rows
		.map((row) => ({ row, epochMs: Date.parse(row.created_at) }))
		.filter((item) => Number.isFinite(item.epochMs) && item.epochMs > 0);

	const byDay = new Map<string, typeof enriched>();
	for (const item of enriched) {
		const day = formatDate(item.epochMs);
		const bucket = byDay.get(day);
		if (bucket) bucket.push(item);
		else byDay.set(day, [item]);
	}

	const sortedDays = Array.from(byDay.entries()).sort((a, b) => {
		const aMin = Math.min(...a[1].map((i) => i.epochMs));
		const bMin = Math.min(...b[1].map((i) => i.epochMs));
		return aMin - bMin;
	});

	const ids = rows.map((r) => r.id);
	const lines: string[] = [
		`This file (${safePath}) has prior codemem observations. The Read result below is unchanged.`,
		`- Fetch full bodies on demand: memory.get_observations([${ids.join(", ")}]).`,
	];
	if (staleness) {
		const driftMinutes = Math.max(
			1,
			Math.round((staleness.fileMtimeMs - staleness.newestObservationMs) / 60_000),
		);
		lines.unshift(
			`Heads up: this file was modified ~${driftMinutes} min after the most recent observation below. Past entries may be partially stale — verify against the Read result before relying on them.`,
		);
	}

	for (const [day, dayItems] of sortedDays) {
		const chronological = [...dayItems].sort((a, b) => a.epochMs - b.epochMs);
		lines.push(`### ${day}`);
		for (const { row, epochMs } of chronological) {
			const title = (row.title || "Untitled")
				.replace(/[\r\n\t]+/g, " ")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 160);
			const icon = KIND_ICONS[row.kind] ?? "❔";
			const time = compactTime(formatTime(epochMs));
			lines.push(`${row.id} ${time} ${icon} (${row.kind}) ${title}`);
		}
	}

	return lines.join("\n");
}

function queryByFile(
	dbPath: string,
	relativePath: string,
	project: string | null,
	limit: number,
): RefQueryResult[] {
	const store = new MemoryStore(dbPath);
	try {
		const opts: { project?: string; limit: number } = { limit };
		if (project) opts.project = project;
		return store.findByFile(relativePath, opts);
	} finally {
		store.close();
	}
}

function resolveProject(payload: Record<string, unknown>): string | null {
	const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
	return resolveHookProject(cwd, payload.project);
}

export async function buildClaudeFileContext(
	payload: Record<string, unknown>,
	opts: FileContextOpts,
	deps: FileContextDeps = {},
): Promise<FileContextResult> {
	if (envTruthy(process.env.CODEMEM_PLUGIN_IGNORE)) {
		return continueResult();
	}
	if (!envNotDisabled(process.env.CODEMEM_FILE_CONTEXT || "1")) {
		return continueResult();
	}

	const filePath = extractFilePath(payload);
	if (!filePath) {
		return continueResult();
	}

	const cwd = typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd();
	const expandedPath = expandHome(filePath);
	const absolutePath = isAbsolute(expandedPath) ? expandedPath : resolve(cwd, expandedPath);
	const relativePath = relative(cwd, absolutePath).split(sep).join("/");

	// Reject paths that escape cwd. `startsWith("..")` would also reject
	// in-repo basenames that begin with `..` (e.g. `..hidden`); a
	// segment-aware check distinguishes those from the `../foo` parent
	// traversal. `isAbsolute` catches the Windows cross-drive case where
	// `relative('C:\\repo', 'D:\\x')` returns an absolute-shaped string.
	const escapesCwd =
		relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath);
	if (!relativePath || escapesCwd) {
		logHookEvent(
			`file_context.skip reason=outside_cwd path=${JSON.stringify(filePath)} cwd=${JSON.stringify(cwd)}`,
		);
		return continueResult();
	}

	const minBytes = Number.parseInt(
		process.env.CODEMEM_FILE_CONTEXT_MIN_BYTES ?? `${FILE_GATE_MIN_BYTES}`,
		10,
	);
	const minBytesEffective =
		Number.isFinite(minBytes) && minBytes >= 0 ? minBytes : FILE_GATE_MIN_BYTES;

	const stat = (deps.statFile ?? statFile)(absolutePath);
	if (!stat) {
		logHookEvent(`file_context.skip reason=stat_failed path=${JSON.stringify(relativePath)}`);
		return continueResult();
	}
	const bypassSizeGate = SMALL_FILE_BYPASS_PATTERNS.some((p) => p.test(relativePath));
	if (stat.sizeBytes < minBytesEffective && !bypassSizeGate) {
		logHookEvent(
			`file_context.skip reason=below_size_gate path=${JSON.stringify(relativePath)} size=${stat.sizeBytes} gate=${minBytesEffective}`,
		);
		return continueResult();
	}

	const project = resolveProject(payload);
	const resolveDb = deps.resolveDb ?? resolveDbPath;
	const queryFn = deps.queryByFile ?? queryByFile;

	let rows: RefQueryResult[] = [];
	try {
		const dbPath = resolveDb(resolveDbOpt(opts));
		rows = queryFn(dbPath, relativePath, project, FETCH_LIMIT);
	} catch (err) {
		logHookEvent(
			`codemem claude-hook-file-context query failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return continueResult();
	}

	if (rows.length === 0) {
		logHookEvent(
			`file_context.skip reason=no_observations path=${JSON.stringify(relativePath)} project=${JSON.stringify(project ?? "")}`,
		);
		return continueResult();
	}

	const top = scoreAndDedupe(rows, relativePath, DISPLAY_LIMIT);
	if (top.length === 0) {
		logHookEvent(
			`file_context.skip reason=no_top_after_dedupe path=${JSON.stringify(relativePath)} candidates=${rows.length}`,
		);
		return continueResult();
	}

	let staleness: { fileMtimeMs: number; newestObservationMs: number } | null = null;
	if (stat.mtimeMs > 0) {
		const newestObservationMs = top.reduce((max, row) => {
			const epoch = Date.parse(row.created_at);
			return Number.isFinite(epoch) && epoch > max ? epoch : max;
		}, 0);
		if (newestObservationMs > 0 && stat.mtimeMs > newestObservationMs + MTIME_FRESH_TOLERANCE_MS) {
			staleness = { fileMtimeMs: stat.mtimeMs, newestObservationMs };
		}
	}

	const timeline = formatTimeline(top, relativePath, staleness);

	logHookEvent(
		`file_context.ok path=${JSON.stringify(relativePath)} candidates=${rows.length} surfaced=${top.length} project=${JSON.stringify(project ?? "")} stale=${staleness ? "true" : "false"}`,
	);

	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
			additionalContext: timeline,
		},
	};
}

const claudeHookFileContextCmd = new Command("claude-hook-file-context")
	.configureHelp(helpStyle)
	.description(
		"Return Claude PreToolUse:Read additionalContext from per-file observation timeline",
	);

addDbOption(claudeHookFileContextCmd);

export const claudeHookFileContextCommand = claudeHookFileContextCmd.action(
	async (opts: FileContextOpts) => {
		let raw = "";
		for await (const chunk of process.stdin) {
			raw += String(chunk);
		}
		const trimmed = raw.trim();
		if (!trimmed) {
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

		const result = await buildClaudeFileContext(payload, opts);
		emitJson(result);
	},
);

export type { FileContextResult };
