import { isAbsolute, posix, win32 } from "node:path";
import type { Database } from "./db.js";
import {
	DEFAULT_RETRIEVAL_LEDGER_RETENTION_DAYS,
	MAX_RETRIEVAL_JSON_BYTES,
} from "./retrieval-ledger.js";
import { SecretScanner } from "./secret-scanner.js";

export const OUTCOME_EVIDENCE_CONTRACT_VERSION = 1 as const;
export const DEFAULT_OUTCOME_EVIDENCE_QUERY_LIMIT = 50;
export const MAX_OUTCOME_EVIDENCE_QUERY_LIMIT = 100;

export type OutcomeDimension = "quality" | "efficiency" | "mechanism" | "safety" | "feedback";
export type OutcomeEvidenceType =
	| "quality.task_assertion"
	| "quality.test_result"
	| "quality.typecheck_result"
	| "quality.lint_result"
	| "quality.build_result"
	| "quality.blinded_evaluator"
	| "quality.corrective_followup"
	| "efficiency.elapsed_ms"
	| "efficiency.tool_call_count"
	| "efficiency.exploration_call_count"
	| "efficiency.files_read_count"
	| "efficiency.files_read_before_target"
	| "efficiency.retrieval_overhead_ms"
	| "efficiency.retrieval_overhead_tokens"
	| "mechanism.source_location_match"
	| "mechanism.memory_reference"
	| "mechanism.command_or_constraint_reuse"
	| "mechanism.retrieval_followup"
	| "safety.stale_guidance"
	| "safety.contradicted_guidance"
	| "safety.wrong_action_followup"
	| "safety.retrieval_noise"
	| "feedback.explicit_helpful"
	| "feedback.explicit_irrelevant"
	| "feedback.explicit_stale"
	| "feedback.explicit_harmful"
	| "feedback.explicit_correction";
export type OutcomeSourceClass =
	| "observed"
	| "derived"
	| "evaluator"
	| "user_reported"
	| "experiment";
export type OutcomeEvidenceStatus = "pass" | "fail" | "mixed" | "present" | "unknown";
export type OutcomeValueUnit = "count" | "milliseconds" | "tokens" | "ratio";
export type OutcomeValue =
	| { type: "integer"; value: number; unit: Exclude<OutcomeValueUnit, "ratio"> }
	| { type: "real"; value: number; unit: OutcomeValueUnit };

export interface OutcomeEvidenceReferences {
	check_id?: string;
	assertion_id?: string;
	rubric_id?: string;
	fixture_id?: string;
	checkout_id?: string;
	adjudication_id?: string;
	feedback_action_id?: string;
	feedback_gate?: "structured_action" | "unambiguous_instruction";
	passed_count?: number;
	failed_count?: number;
	skipped_count?: number;
	total_count?: number;
	repository_paths?: string[];
	matched_paths?: string[];
	reference_codes?: string[];
}

export interface RecordOutcomeEvidenceInput {
	evidenceId: string;
	dimension: OutcomeDimension;
	evidenceType: OutcomeEvidenceType;
	sourceClass: OutcomeSourceClass;
	observedAt: string;
	producer: string;
	producerVersion: string;
	status: OutcomeEvidenceStatus;
	value?: OutcomeValue | null;
	sessionId?: number | null;
	source?: string | null;
	streamId?: string | null;
	sourceSessionId?: string | null;
	promptNumber?: number | null;
	rawEventStartSeq?: number | null;
	rawEventEndSeq?: number | null;
	experimentId?: string | null;
	experimentCellId?: string | null;
	windowStartAt?: string | null;
	windowEndAt?: string | null;
	references?: OutcomeEvidenceReferences;
	retentionDays?: number;
	retentionPinned?: boolean;
}

export interface OutcomeEvidenceRecord {
	evidenceId: string;
	contractVersion: typeof OUTCOME_EVIDENCE_CONTRACT_VERSION;
	dimension: OutcomeDimension;
	evidenceType: OutcomeEvidenceType;
	sourceClass: OutcomeSourceClass;
	observedAt: string;
	producer: string;
	producerVersion: string;
	status: OutcomeEvidenceStatus;
	value: OutcomeValue | null;
	sessionId: number | null;
	source: string | null;
	streamId: string | null;
	sourceSessionId: string | null;
	promptNumber: number | null;
	rawEventStartSeq: number | null;
	rawEventEndSeq: number | null;
	experimentId: string | null;
	experimentCellId: string | null;
	windowStartAt: string | null;
	windowEndAt: string | null;
	references: OutcomeEvidenceReferences | null;
	retentionUntil: string | null;
	retentionPinned: boolean;
	retentionFinalizedAt: string | null;
}

export interface QueryOutcomeEvidenceInput {
	sessionId?: number;
	source?: string;
	streamId?: string;
	dimension?: OutcomeDimension;
	evidenceType?: OutcomeEvidenceType;
	observedAtOrAfter?: string;
	observedAtOrBefore?: string;
	limit?: number;
}

export type OutcomeEvidenceWriteResult = { evidence: OutcomeEvidenceRecord; inserted: boolean };
export type OutcomeEvidenceWriteOutcome =
	| { ok: true; value: OutcomeEvidenceWriteResult }
	| {
			ok: false;
			errorCode: "outcome_evidence_write_failed";
			reason: "invalid_input" | "idempotency_conflict" | "storage_unavailable";
	  };

export interface FinalizeOutcomeEvidenceRetentionInput {
	finalizedAt: string;
	retentionDays?: number;
}

export type OutcomeEvidenceRetentionOutcome =
	| { ok: true; value: { changed: boolean; evidence: OutcomeEvidenceRecord } }
	| {
			ok: false;
			errorCode: "outcome_evidence_retention_write_failed";
			reason:
				| "invalid_input"
				| "idempotency_conflict"
				| "evidence_not_found"
				| "storage_unavailable";
	  };

export class OutcomeEvidenceValidationError extends Error {
	readonly name = "OutcomeEvidenceValidationError";
}

class OutcomeEvidenceIdempotencyConflictError extends Error {
	readonly name = "OutcomeEvidenceIdempotencyConflictError";
}

class OutcomeEvidenceNotFoundError extends Error {
	readonly name = "OutcomeEvidenceNotFoundError";
}

type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

const DIMENSIONS = new Set<OutcomeDimension>([
	"quality",
	"efficiency",
	"mechanism",
	"safety",
	"feedback",
]);
const SOURCE_CLASSES = new Set<OutcomeSourceClass>([
	"observed",
	"derived",
	"evaluator",
	"user_reported",
	"experiment",
]);
const STATUSES = new Set<OutcomeEvidenceStatus>(["pass", "fail", "mixed", "present", "unknown"]);
const VALUE_UNITS = new Set<OutcomeValueUnit>(["count", "milliseconds", "tokens", "ratio"]);
const EVIDENCE_TYPES = new Set<OutcomeEvidenceType>([
	"quality.task_assertion",
	"quality.test_result",
	"quality.typecheck_result",
	"quality.lint_result",
	"quality.build_result",
	"quality.blinded_evaluator",
	"quality.corrective_followup",
	"efficiency.elapsed_ms",
	"efficiency.tool_call_count",
	"efficiency.exploration_call_count",
	"efficiency.files_read_count",
	"efficiency.files_read_before_target",
	"efficiency.retrieval_overhead_ms",
	"efficiency.retrieval_overhead_tokens",
	"mechanism.source_location_match",
	"mechanism.memory_reference",
	"mechanism.command_or_constraint_reuse",
	"mechanism.retrieval_followup",
	"safety.stale_guidance",
	"safety.contradicted_guidance",
	"safety.wrong_action_followup",
	"safety.retrieval_noise",
	"feedback.explicit_helpful",
	"feedback.explicit_irrelevant",
	"feedback.explicit_stale",
	"feedback.explicit_harmful",
	"feedback.explicit_correction",
]);
const REFERENCE_KEYS = new Set<keyof OutcomeEvidenceReferences>([
	"check_id",
	"assertion_id",
	"rubric_id",
	"fixture_id",
	"checkout_id",
	"adjudication_id",
	"feedback_action_id",
	"feedback_gate",
	"passed_count",
	"failed_count",
	"skipped_count",
	"total_count",
	"repository_paths",
	"matched_paths",
	"reference_codes",
]);
const QUALITY_CHECK_TYPES = new Set<OutcomeEvidenceType>([
	"quality.task_assertion",
	"quality.test_result",
	"quality.typecheck_result",
	"quality.lint_result",
	"quality.build_result",
]);
const SECRET_SCANNER = new SecretScanner();
const OUTCOME_EVIDENCE_QUERY_BATCH_SIZE = MAX_OUTCOME_EVIDENCE_QUERY_LIMIT;
const EXPLICIT_TIMESTAMP_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?([Zz]|[+-](\d{2}):?(\d{2}))$/;
const INPUT_KEYS = new Set<keyof RecordOutcomeEvidenceInput>([
	"evidenceId",
	"dimension",
	"evidenceType",
	"sourceClass",
	"observedAt",
	"producer",
	"producerVersion",
	"status",
	"value",
	"sessionId",
	"source",
	"streamId",
	"sourceSessionId",
	"promptNumber",
	"rawEventStartSeq",
	"rawEventEndSeq",
	"experimentId",
	"experimentCellId",
	"windowStartAt",
	"windowEndAt",
	"references",
	"retentionDays",
	"retentionPinned",
]);
const FINALIZATION_INPUT_KEYS = new Set<keyof FinalizeOutcomeEvidenceRetentionInput>([
	"finalizedAt",
	"retentionDays",
]);

function requiredString(value: string, name: string, max = 256): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) {
		throw new OutcomeEvidenceValidationError(
			`${name} must be a non-empty string of at most ${max} characters`,
		);
	}
	return value;
}

function stableCode(value: string, name: string, max = 256): string {
	const checked = requiredString(value, name, max);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@:+-]*$/.test(checked)) {
		throw new OutcomeEvidenceValidationError(`${name} must be a bounded stable identifier`);
	}
	const normalized = checked.replaceAll("\\", "/");
	if (
		isAbsolute(checked) ||
		win32.isAbsolute(checked) ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.includes("/../")
	) {
		throw new OutcomeEvidenceValidationError(
			`${name} must not contain an absolute or traversing path`,
		);
	}
	if (SECRET_SCANNER.scan(checked).detections.length > 0) {
		throw new OutcomeEvidenceValidationError(
			`${name} must not contain authentication or secret material`,
		);
	}
	return checked;
}

function scalarReferenceId(value: unknown, name: string): string {
	if (typeof value !== "string") {
		throw new OutcomeEvidenceValidationError(`${name} must be a string`);
	}
	return stableCode(value, name);
}

function optionalString(value: string | null | undefined, name: string, max = 256): string | null {
	return value == null ? null : stableCode(value, name, max);
}

function nonNegativeInteger(value: number | null | undefined, name: string): number | null {
	if (value == null) return null;
	if (!Number.isSafeInteger(value) || value < 0)
		throw new OutcomeEvidenceValidationError(`${name} must be a non-negative integer`);
	return value;
}

function optionalBoolean(value: unknown, name: string): boolean {
	if (value === undefined) return false;
	if (typeof value !== "boolean") {
		throw new OutcomeEvidenceValidationError(`${name} must be a boolean when provided`);
	}
	return value;
}

function positiveInteger(value: number, name: string, maximum?: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || (maximum != null && value > maximum)) {
		throw new OutcomeEvidenceValidationError(
			`${name} must be a positive integer${maximum == null ? "" : ` no greater than ${maximum}`}`,
		);
	}
	return value;
}

function timestamp(value: string | null | undefined, name: string): string | null {
	if (value == null) return null;
	const match = EXPLICIT_TIMESTAMP_PATTERN.exec(value);
	if (match == null) {
		throw new OutcomeEvidenceValidationError(
			`${name} must be an ISO-8601 timestamp with an explicit time zone`,
		);
	}
	const [
		,
		yearText,
		monthText,
		dayText,
		hourText,
		minuteText,
		secondText,
		fraction,
		,
		offsetHourText,
		offsetMinuteText,
	] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText ?? "0");
	const offsetHour = Number(offsetHourText ?? "0");
	const offsetMinute = Number(offsetMinuteText ?? "0");
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
	const endOfDay = hour === 24 && minute === 0 && second === 0 && !/[1-9]/.test(fraction ?? "");
	if (
		daysInMonth == null ||
		day < 1 ||
		day > daysInMonth ||
		minute > 59 ||
		second > 59 ||
		offsetHour > 23 ||
		offsetMinute > 59 ||
		(hour > 23 && !endOfDay) ||
		!Number.isFinite(Date.parse(value))
	) {
		throw new OutcomeEvidenceValidationError(
			`${name} must be an ISO-8601 timestamp with an explicit time zone`,
		);
	}
	return new Date(value).toISOString();
}

function requiredTimestamp(value: unknown, name: string): string {
	if (typeof value !== "string") {
		throw new OutcomeEvidenceValidationError(
			`${name} is required and must be an ISO-8601 timestamp with an explicit time zone`,
		);
	}
	const canonicalTimestamp = timestamp(value, name);
	if (canonicalTimestamp == null) {
		throw new OutcomeEvidenceValidationError(`${name} is required`);
	}
	return canonicalTimestamp;
}

function uuid(value: unknown): string {
	if (typeof value !== "string") {
		throw new OutcomeEvidenceValidationError("evidenceId must be a string UUID");
	}
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
		throw new OutcomeEvidenceValidationError("evidenceId must be a UUID");
	}
	return value.toLowerCase();
}

function repositoryPath(value: string, name: string): string {
	const raw = requiredString(value, name, 1024);
	const normalized = posix.normalize(raw.replaceAll("\\", "/")).replace(/^\.\//, "");
	if (
		/^\s|\s$/u.test(raw) ||
		isAbsolute(raw) ||
		win32.isAbsolute(raw) ||
		/^[a-z]:/i.test(raw) ||
		/^[a-z][a-z0-9+.-]*:/i.test(raw) ||
		win32.isAbsolute(normalized) ||
		/^[a-z]:/i.test(normalized) ||
		/^[a-z][a-z0-9+.-]*:/i.test(normalized) ||
		normalized.length === 0 ||
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("../")
	) {
		throw new OutcomeEvidenceValidationError(`${name} must be repository-relative`);
	}
	return normalized;
}

function codeList(value: unknown, name: string): string[] {
	if (!Array.isArray(value)) throw new OutcomeEvidenceValidationError(`${name} must be an array`);
	if (value.length > 50)
		throw new OutcomeEvidenceValidationError(`${name} must contain at most 50 values`);
	return value.map((entry) => {
		if (typeof entry !== "string") {
			throw new OutcomeEvidenceValidationError(`${name} must contain only string values`);
		}
		return stableCode(entry, name, 128);
	});
}

function pathList(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.length > 50)
		throw new OutcomeEvidenceValidationError(`${name} must contain at most 50 paths`);
	return value.map((entry) => {
		if (typeof entry !== "string") {
			throw new OutcomeEvidenceValidationError(`${name} must contain only string paths`);
		}
		return repositoryPath(entry, name);
	});
}

function sameRepositoryPath(
	left: string,
	right: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "win32") return left === right;
	const leftCodePoints = [...left];
	const rightCodePoints = [...right];
	return (
		leftCodePoints.length === rightCodePoints.length &&
		leftCodePoints.every(
			(codePoint, index) => codePoint.toUpperCase() === rightCodePoints[index]?.toUpperCase(),
		)
	);
}

function uniqueRepositoryPaths(paths: string[], platform: NodeJS.Platform): string[] {
	return paths.filter(
		(path, index) =>
			paths.findIndex((candidate) => sameRepositoryPath(candidate, path, platform)) === index,
	);
}

function canonicalizeSourceLocationPaths(
	references: OutcomeEvidenceReferences,
	platform: NodeJS.Platform,
): void {
	if (references.repository_paths == null || references.matched_paths == null) return;
	const repositoryPaths = uniqueRepositoryPaths(references.repository_paths, platform);
	const matchedPaths = references.matched_paths.map(
		(path) =>
			repositoryPaths.find((candidate) => sameRepositoryPath(candidate, path, platform)) ?? path,
	);
	references.repository_paths = repositoryPaths;
	references.matched_paths = uniqueRepositoryPaths(matchedPaths, platform);
}

function isPlainObjectMap(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function serializeReferences(input: unknown): string | null {
	if (input === undefined) return null;
	if (!isPlainObjectMap(input)) {
		throw new OutcomeEvidenceValidationError("references must be a plain object when provided");
	}
	const output: Record<string, string | number | string[]> = {};
	for (const key of Object.keys(input).sort()) {
		const value = input[key];
		if (!REFERENCE_KEYS.has(key as keyof OutcomeEvidenceReferences))
			throw new OutcomeEvidenceValidationError(`references contains unsupported key: ${key}`);
		if (value === undefined) continue;
		if (value === null)
			throw new OutcomeEvidenceValidationError(`references.${key} must not be null`);
		if (key === "repository_paths" || key === "matched_paths")
			output[key] = pathList(value, `references.${key}`);
		else if (key === "reference_codes") output[key] = codeList(value, `references.${key}`);
		else if (key.endsWith("_count"))
			output[key] = nonNegativeInteger(value as number, `references.${key}`) as number;
		else if (key === "feedback_gate") {
			if (value !== "structured_action" && value !== "unambiguous_instruction")
				throw new OutcomeEvidenceValidationError("references.feedback_gate is invalid");
			output[key] = value;
		} else output[key] = scalarReferenceId(value, `references.${key}`);
	}
	const json = JSON.stringify(output);
	if (Buffer.byteLength(json, "utf8") > MAX_RETRIEVAL_JSON_BYTES)
		throw new OutcomeEvidenceValidationError(
			`references exceeds ${MAX_RETRIEVAL_JSON_BYTES} bytes`,
		);
	return json;
}

function validatePassingCheckFailedCount(
	status: OutcomeEvidenceStatus,
	failedCount: number | undefined,
): void {
	if (status === "pass" && failedCount != null && failedCount !== 0) {
		throw new OutcomeEvidenceValidationError(
			"passing deterministic quality evidence requires failed_count to be zero",
		);
	}
}

function validateFailingCheckFailedCount(
	status: OutcomeEvidenceStatus,
	failedCount: number | undefined,
): void {
	if (status === "fail" && failedCount === 0) {
		throw new OutcomeEvidenceValidationError(
			"failing deterministic quality evidence requires failed_count to be positive when provided",
		);
	}
}

function validateFailingCheckAccountedCounts(
	status: OutcomeEvidenceStatus,
	passedCount: number | undefined,
	failedCount: number | undefined,
	skippedCount: number | undefined,
	totalCount: number | undefined,
): void {
	if (
		status === "fail" &&
		failedCount == null &&
		totalCount != null &&
		(passedCount ?? 0) + (skippedCount ?? 0) === totalCount
	) {
		throw new OutcomeEvidenceValidationError(
			"failing deterministic quality evidence cannot fully account for total_count without failed_count",
		);
	}
}

function validateCheckCountsDoNotExceedTotal(
	passedCount: number | undefined,
	failedCount: number | undefined,
	skippedCount: number | undefined,
	totalCount: number | undefined,
): void {
	if (
		totalCount != null &&
		(passedCount ?? 0) + (failedCount ?? 0) + (skippedCount ?? 0) > totalCount
	) {
		throw new OutcomeEvidenceValidationError("quality evidence counts cannot exceed total_count");
	}
}

function validateUnknownCheckOutcomeCounts(
	status: OutcomeEvidenceStatus,
	passedCount: number | undefined,
	failedCount: number | undefined,
	totalCount: number | undefined,
): void {
	if (status === "unknown" && (passedCount != null || failedCount != null || totalCount != null)) {
		throw new OutcomeEvidenceValidationError(
			"unknown deterministic quality evidence must not include outcome counts",
		);
	}
}

function validateMixedCheckOutcomeCounts(
	status: OutcomeEvidenceStatus,
	passedCount: number | undefined,
	failedCount: number | undefined,
	skippedCount: number | undefined,
	totalCount: number | undefined,
): void {
	if (status !== "mixed" || totalCount == null) return;
	const counts = [passedCount, failedCount, skippedCount];
	const accounted = counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
	const positiveOutcomes = counts.filter((count) => count != null && count > 0).length;
	if (accounted === totalCount && positiveOutcomes < 2) {
		throw new OutcomeEvidenceValidationError(
			"mixed deterministic quality evidence requires at least two positive outcome counts when fully accounted",
		);
	}
}

function validateBlindedEvaluatorStatus(status: OutcomeEvidenceStatus): void {
	if (status === "present") {
		throw new OutcomeEvidenceValidationError(
			"blinded evaluator evidence requires pass, fail, mixed, or unknown status",
		);
	}
}

function validateReferences(
	type: OutcomeEvidenceType,
	sourceClass: OutcomeSourceClass,
	status: OutcomeEvidenceStatus,
	value: OutcomeValue | null | undefined,
	references: OutcomeEvidenceReferences | null | undefined,
): void {
	if (QUALITY_CHECK_TYPES.has(type)) {
		if (references?.check_id == null)
			throw new OutcomeEvidenceValidationError(
				"deterministic quality evidence requires references.check_id",
			);
		if (sourceClass !== "observed" && sourceClass !== "experiment")
			throw new OutcomeEvidenceValidationError(
				"deterministic quality evidence must be observed or experimental",
			);
		if (status === "present")
			throw new OutcomeEvidenceValidationError(
				"deterministic quality evidence requires a check status",
			);
		if (value != null)
			throw new OutcomeEvidenceValidationError(
				"deterministic quality counts belong in bounded references",
			);
		validateUnknownCheckOutcomeCounts(
			status,
			references.passed_count,
			references.failed_count,
			references.total_count,
		);
		validatePassingCheckFailedCount(status, references.failed_count);
		validateFailingCheckFailedCount(status, references.failed_count);
		validateCheckCountsDoNotExceedTotal(
			references.passed_count,
			references.failed_count,
			references.skipped_count,
			references.total_count,
		);
		validateFailingCheckAccountedCounts(
			status,
			references.passed_count,
			references.failed_count,
			references.skipped_count,
			references.total_count,
		);
		validateMixedCheckOutcomeCounts(
			status,
			references.passed_count,
			references.failed_count,
			references.skipped_count,
			references.total_count,
		);
	}
	if (type === "quality.blinded_evaluator") {
		validateBlindedEvaluatorStatus(status);
		if (sourceClass !== "evaluator" && sourceClass !== "experiment") {
			throw new OutcomeEvidenceValidationError(
				"blinded evaluator evidence must be evaluator-provided or experimentally imported",
			);
		}
		if (references?.assertion_id == null || references.rubric_id == null) {
			throw new OutcomeEvidenceValidationError(
				"blinded evaluator evidence requires assertion and rubric identifiers",
			);
		}
	}
	const sourceLocationRepositoryPaths = new Set(references?.repository_paths ?? []);
	if (type === "mechanism.source_location_match" && status !== "present") {
		throw new OutcomeEvidenceValidationError("source-location evidence status must be present");
	}
	if (
		type === "mechanism.source_location_match" &&
		(!references?.repository_paths?.length || references.matched_paths == null)
	) {
		throw new OutcomeEvidenceValidationError(
			"source-location evidence requires repository and matched paths",
		);
	}
	if (
		type === "mechanism.source_location_match" &&
		(value?.type !== "integer" ||
			value.unit !== "count" ||
			!Number.isSafeInteger(value.value) ||
			value.value < 0 ||
			value.value !== references?.matched_paths?.length)
	) {
		throw new OutcomeEvidenceValidationError(
			"source-location evidence requires a non-negative integer count equal to matched_paths length",
		);
	}
	if (
		type === "mechanism.source_location_match" &&
		references?.repository_paths != null &&
		new Set(references.repository_paths).size !== references.repository_paths.length
	) {
		throw new OutcomeEvidenceValidationError(
			"source-location repository paths must be unique after normalization",
		);
	}
	if (
		type === "mechanism.source_location_match" &&
		references?.matched_paths != null &&
		new Set(references.matched_paths).size !== references.matched_paths.length
	) {
		throw new OutcomeEvidenceValidationError(
			"source-location matched paths must be unique after normalization",
		);
	}
	if (
		type === "mechanism.source_location_match" &&
		references?.matched_paths != null &&
		references.matched_paths.some((path) => !sourceLocationRepositoryPaths.has(path))
	) {
		throw new OutcomeEvidenceValidationError(
			"matched source-location paths must come from repository_paths",
		);
	}
	if (type === "mechanism.source_location_match" && value != null) {
		if (value.type !== "integer" || value.unit !== "count") {
			throw new OutcomeEvidenceValidationError(
				"source-location evidence value must be an integer count",
			);
		}
		if (value.value !== (references?.matched_paths?.length ?? 0)) {
			throw new OutcomeEvidenceValidationError(
				"source-location evidence count must equal matched_paths length",
			);
		}
	}
	if (
		(type === "safety.stale_guidance" || type === "safety.contradicted_guidance") &&
		references?.checkout_id == null &&
		references?.adjudication_id == null
	) {
		throw new OutcomeEvidenceValidationError(
			"stale or contradicted evidence requires a grounded checkout or adjudication identifier",
		);
	}
	if (type.startsWith("feedback.")) {
		if (sourceClass !== "user_reported")
			throw new OutcomeEvidenceValidationError("explicit feedback must be user_reported");
		if (status !== "present")
			throw new OutcomeEvidenceValidationError("explicit feedback status must be present");
		if (references?.feedback_action_id == null || references.feedback_gate == null) {
			throw new OutcomeEvidenceValidationError(
				"explicit feedback requires a gated feedback action",
			);
		}
	}
	if (type.startsWith("efficiency.")) {
		if (sourceClass !== "observed" && sourceClass !== "experiment")
			throw new OutcomeEvidenceValidationError(
				"efficiency evidence must be observed or experimental",
			);
		if (status !== "present" && status !== "unknown")
			throw new OutcomeEvidenceValidationError(
				"efficiency evidence status must be present or unknown",
			);
		if (status === "present" && value == null)
			throw new OutcomeEvidenceValidationError(
				"present efficiency evidence requires a typed value",
			);
		if (status === "unknown" && value != null)
			throw new OutcomeEvidenceValidationError(
				"unknown efficiency evidence must not include a value",
			);
		const expectedUnit = type.endsWith("_ms")
			? "milliseconds"
			: type.endsWith("_tokens")
				? "tokens"
				: "count";
		if (value != null && value.unit !== expectedUnit)
			throw new OutcomeEvidenceValidationError(
				`efficiency evidence requires ${expectedUnit} units`,
			);
		if (value != null && expectedUnit !== "milliseconds" && value.type !== "integer") {
			throw new OutcomeEvidenceValidationError(
				"count and token efficiency evidence requires an integer typed value",
			);
		}
	}
}

function canonicalValue(
	value: OutcomeValue | null | undefined,
): Pick<SqlRow, "value_type" | "value_integer" | "value_real" | "value_unit"> {
	if (value == null)
		return { value_type: null, value_integer: null, value_real: null, value_unit: null };
	if (!Number.isFinite(value.value) || value.value < 0)
		throw new OutcomeEvidenceValidationError("value must be a non-negative finite number");
	if (!VALUE_UNITS.has(value.unit))
		throw new OutcomeEvidenceValidationError("value unit is invalid");
	if (value.type === "integer") {
		if (!Number.isSafeInteger(value.value))
			throw new OutcomeEvidenceValidationError("integer value must be a safe integer");
		if ((value.unit as OutcomeValueUnit) === "ratio")
			throw new OutcomeEvidenceValidationError("integer values cannot use ratio units");
		return {
			value_type: "integer",
			value_integer: value.value,
			value_real: null,
			value_unit: value.unit,
		};
	}
	if (value.type !== "real") throw new OutcomeEvidenceValidationError("value type is invalid");
	return {
		value_type: "real",
		value_integer: null,
		value_real: value.value,
		value_unit: value.unit,
	};
}

function retentionUntil(
	observedAt: string,
	days: number | undefined,
	pinned: boolean,
): string | null {
	const retentionDays = days === undefined ? DEFAULT_RETRIEVAL_LEDGER_RETENTION_DAYS : days;
	if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 365) {
		throw new OutcomeEvidenceValidationError("retentionDays must be an integer from 7 through 365");
	}
	return pinned
		? null
		: new Date(Date.parse(observedAt) + retentionDays * 86_400_000).toISOString();
}

function canonical(
	input: RecordOutcomeEvidenceInput,
	platform: NodeJS.Platform | null = process.platform,
): SqlRow {
	if (!isPlainObjectMap(input)) {
		throw new OutcomeEvidenceValidationError("outcome evidence must be a plain object");
	}
	for (const key of Object.keys(input)) {
		if (!INPUT_KEYS.has(key as keyof RecordOutcomeEvidenceInput)) {
			throw new OutcomeEvidenceValidationError(`outcome evidence contains unsupported key: ${key}`);
		}
	}
	if (!DIMENSIONS.has(input.dimension) || !EVIDENCE_TYPES.has(input.evidenceType))
		throw new OutcomeEvidenceValidationError("evidence type or dimension is invalid");
	if (!input.evidenceType.startsWith(`${input.dimension}.`))
		throw new OutcomeEvidenceValidationError("evidence type does not match dimension");
	if (!SOURCE_CLASSES.has(input.sourceClass) || !STATUSES.has(input.status))
		throw new OutcomeEvidenceValidationError("source class or status is invalid");
	const retentionPinned = optionalBoolean(input.retentionPinned, "retentionPinned");
	if (input.streamId != null && input.source == null)
		throw new OutcomeEvidenceValidationError("source is required when streamId is provided");
	if (input.experimentCellId != null && input.experimentId == null)
		throw new OutcomeEvidenceValidationError(
			"experimentId is required when experimentCellId is provided",
		);
	if (retentionPinned && input.experimentId == null)
		throw new OutcomeEvidenceValidationError("retention pinning requires a named experiment");
	if (input.sourceClass === "experiment" && input.experimentId == null)
		throw new OutcomeEvidenceValidationError(
			"experiment source evidence requires a named experimentId",
		);
	const observedAt = requiredTimestamp(input.observedAt, "observedAt");
	const windowStartAt = timestamp(input.windowStartAt, "windowStartAt");
	const windowEndAt = timestamp(input.windowEndAt, "windowEndAt");
	if (windowStartAt != null && windowEndAt != null && windowEndAt < windowStartAt)
		throw new OutcomeEvidenceValidationError("windowEndAt cannot precede windowStartAt");
	if (
		input.rawEventStartSeq != null &&
		input.rawEventEndSeq != null &&
		input.rawEventEndSeq < input.rawEventStartSeq
	) {
		throw new OutcomeEvidenceValidationError("rawEventEndSeq cannot precede rawEventStartSeq");
	}
	let referencesJson = serializeReferences(input.references);
	const references =
		referencesJson == null ? null : (JSON.parse(referencesJson) as OutcomeEvidenceReferences);
	if (
		input.evidenceType === "mechanism.source_location_match" &&
		references != null &&
		platform != null
	) {
		canonicalizeSourceLocationPaths(references, platform);
		referencesJson = JSON.stringify(references);
		if (Buffer.byteLength(referencesJson, "utf8") > MAX_RETRIEVAL_JSON_BYTES) {
			throw new OutcomeEvidenceValidationError(
				`references exceeds ${MAX_RETRIEVAL_JSON_BYTES} bytes`,
			);
		}
	}
	validateReferences(input.evidenceType, input.sourceClass, input.status, input.value, references);
	return {
		evidence_id: uuid(input.evidenceId),
		contract_version: OUTCOME_EVIDENCE_CONTRACT_VERSION,
		dimension: input.dimension,
		evidence_type: input.evidenceType,
		source_class: input.sourceClass,
		observed_at: observedAt,
		producer: stableCode(input.producer, "producer"),
		producer_version: stableCode(input.producerVersion, "producerVersion"),
		status: input.status,
		...canonicalValue(input.value),
		session_id: input.sessionId == null ? null : positiveInteger(input.sessionId, "sessionId"),
		source: optionalString(input.source, "source"),
		stream_id: optionalString(input.streamId, "streamId"),
		source_session_id: optionalString(input.sourceSessionId, "sourceSessionId"),
		prompt_number: nonNegativeInteger(input.promptNumber, "promptNumber"),
		raw_event_start_seq: nonNegativeInteger(input.rawEventStartSeq, "rawEventStartSeq"),
		raw_event_end_seq: nonNegativeInteger(input.rawEventEndSeq, "rawEventEndSeq"),
		experiment_id: optionalString(input.experimentId, "experimentId"),
		experiment_cell_id: optionalString(input.experimentCellId, "experimentCellId"),
		window_start_at: windowStartAt,
		window_end_at: windowEndAt,
		references_json: referencesJson,
		retention_until: retentionUntil(observedAt, input.retentionDays, retentionPinned),
		retention_pinned: retentionPinned ? 1 : 0,
		retention_finalized_at: null,
	};
}

function decodeReferences(value: unknown): OutcomeEvidenceReferences | null {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_RETRIEVAL_JSON_BYTES)
		return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return null;
		const canonical = serializeReferences(parsed as OutcomeEvidenceReferences);
		return canonical == null ? null : (JSON.parse(canonical) as OutcomeEvidenceReferences);
	} catch {
		return null;
	}
}

function decodeValue(row: SqlRow): OutcomeValue | null {
	const hasNoValue =
		row.value_type == null &&
		row.value_integer == null &&
		row.value_real == null &&
		row.value_unit == null;
	if (hasNoValue) return null;
	if (
		row.value_type === "integer" &&
		typeof row.value_integer === "number" &&
		row.value_real == null &&
		typeof row.value_unit === "string" &&
		VALUE_UNITS.has(row.value_unit as OutcomeValueUnit) &&
		row.value_unit !== "ratio" &&
		Number.isSafeInteger(row.value_integer) &&
		row.value_integer >= 0
	) {
		return {
			type: "integer",
			value: row.value_integer,
			unit: row.value_unit as Exclude<OutcomeValueUnit, "ratio">,
		};
	}
	if (
		row.value_type === "real" &&
		row.value_integer == null &&
		typeof row.value_real === "number" &&
		typeof row.value_unit === "string" &&
		VALUE_UNITS.has(row.value_unit as OutcomeValueUnit) &&
		Number.isFinite(row.value_real) &&
		row.value_real >= 0
	) {
		return { type: "real", value: row.value_real, unit: row.value_unit as OutcomeValueUnit };
	}
	throw new Error("stored outcome evidence value is invalid");
}

function storedRetentionState(
	row: SqlRow,
	observedAt: string,
): {
	input: Pick<RecordOutcomeEvidenceInput, "retentionDays" | "retentionPinned">;
	finalizedAt: string | null;
} {
	if (row.retention_pinned === 1) {
		if (row.retention_until != null || row.retention_finalized_at != null) {
			throw new Error("pinned evidence cannot expire or be finalized");
		}
		return { input: { retentionPinned: true }, finalizedAt: null };
	}
	if (row.retention_pinned !== 0 || typeof row.retention_until !== "string") {
		throw new Error("stored retention state is invalid");
	}
	const canonicalRetentionUntil = timestamp(row.retention_until, "retentionUntil") as string;
	if (canonicalRetentionUntil !== row.retention_until) {
		throw new Error("stored retention timestamp is not canonical");
	}
	const storedFinalizedAt = row.retention_finalized_at;
	if (storedFinalizedAt != null && typeof storedFinalizedAt !== "string") {
		throw new Error("stored retention finalization timestamp is invalid");
	}
	const finalizedAt = timestamp(storedFinalizedAt, "retentionFinalizedAt");
	if (finalizedAt != null && finalizedAt !== storedFinalizedAt) {
		throw new Error("stored retention finalization timestamp is not canonical");
	}
	if (finalizedAt != null && finalizedAt < observedAt) {
		throw new Error("stored retention finalization precedes observation");
	}
	const retentionBase = finalizedAt ?? observedAt;
	const durationMs = Date.parse(canonicalRetentionUntil) - Date.parse(retentionBase);
	if (durationMs % 86_400_000 !== 0) throw new Error("stored retention window is invalid");
	const retentionDays = durationMs / 86_400_000;
	// Reconstructing expiry validates the persisted duration against contract retention bounds.
	retentionUntil(retentionBase, retentionDays, false);
	return {
		input:
			finalizedAt == null ? { retentionDays, retentionPinned: false } : { retentionPinned: true },
		finalizedAt,
	};
}

function inputFromRow(row: SqlRow): {
	input: RecordOutcomeEvidenceInput;
	retentionFinalizedAt: string | null;
} {
	if (row.contract_version !== OUTCOME_EVIDENCE_CONTRACT_VERSION) {
		throw new Error("stored outcome evidence contract version is unsupported");
	}
	const value = decodeValue(row);
	const references = decodeReferences(row.references_json);
	if (row.references_json != null && references == null) {
		throw new Error("stored outcome evidence references are invalid");
	}
	const observedAt = requiredTimestamp(row.observed_at, "observedAt");
	const retention = storedRetentionState(row, observedAt);
	return {
		retentionFinalizedAt: retention.finalizedAt,
		input: {
			evidenceId: row.evidence_id as string,
			dimension: row.dimension as OutcomeDimension,
			evidenceType: row.evidence_type as OutcomeEvidenceType,
			sourceClass: row.source_class as OutcomeSourceClass,
			observedAt,
			producer: row.producer as string,
			producerVersion: row.producer_version as string,
			status: row.status as OutcomeEvidenceStatus,
			value,
			sessionId: row.session_id as number | null,
			source: row.source as string | null,
			streamId: row.stream_id as string | null,
			sourceSessionId: row.source_session_id as string | null,
			promptNumber: row.prompt_number as number | null,
			rawEventStartSeq: row.raw_event_start_seq as number | null,
			rawEventEndSeq: row.raw_event_end_seq as number | null,
			experimentId: row.experiment_id as string | null,
			experimentCellId: row.experiment_cell_id as string | null,
			windowStartAt: row.window_start_at as string | null,
			windowEndAt: row.window_end_at as string | null,
			...(references == null ? {} : { references }),
			...retention.input,
		},
	};
}

function read(db: Database, evidenceId: string): OutcomeEvidenceRecord | null {
	const row = db.prepare("SELECT * FROM outcome_evidence WHERE evidence_id = ?").get(evidenceId) as
		| SqlRow
		| undefined;
	if (!row) return null;
	try {
		const stored = inputFromRow(row);
		const canonicalRow = canonical(stored.input, null);
		const ignoredRetentionKeys =
			stored.retentionFinalizedAt == null
				? []
				: ["retention_pinned", "retention_until", "retention_finalized_at"];
		if (!rowsEqual(canonicalRow, row, ignoredRetentionKeys)) return null;
		return {
			evidenceId: canonicalRow.evidence_id as string,
			contractVersion: OUTCOME_EVIDENCE_CONTRACT_VERSION,
			dimension: canonicalRow.dimension as OutcomeDimension,
			evidenceType: canonicalRow.evidence_type as OutcomeEvidenceType,
			sourceClass: canonicalRow.source_class as OutcomeSourceClass,
			observedAt: canonicalRow.observed_at as string,
			producer: canonicalRow.producer as string,
			producerVersion: canonicalRow.producer_version as string,
			status: canonicalRow.status as OutcomeEvidenceStatus,
			value: decodeValue(canonicalRow),
			sessionId: canonicalRow.session_id as number | null,
			source: canonicalRow.source as string | null,
			streamId: canonicalRow.stream_id as string | null,
			sourceSessionId: canonicalRow.source_session_id as string | null,
			promptNumber: canonicalRow.prompt_number as number | null,
			rawEventStartSeq: canonicalRow.raw_event_start_seq as number | null,
			rawEventEndSeq: canonicalRow.raw_event_end_seq as number | null,
			experimentId: canonicalRow.experiment_id as string | null,
			experimentCellId: canonicalRow.experiment_cell_id as string | null,
			windowStartAt: canonicalRow.window_start_at as string | null,
			windowEndAt: canonicalRow.window_end_at as string | null,
			references: decodeReferences(canonicalRow.references_json),
			retentionUntil: row.retention_until as string | null,
			retentionPinned: row.retention_pinned === 1,
			retentionFinalizedAt: stored.retentionFinalizedAt,
		};
	} catch {
		return null;
	}
}

function rowsEqual(left: SqlRow, right: SqlRow, ignoredKeys: string[] = []): boolean {
	// Compare contract-v1 canonical columns only; additive unknown columns remain tolerated.
	const ignored = new Set(ignoredKeys);
	return Object.entries(left).every(([key, value]) => ignored.has(key) || right[key] === value);
}

export function getOutcomeEvidence(db: Database, evidenceId: string): OutcomeEvidenceRecord | null {
	return read(db, uuid(evidenceId));
}

export function recordOutcomeEvidence(
	db: Database,
	input: RecordOutcomeEvidenceInput,
	platform: NodeJS.Platform = process.platform,
): OutcomeEvidenceWriteResult {
	const row = canonical(input, platform);
	return db
		.transaction(() => {
			const existing = db
				.prepare("SELECT * FROM outcome_evidence WHERE evidence_id = ?")
				.get(row.evidence_id) as SqlRow | undefined;
			let inserted = false;
			if (existing) {
				const retentionFinalized =
					row.retention_pinned === 1 &&
					existing.retention_pinned === 0 &&
					typeof existing.retention_until === "string" &&
					typeof existing.retention_finalized_at === "string" &&
					timestamp(existing.retention_finalized_at, "retentionFinalizedAt") != null;
				const ignoredKeys = retentionFinalized
					? ["retention_pinned", "retention_until", "retention_finalized_at"]
					: [];
				if (!rowsEqual(row, existing, ignoredKeys))
					throw new OutcomeEvidenceIdempotencyConflictError(
						"outcome evidence retry conflicts with persisted data",
					);
			} else {
				const columns = Object.keys(row);
				db.prepare(
					`INSERT INTO outcome_evidence (${columns.join(", ")}) VALUES (${columns.map((key) => `@${key}`).join(", ")})`,
				).run(row);
				inserted = true;
			}
			const evidence = read(db, row.evidence_id as string);
			if (!evidence) throw new Error("outcome evidence was not persisted");
			return { evidence, inserted };
		})
		.immediate();
}

export function finalizeOutcomeEvidenceRetention(
	db: Database,
	evidenceId: string,
	input: FinalizeOutcomeEvidenceRetentionInput,
): { changed: boolean; evidence: OutcomeEvidenceRecord } {
	if (!isPlainObjectMap(input)) {
		throw new OutcomeEvidenceValidationError(
			"outcome evidence retention finalization must be a plain object",
		);
	}
	for (const key of Object.keys(input)) {
		if (!FINALIZATION_INPUT_KEYS.has(key as keyof FinalizeOutcomeEvidenceRetentionInput)) {
			throw new OutcomeEvidenceValidationError(
				`outcome evidence retention finalization contains unsupported key: ${key}`,
			);
		}
	}
	const id = uuid(evidenceId);
	const finalizedAt = requiredTimestamp(input.finalizedAt, "finalizedAt");
	const expiresAt = retentionUntil(finalizedAt, input.retentionDays, false) as string;
	return db
		.transaction(() => {
			const current = db
				.prepare(
					"SELECT contract_version, observed_at, retention_pinned, retention_until, retention_finalized_at FROM outcome_evidence WHERE evidence_id = ?",
				)
				.get(id) as
				| {
						contract_version: number;
						observed_at: string;
						retention_pinned: number;
						retention_until: string | null;
						retention_finalized_at: string | null;
				  }
				| undefined;
			if (!current) throw new OutcomeEvidenceNotFoundError("outcome evidence does not exist");
			if (current.contract_version !== OUTCOME_EVIDENCE_CONTRACT_VERSION) {
				throw new OutcomeEvidenceValidationError(
					"outcome evidence contract version is unsupported",
				);
			}
			const observedAt = requiredTimestamp(current.observed_at, "observedAt");
			if (finalizedAt < observedAt) {
				throw new OutcomeEvidenceValidationError("finalizedAt cannot precede observedAt");
			}
			let changed = true;
			if (current.retention_pinned === 0) {
				if (
					current.retention_until === expiresAt &&
					current.retention_finalized_at === finalizedAt
				) {
					changed = false;
				} else {
					throw new OutcomeEvidenceIdempotencyConflictError(
						"outcome evidence retention finalization conflicts with persisted data",
					);
				}
			} else if (
				current.retention_pinned !== 1 ||
				current.retention_until != null ||
				current.retention_finalized_at != null
			) {
				throw new Error("stored outcome evidence retention state is invalid");
			} else {
				db.prepare(
					"UPDATE outcome_evidence SET retention_pinned = 0, retention_until = ?, retention_finalized_at = ? WHERE evidence_id = ?",
				).run(expiresAt, finalizedAt, id);
			}
			const evidence = read(db, id);
			if (!evidence) throw new Error("outcome evidence does not exist");
			return { changed, evidence };
		})
		.immediate();
}

export function tryFinalizeOutcomeEvidenceRetention(
	db: Database,
	evidenceId: string,
	input: FinalizeOutcomeEvidenceRetentionInput,
): OutcomeEvidenceRetentionOutcome {
	try {
		return { ok: true, value: finalizeOutcomeEvidenceRetention(db, evidenceId, input) };
	} catch (error) {
		const reason =
			error instanceof OutcomeEvidenceValidationError
				? "invalid_input"
				: error instanceof OutcomeEvidenceIdempotencyConflictError
					? "idempotency_conflict"
					: error instanceof OutcomeEvidenceNotFoundError
						? "evidence_not_found"
						: "storage_unavailable";
		return { ok: false, errorCode: "outcome_evidence_retention_write_failed", reason };
	}
}

export function tryRecordOutcomeEvidence(
	db: Database,
	input: RecordOutcomeEvidenceInput,
	platform: NodeJS.Platform = process.platform,
): OutcomeEvidenceWriteOutcome {
	try {
		return { ok: true, value: recordOutcomeEvidence(db, input, platform) };
	} catch (error) {
		const reason =
			error instanceof OutcomeEvidenceValidationError
				? "invalid_input"
				: error instanceof OutcomeEvidenceIdempotencyConflictError
					? "idempotency_conflict"
					: "storage_unavailable";
		return { ok: false, errorCode: "outcome_evidence_write_failed", reason };
	}
}

export function queryOutcomeEvidence(
	db: Database,
	input: QueryOutcomeEvidenceInput = {},
): OutcomeEvidenceRecord[] {
	const clauses = ["typeof(observed_at) = 'text'", "typeof(evidence_id) = 'text'"];
	const params: Array<string | number> = [];
	if (input.sessionId != null) {
		clauses.push("session_id = ?");
		params.push(positiveInteger(input.sessionId, "sessionId"));
	}
	if (input.streamId != null && input.source == null)
		throw new OutcomeEvidenceValidationError("source is required when streamId is provided");
	if (input.source != null) {
		clauses.push("source = ?");
		params.push(stableCode(input.source, "source"));
	}
	if (input.streamId != null) {
		clauses.push("stream_id = ?");
		params.push(stableCode(input.streamId, "streamId"));
	}
	if (input.dimension != null) {
		if (!DIMENSIONS.has(input.dimension))
			throw new OutcomeEvidenceValidationError("dimension is invalid");
		clauses.push("dimension = ?");
		params.push(input.dimension);
	}
	if (input.evidenceType != null) {
		if (!EVIDENCE_TYPES.has(input.evidenceType))
			throw new OutcomeEvidenceValidationError("evidenceType is invalid");
		clauses.push("evidence_type = ?");
		params.push(input.evidenceType);
	}
	const after = timestamp(input.observedAtOrAfter, "observedAtOrAfter");
	const before = timestamp(input.observedAtOrBefore, "observedAtOrBefore");
	if (after != null && before != null && after > before)
		throw new OutcomeEvidenceValidationError("observedAtOrAfter cannot follow observedAtOrBefore");
	if (after != null) {
		clauses.push("observed_at >= ?");
		params.push(after);
	}
	if (before != null) {
		clauses.push("observed_at <= ?");
		params.push(before);
	}
	const limit = positiveInteger(
		input.limit ?? DEFAULT_OUTCOME_EVIDENCE_QUERY_LIMIT,
		"limit",
		MAX_OUTCOME_EVIDENCE_QUERY_LIMIT,
	);
	const evidence: OutcomeEvidenceRecord[] = [];
	let cursor: { observed_at: string; evidence_id: string } | null = null;
	while (evidence.length < limit) {
		const pageClauses = [...clauses];
		const pageParams = [...params];
		if (cursor != null) {
			pageClauses.push("(observed_at < ? OR (observed_at = ? AND evidence_id < ?))");
			pageParams.push(cursor.observed_at, cursor.observed_at, cursor.evidence_id);
		}
		const pageWhere = pageClauses.length === 0 ? "" : ` WHERE ${pageClauses.join(" AND ")}`;
		const rows = db
			.prepare(
				`SELECT evidence_id, observed_at FROM outcome_evidence${pageWhere} ORDER BY observed_at DESC, evidence_id DESC LIMIT ?`,
			)
			.all(...pageParams, OUTCOME_EVIDENCE_QUERY_BATCH_SIZE) as Array<{
			evidence_id: SqlValue;
			observed_at: SqlValue;
		}>;
		for (const row of rows) {
			if (typeof row.evidence_id !== "string") continue;
			const record = read(db, row.evidence_id);
			if (record != null) evidence.push(record);
			if (evidence.length === limit) break;
		}
		if (rows.length < OUTCOME_EVIDENCE_QUERY_BATCH_SIZE || evidence.length === limit) break;
		const last = rows.at(-1);
		if (
			last == null ||
			typeof last.observed_at !== "string" ||
			typeof last.evidence_id !== "string"
		)
			break;
		cursor = { observed_at: last.observed_at, evidence_id: last.evidence_id };
	}
	return evidence;
}

export function purgeExpiredOutcomeEvidence(
	db: Database,
	now: string = new Date().toISOString(),
): number {
	const canonicalNow = requiredTimestamp(now, "now");
	// Contract v1 defines these retention fields; future versions own their expiry semantics.
	return purgeOutcomeEvidenceWhere(
		db,
		"contract_version = ? AND retention_pinned = 0 AND retention_until IS NOT NULL AND retention_until <= ?",
		[OUTCOME_EVIDENCE_CONTRACT_VERSION, canonicalNow],
	);
}

export type OutcomeEvidencePrivacyPurgeSelector =
	| { sessionId: number; source?: never; streamId?: never }
	| { sessionId?: never; source: string; streamId: string };

export function purgeOutcomeEvidenceForPrivacy(
	db: Database,
	selector: OutcomeEvidencePrivacyPurgeSelector,
): number {
	// Explicit privacy deletion applies across versions, including rows this reader cannot interpret.
	if (selector.sessionId != null) {
		return purgeOutcomeEvidenceWhere(db, "session_id = ?", [
			nonNegativeInteger(selector.sessionId, "sessionId") as number,
		]);
	}
	return purgeOutcomeEvidenceWhere(db, "source = ? AND stream_id = ?", [
		stableCode(selector.source, "source"),
		stableCode(selector.streamId, "streamId"),
	]);
}

function purgeOutcomeEvidenceWhere(
	db: Database,
	whereClause: string,
	params: Array<string | number>,
): number {
	return db
		.transaction(() => {
			const hasAssessments =
				db
					.prepare(
						"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attribution_assessments'",
					)
					.get() !== undefined;
			const hasLinks =
				db
					.prepare(
						"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attribution_assessment_evidence'",
					)
					.get() !== undefined;
			if (hasAssessments && hasLinks) {
				const dependentAssessments = db
					.prepare(
						`SELECT DISTINCT links.assessment_id
						 FROM attribution_assessment_evidence links
						 WHERE links.evidence_id IN (
							SELECT evidence_id FROM outcome_evidence WHERE ${whereClause}
						 )`,
					)
					.all(...params) as Array<{ assessment_id: string }>;
				const deleteAssessment = db.prepare(
					"DELETE FROM attribution_assessments WHERE assessment_id = ?",
				);
				const deleteAssessmentLinks = db.prepare(
					"DELETE FROM attribution_assessment_evidence WHERE assessment_id = ?",
				);
				for (const row of dependentAssessments) {
					deleteAssessment.run(row.assessment_id);
					deleteAssessmentLinks.run(row.assessment_id);
				}
			}
			if (hasLinks) {
				db.prepare(
					`DELETE FROM attribution_assessment_evidence WHERE evidence_id IN (
						SELECT evidence_id FROM outcome_evidence WHERE ${whereClause}
					)`,
				).run(...params);
			}
			return db.prepare(`DELETE FROM outcome_evidence WHERE ${whereClause}`).run(...params).changes;
		})
		.immediate();
}

interface CollectorBase {
	evidenceId: string;
	observedAt: string;
	producer: string;
	producerVersion: string;
	correlation?: Partial<
		Pick<
			RecordOutcomeEvidenceInput,
			| "sessionId"
			| "source"
			| "streamId"
			| "sourceSessionId"
			| "promptNumber"
			| "rawEventStartSeq"
			| "rawEventEndSeq"
			| "experimentId"
			| "experimentCellId"
			| "windowStartAt"
			| "windowEndAt"
		>
	>;
}

export function deterministicCheckEvidence(
	input: CollectorBase & {
		check: "task_assertion" | "test_result" | "typecheck_result" | "lint_result" | "build_result";
		checkId: string;
		status: Extract<OutcomeEvidenceStatus, "pass" | "fail" | "mixed" | "unknown">;
		counts?: { passed?: number; failed?: number; skipped?: number; total?: number };
	},
): RecordOutcomeEvidenceInput {
	validateUnknownCheckOutcomeCounts(
		input.status,
		input.counts?.passed,
		input.counts?.failed,
		input.counts?.total,
	);
	validatePassingCheckFailedCount(input.status, input.counts?.failed);
	validateFailingCheckFailedCount(input.status, input.counts?.failed);
	validateCheckCountsDoNotExceedTotal(
		input.counts?.passed,
		input.counts?.failed,
		input.counts?.skipped,
		input.counts?.total,
	);
	validateFailingCheckAccountedCounts(
		input.status,
		input.counts?.passed,
		input.counts?.failed,
		input.counts?.skipped,
		input.counts?.total,
	);
	validateMixedCheckOutcomeCounts(
		input.status,
		input.counts?.passed,
		input.counts?.failed,
		input.counts?.skipped,
		input.counts?.total,
	);
	return {
		...input.correlation,
		evidenceId: input.evidenceId,
		dimension: "quality",
		evidenceType: `quality.${input.check}`,
		sourceClass: "observed",
		observedAt: input.observedAt,
		producer: input.producer,
		producerVersion: input.producerVersion,
		status: input.status,
		references: {
			check_id: input.checkId,
			passed_count: input.counts?.passed,
			failed_count: input.counts?.failed,
			skipped_count: input.counts?.skipped,
			total_count: input.counts?.total,
		},
	};
}

export function evaluationAssertionEvidence(
	input: CollectorBase & {
		assertionId: string;
		rubricId: string;
		fixtureId?: string;
		checkoutId?: string;
		status: Extract<OutcomeEvidenceStatus, "pass" | "fail" | "mixed" | "unknown">;
	},
): RecordOutcomeEvidenceInput {
	validateBlindedEvaluatorStatus(input.status);
	return {
		...input.correlation,
		evidenceId: input.evidenceId,
		dimension: "quality",
		evidenceType: "quality.blinded_evaluator",
		sourceClass: "evaluator",
		observedAt: input.observedAt,
		producer: input.producer,
		producerVersion: input.producerVersion,
		status: input.status,
		references: {
			assertion_id: input.assertionId,
			rubric_id: input.rubricId,
			fixture_id: input.fixtureId,
			checkout_id: input.checkoutId,
		},
	};
}

export function efficiencyEvidence(
	input: CollectorBase & {
		evidenceType: Extract<OutcomeEvidenceType, `efficiency.${string}`>;
		value: number;
	},
): RecordOutcomeEvidenceInput {
	if (!Number.isFinite(input.value) || input.value < 0) {
		throw new OutcomeEvidenceValidationError(
			"efficiency value must be a non-negative finite number",
		);
	}
	const unit: OutcomeValueUnit = input.evidenceType.endsWith("_ms")
		? "milliseconds"
		: input.evidenceType.endsWith("_tokens")
			? "tokens"
			: "count";
	if (unit !== "milliseconds" && !Number.isSafeInteger(input.value)) {
		throw new OutcomeEvidenceValidationError(
			"count and token efficiency values must be safe integers",
		);
	}
	if (Number.isInteger(input.value) && !Number.isSafeInteger(input.value)) {
		throw new OutcomeEvidenceValidationError("integer efficiency values must be safe integers");
	}
	const value: OutcomeValue = Number.isSafeInteger(input.value)
		? {
				type: "integer",
				value: input.value,
				unit: unit as Exclude<OutcomeValueUnit, "ratio">,
			}
		: { type: "real", value: input.value, unit };
	return {
		...input.correlation,
		evidenceId: input.evidenceId,
		dimension: "efficiency",
		evidenceType: input.evidenceType,
		sourceClass: "observed",
		observedAt: input.observedAt,
		producer: input.producer,
		producerVersion: input.producerVersion,
		status: "present",
		value,
	};
}

export function sourceLocationOverlapEvidence(
	input: CollectorBase & {
		retrievedPaths: string[];
		downstreamPaths: string[];
	},
	platform: NodeJS.Platform = process.platform,
): RecordOutcomeEvidenceInput {
	const repositoryPaths = uniqueRepositoryPaths(
		input.retrievedPaths.map((path) => repositoryPath(path, "retrievedPaths")),
		platform,
	);
	const downstreamPaths = input.downstreamPaths.map((path) =>
		repositoryPath(path, "downstreamPaths"),
	);
	const matchedPaths = repositoryPaths.filter((path) =>
		downstreamPaths.some((candidate) => sameRepositoryPath(path, candidate, platform)),
	);
	return {
		...input.correlation,
		evidenceId: input.evidenceId,
		dimension: "mechanism",
		evidenceType: "mechanism.source_location_match",
		sourceClass: "derived",
		observedAt: input.observedAt,
		producer: input.producer,
		producerVersion: input.producerVersion,
		status: "present",
		value: { type: "integer", value: matchedPaths.length, unit: "count" },
		references: { repository_paths: repositoryPaths, matched_paths: matchedPaths },
	};
}

export function groundedStaleEvidence(
	input: CollectorBase & {
		checkoutId?: string;
		adjudicationId?: string;
		referenceCodes?: string[];
	},
): RecordOutcomeEvidenceInput {
	return {
		...input.correlation,
		evidenceId: input.evidenceId,
		dimension: "safety",
		evidenceType: "safety.stale_guidance",
		sourceClass: input.adjudicationId == null ? "derived" : "evaluator",
		observedAt: input.observedAt,
		producer: input.producer,
		producerVersion: input.producerVersion,
		status: "present",
		references: {
			checkout_id: input.checkoutId,
			adjudication_id: input.adjudicationId,
			reference_codes: input.referenceCodes,
		},
	};
}

export function explicitFeedbackEvidence(
	input: CollectorBase & {
		feedback: "helpful" | "irrelevant" | "stale" | "harmful" | "correction";
		actionId: string;
		gate: "structured_action" | "unambiguous_instruction";
		referenceCodes?: string[];
	},
): RecordOutcomeEvidenceInput {
	return {
		...input.correlation,
		evidenceId: input.evidenceId,
		dimension: "feedback",
		evidenceType: `feedback.explicit_${input.feedback}`,
		sourceClass: "user_reported",
		observedAt: input.observedAt,
		producer: input.producer,
		producerVersion: input.producerVersion,
		status: "present",
		references: {
			feedback_action_id: input.actionId,
			feedback_gate: input.gate,
			reference_codes: input.referenceCodes,
		},
	};
}
