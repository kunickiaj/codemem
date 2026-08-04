import type { AttributionAssessmentRecord } from "./attribution-assessment.js";
import {
	isQualifyingSourceLocationWitness,
	queryAttributionAssessmentPage,
	referencesAssessmentSubject,
} from "./attribution-assessment.js";
import { type Database, tableExists } from "./db.js";
import type { OutcomeEvidenceRecord } from "./outcome-evidence.js";
import { queryRetrievalAttempts, type RetrievalAttemptRecord } from "./retrieval-ledger.js";

export const ATTRIBUTION_DIAGNOSTICS_CONTRACT_VERSION = 1 as const;
export const ATTRIBUTION_DIAGNOSTICS_LIMITATIONS = [
	"Handoff confirms only the immediate Codemem consumer boundary, not model use.",
	"Ordinary-session findings are observational and do not establish causation.",
	"Unassessed means no valid assessment row was inspected; unknown means a validated assessment found insufficient evidence.",
	"No per-memory ROI or composite productivity score is produced.",
	"Detailed validation and aggregation are bounded to 100 recent linked assessments.",
	"Invalid-row counts cover inspected rows; omitted rows make assessment status or details explicitly indeterminate.",
	"Overhead totals count only evidence explicitly bound to each assessment subject; session-correlated evidence is excluded.",
] as const;

export interface AttributionDiagnosticsInput {
	sessionId?: number;
	source?: string;
	streamId?: string;
	limit?: number;
}

export interface AttributionDiagnosticsReport {
	contractVersion: typeof ATTRIBUTION_DIAGNOSTICS_CONTRACT_VERSION;
	lifecycle: {
		requestedAttempts: number;
		selectedAttempts: number;
		selectedExposures: number;
		handedOffAttempts: number;
		handedOffExposures: number;
		noResults: number;
		skipped: number;
		retrievalFailed: number;
		deliveryFailed: number;
	};
	evidenceCompleteness: {
		assessedAttempts: number;
		unassessedAttempts: number;
		assessedUnknownAttempts: number;
		assessedKnownAttempts: number;
		assessmentStatusIndeterminateAttempts: number;
		assessmentDetailsIncompleteAttempts: number;
		linkedOutcomeEvidence: number;
		assessmentRowsInvalid: number;
		assessmentRowsOmittedByLimit: number;
	};
	overhead: {
		latencySampleCount: number;
		totalLatencyMs: number;
		averageLatencyMs: number | null;
		maximumLatencyMs: number | null;
		retrievalOverheadMs: number | null;
		retrievalOverheadTokens: number | null;
	};
	sourceLocationSteering: {
		assessmentCount: number;
		matchedPathCount: number;
	};
	findings: { stale: number; harmful: number };
	limitations: readonly string[];
}

function sum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function linkedEvidence(
	assessments: AttributionAssessmentRecord[],
	byId: Map<string, OutcomeEvidenceRecord>,
): OutcomeEvidenceRecord[] {
	const ids = [...new Set(assessments.flatMap((assessment) => assessment.evidenceIds))];
	return ids.flatMap((id) => {
		const evidence = byId.get(id);
		return evidence == null ? [] : [evidence];
	});
}

function lifecycle(attempts: RetrievalAttemptRecord[]): AttributionDiagnosticsReport["lifecycle"] {
	const selected = attempts.flatMap((attempt) =>
		attempt.exposures.filter((exposure) => exposure.disposition === "selected"),
	);
	const handedOff = attempts.flatMap((attempt) =>
		attempt.deliveryStatus === "handed_off"
			? attempt.exposures.filter(
					(exposure) =>
						exposure.disposition === "selected" && exposure.handoffStatus === "handed_off",
				)
			: [],
	);
	return {
		requestedAttempts: attempts.length,
		selectedAttempts: attempts.filter((attempt) => attempt.selectedCount > 0).length,
		selectedExposures: selected.length,
		handedOffAttempts: attempts.filter((attempt) => attempt.deliveryStatus === "handed_off").length,
		handedOffExposures: handedOff.length,
		noResults: attempts.filter((attempt) => attempt.retrievalStatus === "no_results").length,
		skipped: attempts.filter((attempt) => attempt.retrievalStatus === "skipped").length,
		retrievalFailed: attempts.filter((attempt) => attempt.retrievalStatus === "failed").length,
		deliveryFailed: attempts.filter((attempt) => attempt.deliveryStatus === "failed").length,
	};
}

function evidenceCompleteness(
	attempts: RetrievalAttemptRecord[],
	assessments: AttributionAssessmentRecord[],
	omittedAttemptIds: Set<string>,
	counts: {
		linkedOutcomeEvidence: number;
		assessmentRowsInvalid: number;
		assessmentRowsOmittedByLimit: number;
	},
): AttributionDiagnosticsReport["evidenceCompleteness"] {
	const byAttempt = new Map<string, AttributionAssessmentRecord[]>();
	for (const assessment of assessments) {
		byAttempt.set(assessment.attemptId, [
			...(byAttempt.get(assessment.attemptId) ?? []),
			assessment,
		]);
	}
	const assessedAttemptIds = new Set(assessments.map((assessment) => assessment.attemptId));
	const assessed = attempts.filter((attempt) => assessedAttemptIds.has(attempt.attemptId));
	const statusIndeterminate = attempts.filter(
		(attempt) =>
			!assessedAttemptIds.has(attempt.attemptId) && omittedAttemptIds.has(attempt.attemptId),
	);
	const detailsIncomplete = assessed.filter((attempt) => omittedAttemptIds.has(attempt.attemptId));
	const fullyInspected = assessed.filter((attempt) => !omittedAttemptIds.has(attempt.attemptId));
	return {
		assessedAttempts: assessed.length,
		unassessedAttempts: attempts.length - assessed.length - statusIndeterminate.length,
		assessedUnknownAttempts: fullyInspected.filter((attempt) => {
			const detailed = byAttempt.get(attempt.attemptId) ?? [];
			return (
				detailed.length > 0 && detailed.every((assessment) => assessment.impactLabel === "unknown")
			);
		}).length,
		assessedKnownAttempts: fullyInspected.filter((attempt) =>
			(byAttempt.get(attempt.attemptId) ?? []).some(
				(assessment) => assessment.impactLabel !== "unknown",
			),
		).length,
		assessmentStatusIndeterminateAttempts: statusIndeterminate.length,
		assessmentDetailsIncompleteAttempts: detailsIncomplete.length,
		linkedOutcomeEvidence: counts.linkedOutcomeEvidence,
		assessmentRowsInvalid: counts.assessmentRowsInvalid,
		assessmentRowsOmittedByLimit: counts.assessmentRowsOmittedByLimit,
	};
}

// This query must mirror queryAttributionAssessmentPage filters; diagnostics currently passes only
// attemptIds, so adding another page filter requires adding the same predicate here.
function omittedAssessmentAttemptIds(
	db: Database,
	attempts: RetrievalAttemptRecord[],
	selectedAssessmentIds: string[],
): Set<string> {
	if (
		attempts.length === 0 ||
		!tableExists(db, "attribution_assessments") ||
		!tableExists(db, "attribution_assessment_evidence")
	) {
		return new Set();
	}
	const ids = attempts.map((attempt) => attempt.attemptId);
	const selectedClause =
		selectedAssessmentIds.length === 0
			? ""
			: ` AND assessment_id NOT IN (${selectedAssessmentIds.map(() => "?").join(", ")})`;
	const rows = db
		.prepare(
			`SELECT DISTINCT attempt_id FROM attribution_assessments WHERE attempt_id IN (${ids.map(() => "?").join(", ")})${selectedClause}`,
		)
		.all(...ids, ...selectedAssessmentIds) as Array<{ attempt_id: string }>;
	return new Set(rows.map((row) => row.attempt_id));
}

function metric(evidence: OutcomeEvidenceRecord[], type: string): number | null {
	const values = evidence
		.filter((row) => row.evidenceType === type && row.value != null)
		.map((row) => row.value?.value ?? 0);
	return values.length === 0 ? null : sum(values);
}

function subjectBoundEvidence(
	assessments: AttributionAssessmentRecord[],
	attemptsById: Map<string, RetrievalAttemptRecord>,
	byEvidenceId: Map<string, OutcomeEvidenceRecord>,
): OutcomeEvidenceRecord[] {
	const bound = new Map<string, OutcomeEvidenceRecord>();
	for (const assessment of assessments) {
		const attempt = attemptsById.get(assessment.attemptId);
		if (attempt == null) continue;
		for (const evidenceId of assessment.evidenceIds) {
			const evidence = byEvidenceId.get(evidenceId);
			if (
				evidence != null &&
				referencesAssessmentSubject(attempt, assessment.subjectType, assessment.exposureId, [
					evidence,
				])
			) {
				bound.set(evidenceId, evidence);
			}
		}
	}
	return [...bound.values()];
}

export function getAttributionDiagnostics(
	db: Database,
	input: AttributionDiagnosticsInput = {},
): AttributionDiagnosticsReport {
	const attempts = queryRetrievalAttempts(db, input);
	const page =
		attempts.length === 0
			? {
					assessments: [],
					evidence: [],
					selectedAssessmentIds: [],
					selectedRowCount: 0,
					invalidRowCount: 0,
					totalRowCount: 0,
				}
			: queryAttributionAssessmentPage(db, {
					attemptIds: attempts.map((attempt) => attempt.attemptId),
					limit: 100,
				});
	const assessments = page.assessments;
	const byEvidenceId = new Map(page.evidence.map((evidence) => [evidence.evidenceId, evidence]));
	const evidence = linkedEvidence(assessments, byEvidenceId);
	const latencies = attempts.flatMap((attempt) =>
		attempt.latencyMs == null ? [] : [attempt.latencyMs],
	);
	const sourceAssessments = assessments.filter(
		(assessment) => assessment.basis === "source_location_overlap",
	);
	const attemptsById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
	const overheadEvidence = subjectBoundEvidence(assessments, attemptsById, byEvidenceId);
	const sourceEvidenceById = new Map<string, OutcomeEvidenceRecord>();
	for (const assessment of sourceAssessments) {
		const attempt = attemptsById.get(assessment.attemptId);
		if (attempt == null) continue;
		for (const evidenceId of assessment.evidenceIds) {
			const row = byEvidenceId.get(evidenceId);
			if (
				row != null &&
				isQualifyingSourceLocationWitness(
					attempt,
					assessment.subjectType,
					assessment.exposureId,
					row,
				)
			) {
				sourceEvidenceById.set(evidenceId, row);
			}
		}
	}
	const sourceEvidence = [...sourceEvidenceById.values()];
	return {
		contractVersion: ATTRIBUTION_DIAGNOSTICS_CONTRACT_VERSION,
		lifecycle: lifecycle(attempts),
		evidenceCompleteness: evidenceCompleteness(
			attempts,
			assessments,
			omittedAssessmentAttemptIds(db, attempts, page.selectedAssessmentIds),
			{
				linkedOutcomeEvidence: evidence.length,
				assessmentRowsInvalid: page.invalidRowCount,
				assessmentRowsOmittedByLimit: Math.max(0, page.totalRowCount - page.selectedRowCount),
			},
		),
		overhead: {
			latencySampleCount: latencies.length,
			totalLatencyMs: sum(latencies),
			averageLatencyMs: latencies.length === 0 ? null : sum(latencies) / latencies.length,
			maximumLatencyMs: latencies.length === 0 ? null : Math.max(...latencies),
			retrievalOverheadMs: metric(overheadEvidence, "efficiency.retrieval_overhead_ms"),
			retrievalOverheadTokens: metric(overheadEvidence, "efficiency.retrieval_overhead_tokens"),
		},
		sourceLocationSteering: {
			assessmentCount: sourceAssessments.length,
			matchedPathCount: sum(sourceEvidence.map((row) => row.value?.value ?? 0)),
		},
		findings: {
			stale: assessments.filter((assessment) => assessment.impactLabel === "stale").length,
			harmful: assessments.filter((assessment) => assessment.impactLabel === "harmful").length,
		},
		limitations: ATTRIBUTION_DIAGNOSTICS_LIMITATIONS,
	};
}
