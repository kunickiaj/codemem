import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getAttributionAssessment,
	queryAttributionAssessments,
	recordAttributionAssessment,
} from "./attribution-assessment.js";
import { getAttributionDiagnostics } from "./attribution-diagnostics.js";
import {
	deterministicCheckEvidence,
	efficiencyEvidence,
	explicitFeedbackEvidence,
	groundedStaleEvidence,
	type RecordOutcomeEvidenceInput,
	recordOutcomeEvidence,
	sourceLocationOverlapEvidence,
} from "./outcome-evidence.js";
import { type RecordRetrievalAttemptInput, recordRetrievalAttempt } from "./retrieval-ledger.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-08-03T12:00:00.000Z";
const ASSESSED_AT = "2026-08-03T12:05:00.000Z";

function id(sequence: number): string {
	return `018f2db4-f9d3-7a22-8d18-${sequence.toString(16).padStart(12, "0")}`;
}

function attempt(
	sequence: number,
	overrides: Partial<RecordRetrievalAttemptInput> = {},
): RecordRetrievalAttemptInput {
	return {
		attemptId: id(sequence),
		surface: "mcp_search",
		trigger: "explicit",
		startedAt: NOW,
		completedAt: "2026-08-03T12:00:00.010Z",
		retrievalStatus: "succeeded",
		deliveryStatus: "handed_off",
		candidateCount: 1,
		selectedCount: 1,
		recorderVersion: "diagnostics-fixture-v1",
		sessionId: 1,
		source: "opencode",
		streamId: "stream-a",
		latencyMs: 10,
		exposures: [
			{
				memoryImportKey: `memory-${sequence}`,
				rank: 1,
				disposition: "selected",
				handoffStatus: "handed_off",
			},
		],
		...overrides,
	};
}

function feedback(
	db: Database.Database,
	sequence: number,
	attemptId: string,
	label: "helpful" | "irrelevant" | "stale" | "harmful",
): string {
	const evidenceId = id(sequence);
	recordOutcomeEvidence(
		db,
		explicitFeedbackEvidence({
			evidenceId,
			observedAt: "2026-08-03T12:01:00.000Z",
			producer: "diagnostics-feedback",
			producerVersion: "v1",
			feedback: label,
			actionId: `feedback-${sequence}`,
			gate: "structured_action",
			referenceCodes: [`attempt:${attemptId}`],
			correlation: { sessionId: 1, source: "opencode", streamId: "stream-a" },
		}),
	);
	return evidenceId;
}

function referencing(
	evidence: RecordOutcomeEvidenceInput,
	referenceCode: string,
): RecordOutcomeEvidenceInput {
	return {
		...evidence,
		references: { ...(evidence.references ?? {}), reference_codes: [referenceCode] },
	};
}

function assess(
	db: Database.Database,
	sequence: number,
	attemptId: string,
	evidenceIds: string[],
	overrides: Partial<Parameters<typeof recordAttributionAssessment>[1]> = {},
): void {
	recordAttributionAssessment(db, {
		assessmentId: id(sequence),
		attemptId,
		dimension: "feedback",
		impactLabel: "helpful",
		basis: "explicit_reference",
		confidenceLevel: "low",
		method: "diagnostics-fixture",
		methodVersion: "v1",
		createdAt: ASSESSED_AT,
		evidenceIds,
		...overrides,
	});
}

describe("bounded attribution diagnostics", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		db.pragma("foreign_keys = ON");
		db.prepare(
			"INSERT INTO sessions(id, started_at, project) VALUES (1, ?, 'one'), (2, ?, 'two')",
		).run(NOW, NOW);
	});

	afterEach(() => db.close());

	it("reports lifecycle, evidence, overhead, steering, findings, filters, and safe limitations", () => {
		const handedOff = recordRetrievalAttempt(db, attempt(1)).attempt;
		recordRetrievalAttempt(
			db,
			attempt(2, {
				retrievalStatus: "no_results",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				exposures: [],
				latencyMs: 20,
			}),
		);
		recordRetrievalAttempt(
			db,
			attempt(3, {
				retrievalStatus: "skipped",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				exposures: [],
				latencyMs: null,
			}),
		);
		recordRetrievalAttempt(
			db,
			attempt(4, {
				retrievalStatus: "failed",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				exposures: [],
				latencyMs: 30,
			}),
		);
		recordRetrievalAttempt(
			db,
			attempt(5, {
				deliveryStatus: "failed",
				exposures: attempt(5).exposures.map((row) => ({ ...row, handoffStatus: "failed" })),
				latencyMs: 40,
			}),
		);
		recordRetrievalAttempt(
			db,
			attempt(6, {
				retrievalStatus: "unknown",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				exposures: [],
				latencyMs: 50,
			}),
		);
		recordRetrievalAttempt(
			db,
			attempt(7, { sessionId: 2, source: "claude", streamId: "stream-b", latencyMs: 999 }),
		);

		const explicitId = feedback(db, 101, handedOff.attemptId, "helpful");
		const overheadMsId = id(102);
		const overheadTokensId = id(103);
		const unrelatedOverheadId = id(108);
		for (const [evidenceId, evidenceType, value] of [
			[overheadMsId, "efficiency.retrieval_overhead_ms", 12],
			[overheadTokensId, "efficiency.retrieval_overhead_tokens", 34],
			[unrelatedOverheadId, "efficiency.retrieval_overhead_ms", 999],
		] as const) {
			const referencedAttemptId = evidenceId === unrelatedOverheadId ? id(2) : handedOff.attemptId;
			recordOutcomeEvidence(
				db,
				referencing(
					efficiencyEvidence({
						evidenceId,
						observedAt: "2026-08-03T12:01:00.000Z",
						producer: "diagnostics-overhead",
						producerVersion: "v1",
						evidenceType,
						value,
						correlation: { sessionId: 1 },
					}),
					`attempt:${referencedAttemptId}`,
				),
			);
		}
		assess(db, 201, handedOff.attemptId, [
			explicitId,
			overheadMsId,
			overheadTokensId,
			unrelatedOverheadId,
		]);

		const pathId = id(104);
		const qualityId = id(105);
		const exposureId = handedOff.exposures[0]?.exposureId;
		if (exposureId == null) throw new Error("missing fixture exposure");
		recordOutcomeEvidence(
			db,
			referencing(
				sourceLocationOverlapEvidence({
					evidenceId: pathId,
					observedAt: "2026-08-03T12:01:00.000Z",
					producer: "diagnostics-path",
					producerVersion: "v1",
					retrievedPaths: ["packages/core/src/schema.ts", "packages/core/src/index.ts"],
					downstreamPaths: ["packages/core/src/schema.ts", "packages/core/src/index.ts"],
					correlation: { sessionId: 1 },
				}),
				`exposure:${exposureId}`,
			),
		);
		recordOutcomeEvidence(
			db,
			referencing(
				deterministicCheckEvidence({
					evidenceId: qualityId,
					observedAt: "2026-08-03T12:01:00.000Z",
					producer: "diagnostics-check",
					producerVersion: "v1",
					check: "test_result",
					checkId: "diagnostics-suite",
					status: "pass",
					correlation: { sessionId: 1 },
				}),
				`exposure:${exposureId}`,
			),
		);
		assess(db, 202, handedOff.attemptId, [pathId, qualityId], {
			subjectType: "exposure",
			exposureId,
			dimension: "mechanism",
			impactLabel: "helpful",
			basis: "source_location_overlap",
			confidenceLevel: "medium",
		});

		const staleId = id(106);
		recordOutcomeEvidence(
			db,
			groundedStaleEvidence({
				evidenceId: staleId,
				observedAt: "2026-08-03T12:01:00.000Z",
				producer: "diagnostics-review",
				producerVersion: "v1",
				adjudicationId: "stale-review",
				referenceCodes: [`attempt:${handedOff.attemptId}`],
				correlation: { sessionId: 1 },
			}),
		);
		assess(db, 203, handedOff.attemptId, [staleId], {
			dimension: "safety",
			impactLabel: "stale",
			basis: "human_review",
			confidenceLevel: "medium",
		});
		const harmfulId = feedback(db, 107, handedOff.attemptId, "harmful");
		assess(db, 204, handedOff.attemptId, [harmfulId], {
			dimension: "feedback",
			impactLabel: "harmful",
			confidenceLevel: "medium",
		});

		const report = getAttributionDiagnostics(db, { sessionId: 1, source: "opencode" });
		expect(report.lifecycle).toEqual({
			requestedAttempts: 6,
			selectedAttempts: 2,
			selectedExposures: 2,
			handedOffAttempts: 1,
			handedOffExposures: 1,
			noResults: 1,
			skipped: 1,
			retrievalFailed: 1,
			deliveryFailed: 1,
		});
		expect(report.evidenceCompleteness).toMatchObject({
			assessedAttempts: 1,
			unassessedAttempts: 5,
			assessedUnknownAttempts: 0,
			assessedKnownAttempts: 1,
			assessmentRowsInvalid: 0,
			assessmentRowsOmittedByLimit: 0,
		});
		expect(report.overhead).toEqual({
			latencySampleCount: 5,
			totalLatencyMs: 150,
			averageLatencyMs: 30,
			maximumLatencyMs: 50,
			retrievalOverheadMs: 12,
			retrievalOverheadTokens: 34,
		});
		expect(report.sourceLocationSteering).toEqual({ assessmentCount: 1, matchedPathCount: 2 });
		expect(report.findings).toEqual({ stale: 1, harmful: 1 });
		expect(getAttributionDiagnostics(db, { source: "claude" }).lifecycle.requestedAttempts).toBe(1);
		expect(
			getAttributionDiagnostics(db, { source: "claude", streamId: "stream-b" }).lifecycle
				.requestedAttempts,
		).toBe(1);
		const serialized = JSON.stringify(report.limitations);
		expect(report.limitations.length).toBeGreaterThan(0);
		expect(serialized.length).toBeLessThan(1000);
		expect(serialized).not.toMatch(/body_text|pack_text|absolute path|caused|productivity_score/i);
	});

	it("counts handed-off exposures only when their attempt is also handed off", () => {
		const recorded = recordRetrievalAttempt(db, attempt(7)).attempt;
		db.prepare("UPDATE retrieval_attempts SET delivery_status = 'failed' WHERE attempt_id = ?").run(
			recorded.attemptId,
		);

		expect(getAttributionDiagnostics(db, { sessionId: 1 }).lifecycle).toMatchObject({
			selectedExposures: 1,
			handedOffAttempts: 0,
			handedOffExposures: 0,
			deliveryFailed: 1,
		});
	});

	it("counts only qualifying source-location witnesses", () => {
		const recordedAttempt = recordRetrievalAttempt(db, attempt(20)).attempt;
		const qualifyingId = id(210);
		const unrelatedId = id(211);
		const zeroId = id(212);
		const preRetrievalId = id(214);
		for (const [evidenceId, observedAt, retrievedPaths, downstreamPaths, status, referenceCode] of [
			[
				qualifyingId,
				"2026-08-03T12:00:00.010Z",
				["packages/core/src/schema.ts", "packages/core/src/index.ts"],
				["packages/core/src/schema.ts", "packages/core/src/index.ts"],
				"present",
				`attempt:${recordedAttempt.attemptId}`,
			],
			[
				unrelatedId,
				"2026-08-03T12:01:00.000Z",
				["packages/core/src/store.ts"],
				["packages/core/src/store.ts"],
				"present",
				`attempt:${id(999)}`,
			],
			[
				zeroId,
				"2026-08-03T12:01:00.000Z",
				["packages/core/src/db.ts"],
				["packages/core/src/store.ts"],
				"present",
				`attempt:${recordedAttempt.attemptId}`,
			],
			[
				preRetrievalId,
				NOW,
				["packages/core/src/attribution-assessment.ts"],
				["packages/core/src/attribution-assessment.ts"],
				"present",
				`attempt:${recordedAttempt.attemptId}`,
			],
		] as const) {
			recordOutcomeEvidence(db, {
				...referencing(
					sourceLocationOverlapEvidence({
						evidenceId,
						observedAt,
						producer: "diagnostics-path",
						producerVersion: "v1",
						retrievedPaths: [...retrievedPaths],
						downstreamPaths: [...downstreamPaths],
						correlation: { sessionId: 1 },
					}),
					referenceCode,
				),
				status,
			});
		}

		assess(
			db,
			215,
			recordedAttempt.attemptId,
			[qualifyingId, unrelatedId, zeroId, preRetrievalId],
			{
				dimension: "mechanism",
				impactLabel: "unknown",
				basis: "source_location_overlap",
			},
		);

		expect(getAttributionDiagnostics(db, { sessionId: 1 }).sourceLocationSteering).toEqual({
			assessmentCount: 1,
			matchedPathCount: 2,
		});
	});

	it("separates assessed unknown, unassessed, malformed, and rows omitted by the limit", () => {
		recordRetrievalAttempt(db, attempt(30));
		recordRetrievalAttempt(db, attempt(31));
		const evidenceIds = [
			feedback(db, 130, id(30), "helpful"),
			feedback(db, 131, id(30), "irrelevant"),
		];
		for (let sequence = 0; sequence < 101; sequence += 1) {
			assess(db, 300 + sequence, id(30), evidenceIds, { impactLabel: "unknown" });
		}
		db.prepare(
			"UPDATE attribution_assessments SET impact_label = 'invalid' WHERE assessment_id = ?",
		).run(id(400));

		const report = getAttributionDiagnostics(db, { sessionId: 1 });
		expect(report.evidenceCompleteness).toMatchObject({
			assessedAttempts: 1,
			unassessedAttempts: 1,
			assessedUnknownAttempts: 0,
			assessmentStatusIndeterminateAttempts: 0,
			assessmentDetailsIncompleteAttempts: 1,
			assessmentRowsInvalid: 1,
			assessmentRowsOmittedByLimit: 1,
		});
	});

	it("retains retrieval noise as diagnostic evidence and fails closed on corrupted qualification", () => {
		const unknownAttempt = recordRetrievalAttempt(db, attempt(40)).attempt;
		const diagnosticNoiseId = id(140);
		const basisId = id(141);
		recordOutcomeEvidence(db, {
			evidenceId: diagnosticNoiseId,
			dimension: "safety",
			evidenceType: "safety.retrieval_noise",
			sourceClass: "derived",
			observedAt: "2026-08-03T12:01:00.000Z",
			producer: "noise-rule",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: { reference_codes: [`attempt:${unknownAttempt.attemptId}`] },
		});
		recordOutcomeEvidence(db, {
			evidenceId: basisId,
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "derived",
			observedAt: "2026-08-03T12:01:00.000Z",
			producer: "reference-rule",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: { reference_codes: [`attempt:${unknownAttempt.attemptId}`] },
		});
		assess(db, 240, unknownAttempt.attemptId, [diagnosticNoiseId, basisId], {
			dimension: "mechanism",
			impactLabel: "unknown",
		});

		const corruptedAttempt = recordRetrievalAttempt(db, attempt(41)).attempt;
		const evaluatorNoiseId = id(142);
		recordOutcomeEvidence(db, {
			evidenceId: evaluatorNoiseId,
			dimension: "safety",
			evidenceType: "safety.retrieval_noise",
			sourceClass: "evaluator",
			observedAt: "2026-08-03T12:01:00.000Z",
			producer: "noise-review",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: {
				rubric_id: "retrieval-noise-rubric",
				reference_codes: [`attempt:${corruptedAttempt.attemptId}`],
			},
		});
		assess(db, 241, corruptedAttempt.attemptId, [evaluatorNoiseId], {
			dimension: "safety",
			impactLabel: "irrelevant",
			basis: "human_review",
		});
		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify({ reference_codes: [`attempt:${corruptedAttempt.attemptId}`] }),
			evaluatorNoiseId,
		);

		expect(getAttributionDiagnostics(db, { sessionId: 1 }).evidenceCompleteness).toMatchObject({
			assessedAttempts: 1,
			unassessedAttempts: 1,
			assessedUnknownAttempts: 1,
			assessedKnownAttempts: 0,
			linkedOutcomeEvidence: 2,
			assessmentRowsInvalid: 1,
		});
	});

	it("fails closed on persisted weak unknown assessments corrupted to high confidence", () => {
		const recordedAttempt = recordRetrievalAttempt(db, attempt(42)).attempt;
		const evidenceId = id(143);
		const assessmentId = id(242);
		recordOutcomeEvidence(db, {
			evidenceId,
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "derived",
			observedAt: "2026-08-03T12:01:00.000Z",
			producer: "reference-rule",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: { reference_codes: [`attempt:${recordedAttempt.attemptId}`] },
		});
		assess(db, 242, recordedAttempt.attemptId, [evidenceId], {
			dimension: "mechanism",
			impactLabel: "unknown",
			basis: "explicit_reference",
		});
		db.prepare(
			"UPDATE attribution_assessments SET confidence_level = 'high' WHERE assessment_id = ?",
		).run(assessmentId);

		expect(getAttributionAssessment(db, assessmentId)).toBeNull();
		expect(queryAttributionAssessments(db, { attemptId: recordedAttempt.attemptId })).toEqual([]);
		expect(getAttributionDiagnostics(db, { sessionId: 1 }).evidenceCompleteness).toMatchObject({
			assessedAttempts: 0,
			unassessedAttempts: 1,
			assessedUnknownAttempts: 0,
			assessmentRowsInvalid: 1,
		});
	});

	it("fails closed on explicit and evaluator assessments after completion is removed", () => {
		const recordedAttempt = recordRetrievalAttempt(db, attempt(43)).attempt;
		const explicitId = feedback(db, 145, recordedAttempt.attemptId, "helpful");
		const humanReviewId = id(146);
		const blindedReviewId = id(147);
		for (const [evidenceId, dimension, evidenceType, status, references] of [
			[
				humanReviewId,
				"mechanism",
				"mechanism.memory_reference",
				"present",
				{
					rubric_id: "human-review-rubric",
					reference_codes: [`attempt:${recordedAttempt.attemptId}`],
				},
			],
			[
				blindedReviewId,
				"quality",
				"quality.blinded_evaluator",
				"unknown",
				{
					assertion_id: "blinded-review-assertion",
					rubric_id: "blinded-review-rubric",
					reference_codes: [`attempt:${recordedAttempt.attemptId}`],
				},
			],
		] as const) {
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension,
				evidenceType,
				sourceClass: "evaluator",
				observedAt: "2026-08-03T12:01:00.000Z",
				producer: "diagnostics-review",
				producerVersion: "v1",
				status,
				sessionId: 1,
				references,
			});
		}
		assess(db, 243, recordedAttempt.attemptId, [explicitId]);
		assess(db, 244, recordedAttempt.attemptId, [humanReviewId], {
			dimension: "mechanism",
			impactLabel: "unknown",
			basis: "human_review",
		});
		assess(db, 245, recordedAttempt.attemptId, [blindedReviewId], {
			dimension: "quality",
			impactLabel: "unknown",
			basis: "blinded_evaluator",
		});

		db.prepare("UPDATE retrieval_attempts SET completed_at = NULL WHERE attempt_id = ?").run(
			recordedAttempt.attemptId,
		);

		expect(getAttributionDiagnostics(db, { sessionId: 1 }).evidenceCompleteness).toMatchObject({
			assessedAttempts: 0,
			unassessedAttempts: 1,
			linkedOutcomeEvidence: 0,
			assessmentRowsInvalid: 3,
		});
	});

	it("classifies persisted randomized evidence as invalid when attempt pairing becomes ambiguous", () => {
		const treatment = recordRetrievalAttempt(
			db,
			attempt(700, {
				surface: "evaluation_replay",
				trigger: "evaluation",
				experimentId: "experiment-1",
				experimentCellId: "cell-treatment",
				evaluationFixtureId: "fixture-a",
				evaluationSeed: 700,
			}),
		).attempt;
		recordRetrievalAttempt(
			db,
			attempt(701, {
				surface: "evaluation_replay",
				trigger: "evaluation",
				experimentId: "experiment-1",
				experimentCellId: "cell-control",
				evaluationFixtureId: "fixture-a",
				evaluationSeed: 701,
			}),
		);
		const treatmentEvidenceId = id(702);
		const controlEvidenceId = id(703);
		for (const [evidenceId, experimentCellId, status] of [
			[treatmentEvidenceId, "cell-treatment", "pass"],
			[controlEvidenceId, "cell-control", "fail"],
		] as const) {
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "quality",
				evidenceType: "quality.task_assertion",
				sourceClass: "experiment",
				observedAt: "2026-08-03T12:01:00.000Z",
				producer: "diagnostics-experiment",
				producerVersion: "v1",
				status,
				experimentId: "experiment-1",
				experimentCellId,
				references: {
					check_id: "experiment-check",
					assertion_id: "task-assertion",
					fixture_id: "fixture-a",
					reference_codes: ["experiment.preregistered"],
				},
			});
		}
		assess(db, 704, treatment.attemptId, [treatmentEvidenceId, controlEvidenceId], {
			dimension: "quality",
			impactLabel: "helpful",
			basis: "randomized_contrast",
		});

		recordRetrievalAttempt(
			db,
			attempt(705, {
				surface: "evaluation_replay",
				trigger: "evaluation",
				experimentId: "experiment-1",
				experimentCellId: "cell-control",
				evaluationFixtureId: "fixture-a",
				evaluationSeed: 705,
			}),
		);

		expect(getAttributionDiagnostics(db, { sessionId: 1 }).evidenceCompleteness).toMatchObject({
			assessedAttempts: 0,
			unassessedAttempts: 3,
			linkedOutcomeEvidence: 0,
			assessmentRowsInvalid: 1,
		});
	});

	it("retains ungrounded wrong-action followups as evidence for unknown assessments", () => {
		const recordedAttempt = recordRetrievalAttempt(db, attempt(42)).attempt;
		const wrongActionId = id(143);
		const basisId = id(144);
		for (const [evidenceId, dimension, evidenceType] of [
			[wrongActionId, "safety", "safety.wrong_action_followup"],
			[basisId, "mechanism", "mechanism.memory_reference"],
		] as const) {
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension,
				evidenceType,
				sourceClass: "derived",
				observedAt: "2026-08-03T12:01:00.000Z",
				producer: "diagnostic-rule",
				producerVersion: "v1",
				status: "present",
				sessionId: 1,
				references: { reference_codes: [`attempt:${recordedAttempt.attemptId}`] },
			});
		}
		assess(db, 242, recordedAttempt.attemptId, [wrongActionId, basisId], {
			dimension: "mechanism",
			impactLabel: "unknown",
		});

		expect(getAttributionDiagnostics(db, { sessionId: 1 }).evidenceCompleteness).toMatchObject({
			assessedAttempts: 1,
			assessedUnknownAttempts: 1,
			assessedKnownAttempts: 0,
			linkedOutcomeEvidence: 2,
		});
	});

	it("reports assessment status as indeterminate when its only raw row is beyond the detail cap", () => {
		recordRetrievalAttempt(db, attempt(32));
		recordRetrievalAttempt(db, attempt(33));
		recordRetrievalAttempt(db, attempt(34));
		const olderEvidenceId = feedback(db, 132, id(32), "helpful");
		const newerEvidenceIds = [
			feedback(db, 133, id(33), "helpful"),
			feedback(db, 134, id(33), "irrelevant"),
		];
		assess(db, 499, id(32), [olderEvidenceId]);
		for (let sequence = 500; sequence < 600; sequence += 1) {
			assess(db, sequence, id(33), newerEvidenceIds, { impactLabel: "unknown" });
		}

		const report = getAttributionDiagnostics(db, { sessionId: 1 });
		expect(report.evidenceCompleteness).toMatchObject({
			assessedAttempts: 1,
			unassessedAttempts: 1,
			assessedUnknownAttempts: 1,
			assessmentStatusIndeterminateAttempts: 1,
			assessmentDetailsIncompleteAttempts: 0,
			assessmentRowsInvalid: 0,
			assessmentRowsOmittedByLimit: 1,
		});
	});
});
