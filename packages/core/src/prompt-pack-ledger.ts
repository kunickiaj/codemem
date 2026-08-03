import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { Database } from "./db.js";
import { estimateTokens, type PackArtifacts } from "./pack.js";
import { sanitizeSearchQuery } from "./query-sanitizer.js";
import {
	getRetrievalAttempt,
	hashRetrievalQuery,
	MAX_RETRIEVAL_DIAGNOSTIC_EXPOSURES,
	MAX_RETRIEVAL_SELECTED_EXPOSURES,
	type RecordRetrievalAttemptInput,
	type RetrievalExposureInput,
	type RetrievalLedgerWriteOutcome,
	tryRecordRetrievalAttempt,
} from "./retrieval-ledger.js";
import type { MemoryFilters, PackTraceCandidate } from "./types.js";

export const PROMPT_PACK_RECORDER_VERSION = "opencode-prompt-pack-v1";
const MAX_PROMPT_PACK_WORKING_SET_FILES = 50;
const MAX_PROMPT_PACK_WORKING_SET_PATH_CHARS = 512;
const MAX_PROMPT_PACK_WORKING_SET_JSON_BYTES = 8 * 1024;

export interface PromptPackAttemptMetadata {
	attemptId: string;
	startedAt: string;
	completedAt: string;
	source?: string | null;
	streamId?: string | null;
	sourceSessionId?: string | null;
	promptNumber?: number | null;
	requestId?: string | null;
	recorderVersion?: string;
}

type MemorySnapshot = {
	id: number;
	import_key: string | null;
	origin_device_id: string | null;
	rev: number;
	updated_at: string;
	scope_id: string | null;
	kind: string;
	active: number;
	deleted_at: string | null;
};

function isAbsolutePath(value: string): boolean {
	return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function safeIdentity(value: string | null | undefined): string | null {
	return value && value.length <= 512 && !isAbsolutePath(value) ? value : null;
}

function latencyMs(metadata: PromptPackAttemptMetadata): number | null {
	const started = Date.parse(metadata.startedAt);
	const completed = Date.parse(metadata.completedAt);
	if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
	return Math.trunc(completed - started);
}

function workingSetFiles(filters?: MemoryFilters): string[] | null {
	const normalized: string[] = [];
	for (const value of filters?.working_set_paths ?? []) {
		if (normalized.length >= MAX_PROMPT_PACK_WORKING_SET_FILES) break;
		const trimmed = value.trim();
		if (
			!trimmed ||
			trimmed.length > MAX_PROMPT_PACK_WORKING_SET_PATH_CHARS ||
			isAbsolutePath(trimmed)
		) {
			continue;
		}
		const relative = posix.normalize(trimmed.replaceAll("\\", "/")).replace(/^\.\//, "");
		if (!relative || relative === ".." || relative.startsWith("../") || isAbsolutePath(relative)) {
			continue;
		}
		if (
			!normalized.includes(relative) &&
			Buffer.byteLength(JSON.stringify([...normalized, relative]), "utf8") <=
				MAX_PROMPT_PACK_WORKING_SET_JSON_BYTES
		) {
			normalized.push(relative);
		}
	}
	return normalized.length > 0 ? normalized : null;
}

function retryTiming(
	db: Database,
	metadata: PromptPackAttemptMetadata,
	fallbackLatencyMs = latencyMs(metadata),
): { startedAt: string; completedAt: string; latencyMs: number | null } {
	let existing: { started_at: string; completed_at: string; latency_ms: number | null } | undefined;
	try {
		existing = db
			.prepare(
				"SELECT started_at, completed_at, latency_ms FROM retrieval_attempts WHERE attempt_id = ?",
			)
			.get(metadata.attemptId) as typeof existing;
	} catch {
		existing = undefined;
	}
	return existing
		? {
				startedAt: existing.started_at,
				completedAt: existing.completed_at,
				latencyMs: existing.latency_ms,
			}
		: {
				startedAt: metadata.startedAt,
				completedAt: metadata.completedAt,
				latencyMs: fallbackLatencyMs,
			};
}

function snapshots(db: Database, ids: number[]): Map<number, MemorySnapshot> {
	if (ids.length === 0) return new Map();
	const placeholders = ids.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT id, import_key, origin_device_id, rev, updated_at, scope_id, kind, active, deleted_at
			 FROM memory_items WHERE id IN (${placeholders})`,
		)
		.all(...ids) as MemorySnapshot[];
	return new Map(rows.map((row) => [row.id, row]));
}

function reasonCodes(candidate: PackTraceCandidate): string[] {
	const codes = [`disposition.${candidate.disposition}`];
	if (candidate.section) codes.push(`section.${candidate.section}`);
	if (candidate.scores.text_overlap > 0) codes.push("match.text");
	if (candidate.scores.tag_overlap > 0) codes.push("match.tag");
	if (candidate.scores.working_set_overlap > 0) codes.push("match.working_set");
	if (candidate.scores.query_path_overlap > 0) codes.push("match.query_path");
	return codes;
}

function exposures(db: Database, artifacts: PackArtifacts): RetrievalExposureInput[] {
	const candidates = [
		...artifacts.trace.retrieval.candidates
			.filter((candidate) => candidate.disposition === "selected")
			.slice(0, MAX_RETRIEVAL_SELECTED_EXPOSURES),
		...artifacts.trace.retrieval.candidates
			.filter((candidate) => candidate.disposition !== "selected")
			.slice(0, MAX_RETRIEVAL_DIAGNOSTIC_EXPOSURES),
	].sort((left, right) => left.rank - right.rank);
	const byId = snapshots(
		db,
		candidates.map((candidate) => candidate.id),
	);
	return candidates.map((candidate) => {
		const snapshot = byId.get(candidate.id);
		return {
			memoryId: snapshot?.id ?? null,
			memoryImportKey: safeIdentity(snapshot?.import_key),
			originDeviceId: safeIdentity(snapshot?.origin_device_id),
			rank: candidate.rank,
			disposition: candidate.disposition,
			section: candidate.section,
			handoffStatus: "not_attempted",
			memoryRev: snapshot?.rev ?? null,
			memoryUpdatedAt: snapshot?.updated_at ?? null,
			memoryScopeId: safeIdentity(snapshot?.scope_id),
			memoryKind: snapshot?.kind ?? candidate.kind,
			memoryActive: snapshot == null ? null : snapshot.active === 1,
			memoryDeletedAt: snapshot?.deleted_at ?? null,
			scoreSummary: candidate.scores,
			reasonCodes: reasonCodes(candidate),
		};
	});
}

function filterSummary(filters?: MemoryFilters): Omit<MemoryFilters, "working_set_paths"> {
	if (!filters) return {};
	const output: Record<string, unknown> = { ...filters };
	delete output.working_set_paths;
	for (const [key, value] of Object.entries(output)) {
		if (typeof value === "string" && isAbsolutePath(value)) {
			delete output[key];
		} else if (Array.isArray(value)) {
			output[key] = value.filter((item) => typeof item !== "string" || !isAbsolutePath(item));
		}
	}
	return output as unknown as Omit<MemoryFilters, "working_set_paths">;
}

function promptPackArtifactFields(
	db: Database,
	query: string,
	filters: MemoryFilters | undefined,
	artifacts: PackArtifacts,
) {
	const sanitizedQuery = sanitizeSearchQuery(query).clean_query;
	const queryIdentity = hashRetrievalQuery(sanitizedQuery);
	return {
		retrievalStatus:
			artifacts.trace.retrieval.candidate_count === 0
				? ("no_results" as const)
				: ("succeeded" as const),
		candidateCount: artifacts.trace.retrieval.candidate_count,
		selectedCount: artifacts.trace.retrieval.candidates.filter(
			(candidate) => candidate.disposition === "selected",
		).length,
		project: safeIdentity(filters?.project),
		scopeId: safeIdentity(typeof filters?.scope_id === "string" ? filters.scope_id : null),
		mode: artifacts.trace.mode.selected,
		limitRequested: artifacts.trace.inputs.limit,
		tokenBudget: artifacts.trace.inputs.token_budget,
		outputTokens: artifacts.trace.output.estimated_tokens,
		workingSetFileCount: Math.min(
			filters?.working_set_paths?.length ?? 0,
			MAX_PROMPT_PACK_WORKING_SET_FILES,
		),
		workingSetFiles: workingSetFiles(filters),
		queryHashSha256: queryIdentity.queryHashSha256,
		queryCharCount: queryIdentity.queryCharCount,
		queryTokenEstimate: estimateTokens(sanitizedQuery),
		filterSummary: filterSummary(filters),
		traceVersion: artifacts.trace.version,
		exposures: exposures(db, artifacts),
	};
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, current: unknown) => {
		if (current == null || typeof current !== "object" || Array.isArray(current)) return current;
		return Object.fromEntries(
			Object.entries(current as Record<string, unknown>).toSorted(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			),
		);
	});
}

export function promptPackArtifactFingerprint(
	db: Database,
	query: string,
	filters: MemoryFilters | undefined,
	artifacts: PackArtifacts,
): string {
	const fingerprintArtifact = {
		ledger: promptPackArtifactFields(db, query, filters, artifacts),
		packTextHashSha256: createHash("sha256").update(artifacts.response.pack_text).digest("hex"),
	};
	return createHash("sha256").update(canonicalJson(fingerprintArtifact)).digest("hex");
}

export function recordPromptPackArtifacts(
	db: Database,
	metadata: PromptPackAttemptMetadata,
	query: string,
	filters: MemoryFilters | undefined,
	artifacts: PackArtifacts,
): RetrievalLedgerWriteOutcome {
	try {
		const artifactFields = promptPackArtifactFields(db, query, filters, artifacts);
		const timing = retryTiming(db, metadata);
		return tryRecordRetrievalAttempt(db, {
			...metadata,
			...artifactFields,
			startedAt: timing.startedAt,
			completedAt: timing.completedAt,
			surface: "prompt_pack",
			trigger: "automatic",
			deliveryStatus: "not_attempted",
			latencyMs: timing.latencyMs,
			recorderVersion: metadata.recorderVersion ?? PROMPT_PACK_RECORDER_VERSION,
		});
	} catch {
		return {
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "storage_unavailable",
		};
	}
}

export function recordPromptPackTerminal(
	db: Database,
	metadata: PromptPackAttemptMetadata,
	status: "skipped" | "failed",
	failureCode: string,
	failureStage: string,
): RetrievalLedgerWriteOutcome {
	const timing = retryTiming(db, metadata);
	return tryRecordRetrievalAttempt(db, {
		...metadata,
		startedAt: timing.startedAt,
		completedAt: timing.completedAt,
		surface: "prompt_pack",
		trigger: "automatic",
		retrievalStatus: status,
		deliveryStatus: "not_attempted",
		candidateCount: 0,
		selectedCount: 0,
		latencyMs: timing.latencyMs,
		recorderVersion: metadata.recorderVersion ?? PROMPT_PACK_RECORDER_VERSION,
		failureCode,
		failureStage,
		exposures: [],
	});
}

export function clonePromptPackAttempt(
	db: Database,
	originalAttemptId: string,
	metadata: PromptPackAttemptMetadata,
): RetrievalLedgerWriteOutcome {
	const cacheRequestId = metadata.requestId
		? `cache_reuse:${metadata.requestId.slice(0, 400)}:from:${originalAttemptId}`
		: `cache_reuse:from:${originalAttemptId}`;
	let original: ReturnType<typeof getRetrievalAttempt>;
	try {
		original = getRetrievalAttempt(db, originalAttemptId);
	} catch {
		return {
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "invalid_input",
		};
	}
	if (!original) {
		return {
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "attempt_not_found",
		};
	}
	const clonedExposures: RetrievalExposureInput[] = original.exposures.map((exposure) => ({
		memoryId: exposure.memoryId,
		memoryImportKey: exposure.memoryImportKey,
		originDeviceId: exposure.originDeviceId,
		rank: exposure.rank,
		disposition: exposure.disposition,
		section: exposure.section,
		handoffStatus: "not_attempted",
		memoryRev: exposure.memoryRev,
		memoryUpdatedAt: exposure.memoryUpdatedAt,
		memoryScopeId: exposure.memoryScopeId,
		memoryKind: exposure.memoryKind,
		memoryActive: exposure.memoryActive,
		memoryDeletedAt: exposure.memoryDeletedAt,
		scoreSummary: exposure.scoreSummary,
		reasonCodes: exposure.reasonCodes,
	}));
	const timing = retryTiming(db, metadata, 0);
	const input: RecordRetrievalAttemptInput = {
		...metadata,
		startedAt: timing.startedAt,
		completedAt: timing.completedAt,
		surface: "prompt_pack",
		trigger: "automatic",
		retrievalStatus: original.retrievalStatus,
		deliveryStatus: "not_attempted",
		candidateCount: original.candidateCount,
		selectedCount: original.selectedCount,
		recorderVersion: metadata.recorderVersion ?? PROMPT_PACK_RECORDER_VERSION,
		source: metadata.source ?? original.source,
		streamId: metadata.streamId ?? original.streamId,
		sourceSessionId: metadata.sourceSessionId ?? original.sourceSessionId,
		promptNumber: metadata.promptNumber ?? original.promptNumber,
		requestId: cacheRequestId,
		latencyMs: timing.latencyMs,
		project: original.project,
		scopeId: original.scopeId,
		mode: original.mode,
		limitRequested: original.limitRequested,
		tokenBudget: original.tokenBudget,
		outputTokens: original.outputTokens,
		workingSetFileCount: original.workingSetFileCount,
		workingSetFiles: original.workingSetFiles,
		queryHashSha256: original.queryHashSha256,
		queryCharCount: original.queryCharCount,
		queryTokenEstimate: original.queryTokenEstimate,
		filterSummary: original.filterSummary,
		traceVersion: original.traceVersion,
		exposures: clonedExposures,
	};
	return tryRecordRetrievalAttempt(db, input);
}
