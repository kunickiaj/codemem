import { randomUUID } from "node:crypto";
import type { RefQueryResult } from "./ref-queries.js";
import {
	type RetrievalLedgerWriteOutcome,
	tryUpdateRetrievalDelivery,
} from "./retrieval-ledger.js";
import {
	type RetrievalSurfaceRecordInput,
	recordRetrievalSurface,
	resolveRetrievalSession,
} from "./retrieval-surface-ledger.js";
import type { MemoryStore } from "./store.js";

export type FileContextResult = {
	continue?: true;
	hookSpecificOutput?: {
		hookEventName: "PreToolUse";
		permissionDecision: "allow";
		additionalContext: string;
	};
};

export interface FileContextRequest {
	relativePath: string;
	project: string | null;
	fileMtimeMs: number;
}

const SKIP_STAGES = {
	file_context_disabled: "configuration",
	outside_cwd: "path_validation",
	stat_failed: "file_access",
	below_size_gate: "size_gate",
} as const;

export interface FileContextSkip {
	reason: keyof typeof SKIP_STAGES;
	repositoryPaths?: string[];
}

export interface FileContextRunnerOptions {
	/** Caller owns the store lifetime; skipped attempts can also acquire it for the ledger. */
	getStore: () => Pick<MemoryStore, "db" | "findByFile">;
	sourceSessionId: string | null;
	requestId?: string;
	/** Transports acknowledge only after the host output has been written. */
	deferDelivery?: boolean;
	onRecorded?: (outcome: RetrievalLedgerWriteOutcome) => void;
	ledgerEnabled?: () => boolean;
	findByFile?: (
		relativePath: string,
		options: { limit: number; project?: string },
	) => RefQueryResult[];
	recordAttempt?: (input: RetrievalSurfaceRecordInput) => void;
	updateDelivery?: (attemptId: string, status: "handed_off" | "failed") => void;
	log?: (message: string) => void;
	now?: () => Date;
	createAttemptId?: () => string;
}

type RunnerContext = FileContextRunnerOptions & { startedAt: Date; attemptId: string };
type AttemptInput = Omit<
	RetrievalSurfaceRecordInput,
	"attemptId" | "surface" | "trigger" | "startedAt" | "completedAt" | "recorderVersion"
>;
type Staleness = { fileMtimeMs: number; newestObservationMs: number } | null;
type ScoredObservation = { row: RefQueryResult; score: number; idx: number };

const FETCH_LIMIT = 40;
const DISPLAY_LIMIT = 15;
// Observations within five minutes of mtime are fresh enough for routine edits.
const MTIME_FRESH_TOLERANCE_MS = 5 * 60 * 1000;
const KIND_ICONS: Record<string, string> = {
	decision: "⚖️",
	bugfix: "🔴",
	feature: "🟢",
	refactor: "🔄",
	discovery: "🔵",
	change: "✅",
	exploration: "🔬",
};

function recordAttempt(context: RunnerContext, input: AttemptInput): void {
	if (context.ledgerEnabled?.() === false) return;
	try {
		const completedAt = (context.now ?? (() => new Date()))();
		const ledgerInput: RetrievalSurfaceRecordInput = {
			...input,
			attemptId: context.attemptId,
			surface: "file_context",
			trigger: "automatic",
			startedAt: context.startedAt.toISOString(),
			completedAt: completedAt.toISOString(),
			latencyMs: Math.max(0, completedAt.getTime() - context.startedAt.getTime()),
			recorderVersion: "claude-file-context-v1",
			source: "claude",
			streamId: context.sourceSessionId,
			sourceSessionId: context.sourceSessionId,
			mode: "claude_pre_tool_use_read",
			...(context.requestId ? { requestId: context.requestId } : {}),
		};
		if (context.recordAttempt) {
			context.recordAttempt(ledgerInput);
			return;
		}
		const store = context.getStore();
		const outcome = recordRetrievalSurface(store.db, {
			...ledgerInput,
			sessionId: resolveRetrievalSession(store.db, "claude", context.sourceSessionId),
		});
		context.onRecorded?.(outcome);
	} catch {
		// Resolving or writing the ledger must not affect hook output.
	}
}

function updateDelivery(context: RunnerContext, status: "handed_off" | "failed"): void {
	if (status === "handed_off" && context.deferDelivery) return;
	if (context.ledgerEnabled?.() === false) return;
	try {
		if (context.updateDelivery) {
			context.updateDelivery(context.attemptId, status);
			return;
		}
		tryUpdateRetrievalDelivery(context.getStore().db, context.attemptId, status);
	} catch {
		// Delivery remains successful even if attribution cannot be updated.
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

function scoreRow(row: RefQueryResult, normalizedTarget: string, idx: number): ScoredObservation {
	const filesModified = parseJsonArray(row.files_modified);
	const inModified = filesModified.some((f) => normalizePathForCompare(f) === normalizedTarget);
	// Specificity follows files_modified only: crawling files_read must not dilute it.
	let score = 0;
	if (inModified) score += 2;
	if (filesModified.length <= 1) score += 2;
	else if (filesModified.length <= 3) score += 1;
	return { row, score, idx };
}

function scoreAndDedupe(rows: RefQueryResult[], targetPath: string): RefQueryResult[] {
	const normalizedTarget = normalizePathForCompare(targetPath);
	const scored = rows.map((row, idx) => scoreRow(row, normalizedTarget, idx));
	// Keep the most specific observation per originating session. Earlier input
	// indices win ties because findByFile returns newest observations first.
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
	return deduped.slice(0, DISPLAY_LIMIT).map((s) => s.row);
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

function timelineDays(rows: RefQueryResult[]) {
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
	return Array.from(byDay.entries()).sort((a, b) => {
		const aMin = Math.min(...a[1].map((i) => i.epochMs));
		const bMin = Math.min(...b[1].map((i) => i.epochMs));
		return aMin - bMin;
	});
}

function formatTimeline(rows: RefQueryResult[], filePath: string, staleness: Staleness): string {
	const safePath = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	const sortedDays = timelineDays(rows);
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

function fileStaleness(rows: RefQueryResult[], fileMtimeMs: number): Staleness {
	if (!(fileMtimeMs > 0)) return null;
	const newestObservationMs = rows.reduce((max, row) => {
		const epoch = Date.parse(row.created_at);
		return Number.isFinite(epoch) && epoch > max ? epoch : max;
	}, 0);
	if (newestObservationMs > 0 && fileMtimeMs > newestObservationMs + MTIME_FRESH_TOLERANCE_MS) {
		return { fileMtimeMs, newestObservationMs };
	}
	return null;
}

function queryRows(context: RunnerContext, request: FileContextRequest): RefQueryResult[] | null {
	const { relativePath, project } = request;
	try {
		const options = { limit: FETCH_LIMIT, ...(project ? { project } : {}) };
		if (context.findByFile) return context.findByFile(relativePath, options);
		return context.getStore().findByFile(relativePath, options);
	} catch (err) {
		context.log?.(
			`codemem claude-hook-file-context query failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		recordAttempt(context, {
			retrievalStatus: "failed",
			deliveryStatus: "not_attempted",
			failureCode: "query_failed",
			failureStage: "retrieval",
			project,
			filters: project ? { project } : undefined,
			repositoryPaths: [relativePath],
		});
		return null;
	}
}

function recordSelection(
	context: RunnerContext,
	request: FileContextRequest,
	rows: RefQueryResult[],
	top: RefQueryResult[],
): void {
	recordAttempt(context, {
		retrievalStatus: "succeeded",
		deliveryStatus: "not_attempted",
		candidateIds: rows.map((row) => row.id),
		candidateCount: rows.length,
		selectedIds: top.map((row) => row.id),
		...(top.length === 0 ? { failureCode: "no_top_after_dedupe", failureStage: "selection" } : {}),
		project: request.project,
		filters: request.project ? { project: request.project } : undefined,
		repositoryPaths: [request.relativePath],
	});
}

function deliverContext(
	context: RunnerContext,
	request: FileContextRequest,
	rows: RefQueryResult[],
	top: RefQueryResult[],
	staleness: Staleness,
): FileContextResult {
	const { relativePath, project } = request;
	let timeline: string;
	try {
		timeline = formatTimeline(top, relativePath, staleness);
	} catch {
		updateDelivery(context, "failed");
		return { continue: true };
	}
	context.log?.(
		`file_context.ok path=${JSON.stringify(relativePath)} candidates=${rows.length} surfaced=${top.length} project=${JSON.stringify(project ?? "")} stale=${staleness ? "true" : "false"}`,
	);
	updateDelivery(context, "handed_off");
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
			additionalContext: timeline,
		},
	};
}

function runFileContext(context: RunnerContext, request: FileContextRequest): FileContextResult {
	const { relativePath, project } = request;
	const rows = queryRows(context, request);
	if (rows === null) return { continue: true };
	if (rows.length === 0) {
		context.log?.(
			`file_context.skip reason=no_observations path=${JSON.stringify(relativePath)} project=${JSON.stringify(project ?? "")}`,
		);
		recordAttempt(context, {
			retrievalStatus: "no_results",
			deliveryStatus: "not_attempted",
			project,
			filters: project ? { project } : undefined,
			repositoryPaths: [relativePath],
		});
		return { continue: true };
	}
	const top = scoreAndDedupe(rows, relativePath);
	if (top.length === 0) {
		context.log?.(
			`file_context.skip reason=no_top_after_dedupe path=${JSON.stringify(relativePath)} candidates=${rows.length}`,
		);
		recordSelection(context, request, rows, top);
		return { continue: true };
	}
	const staleness = fileStaleness(top, request.fileMtimeMs);
	recordSelection(context, request, rows, top);
	return deliverContext(context, request, rows, top, staleness);
}

/**
 * One Claude file-context attempt. Callers apply environment/path/stat guards,
 * then call skip() for a rejected read or run() for an eligible file.
 * Selection is recorded before formatting; successful formatting marks handoff
 * before returning, preserving the CLI contract. This runner never closes the store.
 */
export function createFileContextRunner(options: FileContextRunnerOptions) {
	const context: RunnerContext = {
		...options,
		startedAt: (options.now ?? (() => new Date()))(),
		attemptId: (options.createAttemptId ?? randomUUID)(),
	};
	return {
		skip(input: FileContextSkip): FileContextResult {
			recordAttempt(context, {
				retrievalStatus: "skipped",
				deliveryStatus: "not_attempted",
				failureCode: input.reason,
				failureStage: SKIP_STAGES[input.reason],
				...(input.repositoryPaths ? { repositoryPaths: input.repositoryPaths } : {}),
			});
			return { continue: true };
		},
		run: (request: FileContextRequest): FileContextResult => runFileContext(context, request),
	};
}
