import { type Database, tableExists } from "./db.js";
import {
	getOutcomeEvidence,
	type OutcomeDimension,
	type OutcomeEvidenceRecord,
	type OutcomeEvidenceType,
} from "./outcome-evidence.js";
import { getRetrievalAttempt, type RetrievalAttemptRecord } from "./retrieval-ledger.js";

// These pre-writer validation gates define initial v1 semantics. Once production writers are
// enabled, semantic rule changes require a contract version bump.
export const ATTRIBUTION_ASSESSMENT_CONTRACT_VERSION = 1 as const;
export const DEFAULT_ATTRIBUTION_ASSESSMENT_QUERY_LIMIT = 50;
export const MAX_ATTRIBUTION_ASSESSMENT_QUERY_LIMIT = 100;

export type AttributionSubjectType = "attempt" | "exposure";
export type AttributionImpactLabel = "helpful" | "irrelevant" | "stale" | "harmful" | "unknown";
type KnownAttributionImpactLabel = Exclude<AttributionImpactLabel, "unknown">;
export type AttributionBasis =
	| "temporal_followup"
	| "source_location_overlap"
	| "explicit_reference"
	| "content_overlap"
	| "human_review"
	| "blinded_evaluator"
	| "randomized_contrast";
export type AttributionConfidenceLevel = "low" | "medium" | "high";
export type AttributionClaimType = "observational" | "causal";

export interface RecordAttributionAssessmentInput {
	assessmentId: string;
	subjectType?: AttributionSubjectType;
	attemptId: string;
	exposureId?: number | null;
	dimension: OutcomeDimension;
	impactLabel: AttributionImpactLabel;
	basis: AttributionBasis;
	confidenceLevel: AttributionConfidenceLevel;
	method: string;
	methodVersion: string;
	createdAt: string;
	evidenceIds: string[];
	claimType?: AttributionClaimType;
}

export interface AttributionAssessmentRecord {
	assessmentId: string;
	contractVersion: typeof ATTRIBUTION_ASSESSMENT_CONTRACT_VERSION;
	subjectType: AttributionSubjectType;
	attemptId: string;
	exposureId: number | null;
	dimension: OutcomeDimension;
	impactLabel: AttributionImpactLabel;
	basis: AttributionBasis;
	confidenceLevel: AttributionConfidenceLevel;
	method: string;
	methodVersion: string;
	createdAt: string;
	evidenceIds: string[];
	claimType: AttributionClaimType;
}

export interface QueryAttributionAssessmentsInput {
	attemptId?: string;
	attemptIds?: string[];
	subjectType?: AttributionSubjectType;
	dimension?: OutcomeDimension;
	impactLabel?: AttributionImpactLabel;
	limit?: number;
}

export interface AttributionAssessmentQueryPage {
	assessments: AttributionAssessmentRecord[];
	evidence: OutcomeEvidenceRecord[];
	selectedAssessmentIds: string[];
	selectedRowCount: number;
	invalidRowCount: number;
	totalRowCount: number;
}

export type AttributionAssessmentWriteResult = {
	assessment: AttributionAssessmentRecord;
	inserted: boolean;
};
export type AttributionAssessmentWriteOutcome =
	| { ok: true; value: AttributionAssessmentWriteResult }
	| {
			ok: false;
			errorCode: "attribution_assessment_write_failed";
			reason: "invalid_input" | "idempotency_conflict" | "storage_unavailable";
	  };

type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;
interface RandomizedValidationCache {
	cellAttempts: Map<string, RetrievalAttemptRecord[] | null>;
	memoryReferenceAttemptIds: Map<string, Set<string>>;
}
interface RandomizedEvidenceBoundary {
	boundary: number;
	attempt: RetrievalAttemptRecord;
}

const SUBJECT_TYPES = new Set<AttributionSubjectType>(["attempt", "exposure"]);
const DIMENSIONS = new Set<OutcomeDimension>([
	"quality",
	"efficiency",
	"mechanism",
	"safety",
	"feedback",
]);
const IMPACT_LABELS = new Set<AttributionImpactLabel>([
	"helpful",
	"irrelevant",
	"stale",
	"harmful",
	"unknown",
]);
const BASES = new Set<AttributionBasis>([
	"temporal_followup",
	"source_location_overlap",
	"explicit_reference",
	"content_overlap",
	"human_review",
	"blinded_evaluator",
	"randomized_contrast",
]);
const CONFIDENCE_LEVELS = new Set<AttributionConfidenceLevel>(["low", "medium", "high"]);
const CLAIM_TYPES = new Set<AttributionClaimType>(["observational", "causal"]);
const EXPLICIT_TIMESTAMP_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?([Zz]|[+-](\d{2}):?(\d{2}))$/;
const EVIDENCE_TYPE_DIMENSIONS = {
	"quality.task_assertion": "quality",
	"quality.test_result": "quality",
	"quality.typecheck_result": "quality",
	"quality.lint_result": "quality",
	"quality.build_result": "quality",
	"quality.blinded_evaluator": "quality",
	"quality.corrective_followup": "quality",
	"efficiency.elapsed_ms": "efficiency",
	"efficiency.tool_call_count": "efficiency",
	"efficiency.exploration_call_count": "efficiency",
	"efficiency.files_read_count": "efficiency",
	"efficiency.files_read_before_target": "efficiency",
	"efficiency.retrieval_overhead_ms": "efficiency",
	"efficiency.retrieval_overhead_tokens": "efficiency",
	"mechanism.source_location_match": "mechanism",
	"mechanism.memory_reference": "mechanism",
	"mechanism.command_or_constraint_reuse": "mechanism",
	"mechanism.retrieval_followup": "mechanism",
	"safety.stale_guidance": "safety",
	"safety.contradicted_guidance": "safety",
	"safety.wrong_action_followup": "safety",
	"safety.retrieval_noise": "safety",
	"feedback.explicit_helpful": "feedback",
	"feedback.explicit_irrelevant": "feedback",
	"feedback.explicit_stale": "feedback",
	"feedback.explicit_harmful": "feedback",
	"feedback.explicit_correction": "feedback",
} as const satisfies Record<OutcomeEvidenceType, OutcomeDimension>;
const INPUT_KEYS = new Set<keyof RecordAttributionAssessmentInput>([
	"assessmentId",
	"subjectType",
	"attemptId",
	"exposureId",
	"dimension",
	"impactLabel",
	"basis",
	"confidenceLevel",
	"method",
	"methodVersion",
	"createdAt",
	"evidenceIds",
	"claimType",
]);

function uuid(value: string, name: string): string {
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
		throw new Error(`${name} must be a UUID`);
	}
	return value.toLowerCase();
}

function stableCode(value: string, name: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 256 ||
		!/^[a-zA-Z0-9][a-zA-Z0-9._/@:+-]*$/.test(value)
	) {
		throw new Error(`${name} must be a bounded stable identifier`);
	}
	return value;
}

function positiveInteger(value: number, name: string, maximum?: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || (maximum != null && value > maximum)) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function timestamp(value: string, name: string): string {
	const match = EXPLICIT_TIMESTAMP_PATTERN.exec(value);
	if (match == null) {
		throw new Error(`${name} must be an ISO-8601 timestamp with an explicit time zone`);
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
		throw new Error(`${name} must be an ISO-8601 timestamp with an explicit time zone`);
	}
	return new Date(value).toISOString();
}

function normalizedEvidenceIds(value: string[]): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
		throw new Error("evidenceIds must contain from 1 through 100 UUIDs");
	}
	return [...new Set(value.map((id) => uuid(id, "evidenceId")))].sort();
}

function linkedEvidence(
	db: Database,
	ids: string[],
	cache?: Map<string, OutcomeEvidenceRecord>,
): OutcomeEvidenceRecord[] {
	return ids.map((id) => {
		const cached = cache?.get(id);
		if (cached) return cached;
		const evidence = getOutcomeEvidence(db, id);
		if (!evidence) throw new Error(`linked outcome evidence does not exist or is invalid: ${id}`);
		cache?.set(id, evidence);
		return evidence;
	});
}

function referenceCodes(evidence: OutcomeEvidenceRecord[]): Set<string> {
	return new Set(evidence.flatMap((row) => row.references?.reference_codes ?? []));
}

// Persisted attempt delivery is the consumer-boundary authority; per-item disposition and
// handoff status then identify the memories that actually crossed that boundary. Attempt
// assessments may name multiple eligible exposures, while exposure assessments require each
// witness to isolate exactly one eligible exposure.
function eligibleAttributionExposures(
	attempt: RetrievalAttemptRecord,
): RetrievalAttemptRecord["exposures"] {
	if (attempt.deliveryStatus !== "handed_off") return [];
	return attempt.exposures.filter(
		(row) => row.disposition === "selected" && row.handoffStatus === "handed_off",
	);
}

function isolatedAttributionExposure(
	attempt: RetrievalAttemptRecord,
): RetrievalAttemptRecord["exposures"][number] | null {
	const eligible = eligibleAttributionExposures(attempt);
	return attempt.selectedCount === 1 && eligible.length === 1 ? (eligible[0] ?? null) : null;
}

function referencedEligibleExposureIds(
	attempt: RetrievalAttemptRecord,
	evidence: OutcomeEvidenceRecord[],
): Set<number> {
	const codes = referenceCodes(evidence);
	return new Set(
		eligibleAttributionExposures(attempt).flatMap((exposure) =>
			codes.has(`exposure:${exposure.exposureId}`) ||
			(exposure.memoryImportKey != null && codes.has(`memory:${exposure.memoryImportKey}`))
				? [exposure.exposureId]
				: [],
		),
	);
}

function referencesSubject(
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
): boolean {
	const codes = referenceCodes(evidence);
	if (subjectType === "attempt" && codes.has(`attempt:${attempt.attemptId}`)) return true;
	const referenced = referencedEligibleExposureIds(attempt, evidence);
	if (subjectType === "attempt") return referenced.size > 0;
	return exposureId != null && referenced.size === 1 && referenced.has(exposureId);
}

export function referencesAssessmentSubject(
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
): boolean {
	if (referencesSubject(attempt, subjectType, exposureId, evidence)) return true;
	if (subjectType !== "exposure" || exposureId == null) return false;
	const isolated = isolatedAttributionExposure(attempt);
	return (
		isolated?.exposureId === exposureId &&
		referenceCodes(evidence).has(`attempt:${attempt.attemptId}`)
	);
}

function correlates(
	attempt: RetrievalAttemptRecord,
	evidence: OutcomeEvidenceRecord,
	exposureId: number | null,
): boolean {
	const codes = new Set(evidence.references?.reference_codes ?? []);
	if (codes.has(`attempt:${attempt.attemptId}`)) return true;
	if (exposureId != null && codes.has(`exposure:${exposureId}`)) return true;
	if (attempt.sessionId != null && evidence.sessionId === attempt.sessionId) return true;
	if (
		attempt.source != null &&
		attempt.streamId != null &&
		evidence.source === attempt.source &&
		evidence.streamId === attempt.streamId
	)
		return true;
	if (
		attempt.source != null &&
		attempt.sourceSessionId != null &&
		evidence.source === attempt.source &&
		evidence.sourceSessionId === attempt.sourceSessionId
	)
		return true;
	return attempt.experimentId != null && evidence.experimentId === attempt.experimentId;
}

function memoryReferenceAttemptIds(
	db: Database,
	evidence: OutcomeEvidenceRecord,
	memoryImportKey: string,
	cache: RandomizedValidationCache,
): Set<string> {
	const cacheKey = JSON.stringify([evidence.evidenceId, memoryImportKey]);
	const cached = cache.memoryReferenceAttemptIds.get(cacheKey);
	if (cached) return cached;
	const correlationQueries: Array<{ clause: string; params: Array<string | number> }> = [];
	if (evidence.sessionId != null) {
		correlationQueries.push({ clause: "attempts.session_id = ?", params: [evidence.sessionId] });
	}
	if (evidence.source != null && evidence.streamId != null) {
		correlationQueries.push({
			clause: "attempts.source = ? AND attempts.stream_id = ?",
			params: [evidence.source, evidence.streamId],
		});
	}
	if (evidence.source != null && evidence.sourceSessionId != null) {
		correlationQueries.push({
			clause: "attempts.source = ? AND attempts.source_session_id = ?",
			params: [evidence.source, evidence.sourceSessionId],
		});
	}
	if (evidence.experimentId != null) {
		correlationQueries.push({
			clause: "attempts.experiment_id = ?",
			params: [evidence.experimentId],
		});
	}
	const matching = new Set<string>();
	for (const correlation of correlationQueries) {
		const attemptIds = db
			.prepare(
				`SELECT DISTINCT attempts.attempt_id
				 FROM retrieval_attempts AS attempts
				 JOIN retrieval_exposures AS exposures ON exposures.attempt_id = attempts.attempt_id
				 WHERE attempts.contract_version = 1
				   AND attempts.delivery_status = 'handed_off'
				   AND attempts.completed_at IS NOT NULL
				   AND attempts.completed_at <= ?
				   AND exposures.memory_import_key = ?
				   AND exposures.disposition = 'selected'
				   AND exposures.handoff_status = 'handed_off'
				   AND ${correlation.clause}
				 LIMIT 2`,
			)
			.all(evidence.observedAt, memoryImportKey, ...correlation.params) as Array<{
			attempt_id: string;
		}>;
		for (const { attempt_id } of attemptIds) matching.add(attempt_id);
		if (matching.size > 1) break;
	}
	cache.memoryReferenceAttemptIds.set(cacheKey, matching);
	return matching;
}

function hasExactSubjectReference(
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord,
): boolean {
	const codes = new Set(evidence.references?.reference_codes ?? []);
	if (codes.has(`attempt:${attempt.attemptId}`)) {
		return (
			subjectType === "attempt" || isolatedAttributionExposure(attempt)?.exposureId === exposureId
		);
	}
	if (subjectType === "attempt") {
		return eligibleAttributionExposures(attempt).some((row) =>
			codes.has(`exposure:${row.exposureId}`),
		);
	}
	return exposureId != null && codes.has(`exposure:${exposureId}`);
}

function assertUnambiguousSubjectMemoryReferences(
	db: Database,
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
	cache: RandomizedValidationCache,
): void {
	for (const row of evidence) {
		if (hasExactSubjectReference(attempt, subjectType, exposureId, row)) continue;
		const codes = new Set(row.references?.reference_codes ?? []);
		const memoryImportKeys = new Set(
			eligibleAttributionExposures(attempt).flatMap((exposure) =>
				exposure.memoryImportKey != null && codes.has(`memory:${exposure.memoryImportKey}`)
					? [exposure.memoryImportKey]
					: [],
			),
		);
		for (const memoryImportKey of memoryImportKeys) {
			const matchingAttemptIds = memoryReferenceAttemptIds(db, row, memoryImportKey, cache);
			if (matchingAttemptIds.size > 1) {
				throw new Error(
					"memory references must uniquely identify one correlated retrieval attempt",
				);
			}
		}
	}
}

function supportsExposure(
	attempt: RetrievalAttemptRecord,
	exposureId: number,
	evidence: OutcomeEvidenceRecord[],
): boolean {
	const handedOff = eligibleAttributionExposures(attempt);
	if (!handedOff.some((row) => row.exposureId === exposureId)) return false;
	return (
		isolatedAttributionExposure(attempt)?.exposureId === exposureId ||
		evidence.some((row) => referencesSubject(attempt, "exposure", exposureId, [row]))
	);
}

function isQualifiedExplicitFeedback(evidence: OutcomeEvidenceRecord): boolean {
	const gate = evidence.references?.feedback_gate;
	return (
		evidence.sourceClass === "user_reported" &&
		evidence.references?.feedback_action_id != null &&
		(gate === "structured_action" || gate === "unambiguous_instruction")
	);
}

function isGroundedEvaluatorReview(evidence: OutcomeEvidenceRecord): boolean {
	return (
		evidence.sourceClass === "evaluator" &&
		(evidence.references?.rubric_id != null || evidence.references?.adjudication_id != null)
	);
}

// Grounding is checked at assessment time so ungrounded wrong-action rows remain linkable
// diagnostics for unknown assessments. Subject binding identifies the retrieval, not the harm.
function isQualifiedWrongActionFollowup(evidence: OutcomeEvidenceRecord): boolean {
	if (evidence.sourceClass === "evaluator") {
		return isGroundedEvaluatorReview(evidence);
	}
	return (
		(evidence.sourceClass === "observed" || evidence.sourceClass === "derived") &&
		evidence.references?.checkout_id != null
	);
}

function isQualifiedStaleSafetyEvidence(evidence: OutcomeEvidenceRecord): boolean {
	if (evidence.sourceClass === "evaluator") {
		return evidence.references?.adjudication_id != null;
	}
	return (
		(evidence.sourceClass === "observed" || evidence.sourceClass === "derived") &&
		evidence.references?.checkout_id != null
	);
}

function directEvidenceLabel(evidence: OutcomeEvidenceRecord): KnownAttributionImpactLabel | null {
	if (evidence.status !== "present") return null;
	switch (evidence.evidenceType) {
		case "feedback.explicit_helpful":
			return isQualifiedExplicitFeedback(evidence) ? "helpful" : null;
		case "feedback.explicit_irrelevant":
			return isQualifiedExplicitFeedback(evidence) ? "irrelevant" : null;
		case "safety.retrieval_noise":
			return isGroundedEvaluatorReview(evidence) ? "irrelevant" : null;
		case "feedback.explicit_stale":
			return isQualifiedExplicitFeedback(evidence) ? "stale" : null;
		case "safety.stale_guidance":
		case "safety.contradicted_guidance":
			return isQualifiedStaleSafetyEvidence(evidence) ? "stale" : null;
		case "feedback.explicit_harmful":
			return isQualifiedExplicitFeedback(evidence) ? "harmful" : null;
		case "safety.wrong_action_followup":
			return isQualifiedWrongActionFollowup(evidence) ? "harmful" : null;
		default:
			return null;
	}
}

// Attempt subjects allow stable evidence identifiers to pair across cells without subject
// binding; identifier-free rows still have to name the subject. Exposure subjects require every
// participating row, including the comparison cell, to name the assessed exposure so sibling or
// diagnostic exposures cannot isolate a contrast.
function comparisonKey(
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord,
): string | null {
	const namesSubject = referencesAssessmentSubject(attempt, subjectType, exposureId, [evidence]);
	if (subjectType === "exposure" && !namesSubject) return null;
	const identifiers: Array<[string, string]> = [];
	for (const [name, value] of [
		["check", evidence.references?.check_id],
		["assertion", evidence.references?.assertion_id],
		["checkout", evidence.references?.checkout_id],
		["fixture", evidence.references?.fixture_id],
	] as const) {
		if (value != null) identifiers.push([name, value]);
	}
	if (identifiers.length > 0) {
		const rubric = evidence.references?.rubric_id;
		return [
			evidence.evidenceType,
			...identifiers.map(([name, value]) => `${name}:${value}`),
			...(rubric == null ? [] : [`rubric:${rubric}`]),
		].join("|");
	}
	if (!namesSubject) return null;
	return subjectType === "attempt"
		? `${evidence.evidenceType}|attempt:${attempt.attemptId}`
		: `${evidence.evidenceType}|exposure:${exposureId}`;
}

function qualityRank(evidence: OutcomeEvidenceRecord): number | null {
	if (evidence.dimension !== "quality") return null;
	if (evidence.status === "pass") return 2;
	if (evidence.status === "mixed") return 1;
	if (evidence.status === "fail") return 0;
	return null;
}

function hasResolvedGroundedOutcome(evidence: OutcomeEvidenceRecord): boolean {
	if (directEvidenceLabel(evidence) != null) return true;
	return evidence.sourceClass !== "user_reported" && qualityRank(evidence) != null;
}

function isQualityRank(rank: number | null): rank is number {
	return rank != null;
}

function rankRelation(
	attemptRank: number,
	comparisonRank: number,
): Extract<KnownAttributionImpactLabel, "helpful" | "harmful" | "irrelevant"> {
	if (attemptRank > comparisonRank) return "helpful";
	if (attemptRank < comparisonRank) return "harmful";
	return "irrelevant";
}

function hasPositiveQuality(evidence: OutcomeEvidenceRecord): boolean {
	if (
		evidence.dimension !== "quality" ||
		(evidence.status !== "pass" && evidence.status !== "mixed")
	) {
		return false;
	}
	const references = evidence.references;
	if (evidence.sourceClass === "evaluator") {
		return references?.rubric_id != null || references?.adjudication_id != null;
	}
	if (
		evidence.sourceClass !== "observed" &&
		evidence.sourceClass !== "derived" &&
		evidence.sourceClass !== "experiment"
	) {
		return false;
	}
	return (
		references?.check_id != null ||
		references?.checkout_id != null ||
		(references?.assertion_id != null && references.rubric_id != null)
	);
}

function hasActualSourceLocationOverlap(evidence: OutcomeEvidenceRecord): boolean {
	if (
		evidence.evidenceType !== "mechanism.source_location_match" ||
		evidence.status !== "present" ||
		(evidence.sourceClass !== "observed" && evidence.sourceClass !== "derived")
	) {
		return false;
	}
	const matchedPathCount = evidence.references?.matched_paths?.length ?? 0;
	return (
		matchedPathCount > 0 &&
		evidence.value?.type === "integer" &&
		evidence.value.unit === "count" &&
		evidence.value.value === matchedPathCount
	);
}

function attemptCompletionBoundary(attempt: RetrievalAttemptRecord): number | null {
	if (attempt.completedAt == null) return null;
	const boundary = Date.parse(attempt.completedAt);
	return Number.isFinite(boundary) ? boundary : null;
}

function occursAtOrAfterRetrievalCompletion(
	attempt: RetrievalAttemptRecord,
	evidence: OutcomeEvidenceRecord,
): boolean {
	const boundary = attemptCompletionBoundary(attempt);
	return boundary != null && Date.parse(evidence.observedAt) >= boundary;
}

export function isQualifyingSourceLocationWitness(
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord,
): boolean {
	return (
		hasActualSourceLocationOverlap(evidence) &&
		referencesAssessmentSubject(attempt, subjectType, exposureId, [evidence]) &&
		occursAtOrAfterRetrievalCompletion(attempt, evidence)
	);
}

function isQualifyingContentOverlapWitness(
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord,
): boolean {
	return (
		evidence.evidenceType === "mechanism.command_or_constraint_reuse" &&
		(evidence.sourceClass === "observed" || evidence.sourceClass === "derived") &&
		evidence.status === "present" &&
		referencesAssessmentSubject(attempt, subjectType, exposureId, [evidence]) &&
		occursAtOrAfterRetrievalCompletion(attempt, evidence)
	);
}

function randomizedCellAttempts(
	db: Database,
	experimentId: string,
	cell: string,
	cache: RandomizedValidationCache,
): RetrievalAttemptRecord[] | null {
	const cacheKey = JSON.stringify([experimentId, cell]);
	if (cache.cellAttempts.has(cacheKey)) return cache.cellAttempts.get(cacheKey) ?? null;
	const attemptIds = db
		.prepare(
			`SELECT attempt_id FROM retrieval_attempts
			 WHERE experiment_id = ? AND experiment_cell_id = ?
			 ORDER BY attempt_id`,
		)
		.all(experimentId, cell) as Array<{ attempt_id: string }>;
	const attempts = attemptIds.flatMap(({ attempt_id }) => {
		const candidate = getRetrievalAttempt(db, attempt_id);
		return candidate == null ? [] : [candidate];
	});
	const resolved = attempts.length === attemptIds.length ? attempts : null;
	cache.cellAttempts.set(cacheKey, resolved);
	return resolved;
}

function randomizedEvidenceCompletionBoundaries(
	db: Database,
	attempt: RetrievalAttemptRecord,
	evidence: OutcomeEvidenceRecord[],
	cache: RandomizedValidationCache,
): Map<string, RandomizedEvidenceBoundary> | null {
	if (attempt.experimentId == null || attempt.experimentCellId == null) return null;
	const cells = new Set(
		evidence.map((row) => row.experimentCellId).filter((cell): cell is string => cell != null),
	);
	if (cells.size === 0 || evidence.some((row) => row.experimentCellId == null)) return null;

	const attemptsByCell = new Map<string, RetrievalAttemptRecord[]>();
	for (const cell of cells) {
		const cellAttempts = randomizedCellAttempts(db, attempt.experimentId, cell, cache);
		if (cellAttempts == null) return null;
		attemptsByCell.set(cell, cellAttempts);
	}

	const boundaries = new Map<string, RandomizedEvidenceBoundary>();
	for (const row of evidence) {
		const cell = row.experimentCellId;
		if (cell == null) return null;
		const cellAttempts = attemptsByCell.get(cell) ?? [];
		const checkoutId = row.references?.checkout_id;
		const fixtureId = row.references?.fixture_id;
		const correlated = checkoutId != null || fixtureId != null;
		const correlationPossible = cellAttempts.some(
			(candidate) =>
				candidate.evaluationCheckoutId != null || candidate.evaluationFixtureId != null,
		);
		// Replay identities take precedence when the cell carries them. Plain legacy cells retain
		// the singleton fallback even if evidence has an identifier; neither path guesses by order.
		const matches =
			correlated && correlationPossible
				? cellAttempts.filter(
						(candidate) =>
							(checkoutId == null || candidate.evaluationCheckoutId === checkoutId) &&
							(fixtureId == null || candidate.evaluationFixtureId === fixtureId),
					)
				: cellAttempts;
		if (matches.length !== 1) return null;
		const matchedAttempt = matches[0];
		if (matchedAttempt == null) return null;
		if (cell === attempt.experimentCellId && matchedAttempt.attemptId !== attempt.attemptId) {
			return null;
		}
		const boundary = attemptCompletionBoundary(matchedAttempt);
		if (boundary == null) return null;
		boundaries.set(row.evidenceId, { boundary, attempt: matchedAttempt });
	}
	return boundaries;
}

function randomizedEvidenceAfterCellCompletion(
	db: Database,
	attempt: RetrievalAttemptRecord,
	evidence: OutcomeEvidenceRecord[],
	cache: RandomizedValidationCache,
): OutcomeEvidenceRecord[] {
	const boundaries = randomizedEvidenceCompletionBoundaries(db, attempt, evidence, cache);
	if (boundaries == null) return [];
	return evidence.filter((row) => {
		const matched = boundaries.get(row.evidenceId);
		return matched != null && Date.parse(row.observedAt) >= matched.boundary;
	});
}

function randomizedLabelWitnesses(
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
): Map<KnownAttributionImpactLabel, OutcomeEvidenceRecord[]> {
	const witnesses = new Map<KnownAttributionImpactLabel, OutcomeEvidenceRecord[]>();
	const attemptCell = attempt.experimentCellId;
	if (attemptCell == null) return witnesses;
	const comparisons = new Map<string, OutcomeEvidenceRecord[]>();
	for (const row of evidence) {
		const key = comparisonKey(attempt, subjectType, exposureId, row);
		if (key == null) continue;
		comparisons.set(key, [...(comparisons.get(key) ?? []), row]);
	}
	for (const rows of comparisons.values()) {
		// A stable comparison key is a closed unit: no row may be discarded merely because its
		// rank is unknown or contradicts the relation established by neighboring rows.
		const attemptRows = rows.filter((row) => row.experimentCellId === attemptCell);
		const comparisonRows = rows.filter((row) => row.experimentCellId !== attemptCell);
		if (attemptRows.length === 0 || comparisonRows.length === 0) continue;
		const attemptRanks = attemptRows.map(qualityRank).filter(isQualityRank);
		const comparisonRanks = comparisonRows.map(qualityRank).filter(isQualityRank);
		if (
			attemptRanks.length !== attemptRows.length ||
			comparisonRanks.length !== comparisonRows.length
		) {
			continue;
		}
		const attemptRank = attemptRanks.at(0);
		if (attemptRank == null || attemptRanks.some((rank) => rank !== attemptRank)) continue;
		const relations = comparisonRanks.map((rank) => rankRelation(attemptRank, rank));
		const relation = relations.at(0);
		if (relation == null || relations.some((candidate) => candidate !== relation)) continue;
		witnesses.set(relation, [
			...(witnesses.get(relation) ?? []),
			...attemptRows,
			...comparisonRows,
		]);
	}
	return witnesses;
}

function randomizedContrastWitnesses(
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
): OutcomeEvidenceRecord[] {
	// Prerequisites belong to the exact rows establishing the contrast. Requiring them on every
	// participating cell prevents an auxiliary row from laundering a partial experiment contract.
	const byId = new Map<string, OutcomeEvidenceRecord>();
	for (const rows of randomizedLabelWitnesses(
		attempt,
		subjectType,
		exposureId,
		evidence,
	).values()) {
		for (const row of rows) byId.set(row.evidenceId, row);
	}
	return [...byId.values()];
}

function randomizedLabelSupport(
	db: Database,
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
	cache: RandomizedValidationCache,
): Set<KnownAttributionImpactLabel> {
	return new Set(
		randomizedLabelWitnesses(
			attempt,
			subjectType,
			exposureId,
			randomizedEvidenceAfterCellCompletion(db, attempt, evidence, cache),
		).keys(),
	);
}

function observationalLabelSupport(
	input: Pick<RecordAttributionAssessmentInput, "subjectType">,
	evidence: OutcomeEvidenceRecord[],
): Set<KnownAttributionImpactLabel> {
	const support = new Set(
		evidence
			.map(directEvidenceLabel)
			.filter((label): label is KnownAttributionImpactLabel => label != null),
	);
	const hasSourceLocationMatch = evidence.some(hasActualSourceLocationOverlap);
	const positiveQuality = evidence.some(hasPositiveQuality);
	if (input.subjectType === "exposure" && hasSourceLocationMatch && positiveQuality) {
		support.add("helpful");
	}
	return support;
}

function observationalLabelEvidence(
	input: Pick<RecordAttributionAssessmentInput, "impactLabel" | "subjectType">,
	evidence: OutcomeEvidenceRecord[],
): OutcomeEvidenceRecord[] {
	const hasExposureHelpfulSupport =
		input.subjectType === "exposure" &&
		input.impactLabel === "helpful" &&
		evidence.some(hasActualSourceLocationOverlap) &&
		evidence.some(hasPositiveQuality);
	return evidence.filter((row) => {
		if (directEvidenceLabel(row) === input.impactLabel) return true;
		return (
			hasExposureHelpfulSupport && (hasActualSourceLocationOverlap(row) || hasPositiveQuality(row))
		);
	});
}

function subjectLabelEvidence(
	input: Pick<RecordAttributionAssessmentInput, "impactLabel" | "subjectType">,
	attempt: RetrievalAttemptRecord,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
): OutcomeEvidenceRecord[] {
	return observationalLabelEvidence(
		input,
		evidence.filter(
			(row) =>
				referencesAssessmentSubject(attempt, input.subjectType ?? "attempt", exposureId, [row]) &&
				occursAtOrAfterRetrievalCompletion(attempt, row),
		),
	);
}

function supportsLabel(
	db: Database,
	input: Pick<RecordAttributionAssessmentInput, "impactLabel" | "basis" | "subjectType">,
	attempt: RetrievalAttemptRecord,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
	cache: RandomizedValidationCache,
): boolean {
	const support =
		input.basis === "randomized_contrast"
			? randomizedLabelSupport(
					db,
					attempt,
					input.subjectType ?? "attempt",
					exposureId,
					evidence,
					cache,
				)
			: observationalLabelSupport(
					input,
					evidence.filter(
						(row) =>
							referencesAssessmentSubject(attempt, input.subjectType ?? "attempt", exposureId, [
								row,
							]) && occursAtOrAfterRetrievalCompletion(attempt, row),
					),
				);
	if (input.impactLabel === "unknown") return support.size !== 1;
	if (input.basis === "temporal_followup") return false;
	return support.size === 1 && support.has(input.impactLabel);
}

function assertRandomizedContrast(
	db: Database,
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
	cache: RandomizedValidationCache,
): void {
	const eligibleEvidence = randomizedEvidenceAfterCellCompletion(db, attempt, evidence, cache);
	const cells = new Set(
		eligibleEvidence
			.map((row) => row.experimentCellId)
			.filter((cell): cell is string => cell != null),
	);
	const witnesses = randomizedContrastWitnesses(attempt, subjectType, exposureId, eligibleEvidence);
	if (
		attempt.experimentId == null ||
		attempt.experimentCellId == null ||
		eligibleEvidence.length !== evidence.length ||
		cells.size < 2 ||
		!cells.has(attempt.experimentCellId) ||
		witnesses.length === 0 ||
		evidence.some(
			(row) =>
				row.sourceClass !== "experiment" ||
				row.experimentId !== attempt.experimentId ||
				row.experimentCellId == null,
		) ||
		witnesses.some(
			(row) => !(row.references?.reference_codes ?? []).includes("experiment.preregistered"),
		)
	) {
		throw new Error(
			"randomized_contrast requires a preregistered experiment with a stable matched outcome pair across the attempt and comparison cells",
		);
	}
}

function basisWitnesses(
	db: Database,
	basis: AttributionBasis,
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
	cache: RandomizedValidationCache,
): OutcomeEvidenceRecord[] {
	// Non-randomized attribution describes downstream evidence from this retrieval. Linked rows
	// observed earlier remain useful correlation diagnostics, but cannot witness the basis. The
	// experiment contract intentionally owns randomized timing semantics separately.
	const eligibleEvidence =
		basis === "randomized_contrast"
			? randomizedEvidenceAfterCellCompletion(db, attempt, evidence, cache)
			: evidence.filter((row) => occursAtOrAfterRetrievalCompletion(attempt, row));
	switch (basis) {
		case "explicit_reference":
			return eligibleEvidence.filter(
				(row) =>
					((row.evidenceType === "mechanism.memory_reference" && row.status === "present") ||
						row.evidenceType.startsWith("feedback.")) &&
					referencesAssessmentSubject(attempt, subjectType, exposureId, [row]),
			);
		case "content_overlap":
			return eligibleEvidence.filter((row) =>
				isQualifyingContentOverlapWitness(attempt, subjectType, exposureId, row),
			);
		case "human_review":
			return eligibleEvidence.filter(
				(row) =>
					isGroundedEvaluatorReview(row) &&
					referencesAssessmentSubject(attempt, subjectType, exposureId, [row]),
			);
		case "source_location_overlap":
			return eligibleEvidence.filter((row) =>
				isQualifyingSourceLocationWitness(attempt, subjectType, exposureId, row),
			);
		case "blinded_evaluator":
			return eligibleEvidence.filter(
				(row) =>
					row.evidenceType === "quality.blinded_evaluator" &&
					row.sourceClass === "evaluator" &&
					referencesAssessmentSubject(attempt, subjectType, exposureId, [row]),
			);
		case "temporal_followup":
			return eligibleEvidence.filter(
				(row) =>
					row.evidenceType === "mechanism.retrieval_followup" &&
					row.status === "present" &&
					referencesAssessmentSubject(attempt, subjectType, exposureId, [row]),
			);
		case "randomized_contrast":
			return randomizedContrastWitnesses(attempt, subjectType, exposureId, eligibleEvidence);
	}
}

function assertSupportingDimension(
	db: Database,
	input: RecordAttributionAssessmentInput,
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
	cache: RandomizedValidationCache,
): void {
	const labelWitnesses =
		input.impactLabel === "unknown"
			? []
			: input.basis === "randomized_contrast"
				? (randomizedLabelWitnesses(
						attempt,
						subjectType,
						exposureId,
						randomizedEvidenceAfterCellCompletion(db, attempt, evidence, cache),
					).get(input.impactLabel) ?? [])
				: subjectLabelEvidence({ ...input, subjectType }, attempt, exposureId, evidence);
	const witnesses = [
		...labelWitnesses,
		...basisWitnesses(db, input.basis, attempt, subjectType, exposureId, evidence, cache),
	];
	if (!witnesses.some((row) => EVIDENCE_TYPE_DIMENSIONS[row.evidenceType] === input.dimension)) {
		throw new Error("assessment dimension must be represented by supporting evidence");
	}
}

function assertBasis(
	db: Database,
	input: RecordAttributionAssessmentInput,
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
	cache: RandomizedValidationCache,
): void {
	const witnesses = basisWitnesses(
		db,
		input.basis,
		attempt,
		subjectType,
		exposureId,
		evidence,
		cache,
	);
	if (input.basis === "explicit_reference" && witnesses.length === 0) {
		throw new Error(
			"explicit_reference requires allowed evidence naming the exact assessment subject",
		);
	}
	if (
		input.basis === "content_overlap" &&
		!evidence.some((row) => row.evidenceType === "mechanism.command_or_constraint_reuse")
	) {
		throw new Error("content_overlap requires linked command-or-constraint reuse evidence");
	}
	if (input.basis === "content_overlap" && witnesses.length === 0) {
		throw new Error(
			"content_overlap requires linked post-retrieval command-or-constraint reuse evidence naming the assessment subject",
		);
	}
	if (input.basis === "human_review" && witnesses.length === 0) {
		throw new Error(
			"human_review requires linked grounded evaluator evidence naming the assessment subject",
		);
	}
	if (input.basis === "source_location_overlap" && witnesses.length === 0) {
		const subjectBoundOverlap = evidence.filter(
			(row) =>
				hasActualSourceLocationOverlap(row) &&
				referencesAssessmentSubject(attempt, subjectType, exposureId, [row]),
		);
		if (
			subjectBoundOverlap.length > 0 &&
			subjectBoundOverlap.every((row) => !occursAtOrAfterRetrievalCompletion(attempt, row))
		) {
			throw new Error("source_location_overlap evidence must occur after retrieval completion");
		}
		throw new Error(
			"source_location_overlap requires linked evidence with an actual overlap naming the assessment subject",
		);
	}
	if (input.basis === "blinded_evaluator" && witnesses.length === 0) {
		throw new Error(
			"blinded_evaluator requires linked evaluator-provenance evidence naming the assessment subject",
		);
	}
	if (
		input.basis === "temporal_followup" &&
		!evidence.some((row) => row.evidenceType === "mechanism.retrieval_followup")
	) {
		throw new Error("temporal_followup requires linked followup evidence");
	}
	if (input.basis === "temporal_followup" && witnesses.length === 0) {
		throw new Error(
			"temporal_followup requires linked followup evidence naming the assessment subject",
		);
	}
	if (
		input.basis === "randomized_contrast" &&
		evidence.some((row) => row.sourceClass !== "experiment")
	) {
		throw new Error("randomized_contrast requires only linked experiment evidence");
	}
	if (input.basis === "randomized_contrast") {
		assertRandomizedContrast(db, attempt, subjectType, exposureId, evidence, cache);
	}
}

function assertHighConfidenceSupport(
	db: Database,
	input: RecordAttributionAssessmentInput,
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
	cache: RandomizedValidationCache,
): void {
	if (input.confidenceLevel !== "high") return;
	const witnesses = basisWitnesses(
		db,
		input.basis,
		attempt,
		subjectType,
		exposureId,
		evidence,
		cache,
	);
	// The human-review and blinded-evaluator witness selectors already enforce evaluator provenance.
	const hasGroundedEvaluatorOutcome = witnesses.some(hasResolvedGroundedOutcome);
	const hasStrongSupport =
		input.basis === "randomized_contrast" ||
		(input.basis === "human_review" && hasGroundedEvaluatorOutcome) ||
		(input.basis === "blinded_evaluator" && hasGroundedEvaluatorOutcome) ||
		(input.basis === "explicit_reference" &&
			witnesses.some((row) => directEvidenceLabel(row) != null));
	if (!hasStrongSupport) {
		throw new Error(
			"high confidence requires grounded direct evidence, strong adjudication, or a preregistered randomized contrast",
		);
	}
}

function assertCausalGate(
	db: Database,
	claimType: AttributionClaimType,
	basis: AttributionBasis,
	attempt: RetrievalAttemptRecord,
	subjectType: AttributionSubjectType,
	exposureId: number | null,
	evidence: OutcomeEvidenceRecord[],
	cache: RandomizedValidationCache,
): void {
	if (claimType === "observational") return;
	if (basis !== "randomized_contrast") {
		throw new Error(
			"causal claims require a linked preregistered randomized contrast with complete retained cells and uncertainty",
		);
	}
	assertRandomizedContrast(db, attempt, subjectType, exposureId, evidence, cache);
	const witnesses = randomizedContrastWitnesses(
		attempt,
		subjectType,
		exposureId,
		randomizedEvidenceAfterCellCompletion(db, attempt, evidence, cache),
	);
	const matchedBoundaries = randomizedEvidenceCompletionBoundaries(db, attempt, witnesses, cache);
	if (
		matchedBoundaries == null ||
		[...matchedBoundaries.values()].some((matched) => !matched.attempt.retentionPinned) ||
		witnesses.some(
			(row) =>
				!row.retentionPinned ||
				!(row.references?.reference_codes ?? []).includes("experiment.cells_complete") ||
				!(row.references?.reference_codes ?? []).includes("experiment.uncertainty_reported"),
		)
	) {
		throw new Error(
			"causal claims require a linked preregistered randomized contrast with complete retained cells and uncertainty",
		);
	}
}

function canonical(
	db: Database,
	input: RecordAttributionAssessmentInput,
	evidenceCache?: Map<string, OutcomeEvidenceRecord>,
): SqlRow {
	for (const key of Object.keys(input)) {
		if (!INPUT_KEYS.has(key as keyof RecordAttributionAssessmentInput)) {
			throw new Error(`attribution assessment contains unsupported key: ${key}`);
		}
	}
	const subjectType = input.subjectType ?? "attempt";
	const claimType = input.claimType ?? "observational";
	if (!SUBJECT_TYPES.has(subjectType) || !DIMENSIONS.has(input.dimension)) {
		throw new Error("assessment subject or dimension is invalid");
	}
	if (
		!IMPACT_LABELS.has(input.impactLabel) ||
		!BASES.has(input.basis) ||
		!CONFIDENCE_LEVELS.has(input.confidenceLevel) ||
		!CLAIM_TYPES.has(claimType)
	) {
		throw new Error("assessment label, basis, confidence, or claim type is invalid");
	}
	const attemptId = uuid(input.attemptId, "attemptId");
	const attempt = getRetrievalAttempt(db, attemptId);
	if (!attempt) throw new Error("retrieval attempt does not exist or is invalid");
	const exposureId =
		input.exposureId == null ? null : positiveInteger(input.exposureId, "exposureId");
	const evidenceIds = normalizedEvidenceIds(input.evidenceIds);
	const evidence = linkedEvidence(db, evidenceIds, evidenceCache);
	const randomizedCache: RandomizedValidationCache = {
		cellAttempts: new Map(),
		memoryReferenceAttemptIds: new Map(),
	};
	const createdAt = timestamp(input.createdAt, "createdAt");
	const completionBoundary = attemptCompletionBoundary(attempt);
	if (completionBoundary == null) {
		throw new Error("attribution requires a reliable retrieval completion boundary");
	}
	if (Date.parse(createdAt) < completionBoundary) {
		throw new Error("assessment creation must not predate retrieval completion");
	}
	if (evidence.some((row) => Date.parse(row.observedAt) > Date.parse(createdAt))) {
		throw new Error("assessment creation must not predate linked evidence");
	}
	if (evidence.some((row) => !correlates(attempt, row, exposureId))) {
		throw new Error("linked outcome evidence must correlate to the assessment subject");
	}
	if (subjectType === "attempt" && exposureId != null) {
		throw new Error("attempt assessments must not include exposureId");
	}
	if (subjectType === "attempt" && eligibleAttributionExposures(attempt).length === 0) {
		throw new Error("attempt assessments require a confirmed selected handoff");
	}
	if (input.impactLabel !== "unknown" && input.basis !== "randomized_contrast") {
		assertUnambiguousSubjectMemoryReferences(
			db,
			attempt,
			subjectType,
			exposureId,
			evidence,
			randomizedCache,
		);
	}
	if (
		subjectType === "attempt" &&
		input.impactLabel !== "unknown" &&
		input.basis !== "randomized_contrast" &&
		!referencesAssessmentSubject(attempt, subjectType, exposureId, evidence)
	) {
		throw new Error("known attempt attribution requires linked evidence naming the attempt");
	}
	if (
		subjectType === "exposure" &&
		(exposureId == null || !supportsExposure(attempt, exposureId, evidence))
	) {
		throw new Error("exposure assessment failed the documented isolation gate");
	}
	if (
		!supportsLabel(db, { ...input, subjectType }, attempt, exposureId, evidence, randomizedCache)
	) {
		throw new Error(`linked evidence does not support ${input.impactLabel} attribution`);
	}
	assertBasis(db, input, attempt, subjectType, exposureId, evidence, randomizedCache);
	assertHighConfidenceSupport(
		db,
		input,
		attempt,
		subjectType,
		exposureId,
		evidence,
		randomizedCache,
	);
	assertSupportingDimension(db, input, attempt, subjectType, exposureId, evidence, randomizedCache);
	assertCausalGate(
		db,
		claimType,
		input.basis,
		attempt,
		subjectType,
		exposureId,
		evidence,
		randomizedCache,
	);
	return {
		assessment_id: uuid(input.assessmentId, "assessmentId"),
		contract_version: ATTRIBUTION_ASSESSMENT_CONTRACT_VERSION,
		subject_type: subjectType,
		attempt_id: attemptId,
		exposure_id: exposureId,
		dimension: input.dimension,
		impact_label: input.impactLabel,
		basis: input.basis,
		confidence_level: input.confidenceLevel,
		method: stableCode(input.method, "method"),
		method_version: stableCode(input.methodVersion, "methodVersion"),
		created_at: createdAt,
		claim_type: claimType,
	};
}

function evidenceIds(db: Database, assessmentId: string): string[] {
	return (
		db
			.prepare(
				"SELECT evidence_id FROM attribution_assessment_evidence WHERE assessment_id = ? ORDER BY evidence_id",
			)
			.all(assessmentId) as Array<{ evidence_id: string }>
	).map((row) => row.evidence_id);
}

function hasAttributionAssessmentSchema(db: Database): boolean {
	return (
		tableExists(db, "attribution_assessments") && tableExists(db, "attribution_assessment_evidence")
	);
}

function emptyAttributionAssessmentPage(): AttributionAssessmentQueryPage {
	return {
		assessments: [],
		evidence: [],
		selectedAssessmentIds: [],
		selectedRowCount: 0,
		invalidRowCount: 0,
		totalRowCount: 0,
	};
}

function read(
	db: Database,
	assessmentId: string,
	evidenceCache?: Map<string, OutcomeEvidenceRecord>,
	schemaChecked = false,
): AttributionAssessmentRecord | null {
	if (!schemaChecked && !hasAttributionAssessmentSchema(db)) return null;
	const row = db
		.prepare("SELECT * FROM attribution_assessments WHERE assessment_id = ?")
		.get(assessmentId) as SqlRow | undefined;
	if (!row) return null;
	const ids = evidenceIds(db, assessmentId);
	try {
		const input: RecordAttributionAssessmentInput = {
			assessmentId: String(row.assessment_id),
			subjectType: row.subject_type as AttributionSubjectType,
			attemptId: String(row.attempt_id),
			exposureId: row.exposure_id as number | null,
			dimension: row.dimension as OutcomeDimension,
			impactLabel: row.impact_label as AttributionImpactLabel,
			basis: row.basis as AttributionBasis,
			confidenceLevel: row.confidence_level as AttributionConfidenceLevel,
			method: String(row.method),
			methodVersion: String(row.method_version),
			createdAt: String(row.created_at),
			evidenceIds: ids,
			claimType: row.claim_type as AttributionClaimType,
		};
		const checked = canonical(db, input, evidenceCache);
		if (!Object.entries(checked).every(([key, value]) => row[key] === value)) return null;
		return {
			assessmentId: checked.assessment_id as string,
			contractVersion: ATTRIBUTION_ASSESSMENT_CONTRACT_VERSION,
			subjectType: checked.subject_type as AttributionSubjectType,
			attemptId: checked.attempt_id as string,
			exposureId: checked.exposure_id as number | null,
			dimension: checked.dimension as OutcomeDimension,
			impactLabel: checked.impact_label as AttributionImpactLabel,
			basis: checked.basis as AttributionBasis,
			confidenceLevel: checked.confidence_level as AttributionConfidenceLevel,
			method: checked.method as string,
			methodVersion: checked.method_version as string,
			createdAt: checked.created_at as string,
			evidenceIds: ids,
			claimType: checked.claim_type as AttributionClaimType,
		};
	} catch {
		return null;
	}
}

function rowsEqual(left: SqlRow, right: SqlRow): boolean {
	return Object.entries(left).every(([key, value]) => right[key] === value);
}

export function getAttributionAssessment(
	db: Database,
	assessmentId: string,
): AttributionAssessmentRecord | null {
	return read(db, uuid(assessmentId, "assessmentId"));
}

export function recordAttributionAssessment(
	db: Database,
	input: RecordAttributionAssessmentInput,
): AttributionAssessmentWriteResult {
	const row = canonical(db, input);
	const ids = normalizedEvidenceIds(input.evidenceIds);
	const inserted = db
		.transaction(() => {
			const existing = db
				.prepare("SELECT * FROM attribution_assessments WHERE assessment_id = ?")
				.get(row.assessment_id) as SqlRow | undefined;
			if (existing) {
				if (
					!rowsEqual(row, existing) ||
					JSON.stringify(ids) !== JSON.stringify(evidenceIds(db, String(row.assessment_id)))
				) {
					throw new Error("attribution assessment retry conflicts with persisted data");
				}
				return false;
			}
			const columns = Object.keys(row);
			db.prepare(
				`INSERT INTO attribution_assessments (${columns.join(", ")}) VALUES (${columns.map((key) => `@${key}`).join(", ")})`,
			).run(row);
			const link = db.prepare(
				"INSERT INTO attribution_assessment_evidence(assessment_id, evidence_id) VALUES (?, ?)",
			);
			for (const id of ids) link.run(row.assessment_id, id);
			return true;
		})
		.immediate();
	const assessment = read(db, String(row.assessment_id));
	if (!assessment) throw new Error("attribution assessment was not persisted safely");
	return { assessment, inserted };
}

export function tryRecordAttributionAssessment(
	db: Database,
	input: RecordAttributionAssessmentInput,
): AttributionAssessmentWriteOutcome {
	try {
		return { ok: true, value: recordAttributionAssessment(db, input) };
	} catch (error) {
		const message = error instanceof Error ? error.message.toLowerCase() : "";
		const reason = message.includes("conflict")
			? "idempotency_conflict"
			: /(must|require|invalid|unsupported|does not exist|failed the|does not support|cannot|correlate|must occur)/.test(
						message,
					)
				? "invalid_input"
				: "storage_unavailable";
		return { ok: false, errorCode: "attribution_assessment_write_failed", reason };
	}
}

export function queryAttributionAssessments(
	db: Database,
	input: QueryAttributionAssessmentsInput = {},
): AttributionAssessmentRecord[] {
	return queryAttributionAssessmentPage(db, input).assessments;
}

export function queryAttributionAssessmentPage(
	db: Database,
	input: QueryAttributionAssessmentsInput = {},
): AttributionAssessmentQueryPage {
	const clauses: string[] = [];
	const params: Array<string | number> = [];
	if (input.attemptId != null && input.attemptIds != null) {
		throw new Error("attemptId and attemptIds are mutually exclusive");
	}
	if (input.attemptId != null) {
		clauses.push("attempt_id = ?");
		params.push(uuid(input.attemptId, "attemptId"));
	}
	if (input.attemptIds != null) {
		if (input.attemptIds.length === 0 || input.attemptIds.length > 100) {
			throw new Error("attemptIds must contain from 1 through 100 UUIDs");
		}
		const attemptIds = [...new Set(input.attemptIds.map((id) => uuid(id, "attemptId")))];
		clauses.push(`attempt_id IN (${attemptIds.map(() => "?").join(", ")})`);
		params.push(...attemptIds);
	}
	if (input.subjectType != null) {
		if (!SUBJECT_TYPES.has(input.subjectType)) throw new Error("subjectType is invalid");
		clauses.push("subject_type = ?");
		params.push(input.subjectType);
	}
	if (input.dimension != null) {
		if (!DIMENSIONS.has(input.dimension)) throw new Error("dimension is invalid");
		clauses.push("dimension = ?");
		params.push(input.dimension);
	}
	if (input.impactLabel != null) {
		if (!IMPACT_LABELS.has(input.impactLabel)) throw new Error("impactLabel is invalid");
		clauses.push("impact_label = ?");
		params.push(input.impactLabel);
	}
	const limit = positiveInteger(
		input.limit ?? DEFAULT_ATTRIBUTION_ASSESSMENT_QUERY_LIMIT,
		"limit",
		MAX_ATTRIBUTION_ASSESSMENT_QUERY_LIMIT,
	);
	if (!hasAttributionAssessmentSchema(db)) return emptyAttributionAssessmentPage();
	const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
	const totalRowCount = db
		.prepare(`SELECT COUNT(*) FROM attribution_assessments${where}`)
		.pluck()
		.get(...params) as number;
	const rows = db
		.prepare(
			`SELECT assessment_id FROM attribution_assessments${where} ORDER BY created_at DESC, assessment_id DESC LIMIT ?`,
		)
		.all(...params, limit) as Array<{ assessment_id: string }>;
	const evidenceCache = new Map<string, OutcomeEvidenceRecord>();
	const assessments = rows.flatMap((row) => {
		const assessment = read(db, row.assessment_id, evidenceCache, true);
		return assessment == null ? [] : [assessment];
	});
	return {
		assessments,
		evidence: [...evidenceCache.values()],
		selectedAssessmentIds: rows.map((row) => row.assessment_id),
		selectedRowCount: rows.length,
		invalidRowCount: rows.length - assessments.length,
		totalRowCount,
	};
}
