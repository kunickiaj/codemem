import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AttributionBasis,
	getAttributionAssessment,
	queryAttributionAssessmentPage,
	queryAttributionAssessments,
	type RecordAttributionAssessmentInput,
	recordAttributionAssessment,
	tryRecordAttributionAssessment,
} from "./attribution-assessment.js";
import { getAttributionDiagnostics } from "./attribution-diagnostics.js";
import { ensureAdditiveSchemaCompatibility } from "./db.js";
import { exportMemories } from "./export-import.js";
import {
	deterministicCheckEvidence,
	explicitFeedbackEvidence,
	getOutcomeEvidence,
	groundedStaleEvidence,
	purgeExpiredOutcomeEvidence,
	purgeOutcomeEvidenceForPrivacy,
	type RecordOutcomeEvidenceInput,
	recordOutcomeEvidence,
	sourceLocationOverlapEvidence,
} from "./outcome-evidence.js";
import {
	finalizeRetrievalAttemptRetention,
	purgeExpiredRetrievalAttempts,
	purgeRetrievalAttemptsForPrivacy,
	type RecordRetrievalAttemptInput,
	recordRetrievalAttempt,
} from "./retrieval-ledger.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-08-03T12:00:00.000Z";
const COMPLETED_AT = "2026-08-03T12:00:00.010Z";
const ASSESSED_AT = "2026-08-03T12:02:00.000Z";

function id(sequence: number): string {
	return `018f2db4-f9d3-7a22-8d18-${sequence.toString(16).padStart(12, "0")}`;
}

function attempt(
	sequence: number,
	overrides: Partial<RecordRetrievalAttemptInput> = {},
): RecordRetrievalAttemptInput {
	return {
		attemptId: id(sequence),
		surface: "prompt_pack",
		trigger: "explicit",
		startedAt: NOW,
		completedAt: COMPLETED_AT,
		retrievalStatus: "succeeded",
		deliveryStatus: "handed_off",
		candidateCount: 1,
		selectedCount: 1,
		recorderVersion: "fixture-v1",
		sessionId: 1,
		source: "opencode",
		streamId: "stream-1",
		latencyMs: 10,
		exposures: [
			{
				memoryId: 10,
				memoryImportKey: "memory-10",
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
	label: "helpful" | "irrelevant" | "stale" | "harmful",
	attemptId: string,
): string {
	const evidenceId = id(sequence);
	recordOutcomeEvidence(
		db,
		explicitFeedbackEvidence({
			evidenceId,
			observedAt: COMPLETED_AT,
			producer: "feedback-action",
			producerVersion: "v1",
			feedback: label,
			actionId: `feedback-${sequence}`,
			gate: "structured_action",
			referenceCodes: [`attempt:${attemptId}`],
			correlation: { sessionId: 1, source: "opencode", streamId: "stream-1" },
		}),
	);
	return evidenceId;
}

function retrievalNoise(
	db: Database.Database,
	sequence: number,
	attemptId: string,
	sourceClass: Extract<
		RecordOutcomeEvidenceInput["sourceClass"],
		"observed" | "derived" | "evaluator"
	>,
	rubricId?: string,
): string {
	const evidenceId = id(sequence);
	recordOutcomeEvidence(db, {
		evidenceId,
		dimension: "safety",
		evidenceType: "safety.retrieval_noise",
		sourceClass,
		observedAt: COMPLETED_AT,
		producer: "retrieval-noise-review",
		producerVersion: "v1",
		status: "present",
		sessionId: 1,
		references: {
			rubric_id: rubricId,
			reference_codes: [`attempt:${attemptId}`],
		},
	});
	return evidenceId;
}

function wrongActionFollowup(
	db: Database.Database,
	sequence: number,
	attemptId: string,
	sourceClass: Extract<
		RecordOutcomeEvidenceInput["sourceClass"],
		"observed" | "derived" | "evaluator"
	>,
	grounding: Partial<
		Pick<
			NonNullable<RecordOutcomeEvidenceInput["references"]>,
			"checkout_id" | "adjudication_id" | "rubric_id"
		>
	> = {},
): string {
	const evidenceId = id(sequence);
	recordOutcomeEvidence(db, {
		evidenceId,
		dimension: "safety",
		evidenceType: "safety.wrong_action_followup",
		sourceClass,
		observedAt: COMPLETED_AT,
		producer: "wrong-action-review",
		producerVersion: "v1",
		status: "present",
		sessionId: 1,
		references: {
			...grounding,
			reference_codes: [`attempt:${attemptId}`],
		},
	});
	return evidenceId;
}

function referencing(
	evidence: RecordOutcomeEvidenceInput,
	referenceCode: string,
): RecordOutcomeEvidenceInput {
	return {
		...evidence,
		references: {
			...(evidence.references ?? {}),
			reference_codes: [referenceCode],
		},
	};
}

function experimentQualityEvidence(
	db: Database.Database,
	sequence: number,
	input: {
		cellId: string;
		status: "pass" | "fail" | "mixed" | "unknown";
		preregistered?: boolean;
		causalContract?: boolean;
		checkId?: string;
		checkoutId?: string;
		fixtureId?: string;
		observedAt?: string;
		referenceCodes?: string[];
		retentionPinned?: boolean;
	},
): string {
	const evidenceId = id(sequence);
	recordOutcomeEvidence(db, {
		evidenceId,
		dimension: "quality",
		evidenceType: "quality.task_assertion",
		sourceClass: "experiment",
		observedAt: input.observedAt ?? COMPLETED_AT,
		producer: "experiment-runner",
		producerVersion: "v1",
		status: input.status,
		experimentId: "experiment-1",
		experimentCellId: input.cellId,
		references: {
			check_id: input.checkId ?? "experiment-check",
			assertion_id: "task-assertion",
			checkout_id: input.checkoutId,
			fixture_id: input.fixtureId,
			reference_codes: input.referenceCodes ?? [
				...(input.preregistered === false ? [] : ["experiment.preregistered"]),
				...(input.causalContract
					? ["experiment.cells_complete", "experiment.uncertainty_reported"]
					: []),
			],
		},
		retentionPinned: input.retentionPinned ?? input.causalContract === true,
	});
	return evidenceId;
}

function recordEvaluationAttempt(
	db: Database.Database,
	sequence: number,
	input: {
		cellId: string;
		checkoutId?: string;
		fixtureId?: string;
		completedAt?: string | null;
	},
): void {
	recordRetrievalAttempt(
		db,
		attempt(sequence, {
			surface: "evaluation_replay",
			trigger: "evaluation",
			experimentId: "experiment-1",
			experimentCellId: input.cellId,
			evaluationCheckoutId: input.checkoutId ?? null,
			evaluationFixtureId: input.fixtureId ?? null,
			evaluationSeed: sequence,
			completedAt: input.completedAt === undefined ? COMPLETED_AT : input.completedAt,
		}),
	);
}

function recordExperimentControlAttempt(
	db: Database.Database,
	sequence: number,
	overrides: Partial<RecordRetrievalAttemptInput> = {},
): void {
	recordRetrievalAttempt(
		db,
		attempt(sequence, {
			experimentId: "experiment-1",
			experimentCellId: "cell-control",
			...overrides,
		}),
	);
}

function assessment(
	attemptId: string,
	assessmentId: string,
	evidenceIds: string[],
	overrides: Partial<RecordAttributionAssessmentInput> = {},
): RecordAttributionAssessmentInput {
	return {
		assessmentId,
		attemptId,
		dimension: "feedback" as const,
		impactLabel: "helpful" as const,
		basis: "explicit_reference" as const,
		confidenceLevel: "medium" as const,
		method: "fixture-review",
		methodVersion: "v1",
		createdAt: ASSESSED_AT,
		evidenceIds,
		...overrides,
	};
}

const NON_RANDOMIZED_BASIS_CASES_BY_BASIS = {
	explicit_reference: {
		family: "explicit_reference",
		basis: "explicit_reference",
		dimension: "mechanism",
		evidenceType: "mechanism.memory_reference",
		sourceClass: "derived",
	},
	temporal_followup: {
		family: "temporal_followup",
		basis: "temporal_followup",
		dimension: "mechanism",
		evidenceType: "mechanism.retrieval_followup",
		sourceClass: "derived",
	},
	human_review: {
		family: "human_evaluator",
		basis: "human_review",
		dimension: "mechanism",
		evidenceType: "mechanism.memory_reference",
		sourceClass: "evaluator",
	},
	blinded_evaluator: {
		family: "blinded_evaluator",
		basis: "blinded_evaluator",
		dimension: "quality",
		evidenceType: "quality.blinded_evaluator",
		sourceClass: "evaluator",
	},
	content_overlap: {
		family: "observational_correlation",
		basis: "content_overlap",
		dimension: "mechanism",
		evidenceType: "mechanism.command_or_constraint_reuse",
		sourceClass: "derived",
	},
	source_location_overlap: {
		family: "source_location_overlap",
		basis: "source_location_overlap",
		dimension: "mechanism",
		evidenceType: "mechanism.source_location_match",
		sourceClass: "derived",
	},
} as const satisfies Record<
	Exclude<AttributionBasis, "randomized_contrast">,
	{
		family: string;
		basis: Exclude<AttributionBasis, "randomized_contrast">;
		dimension: "mechanism" | "quality";
		evidenceType: RecordOutcomeEvidenceInput["evidenceType"];
		sourceClass: RecordOutcomeEvidenceInput["sourceClass"];
	}
>;
const NON_RANDOMIZED_BASIS_CASES = Object.values(NON_RANDOMIZED_BASIS_CASES_BY_BASIS);

function basisEvidence(
	db: Database.Database,
	sequence: number,
	attemptId: string,
	observedAt: string,
	testCase: (typeof NON_RANDOMIZED_BASIS_CASES)[number],
): string {
	const evidenceId = id(sequence);
	if (testCase.basis === "source_location_overlap") {
		recordOutcomeEvidence(
			db,
			referencing(
				sourceLocationOverlapEvidence({
					evidenceId,
					observedAt,
					producer: "basis-timestamp-test",
					producerVersion: "v1",
					retrievedPaths: ["packages/core/src/attribution-assessment.ts"],
					downstreamPaths: ["packages/core/src/attribution-assessment.ts"],
					correlation: { sessionId: 1 },
				}),
				`attempt:${attemptId}`,
			),
		);
		return evidenceId;
	}
	recordOutcomeEvidence(db, {
		evidenceId,
		dimension: testCase.dimension,
		evidenceType: testCase.evidenceType,
		sourceClass: testCase.sourceClass,
		observedAt,
		producer: "basis-timestamp-test",
		producerVersion: "v1",
		status: testCase.basis === "blinded_evaluator" ? "unknown" : "present",
		sessionId: 1,
		references: {
			...(testCase.basis === "human_review" ? { rubric_id: "human-review-rubric" } : {}),
			...(testCase.basis === "blinded_evaluator"
				? { assertion_id: `assertion-${evidenceId}`, rubric_id: "quality-rubric" }
				: {}),
			reference_codes: [`attempt:${attemptId}`],
		},
	});
	return evidenceId;
}

function seed(db: Database.Database): void {
	initTestSchema(db);
	db.pragma("foreign_keys = ON");
	db.prepare("INSERT INTO sessions(id, started_at, project) VALUES (1, ?, 'codemem')").run(NOW);
	db.prepare(
		`INSERT INTO memory_items(id, session_id, kind, title, body_text, active, created_at, updated_at, import_key)
		 VALUES (10, 1, 'decision', 'fixture', 'body', 1, ?, ?, 'memory-10')`,
	).run(NOW, NOW);
}

function attributionSchema(db: Database.Database) {
	const tables = ["attribution_assessments", "attribution_assessment_evidence"];
	return {
		columns: Object.fromEntries(
			tables.map((table) => [table, db.prepare(`PRAGMA table_info(${table})`).all()]),
		),
		foreignKeys: Object.fromEntries(
			tables.map((table) => [table, db.prepare(`PRAGMA foreign_key_list(${table})`).all()]),
		),
		indexes: Object.fromEntries(
			tables.map((table) => {
				const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
					name: string;
					unique: number;
					origin: string;
					partial: number;
				}>;
				return [
					table,
					indexes.map((index) => ({
						name: index.name,
						unique: index.unique,
						origin: index.origin,
						partial: index.partial,
						columns: db.prepare(`PRAGMA index_info(${index.name})`).all(),
					})),
				];
			}),
		),
		triggers: db
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%attribution%' ORDER BY name",
			)
			.all(),
	};
}

describe("contract-v1 attribution assessments", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = new Database(":memory:");
		seed(db);
	});

	afterEach(() => db.close());

	it("records an attempt-level helpful assessment without assigning per-memory ROI", () => {
		recordRetrievalAttempt(db, attempt(1));
		const evidenceId = feedback(db, 101, "helpful", id(1));
		const result = recordAttributionAssessment(db, assessment(id(1), id(201), [evidenceId]));

		expect(result.assessment).toMatchObject({
			contractVersion: 1,
			subjectType: "attempt",
			exposureId: null,
			impactLabel: "helpful",
			claimType: "observational",
			evidenceIds: [evidenceId],
		});
		expect(result.inserted).toBe(true);
		expect(recordAttributionAssessment(db, assessment(id(1), id(201), [evidenceId])).inserted).toBe(
			false,
		);
	});

	it("requires and canonicalizes explicit time zones on write, retry, and read", () => {
		recordRetrievalAttempt(db, attempt(7000));
		const evidenceId = feedback(db, 7001, "helpful", id(7000));
		const assessmentId = id(7002);
		const offsetInput = assessment(id(7000), assessmentId, [evidenceId], {
			createdAt: "2026-08-03T14:02:00+02:00",
		});

		expect(recordAttributionAssessment(db, offsetInput)).toMatchObject({
			inserted: true,
			assessment: { createdAt: ASSESSED_AT },
		});
		expect(
			recordAttributionAssessment(db, { ...offsetInput, createdAt: "2026-08-03T07:02:00-05:00" })
				.inserted,
		).toBe(false);

		for (const [index, createdAt] of [
			"2026-08-03T12:02:00",
			"2026-08-03",
			"2026-02-30T12:02:00Z",
			"not-a-timestamp",
		].entries()) {
			const input = assessment(id(7000), id(7010 + index), [evidenceId], { createdAt });
			expect(() => recordAttributionAssessment(db, input)).toThrow("explicit time zone");
			expect(tryRecordAttributionAssessment(db, input)).toMatchObject({
				ok: false,
				reason: "invalid_input",
			});
		}

		db.prepare("UPDATE attribution_assessments SET created_at = ? WHERE assessment_id = ?").run(
			"2026-08-03T12:02:00",
			assessmentId,
		);
		expect(getAttributionAssessment(db, assessmentId)).toBeNull();
		expect(queryAttributionAssessments(db, { attemptId: id(7000) })).toEqual([]);
		expect(queryAttributionAssessmentPage(db, { attemptId: id(7000) })).toMatchObject({
			assessments: [],
			invalidRowCount: 1,
		});
	});

	it("rejects attempt assessments unless a selected exposure was confirmed handed off", () => {
		const rejectedAttempts: Array<Partial<RecordRetrievalAttemptInput>> = [
			{
				retrievalStatus: "succeeded",
				deliveryStatus: "failed",
				exposures: attempt(30).exposures.map((row) => ({ ...row, handoffStatus: "failed" })),
			},
			{
				retrievalStatus: "succeeded",
				deliveryStatus: "not_attempted",
				exposures: attempt(31).exposures.map((row) => ({
					...row,
					handoffStatus: "not_attempted",
				})),
			},
			{
				retrievalStatus: "succeeded",
				deliveryStatus: "unknown",
				exposures: attempt(32).exposures.map((row) => ({ ...row, handoffStatus: "unknown" })),
			},
			{
				retrievalStatus: "failed",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				exposures: [],
			},
			{
				retrievalStatus: "skipped",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				exposures: [],
			},
			{
				retrievalStatus: "no_results",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				exposures: [],
			},
			{
				retrievalStatus: "unknown",
				deliveryStatus: "unknown",
				exposures: attempt(36).exposures.map((row) => ({ ...row, handoffStatus: "unknown" })),
			},
			{
				retrievalStatus: "succeeded",
				deliveryStatus: "not_attempted",
				candidateCount: 1,
				selectedCount: 0,
				exposures: [
					{
						memoryImportKey: "memory-unselected",
						rank: 1,
						disposition: "dropped",
						handoffStatus: "not_attempted",
					},
				],
			},
		];

		for (const [index, overrides] of rejectedAttempts.entries()) {
			const sequence = 30 + index;
			recordRetrievalAttempt(db, attempt(sequence, overrides));
			const evidenceId = feedback(db, 130 + index, "helpful", id(sequence));
			expect(
				tryRecordAttributionAssessment(db, assessment(id(sequence), id(230 + index), [evidenceId])),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}
	});

	it("binds attempt evidence only through selected handed-off exposures", () => {
		const recorded = recordRetrievalAttempt(
			db,
			attempt(80, {
				candidateCount: 5,
				selectedCount: 1,
				exposures: [
					...attempt(80).exposures,
					...(["dropped", "deduped", "trimmed", "compressed"] as const).map(
						(disposition, index) => ({
							memoryImportKey: `diagnostic-${disposition}`,
							rank: index + 2,
							disposition,
							handoffStatus: "not_attempted" as const,
						}),
					),
				],
			}),
		).attempt;
		const selectedReferenceId = id(520);
		const mixedReferenceId = id(521);
		const explicitAttemptId = id(522);
		for (const [evidenceId, actionId, referenceCodes] of [
			[selectedReferenceId, "selected-memory", ["memory:memory-10"]],
			[
				mixedReferenceId,
				"selected-plus-diagnostic",
				["memory:memory-10", "memory:diagnostic-dropped"],
			],
			[explicitAttemptId, "explicit-attempt", [`attempt:${recorded.attemptId}`]],
		] as const) {
			recordOutcomeEvidence(
				db,
				explicitFeedbackEvidence({
					evidenceId,
					observedAt: COMPLETED_AT,
					producer: "feedback-action",
					producerVersion: "v1",
					feedback: "helpful",
					actionId,
					gate: "structured_action",
					referenceCodes: [...referenceCodes],
					correlation: { sessionId: 1 },
				}),
			);
		}

		for (const [offset, evidenceId] of [
			selectedReferenceId,
			mixedReferenceId,
			explicitAttemptId,
		].entries()) {
			const assessmentId = id(523 + offset);
			const result = recordAttributionAssessment(
				db,
				assessment(recorded.attemptId, assessmentId, [evidenceId]),
			);
			expect(result.assessment.impactLabel).toBe("helpful");
			expect(
				recordAttributionAssessment(db, assessment(recorded.attemptId, assessmentId, [evidenceId]))
					.inserted,
			).toBe(false);
			expect(getAttributionAssessment(db, assessmentId)?.assessmentId).toBe(assessmentId);
		}
	});

	it("rejects memory references shared by correlated handed-off attempts", () => {
		const first = recordRetrievalAttempt(db, attempt(82)).attempt;
		const second = recordRetrievalAttempt(db, attempt(83)).attempt;
		const ambiguousEvidenceId = id(540);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId: ambiguousEvidenceId,
				observedAt: COMPLETED_AT,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "ambiguous-memory",
				gate: "structured_action",
				referenceCodes: ["memory:memory-10"],
				correlation: { sessionId: 1 },
			}),
		);

		expect(() =>
			recordAttributionAssessment(db, assessment(first.attemptId, id(541), [ambiguousEvidenceId])),
		).toThrow(/memory references must uniquely identify one correlated retrieval attempt/);
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(second.attemptId, id(542), [ambiguousEvidenceId]),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const exactAttemptEvidenceId = feedback(db, 543, "helpful", first.attemptId);
		expect(
			recordAttributionAssessment(
				db,
				assessment(first.attemptId, id(544), [exactAttemptEvidenceId]),
			).assessment.attemptId,
		).toBe(first.attemptId);

		const exposureId = second.exposures[0]?.exposureId;
		expect(exposureId).toBeDefined();
		const exactExposureEvidenceId = id(545);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId: exactExposureEvidenceId,
				observedAt: COMPLETED_AT,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "exact-exposure",
				gate: "structured_action",
				referenceCodes: [`exposure:${exposureId}`],
				correlation: { sessionId: 1 },
			}),
		);
		expect(
			recordAttributionAssessment(
				db,
				assessment(second.attemptId, id(546), [exactExposureEvidenceId], {
					subjectType: "exposure",
					exposureId,
				}),
			).assessment.exposureId,
		).toBe(exposureId);
	});

	it("scopes memory-reference uniqueness to correlated attempts and revalidates persisted rows", () => {
		db.prepare("INSERT INTO sessions(id, started_at, project) VALUES (2, ?, 'other')").run(NOW);
		const first = recordRetrievalAttempt(db, attempt(84)).attempt;
		recordRetrievalAttempt(db, attempt(85, { sessionId: 2 }));
		const evidenceId = id(547);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId,
				observedAt: COMPLETED_AT,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "session-scoped-memory",
				gate: "structured_action",
				referenceCodes: ["memory:memory-10"],
				correlation: { sessionId: 1 },
			}),
		);
		const assessmentId = id(548);
		recordAttributionAssessment(db, assessment(first.attemptId, assessmentId, [evidenceId]));
		expect(getAttributionAssessment(db, assessmentId)?.assessmentId).toBe(assessmentId);

		recordRetrievalAttempt(db, attempt(86));
		expect(getAttributionAssessment(db, assessmentId)).toBeNull();
		expect(getAttributionDiagnostics(db).evidenceCompleteness.assessmentRowsInvalid).toBe(1);
	});

	it("rejects diagnostic-only references on direct, try, and fail-closed read paths", () => {
		const recorded = recordRetrievalAttempt(
			db,
			attempt(81, {
				candidateCount: 3,
				selectedCount: 1,
				exposures: [
					...attempt(81).exposures,
					{
						memoryImportKey: "diagnostic-dropped",
						rank: 2,
						disposition: "dropped",
						handoffStatus: "not_attempted",
					},
					{
						memoryImportKey: "diagnostic-deduped",
						rank: 3,
						disposition: "deduped",
						handoffStatus: "not_attempted",
					},
				],
			}),
		).attempt;
		const droppedId = id(530);
		const dedupedId = id(531);
		for (const [evidenceId, memoryImportKey] of [
			[droppedId, "diagnostic-dropped"],
			[dedupedId, "diagnostic-deduped"],
		] as const) {
			recordOutcomeEvidence(
				db,
				explicitFeedbackEvidence({
					evidenceId,
					observedAt: COMPLETED_AT,
					producer: "feedback-action",
					producerVersion: "v1",
					feedback: "helpful",
					actionId: memoryImportKey,
					gate: "structured_action",
					referenceCodes: [`memory:${memoryImportKey}`],
					correlation: { sessionId: 1 },
				}),
			);
		}

		expect(() =>
			recordAttributionAssessment(db, assessment(recorded.attemptId, id(532), [droppedId])),
		).toThrow("known attempt attribution requires linked evidence naming the attempt");
		expect(
			tryRecordAttributionAssessment(db, assessment(recorded.attemptId, id(533), [dedupedId])),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const persistedId = id(534);
		const selectedId = id(535);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId: selectedId,
				observedAt: COMPLETED_AT,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "read-revalidation",
				gate: "structured_action",
				referenceCodes: ["memory:memory-10"],
				correlation: { sessionId: 1 },
			}),
		);
		recordAttributionAssessment(db, assessment(recorded.attemptId, persistedId, [selectedId]));
		const persistedReferences = JSON.parse(
			db
				.prepare("SELECT references_json FROM outcome_evidence WHERE evidence_id = ?")
				.pluck()
				.get(selectedId) as string,
		) as Record<string, unknown>;
		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify({
				...persistedReferences,
				reference_codes: ["memory:diagnostic-dropped"],
			}),
			selectedId,
		);
		expect(getAttributionAssessment(db, persistedId)).toBeNull();
		expect(queryAttributionAssessments(db, { attemptId: recorded.attemptId })).toEqual([]);
	});

	it("rejects selected memory references until their attempt is handed off", () => {
		for (const [offset, deliveryStatus] of (["failed", "not_attempted"] as const).entries()) {
			const sequence = 82 + offset;
			const recorded = recordRetrievalAttempt(
				db,
				attempt(sequence, {
					deliveryStatus,
					exposures: attempt(sequence).exposures.map((row) => ({
						...row,
						handoffStatus: deliveryStatus,
					})),
				}),
			).attempt;
			const evidenceId = id(540 + offset);
			recordOutcomeEvidence(
				db,
				explicitFeedbackEvidence({
					evidenceId,
					observedAt: COMPLETED_AT,
					producer: "feedback-action",
					producerVersion: "v1",
					feedback: "helpful",
					actionId: `undelivered-${deliveryStatus}`,
					gate: "structured_action",
					referenceCodes: ["memory:memory-10"],
					correlation: { sessionId: 1 },
				}),
			);
			const input = assessment(recorded.attemptId, id(542 + offset), [evidenceId]);
			if (offset === 0) {
				expect(() => recordAttributionAssessment(db, input)).toThrow(
					"attempt assessments require a confirmed selected handoff",
				);
			}
			expect(
				tryRecordAttributionAssessment(db, { ...input, assessmentId: id(544 + offset) }),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}

		for (const [offset, tamper] of (["disposition", "delivery"] as const).entries()) {
			const sequence = 86 + offset;
			const recorded = recordRetrievalAttempt(db, attempt(sequence)).attempt;
			const evidenceId = id(586 + offset * 2);
			const assessmentId = id(587 + offset * 2);
			recordOutcomeEvidence(
				db,
				explicitFeedbackEvidence({
					evidenceId,
					observedAt: COMPLETED_AT,
					producer: "feedback-action",
					producerVersion: "v1",
					feedback: "helpful",
					actionId: `read-${tamper}`,
					gate: "structured_action",
					referenceCodes: ["memory:memory-10"],
					correlation: { sessionId: 1 },
				}),
			);
			recordAttributionAssessment(db, assessment(recorded.attemptId, assessmentId, [evidenceId]));
			if (tamper === "disposition") {
				db.prepare(
					"UPDATE retrieval_exposures SET disposition = 'dropped', handoff_status = 'not_attempted' WHERE attempt_id = ?",
				).run(recorded.attemptId);
			} else {
				db.prepare(
					"UPDATE retrieval_attempts SET delivery_status = 'failed' WHERE attempt_id = ?",
				).run(recorded.attemptId);
				db.prepare(
					"UPDATE retrieval_exposures SET handoff_status = 'failed' WHERE attempt_id = ?",
				).run(recorded.attemptId);
			}
			expect(getAttributionAssessment(db, assessmentId)).toBeNull();
		}
	});

	it("applies the same eligible exposure binding to observational basis witnesses", () => {
		const recorded = recordRetrievalAttempt(
			db,
			attempt(84, {
				candidateCount: 2,
				selectedCount: 1,
				exposures: [
					...attempt(84).exposures,
					{
						memoryImportKey: "diagnostic-only",
						rank: 2,
						disposition: "trimmed",
						handoffStatus: "not_attempted",
					},
				],
			}),
		).attempt;
		const cases = [
			["explicit_reference", "mechanism.memory_reference", "derived", "mechanism"],
			["content_overlap", "mechanism.command_or_constraint_reuse", "derived", "mechanism"],
			["human_review", "mechanism.memory_reference", "evaluator", "mechanism"],
			["blinded_evaluator", "quality.blinded_evaluator", "evaluator", "quality"],
		] as const;

		for (const [index, [basis, evidenceType, sourceClass, dimension]] of cases.entries()) {
			const validId = id(550 + index * 2);
			const diagnosticId = id(551 + index * 2);
			for (const [evidenceId, referenceCode] of [
				[validId, "memory:memory-10"],
				[diagnosticId, "memory:diagnostic-only"],
			] as const) {
				recordOutcomeEvidence(db, {
					evidenceId,
					dimension,
					evidenceType,
					sourceClass,
					observedAt: COMPLETED_AT,
					producer: `basis-${basis}`,
					producerVersion: "v1",
					status: evidenceType === "quality.blinded_evaluator" ? "unknown" : "present",
					sessionId: 1,
					references: {
						...(basis === "human_review"
							? { rubric_id: "human-review-rubric" }
							: evidenceType === "quality.blinded_evaluator"
								? { assertion_id: `assertion-${evidenceId}`, rubric_id: "quality-rubric" }
								: {}),
						reference_codes: [referenceCode],
					},
				});
			}

			expect(
				recordAttributionAssessment(
					db,
					assessment(recorded.attemptId, id(560 + index * 2), [validId], {
						dimension,
						impactLabel: "unknown",
						basis,
					}),
				).assessment.basis,
			).toBe(basis);
			expect(
				tryRecordAttributionAssessment(
					db,
					assessment(recorded.attemptId, id(561 + index * 2), [diagnosticId], {
						dimension,
						impactLabel: "unknown",
						basis,
					}),
				),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}

		const validSourceId = id(570);
		const diagnosticSourceId = id(571);
		for (const [evidenceId, referenceCode] of [
			[validSourceId, "memory:memory-10"],
			[diagnosticSourceId, "memory:diagnostic-only"],
		] as const) {
			recordOutcomeEvidence(
				db,
				referencing(
					sourceLocationOverlapEvidence({
						evidenceId,
						observedAt: COMPLETED_AT,
						producer: "path-rule",
						producerVersion: "v1",
						retrievedPaths: ["packages/core/src/schema.ts"],
						downstreamPaths: ["packages/core/src/schema.ts"],
						correlation: { sessionId: 1 },
					}),
					referenceCode,
				),
			);
		}
		expect(
			recordAttributionAssessment(
				db,
				assessment(recorded.attemptId, id(572), [validSourceId], {
					dimension: "mechanism",
					impactLabel: "unknown",
					basis: "source_location_overlap",
				}),
			).assessment.basis,
		).toBe("source_location_overlap");
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(recorded.attemptId, id(573), [diagnosticSourceId], {
					dimension: "mechanism",
					impactLabel: "unknown",
					basis: "source_location_overlap",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const helpfulId = id(574);
		const validReviewId = id(575);
		const diagnosticDimensionId = id(576);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId: helpfulId,
				observedAt: COMPLETED_AT,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "selected-label",
				gate: "structured_action",
				referenceCodes: ["memory:memory-10"],
				correlation: { sessionId: 1 },
			}),
		);
		recordOutcomeEvidence(db, {
			evidenceId: validReviewId,
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "evaluator",
			observedAt: COMPLETED_AT,
			producer: "human-review",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: {
				rubric_id: "human-review-rubric",
				reference_codes: ["memory:memory-10"],
			},
		});
		recordOutcomeEvidence(db, {
			evidenceId: diagnosticDimensionId,
			dimension: "quality",
			evidenceType: "quality.blinded_evaluator",
			sourceClass: "evaluator",
			observedAt: COMPLETED_AT,
			producer: "human-review",
			producerVersion: "v1",
			status: "unknown",
			sessionId: 1,
			references: {
				assertion_id: "diagnostic-dimension",
				rubric_id: "quality-rubric",
				reference_codes: ["memory:diagnostic-only"],
			},
		});
		expect(() =>
			recordAttributionAssessment(
				db,
				assessment(recorded.attemptId, id(577), [helpfulId, validReviewId, diagnosticDimensionId], {
					dimension: "quality",
					basis: "human_review",
				}),
			),
		).toThrow("assessment dimension must be represented by supporting evidence");
	});

	it("rejects non-positive or ungrounded observational basis witnesses", () => {
		const recorded = recordRetrievalAttempt(db, attempt(799)).attempt;
		const cases = [
			{
				basis: "explicit_reference",
				evidenceType: "mechanism.memory_reference",
				sourceClass: "derived",
				status: "unknown",
			},
			{
				basis: "content_overlap",
				evidenceType: "mechanism.command_or_constraint_reuse",
				sourceClass: "user_reported",
				status: "present",
			},
			{
				basis: "temporal_followup",
				evidenceType: "mechanism.retrieval_followup",
				sourceClass: "derived",
				status: "unknown",
			},
		] as const;

		for (const [index, testCase] of cases.entries()) {
			const evidenceId = id(800 + index);
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "mechanism",
				evidenceType: testCase.evidenceType,
				sourceClass: testCase.sourceClass,
				observedAt: COMPLETED_AT,
				producer: "invalid-basis-witness",
				producerVersion: "v1",
				status: testCase.status,
				sessionId: 1,
				references: { reference_codes: [`attempt:${recorded.attemptId}`] },
			});

			expect(() =>
				recordAttributionAssessment(
					db,
					assessment(recorded.attemptId, id(810 + index), [evidenceId], {
						dimension: "mechanism",
						impactLabel: "unknown",
						basis: testCase.basis,
						confidenceLevel: "low",
					}),
				),
			).toThrow(/requires/);
		}
	});

	it("does not let diagnostic exposure references isolate a randomized assessment", () => {
		const recorded = recordRetrievalAttempt(
			db,
			attempt(85, {
				candidateCount: 3,
				selectedCount: 2,
				experimentId: "experiment-1",
				experimentCellId: "cell-treatment",
				exposures: [
					...attempt(85).exposures,
					{
						memoryImportKey: "second-selected",
						rank: 2,
						disposition: "selected",
						handoffStatus: "handed_off",
					},
					{
						memoryImportKey: "diagnostic-randomized",
						rank: 3,
						disposition: "dropped",
						handoffStatus: "not_attempted",
					},
				],
			}),
		).attempt;
		recordExperimentControlAttempt(db, 5085);
		const exposureId = recorded.exposures[0]?.exposureId;
		if (exposureId == null) throw new Error("fixture exposure missing");
		const validIds = [
			experimentQualityEvidence(db, 580, {
				cellId: "cell-treatment",
				status: "pass",
				checkId: "selected-exposure-contrast",
				referenceCodes: ["experiment.preregistered", "memory:memory-10"],
			}),
			experimentQualityEvidence(db, 581, {
				cellId: "cell-control",
				status: "fail",
				checkId: "selected-exposure-contrast",
				referenceCodes: ["experiment.preregistered", "memory:memory-10"],
			}),
		];
		const diagnosticIds = [
			experimentQualityEvidence(db, 582, {
				cellId: "cell-treatment",
				status: "pass",
				checkId: "diagnostic-exposure-contrast",
				referenceCodes: ["experiment.preregistered", "memory:diagnostic-randomized"],
			}),
			experimentQualityEvidence(db, 583, {
				cellId: "cell-control",
				status: "fail",
				checkId: "diagnostic-exposure-contrast",
				referenceCodes: ["experiment.preregistered", "memory:diagnostic-randomized"],
			}),
		];

		expect(
			recordAttributionAssessment(
				db,
				assessment(recorded.attemptId, id(584), validIds, {
					subjectType: "exposure",
					exposureId,
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			).assessment.impactLabel,
		).toBe("helpful");
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(recorded.attemptId, id(585), diagnosticIds, {
					subjectType: "exposure",
					exposureId,
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("requires persisted one-to-one selection before inferring an exposure from an attempt reference", () => {
		const twoSelected = recordRetrievalAttempt(
			db,
			attempt(88, {
				candidateCount: 2,
				selectedCount: 2,
				exposures: [
					...attempt(88).exposures,
					{
						memoryImportKey: "memory-second",
						rank: 2,
						disposition: "selected",
						handoffStatus: "handed_off",
					},
				],
			}),
		).attempt;
		const assessedExposureId = twoSelected.exposures[0]?.exposureId;
		const deletedExposureId = twoSelected.exposures[1]?.exposureId;
		if (assessedExposureId == null || deletedExposureId == null)
			throw new Error("fixture exposure missing");
		db.prepare("DELETE FROM retrieval_exposures WHERE exposure_id = ?").run(deletedExposureId);
		const attemptEvidenceId = feedback(db, 590, "helpful", twoSelected.attemptId);
		const inferred = assessment(twoSelected.attemptId, id(591), [attemptEvidenceId], {
			subjectType: "exposure",
			exposureId: assessedExposureId,
		});
		expect(() => recordAttributionAssessment(db, inferred)).toThrow(
			"exposure assessment failed the documented isolation gate",
		);
		expect(
			tryRecordAttributionAssessment(db, { ...inferred, assessmentId: id(592) }),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const persisted = recordRetrievalAttempt(db, attempt(89)).attempt;
		const persistedExposureId = persisted.exposures[0]?.exposureId;
		if (persistedExposureId == null) throw new Error("fixture exposure missing");
		const persistedEvidenceId = feedback(db, 593, "helpful", persisted.attemptId);
		const persistedAssessmentId = id(594);
		recordAttributionAssessment(
			db,
			assessment(persisted.attemptId, persistedAssessmentId, [persistedEvidenceId], {
				subjectType: "exposure",
				exposureId: persistedExposureId,
			}),
		);
		db.pragma("foreign_keys = OFF");
		db.prepare("DELETE FROM retrieval_exposures WHERE exposure_id = ?").run(persistedExposureId);
		expect(
			db
				.prepare("SELECT count(*) FROM attribution_assessments WHERE assessment_id = ?")
				.pluck()
				.get(persistedAssessmentId),
		).toBe(1);
		expect(getAttributionAssessment(db, persistedAssessmentId)).toBeNull();
	});

	it("requires each exposure witness to name only the assessed eligible exposure", () => {
		const recorded = recordRetrievalAttempt(
			db,
			attempt(90, {
				candidateCount: 2,
				selectedCount: 2,
				exposures: [
					...attempt(90).exposures,
					{
						memoryImportKey: "memory-second",
						rank: 2,
						disposition: "selected",
						handoffStatus: "handed_off",
					},
				],
			}),
		).attempt;
		const firstExposureId = recorded.exposures[0]?.exposureId;
		if (firstExposureId == null) throw new Error("fixture exposure missing");
		const mixedEvidenceId = id(595);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId: mixedEvidenceId,
				observedAt: COMPLETED_AT,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "mixed-eligible-exposures",
				gate: "structured_action",
				referenceCodes: ["memory:memory-10", "memory:memory-second"],
				correlation: { sessionId: 1 },
			}),
		);
		const mixedInput = assessment(recorded.attemptId, id(596), [mixedEvidenceId], {
			subjectType: "exposure",
			exposureId: firstExposureId,
		});
		expect(() => recordAttributionAssessment(db, mixedInput)).toThrow(
			"exposure assessment failed the documented isolation gate",
		);
		expect(
			tryRecordAttributionAssessment(db, { ...mixedInput, assessmentId: id(597) }),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const validEvidenceId = id(598);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId: validEvidenceId,
				observedAt: COMPLETED_AT,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "single-eligible-exposure",
				gate: "structured_action",
				referenceCodes: ["memory:memory-10"],
				correlation: { sessionId: 1 },
			}),
		);
		const persistedAssessmentId = id(599);
		recordAttributionAssessment(
			db,
			assessment(recorded.attemptId, persistedAssessmentId, [validEvidenceId], {
				subjectType: "exposure",
				exposureId: firstExposureId,
			}),
		);
		const references = JSON.parse(
			db
				.prepare("SELECT references_json FROM outcome_evidence WHERE evidence_id = ?")
				.pluck()
				.get(validEvidenceId) as string,
		) as Record<string, unknown>;
		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify({
				...references,
				reference_codes: ["memory:memory-10", "memory:memory-second"],
			}),
			validEvidenceId,
		);
		expect(getAttributionAssessment(db, persistedAssessmentId)).toBeNull();

		expect(
			recordAttributionAssessment(db, assessment(recorded.attemptId, id(600), [mixedEvidenceId]))
				.assessment.subjectType,
		).toBe("attempt");
	});

	it("requires temporal followups to name the assessment subject", () => {
		const recorded = recordRetrievalAttempt(
			db,
			attempt(93, {
				candidateCount: 2,
				selectedCount: 1,
				exposures: [
					...attempt(93).exposures,
					{
						memoryImportKey: "diagnostic-followup",
						rank: 2,
						disposition: "dropped",
						handoffStatus: "not_attempted",
					},
				],
			}),
		).attempt;
		for (const [offset, referenceCode] of [
			"memory:diagnostic-followup",
			`attempt:${id(999)}`,
		].entries()) {
			const evidenceId = id(601 + offset);
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "mechanism",
				evidenceType: "mechanism.retrieval_followup",
				sourceClass: "derived",
				observedAt: COMPLETED_AT,
				producer: "followup-rule",
				producerVersion: "v1",
				status: "present",
				sessionId: 1,
				references: { reference_codes: [referenceCode] },
			});
			expect(
				tryRecordAttributionAssessment(
					db,
					assessment(recorded.attemptId, id(603 + offset), [evidenceId], {
						dimension: "mechanism",
						impactLabel: "unknown",
						basis: "temporal_followup",
						confidenceLevel: "low",
					}),
				),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}

		const multi = recordRetrievalAttempt(
			db,
			attempt(95, {
				candidateCount: 2,
				selectedCount: 2,
				exposures: [
					...attempt(95).exposures,
					{
						memoryImportKey: "other-selected-followup",
						rank: 2,
						disposition: "selected",
						handoffStatus: "handed_off",
					},
				],
			}),
		).attempt;
		const assessedExposureId = multi.exposures[0]?.exposureId;
		if (assessedExposureId == null) throw new Error("fixture exposure missing");
		const subjectEvidenceId = id(605);
		const otherFollowupId = id(606);
		for (const [evidenceId, evidenceType, referenceCode] of [
			[subjectEvidenceId, "mechanism.memory_reference", "memory:memory-10"],
			[otherFollowupId, "mechanism.retrieval_followup", "memory:other-selected-followup"],
		] as const) {
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "mechanism",
				evidenceType,
				sourceClass: "derived",
				observedAt: COMPLETED_AT,
				producer: "followup-rule",
				producerVersion: "v1",
				status: "present",
				sessionId: 1,
				references: { reference_codes: [referenceCode] },
			});
		}
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(multi.attemptId, id(607), [subjectEvidenceId, otherFollowupId], {
					subjectType: "exposure",
					exposureId: assessedExposureId,
					dimension: "mechanism",
					impactLabel: "unknown",
					basis: "temporal_followup",
					confidenceLevel: "low",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("rejects same-session explicit evidence that does not name the subject", () => {
		recordRetrievalAttempt(db, attempt(21));
		const evidenceId = id(121);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId,
				observedAt: NOW,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "same-session-only",
				gate: "structured_action",
				correlation: { sessionId: 1 },
			}),
		);

		expect(
			tryRecordAttributionAssessment(db, assessment(id(21), id(221), [evidenceId])),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("requires the known-label witness itself to name the assessed subject", () => {
		recordRetrievalAttempt(db, attempt(26));
		const unrelatedFeedbackId = id(326);
		const subjectMechanismId = id(327);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId: unrelatedFeedbackId,
				observedAt: COMPLETED_AT,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "unrelated-helpful",
				gate: "structured_action",
				correlation: { sessionId: 1 },
			}),
		);
		recordOutcomeEvidence(db, {
			evidenceId: subjectMechanismId,
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "derived",
			observedAt: COMPLETED_AT,
			producer: "reference-rule",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: { reference_codes: [`attempt:${id(26)}`] },
		});

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(26), id(328), [unrelatedFeedbackId, subjectMechanismId]),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("derives assessment dimension only from label and basis witnesses", () => {
		recordRetrievalAttempt(db, attempt(27));
		const feedbackId = feedback(db, 329, "helpful", id(27));
		const unrelatedEfficiencyId = id(330);
		recordOutcomeEvidence(db, {
			evidenceId: unrelatedEfficiencyId,
			dimension: "efficiency",
			evidenceType: "efficiency.tool_call_count",
			sourceClass: "observed",
			observedAt: COMPLETED_AT,
			producer: "metrics",
			producerVersion: "v1",
			status: "present",
			value: { type: "integer", value: 1, unit: "count" },
			sessionId: 1,
		});

		for (const [sequence, dimension, evidenceIds] of [
			[331, "quality", [feedbackId]],
			[332, "safety", [feedbackId]],
			[333, "efficiency", [feedbackId, unrelatedEfficiencyId]],
		] as const) {
			expect(
				tryRecordAttributionAssessment(
					db,
					assessment(id(27), id(sequence), [...evidenceIds], { dimension }),
				),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}
	});

	it("rejects numeric local memory references and retains stable references after deletion", () => {
		recordRetrievalAttempt(db, attempt(28));
		const numericId = id(334);
		const stableId = id(335);
		for (const [evidenceId, referenceCode, actionId] of [
			[numericId, "memory:10", "numeric-memory"],
			[stableId, "memory:memory-10", "stable-memory"],
		] as const) {
			recordOutcomeEvidence(
				db,
				explicitFeedbackEvidence({
					evidenceId,
					observedAt: COMPLETED_AT,
					producer: "feedback-action",
					producerVersion: "v1",
					feedback: "helpful",
					actionId,
					gate: "structured_action",
					referenceCodes: [referenceCode],
					correlation: { sessionId: 1 },
				}),
			);
		}

		expect(
			tryRecordAttributionAssessment(db, assessment(id(28), id(336), [numericId])),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		const assessmentId = id(337);
		recordAttributionAssessment(db, assessment(id(28), assessmentId, [stableId]));

		db.prepare("UPDATE memory_items SET active = 0, deleted_at = ? WHERE id = 10").run(ASSESSED_AT);
		expect(getAttributionAssessment(db, assessmentId)).not.toBeNull();
		db.prepare("DELETE FROM memory_items WHERE id = 10").run();
		expect(getAttributionAssessment(db, assessmentId)).not.toBeNull();
	});

	it("rejects pre-retrieval observational evidence for a repeated memory and accepts exact boundaries", () => {
		recordRetrievalAttempt(db, attempt(24));
		const preRetrievalId = id(301);
		const completionBoundaryId = id(302);
		const assessmentBoundaryId = id(303);
		for (const [evidenceId, observedAt, actionId] of [
			[preRetrievalId, NOW, "pre-retrieval"],
			[completionBoundaryId, COMPLETED_AT, "completion-boundary"],
			[assessmentBoundaryId, ASSESSED_AT, "assessment-boundary"],
		] as const) {
			recordOutcomeEvidence(
				db,
				explicitFeedbackEvidence({
					evidenceId,
					observedAt,
					producer: "feedback-action",
					producerVersion: "v1",
					feedback: "helpful",
					actionId,
					gate: "structured_action",
					referenceCodes: ["memory:memory-10"],
					correlation: { sessionId: 1 },
				}),
			);
		}

		expect(
			tryRecordAttributionAssessment(db, assessment(id(24), id(304), [preRetrievalId])),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(24), id(305), [completionBoundaryId, assessmentBoundaryId]),
			).assessment.evidenceIds,
		).toEqual([completionBoundaryId, assessmentBoundaryId]);
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(24), id(306), [preRetrievalId, completionBoundaryId]),
			).assessment.evidenceIds,
		).toEqual([preRetrievalId, completionBoundaryId].sort());
	});

	it("gates every non-randomized basis family at retrieval completion", () => {
		expect(NON_RANDOMIZED_BASIS_CASES.map((testCase) => testCase.family).sort()).toEqual(
			[
				"blinded_evaluator",
				"explicit_reference",
				"human_evaluator",
				"observational_correlation",
				"source_location_overlap",
				"temporal_followup",
			].sort(),
		);
		expect(NON_RANDOMIZED_BASIS_CASES.map((testCase) => testCase.basis).sort()).toEqual(
			[
				"blinded_evaluator",
				"content_overlap",
				"explicit_reference",
				"human_review",
				"source_location_overlap",
				"temporal_followup",
			].sort(),
		);

		for (const [index, testCase] of NON_RANDOMIZED_BASIS_CASES.entries()) {
			const attemptId = id(700 + index);
			recordRetrievalAttempt(db, attempt(700 + index));
			const preRetrievalId = basisEvidence(db, 800 + index * 2, attemptId, NOW, testCase);
			const boundaryId = basisEvidence(db, 801 + index * 2, attemptId, COMPLETED_AT, testCase);
			const basisAssessment = (
				assessmentId: string,
				evidenceIds: string[],
			): RecordAttributionAssessmentInput =>
				assessment(attemptId, assessmentId, evidenceIds, {
					dimension: testCase.dimension,
					impactLabel: "unknown",
					basis: testCase.basis,
					confidenceLevel: testCase.basis === "temporal_followup" ? "low" : "medium",
				});

			expect(() =>
				recordAttributionAssessment(db, basisAssessment(id(900 + index * 3), [preRetrievalId])),
			).toThrow();
			expect(
				tryRecordAttributionAssessment(db, basisAssessment(id(901 + index * 3), [preRetrievalId])),
			).toMatchObject({ ok: false, reason: "invalid_input" });

			const boundaryAssessmentId = id(902 + index * 3);
			const boundaryInput = basisAssessment(boundaryAssessmentId, [boundaryId]);
			expect(recordAttributionAssessment(db, boundaryInput)).toMatchObject({
				inserted: true,
				assessment: { basis: testCase.basis, evidenceIds: [boundaryId] },
			});
			expect(recordAttributionAssessment(db, boundaryInput).inserted).toBe(false);

			const mixedAssessmentId = id(1000 + index);
			expect(
				recordAttributionAssessment(
					db,
					basisAssessment(mixedAssessmentId, [preRetrievalId, boundaryId]),
				).assessment.evidenceIds,
			).toEqual([preRetrievalId, boundaryId].sort());
			expect(getAttributionAssessment(db, mixedAssessmentId)).not.toBeNull();

			db.prepare("UPDATE retrieval_attempts SET completed_at = ? WHERE attempt_id = ?").run(
				"2026-08-03T12:00:00.011Z",
				attemptId,
			);
			expect(getAttributionAssessment(db, boundaryAssessmentId)).toBeNull();
			expect(getAttributionAssessment(db, mixedAssessmentId)).toBeNull();
			expect(queryAttributionAssessments(db, { attemptId })).toEqual([]);
		}
	});

	it("rejects explicit feedback and evaluator reviews when attempt completion is absent", () => {
		const cases = [
			{
				attemptSequence: 111,
				evidenceSequence: 1110,
				assessmentSequence: 1111,
				dimension: "feedback" as const,
				impactLabel: "helpful" as const,
				basis: "explicit_reference" as const,
			},
			{
				attemptSequence: 112,
				evidenceSequence: 1112,
				assessmentSequence: 1113,
				dimension: "mechanism" as const,
				impactLabel: "unknown" as const,
				basis: "human_review" as const,
			},
			{
				attemptSequence: 113,
				evidenceSequence: 1114,
				assessmentSequence: 1115,
				dimension: "quality" as const,
				impactLabel: "unknown" as const,
				basis: "blinded_evaluator" as const,
			},
		];

		for (const testCase of cases) {
			const attemptId = id(testCase.attemptSequence);
			recordRetrievalAttempt(db, attempt(testCase.attemptSequence, { completedAt: null }));
			let evidenceId: string;
			if (testCase.basis === "explicit_reference") {
				evidenceId = feedback(db, testCase.evidenceSequence, "helpful", attemptId);
			} else {
				const basisCase = NON_RANDOMIZED_BASIS_CASES_BY_BASIS[testCase.basis];
				evidenceId = basisEvidence(
					db,
					testCase.evidenceSequence,
					attemptId,
					COMPLETED_AT,
					basisCase,
				);
			}
			const input = assessment(attemptId, id(testCase.assessmentSequence), [evidenceId], {
				dimension: testCase.dimension,
				impactLabel: testCase.impactLabel,
				basis: testCase.basis,
			});

			expect(() => recordAttributionAssessment(db, input)).toThrow(
				"attribution requires a reliable retrieval completion boundary",
			);
			expect(
				tryRecordAttributionAssessment(db, {
					...input,
					assessmentId: id(testCase.assessmentSequence + 100),
				}),
			).toMatchObject({ ok: false, reason: "invalid_input" });
			expect(queryAttributionAssessments(db, { attemptId })).toEqual([]);
		}
	});

	it("computes exposure label admission only from post-retrieval rows", () => {
		const recordedAttempt = recordRetrievalAttempt(db, attempt(110)).attempt;
		const exposureId = recordedAttempt.exposures[0]?.exposureId;
		if (exposureId == null) throw new Error("fixture exposure missing");

		const rowAExplicitHelpfulId = id(1100);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId: rowAExplicitHelpfulId,
				observedAt: COMPLETED_AT,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "row-a-post-retrieval-helpful",
				gate: "structured_action",
				referenceCodes: [`exposure:${exposureId}`],
				correlation: { sessionId: 1 },
			}),
		);

		const rowBPreRetrievalOverlapId = id(1101);
		const rowBPostRetrievalOverlapId = id(1102);
		for (const [evidenceId, observedAt] of [
			[rowBPreRetrievalOverlapId, NOW],
			[rowBPostRetrievalOverlapId, COMPLETED_AT],
		] as const) {
			recordOutcomeEvidence(
				db,
				referencing(
					sourceLocationOverlapEvidence({
						evidenceId,
						observedAt,
						producer: "path-rule",
						producerVersion: "v1",
						retrievedPaths: ["packages/core/src/attribution-assessment.ts"],
						downstreamPaths: ["packages/core/src/attribution-assessment.ts"],
						correlation: { sessionId: 1 },
					}),
					`exposure:${exposureId}`,
				),
			);
		}

		const rowCQualityPassId = id(1103);
		recordOutcomeEvidence(
			db,
			referencing(
				deterministicCheckEvidence({
					evidenceId: rowCQualityPassId,
					observedAt: COMPLETED_AT,
					producer: "test-runner",
					producerVersion: "v1",
					check: "test_result",
					checkId: "row-c-post-retrieval-quality",
					status: "pass",
					correlation: { sessionId: 1 },
				}),
				`exposure:${exposureId}`,
			),
		);

		const qualityAssessment = (assessmentId: string, overlapId: string) =>
			assessment(
				recordedAttempt.attemptId,
				assessmentId,
				[rowAExplicitHelpfulId, overlapId, rowCQualityPassId],
				{
					subjectType: "exposure",
					exposureId,
					dimension: "quality",
					basis: "explicit_reference",
				},
			);

		expect(() =>
			recordAttributionAssessment(db, qualityAssessment(id(1104), rowBPreRetrievalOverlapId)),
		).toThrow("assessment dimension must be represented by supporting evidence");
		expect(
			tryRecordAttributionAssessment(db, qualityAssessment(id(1105), rowBPreRetrievalOverlapId)),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			recordAttributionAssessment(db, qualityAssessment(id(1106), rowBPostRetrievalOverlapId))
				.assessment.dimension,
		).toBe("quality");
	});

	it("bounds exposure overlap support for a non-source-location basis and accepts completion boundaries", () => {
		const recordedAttempt = recordRetrievalAttempt(db, attempt(25)).attempt;
		const exposureId = recordedAttempt.exposures[0]?.exposureId;
		if (exposureId == null) throw new Error("fixture exposure missing");
		const preCompletionOverlapId = id(319);
		const preCompletionQualityId = id(320);
		const boundaryOverlapId = id(321);
		const boundaryQualityId = id(322);
		const reviewEvidenceId = id(323);
		for (const [evidenceId, observedAt] of [
			[preCompletionOverlapId, NOW],
			[boundaryOverlapId, COMPLETED_AT],
		] as const) {
			recordOutcomeEvidence(
				db,
				referencing(
					sourceLocationOverlapEvidence({
						evidenceId,
						observedAt,
						producer: "path-rule",
						producerVersion: "v1",
						retrievedPaths: ["packages/core/src/schema.ts"],
						downstreamPaths: ["packages/core/src/schema.ts"],
						correlation: { sessionId: 1 },
					}),
					`exposure:${exposureId}`,
				),
			);
		}
		for (const [evidenceId, observedAt, checkId] of [
			[preCompletionQualityId, NOW, "pre-completion-quality"],
			[boundaryQualityId, COMPLETED_AT, "boundary-quality"],
		] as const) {
			recordOutcomeEvidence(
				db,
				referencing(
					deterministicCheckEvidence({
						evidenceId,
						observedAt,
						producer: "test-runner",
						producerVersion: "v1",
						check: "test_result",
						checkId,
						status: "pass",
						correlation: { sessionId: 1 },
					}),
					`exposure:${exposureId}`,
				),
			);
		}
		recordOutcomeEvidence(db, {
			evidenceId: reviewEvidenceId,
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "evaluator",
			observedAt: COMPLETED_AT,
			producer: "human-review",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: {
				rubric_id: "human-review-rubric",
				reference_codes: [`exposure:${exposureId}`],
			},
		});

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(
					id(25),
					id(324),
					[preCompletionOverlapId, preCompletionQualityId, reviewEvidenceId],
					{
						subjectType: "exposure",
						exposureId,
						dimension: "mechanism",
						basis: "human_review",
					},
				),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(25), id(325), [boundaryOverlapId, boundaryQualityId, reviewEvidenceId], {
					subjectType: "exposure",
					exposureId,
					dimension: "mechanism",
					basis: "human_review",
				}),
			).assessment.impactLabel,
		).toBe("helpful");
	});

	it("requires the human-review witness itself to name the assessed subject", () => {
		recordRetrievalAttempt(db, attempt(23));
		const labelEvidenceId = feedback(db, 123, "helpful", id(23));
		const unrelatedEvaluatorId = id(126);
		recordOutcomeEvidence(db, {
			evidenceId: unrelatedEvaluatorId,
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "evaluator",
			observedAt: COMPLETED_AT,
			producer: "human-adjudication",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: {
				adjudication_id: "unrelated-human-review",
				reference_codes: [`attempt:${id(999)}`],
			},
		});

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(23), id(223), [labelEvidenceId, unrelatedEvaluatorId], {
					basis: "human_review",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("requires grounded evaluator evidence for the human-review basis", () => {
		recordRetrievalAttempt(db, attempt(131));
		const ungroundedId = id(1260);
		const groundedId = id(1261);
		for (const [evidenceId, grounding] of [
			[ungroundedId, {}],
			[groundedId, { adjudication_id: "human-review-adjudication" }],
		] as const) {
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "mechanism",
				evidenceType: "mechanism.memory_reference",
				sourceClass: "evaluator",
				observedAt: COMPLETED_AT,
				producer: "human-review",
				producerVersion: "v1",
				status: "present",
				sessionId: 1,
				references: {
					...grounding,
					reference_codes: [`attempt:${id(131)}`],
				},
			});
		}
		const ungroundedInput = assessment(id(131), id(1262), [ungroundedId], {
			dimension: "mechanism",
			impactLabel: "unknown",
			basis: "human_review",
		});

		expect(() => recordAttributionAssessment(db, ungroundedInput)).toThrow(
			"human_review requires linked grounded evaluator evidence naming the assessment subject",
		);
		expect(
			tryRecordAttributionAssessment(db, { ...ungroundedInput, assessmentId: id(1263) }),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(getAttributionAssessment(db, ungroundedInput.assessmentId)).toBeNull();
		expect(getAttributionAssessment(db, id(1263))).toBeNull();
		expect(queryAttributionAssessments(db, { attemptId: id(131) })).toEqual([]);

		expect(
			recordAttributionAssessment(
				db,
				assessment(id(131), id(1264), [groundedId], {
					dimension: "mechanism",
					impactLabel: "unknown",
					basis: "human_review",
				}),
			).assessment.basis,
		).toBe("human_review");
	});

	it("enforces explicit, overlap, and human-review basis requirements for unknown labels", () => {
		recordRetrievalAttempt(db, attempt(22));
		const evidenceId = feedback(db, 122, "helpful", id(22));
		for (const [offset, basis] of (["content_overlap", "human_review"] as const).entries()) {
			expect(
				tryRecordAttributionAssessment(
					db,
					assessment(id(22), id(222 + offset), [evidenceId], {
						impactLabel: "unknown",
						basis,
					}),
				),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}
		const sameSessionOnlyId = id(124);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId: sameSessionOnlyId,
				observedAt: NOW,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "unknown-without-reference",
				gate: "structured_action",
				correlation: { sessionId: 1 },
			}),
		);
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(22), id(224), [sameSessionOnlyId], { impactLabel: "unknown" }),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("accepts isolated helpful exposure evidence and rejects a non-isolated pack", () => {
		const isolated = recordRetrievalAttempt(db, attempt(2)).attempt;
		const exposureId = isolated.exposures[0]?.exposureId;
		if (exposureId == null) throw new Error("fixture exposure missing");
		const pathEvidenceId = id(102);
		const qualityEvidenceId = id(103);
		const pathEvidence = recordOutcomeEvidence(
			db,
			referencing(
				sourceLocationOverlapEvidence({
					evidenceId: pathEvidenceId,
					observedAt: COMPLETED_AT,
					producer: "path-rule",
					producerVersion: "v1",
					retrievedPaths: ["packages/core/src/schema.ts"],
					downstreamPaths: ["packages/core/src/schema.ts"],
					correlation: { sessionId: 1 },
				}),
				`exposure:${exposureId}`,
			),
		).evidence;
		expect(pathEvidence.references?.matched_paths).toEqual(["packages/core/src/schema.ts"]);
		expect(pathEvidence.value).toEqual({ type: "integer", value: 1, unit: "count" });
		recordOutcomeEvidence(
			db,
			referencing(
				deterministicCheckEvidence({
					evidenceId: qualityEvidenceId,
					observedAt: COMPLETED_AT,
					producer: "test-runner",
					producerVersion: "v1",
					check: "test_result",
					checkId: "targeted-suite",
					status: "pass",
					correlation: { sessionId: 1 },
				}),
				`exposure:${exposureId}`,
			),
		);
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(2), id(202), [pathEvidenceId, qualityEvidenceId], {
					subjectType: "exposure",
					exposureId,
					dimension: "mechanism",
					basis: "source_location_overlap",
				}),
			).assessment.subjectType,
		).toBe("exposure");

		const zeroMatchEvidenceId = id(306);
		recordOutcomeEvidence(
			db,
			sourceLocationOverlapEvidence({
				evidenceId: zeroMatchEvidenceId,
				observedAt: COMPLETED_AT,
				producer: "path-rule",
				producerVersion: "v1",
				retrievedPaths: ["packages/core/src/schema.ts"],
				downstreamPaths: ["packages/core/src/store.ts"],
				correlation: { sessionId: 1 },
			}),
		);
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(2), id(307), [zeroMatchEvidenceId, qualityEvidenceId], {
					subjectType: "exposure",
					exposureId,
					dimension: "mechanism",
					basis: "source_location_overlap",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const pack = recordRetrievalAttempt(
			db,
			attempt(3, {
				candidateCount: 2,
				selectedCount: 2,
				exposures: [
					...attempt(3).exposures,
					{
						memoryImportKey: "memory-11",
						rank: 2,
						disposition: "selected",
						handoffStatus: "handed_off",
					},
				],
			}),
		).attempt;
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(3), id(203), [pathEvidenceId, qualityEvidenceId], {
					subjectType: "exposure",
					exposureId: pack.exposures[0]?.exposureId,
					dimension: "mechanism",
					basis: "source_location_overlap",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const referencedExposureId = pack.exposures[0]?.exposureId;
		if (referencedExposureId == null) throw new Error("fixture pack exposure missing");
		const explicitExposureEvidenceId = id(125);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId: explicitExposureEvidenceId,
				observedAt: COMPLETED_AT,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "explicit-exposure-feedback",
				gate: "structured_action",
				referenceCodes: [`exposure:${referencedExposureId}`],
				correlation: { sessionId: 1 },
			}),
		);
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(3), id(225), [explicitExposureEvidenceId], {
					subjectType: "exposure",
					exposureId: referencedExposureId,
				}),
			).assessment.exposureId,
		).toBe(referencedExposureId);
	});

	it("maps attempt-bound label and evaluator witnesses to a sole handed-off exposure", () => {
		const recorded = recordRetrievalAttempt(db, attempt(60)).attempt;
		const exposureId = recorded.exposures[0]?.exposureId;
		if (exposureId == null) throw new Error("fixture exposure missing");
		const helpfulId = feedback(db, 500, "helpful", id(60));
		const humanWitnessId = id(501);
		const blindedWitnessId = id(502);
		recordOutcomeEvidence(db, {
			evidenceId: humanWitnessId,
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "evaluator",
			observedAt: COMPLETED_AT,
			producer: "human-review",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: {
				rubric_id: "human-review-rubric",
				reference_codes: [`attempt:${id(60)}`],
			},
		});
		recordOutcomeEvidence(db, {
			evidenceId: blindedWitnessId,
			dimension: "quality",
			evidenceType: "quality.blinded_evaluator",
			sourceClass: "evaluator",
			observedAt: COMPLETED_AT,
			producer: "blinded-review",
			producerVersion: "v1",
			status: "unknown",
			sessionId: 1,
			references: {
				assertion_id: "sole-exposure-review",
				rubric_id: "quality-rubric",
				reference_codes: [`attempt:${id(60)}`],
			},
		});

		expect(
			recordAttributionAssessment(
				db,
				assessment(id(60), id(510), [helpfulId], {
					subjectType: "exposure",
					exposureId,
				}),
			).assessment.impactLabel,
		).toBe("helpful");
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(60), id(511), [helpfulId], {
					subjectType: "exposure",
					exposureId,
					impactLabel: "unknown",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(60), id(512), [humanWitnessId], {
					subjectType: "exposure",
					exposureId,
					dimension: "mechanism",
					impactLabel: "unknown",
					basis: "human_review",
				}),
			).assessment.impactLabel,
		).toBe("unknown");
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(60), id(513), [blindedWitnessId], {
					subjectType: "exposure",
					exposureId,
					dimension: "quality",
					impactLabel: "unknown",
					basis: "blinded_evaluator",
				}),
			).assessment.impactLabel,
		).toBe("unknown");
	});

	it("keeps sole-exposure mapping fail-closed for ambiguity and unrelated witnesses", () => {
		const ambiguous = recordRetrievalAttempt(
			db,
			attempt(61, {
				candidateCount: 2,
				selectedCount: 2,
				exposures: [
					...attempt(61).exposures,
					{
						memoryImportKey: "memory-11",
						rank: 2,
						disposition: "selected",
						handoffStatus: "handed_off",
					},
				],
			}),
		).attempt;
		const ambiguousExposureId = ambiguous.exposures[0]?.exposureId;
		if (ambiguousExposureId == null) throw new Error("fixture exposure missing");
		const ambiguousHelpfulId = feedback(db, 503, "helpful", id(61));
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(61), id(514), [ambiguousHelpfulId], {
					subjectType: "exposure",
					exposureId: ambiguousExposureId,
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const isolated = recordRetrievalAttempt(db, attempt(62)).attempt;
		const exposureId = isolated.exposures[0]?.exposureId;
		if (exposureId == null) throw new Error("fixture exposure missing");
		const unrelatedAttemptId = id(504);
		const unrelatedExposureId = id(505);
		for (const [evidenceId, referenceCode, actionId] of [
			[unrelatedAttemptId, `attempt:${id(999)}`, "unrelated-attempt"],
			[unrelatedExposureId, "exposure:999999", "unrelated-exposure"],
		] as const) {
			recordOutcomeEvidence(
				db,
				explicitFeedbackEvidence({
					evidenceId,
					observedAt: COMPLETED_AT,
					producer: "feedback-action",
					producerVersion: "v1",
					feedback: "helpful",
					actionId,
					gate: "structured_action",
					referenceCodes: [referenceCode],
					correlation: { sessionId: 1 },
				}),
			);
		}
		for (const [index, evidenceId] of [unrelatedAttemptId, unrelatedExposureId].entries()) {
			expect(
				tryRecordAttributionAssessment(
					db,
					assessment(id(62), id(515 + index), [evidenceId], {
						subjectType: "exposure",
						exposureId,
					}),
				),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}

		const helpfulId = feedback(db, 506, "helpful", id(62));
		for (const [evidenceId, evidenceType, basis, assessmentId] of [
			[id(507), "mechanism.memory_reference", "human_review", id(517)],
			[id(508), "quality.blinded_evaluator", "blinded_evaluator", id(518)],
		] as const) {
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: evidenceType === "quality.blinded_evaluator" ? "quality" : "mechanism",
				evidenceType,
				sourceClass: "evaluator",
				observedAt: COMPLETED_AT,
				producer: "unrelated-review",
				producerVersion: "v1",
				status: evidenceType === "quality.blinded_evaluator" ? "pass" : "present",
				sessionId: 1,
				references: {
					...(evidenceType === "quality.blinded_evaluator"
						? { assertion_id: "unrelated-review", rubric_id: "quality-rubric" }
						: { adjudication_id: "unrelated-human-review" }),
					reference_codes: [`attempt:${id(999)}`],
				},
			});
			expect(
				tryRecordAttributionAssessment(
					db,
					assessment(id(62), assessmentId, [helpfulId, evidenceId], {
						subjectType: "exposure",
						exposureId,
						basis,
					}),
				),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}
	});

	it("requires explicit irrelevant evidence and keeps stale separate from harmful", () => {
		recordRetrievalAttempt(db, attempt(4));
		const irrelevantId = feedback(db, 104, "irrelevant", id(4));
		const staleId = id(105);
		const harmfulId = feedback(db, 106, "harmful", id(4));
		recordOutcomeEvidence(
			db,
			groundedStaleEvidence({
				evidenceId: staleId,
				observedAt: COMPLETED_AT,
				producer: "checkout-rule",
				producerVersion: "v1",
				checkoutId: "git-fixture",
				adjudicationId: "stale-review-1",
				referenceCodes: [`attempt:${id(4)}`],
				correlation: { sessionId: 1 },
			}),
		);
		recordAttributionAssessment(
			db,
			assessment(id(4), id(204), [irrelevantId], { impactLabel: "irrelevant" }),
		);
		recordAttributionAssessment(
			db,
			assessment(id(4), id(205), [staleId], {
				dimension: "safety",
				impactLabel: "stale",
				basis: "human_review",
			}),
		);
		recordAttributionAssessment(
			db,
			assessment(id(4), id(206), [harmfulId], { impactLabel: "harmful" }),
		);
		expect(
			queryAttributionAssessments(db)
				.map((row) => row.impactLabel)
				.sort(),
		).toEqual(["harmful", "irrelevant", "stale"]);
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(4), id(207), [staleId], {
					dimension: "safety",
					impactLabel: "harmful",
					basis: "human_review",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("qualifies stale safety evidence only through source-appropriate grounding", () => {
		recordRetrievalAttempt(db, attempt(7100));
		const basisId = id(7101);
		recordOutcomeEvidence(db, {
			evidenceId: basisId,
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "derived",
			observedAt: COMPLETED_AT,
			producer: "reference-rule",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: { reference_codes: [`attempt:${id(7100)}`] },
		});
		const staleEvidence = (
			sequence: number,
			evidenceType: "safety.stale_guidance" | "safety.contradicted_guidance",
			sourceClass: RecordOutcomeEvidenceInput["sourceClass"],
			references: NonNullable<RecordOutcomeEvidenceInput["references"]>,
		): string => {
			const evidenceId = id(sequence);
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "safety",
				evidenceType,
				sourceClass,
				observedAt: COMPLETED_AT,
				producer: "stale-review",
				producerVersion: "v1",
				status: "present",
				sessionId: 1,
				experimentId: sourceClass === "experiment" ? "imported-experiment" : null,
				references: {
					...references,
					reference_codes: [`attempt:${id(7100)}`],
				},
			});
			return evidenceId;
		};

		const weakCases = [
			["user_reported", { checkout_id: "checkout-user", adjudication_id: "user-review" }],
			["experiment", { checkout_id: "checkout-imported" }],
			["evaluator", { checkout_id: "checkout-evaluator" }],
			["derived", { adjudication_id: "derived-review" }],
		] as const;
		for (const [index, [sourceClass, grounding]] of weakCases.entries()) {
			const evidenceId = staleEvidence(
				7110 + index,
				index % 2 === 0 ? "safety.stale_guidance" : "safety.contradicted_guidance",
				sourceClass,
				grounding,
			);
			const input = assessment(id(7100), id(7120 + index), [evidenceId, basisId], {
				dimension: "safety",
				impactLabel: "stale",
			});
			expect(() => recordAttributionAssessment(db, input)).toThrow(
				"linked evidence does not support stale attribution",
			);
			expect(tryRecordAttributionAssessment(db, input)).toMatchObject({
				ok: false,
				reason: "invalid_input",
			});
		}

		const diagnosticId = staleEvidence(7130, "safety.stale_guidance", "user_reported", {
			checkout_id: "checkout-diagnostic",
		});
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(7100), id(7131), [diagnosticId, basisId], {
					dimension: "mechanism",
					impactLabel: "unknown",
				}),
			).assessment.impactLabel,
		).toBe("unknown");

		const derivedId = staleEvidence(7140, "safety.contradicted_guidance", "derived", {
			checkout_id: "checkout-derived",
		});
		const derivedAssessmentId = id(7141);
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(7100), derivedAssessmentId, [derivedId, basisId], {
					dimension: "safety",
					impactLabel: "stale",
				}),
			).assessment.impactLabel,
		).toBe("stale");

		const evaluatorId = staleEvidence(7142, "safety.stale_guidance", "evaluator", {
			adjudication_id: "stale-adjudication",
		});
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(7100), id(7143), [evaluatorId], {
					dimension: "safety",
					impactLabel: "stale",
					basis: "human_review",
				}),
			).assessment.impactLabel,
		).toBe("stale");

		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify({ reference_codes: [`attempt:${id(7100)}`] }),
			derivedId,
		);
		expect(getAttributionAssessment(db, derivedAssessmentId)).toBeNull();
		expect(
			queryAttributionAssessments(db, { attemptId: id(7100) }).some(
				(row) => row.assessmentId === derivedAssessmentId,
			),
		).toBe(false);
	});

	it("keeps observed and derived retrieval noise diagnostic instead of inferring irrelevant", () => {
		recordRetrievalAttempt(db, attempt(120));
		const observedNoiseId = retrievalNoise(db, 1200, id(120), "observed");
		const derivedNoiseId = retrievalNoise(db, 1201, id(120), "derived");
		const basisId = id(1202);
		recordOutcomeEvidence(db, {
			evidenceId: basisId,
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "derived",
			observedAt: COMPLETED_AT,
			producer: "reference-rule",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: { reference_codes: [`attempt:${id(120)}`] },
		});

		for (const [index, noiseId] of [observedNoiseId, derivedNoiseId].entries()) {
			const input = assessment(id(120), id(1203 + index * 2), [noiseId, basisId], {
				dimension: "safety",
				impactLabel: "irrelevant",
			});
			expect(() => recordAttributionAssessment(db, input)).toThrow(
				"linked evidence does not support irrelevant attribution",
			);
			expect(
				tryRecordAttributionAssessment(db, { ...input, assessmentId: id(1204 + index * 2) }),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}

		const unknown = recordAttributionAssessment(
			db,
			assessment(id(120), id(1207), [observedNoiseId, derivedNoiseId, basisId], {
				dimension: "mechanism",
				impactLabel: "unknown",
			}),
		).assessment;
		expect(unknown).toMatchObject({
			impactLabel: "unknown",
			evidenceIds: [observedNoiseId, derivedNoiseId, basisId].sort(),
		});
	});

	it("accepts only explicitly qualified, evaluator-qualified, or randomized irrelevant evidence", () => {
		recordRetrievalAttempt(db, attempt(121));
		const explicitId = id(1210);
		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId: explicitId,
				observedAt: COMPLETED_AT,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "irrelevant",
				actionId: "unambiguous-irrelevant",
				gate: "unambiguous_instruction",
				referenceCodes: [`attempt:${id(121)}`],
				correlation: { sessionId: 1 },
			}),
		);
		const diagnosticNoiseId = retrievalNoise(db, 1211, id(121), "derived");
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(121), id(1212), [diagnosticNoiseId, explicitId], {
					impactLabel: "irrelevant",
				}),
			).assessment,
		).toMatchObject({
			impactLabel: "irrelevant",
			evidenceIds: [diagnosticNoiseId, explicitId].sort(),
		});

		recordRetrievalAttempt(db, attempt(122));
		const evaluatorNoiseId = retrievalNoise(
			db,
			1213,
			id(122),
			"evaluator",
			"retrieval-noise-rubric",
		);
		const evaluatorAssessmentId = id(1214);
		const evaluatorInput = assessment(id(122), evaluatorAssessmentId, [evaluatorNoiseId], {
			dimension: "safety",
			impactLabel: "irrelevant",
			basis: "human_review",
		});
		expect(recordAttributionAssessment(db, evaluatorInput).assessment.impactLabel).toBe(
			"irrelevant",
		);
		expect(recordAttributionAssessment(db, evaluatorInput).inserted).toBe(false);
		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify({ reference_codes: [`attempt:${id(122)}`] }),
			evaluatorNoiseId,
		);
		expect(getAttributionAssessment(db, evaluatorAssessmentId)).toBeNull();
		expect(queryAttributionAssessments(db, { attemptId: id(122) })).toEqual([]);

		recordRetrievalAttempt(
			db,
			attempt(123, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 5123);
		const randomizedIds = [
			experimentQualityEvidence(db, 1215, { cellId: "cell-treatment", status: "pass" }),
			experimentQualityEvidence(db, 1216, { cellId: "cell-control", status: "pass" }),
		];
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(123), id(1217), randomizedIds, {
					dimension: "quality",
					impactLabel: "irrelevant",
					basis: "randomized_contrast",
				}),
			).assessment.impactLabel,
		).toBe("irrelevant");
	});

	it("rejects ungrounded evaluator retrieval noise without persisting an assessment", () => {
		recordRetrievalAttempt(db, attempt(124));
		const evaluatorNoiseId = retrievalNoise(db, 1218, id(124), "evaluator");
		const input = assessment(id(124), id(1219), [evaluatorNoiseId], {
			dimension: "safety",
			impactLabel: "irrelevant",
			basis: "human_review",
		});

		expect(() => recordAttributionAssessment(db, input)).toThrow(
			"linked evidence does not support irrelevant attribution",
		);
		expect(tryRecordAttributionAssessment(db, { ...input, assessmentId: id(1220) })).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});
		expect(getAttributionAssessment(db, input.assessmentId)).toBeNull();
		expect(getAttributionAssessment(db, id(1220))).toBeNull();
		expect(queryAttributionAssessments(db, { attemptId: id(124) })).toEqual([]);
	});

	it("keeps ungrounded wrong-action followups diagnostic instead of inferring harmful", () => {
		recordRetrievalAttempt(db, attempt(125));
		const basisId = id(1221);
		recordOutcomeEvidence(db, {
			evidenceId: basisId,
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "derived",
			observedAt: COMPLETED_AT,
			producer: "reference-rule",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: { reference_codes: [`attempt:${id(125)}`] },
		});

		const unqualifiedCases = [
			["observed", {}],
			["derived", {}],
			["derived", { rubric_id: "wrong-source-rubric" }],
			["evaluator", { checkout_id: "wrong-source-checkout" }],
		] as const;
		for (const [index, [sourceClass, grounding]] of unqualifiedCases.entries()) {
			const wrongActionId = wrongActionFollowup(db, 1222 + index, id(125), sourceClass, grounding);
			const input = assessment(id(125), id(1224 + index * 2), [wrongActionId, basisId], {
				dimension: "safety",
				impactLabel: "harmful",
			});
			expect(() => recordAttributionAssessment(db, input)).toThrow(
				"linked evidence does not support harmful attribution",
			);
			expect(
				tryRecordAttributionAssessment(db, { ...input, assessmentId: id(1225 + index * 2) }),
			).toMatchObject({ ok: false, reason: "invalid_input" });
			expect(getAttributionAssessment(db, input.assessmentId)).toBeNull();
		}
		expect(queryAttributionAssessments(db, { attemptId: id(125) })).toEqual([]);

		const evidenceIds = [wrongActionFollowup(db, 1232, id(125), "derived"), basisId];
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(125), id(1233), evidenceIds, {
					dimension: "mechanism",
					impactLabel: "unknown",
				}),
			).assessment,
		).toMatchObject({ impactLabel: "unknown", evidenceIds: [...evidenceIds].sort() });
	});

	it("accepts source-qualified grounded wrong-action followups and fails closed after corruption", () => {
		const qualifiedCases = [
			[126, 1230, "observed", { checkout_id: "checkout-observed" }],
			[127, 1231, "derived", { checkout_id: "checkout-derived" }],
			[128, 1232, "evaluator", { adjudication_id: "wrong-action-adjudication" }],
			[129, 1233, "evaluator", { rubric_id: "wrong-action-rubric" }],
		] as const;

		for (const [
			index,
			[attemptSequence, evidenceSequence, sourceClass, grounding],
		] of qualifiedCases.entries()) {
			recordRetrievalAttempt(db, attempt(attemptSequence));
			const evidenceId = wrongActionFollowup(
				db,
				evidenceSequence,
				id(attemptSequence),
				sourceClass,
				grounding,
			);
			const assessmentId = id(1234 + index);
			const input = assessment(id(attemptSequence), assessmentId, [evidenceId], {
				dimension: "safety",
				impactLabel: "harmful",
				basis: sourceClass === "evaluator" ? "human_review" : "explicit_reference",
			});
			if (sourceClass !== "evaluator") {
				const referenceId = id(1240 + index);
				recordOutcomeEvidence(db, {
					evidenceId: referenceId,
					dimension: "mechanism",
					evidenceType: "mechanism.memory_reference",
					sourceClass: "derived",
					observedAt: COMPLETED_AT,
					producer: "reference-rule",
					producerVersion: "v1",
					status: "present",
					sessionId: 1,
					references: { reference_codes: [`attempt:${id(attemptSequence)}`] },
				});
				input.evidenceIds.push(referenceId);
			}
			expect(recordAttributionAssessment(db, input).assessment.impactLabel).toBe("harmful");
			if (index === 1) {
				db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
					JSON.stringify({ reference_codes: [`attempt:${id(attemptSequence)}`] }),
					evidenceId,
				);
				expect(getAttributionAssessment(db, assessmentId)).toBeNull();
				expect(queryAttributionAssessments(db, { attemptId: id(attemptSequence) })).toEqual([]);
			}
		}
	});

	it("preserves randomized harmful attribution without wrong-action followup evidence", () => {
		recordRetrievalAttempt(
			db,
			attempt(130, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 5130);
		const evidenceIds = [
			experimentQualityEvidence(db, 1250, { cellId: "cell-treatment", status: "fail" }),
			experimentQualityEvidence(db, 1251, { cellId: "cell-control", status: "pass" }),
		];

		expect(
			recordAttributionAssessment(
				db,
				assessment(id(130), id(1252), evidenceIds, {
					dimension: "quality",
					impactLabel: "harmful",
					basis: "randomized_contrast",
				}),
			).assessment.impactLabel,
		).toBe("harmful");
	});

	it("represents conflicting evidence as assessed unknown and no outcome as unassessed", () => {
		recordRetrievalAttempt(db, attempt(5));
		recordRetrievalAttempt(
			db,
			attempt(6, {
				deliveryStatus: "failed",
				exposures: attempt(6).exposures.map((row) => ({ ...row, handoffStatus: "failed" })),
			}),
		);
		const helpfulId = feedback(db, 107, "helpful", id(5));
		const irrelevantId = feedback(db, 108, "irrelevant", id(5));
		recordAttributionAssessment(
			db,
			assessment(id(5), id(208), [irrelevantId, helpfulId], { impactLabel: "unknown" }),
		);

		const report = getAttributionDiagnostics(db);
		expect(report.evidenceCompleteness).toMatchObject({
			assessedAttempts: 1,
			unassessedAttempts: 1,
			assessedUnknownAttempts: 1,
		});
		expect(report.lifecycle.deliveryFailed).toBe(1);
	});

	it("forces conflicting helpful and irrelevant evidence to unknown", () => {
		recordRetrievalAttempt(db, attempt(40));
		const helpfulId = feedback(db, 140, "helpful", id(40));
		const irrelevantId = feedback(db, 141, "irrelevant", id(40));
		const evidenceIds = [helpfulId, irrelevantId];

		for (const [index, impactLabel] of (["helpful", "irrelevant"] as const).entries()) {
			expect(
				tryRecordAttributionAssessment(
					db,
					assessment(id(40), id(240 + index), evidenceIds, { impactLabel }),
				),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(40), id(242), evidenceIds, { impactLabel: "unknown" }),
			).assessment.impactLabel,
		).toBe("unknown");
	});

	it("forces conflicting helpful and harmful evidence to unknown", () => {
		recordRetrievalAttempt(db, attempt(41));
		const helpfulId = feedback(db, 142, "helpful", id(41));
		const harmfulId = id(143);
		recordOutcomeEvidence(db, {
			evidenceId: harmfulId,
			dimension: "safety",
			evidenceType: "safety.wrong_action_followup",
			sourceClass: "evaluator",
			observedAt: COMPLETED_AT,
			producer: "grounded-review",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: {
				rubric_id: "wrong-action-rubric",
				reference_codes: [`attempt:${id(41)}`],
			},
		});
		const evidenceIds = [helpfulId, harmfulId];

		for (const [index, impactLabel] of (["helpful", "harmful"] as const).entries()) {
			expect(
				tryRecordAttributionAssessment(
					db,
					assessment(id(41), id(243 + index), evidenceIds, { impactLabel }),
				),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(41), id(245), evidenceIds, { impactLabel: "unknown" }),
			).assessment.impactLabel,
		).toBe("unknown");
	});

	it("accepts only the single known label supported by non-conflicting evidence", () => {
		const labels = ["helpful", "irrelevant", "stale", "harmful"] as const;
		for (const [index, impactLabel] of labels.entries()) {
			const sequence = 42 + index;
			recordRetrievalAttempt(db, attempt(sequence));
			const evidenceId = feedback(db, 144 + index, impactLabel, id(sequence));
			expect(
				recordAttributionAssessment(
					db,
					assessment(id(sequence), id(246 + index), [evidenceId], { impactLabel }),
				).assessment.impactLabel,
			).toBe(impactLabel);
			const alternative = impactLabel === "helpful" ? "irrelevant" : "helpful";
			expect(
				tryRecordAttributionAssessment(
					db,
					assessment(id(sequence), id(250 + index), [evidenceId], {
						impactLabel: alternative,
					}),
				),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}
	});

	it("rejects unknown when exact post-handoff feedback supports one known label", () => {
		recordRetrievalAttempt(db, attempt(50));
		const evidenceId = feedback(db, 400, "helpful", id(50));
		const unknown = assessment(id(50), id(401), [evidenceId], { impactLabel: "unknown" });

		expect(() => recordAttributionAssessment(db, unknown)).toThrow(
			"linked evidence does not support unknown attribution",
		);
		expect(tryRecordAttributionAssessment(db, { ...unknown, assessmentId: id(402) })).toMatchObject(
			{ ok: false, reason: "invalid_input" },
		);

		const persistedId = id(403);
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(50), persistedId, [evidenceId], { impactLabel: "helpful" }),
			).assessment.impactLabel,
		).toBe("helpful");
		db.prepare(
			"UPDATE attribution_assessments SET impact_label = 'unknown' WHERE assessment_id = ?",
		).run(persistedId);
		expect(getAttributionAssessment(db, persistedId)).toBeNull();
		expect(queryAttributionAssessments(db)).toEqual([]);
	});

	it("requires subject-bound post-retrieval source-location witnesses for unknown assessments", () => {
		recordRetrievalAttempt(db, attempt(51));
		const preRetrievalId = id(410);
		const unboundId = id(411);
		const boundaryId = id(412);
		const userReportedId = id(417);
		for (const [evidenceId, observedAt, referenceCode] of [
			[preRetrievalId, NOW, `attempt:${id(51)}`],
			[unboundId, COMPLETED_AT, null],
			[boundaryId, COMPLETED_AT, `attempt:${id(51)}`],
		] as const) {
			const evidence = sourceLocationOverlapEvidence({
				evidenceId,
				observedAt,
				producer: "path-rule",
				producerVersion: "v1",
				retrievedPaths: ["packages/core/src/schema.ts"],
				downstreamPaths: ["packages/core/src/schema.ts"],
				correlation: { sessionId: 1 },
			});
			recordOutcomeEvidence(
				db,
				referenceCode == null ? evidence : referencing(evidence, referenceCode),
			);
		}
		recordOutcomeEvidence(
			db,
			referencing(
				{
					...sourceLocationOverlapEvidence({
						evidenceId: userReportedId,
						observedAt: COMPLETED_AT,
						producer: "user-path-claim",
						producerVersion: "v1",
						retrievedPaths: ["packages/core/src/schema.ts"],
						downstreamPaths: ["packages/core/src/schema.ts"],
						correlation: { sessionId: 1 },
					}),
					sourceClass: "user_reported",
				},
				`attempt:${id(51)}`,
			),
		);
		const sourceLocationAssessment = (
			assessmentId: string,
			evidenceId: string,
		): RecordAttributionAssessmentInput =>
			assessment(id(51), assessmentId, [evidenceId], {
				dimension: "mechanism",
				impactLabel: "unknown",
				basis: "source_location_overlap",
			});

		expect(() =>
			recordAttributionAssessment(db, sourceLocationAssessment(id(413), preRetrievalId)),
		).toThrow("source_location_overlap evidence must occur after retrieval completion");
		expect(
			tryRecordAttributionAssessment(db, sourceLocationAssessment(id(414), preRetrievalId)),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			tryRecordAttributionAssessment(db, sourceLocationAssessment(id(415), unboundId)),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			tryRecordAttributionAssessment(db, sourceLocationAssessment(id(418), userReportedId)),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const persistedId = id(416);
		expect(
			recordAttributionAssessment(db, sourceLocationAssessment(persistedId, boundaryId)).assessment
				.impactLabel,
		).toBe("unknown");
		db.prepare(
			"UPDATE outcome_evidence SET source_class = 'user_reported' WHERE evidence_id = ?",
		).run(boundaryId);
		expect(getAttributionAssessment(db, persistedId)).toBeNull();
	});

	it("requires subject-bound post-retrieval content-overlap witnesses for known and unknown assessments", () => {
		recordRetrievalAttempt(db, attempt(54));
		const preRetrievalId = id(430);
		const unrelatedId = id(431);
		const boundaryId = id(432);
		const unknownReuseId = id(440);
		const failedReuseId = id(441);
		for (const [evidenceId, observedAt, referenceCode] of [
			[preRetrievalId, NOW, `attempt:${id(54)}`],
			[unrelatedId, COMPLETED_AT, `attempt:${id(999)}`],
			[boundaryId, COMPLETED_AT, `attempt:${id(54)}`],
		] as const) {
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "mechanism",
				evidenceType: "mechanism.command_or_constraint_reuse",
				sourceClass: "derived",
				observedAt,
				producer: "content-overlap-rule",
				producerVersion: "v1",
				status: "present",
				sessionId: 1,
				references: { reference_codes: [referenceCode] },
			});
		}
		for (const [evidenceId, status] of [
			[unknownReuseId, "unknown"],
			[failedReuseId, "fail"],
		] as const) {
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "mechanism",
				evidenceType: "mechanism.command_or_constraint_reuse",
				sourceClass: "derived",
				observedAt: COMPLETED_AT,
				producer: "content-overlap-rule",
				producerVersion: "v1",
				status,
				sessionId: 1,
				references: { reference_codes: [`attempt:${id(54)}`] },
			});
		}
		const contentAssessment = (
			assessmentId: string,
			evidenceIds: string[],
			impactLabel: "helpful" | "unknown",
		): RecordAttributionAssessmentInput =>
			assessment(id(54), assessmentId, evidenceIds, {
				dimension: "mechanism",
				impactLabel,
				basis: "content_overlap",
			});

		for (const [sequence, evidenceId] of [
			[433, preRetrievalId],
			[434, unrelatedId],
			[442, unknownReuseId],
			[443, failedReuseId],
		] as const) {
			expect(
				tryRecordAttributionAssessment(
					db,
					contentAssessment(id(sequence), [evidenceId], "unknown"),
				),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}
		expect(
			recordAttributionAssessment(db, contentAssessment(id(435), [boundaryId], "unknown"))
				.assessment.impactLabel,
		).toBe("unknown");

		const helpfulId = feedback(db, 436, "helpful", id(54));
		for (const [sequence, evidenceId] of [
			[437, preRetrievalId],
			[438, unrelatedId],
		] as const) {
			expect(
				tryRecordAttributionAssessment(
					db,
					contentAssessment(id(sequence), [helpfulId, evidenceId], "helpful"),
				),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}
		const persistedId = id(439);
		expect(
			recordAttributionAssessment(
				db,
				contentAssessment(persistedId, [helpfulId, boundaryId], "helpful"),
			).assessment.impactLabel,
		).toBe("helpful");
		db.prepare("UPDATE outcome_evidence SET status = 'unknown' WHERE evidence_id = ?").run(
			boundaryId,
		);
		expect(getAttributionAssessment(db, persistedId)).toBeNull();
	});

	it("requires grounded positive quality evidence for exposure helpful support", () => {
		const recordedAttempt = recordRetrievalAttempt(db, attempt(55)).attempt;
		const exposureId = recordedAttempt.exposures[0]?.exposureId;
		if (exposureId == null) throw new Error("fixture exposure missing");
		const overlapId = id(450);
		recordOutcomeEvidence(
			db,
			referencing(
				sourceLocationOverlapEvidence({
					evidenceId: overlapId,
					observedAt: COMPLETED_AT,
					producer: "path-rule",
					producerVersion: "v1",
					retrievedPaths: ["packages/core/src/schema.ts"],
					downstreamPaths: ["packages/core/src/schema.ts"],
					correlation: { sessionId: 1 },
				}),
				`exposure:${exposureId}`,
			),
		);
		const ungroundedQualityId = id(451);
		recordOutcomeEvidence(db, {
			evidenceId: ungroundedQualityId,
			dimension: "quality",
			evidenceType: "quality.corrective_followup",
			sourceClass: "user_reported",
			observedAt: COMPLETED_AT,
			producer: "user-quality-claim",
			producerVersion: "v1",
			status: "pass",
			sessionId: 1,
			references: { reference_codes: [`exposure:${exposureId}`] },
		});
		const helpfulAssessment = (
			assessmentId: string,
			qualityEvidenceId: string,
		): RecordAttributionAssessmentInput =>
			assessment(recordedAttempt.attemptId, assessmentId, [overlapId, qualityEvidenceId], {
				subjectType: "exposure",
				exposureId,
				dimension: "quality",
				impactLabel: "helpful",
				basis: "source_location_overlap",
			});

		expect(
			tryRecordAttributionAssessment(db, helpfulAssessment(id(452), ungroundedQualityId)),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const groundedQualityId = id(453);
		recordOutcomeEvidence(
			db,
			referencing(
				deterministicCheckEvidence({
					evidenceId: groundedQualityId,
					observedAt: COMPLETED_AT,
					producer: "test-runner",
					producerVersion: "v1",
					check: "test_result",
					checkId: "grounded-quality-check",
					status: "pass",
					correlation: { sessionId: 1 },
				}),
				`exposure:${exposureId}`,
			),
		);
		expect(
			recordAttributionAssessment(db, helpfulAssessment(id(454), groundedQualityId)).assessment
				.impactLabel,
		).toBe("helpful");

		const userReportedOverlapId = id(455);
		recordOutcomeEvidence(
			db,
			referencing(
				{
					...sourceLocationOverlapEvidence({
						evidenceId: userReportedOverlapId,
						observedAt: COMPLETED_AT,
						producer: "user-path-claim",
						producerVersion: "v1",
						retrievedPaths: ["packages/core/src/schema.ts"],
						downstreamPaths: ["packages/core/src/schema.ts"],
						correlation: { sessionId: 1 },
					}),
					sourceClass: "user_reported",
				},
				`exposure:${exposureId}`,
			),
		);
		const contentReuseId = id(456);
		recordOutcomeEvidence(db, {
			evidenceId: contentReuseId,
			dimension: "mechanism",
			evidenceType: "mechanism.command_or_constraint_reuse",
			sourceClass: "derived",
			observedAt: COMPLETED_AT,
			producer: "content-overlap-rule",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: { reference_codes: [`exposure:${exposureId}`] },
		});
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(
					recordedAttempt.attemptId,
					id(457),
					[userReportedOverlapId, contentReuseId, groundedQualityId],
					{
						subjectType: "exposure",
						exposureId,
						dimension: "quality",
						impactLabel: "helpful",
						basis: "content_overlap",
					},
				),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		db.prepare(
			"UPDATE outcome_evidence SET evidence_type = 'quality.corrective_followup', source_class = 'user_reported' WHERE evidence_id = ?",
		).run(groundedQualityId);
		expect(getAttributionAssessment(db, id(454))).toBeNull();
	});

	it("requires evaluator provenance for blinded-evaluator assessments", () => {
		recordRetrievalAttempt(db, attempt(52));
		recordRetrievalAttempt(db, attempt(53));
		const helpfulId = feedback(db, 420, "helpful", id(52));
		const evaluatorBlindedId = id(422);
		const unknownEvaluatorId = id(423);
		const unrelatedEvaluatorId = id(428);
		for (const [evidenceId, attemptId] of [
			[evaluatorBlindedId, id(52)],
			[unknownEvaluatorId, id(53)],
			[unrelatedEvaluatorId, id(999)],
		] as const) {
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "quality",
				evidenceType: "quality.blinded_evaluator",
				sourceClass: "evaluator",
				observedAt: COMPLETED_AT,
				producer: "blinded-rubric",
				producerVersion: "v1",
				status: evidenceId === unknownEvaluatorId ? "unknown" : "pass",
				sessionId: 1,
				references: {
					assertion_id: `assertion-${evidenceId}`,
					rubric_id: "quality-rubric",
					reference_codes: [`attempt:${attemptId}`],
				},
			});
		}
		const qualityAssessment = (
			attemptId: string,
			assessmentId: string,
			evidenceIds: string[],
			impactLabel: "helpful" | "unknown",
		): RecordAttributionAssessmentInput =>
			assessment(attemptId, assessmentId, evidenceIds, {
				dimension: "quality",
				impactLabel,
				basis: "blinded_evaluator",
			});

		expect(
			tryRecordAttributionAssessment(
				db,
				qualityAssessment(id(52), id(429), [helpfulId, unrelatedEvaluatorId], "helpful"),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			recordAttributionAssessment(
				db,
				qualityAssessment(id(52), id(426), [helpfulId, evaluatorBlindedId], "helpful"),
			).assessment.impactLabel,
		).toBe("helpful");

		const persistedId = id(427);
		expect(
			recordAttributionAssessment(
				db,
				qualityAssessment(id(53), persistedId, [unknownEvaluatorId], "unknown"),
			).assessment.impactLabel,
		).toBe("unknown");
		db.prepare("UPDATE outcome_evidence SET source_class = 'observed' WHERE evidence_id = ?").run(
			unknownEvaluatorId,
		);
		expect(getAttributionAssessment(db, persistedId)).toBeNull();
	});

	it("rejects unsupported causal language and weak observational high confidence", () => {
		recordRetrievalAttempt(db, attempt(7));
		const evidenceId = feedback(db, 109, "helpful", id(7));
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(7), id(209), [evidenceId], { claimType: "causal" }),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(7), id(210), [evidenceId], {
					impactLabel: "unknown",
					basis: "temporal_followup",
					confidenceLevel: "high",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("rejects high-confidence unknown explicit references without grounded outcome evidence", () => {
		recordRetrievalAttempt(db, attempt(1300));
		const evidenceId = id(1301);
		recordOutcomeEvidence(db, {
			evidenceId,
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "derived",
			observedAt: COMPLETED_AT,
			producer: "reference-rule",
			producerVersion: "v1",
			status: "present",
			sessionId: 1,
			references: { reference_codes: [`attempt:${id(1300)}`] },
		});
		const weakHighConfidence = (assessmentId: string): RecordAttributionAssessmentInput =>
			assessment(id(1300), assessmentId, [evidenceId], {
				dimension: "mechanism",
				impactLabel: "unknown",
				basis: "explicit_reference",
				confidenceLevel: "high",
			});

		expect(() => recordAttributionAssessment(db, weakHighConfidence(id(1302)))).toThrow(
			"high confidence requires grounded direct evidence",
		);
		expect(tryRecordAttributionAssessment(db, weakHighConfidence(id(1303)))).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});
		expect(queryAttributionAssessments(db)).toEqual([]);
	});

	it("persists and reads high confidence backed by grounded explicit feedback", () => {
		recordRetrievalAttempt(db, attempt(1304));
		const helpfulId = feedback(db, 1305, "helpful", id(1304));
		const assessmentId = id(1306);

		expect(
			recordAttributionAssessment(
				db,
				assessment(id(1304), assessmentId, [helpfulId], { confidenceLevel: "high" }),
			).assessment,
		).toMatchObject({ assessmentId, impactLabel: "helpful", confidenceLevel: "high" });
		expect(getAttributionAssessment(db, assessmentId)).toMatchObject({
			assessmentId,
			impactLabel: "helpful",
			confidenceLevel: "high",
		});

		const harmfulId = feedback(db, 1307, "harmful", id(1304));
		const unknownAssessmentId = id(1308);
		recordAttributionAssessment(
			db,
			assessment(id(1304), unknownAssessmentId, [helpfulId, harmfulId], {
				impactLabel: "unknown",
				confidenceLevel: "high",
			}),
		);
		expect(getAttributionAssessment(db, unknownAssessmentId)).toMatchObject({
			assessmentId: unknownAssessmentId,
			impactLabel: "unknown",
			confidenceLevel: "high",
		});
	});

	it("requires a resolved grounded outcome for high-confidence blinded evaluation", () => {
		const evaluatorEvidence = (
			attemptSequence: number,
			evidenceSequence: number,
			status: "pass" | "unknown",
		): string => {
			const evidenceId = id(evidenceSequence);
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "quality",
				evidenceType: "quality.blinded_evaluator",
				sourceClass: "evaluator",
				observedAt: COMPLETED_AT,
				producer: "blinded-rubric",
				producerVersion: "v1",
				status,
				sessionId: 1,
				references: {
					assertion_id: `assertion-${evidenceId}`,
					rubric_id: "quality-rubric",
					reference_codes: [`attempt:${id(attemptSequence)}`],
				},
			});
			return evidenceId;
		};

		recordRetrievalAttempt(db, attempt(7200));
		const unknownEvaluatorId = evaluatorEvidence(7200, 7201, "unknown");
		const unknownHigh = assessment(id(7200), id(7202), [unknownEvaluatorId], {
			dimension: "quality",
			impactLabel: "unknown",
			basis: "blinded_evaluator",
			confidenceLevel: "high",
		});
		expect(() => recordAttributionAssessment(db, unknownHigh)).toThrow(
			"high confidence requires grounded direct evidence",
		);
		expect(
			tryRecordAttributionAssessment(db, { ...unknownHigh, assessmentId: id(7203) }),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		recordRetrievalAttempt(db, attempt(7210));
		const knownEvaluatorId = evaluatorEvidence(7210, 7211, "pass");
		const knownAssessmentId = id(7212);
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(7210), knownAssessmentId, [knownEvaluatorId], {
					dimension: "quality",
					impactLabel: "unknown",
					basis: "blinded_evaluator",
					confidenceLevel: "high",
				}),
			).assessment.confidenceLevel,
		).toBe("high");

		recordRetrievalAttempt(db, attempt(7220));
		const mixedEvaluatorId = evaluatorEvidence(7220, 7221, "unknown");
		const helpfulId = feedback(db, 7222, "helpful", id(7220));
		const harmfulId = feedback(db, 7223, "harmful", id(7220));
		expect(() =>
			recordAttributionAssessment(
				db,
				assessment(id(7220), id(7224), [mixedEvaluatorId, helpfulId, harmfulId], {
					dimension: "quality",
					impactLabel: "unknown",
					basis: "blinded_evaluator",
					confidenceLevel: "high",
				}),
			),
		).toThrow("high confidence requires grounded direct evidence");

		db.prepare("UPDATE outcome_evidence SET status = 'unknown' WHERE evidence_id = ?").run(
			knownEvaluatorId,
		);
		expect(getAttributionAssessment(db, knownAssessmentId)).toBeNull();
		expect(queryAttributionAssessments(db, { attemptId: id(7210) })).toEqual([]);
		expect(getAttributionDiagnostics(db, { sessionId: 1 }).evidenceCompleteness).toMatchObject({
			assessmentRowsInvalid: 1,
		});
	});

	it("requires a resolved grounded outcome for high-confidence human review", () => {
		recordRetrievalAttempt(db, attempt(7230));
		const humanReviewEvidence = (evidenceSequence: number, status: "pass" | "unknown"): string => {
			const evidenceId = id(evidenceSequence);
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "quality",
				evidenceType: "quality.blinded_evaluator",
				sourceClass: "evaluator",
				observedAt: COMPLETED_AT,
				producer: "human-review",
				producerVersion: "v1",
				status,
				sessionId: 1,
				references: {
					assertion_id: `human-assertion-${evidenceId}`,
					rubric_id: "human-review-rubric",
					adjudication_id: `human-adjudication-${evidenceId}`,
					reference_codes: [`attempt:${id(7230)}`],
				},
			});
			return evidenceId;
		};

		const unresolvedId = humanReviewEvidence(7231, "unknown");
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(7230), id(7232), [unresolvedId], {
					dimension: "quality",
					impactLabel: "unknown",
					basis: "human_review",
					confidenceLevel: "medium",
				}),
			).assessment.confidenceLevel,
		).toBe("medium");
		const unresolvedHigh = assessment(id(7230), id(7233), [unresolvedId], {
			dimension: "quality",
			impactLabel: "unknown",
			basis: "human_review",
			confidenceLevel: "high",
		});
		expect(() => recordAttributionAssessment(db, unresolvedHigh)).toThrow(
			"high confidence requires grounded direct evidence",
		);
		expect(
			tryRecordAttributionAssessment(db, { ...unresolvedHigh, assessmentId: id(7234) }),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const resolvedId = humanReviewEvidence(7235, "pass");
		const resolvedAssessmentId = id(7236);
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(7230), resolvedAssessmentId, [resolvedId], {
					dimension: "quality",
					impactLabel: "unknown",
					basis: "human_review",
					confidenceLevel: "high",
				}),
			).assessment.confidenceLevel,
		).toBe("high");

		db.prepare("UPDATE outcome_evidence SET status = 'unknown' WHERE evidence_id = ?").run(
			resolvedId,
		);
		expect(getAttributionAssessment(db, resolvedAssessmentId)).toBeNull();
		expect(
			db
				.prepare("SELECT count(*) FROM attribution_assessments WHERE assessment_id = ?")
				.pluck()
				.get(resolvedAssessmentId),
		).toBe(1);
	});

	it("requires a preregistered stable-key two-cell comparison that supports the randomized label", () => {
		recordRetrievalAttempt(
			db,
			attempt(71, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 5071);
		const treatmentPass = experimentQualityEvidence(db, 172, {
			cellId: "cell-treatment",
			status: "pass",
		});
		const controlFail = experimentQualityEvidence(db, 173, {
			cellId: "cell-control",
			status: "fail",
		});
		const controlPass = experimentQualityEvidence(db, 174, {
			cellId: "cell-control",
			status: "pass",
		});
		const missingPreregistration = experimentQualityEvidence(db, 175, {
			cellId: "cell-control",
			status: "fail",
			preregistered: false,
		});
		const treatmentWithoutPreregistration = experimentQualityEvidence(db, 176, {
			cellId: "cell-treatment",
			status: "pass",
			preregistered: false,
		});
		expect(Date.parse(NOW)).toBeLessThan(Date.parse(COMPLETED_AT));

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(71), id(271), [treatmentPass], {
					dimension: "quality",
					impactLabel: "unknown",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(71), id(272), [treatmentWithoutPreregistration, missingPreregistration], {
					dimension: "quality",
					impactLabel: "unknown",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(71), id(273), [treatmentPass, controlPass], {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(71), id(276), [treatmentPass, controlFail], {
					dimension: "quality",
					impactLabel: "unknown",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(71), id(274), [treatmentPass, controlFail], {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			).assessment.impactLabel,
		).toBe("helpful");
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(71), id(275), [treatmentPass, controlFail], {
					dimension: "feedback",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("pairs repeated experiment-cell attempts by fixture and applies each matched completion boundary", () => {
		recordEvaluationAttempt(db, 1200, {
			cellId: "cell-treatment",
			fixtureId: "fixture-a",
			completedAt: "2026-08-03T12:00:00.020Z",
		});
		recordEvaluationAttempt(db, 1201, {
			cellId: "cell-treatment",
			fixtureId: "fixture-b",
			completedAt: "2026-08-03T12:00:00.090Z",
		});
		recordEvaluationAttempt(db, 1202, {
			cellId: "cell-control",
			fixtureId: "fixture-a",
			completedAt: "2026-08-03T12:00:00.030Z",
		});
		recordEvaluationAttempt(db, 1203, {
			cellId: "cell-control",
			fixtureId: "fixture-b",
			completedAt: "2026-08-03T12:00:00.080Z",
		});
		const evidenceIds = [
			experimentQualityEvidence(db, 1204, {
				cellId: "cell-treatment",
				status: "pass",
				fixtureId: "fixture-a",
				observedAt: "2026-08-03T12:00:00.020Z",
			}),
			experimentQualityEvidence(db, 1205, {
				cellId: "cell-control",
				status: "fail",
				fixtureId: "fixture-a",
				observedAt: "2026-08-03T12:00:00.030Z",
			}),
		];

		expect(
			recordAttributionAssessment(
				db,
				assessment(id(1200), id(1206), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			).assessment.impactLabel,
		).toBe("helpful");
	});

	it("pairs randomized checkout evidence only across the same checkout", () => {
		recordEvaluationAttempt(db, 7300, {
			cellId: "cell-treatment",
			checkoutId: "checkout-a",
		});
		recordEvaluationAttempt(db, 7301, {
			cellId: "cell-control",
			checkoutId: "checkout-b",
		});
		const unrelatedWorkIds = [
			experimentQualityEvidence(db, 7302, {
				cellId: "cell-treatment",
				status: "pass",
				checkoutId: "checkout-a",
			}),
			experimentQualityEvidence(db, 7303, {
				cellId: "cell-control",
				status: "fail",
				checkoutId: "checkout-b",
			}),
		];
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(7300), id(7304), unrelatedWorkIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		recordEvaluationAttempt(db, 7310, {
			cellId: "cell-treatment",
			checkoutId: "checkout-shared",
		});
		recordEvaluationAttempt(db, 7311, {
			cellId: "cell-control",
			checkoutId: "checkout-shared",
		});
		const matchedWorkIds = [
			experimentQualityEvidence(db, 7312, {
				cellId: "cell-treatment",
				status: "pass",
				checkoutId: "checkout-shared",
			}),
			experimentQualityEvidence(db, 7313, {
				cellId: "cell-control",
				status: "fail",
				checkoutId: "checkout-shared",
			}),
		];
		expect(
			recordAttributionAssessment(
				db,
				assessment(id(7310), id(7314), matchedWorkIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			).assessment.impactLabel,
		).toBe("helpful");
	});

	it("does not pair different replay fixtures across randomized cells", () => {
		recordEvaluationAttempt(db, 7320, {
			cellId: "cell-treatment",
			fixtureId: "fixture-a",
		});
		recordEvaluationAttempt(db, 7321, {
			cellId: "cell-control",
			fixtureId: "fixture-b",
		});
		const evidenceIds = [
			experimentQualityEvidence(db, 7322, {
				cellId: "cell-treatment",
				status: "pass",
				fixtureId: "fixture-a",
			}),
			experimentQualityEvidence(db, 7323, {
				cellId: "cell-control",
				status: "fail",
				fixtureId: "fixture-b",
			}),
		];

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(7320), id(7324), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("fails closed when repeated-cell correlation is ambiguous", () => {
		recordEvaluationAttempt(db, 1210, {
			cellId: "cell-treatment",
			fixtureId: "fixture-a",
		});
		recordEvaluationAttempt(db, 1211, { cellId: "cell-control", fixtureId: "fixture-a" });
		recordEvaluationAttempt(db, 1212, { cellId: "cell-control", fixtureId: "fixture-a" });
		const evidenceIds = [
			experimentQualityEvidence(db, 1213, {
				cellId: "cell-treatment",
				status: "pass",
				fixtureId: "fixture-a",
			}),
			experimentQualityEvidence(db, 1214, {
				cellId: "cell-control",
				status: "fail",
				fixtureId: "fixture-a",
			}),
		];

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(1210), id(1215), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("fails closed on mismatched randomized correlation identifiers", () => {
		recordEvaluationAttempt(db, 1220, {
			cellId: "cell-treatment",
			checkoutId: "checkout-a",
		});
		recordEvaluationAttempt(db, 1221, { cellId: "cell-control", checkoutId: "checkout-a" });
		const evidenceIds = [
			experimentQualityEvidence(db, 1222, {
				cellId: "cell-treatment",
				status: "pass",
				checkoutId: "checkout-a",
			}),
			experimentQualityEvidence(db, 1223, {
				cellId: "cell-control",
				status: "fail",
				checkoutId: "checkout-mismatch",
			}),
		];

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(1220), id(1224), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("fails closed when the correlated randomized attempt is incomplete", () => {
		recordEvaluationAttempt(db, 1230, {
			cellId: "cell-treatment",
			fixtureId: "fixture-a",
		});
		recordEvaluationAttempt(db, 1231, {
			cellId: "cell-control",
			fixtureId: "fixture-a",
			completedAt: null,
		});
		const evidenceIds = [
			experimentQualityEvidence(db, 1232, {
				cellId: "cell-treatment",
				status: "pass",
				fixtureId: "fixture-a",
			}),
			experimentQualityEvidence(db, 1233, {
				cellId: "cell-control",
				status: "fail",
				fixtureId: "fixture-a",
			}),
		];

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(1230), id(1234), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("preserves singleton-cell randomized evidence without correlation identifiers", () => {
		recordRetrievalAttempt(
			db,
			attempt(1240, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 1241);
		const evidenceIds = [
			experimentQualityEvidence(db, 1242, { cellId: "cell-treatment", status: "pass" }),
			experimentQualityEvidence(db, 1243, { cellId: "cell-control", status: "fail" }),
		];

		expect(
			recordAttributionAssessment(
				db,
				assessment(id(1240), id(1244), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			).assessment.impactLabel,
		).toBe("helpful");
	});

	it("preserves singleton plain-attempt cells when evidence carries a fixture identifier", () => {
		recordRetrievalAttempt(
			db,
			attempt(6000, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 6001);
		const evidenceIds = [
			experimentQualityEvidence(db, 6002, {
				cellId: "cell-treatment",
				status: "pass",
				fixtureId: "legacy-fixture",
			}),
			experimentQualityEvidence(db, 6003, {
				cellId: "cell-control",
				status: "fail",
				fixtureId: "legacy-fixture",
			}),
		];

		expect(
			recordAttributionAssessment(
				db,
				assessment(id(6000), id(6004), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			).assessment.impactLabel,
		).toBe("helpful");
	});

	it("fails closed for repeated plain-attempt cells even when evidence carries a fixture", () => {
		recordRetrievalAttempt(
			db,
			attempt(6010, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 6011);
		recordExperimentControlAttempt(db, 6012);
		const evidenceIds = [
			experimentQualityEvidence(db, 6013, {
				cellId: "cell-treatment",
				status: "pass",
				fixtureId: "legacy-fixture",
			}),
			experimentQualityEvidence(db, 6014, {
				cellId: "cell-control",
				status: "fail",
				fixtureId: "legacy-fixture",
			}),
		];

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(6010), id(6015), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("does not downgrade partial replay-identifier cells to singleton matching", () => {
		recordRetrievalAttempt(
			db,
			attempt(6020, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 6021);
		recordEvaluationAttempt(db, 6022, {
			cellId: "cell-control",
			fixtureId: "replay-fixture",
		});
		const evidenceIds = [
			experimentQualityEvidence(db, 6023, {
				cellId: "cell-treatment",
				status: "pass",
				fixtureId: "missing-fixture",
			}),
			experimentQualityEvidence(db, 6024, {
				cellId: "cell-control",
				status: "fail",
				fixtureId: "missing-fixture",
			}),
		];

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(6020), id(6025), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("fails closed when subject-cell evidence resolves to a sibling attempt", () => {
		recordEvaluationAttempt(db, 1250, {
			cellId: "cell-treatment",
			fixtureId: "fixture-a",
		});
		recordEvaluationAttempt(db, 1251, {
			cellId: "cell-treatment",
			fixtureId: "fixture-b",
		});
		recordEvaluationAttempt(db, 1252, { cellId: "cell-control", fixtureId: "fixture-b" });
		const evidenceIds = [
			experimentQualityEvidence(db, 1253, {
				cellId: "cell-treatment",
				status: "pass",
				fixtureId: "fixture-b",
			}),
			experimentQualityEvidence(db, 1254, {
				cellId: "cell-control",
				status: "fail",
				fixtureId: "fixture-b",
			}),
		];

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(1250), id(1255), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("rejects randomized contrast when the subject attempt completion is absent", () => {
		recordRetrievalAttempt(
			db,
			attempt(77, {
				completedAt: null,
				experimentId: "experiment-1",
				experimentCellId: "cell-treatment",
			}),
		);
		recordExperimentControlAttempt(db, 5077);
		const evidenceIds = [
			experimentQualityEvidence(db, 204, { cellId: "cell-treatment", status: "pass" }),
			experimentQualityEvidence(db, 205, { cellId: "cell-control", status: "fail" }),
		];
		const input = assessment(id(77), id(297), evidenceIds, {
			dimension: "quality",
			basis: "randomized_contrast",
		});

		expect(() => recordAttributionAssessment(db, input)).toThrow(
			"attribution requires a reliable retrieval completion boundary",
		);
		expect(tryRecordAttributionAssessment(db, { ...input, assessmentId: id(298) })).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});
		expect(queryAttributionAssessments(db, { attemptId: id(77) })).toEqual([]);
	});

	it("rejects randomized contrast when the control attempt completion is absent", () => {
		recordRetrievalAttempt(
			db,
			attempt(78, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 5078);
		const evidenceIds = [
			experimentQualityEvidence(db, 206, { cellId: "cell-treatment", status: "pass" }),
			experimentQualityEvidence(db, 207, { cellId: "cell-control", status: "fail" }),
		];
		const persistedId = id(299);
		const input = assessment(id(78), persistedId, evidenceIds, {
			dimension: "quality",
			basis: "randomized_contrast",
		});
		expect(recordAttributionAssessment(db, input).assessment.impactLabel).toBe("helpful");
		db.prepare("UPDATE retrieval_attempts SET completed_at = NULL WHERE attempt_id = ?").run(
			id(5078),
		);
		expect(getAttributionAssessment(db, persistedId)).toBeNull();
		expect(getAttributionDiagnostics(db).evidenceCompleteness.assessmentRowsInvalid).toBe(1);

		expect(() => recordAttributionAssessment(db, { ...input, assessmentId: id(300) })).toThrow(
			"linked evidence does not support helpful attribution",
		);
		expect(tryRecordAttributionAssessment(db, { ...input, assessmentId: id(301) })).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});
		expect(queryAttributionAssessments(db, { attemptId: id(78) })).toEqual([]);
	});

	it("derives randomized dimensions only from the closed contrast witnesses", () => {
		recordRetrievalAttempt(
			db,
			attempt(75, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 5075);
		const treatmentPass = experimentQualityEvidence(db, 191, {
			cellId: "cell-treatment",
			status: "pass",
		});
		const controlFail = experimentQualityEvidence(db, 192, {
			cellId: "cell-control",
			status: "fail",
		});
		const efficiencyAuxiliary = id(193);
		recordOutcomeEvidence(db, {
			evidenceId: efficiencyAuxiliary,
			dimension: "efficiency",
			evidenceType: "efficiency.elapsed_ms",
			sourceClass: "experiment",
			observedAt: COMPLETED_AT,
			producer: "experiment-runner",
			producerVersion: "v1",
			status: "present",
			value: { type: "integer", value: 10, unit: "milliseconds" },
			experimentId: "experiment-1",
			experimentCellId: "cell-treatment",
		});
		const safetyAuxiliary = id(194);
		recordOutcomeEvidence(db, {
			evidenceId: safetyAuxiliary,
			dimension: "safety",
			evidenceType: "safety.retrieval_noise",
			sourceClass: "experiment",
			observedAt: COMPLETED_AT,
			producer: "experiment-runner",
			producerVersion: "v1",
			status: "present",
			experimentId: "experiment-1",
			experimentCellId: "cell-treatment",
		});

		const efficiencyLaundering = assessment(
			id(75),
			id(288),
			[treatmentPass, controlFail, efficiencyAuxiliary],
			{ dimension: "efficiency", basis: "randomized_contrast" },
		);
		expect(() => recordAttributionAssessment(db, efficiencyLaundering)).toThrow(
			"assessment dimension must be represented by supporting evidence",
		);
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(75), id(289), [treatmentPass, controlFail, safetyAuxiliary], {
					dimension: "safety",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(
					id(75),
					id(290),
					[treatmentPass, controlFail, efficiencyAuxiliary, safetyAuxiliary],
					{ dimension: "quality", basis: "randomized_contrast" },
				),
			),
		).toMatchObject({ ok: true, value: { assessment: { dimension: "quality" } } });
	});

	it("requires every row in a comparison group to have one consistent rank relation", () => {
		recordRetrievalAttempt(
			db,
			attempt(76, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 5076);
		const treatmentPass = experimentQualityEvidence(db, 195, {
			cellId: "cell-treatment",
			status: "pass",
		});
		const controlFail = experimentQualityEvidence(db, 196, {
			cellId: "cell-control",
			status: "fail",
		});
		const controlPass = experimentQualityEvidence(db, 197, {
			cellId: "cell-control",
			status: "pass",
		});
		const contradictory = assessment(id(76), id(291), [treatmentPass, controlFail, controlPass], {
			dimension: "quality",
			basis: "randomized_contrast",
		});
		expect(() => recordAttributionAssessment(db, contradictory)).toThrow(
			"linked evidence does not support helpful attribution",
		);
		expect(
			tryRecordAttributionAssessment(db, { ...contradictory, assessmentId: id(292) }),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const unknownTreatment = experimentQualityEvidence(db, 198, {
			cellId: "cell-treatment",
			status: "pass",
			checkId: "unknown-rank-check",
		});
		const unknownControl = experimentQualityEvidence(db, 199, {
			cellId: "cell-control",
			status: "unknown",
			checkId: "unknown-rank-check",
		});
		const unknownRank = assessment(id(76), id(293), [unknownTreatment, unknownControl], {
			dimension: "quality",
			basis: "randomized_contrast",
		});
		expect(() => recordAttributionAssessment(db, unknownRank)).toThrow(
			"linked evidence does not support helpful attribution",
		);
		expect(
			tryRecordAttributionAssessment(db, { ...unknownRank, assessmentId: id(294) }),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const presentTreatment = id(202);
		const presentControl = id(203);
		for (const [evidenceId, experimentCellId, status] of [
			[presentTreatment, "cell-treatment", "pass"],
			[presentControl, "cell-control", "present"],
		] as const) {
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "quality",
				evidenceType: "quality.corrective_followup",
				sourceClass: "experiment",
				observedAt: COMPLETED_AT,
				producer: "experiment-runner",
				producerVersion: "v1",
				status,
				experimentId: "experiment-1",
				experimentCellId,
				references: {
					check_id: "present-rank-check",
					reference_codes: ["experiment.preregistered"],
				},
			});
		}
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(76), id(296), [presentTreatment, presentControl], {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const validTreatment = experimentQualityEvidence(db, 200, {
			cellId: "cell-treatment",
			status: "pass",
			checkId: "valid-neighbor-check",
		});
		const validControl = experimentQualityEvidence(db, 201, {
			cellId: "cell-control",
			status: "fail",
			checkId: "valid-neighbor-check",
		});
		const persistedId = id(295);
		expect(
			recordAttributionAssessment(
				db,
				assessment(
					id(76),
					persistedId,
					[treatmentPass, controlFail, controlPass, validTreatment, validControl],
					{ dimension: "quality", basis: "randomized_contrast" },
				),
			).assessment.impactLabel,
		).toBe("helpful");
		db.prepare("UPDATE outcome_evidence SET status = 'pass' WHERE evidence_id = ?").run(
			validControl,
		);
		expect(getAttributionAssessment(db, persistedId)).toBeNull();
	});

	it("requires randomized prerequisites on every exact contrast witness row", () => {
		recordRetrievalAttempt(
			db,
			attempt(74, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 5074);
		const treatmentWithoutContract = experimentQualityEvidence(db, 181, {
			cellId: "cell-treatment",
			status: "pass",
			preregistered: false,
		});
		const controlWithoutContract = experimentQualityEvidence(db, 182, {
			cellId: "cell-control",
			status: "fail",
			preregistered: false,
		});
		const unrelatedPreregistration = experimentQualityEvidence(db, 183, {
			cellId: "cell-treatment",
			status: "pass",
			checkId: "unrelated-preregistered-check",
		});
		const laundered = assessment(
			id(74),
			id(280),
			[treatmentWithoutContract, controlWithoutContract, unrelatedPreregistration],
			{ dimension: "quality", basis: "randomized_contrast" },
		);

		expect(() => recordAttributionAssessment(db, laundered)).toThrow(
			"randomized_contrast requires a preregistered experiment",
		);
		expect(
			tryRecordAttributionAssessment(db, { ...laundered, assessmentId: id(281) }),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const treatmentPreregistered = experimentQualityEvidence(db, 184, {
			cellId: "cell-treatment",
			status: "pass",
		});
		const oneSided = assessment(id(74), id(282), [treatmentPreregistered, controlWithoutContract], {
			dimension: "quality",
			basis: "randomized_contrast",
		});
		expect(() => recordAttributionAssessment(db, oneSided)).toThrow(
			"randomized_contrast requires a preregistered experiment",
		);
		expect(
			tryRecordAttributionAssessment(db, { ...oneSided, assessmentId: id(283) }),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const controlPreregistered = experimentQualityEvidence(db, 188, {
			cellId: "cell-control",
			status: "fail",
		});
		const unrelatedWithoutContract = experimentQualityEvidence(db, 189, {
			cellId: "cell-control",
			status: "fail",
			checkId: "unrelated-uncontracted-check",
			preregistered: false,
		});
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(
					id(74),
					id(287),
					[treatmentPreregistered, controlPreregistered, unrelatedWithoutContract],
					{ dimension: "quality", basis: "randomized_contrast" },
				),
			),
		).toMatchObject({ ok: true, value: { assessment: { impactLabel: "helpful" } } });
		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify({
				assertion_id: "task-assertion",
				check_id: "experiment-check",
				reference_codes: [],
			}),
			controlPreregistered,
		);
		expect(getAttributionAssessment(db, id(287))).toBeNull();
	});

	it("rejects unrelated randomized outcomes without a stable cross-cell pairing key", () => {
		recordRetrievalAttempt(
			db,
			attempt(72, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 5072);
		const treatmentId = id(177);
		const controlId = id(178);
		const evidenceIds = [treatmentId, controlId];
		for (const [evidenceId, experimentCellId, status] of [
			[treatmentId, "cell-treatment", "pass"],
			[controlId, "cell-control", "fail"],
		] as const) {
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "quality",
				evidenceType: "quality.corrective_followup",
				sourceClass: "experiment",
				observedAt: COMPLETED_AT,
				producer: "experiment-runner",
				producerVersion: "v1",
				status,
				experimentId: "experiment-1",
				experimentCellId,
				references: { reference_codes: ["experiment.preregistered"] },
			});
		}

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(72), id(277), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("namespaces native source-session correlation by source", () => {
		recordRetrievalAttempt(
			db,
			attempt(73, {
				sessionId: null,
				streamId: null,
				source: "opencode",
				sourceSessionId: "native-session-1",
			}),
		);
		const wrongSourceId = id(179);
		const matchingSourceId = id(180);
		for (const [evidenceId, source] of [
			[wrongSourceId, "claude"],
			[matchingSourceId, "opencode"],
		] as const) {
			recordOutcomeEvidence(db, {
				evidenceId,
				dimension: "mechanism",
				evidenceType: "mechanism.retrieval_followup",
				sourceClass: "derived",
				observedAt: COMPLETED_AT,
				producer: "followup-rule",
				producerVersion: "v1",
				status: "present",
				source,
				sourceSessionId: "native-session-1",
				references: source === "opencode" ? { reference_codes: [`attempt:${id(73)}`] } : undefined,
			});
		}
		const temporalAssessment = (
			assessmentId: string,
			evidenceId: string,
		): RecordAttributionAssessmentInput =>
			assessment(id(73), assessmentId, [evidenceId], {
				dimension: "mechanism",
				impactLabel: "unknown",
				basis: "temporal_followup",
				confidenceLevel: "low",
			});

		expect(
			tryRecordAttributionAssessment(db, temporalAssessment(id(278), wrongSourceId)),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			recordAttributionAssessment(db, temporalAssessment(id(279), matchingSourceId)).assessment
				.impactLabel,
		).toBe("unknown");
	});

	it("requires complete causal prerequisites on both retained contrast cells", () => {
		recordRetrievalAttempt(
			db,
			attempt(70, {
				experimentId: "experiment-1",
				experimentCellId: "cell-treatment",
				retentionPinned: true,
			}),
		);
		recordExperimentControlAttempt(db, 5070, { retentionPinned: true });
		const splitTreatment = experimentQualityEvidence(db, 185, {
			cellId: "cell-treatment",
			status: "pass",
			referenceCodes: ["experiment.preregistered", "experiment.cells_complete"],
			retentionPinned: true,
		});
		const splitControl = experimentQualityEvidence(db, 186, {
			cellId: "cell-control",
			status: "fail",
			referenceCodes: ["experiment.preregistered", "experiment.uncertainty_reported"],
			retentionPinned: true,
		});
		const unrelatedContract = experimentQualityEvidence(db, 187, {
			cellId: "cell-control",
			status: "fail",
			checkId: "unrelated-causal-contract",
			causalContract: true,
		});
		const splitContract = assessment(
			id(70),
			id(284),
			[splitTreatment, splitControl, unrelatedContract],
			{
				dimension: "quality",
				basis: "randomized_contrast",
				claimType: "causal",
				confidenceLevel: "high",
			},
		);
		expect(() => recordAttributionAssessment(db, splitContract)).toThrow(
			"causal claims require a linked preregistered randomized contrast",
		);
		expect(
			tryRecordAttributionAssessment(db, { ...splitContract, assessmentId: id(285) }),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const evidenceIds = [
			experimentQualityEvidence(db, 170, {
				cellId: "cell-treatment",
				status: "pass",
				causalContract: true,
			}),
			experimentQualityEvidence(db, 171, {
				cellId: "cell-control",
				status: "fail",
				causalContract: true,
			}),
		];
		const unrelatedUnretainedEvidence = experimentQualityEvidence(db, 190, {
			cellId: "cell-control",
			status: "fail",
			checkId: "unrelated-unretained-evidence",
			preregistered: false,
		});

		expect(
			recordAttributionAssessment(
				db,
				assessment(id(70), id(270), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
					claimType: "causal",
					confidenceLevel: "high",
				}),
			).assessment.claimType,
		).toBe("causal");
		expect(getAttributionAssessment(db, id(270))).toMatchObject({
			basis: "randomized_contrast",
			confidenceLevel: "high",
			claimType: "causal",
		});
		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(70), id(286), [...evidenceIds, unrelatedUnretainedEvidence], {
					dimension: "quality",
					basis: "randomized_contrast",
					claimType: "causal",
					confidenceLevel: "high",
				}),
			),
		).toMatchObject({ ok: true, value: { assessment: { claimType: "causal" } } });
		finalizeRetrievalAttemptRetention(db, id(5070), {
			finalizedAt: "2026-08-10T12:00:00.000Z",
			retentionDays: 7,
		});
		expect(getAttributionAssessment(db, id(270))).toBeNull();
	});

	it("rejects a causal contrast when the focal attempt is not retention-pinned", () => {
		recordRetrievalAttempt(
			db,
			attempt(74, { experimentId: "experiment-1", experimentCellId: "cell-treatment" }),
		);
		recordExperimentControlAttempt(db, 5074, { retentionPinned: true });
		const evidenceIds = [
			experimentQualityEvidence(db, 191, {
				cellId: "cell-treatment",
				status: "pass",
				causalContract: true,
			}),
			experimentQualityEvidence(db, 192, {
				cellId: "cell-control",
				status: "fail",
				causalContract: true,
			}),
		];

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(74), id(287), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
					claimType: "causal",
					confidenceLevel: "high",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("rejects a causal contrast when the comparison attempt is not retention-pinned", () => {
		recordRetrievalAttempt(
			db,
			attempt(75, {
				experimentId: "experiment-1",
				experimentCellId: "cell-treatment",
				retentionPinned: true,
			}),
		);
		recordExperimentControlAttempt(db, 5075);
		const evidenceIds = [
			experimentQualityEvidence(db, 193, {
				cellId: "cell-treatment",
				status: "pass",
				causalContract: true,
			}),
			experimentQualityEvidence(db, 194, {
				cellId: "cell-control",
				status: "fail",
				causalContract: true,
			}),
		];

		expect(
			tryRecordAttributionAssessment(
				db,
				assessment(id(75), id(288), evidenceIds, {
					dimension: "quality",
					basis: "randomized_contrast",
					claimType: "causal",
					confidenceLevel: "high",
				}),
			),
		).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("fails closed on malformed persisted assessment rows", () => {
		recordRetrievalAttempt(db, attempt(8));
		const evidenceId = feedback(db, 110, "helpful", id(8));
		recordAttributionAssessment(db, assessment(id(8), id(211), [evidenceId]));
		db.prepare(
			"UPDATE attribution_assessments SET impact_label = 'productive' WHERE assessment_id = ?",
		).run(id(211));

		expect(getAttributionAssessment(db, id(211))).toBeNull();
		expect(queryAttributionAssessments(db)).toEqual([]);
		expect(getAttributionDiagnostics(db).evidenceCompleteness).toMatchObject({
			assessedAttempts: 0,
			unassessedAttempts: 1,
			assessmentStatusIndeterminateAttempts: 0,
			assessmentRowsInvalid: 1,
			assessmentRowsOmittedByLimit: 0,
		});
	});

	it("returns empty reads and pages when optional attribution tables are partially absent", () => {
		recordRetrievalAttempt(db, attempt(94));
		const evidenceId = feedback(db, 606, "helpful", id(94));
		const assessmentId = id(607);
		recordAttributionAssessment(db, assessment(id(94), assessmentId, [evidenceId]));

		db.exec("DROP TABLE attribution_assessment_evidence");
		expect(getAttributionAssessment(db, assessmentId)).toBeNull();
		expect(queryAttributionAssessments(db)).toEqual([]);
		expect(queryAttributionAssessmentPage(db)).toEqual({
			assessments: [],
			evidence: [],
			selectedAssessmentIds: [],
			selectedRowCount: 0,
			invalidRowCount: 0,
			totalRowCount: 0,
		});
		expect(getAttributionDiagnostics(db).evidenceCompleteness).toMatchObject({
			assessedAttempts: 0,
			unassessedAttempts: 1,
			assessmentRowsInvalid: 0,
		});

		db.exec("DROP TABLE attribution_assessments");
		expect(getAttributionAssessment(db, assessmentId)).toBeNull();
		expect(queryAttributionAssessments(db)).toEqual([]);
		expect(getAttributionDiagnostics(db).evidenceCompleteness.unassessedAttempts).toBe(1);

		db.exec("CREATE TABLE attribution_assessment_evidence (assessment_id TEXT, evidence_id TEXT)");
		expect(getAttributionAssessment(db, assessmentId)).toBeNull();
		expect(queryAttributionAssessmentPage(db).totalRowCount).toBe(0);
		expect(getAttributionDiagnostics(db).evidenceCompleteness.unassessedAttempts).toBe(1);
	});

	it("does not hide storage failures unrelated to absent optional tables", () => {
		const closed = new Database(":memory:");
		closed.close();
		expect(() => getAttributionAssessment(closed, id(608))).toThrow();
		expect(() => queryAttributionAssessmentPage(closed)).toThrow();
	});

	it("deletes an assessment when expiry selects only one of its linked evidence rows", () => {
		recordRetrievalAttempt(db, attempt(91));
		const expiredEvidenceId = id(311);
		const retainedEvidenceId = id(312);
		for (const [evidenceId, retentionDays, actionId] of [
			[expiredEvidenceId, 7, "expires-first"],
			[retainedEvidenceId, 365, "retained-longer"],
		] as const) {
			recordOutcomeEvidence(db, {
				...explicitFeedbackEvidence({
					evidenceId,
					observedAt: COMPLETED_AT,
					producer: "feedback-action",
					producerVersion: "v1",
					feedback: "helpful",
					actionId,
					gate: "structured_action",
					referenceCodes: [`attempt:${id(91)}`],
					correlation: { sessionId: 1 },
				}),
				retentionDays,
			});
		}
		recordAttributionAssessment(
			db,
			assessment(id(91), id(313), [expiredEvidenceId, retainedEvidenceId]),
		);
		db.pragma("foreign_keys = OFF");

		expect(purgeExpiredOutcomeEvidence(db, "2026-08-11T12:00:00.000Z")).toBe(1);
		expect(db.prepare("SELECT count(*) FROM attribution_assessments").pluck().get()).toBe(0);
		expect(db.prepare("SELECT count(*) FROM attribution_assessment_evidence").pluck().get()).toBe(
			0,
		);
		expect(getOutcomeEvidence(db, retainedEvidenceId)).not.toBeNull();
	});

	it("deletes an assessment and all links when privacy selects all linked evidence", () => {
		recordRetrievalAttempt(db, attempt(92));
		const evidenceIds = [
			feedback(db, 314, "helpful", id(92)),
			feedback(db, 315, "helpful", id(92)),
		];
		recordAttributionAssessment(db, assessment(id(92), id(316), evidenceIds));
		db.pragma("foreign_keys = OFF");

		expect(purgeOutcomeEvidenceForPrivacy(db, { source: "opencode", streamId: "stream-1" })).toBe(
			2,
		);
		expect(db.prepare("SELECT count(*) FROM attribution_assessments").pluck().get()).toBe(0);
		expect(db.prepare("SELECT count(*) FROM attribution_assessment_evidence").pluck().get()).toBe(
			0,
		);
	});

	it("deletes randomized assessments when privacy purges their control cell only", () => {
		recordRetrievalAttempt(
			db,
			attempt(7300, {
				experimentId: "experiment-1",
				experimentCellId: "cell-treatment",
				streamId: "treatment-retained",
			}),
		);
		recordExperimentControlAttempt(db, 7301, { streamId: "control-purged" });
		const treatmentId = experimentQualityEvidence(db, 7302, {
			cellId: "cell-treatment",
			status: "pass",
		});
		const controlId = experimentQualityEvidence(db, 7303, {
			cellId: "cell-control",
			status: "fail",
		});
		const randomizedAssessmentId = id(7304);
		recordAttributionAssessment(
			db,
			assessment(id(7300), randomizedAssessmentId, [treatmentId, controlId], {
				dimension: "quality",
				basis: "randomized_contrast",
			}),
		);

		const feedbackId = feedback(db, 7305, "helpful", id(7300));
		const observationalAssessmentId = id(7306);
		recordAttributionAssessment(db, assessment(id(7300), observationalAssessmentId, [feedbackId]));

		recordExperimentControlAttempt(db, 7311, {
			experimentCellId: "cell-control-other",
			streamId: "unrelated-control",
		});
		const unrelatedTreatmentId = experimentQualityEvidence(db, 7312, {
			cellId: "cell-treatment",
			status: "pass",
			checkId: "unrelated-contrast",
		});
		const unrelatedControlId = experimentQualityEvidence(db, 7313, {
			cellId: "cell-control-other",
			status: "fail",
			checkId: "unrelated-contrast",
		});
		const unrelatedAssessmentId = id(7314);
		recordAttributionAssessment(
			db,
			assessment(id(7300), unrelatedAssessmentId, [unrelatedTreatmentId, unrelatedControlId], {
				dimension: "quality",
				basis: "randomized_contrast",
			}),
		);

		expect(
			purgeRetrievalAttemptsForPrivacy(db, {
				source: "opencode",
				streamId: "control-purged",
			}),
		).toBe(1);
		expect(getAttributionAssessment(db, randomizedAssessmentId)).toBeNull();
		expect(
			db
				.prepare("SELECT count(*) FROM attribution_assessments WHERE assessment_id = ?")
				.pluck()
				.get(randomizedAssessmentId),
		).toBe(0);
		expect(
			db
				.prepare("SELECT count(*) FROM attribution_assessment_evidence WHERE assessment_id = ?")
				.pluck()
				.get(randomizedAssessmentId),
		).toBe(0);
		expect(getAttributionAssessment(db, observationalAssessmentId)).not.toBeNull();
		expect(getAttributionAssessment(db, unrelatedAssessmentId)).not.toBeNull();
		expect(getOutcomeEvidence(db, controlId)).not.toBeNull();
		expect(getOutcomeEvidence(db, feedbackId)).not.toBeNull();
		expect(
			db
				.prepare(
					`SELECT count(*) FROM attribution_assessment_evidence links
					 LEFT JOIN attribution_assessments assessments
					   ON assessments.assessment_id = links.assessment_id
					 WHERE assessments.assessment_id IS NULL`,
				)
				.pluck()
				.get(),
		).toBe(0);
	});

	it("fails closed when privacy purges only a sibling attempt in the assessed experiment cell", () => {
		recordRetrievalAttempt(
			db,
			attempt(7315, {
				experimentId: "experiment-1",
				experimentCellId: "cell-treatment",
				streamId: "treatment-retained",
			}),
		);
		recordExperimentControlAttempt(db, 7317, { streamId: "control-retained" });
		const treatmentId = experimentQualityEvidence(db, 7318, {
			cellId: "cell-treatment",
			status: "pass",
		});
		const controlId = experimentQualityEvidence(db, 7319, {
			cellId: "cell-control",
			status: "fail",
		});
		const assessmentId = id(7325);
		recordAttributionAssessment(
			db,
			assessment(id(7315), assessmentId, [treatmentId, controlId], {
				dimension: "quality",
				basis: "randomized_contrast",
			}),
		);
		recordRetrievalAttempt(
			db,
			attempt(7316, {
				experimentId: "experiment-1",
				experimentCellId: "cell-treatment",
				streamId: "treatment-sibling-purged",
			}),
		);

		// codemem-ysyh: exact attempt pairing is not persisted, so cell-level purge
		// intentionally deletes the retained attempt's contrast rather than risk stale attribution.
		expect(
			purgeRetrievalAttemptsForPrivacy(db, {
				source: "opencode",
				streamId: "treatment-sibling-purged",
			}),
		).toBe(1);
		expect(
			db
				.prepare("SELECT count(*) FROM retrieval_attempts WHERE attempt_id = ?")
				.pluck()
				.get(id(7315)),
		).toBe(1);
		expect(getAttributionAssessment(db, assessmentId)).toBeNull();
		expect(
			db
				.prepare("SELECT count(*) FROM attribution_assessments WHERE assessment_id = ?")
				.pluck()
				.get(assessmentId),
		).toBe(0);
	});

	it("deletes focal randomized assessments and links during retention purge", () => {
		recordRetrievalAttempt(
			db,
			attempt(7320, {
				experimentId: "experiment-1",
				experimentCellId: "cell-treatment",
				retentionDays: 7,
			}),
		);
		recordExperimentControlAttempt(db, 7321, { retentionDays: 365 });
		const evidenceIds = [
			experimentQualityEvidence(db, 7322, {
				cellId: "cell-treatment",
				status: "pass",
			}),
			experimentQualityEvidence(db, 7323, {
				cellId: "cell-control",
				status: "fail",
			}),
		];
		const assessmentId = id(7324);
		recordAttributionAssessment(
			db,
			assessment(id(7320), assessmentId, evidenceIds, {
				dimension: "quality",
				basis: "randomized_contrast",
			}),
		);
		db.pragma("foreign_keys = OFF");

		expect(purgeExpiredRetrievalAttempts(db, "2026-08-11T12:00:00.000Z")).toBe(1);
		expect(getAttributionAssessment(db, assessmentId)).toBeNull();
		expect(
			db
				.prepare("SELECT count(*) FROM attribution_assessment_evidence WHERE assessment_id = ?")
				.pluck()
				.get(assessmentId),
		).toBe(0);
		expect(
			db
				.prepare("SELECT count(*) FROM retrieval_attempts WHERE attempt_id = ?")
				.pluck()
				.get(id(7321)),
		).toBe(1);
	});

	it("purges expired and private evidence when optional attribution tables are absent", () => {
		recordOutcomeEvidence(db, {
			...deterministicCheckEvidence({
				evidenceId: id(317),
				observedAt: COMPLETED_AT,
				producer: "test-runner",
				producerVersion: "v1",
				check: "test_result",
				checkId: "expires-without-attribution",
				status: "pass",
				correlation: { sessionId: 1, source: "opencode", streamId: "stream-1" },
			}),
			retentionDays: 7,
		});
		recordOutcomeEvidence(db, {
			...deterministicCheckEvidence({
				evidenceId: id(318),
				observedAt: COMPLETED_AT,
				producer: "test-runner",
				producerVersion: "v1",
				check: "test_result",
				checkId: "privacy-without-attribution",
				status: "pass",
				correlation: { sessionId: 1, source: "opencode", streamId: "stream-1" },
			}),
			retentionDays: 365,
		});
		db.exec("DROP TABLE attribution_assessment_evidence; DROP TABLE attribution_assessments;");

		expect(purgeExpiredOutcomeEvidence(db, "2026-08-11T12:00:00.000Z")).toBe(1);
		expect(purgeOutcomeEvidenceForPrivacy(db, { source: "opencode", streamId: "stream-1" })).toBe(
			1,
		);
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(0);
	});

	it("purges direct attempt assessments when outcome evidence storage is absent", () => {
		recordRetrievalAttempt(db, attempt(7326));
		const evidenceId = feedback(db, 7327, "helpful", id(7326));
		const assessmentId = id(7328);
		recordAttributionAssessment(db, assessment(id(7326), assessmentId, [evidenceId]));
		db.pragma("foreign_keys = OFF");
		db.exec("DROP TABLE outcome_evidence");

		expect(purgeRetrievalAttemptsForPrivacy(db, { sessionId: 1 })).toBe(1);
		expect(db.prepare("SELECT count(*) FROM attribution_assessments").pluck().get()).toBe(0);
		expect(db.prepare("SELECT count(*) FROM attribution_assessment_evidence").pluck().get()).toBe(
			0,
		);
	});

	it("migrates an old database additively and purges assessments with attempts or evidence", () => {
		const freshSchema = attributionSchema(db);
		db.exec(`
			DROP TABLE attribution_assessment_evidence;
			DROP TABLE attribution_assessments;
		`);
		db.pragma("user_version = 17");
		ensureAdditiveSchemaCompatibility(db);
		ensureAdditiveSchemaCompatibility(db);
		expect(
			db
				.prepare(
					"SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'attribution_%'",
				)
				.pluck()
				.get(),
		).toBe(2);
		expect(attributionSchema(db)).toEqual(freshSchema);
		expect(freshSchema.triggers).toEqual([]);
		db.exec(`
			CREATE TRIGGER trg_attribution_evidence_delete_orphan
			AFTER DELETE ON outcome_evidence
			BEGIN
				SELECT 1;
			END;
		`);
		ensureAdditiveSchemaCompatibility(db);
		expect(attributionSchema(db).triggers).toEqual([]);

		recordRetrievalAttempt(db, attempt(9));
		const evidenceId = feedback(db, 111, "helpful", id(9));
		recordAttributionAssessment(db, assessment(id(9), id(212), [evidenceId]));
		db.pragma("foreign_keys = OFF");
		expect(purgeOutcomeEvidenceForPrivacy(db, { source: "opencode", streamId: "stream-1" })).toBe(
			1,
		);
		expect(getAttributionAssessment(db, id(212))).toBeNull();

		const secondEvidenceId = feedback(db, 112, "helpful", id(9));
		recordAttributionAssessment(db, assessment(id(9), id(213), [secondEvidenceId]));
		expect(purgeRetrievalAttemptsForPrivacy(db, { sessionId: 1 })).toBe(1);
		expect(db.prepare("SELECT count(*) FROM attribution_assessments").pluck().get()).toBe(0);
		expect(db.prepare("SELECT count(*) FROM attribution_assessment_evidence").pluck().get()).toBe(
			0,
		);
	});
});

describe("attribution assessment data boundary", () => {
	it("stays local-only and excluded from ordinary export", () => {
		const directory = mkdtempSync(join(tmpdir(), "codemem-attribution-assessment-"));
		const dbPath = join(directory, "ledger.sqlite");
		const db = new Database(dbPath);
		try {
			seed(db);
			recordRetrievalAttempt(db, attempt(20));
			const evidenceId = feedback(db, 120, "helpful", id(20));
			const replicationBefore = db.prepare("SELECT count(*) FROM replication_ops").pluck().get();
			recordAttributionAssessment(db, assessment(id(20), id(220), [evidenceId]));
			expect(db.prepare("SELECT count(*) FROM replication_ops").pluck().get()).toBe(
				replicationBefore,
			);
		} finally {
			db.close();
		}

		try {
			const payload = exportMemories({ dbPath, allProjects: true, includeInactive: true });
			expect(payload).not.toHaveProperty("attribution_assessments");
			expect(payload).not.toHaveProperty("attribution_assessment_evidence");
			expect(JSON.stringify(payload)).not.toContain(id(220));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
