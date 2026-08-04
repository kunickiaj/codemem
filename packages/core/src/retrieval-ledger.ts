import { createHash } from "node:crypto";
import { isAbsolute, posix, win32 } from "node:path";
import type { Database } from "./db.js";
import type { MemoryFilters, PackTraceCandidateScores, PackTraceSection } from "./types.js";

export const RETRIEVAL_LEDGER_CONTRACT_VERSION = 1 as const;
export const DEFAULT_RETRIEVAL_LEDGER_RETENTION_DAYS = 90;
export const MAX_RETRIEVAL_SELECTED_EXPOSURES = 50;
export const MAX_RETRIEVAL_DIAGNOSTIC_EXPOSURES = 20;
export const MAX_RETRIEVAL_JSON_BYTES = 16 * 1024;
export const DEFAULT_RETRIEVAL_QUERY_LIMIT = 50;
export const MAX_RETRIEVAL_QUERY_LIMIT = 100;

export type RetrievalSurface =
	| "prompt_pack"
	| "file_context"
	| "mcp_search"
	| "mcp_search_index"
	| "mcp_pack"
	| "mcp_get"
	| "mcp_get_observations"
	| "mcp_recent"
	| "mcp_timeline"
	| "mcp_expand"
	| "mcp_explain"
	| "evaluation_replay";
export type RetrievalTrigger = "automatic" | "explicit" | "evaluation";
export type RetrievalStatus = "succeeded" | "no_results" | "skipped" | "failed" | "unknown";
export type RetrievalDeliveryStatus = "not_attempted" | "handed_off" | "failed" | "unknown";
export type RetrievalDisposition = "selected" | "dropped" | "deduped" | "trimmed" | "compressed";

export type RetrievalFilterSummary = Omit<MemoryFilters, "working_set_paths">;
export type RetrievalScoreSummary = Partial<PackTraceCandidateScores>;

export interface RetrievalExposureInput {
	memoryId?: number | null;
	memoryImportKey?: string | null;
	originDeviceId?: string | null;
	rank: number;
	disposition: RetrievalDisposition;
	section?: PackTraceSection | null;
	handoffStatus: RetrievalDeliveryStatus;
	memoryRev?: number | null;
	memoryUpdatedAt?: string | null;
	memoryScopeId?: string | null;
	memoryKind?: string | null;
	memoryActive?: boolean | null;
	memoryDeletedAt?: string | null;
	scoreSummary?: RetrievalScoreSummary | null;
	reasonCodes?: string[] | null;
}

export interface RecordRetrievalAttemptInput {
	attemptId: string;
	surface: RetrievalSurface;
	trigger: RetrievalTrigger;
	startedAt: string;
	completedAt?: string | null;
	retrievalStatus: RetrievalStatus;
	deliveryStatus: RetrievalDeliveryStatus;
	candidateCount: number;
	selectedCount: number;
	recorderVersion: string;
	sessionId?: number | null;
	source?: string | null;
	streamId?: string | null;
	sourceSessionId?: string | null;
	promptNumber?: number | null;
	requestId?: string | null;
	rawEventStartSeq?: number | null;
	rawEventEndSeq?: number | null;
	experimentId?: string | null;
	experimentCellId?: string | null;
	evaluationCheckoutId?: string | null;
	evaluationFixtureId?: string | null;
	evaluationSeed?: number | null;
	latencyMs?: number | null;
	project?: string | null;
	scopeId?: string | null;
	mode?: string | null;
	limitRequested?: number | null;
	tokenBudget?: number | null;
	outputTokens?: number | null;
	workingSetFileCount?: number | null;
	workingSetFiles?: string[] | null;
	queryHashSha256?: string | null;
	queryCharCount?: number | null;
	queryTokenEstimate?: number | null;
	filterSummary?: RetrievalFilterSummary | null;
	failureCode?: string | null;
	failureStage?: string | null;
	traceVersion?: number | null;
	retentionDays?: number;
	retentionPinned?: boolean;
	exposures: RetrievalExposureInput[];
}

export interface RetrievalAttemptRecord {
	attemptId: string;
	contractVersion: typeof RETRIEVAL_LEDGER_CONTRACT_VERSION;
	surface: RetrievalSurface;
	trigger: RetrievalTrigger;
	startedAt: string;
	completedAt: string | null;
	retrievalStatus: RetrievalStatus;
	deliveryStatus: RetrievalDeliveryStatus;
	candidateCount: number;
	selectedCount: number;
	persistedCandidateCount: number;
	recorderVersion: string;
	sessionId: number | null;
	source: string | null;
	streamId: string | null;
	sourceSessionId: string | null;
	promptNumber: number | null;
	requestId: string | null;
	rawEventStartSeq: number | null;
	rawEventEndSeq: number | null;
	experimentId: string | null;
	experimentCellId: string | null;
	evaluationCheckoutId: string | null;
	evaluationFixtureId: string | null;
	evaluationSeed: number | null;
	latencyMs: number | null;
	project: string | null;
	scopeId: string | null;
	mode: string | null;
	limitRequested: number | null;
	tokenBudget: number | null;
	outputTokens: number | null;
	workingSetFileCount: number | null;
	workingSetFiles: string[] | null;
	queryHashSha256: string | null;
	queryCharCount: number | null;
	queryTokenEstimate: number | null;
	filterSummary: RetrievalFilterSummary | null;
	failureCode: string | null;
	failureStage: string | null;
	traceVersion: number | null;
	retentionUntil: string | null;
	retentionPinned: boolean;
	retentionFinalizedAt: string | null;
	exposures: RetrievalExposureRecord[];
}

export interface RetrievalExposureRecord extends RetrievalExposureInput {
	exposureId: number;
	attemptId: string;
}

export interface RetrievalWriteResult {
	attempt: RetrievalAttemptRecord;
	inserted: boolean;
}

export interface QueryRetrievalAttemptsInput {
	sessionId?: number;
	source?: string;
	streamId?: string;
	surface?: RetrievalSurface;
	startedAtOrAfter?: string;
	startedAtOrBefore?: string;
	limit?: number;
}

export interface FinalizeRetrievalAttemptRetentionInput {
	finalizedAt: string;
	retentionDays?: number;
}

export type RetrievalLedgerWriteOutcome =
	| { ok: true; value: RetrievalWriteResult }
	| {
			ok: false;
			errorCode: "retrieval_ledger_write_failed";
			reason: RetrievalLedgerFailureReason;
	  };

export type RetrievalLedgerDeliveryOutcome =
	| { ok: true; value: { changed: boolean; attempt: RetrievalAttemptRecord } }
	| {
			ok: false;
			errorCode: "retrieval_ledger_delivery_write_failed";
			reason: RetrievalLedgerFailureReason;
	  };

export type RetrievalLedgerRetentionOutcome =
	| { ok: true; value: { changed: boolean; attempt: RetrievalAttemptRecord } }
	| {
			ok: false;
			errorCode: "retrieval_ledger_retention_write_failed";
			reason: RetrievalLedgerFailureReason;
	  };

export type RetrievalLedgerFailureReason =
	| "invalid_input"
	| "idempotency_conflict"
	| "attempt_not_found"
	| "storage_unavailable";

const FILTER_KEY_ORDER = [
	"kind",
	"session_id",
	"since",
	"project",
	"scope_id",
	"include_scope_ids",
	"exclude_scope_ids",
	"visibility",
	"include_visibility",
	"exclude_visibility",
	"include_workspace_ids",
	"exclude_workspace_ids",
	"include_workspace_kinds",
	"exclude_workspace_kinds",
	"include_actor_ids",
	"exclude_actor_ids",
	"include_trust_states",
	"exclude_trust_states",
	"ownership_scope",
	"personal_first",
	"trust_bias",
	"widen_shared_when_weak",
	"widen_shared_min_personal_results",
	"widen_shared_min_personal_score",
	"widen_project_when_weak",
	"widen_project_min_results",
	"widen_project_min_score",
	"widen_project_max_results",
] as const satisfies readonly (keyof RetrievalFilterSummary)[];
const FILTER_KEYS = new Set<string>(FILTER_KEY_ORDER);

const SCORE_KEY_ORDER = [
	"base_score",
	"combined_score",
	"recency",
	"kind_bonus",
	"quality_boost",
	"role_adjustment",
	"working_set_overlap",
	"query_path_overlap",
	"personal_bias",
	"shared_trust_penalty",
	"recap_penalty",
	"tasklike_penalty",
	"text_overlap",
	"tag_overlap",
] as const satisfies readonly (keyof RetrievalScoreSummary)[];
const SCORE_KEYS = new Set<string>(SCORE_KEY_ORDER);
const NULLABLE_SCORE_KEYS = new Set<string>(["base_score", "combined_score"]);

const RETRIEVAL_SURFACES = new Set<RetrievalSurface>([
	"prompt_pack",
	"file_context",
	"mcp_search",
	"mcp_search_index",
	"mcp_pack",
	"mcp_get",
	"mcp_get_observations",
	"mcp_recent",
	"mcp_timeline",
	"mcp_expand",
	"mcp_explain",
	"evaluation_replay",
]);

const RETRIEVAL_DISPOSITIONS = new Set<RetrievalDisposition>([
	"selected",
	"dropped",
	"deduped",
	"trimmed",
	"compressed",
]);

const RETRIEVAL_SECTIONS = new Set<PackTraceSection>(["summary", "timeline", "observations"]);

type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

class RetrievalLedgerValidationError extends Error {}

function requiredString(value: string, name: string, max = 512): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) {
		throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
	}
	return value;
}

function optionalString(value: string | null | undefined, name: string, max = 512): string | null {
	return value == null ? null : requiredString(value, name, max);
}

function optionalStableId(value: unknown, name: string): string | null {
	if (value == null) return null;
	if (typeof value !== "string") {
		throw new RetrievalLedgerValidationError(`${name} must be a string when provided`);
	}
	if (!/^[a-z0-9][a-z0-9._:/@+~-]{0,127}$/i.test(value)) {
		throw new Error(`${name} must be a bounded stable identifier`);
	}
	return value;
}

function nonNegativeInteger(value: number | null | undefined, name: string): number | null {
	if (value == null) return null;
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error(`${name} must be a non-negative integer`);
	return value;
}

function optionalBoolean(value: unknown, name: string): boolean {
	if (value === undefined) return false;
	if (typeof value !== "boolean")
		throw new RetrievalLedgerValidationError(`${name} must be a boolean when provided`);
	return value;
}

function nullableBooleanInteger(value: unknown, name: string): number | null {
	if (value == null) return null;
	if (typeof value !== "boolean")
		throw new RetrievalLedgerValidationError(`${name} must be a boolean or null`);
	return value ? 1 : 0;
}

function decodeNullableBooleanInteger(value: unknown): boolean | null {
	if (value === 0) return false;
	if (value === 1) return true;
	return null;
}

function positiveInteger(value: number, name: string, maximum?: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || (maximum != null && value > maximum)) {
		const range = maximum == null ? "a positive integer" : `an integer from 1 through ${maximum}`;
		throw new Error(`${name} must be ${range}`);
	}
	return value;
}

function isoTimestamp(value: string | null | undefined, name: string): string | null {
	if (value == null) return null;
	if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
		throw new Error(`${name} must be an ISO-8601 timestamp`);
	}
	return new Date(value).toISOString();
}

function boundedJson(value: unknown, name: string): string {
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json, "utf8") > MAX_RETRIEVAL_JSON_BYTES) {
		throw new Error(`${name} exceeds ${MAX_RETRIEVAL_JSON_BYTES} bytes`);
	}
	return json;
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
}

function serializeFilterSummary(input: RetrievalFilterSummary | null | undefined): string | null {
	if (input == null) return null;
	if (!isPlainObjectRecord(input)) {
		throw new RetrievalLedgerValidationError(
			"filterSummary must be a plain object record when provided",
		);
	}
	const definedEntries: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (!FILTER_KEYS.has(key)) {
			throw new RetrievalLedgerValidationError(`filterSummary contains unsupported key: ${key}`);
		}
		if (value !== undefined) definedEntries[key] = value;
	}
	if (!isRetrievalFilterSummary(definedEntries)) {
		throw new RetrievalLedgerValidationError("filterSummary contains an invalid value shape");
	}
	const output: Record<string, string | number | boolean | Array<string | number | boolean>> = {};
	for (const key of FILTER_KEY_ORDER) {
		const value = definedEntries[key];
		if (value !== undefined) {
			output[key] = value as string | number | boolean | Array<string | number | boolean>;
		}
	}
	return boundedJson(output, "filterSummary");
}

function serializeScoreSummary(input: RetrievalScoreSummary | null | undefined): string | null {
	if (input == null) return null;
	if (!isPlainObjectRecord(input)) {
		throw new RetrievalLedgerValidationError("scoreSummary contains an invalid value shape");
	}
	const definedEntries: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (!SCORE_KEYS.has(key)) {
			throw new RetrievalLedgerValidationError(`scoreSummary contains unsupported key: ${key}`);
		}
		if (value === undefined) continue;
		if (!isValidScoreSummaryEntry(key, value)) {
			const expected = NULLABLE_SCORE_KEYS.has(key) ? "a finite number or null" : "a finite number";
			throw new RetrievalLedgerValidationError(`scoreSummary.${key} must be ${expected}`);
		}
		definedEntries[key] = value;
	}
	if (!isRetrievalScoreSummary(definedEntries)) {
		throw new RetrievalLedgerValidationError("scoreSummary contains an invalid value shape");
	}
	const output: Record<string, number | null> = {};
	for (const key of SCORE_KEY_ORDER) {
		const value = definedEntries[key];
		if (value !== undefined) output[key] = value as number | null;
	}
	return boundedJson(output, "scoreSummary");
}

function serializeReasonCodes(input: string[] | null | undefined): string | null {
	if (input == null) return null;
	if (!Array.isArray(input)) {
		throw new RetrievalLedgerValidationError("reasonCodes must be an array when provided");
	}
	if (input.length > 20) throw new Error("reasonCodes exceeds 20 values");
	const values = input.map((code) => {
		if (typeof code !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(code)) {
			throw new Error("reasonCodes must contain actual strings with bounded stable codes");
		}
		return code;
	});
	return boundedJson(values, "reasonCodes");
}

function serializeWorkingSetFiles(input: string[] | null | undefined): string | null {
	if (input == null) return null;
	if (!Array.isArray(input) || !input.every((path) => typeof path === "string")) {
		throw new RetrievalLedgerValidationError("workingSetFiles must be an array of strings");
	}
	if (input.length > 50) throw new Error("workingSetFiles exceeds 50 paths");
	const paths = input.map((path) => {
		const normalized = posix.normalize(
			requiredString(path.replaceAll("\\", "/"), "workingSetFiles", 1024),
		);
		if (
			isAbsolute(path) ||
			win32.isAbsolute(path) ||
			normalized === ".." ||
			normalized.startsWith("../")
		) {
			throw new Error("workingSetFiles must contain repository-relative paths");
		}
		return normalized.replace(/^\.\//, "");
	});
	return boundedJson(paths, "workingSetFiles");
}

function retentionUntil(
	startedAt: string,
	days: number | undefined,
	pinned: boolean,
): string | null {
	const retentionDays = days === undefined ? DEFAULT_RETRIEVAL_LEDGER_RETENTION_DAYS : days;
	if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 365) {
		throw new Error("retentionDays must be an integer from 7 through 365");
	}
	if (pinned) return null;
	return new Date(Date.parse(startedAt) + retentionDays * 86_400_000).toISOString();
}

function insertRow(db: Database, table: string, row: SqlRow): void {
	const columns = Object.keys(row);
	const placeholders = columns.map((column) => `@${column}`);
	db.prepare(
		`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
	).run(row);
}

function canonicalAttempt(input: RecordRetrievalAttemptInput): SqlRow {
	const startedAt = isoTimestamp(input.startedAt, "startedAt") as string;
	const completedAt = isoTimestamp(input.completedAt, "completedAt");
	if (completedAt && Date.parse(completedAt) < Date.parse(startedAt)) {
		throw new Error("completedAt cannot precede startedAt");
	}
	if (
		!(["succeeded", "no_results", "skipped", "failed", "unknown"] as string[]).includes(
			input.retrievalStatus,
		)
	) {
		throw new Error("retrievalStatus is invalid");
	}
	if (!RETRIEVAL_SURFACES.has(input.surface)) {
		throw new Error("surface is invalid for contract version 1");
	}
	if (!("automatic explicit evaluation".split(" ") as string[]).includes(input.trigger)) {
		throw new Error("trigger is invalid");
	}
	if (
		!(["not_attempted", "handed_off", "failed", "unknown"] as string[]).includes(
			input.deliveryStatus,
		)
	) {
		throw new Error("deliveryStatus is invalid");
	}
	const candidateCount = nonNegativeInteger(input.candidateCount, "candidateCount") as number;
	const selectedCount = nonNegativeInteger(input.selectedCount, "selectedCount") as number;
	assertFailedRetrievalInvariant(
		input.retrievalStatus,
		input.deliveryStatus,
		selectedCount,
		input.exposures.length,
	);
	assertDeliverySelectionInvariant(input.deliveryStatus, selectedCount);
	if (input.retrievalStatus === "succeeded" && candidateCount === 0) {
		throw new RetrievalLedgerValidationError(
			"succeeded retrieval requires at least one candidate; use no_results for an empty completion",
		);
	}
	if (selectedCount > candidateCount) throw new Error("selectedCount cannot exceed candidateCount");
	if (input.exposures.length > candidateCount) {
		throw new Error("persisted exposures cannot exceed candidateCount");
	}
	if (
		(input.retrievalStatus === "no_results" || input.retrievalStatus === "skipped") &&
		(candidateCount !== 0 ||
			selectedCount !== 0 ||
			input.exposures.length !== 0 ||
			input.deliveryStatus !== "not_attempted")
	) {
		throw new Error(
			`${input.retrievalStatus} requires zero candidates, zero selections, no exposures, and no delivery attempt`,
		);
	}
	const evaluationCheckoutId = optionalStableId(input.evaluationCheckoutId, "evaluationCheckoutId");
	const evaluationFixtureId = optionalStableId(input.evaluationFixtureId, "evaluationFixtureId");
	const evaluationSeed = nonNegativeInteger(input.evaluationSeed, "evaluationSeed");
	const retentionPinned = optionalBoolean(input.retentionPinned, "retentionPinned");
	if (input.surface === "evaluation_replay") {
		if (input.trigger !== "evaluation") {
			throw new Error("evaluation_replay requires the evaluation trigger");
		}
		if (input.experimentId == null) throw new Error("evaluation_replay requires experimentId");
		if (input.experimentCellId == null) {
			throw new Error("evaluation_replay requires experimentCellId");
		}
		if ((evaluationCheckoutId == null) === (evaluationFixtureId == null)) {
			throw new Error("evaluation_replay requires exactly one checkout or fixture identity");
		}
		if (evaluationSeed == null) {
			throw new Error("evaluation_replay requires evaluationSeed");
		}
	} else if (
		evaluationCheckoutId != null ||
		evaluationFixtureId != null ||
		evaluationSeed != null
	) {
		throw new Error("evaluation replay fields require the evaluation_replay surface");
	}
	if (input.streamId != null && input.source == null) {
		throw new RetrievalLedgerValidationError("source is required when streamId is provided");
	}
	if (input.requestId != null && input.source == null) {
		throw new Error("source is required when requestId is provided");
	}
	if (retentionPinned && input.experimentId == null) {
		throw new Error("retention pinning requires a named experiment");
	}
	if (
		input.rawEventStartSeq != null &&
		input.rawEventEndSeq != null &&
		input.rawEventEndSeq < input.rawEventStartSeq
	) {
		throw new Error("rawEventEndSeq cannot precede rawEventStartSeq");
	}
	return {
		attempt_id: validateUuid(input.attemptId, "attemptId"),
		contract_version: RETRIEVAL_LEDGER_CONTRACT_VERSION,
		surface: requiredString(input.surface, "surface", 128),
		trigger: requiredString(input.trigger, "trigger", 128),
		started_at: startedAt,
		completed_at: completedAt,
		retrieval_status: input.retrievalStatus,
		delivery_status: input.deliveryStatus,
		candidate_count: candidateCount,
		selected_count: selectedCount,
		persisted_candidate_count: input.exposures.length,
		recorder_version: requiredString(input.recorderVersion, "recorderVersion", 128),
		session_id: nonNegativeInteger(input.sessionId, "sessionId"),
		source: optionalString(input.source, "source", 128),
		stream_id: optionalString(input.streamId, "streamId"),
		source_session_id: optionalString(input.sourceSessionId, "sourceSessionId"),
		prompt_number: nonNegativeInteger(input.promptNumber, "promptNumber"),
		request_id: optionalString(input.requestId, "requestId"),
		raw_event_start_seq: nonNegativeInteger(input.rawEventStartSeq, "rawEventStartSeq"),
		raw_event_end_seq: nonNegativeInteger(input.rawEventEndSeq, "rawEventEndSeq"),
		experiment_id: optionalString(input.experimentId, "experimentId", 128),
		experiment_cell_id: optionalString(input.experimentCellId, "experimentCellId", 128),
		evaluation_checkout_id: evaluationCheckoutId,
		evaluation_fixture_id: evaluationFixtureId,
		evaluation_seed: evaluationSeed,
		latency_ms: nonNegativeInteger(input.latencyMs, "latencyMs"),
		project: optionalString(input.project, "project", 1024),
		scope_id: optionalString(input.scopeId, "scopeId"),
		mode: optionalString(input.mode, "mode", 64),
		limit_requested: nonNegativeInteger(input.limitRequested, "limitRequested"),
		token_budget: nonNegativeInteger(input.tokenBudget, "tokenBudget"),
		output_tokens: nonNegativeInteger(input.outputTokens, "outputTokens"),
		working_set_file_count: nonNegativeInteger(input.workingSetFileCount, "workingSetFileCount"),
		working_set_files_json: serializeWorkingSetFiles(input.workingSetFiles),
		query_hash_sha256: input.queryHashSha256 == null ? null : validateSha256(input.queryHashSha256),
		query_char_count: nonNegativeInteger(input.queryCharCount, "queryCharCount"),
		query_token_estimate: nonNegativeInteger(input.queryTokenEstimate, "queryTokenEstimate"),
		filter_summary_json: serializeFilterSummary(input.filterSummary),
		failure_code: optionalString(input.failureCode, "failureCode", 128),
		failure_stage: optionalString(input.failureStage, "failureStage", 128),
		trace_version: nonNegativeInteger(input.traceVersion, "traceVersion"),
		retention_until: retentionUntil(startedAt, input.retentionDays, retentionPinned),
		retention_pinned: retentionPinned ? 1 : 0,
		retention_finalized_at: null,
	};
}

function canonicalExposures(input: RecordRetrievalAttemptInput, attemptId: string): SqlRow[] {
	const selected = input.exposures.filter((exposure) => exposure.disposition === "selected");
	const diagnostic = input.exposures.length - selected.length;
	if (selected.length > MAX_RETRIEVAL_SELECTED_EXPOSURES) {
		throw new Error(`selected exposures exceed ${MAX_RETRIEVAL_SELECTED_EXPOSURES}`);
	}
	if (diagnostic > MAX_RETRIEVAL_DIAGNOSTIC_EXPOSURES) {
		throw new Error(`diagnostic exposures exceed ${MAX_RETRIEVAL_DIAGNOSTIC_EXPOSURES}`);
	}
	const persistedSelectedCount = Math.min(input.selectedCount, MAX_RETRIEVAL_SELECTED_EXPOSURES);
	if (selected.length !== persistedSelectedCount) {
		throw new Error("selected exposure count must equal the bounded selectedCount");
	}
	const ranks = new Set<number>();
	const rows = input.exposures.map((exposure) => {
		const rank = nonNegativeInteger(exposure.rank, "exposure.rank") as number;
		if (rank === 0 || ranks.has(rank))
			throw new Error("exposure ranks must be unique positive integers");
		if (rank > input.candidateCount) {
			throw new Error("exposure.rank cannot exceed candidateCount");
		}
		ranks.add(rank);
		if (!RETRIEVAL_DISPOSITIONS.has(exposure.disposition)) {
			throw new Error("exposure disposition is invalid for contract version 1");
		}
		if (exposure.section != null && !RETRIEVAL_SECTIONS.has(exposure.section)) {
			throw new Error("exposure section is invalid for contract version 1");
		}
		if (exposure.disposition !== "selected" && exposure.handoffStatus !== "not_attempted") {
			throw new Error("diagnostic exposures cannot have a handoff status");
		}
		if (exposure.disposition === "selected" && exposure.handoffStatus !== input.deliveryStatus) {
			throw new Error("selected exposure handoff status must match the attempt delivery status");
		}
		return {
			attempt_id: attemptId,
			memory_id: nonNegativeInteger(exposure.memoryId, "exposure.memoryId"),
			memory_import_key: optionalString(exposure.memoryImportKey, "exposure.memoryImportKey"),
			origin_device_id: optionalString(exposure.originDeviceId, "exposure.originDeviceId"),
			rank,
			disposition: exposure.disposition,
			section: optionalString(exposure.section, "exposure.section", 128),
			handoff_status: exposure.handoffStatus,
			memory_rev: nonNegativeInteger(exposure.memoryRev, "exposure.memoryRev"),
			memory_updated_at: isoTimestamp(exposure.memoryUpdatedAt, "exposure.memoryUpdatedAt"),
			memory_scope_id: optionalString(exposure.memoryScopeId, "exposure.memoryScopeId"),
			memory_kind: optionalString(exposure.memoryKind, "exposure.memoryKind", 64),
			memory_active: nullableBooleanInteger(exposure.memoryActive, "exposure.memoryActive"),
			memory_deleted_at: isoTimestamp(exposure.memoryDeletedAt, "exposure.memoryDeletedAt"),
			score_summary_json: serializeScoreSummary(exposure.scoreSummary),
			reason_codes_json: serializeReasonCodes(exposure.reasonCodes),
		};
	});
	return rows.sort((left, right) => Number(left.rank) - Number(right.rank));
}

function rowsEqual(expected: SqlRow, actual: SqlRow, ignoredKeys: string[] = []): boolean {
	return Object.entries(expected).every(
		([key, value]) => ignoredKeys.includes(key) || actual[key] === value,
	);
}

function hasSameRetryRetentionPolicy(expected: SqlRow, existing: SqlRow): boolean {
	if (
		expected.retention_pinned !== existing.retention_pinned ||
		expected.retention_finalized_at !== existing.retention_finalized_at
	) {
		return false;
	}
	if (expected.retention_until == null || existing.retention_until == null) {
		return expected.retention_until === existing.retention_until;
	}
	if (
		typeof expected.retention_until !== "string" ||
		typeof existing.retention_until !== "string" ||
		typeof expected.started_at !== "string" ||
		typeof existing.started_at !== "string"
	) {
		return false;
	}
	const expectedDuration = Date.parse(expected.retention_until) - Date.parse(expected.started_at);
	const existingDuration = Date.parse(existing.retention_until) - Date.parse(existing.started_at);
	return Number.isFinite(expectedDuration) && expectedDuration === existingDuration;
}

function memoryIdentityMatchesExposure(
	exposure: SqlRow,
	memory: { import_key: string | null; origin_device_id: string | null },
): boolean {
	const exposureImportKey = exposure.memory_import_key;
	if (typeof exposureImportKey !== "string" || exposureImportKey.trim().length === 0) return false;
	if (memory.import_key == null || memory.import_key.trim().length === 0) return false;
	if (exposureImportKey !== memory.import_key) return false;

	const exposureOriginDeviceId = exposure.origin_device_id;
	if (typeof exposureOriginDeviceId !== "string" || exposureOriginDeviceId.trim().length === 0) {
		return true;
	}
	return (
		memory.origin_device_id != null &&
		memory.origin_device_id.trim().length > 0 &&
		exposureOriginDeviceId === memory.origin_device_id
	);
}

function isAllowedDeliveryTransition(
	previous: RetrievalDeliveryStatus,
	next: RetrievalDeliveryStatus,
): boolean {
	switch (previous) {
		case "not_attempted":
			return next === "handed_off" || next === "failed" || next === "unknown";
		case "failed":
			return next === "handed_off" || next === "unknown";
		case "unknown":
			return next === "handed_off" || next === "failed";
		case "handed_off":
			return false;
	}
}

function assertDeliverySelectionInvariant(
	deliveryStatus: RetrievalDeliveryStatus,
	selectedCount: number,
): void {
	if (deliveryStatus !== "not_attempted" && selectedCount === 0) {
		throw new RetrievalLedgerValidationError(
			"deliveryStatus requires selectedCount to be greater than zero unless delivery was not attempted",
		);
	}
}

function assertFailedRetrievalInvariant(
	retrievalStatus: RetrievalStatus,
	deliveryStatus: RetrievalDeliveryStatus,
	selectedCount: number,
	exposureCount: number,
): void {
	if (
		retrievalStatus === "failed" &&
		(selectedCount !== 0 || exposureCount !== 0 || deliveryStatus !== "not_attempted")
	) {
		throw new RetrievalLedgerValidationError(
			"failed retrieval requires zero selections, no exposures, and no delivery attempt",
		);
	}
}

function exposureRowsEqualAfterMemoryDeletion(
	db: Database,
	expected: SqlRow,
	actual: SqlRow,
	ignoredKeys: string[],
): boolean {
	if (rowsEqual(expected, actual, ignoredKeys)) return true;
	if (actual.memory_id !== null || typeof expected.memory_id !== "number") return false;
	if (!rowsEqual(expected, actual, [...ignoredKeys, "memory_id"])) return false;

	const memory = db
		.prepare(
			"SELECT active, deleted_at, import_key, origin_device_id FROM memory_items WHERE id = ?",
		)
		.get(expected.memory_id) as
		| {
				active: number;
				deleted_at: string | null;
				import_key: string | null;
				origin_device_id: string | null;
		  }
		| undefined;
	if (memory == null || memory.active === 0 || memory.deleted_at != null) return true;
	const expectedImportKey = expected.memory_import_key;
	if (typeof expectedImportKey !== "string" || expectedImportKey.trim().length === 0) return false;
	return !memoryIdentityMatchesExposure(expected, memory);
}

function parsePersistedJson(value: unknown): unknown | null {
	if (typeof value !== "string") return null;
	if (Buffer.byteLength(value, "utf8") > MAX_RETRIEVAL_JSON_BYTES) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed;
	} catch {
		return null;
	}
}

function decodeIsoTimestamp(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const normalized = isoTimestamp(value, "persisted timestamp");
		return normalized === value ? normalized : null;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isBoundedStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 50 && value.every(isBoundedString);
}

export function isValidRetrievalFilterSummaryEntry(key: string, entry: unknown): boolean {
	if (!FILTER_KEYS.has(key)) return false;
	switch (key) {
		case "kind":
		case "since":
		case "project":
		case "ownership_scope":
		case "trust_bias":
			return isBoundedString(entry);
		case "session_id":
		case "widen_shared_min_personal_results":
		case "widen_shared_min_personal_score":
		case "widen_project_min_results":
		case "widen_project_min_score":
		case "widen_project_max_results":
			return typeof entry === "number" && Number.isFinite(entry);
		case "scope_id":
		case "visibility":
			return isBoundedString(entry) || isBoundedStringList(entry);
		case "personal_first":
		case "widen_shared_when_weak":
		case "widen_project_when_weak":
			return typeof entry === "boolean" || isBoundedString(entry);
		default:
			return isBoundedStringList(entry);
	}
}

function isRetrievalFilterSummary(value: unknown): value is RetrievalFilterSummary {
	if (!isRecord(value)) return false;
	return Object.entries(value).every(([key, entry]) =>
		isValidRetrievalFilterSummaryEntry(key, entry),
	);
}

function decodeFilterSummary(value: unknown): RetrievalFilterSummary | null {
	const parsed = parsePersistedJson(value);
	return isRetrievalFilterSummary(parsed) ? parsed : null;
}

function isRetrievalScoreSummary(value: unknown): value is RetrievalScoreSummary {
	if (!isRecord(value)) return false;
	return Object.entries(value).every(
		([key, entry]) => SCORE_KEYS.has(key) && isValidScoreSummaryEntry(key, entry),
	);
}

function isValidScoreSummaryEntry(key: string, value: unknown): boolean {
	return (
		(typeof value === "number" && Number.isFinite(value)) ||
		(value === null && NULLABLE_SCORE_KEYS.has(key))
	);
}

function decodeScoreSummary(value: unknown): RetrievalScoreSummary | null {
	const parsed = parsePersistedJson(value);
	return isRetrievalScoreSummary(parsed) ? parsed : null;
}

function decodeStringArray(value: unknown, maximum: number): string[] | null {
	const parsed = parsePersistedJson(value);
	return Array.isArray(parsed) &&
		parsed.length <= maximum &&
		parsed.every((entry) => typeof entry === "string")
		? parsed
		: null;
}

function decodeWorkingSetFiles(value: unknown): string[] | null {
	const decoded = decodeStringArray(value, 50);
	if (decoded == null) return null;
	try {
		serializeWorkingSetFiles(decoded);
		return decoded;
	} catch {
		return null;
	}
}

function decodeReasonCodes(value: unknown): string[] | null {
	const decoded = decodeStringArray(value, 20);
	if (decoded == null) return null;
	try {
		serializeReasonCodes(decoded);
		return decoded;
	} catch {
		return null;
	}
}

function decodeEvaluationReplayMetadata(row: SqlRow): {
	evaluationCheckoutId: string | null;
	evaluationFixtureId: string | null;
	evaluationSeed: number | null;
} | null {
	let evaluationCheckoutId: string | null;
	let evaluationFixtureId: string | null;
	let evaluationSeed: number | null;
	try {
		evaluationCheckoutId = optionalStableId(
			row.evaluation_checkout_id,
			"persisted evaluationCheckoutId",
		);
		evaluationFixtureId = optionalStableId(
			row.evaluation_fixture_id,
			"persisted evaluationFixtureId",
		);
		evaluationSeed = nonNegativeInteger(row.evaluation_seed as number | null, "evaluationSeed");
	} catch {
		return null;
	}

	if (row.surface === "evaluation_replay") {
		if (row.trigger !== "evaluation") return null;
		try {
			requiredString(row.experiment_id as string, "persisted experimentId", 128);
			requiredString(row.experiment_cell_id as string, "persisted experimentCellId", 128);
		} catch {
			return null;
		}
		if ((evaluationCheckoutId == null) === (evaluationFixtureId == null)) return null;
		if (evaluationSeed == null) return null;
	} else if (
		evaluationCheckoutId != null ||
		evaluationFixtureId != null ||
		evaluationSeed != null
	) {
		return null;
	}

	return { evaluationCheckoutId, evaluationFixtureId, evaluationSeed };
}

function readAttempt(db: Database, attemptId: string): RetrievalAttemptRecord | null {
	const row = db.prepare("SELECT * FROM retrieval_attempts WHERE attempt_id = ?").get(attemptId) as
		| SqlRow
		| undefined;
	if (!row) return null;
	if (row.contract_version !== RETRIEVAL_LEDGER_CONTRACT_VERSION) return null;
	const evaluationReplayMetadata = decodeEvaluationReplayMetadata(row);
	if (evaluationReplayMetadata == null) return null;
	const exposures = db
		.prepare("SELECT * FROM retrieval_exposures WHERE attempt_id = ? ORDER BY rank")
		.all(attemptId) as SqlRow[];
	const decodedExposures: RetrievalExposureRecord[] = [];
	for (const exposure of exposures) {
		decodedExposures.push({
			exposureId: exposure.exposure_id as number,
			attemptId: exposure.attempt_id as string,
			memoryId: exposure.memory_id as number | null,
			memoryImportKey: exposure.memory_import_key as string | null,
			originDeviceId: exposure.origin_device_id as string | null,
			rank: exposure.rank as number,
			disposition: exposure.disposition as RetrievalDisposition,
			section: exposure.section as PackTraceSection | null,
			handoffStatus: exposure.handoff_status as RetrievalDeliveryStatus,
			memoryRev: exposure.memory_rev as number | null,
			memoryUpdatedAt: exposure.memory_updated_at as string | null,
			memoryScopeId: exposure.memory_scope_id as string | null,
			memoryKind: exposure.memory_kind as string | null,
			memoryActive: decodeNullableBooleanInteger(exposure.memory_active),
			memoryDeletedAt: exposure.memory_deleted_at as string | null,
			scoreSummary: decodeScoreSummary(exposure.score_summary_json),
			reasonCodes: decodeReasonCodes(exposure.reason_codes_json),
		});
	}
	return {
		attemptId: row.attempt_id as string,
		contractVersion: RETRIEVAL_LEDGER_CONTRACT_VERSION,
		surface: row.surface as RetrievalSurface,
		trigger: row.trigger as RetrievalTrigger,
		startedAt: row.started_at as string,
		completedAt: row.completed_at as string | null,
		retrievalStatus: row.retrieval_status as RetrievalStatus,
		deliveryStatus: row.delivery_status as RetrievalDeliveryStatus,
		candidateCount: row.candidate_count as number,
		selectedCount: row.selected_count as number,
		persistedCandidateCount: row.persisted_candidate_count as number,
		recorderVersion: row.recorder_version as string,
		sessionId: row.session_id as number | null,
		source: row.source as string | null,
		streamId: row.stream_id as string | null,
		sourceSessionId: row.source_session_id as string | null,
		promptNumber: row.prompt_number as number | null,
		requestId: row.request_id as string | null,
		rawEventStartSeq: row.raw_event_start_seq as number | null,
		rawEventEndSeq: row.raw_event_end_seq as number | null,
		experimentId: row.experiment_id as string | null,
		experimentCellId: row.experiment_cell_id as string | null,
		evaluationCheckoutId: evaluationReplayMetadata.evaluationCheckoutId,
		evaluationFixtureId: evaluationReplayMetadata.evaluationFixtureId,
		evaluationSeed: evaluationReplayMetadata.evaluationSeed,
		latencyMs: row.latency_ms as number | null,
		project: row.project as string | null,
		scopeId: row.scope_id as string | null,
		mode: row.mode as string | null,
		limitRequested: row.limit_requested as number | null,
		tokenBudget: row.token_budget as number | null,
		outputTokens: row.output_tokens as number | null,
		workingSetFileCount: row.working_set_file_count as number | null,
		workingSetFiles: decodeWorkingSetFiles(row.working_set_files_json),
		queryHashSha256: row.query_hash_sha256 as string | null,
		queryCharCount: row.query_char_count as number | null,
		queryTokenEstimate: row.query_token_estimate as number | null,
		filterSummary: decodeFilterSummary(row.filter_summary_json),
		failureCode: row.failure_code as string | null,
		failureStage: row.failure_stage as string | null,
		traceVersion: row.trace_version as number | null,
		retentionUntil: row.retention_until as string | null,
		retentionPinned: row.retention_pinned === 1,
		retentionFinalizedAt: decodeIsoTimestamp(row.retention_finalized_at),
		exposures: decodedExposures,
	};
}

export function hashRetrievalQuery(query: string): {
	queryHashSha256: string;
	queryCharCount: number;
} {
	return {
		queryHashSha256: createHash("sha256").update(query, "utf8").digest("hex"),
		queryCharCount: query.length,
	};
}

function validateSha256(value: string): string {
	if (!/^[a-f0-9]{64}$/.test(value))
		throw new Error("queryHashSha256 must be lowercase SHA-256 hex");
	return value;
}

function validateUuid(value: string, name: string): string {
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
		throw new Error(`${name} must be a UUID`);
	}
	return value.toLowerCase();
}

function safeFailureReason(error: unknown): RetrievalLedgerFailureReason {
	if (error instanceof RetrievalLedgerValidationError) return "invalid_input";
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	if (message.includes("does not exist")) return "attempt_not_found";
	if (message.includes("conflict") || message.includes("already associated")) {
		return "idempotency_conflict";
	}
	if (
		message.includes("invalid") ||
		message.includes("must") ||
		message.includes("cannot") ||
		message.includes("exceed") ||
		message.includes("require")
	) {
		return "invalid_input";
	}
	return "storage_unavailable";
}

export function getRetrievalAttempt(
	db: Database,
	attemptId: string,
): RetrievalAttemptRecord | null {
	return readAttempt(db, validateUuid(attemptId, "attemptId"));
}

export function queryRetrievalAttempts(
	db: Database,
	input: QueryRetrievalAttemptsInput = {},
): RetrievalAttemptRecord[] {
	const clauses = ["contract_version = ?"];
	const params: Array<string | number> = [RETRIEVAL_LEDGER_CONTRACT_VERSION];
	if (input.sessionId != null) {
		clauses.push("session_id = ?");
		params.push(positiveInteger(input.sessionId, "sessionId"));
	}
	if (input.streamId != null && input.source == null) {
		throw new Error("source is required when streamId is provided");
	}
	if (input.source != null) {
		clauses.push("source = ?");
		params.push(requiredString(input.source, "source", 128));
	}
	if (input.streamId != null) {
		clauses.push("stream_id = ?");
		params.push(requiredString(input.streamId, "streamId"));
	}
	if (input.surface != null) {
		if (!RETRIEVAL_SURFACES.has(input.surface)) {
			throw new Error("surface is invalid for contract version 1");
		}
		clauses.push("surface = ?");
		params.push(input.surface);
	}
	const startedAtOrAfter = isoTimestamp(input.startedAtOrAfter, "startedAtOrAfter");
	const startedAtOrBefore = isoTimestamp(input.startedAtOrBefore, "startedAtOrBefore");
	if (
		startedAtOrAfter != null &&
		startedAtOrBefore != null &&
		startedAtOrAfter > startedAtOrBefore
	) {
		throw new Error("startedAtOrAfter cannot follow startedAtOrBefore");
	}
	if (startedAtOrAfter != null) {
		clauses.push("started_at >= ?");
		params.push(startedAtOrAfter);
	}
	if (startedAtOrBefore != null) {
		clauses.push("started_at <= ?");
		params.push(startedAtOrBefore);
	}
	const limit = positiveInteger(
		input.limit ?? DEFAULT_RETRIEVAL_QUERY_LIMIT,
		"limit",
		MAX_RETRIEVAL_QUERY_LIMIT,
	);
	const where = ` WHERE ${clauses.join(" AND ")}`;
	const rows = db
		.prepare(
			`SELECT attempt_id FROM retrieval_attempts${where} ORDER BY started_at DESC, attempt_id DESC LIMIT ?`,
		)
		.all(...params, limit) as Array<{ attempt_id: string }>;
	return rows.flatMap((row) => {
		const attempt = readAttempt(db, row.attempt_id);
		return attempt == null ? [] : [attempt];
	});
}

export function recordRetrievalAttempt(
	db: Database,
	input: RecordRetrievalAttemptInput,
): RetrievalWriteResult {
	const attempt = canonicalAttempt(input);
	const exposures = canonicalExposures(input, attempt.attempt_id as string);
	const inserted = db
		.transaction(() => {
			const requestMatch =
				attempt.request_id == null
					? undefined
					: (db
							.prepare(
								"SELECT attempt_id FROM retrieval_attempts WHERE source = ? AND surface = ? AND request_id = ?",
							)
							.get(attempt.source, attempt.surface, attempt.request_id) as
							| { attempt_id: string }
							| undefined);
			if (requestMatch && requestMatch.attempt_id !== attempt.attempt_id) {
				throw new Error("request identity is already associated with another retrieval attempt");
			}
			const existing = db
				.prepare("SELECT * FROM retrieval_attempts WHERE attempt_id = ?")
				.get(attempt.attempt_id) as SqlRow | undefined;
			if (existing) {
				const existingExposures = db
					.prepare("SELECT * FROM retrieval_exposures WHERE attempt_id = ? ORDER BY rank")
					.all(attempt.attempt_id) as SqlRow[];
				assertFailedRetrievalInvariant(
					existing.retrieval_status as RetrievalStatus,
					existing.delivery_status as RetrievalDeliveryStatus,
					existing.selected_count as number,
					existingExposures.length,
				);
				assertDeliverySelectionInvariant(
					existing.delivery_status as RetrievalDeliveryStatus,
					existing.selected_count as number,
				);
				const deliveryTransitioned = isAllowedDeliveryTransition(
					attempt.delivery_status as RetrievalDeliveryStatus,
					existing.delivery_status as RetrievalDeliveryStatus,
				);
				const retentionFinalized =
					attempt.retention_pinned === 1 &&
					existing.retention_pinned === 0 &&
					typeof existing.retention_until === "string" &&
					decodeIsoTimestamp(existing.retention_finalized_at) != null;
				const reconciledCompletionRetry =
					existing.request_id != null &&
					existing.request_id === attempt.request_id &&
					existing.retrieval_status === attempt.retrieval_status &&
					existing.delivery_status === attempt.delivery_status &&
					((attempt.retrieval_status === "succeeded" && attempt.delivery_status === "handed_off") ||
						(attempt.retrieval_status === "no_results" &&
							attempt.delivery_status === "not_attempted"));
				const sameRetryRetentionPolicy = hasSameRetryRetentionPolicy(attempt, existing);
				const ignoredAttemptKeys = [
					...(deliveryTransitioned ? ["delivery_status"] : []),
					...(reconciledCompletionRetry ? ["started_at", "completed_at", "latency_ms"] : []),
					...(reconciledCompletionRetry && sameRetryRetentionPolicy ? ["retention_until"] : []),
					...(retentionFinalized
						? ["retention_pinned", "retention_until", "retention_finalized_at"]
						: []),
				];
				if (
					!rowsEqual(attempt, existing, ignoredAttemptKeys) ||
					existingExposures.length !== exposures.length ||
					!exposures.every((row, index) =>
						exposureRowsEqualAfterMemoryDeletion(
							db,
							row,
							existingExposures[index] ?? {},
							deliveryTransitioned && row.disposition === "selected"
								? ["exposure_id", "handoff_status"]
								: ["exposure_id"],
						),
					)
				) {
					throw new Error("retrieval attempt retry conflicts with persisted data");
				}
				return false;
			}
			insertRow(db, "retrieval_attempts", attempt);
			for (const exposure of exposures) insertRow(db, "retrieval_exposures", exposure);
			return true;
		})
		.immediate();
	const saved = readAttempt(db, attempt.attempt_id as string);
	if (!saved) throw new Error("retrieval attempt was not persisted");
	return { attempt: saved, inserted };
}

export function tryRecordRetrievalAttempt(
	db: Database,
	input: RecordRetrievalAttemptInput,
): RetrievalLedgerWriteOutcome {
	try {
		return { ok: true, value: recordRetrievalAttempt(db, input) };
	} catch (error) {
		return {
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: safeFailureReason(error),
		};
	}
}

export function reconcileFailedRetrievalAttempt(
	db: Database,
	input: RecordRetrievalAttemptInput,
): RetrievalWriteResult {
	const attempt = canonicalAttempt(input);
	const attemptId = attempt.attempt_id as string;
	const exposures = canonicalExposures(input, attemptId);
	const isSuccessfulCompletion =
		(attempt.retrieval_status === "succeeded" && attempt.delivery_status === "handed_off") ||
		(attempt.retrieval_status === "no_results" && attempt.delivery_status === "not_attempted");
	if (attempt.request_id == null || !isSuccessfulCompletion) {
		throw new RetrievalLedgerValidationError(
			"failed retrieval reconciliation requires a request-bound successful completion",
		);
	}
	db.transaction(() => {
		const existing = db
			.prepare("SELECT * FROM retrieval_attempts WHERE attempt_id = ?")
			.get(attemptId) as SqlRow | undefined;
		if (
			!existing ||
			existing.contract_version !== RETRIEVAL_LEDGER_CONTRACT_VERSION ||
			existing.source !== attempt.source ||
			existing.surface !== attempt.surface ||
			existing.request_id !== attempt.request_id ||
			existing.retrieval_status !== "failed" ||
			existing.delivery_status !== "not_attempted"
		) {
			throw new Error("failed retrieval reconciliation conflicts with persisted data");
		}
		const completedAt = attempt.completed_at as string | null;
		const originalStartedAt = existing.started_at as string;
		if (
			!hasSameRetryRetentionPolicy(attempt, existing) ||
			(completedAt != null && Date.parse(completedAt) < Date.parse(originalStartedAt))
		) {
			throw new Error("failed retrieval reconciliation conflicts with persisted data");
		}
		const reconciled = {
			...attempt,
			started_at: originalStartedAt,
			latency_ms:
				completedAt == null
					? existing.latency_ms
					: Math.max(0, Date.parse(completedAt) - Date.parse(originalStartedAt)),
			retention_until: existing.retention_until,
			retention_pinned: existing.retention_pinned,
			retention_finalized_at: existing.retention_finalized_at,
		};
		const columns = Object.keys(reconciled).filter((column) => column !== "attempt_id");
		db.prepare(
			`UPDATE retrieval_attempts SET ${columns.map((column) => `${column} = @${column}`).join(", ")} WHERE attempt_id = @attempt_id`,
		).run(reconciled);
		db.prepare("DELETE FROM retrieval_exposures WHERE attempt_id = ?").run(attemptId);
		for (const exposure of exposures) insertRow(db, "retrieval_exposures", exposure);
	}).immediate();
	const saved = readAttempt(db, attemptId);
	if (!saved) throw new Error("reconciled retrieval attempt was not persisted");
	return { attempt: saved, inserted: false };
}

export function tryReconcileFailedRetrievalAttempt(
	db: Database,
	input: RecordRetrievalAttemptInput,
): RetrievalLedgerWriteOutcome {
	try {
		return { ok: true, value: reconcileFailedRetrievalAttempt(db, input) };
	} catch (error) {
		return {
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: safeFailureReason(error),
		};
	}
}

export function updateRetrievalDelivery(
	db: Database,
	attemptId: string,
	deliveryStatus: Exclude<RetrievalDeliveryStatus, "not_attempted">,
): { changed: boolean; attempt: RetrievalAttemptRecord } {
	if (!(["handed_off", "failed", "unknown"] as string[]).includes(deliveryStatus)) {
		throw new Error("deliveryStatus is invalid");
	}
	const id = validateUuid(attemptId, "attemptId");
	const changed = db
		.transaction(() => {
			const current = db
				.prepare(
					"SELECT contract_version, retrieval_status, delivery_status, selected_count FROM retrieval_attempts WHERE attempt_id = ?",
				)
				.get(id) as
				| {
						contract_version: number;
						retrieval_status: RetrievalStatus;
						delivery_status: RetrievalDeliveryStatus;
						selected_count: number;
				  }
				| undefined;
			if (!current) throw new Error("retrieval attempt does not exist");
			if (current.contract_version !== RETRIEVAL_LEDGER_CONTRACT_VERSION) {
				throw new RetrievalLedgerValidationError(
					"retrieval attempt contract version is unsupported",
				);
			}
			if (
				current.retrieval_status === "no_results" ||
				current.retrieval_status === "skipped" ||
				current.retrieval_status === "failed"
			) {
				const status =
					current.retrieval_status === "no_results" ? "no-results" : current.retrieval_status;
				throw new Error(`a ${status} retrieval attempt cannot transition delivery status`);
			}
			assertDeliverySelectionInvariant(deliveryStatus, current.selected_count);
			if (current.delivery_status === deliveryStatus) return false;
			if (current.delivery_status === "handed_off") {
				throw new Error("a handed-off retrieval attempt cannot be downgraded");
			}
			db.prepare("UPDATE retrieval_attempts SET delivery_status = ? WHERE attempt_id = ?").run(
				deliveryStatus,
				id,
			);
			db.prepare(
				"UPDATE retrieval_exposures SET handoff_status = ? WHERE attempt_id = ? AND disposition = 'selected'",
			).run(deliveryStatus, id);
			return true;
		})
		.immediate();
	const attempt = readAttempt(db, id);
	if (!attempt) throw new Error("retrieval attempt does not exist");
	return { changed, attempt };
}

export function tryUpdateRetrievalDelivery(
	db: Database,
	attemptId: string,
	deliveryStatus: Exclude<RetrievalDeliveryStatus, "not_attempted">,
): RetrievalLedgerDeliveryOutcome {
	try {
		return { ok: true, value: updateRetrievalDelivery(db, attemptId, deliveryStatus) };
	} catch (error) {
		return {
			ok: false,
			errorCode: "retrieval_ledger_delivery_write_failed",
			reason: safeFailureReason(error),
		};
	}
}

export function finalizeRetrievalAttemptRetention(
	db: Database,
	attemptId: string,
	input: FinalizeRetrievalAttemptRetentionInput,
): { changed: boolean; attempt: RetrievalAttemptRecord } {
	const id = validateUuid(attemptId, "attemptId");
	const finalizedAt = isoTimestamp(input.finalizedAt, "finalizedAt") as string;
	const expiresAt = retentionUntil(finalizedAt, input.retentionDays, false) as string;
	const changed = db
		.transaction(() => {
			const current = db
				.prepare(
					"SELECT contract_version, started_at, retention_pinned, retention_until, retention_finalized_at FROM retrieval_attempts WHERE attempt_id = ?",
				)
				.get(id) as
				| {
						contract_version: number;
						started_at: string;
						retention_pinned: number;
						retention_until: string | null;
						retention_finalized_at: string | null;
				  }
				| undefined;
			if (!current) throw new Error("retrieval attempt does not exist");
			if (current.contract_version !== RETRIEVAL_LEDGER_CONTRACT_VERSION) {
				throw new RetrievalLedgerValidationError(
					"retrieval attempt contract version is unsupported",
				);
			}
			if (finalizedAt < current.started_at) {
				throw new RetrievalLedgerValidationError("finalizedAt cannot precede startedAt");
			}
			if (current.retention_pinned === 0) {
				if (
					current.retention_until === expiresAt &&
					current.retention_finalized_at === finalizedAt
				) {
					return false;
				}
				throw new Error("retrieval attempt retention finalization conflicts with persisted data");
			}
			db.prepare(
				"UPDATE retrieval_attempts SET retention_pinned = 0, retention_until = ?, retention_finalized_at = ? WHERE attempt_id = ?",
			).run(expiresAt, finalizedAt, id);
			return true;
		})
		.immediate();
	const attempt = readAttempt(db, id);
	if (!attempt) throw new Error("retrieval attempt does not exist");
	return { changed, attempt };
}

export function tryFinalizeRetrievalAttemptRetention(
	db: Database,
	attemptId: string,
	input: FinalizeRetrievalAttemptRetentionInput,
): RetrievalLedgerRetentionOutcome {
	try {
		return { ok: true, value: finalizeRetrievalAttemptRetention(db, attemptId, input) };
	} catch (error) {
		return {
			ok: false,
			errorCode: "retrieval_ledger_retention_write_failed",
			reason: safeFailureReason(error),
		};
	}
}

function purgeRetrievalAttemptsWhere(
	db: Database,
	whereClause: string,
	params: Array<string | number>,
): number {
	return db
		.transaction(() => {
			const attributionTables = new Set(
				db
					.prepare(
						`SELECT name FROM sqlite_master
							 WHERE type = 'table'
							   AND name IN (
								'attribution_assessments',
								'attribution_assessment_evidence',
								'outcome_evidence'
							   )`,
					)
					.pluck()
					.all() as string[],
			);
			if (attributionTables.has("attribution_assessments")) {
				if (attributionTables.has("attribution_assessment_evidence")) {
					const assessmentIds = new Set(
						db
							.prepare(
								`SELECT assessment_id FROM attribution_assessments WHERE attempt_id IN (
										SELECT attempt_id FROM retrieval_attempts WHERE ${whereClause}
									)`,
							)
							.pluck()
							.all(...params) as string[],
					);
					if (attributionTables.has("outcome_evidence")) {
						// codemem-ysyh will persist exact randomized pairings. Until then, cell-level
						// matching deliberately over-deletes when multiple attempts share a cell: fail
						// closed rather than retain a potentially invalid contrast. Materialize IDs
						// before deleting links because this selection itself joins the link table.
						const dependentIds = db
							.prepare(
								`WITH purged_cells AS (
									SELECT DISTINCT experiment_id, experiment_cell_id
									FROM retrieval_attempts
									WHERE ${whereClause}
									  AND experiment_id IS NOT NULL
									  AND experiment_cell_id IS NOT NULL
								 )
								 SELECT DISTINCT assessments.assessment_id
								 FROM attribution_assessments assessments
								 JOIN attribution_assessment_evidence links
								   ON links.assessment_id = assessments.assessment_id
								 JOIN outcome_evidence evidence ON evidence.evidence_id = links.evidence_id
								 JOIN purged_cells cells
								   ON cells.experiment_id = evidence.experiment_id
								  AND cells.experiment_cell_id = evidence.experiment_cell_id
								 WHERE assessments.basis = 'randomized_contrast'`,
							)
							.pluck()
							.all(...params) as string[];
						for (const assessmentId of dependentIds) assessmentIds.add(assessmentId);
					}
					const deleteLinks = db.prepare(
						"DELETE FROM attribution_assessment_evidence WHERE assessment_id = ?",
					);
					const deleteAssessment = db.prepare(
						"DELETE FROM attribution_assessments WHERE assessment_id = ?",
					);
					for (const assessmentId of assessmentIds) {
						deleteLinks.run(assessmentId);
						deleteAssessment.run(assessmentId);
					}
				} else {
					// Without evidence links, only assessments bound directly to purged attempts are identifiable.
					db.prepare(
						`DELETE FROM attribution_assessments WHERE attempt_id IN (
							SELECT attempt_id FROM retrieval_attempts WHERE ${whereClause}
						)`,
					).run(...params);
				}
			}
			db.prepare(
				`DELETE FROM retrieval_exposures WHERE attempt_id IN (
					SELECT attempt_id FROM retrieval_attempts WHERE ${whereClause}
				)`,
			).run(...params);
			return db.prepare(`DELETE FROM retrieval_attempts WHERE ${whereClause}`).run(...params)
				.changes;
		})
		.immediate();
}

export function purgeExpiredRetrievalAttempts(
	db: Database,
	now: string = new Date().toISOString(),
): number {
	const timestamp = isoTimestamp(now, "now");
	if (timestamp == null) {
		throw new RetrievalLedgerValidationError("now must be an ISO-8601 timestamp");
	}
	// Contract v1 defines these retention fields; future versions own their expiry semantics.
	return purgeRetrievalAttemptsWhere(
		db,
		"contract_version = ? AND retention_pinned = 0 AND retention_until IS NOT NULL AND retention_until <= ?",
		[RETRIEVAL_LEDGER_CONTRACT_VERSION, timestamp],
	);
}

export type RetrievalPrivacyPurgeSelector =
	| { sessionId: number; source?: never; streamId?: never; surface?: never }
	| { sessionId?: never; source: string; streamId: string; surface?: never }
	| { sessionId?: never; source: string; streamId?: never; surface: RetrievalSurface };

export function purgeRetrievalAttemptsForPrivacy(
	db: Database,
	selector: RetrievalPrivacyPurgeSelector,
): number {
	// Explicit privacy deletion applies across versions, including rows this reader cannot interpret.
	if (selector.sessionId != null) {
		const sessionId = nonNegativeInteger(selector.sessionId, "sessionId") as number;
		return purgeRetrievalAttemptsWhere(db, "session_id = ?", [sessionId]);
	}
	const source = requiredString(selector.source, "source", 128);
	if (selector.surface != null) {
		if (!RETRIEVAL_SURFACES.has(selector.surface)) {
			throw new Error("surface is invalid for contract version 1");
		}
		return purgeRetrievalAttemptsWhere(db, "source = ? AND surface = ?", [
			source,
			selector.surface,
		]);
	}
	const streamId = requiredString(selector.streamId, "streamId");
	return purgeRetrievalAttemptsWhere(db, "source = ? AND stream_id = ?", [source, streamId]);
}
