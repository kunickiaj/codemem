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

const KIND_ICONS: Record<string, string> = {
	decision: "⚖️",
	bugfix: "🔴",
	feature: "🟢",
	refactor: "🔄",
	discovery: "🔵",
	change: "✅",
	exploration: "🔬",
};

function emitJson(value: FileContextResult | { error: string; message: string }): void {
	console.log(JSON.stringify(value));
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

type ScoredObservation = { row: RefQueryResult; score: number };

function scoreAndDedupe(
	rows: RefQueryResult[],
	targetPath: string,
	limit: number,
): RefQueryResult[] {
	// One observation per session: keep the most recent (rows arrive
	// ORDER BY created_at DESC) and drop the rest so the timeline doesn't
	// fill up with sibling observations from the same chat.
	const seenSessions = new Set<number>();
	const dedupedBySession: RefQueryResult[] = [];
	for (const row of rows) {
		if (!seenSessions.has(row.session_id)) {
			seenSessions.add(row.session_id);
			dedupedBySession.push(row);
		}
	}

	const normalizedTarget = normalizePathForCompare(targetPath);
	const scored: ScoredObservation[] = dedupedBySession.map((row) => {
		const filesRead = parseJsonArray(row.files_read);
		const filesModified = parseJsonArray(row.files_modified);
		const totalFiles = filesRead.length + filesModified.length;
		const inModified = filesModified.some((f) => normalizePathForCompare(f) === normalizedTarget);

		let score = 0;
		if (inModified) score += 2;
		if (totalFiles <= 3) score += 2;
		else if (totalFiles <= 8) score += 1;

		return { row, score };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((s) => s.row);
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

function formatTimeline(rows: RefQueryResult[], filePath: string): string {
	const safePath = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	const enriched = rows.map((row) => ({
		row,
		epochMs: Date.parse(row.created_at) || 0,
	}));

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

	const lines: string[] = [
		`This file (${safePath}) has prior codemem observations. The Read result below is unchanged.`,
		"- Need full detail on a past observation? memory.get_observations([IDs]) — fetches body + narrative.",
	];

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

	if (!relativePath || relativePath.startsWith("..")) {
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
		return continueResult();
	}
	if (stat.sizeBytes < minBytesEffective) {
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

	if (stat.mtimeMs > 0) {
		const newestObservationMs = rows.reduce((max, row) => {
			const epoch = Date.parse(row.created_at);
			return Number.isFinite(epoch) && epoch > max ? epoch : max;
		}, 0);
		if (newestObservationMs > 0 && stat.mtimeMs >= newestObservationMs) {
			logHookEvent(
				`file_context.skip reason=file_newer path=${JSON.stringify(relativePath)} mtime_ms=${stat.mtimeMs} newest_obs_ms=${newestObservationMs}`,
			);
			return continueResult();
		}
	}

	const top = scoreAndDedupe(rows, relativePath, DISPLAY_LIMIT);
	if (top.length === 0) {
		return continueResult();
	}

	const timeline = formatTimeline(top, relativePath);

	logHookEvent(
		`file_context.ok path=${JSON.stringify(relativePath)} candidates=${rows.length} surfaced=${top.length} project=${JSON.stringify(project ?? "")}`,
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
				emitJson({ error: "parse_error", message: "payload must be a JSON object" });
				process.exitCode = 1;
				return;
			}
			payload = parsed as Record<string, unknown>;
		} catch {
			emitJson({ error: "parse_error", message: "invalid JSON" });
			process.exitCode = 1;
			return;
		}

		const result = await buildClaudeFileContext(payload, opts);
		emitJson(result);
	},
);

export type { FileContextResult };
