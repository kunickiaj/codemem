import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAdditiveSchemaCompatibility } from "./db.js";
import { exportMemories } from "./export-import.js";
import {
	deterministicCheckEvidence,
	efficiencyEvidence,
	evaluationAssertionEvidence,
	explicitFeedbackEvidence,
	finalizeOutcomeEvidenceRetention,
	getOutcomeEvidence,
	groundedStaleEvidence,
	type OutcomeEvidenceReferences,
	OutcomeEvidenceValidationError,
	purgeExpiredOutcomeEvidence,
	purgeOutcomeEvidenceForPrivacy,
	queryOutcomeEvidence,
	type RecordOutcomeEvidenceInput,
	recordOutcomeEvidence,
	sourceLocationOverlapEvidence,
	tryFinalizeOutcomeEvidenceRetention,
	tryRecordOutcomeEvidence,
} from "./outcome-evidence.js";
import { ensureRetrievalLedgerSchema } from "./schema-bootstrap.js";
import { TEST_SCHEMA_BASE_DDL } from "./test-schema.generated.js";
import { initTestSchema } from "./test-utils.js";

const OBSERVED_AT = "2026-08-03T12:00:00.000Z";

function id(sequence: number): string {
	return `018f2db4-f9d3-7a22-8d18-${sequence.toString(16).padStart(12, "0")}`;
}

function check(sequence = 1, status: "pass" | "fail" | "mixed" | "unknown" = "pass") {
	return deterministicCheckEvidence({
		evidenceId: id(sequence),
		observedAt: OBSERVED_AT,
		producer: "core.test-collector",
		producerVersion: "1.0.0",
		check: "test_result",
		checkId: `targeted-suite-${sequence}`,
		status,
		counts:
			status === "unknown"
				? { skipped: 3 }
				: { passed: status === "pass" ? 3 : 1, failed: status === "fail" ? 2 : 0, total: 3 },
		correlation: { sessionId: 1, source: "opencode", streamId: "stream-1" },
	});
}

type ScalarReferenceIdKey = Extract<keyof OutcomeEvidenceReferences, `${string}_id`>;

const SCALAR_REFERENCE_ID_KEYS = [
	"check_id",
	"assertion_id",
	"rubric_id",
	"fixture_id",
	"checkout_id",
	"adjudication_id",
	"feedback_action_id",
] as const satisfies readonly ScalarReferenceIdKey[];

function scalarReferenceEvidence(
	sequence: number,
	key: ScalarReferenceIdKey,
	value: unknown,
): RecordOutcomeEvidenceInput {
	const withReference = (input: RecordOutcomeEvidenceInput): RecordOutcomeEvidenceInput => ({
		...input,
		references: { ...(input.references ?? {}), [key]: value } as never,
	});

	switch (key) {
		case "check_id":
			return withReference(check(sequence));
		case "assertion_id":
		case "rubric_id":
		case "fixture_id":
			return withReference(
				evaluationAssertionEvidence({
					evidenceId: id(sequence),
					observedAt: OBSERVED_AT,
					producer: "eval.harness",
					producerVersion: "fixture-v1",
					assertionId: `assert-${sequence}`,
					rubricId: "quality-rubric-v1",
					fixtureId: `fixture-${sequence}`,
					status: "pass",
				}),
			);
		case "checkout_id":
			return withReference(
				groundedStaleEvidence({
					evidenceId: id(sequence),
					observedAt: OBSERVED_AT,
					producer: "checkout-verifier",
					producerVersion: "v1",
					checkoutId: `checkout-${sequence}`,
				}),
			);
		case "adjudication_id":
			return withReference(
				groundedStaleEvidence({
					evidenceId: id(sequence),
					observedAt: OBSERVED_AT,
					producer: "adjudication-verifier",
					producerVersion: "v1",
					adjudicationId: `adjudication-${sequence}`,
				}),
			);
		case "feedback_action_id":
			return withReference(
				explicitFeedbackEvidence({
					evidenceId: id(sequence),
					observedAt: OBSERVED_AT,
					producer: "feedback-action",
					producerVersion: "v1",
					feedback: "helpful",
					actionId: `feedback-${sequence}`,
					gate: "structured_action",
				}),
			);
	}
}

function seed(db: Database.Database): void {
	initTestSchema(db);
	db.pragma("foreign_keys = ON");
	db.prepare(
		"INSERT INTO sessions(id, started_at, project, tool_version) VALUES (1, ?, 'codemem', 'test')",
	).run(OBSERVED_AT);
}

function outcomeSchemaSnapshot(db: Database.Database) {
	return {
		columns: db.prepare("PRAGMA table_info(outcome_evidence)").all(),
		indexes: db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'outcome_evidence' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
			)
			.all()
			.map((row) => {
				const name = (row as { name: string }).name;
				const metadata = (
					db.prepare("PRAGMA index_list(outcome_evidence)").all() as Array<{
						name: string;
						unique: number;
						partial: number;
					}>
				).find((index) => index.name === name);
				return {
					name,
					unique: metadata?.unique,
					partial: metadata?.partial,
					// index_xinfo includes sort direction, so fresh and repaired schemas
					// cannot silently diverge between the generated and additive DDL.
					columns: db.prepare(`PRAGMA index_xinfo(${name})`).all(),
				};
			}),
		foreignKeys: db.prepare("PRAGMA foreign_key_list(outcome_evidence)").all(),
	};
}

describe("outcome evidence ledger", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = new Database(":memory:");
		seed(db);
	});

	afterEach(() => db.close());

	it("records pass, fail, mixed, and unknown deterministic outcomes independently of retrieval", () => {
		expect(TEST_SCHEMA_BASE_DDL).toContain("CREATE TABLE IF NOT EXISTS `outcome_evidence`");
		const statuses = ["pass", "fail", "mixed", "unknown"] as const;
		for (const [index, status] of statuses.entries())
			recordOutcomeEvidence(db, check(index + 1, status));

		expect(
			queryOutcomeEvidence(db)
				.map((evidence) => evidence.status)
				.sort(),
		).toEqual([...statuses].sort());
		expect(db.prepare("SELECT count(*) FROM retrieval_attempts").pluck().get()).toBe(0);
		expect(getOutcomeEvidence(db, id(1))).toMatchObject({
			contractVersion: 1,
			dimension: "quality",
			evidenceType: "quality.test_result",
			references: { check_id: "targeted-suite-1", passed_count: 3, total_count: 3 },
		});
	});

	it("indexes the default query order for stable keyset pagination", () => {
		const indexColumns = db
			.prepare("PRAGMA index_xinfo(idx_outcome_evidence_observed_id)")
			.all() as Array<{ name: string | null; desc: number; key: number }>;
		expect(
			indexColumns.filter((column) => column.key === 1).map(({ name, desc }) => ({ name, desc })),
		).toEqual([
			{ name: "observed_at", desc: 0 },
			{ name: "evidence_id", desc: 0 },
		]);

		for (const [sql, params] of [
			[
				"EXPLAIN QUERY PLAN SELECT evidence_id, observed_at FROM outcome_evidence WHERE typeof(observed_at) = 'text' AND typeof(evidence_id) = 'text' ORDER BY observed_at DESC, evidence_id DESC LIMIT ?",
				[50],
			],
			[
				"EXPLAIN QUERY PLAN SELECT evidence_id, observed_at FROM outcome_evidence WHERE typeof(observed_at) = 'text' AND typeof(evidence_id) = 'text' AND (observed_at < ? OR (observed_at = ? AND evidence_id < ?)) ORDER BY observed_at DESC, evidence_id DESC LIMIT ?",
				[OBSERVED_AT, OBSERVED_AT, id(1), 50],
			],
		] as const) {
			const plan = db.prepare(sql).all(...params) as Array<{ detail: string }>;
			expect(plan.some(({ detail }) => detail.includes("idx_outcome_evidence_observed_id"))).toBe(
				true,
			);
			expect(plan.some(({ detail }) => detail.includes("USE TEMP B-TREE"))).toBe(false);
		}
	});

	it("rejects passing deterministic checks with a positive failed count at every boundary", () => {
		const contradictory = {
			...check(200),
			references: {
				check_id: "targeted-suite-200",
				passed_count: 3,
				failed_count: 1,
				total_count: 4,
			},
		};

		expect(() => recordOutcomeEvidence(db, contradictory)).toThrow(OutcomeEvidenceValidationError);
		expect(() => recordOutcomeEvidence(db, contradictory)).toThrow(/failed_count to be zero/);
		expect(tryRecordOutcomeEvidence(db, contradictory)).toEqual({
			ok: false,
			errorCode: "outcome_evidence_write_failed",
			reason: "invalid_input",
		});
		expect(() =>
			deterministicCheckEvidence({
				evidenceId: id(201),
				observedAt: OBSERVED_AT,
				producer: "core.test-collector",
				producerVersion: "1.0.0",
				check: "test_result",
				checkId: "targeted-suite-201",
				status: "pass",
				counts: { passed: 3, failed: 1, total: 4 },
			}),
		).toThrow(/failed_count to be zero/);

		recordOutcomeEvidence(db, check(202));
		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify({
				check_id: "targeted-suite-202",
				passed_count: 3,
				failed_count: 1,
				total_count: 4,
			}),
			id(202),
		);
		expect(getOutcomeEvidence(db, id(202))).toBeNull();
	});

	it("rejects failed deterministic checks with an explicit zero failed count at every boundary", () => {
		const contradictory = {
			...check(260, "fail"),
			references: {
				check_id: "targeted-suite-260",
				passed_count: 3,
				failed_count: 0,
				total_count: 3,
			},
		};

		expect(() => recordOutcomeEvidence(db, contradictory)).toThrow(OutcomeEvidenceValidationError);
		expect(() => recordOutcomeEvidence(db, contradictory)).toThrow(
			/failed_count to be positive when provided/,
		);
		expect(tryRecordOutcomeEvidence(db, contradictory)).toEqual({
			ok: false,
			errorCode: "outcome_evidence_write_failed",
			reason: "invalid_input",
		});
		expect(() =>
			deterministicCheckEvidence({
				evidenceId: id(261),
				observedAt: OBSERVED_AT,
				producer: "core.test-collector",
				producerVersion: "1.0.0",
				check: "test_result",
				checkId: "targeted-suite-261",
				status: "fail",
				counts: { passed: 3, failed: 0, total: 3 },
			}),
		).toThrow(/failed_count to be positive when provided/);

		const corrupt = recordOutcomeEvidence(db, check(262, "fail")).evidence;
		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify({
				check_id: "targeted-suite-262",
				passed_count: 3,
				failed_count: 0,
				total_count: 3,
			}),
			corrupt.evidenceId,
		);
		expect(getOutcomeEvidence(db, corrupt.evidenceId)).toBeNull();
		expect(queryOutcomeEvidence(db, { evidenceType: "quality.test_result" })).toEqual([]);
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(1);
	});

	it("rejects fully accounted failures with omitted failed counts at every boundary", () => {
		const contradictory = {
			...check(930, "fail"),
			references: {
				check_id: "targeted-suite-930",
				passed_count: 2,
				skipped_count: 1,
				total_count: 3,
			},
		};

		expect(() => recordOutcomeEvidence(db, contradictory)).toThrow(
			/cannot fully account for total_count without failed_count/,
		);
		expect(tryRecordOutcomeEvidence(db, contradictory)).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});
		expect(() =>
			deterministicCheckEvidence({
				evidenceId: id(931),
				observedAt: OBSERVED_AT,
				producer: "core.test-collector",
				producerVersion: "1.0.0",
				check: "test_result",
				checkId: "targeted-suite-931",
				status: "fail",
				counts: { passed: 2, skipped: 1, total: 3 },
			}),
		).toThrow(/cannot fully account for total_count without failed_count/);

		const zeroTotal = {
			...contradictory,
			evidenceId: id(932),
			references: {
				check_id: "targeted-suite-932",
				total_count: 0,
			},
		};
		expect(() => recordOutcomeEvidence(db, zeroTotal)).toThrow(
			/cannot fully account for total_count without failed_count/,
		);
		expect(tryRecordOutcomeEvidence(db, zeroTotal)).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});
		expect(() =>
			deterministicCheckEvidence({
				evidenceId: id(934),
				observedAt: OBSERVED_AT,
				producer: "core.test-collector",
				producerVersion: "1.0.0",
				check: "test_result",
				checkId: "targeted-suite-934",
				status: "fail",
				counts: { total: 0 },
			}),
		).toThrow(/cannot fully account for total_count without failed_count/);

		const overflow = {
			...check(935, "fail"),
			references: {
				check_id: "targeted-suite-935",
				passed_count: 2,
				skipped_count: 2,
				total_count: 3,
			},
		};
		expect(() => recordOutcomeEvidence(db, overflow)).toThrow(
			/quality evidence counts cannot exceed total_count/,
		);
		expect(() =>
			deterministicCheckEvidence({
				evidenceId: id(936),
				observedAt: OBSERVED_AT,
				producer: "core.test-collector",
				producerVersion: "1.0.0",
				check: "test_result",
				checkId: "targeted-suite-936",
				status: "fail",
				counts: { passed: 2, skipped: 2, total: 3 },
			}),
		).toThrow(/quality evidence counts cannot exceed total_count/);

		recordOutcomeEvidence(db, check(933, "fail"));
		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify({ ...contradictory.references, check_id: "targeted-suite-933" }),
			id(933),
		);
		expect(getOutcomeEvidence(db, id(933))).toBeNull();
		expect(queryOutcomeEvidence(db, { evidenceType: "quality.test_result" })).toEqual([]);
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(1);
	});

	it("preserves status-only, partial, no-total, and positive-count failures", () => {
		const statusOnly = deterministicCheckEvidence({
			evidenceId: id(263),
			observedAt: OBSERVED_AT,
			producer: "core.test-collector",
			producerVersion: "1.0.0",
			check: "test_result",
			checkId: "targeted-suite-263",
			status: "fail",
		});
		const partial = {
			...statusOnly,
			evidenceId: id(264),
			references: { check_id: "targeted-suite-264", passed_count: 1, total_count: 3 },
		};
		const withoutTotal = {
			...statusOnly,
			evidenceId: id(265),
			references: { check_id: "targeted-suite-265", passed_count: 2, skipped_count: 1 },
		};
		const positive = check(266, "fail");

		expect(recordOutcomeEvidence(db, statusOnly).evidence.references).toEqual({
			check_id: "targeted-suite-263",
		});
		expect(recordOutcomeEvidence(db, partial).evidence.references).toMatchObject({
			passed_count: 1,
			total_count: 3,
		});
		expect(recordOutcomeEvidence(db, withoutTotal).evidence.references).toMatchObject({
			passed_count: 2,
			skipped_count: 1,
		});
		expect(recordOutcomeEvidence(db, positive).evidence.references?.failed_count).toBe(2);
	});

	it("rejects fully accounted mixed checks with uniform outcomes", () => {
		const contradictory = {
			...check(265, "mixed"),
			references: {
				check_id: "targeted-suite-265",
				passed_count: 3,
				failed_count: 0,
				skipped_count: 0,
				total_count: 3,
			},
		};

		expect(() => recordOutcomeEvidence(db, contradictory)).toThrow(
			/requires at least two positive outcome counts/,
		);
		expect(tryRecordOutcomeEvidence(db, contradictory)).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});
		expect(() =>
			deterministicCheckEvidence({
				evidenceId: id(266),
				observedAt: OBSERVED_AT,
				producer: "core.test-collector",
				producerVersion: "1.0.0",
				check: "test_result",
				checkId: "targeted-suite-266",
				status: "mixed",
				counts: { passed: 3, failed: 0, skipped: 0, total: 3 },
			}),
		).toThrow(/requires at least two positive outcome counts/);

		const valid = deterministicCheckEvidence({
			evidenceId: id(267),
			observedAt: OBSERVED_AT,
			producer: "core.test-collector",
			producerVersion: "1.0.0",
			check: "test_result",
			checkId: "targeted-suite-267",
			status: "mixed",
			counts: { passed: 2, failed: 1, skipped: 0, total: 3 },
		});
		expect(recordOutcomeEvidence(db, valid).evidence.status).toBe("mixed");

		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify(contradictory.references),
			valid.evidenceId,
		);
		expect(getOutcomeEvidence(db, valid.evidenceId)).toBeNull();
	});

	it("rejects outcome counts when a deterministic check status is unknown without persistence", () => {
		const countCases = [
			["passed_count", 0],
			["failed_count", 0],
			["total_count", 0],
		] as const;

		for (const [offset, [countKey, count]] of countCases.entries()) {
			const sequence = 270 + offset;
			const unknown = check(sequence, "unknown");
			const invalid = {
				...unknown,
				references: { ...unknown.references, [countKey]: count },
			};

			expect(() => recordOutcomeEvidence(db, invalid)).toThrow(OutcomeEvidenceValidationError);
			expect(() => recordOutcomeEvidence(db, invalid)).toThrow(
				/unknown deterministic quality evidence must not include outcome counts/,
			);
			expect(tryRecordOutcomeEvidence(db, invalid)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
			expect(
				db
					.prepare("SELECT count(*) FROM outcome_evidence WHERE evidence_id = ?")
					.pluck()
					.get(id(sequence)),
			).toBe(0);

			expect(() =>
				deterministicCheckEvidence({
					evidenceId: id(sequence + 10),
					observedAt: OBSERVED_AT,
					producer: "core.test-collector",
					producerVersion: "1.0.0",
					check: "test_result",
					checkId: `targeted-suite-${sequence + 10}`,
					status: "unknown",
					counts: { [countKey.replace("_count", "")]: count },
				} as never),
			).toThrow(/unknown deterministic quality evidence must not include outcome counts/);
		}
	});

	it("preserves deterministic outcome counts for known statuses and on unrelated evidence", () => {
		for (const [offset, status] of (["pass", "fail", "mixed"] as const).entries()) {
			const evidence = recordOutcomeEvidence(db, check(280 + offset, status)).evidence;
			expect(evidence.references).toMatchObject({
				passed_count: status === "pass" ? 3 : 1,
				failed_count: status === "fail" ? 2 : 0,
				total_count: 3,
			});
		}

		const unrelated = recordOutcomeEvidence(db, {
			evidenceId: id(283),
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "derived",
			observedAt: OBSERVED_AT,
			producer: "mechanism-counter",
			producerVersion: "v1",
			status: "unknown",
			references: { passed_count: 1, failed_count: 2, total_count: 3 },
		}).evidence;
		expect(unrelated.references).toEqual({ failed_count: 2, passed_count: 1, total_count: 3 });
	});

	it("fails closed on get and query for stored unknown deterministic outcome counts", () => {
		for (const [offset, countKey] of ["passed_count", "failed_count", "total_count"].entries()) {
			const sequence = 290 + offset;
			recordOutcomeEvidence(db, check(sequence, "unknown"));
			db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
				JSON.stringify({ check_id: `targeted-suite-${sequence}`, skipped_count: 3, [countKey]: 0 }),
				id(sequence),
			);
			expect(getOutcomeEvidence(db, id(sequence))).toBeNull();
		}

		expect(queryOutcomeEvidence(db, { evidenceType: "quality.test_result" })).toEqual([]);
	});

	it("rejects present blinded evaluator evidence on writes and corrupted reads", () => {
		const presentEvaluator = {
			...evaluationAssertionEvidence({
				evidenceId: id(203),
				observedAt: OBSERVED_AT,
				producer: "eval.harness",
				producerVersion: "fixture-v1",
				assertionId: "assert-203",
				rubricId: "quality-rubric-v1",
				status: "pass",
			}),
			status: "present" as const,
		};

		expect(() => recordOutcomeEvidence(db, presentEvaluator)).toThrow(
			/pass, fail, mixed, or unknown status/,
		);
		expect(tryRecordOutcomeEvidence(db, presentEvaluator)).toEqual({
			ok: false,
			errorCode: "outcome_evidence_write_failed",
			reason: "invalid_input",
		});
		expect(() =>
			evaluationAssertionEvidence({
				evidenceId: id(209),
				observedAt: OBSERVED_AT,
				producer: "eval.harness",
				producerVersion: "fixture-v1",
				assertionId: "assert-209",
				rubricId: "quality-rubric-v1",
				status: "present",
			} as never),
		).toThrow(/pass, fail, mixed, or unknown status/);

		const validEvaluator = evaluationAssertionEvidence({
			evidenceId: id(204),
			observedAt: OBSERVED_AT,
			producer: "eval.harness",
			producerVersion: "fixture-v1",
			assertionId: "assert-204",
			rubricId: "quality-rubric-v1",
			status: "unknown",
		});
		recordOutcomeEvidence(db, validEvaluator);
		db.prepare("UPDATE outcome_evidence SET status = 'present' WHERE evidence_id = ?").run(id(204));
		expect(getOutcomeEvidence(db, id(204))).toBeNull();
	});

	it("requires evaluator or experiment provenance for blinded evaluator evidence", () => {
		const evaluator = evaluationAssertionEvidence({
			evidenceId: id(241),
			observedAt: OBSERVED_AT,
			producer: "eval.harness",
			producerVersion: "fixture-v1",
			assertionId: "assert-241",
			rubricId: "quality-rubric-v1",
			status: "pass",
		});

		for (const [sequence, sourceClass] of [
			[242, "observed"],
			[243, "derived"],
			[244, "user_reported"],
		] as const) {
			const invalid = { ...evaluator, evidenceId: id(sequence), sourceClass };
			expect(() => recordOutcomeEvidence(db, invalid)).toThrow(
				/evaluator-provided or experimentally imported/,
			);
			expect(tryRecordOutcomeEvidence(db, invalid)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
		}

		expect(recordOutcomeEvidence(db, evaluator).evidence).toMatchObject({
			evidenceId: id(241),
			evidenceType: "quality.blinded_evaluator",
			sourceClass: "evaluator",
		});
		expect(
			recordOutcomeEvidence(db, {
				...evaluator,
				evidenceId: id(245),
				sourceClass: "experiment",
				experimentId: "blinded-quality-study-v1",
			}).evidence,
		).toMatchObject({
			evidenceId: id(245),
			sourceClass: "experiment",
			experimentId: "blinded-quality-study-v1",
		});

		db.prepare("UPDATE outcome_evidence SET source_class = 'observed' WHERE evidence_id = ?").run(
			id(241),
		);
		expect(getOutcomeEvidence(db, id(241))).toBeNull();
	});

	it("requires every experiment source to name a bounded experiment identifier", () => {
		const valid = {
			...check(255),
			sourceClass: "experiment" as const,
			experimentId: "quality-study-v1",
		};
		const invalidInputs = [
			{ ...check(256), sourceClass: "experiment" as const },
			{ ...check(257), sourceClass: "experiment" as const, experimentId: "" },
		];

		for (const input of invalidInputs) {
			expect(() => recordOutcomeEvidence(db, input)).toThrow(OutcomeEvidenceValidationError);
			expect(tryRecordOutcomeEvidence(db, input)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
		}

		expect(recordOutcomeEvidence(db, valid).evidence).toMatchObject({
			evidenceId: id(255),
			sourceClass: "experiment",
			experimentId: "quality-study-v1",
		});
		db.prepare("UPDATE outcome_evidence SET experiment_id = NULL WHERE evidence_id = ?").run(
			id(255),
		);
		expect(getOutcomeEvidence(db, id(255))).toBeNull();
	});

	it("classifies canonical validation errors explicitly without masking database failures", () => {
		const invalidInputs = [
			{ ...check(205), dimension: "efficiency" as const },
			{
				...check(206),
				windowStartAt: "2026-08-03T12:05:00.000Z",
				windowEndAt: "2026-08-03T12:00:00.000Z",
			},
			{
				evidenceId: id(207),
				dimension: "mechanism" as const,
				evidenceType: "mechanism.memory_reference" as const,
				sourceClass: "derived" as const,
				observedAt: OBSERVED_AT,
				producer: "mechanism-counter",
				producerVersion: "v1",
				status: "present" as const,
				value: { type: "integer" as const, value: 1, unit: "ratio" as const },
			},
		];

		for (const input of invalidInputs) {
			expect(tryRecordOutcomeEvidence(db, input as never)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
		}

		const unavailableDb = new Database(":memory:");
		unavailableDb.close();
		expect(tryRecordOutcomeEvidence(unavailableDb, check(208))).toEqual({
			ok: false,
			errorCode: "outcome_evidence_write_failed",
			reason: "storage_unavailable",
		});
	});

	it("rejects non-object outcome evidence as invalid input", () => {
		expect(() => recordOutcomeEvidence(db, null as never)).toThrow(
			/outcome evidence must be a plain object/,
		);
		expect(tryRecordOutcomeEvidence(db, null as never)).toEqual({
			ok: false,
			errorCode: "outcome_evidence_write_failed",
			reason: "invalid_input",
		});
		expect(queryOutcomeEvidence(db)).toEqual([]);
	});

	it("keeps conflicting observations as separate evidence rows", () => {
		recordOutcomeEvidence(db, check(10, "pass"));
		recordOutcomeEvidence(db, check(11, "fail"));

		expect(
			queryOutcomeEvidence(db, { evidenceType: "quality.test_result" })
				.map((row) => row.status)
				.sort(),
		).toEqual(["fail", "pass"]);
	});

	it("makes exact retries idempotent and rejects conflicting reuse of an evidence UUID", () => {
		expect(recordOutcomeEvidence(db, check(20)).inserted).toBe(true);
		expect(recordOutcomeEvidence(db, check(20)).inserted).toBe(false);
		const reordered = {
			...check(21),
			references: { total_count: 3, passed_count: 3, check_id: "targeted-suite-21" },
		};
		expect(recordOutcomeEvidence(db, reordered).inserted).toBe(true);
		expect(
			recordOutcomeEvidence(db, {
				...reordered,
				references: { check_id: "targeted-suite-21", passed_count: 3, total_count: 3 },
			}).inserted,
		).toBe(false);
		expect(tryRecordOutcomeEvidence(db, check(20, "fail"))).toEqual({
			ok: false,
			errorCode: "outcome_evidence_write_failed",
			reason: "idempotency_conflict",
		});
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(2);
	});

	it("collects evaluator assertions and bounded efficiency values without command-output inference", () => {
		const evaluator = recordOutcomeEvidence(
			db,
			evaluationAssertionEvidence({
				evidenceId: id(30),
				observedAt: OBSERVED_AT,
				producer: "eval.harness",
				producerVersion: "fixture-v1",
				assertionId: "assert-types-clean",
				rubricId: "quality-rubric-v1",
				fixtureId: "fixture-30",
				status: "mixed",
			}),
		).evidence;
		const efficiency = recordOutcomeEvidence(
			db,
			efficiencyEvidence({
				evidenceId: id(31),
				observedAt: OBSERVED_AT,
				producer: "event-counter",
				producerVersion: "v1",
				evidenceType: "efficiency.exploration_call_count",
				value: 7,
			}),
		).evidence;

		expect(evaluator).toMatchObject({ sourceClass: "evaluator", status: "mixed" });
		expect(efficiency.value).toEqual({ type: "integer", value: 7, unit: "count" });
		expect(() =>
			recordOutcomeEvidence(db, {
				...check(32),
				references: { check_id: "generic-shell-exit", raw_output: "secret" } as never,
			}),
		).toThrow(/unsupported key/);
		expect(() =>
			recordOutcomeEvidence(db, {
				...check(33),
				producer: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			}),
		).toThrow(/secret material/);
	});

	it("preserves fractional millisecond efficiency measurements as real values", () => {
		const fractional = efficiencyEvidence({
			evidenceId: id(34),
			observedAt: OBSERVED_AT,
			producer: "duration-counter",
			producerVersion: "v1",
			evidenceType: "efficiency.elapsed_ms",
			value: 12.5,
		});
		const integer = efficiencyEvidence({
			evidenceId: id(35),
			observedAt: OBSERVED_AT,
			producer: "duration-counter",
			producerVersion: "v1",
			evidenceType: "efficiency.elapsed_ms",
			value: 12,
		});
		const fractionalOverhead = efficiencyEvidence({
			evidenceId: id(38),
			observedAt: OBSERVED_AT,
			producer: "duration-counter",
			producerVersion: "v1",
			evidenceType: "efficiency.retrieval_overhead_ms",
			value: 0.25,
		});

		expect(recordOutcomeEvidence(db, fractional).evidence.value).toEqual({
			type: "real",
			value: 12.5,
			unit: "milliseconds",
		});
		expect(recordOutcomeEvidence(db, integer).evidence.value).toEqual({
			type: "integer",
			value: 12,
			unit: "milliseconds",
		});
		expect(recordOutcomeEvidence(db, fractionalOverhead).evidence.value).toEqual({
			type: "real",
			value: 0.25,
			unit: "milliseconds",
		});
		for (const [sequence, value] of [
			[36, -0.5],
			[37, Number.NaN],
		] as const) {
			expect(() =>
				efficiencyEvidence({
					evidenceId: id(sequence),
					observedAt: OBSERVED_AT,
					producer: "duration-counter",
					producerVersion: "v1",
					evidenceType: "efficiency.elapsed_ms",
					value,
				}),
			).toThrow(/non-negative finite/);
		}
		expect(() =>
			efficiencyEvidence({
				evidenceId: id(39),
				observedAt: OBSERVED_AT,
				producer: "duration-counter",
				producerVersion: "v1",
				evidenceType: "efficiency.tool_call_count",
				value: 1.5,
			}),
		).toThrow(/safe integers/);
	});

	it("requires present efficiency values and keeps unknown efficiency evidence valueless", () => {
		const base = {
			dimension: "efficiency" as const,
			evidenceType: "efficiency.elapsed_ms" as const,
			sourceClass: "observed" as const,
			observedAt: OBSERVED_AT,
			producer: "duration-counter",
			producerVersion: "v1",
		};

		expect(() =>
			recordOutcomeEvidence(db, {
				...base,
				evidenceId: id(120),
				status: "present",
			}),
		).toThrow(/requires a typed value/);
		expect(() =>
			recordOutcomeEvidence(db, {
				...base,
				evidenceId: id(121),
				status: "unknown",
				value: { type: "real", value: 12.5, unit: "milliseconds" },
			}),
		).toThrow(/must not include a value/);
		expect(
			recordOutcomeEvidence(db, {
				...base,
				evidenceId: id(122),
				status: "unknown",
				value: null,
			}).evidence.value,
		).toBeNull();
		expect(
			recordOutcomeEvidence(db, {
				...base,
				evidenceId: id(123),
				status: "unknown",
			}).evidence.value,
		).toBeNull();
	});

	it("rejects real typed count and token efficiency evidence on direct writes", () => {
		for (const [sequence, evidenceType, value, unit] of [
			[124, "efficiency.tool_call_count", 1.5, "count"],
			[125, "efficiency.retrieval_overhead_tokens", 2, "tokens"],
		] as const) {
			expect(() =>
				recordOutcomeEvidence(db, {
					evidenceId: id(sequence),
					dimension: "efficiency",
					evidenceType,
					sourceClass: "observed",
					observedAt: OBSERVED_AT,
					producer: "efficiency-direct-write",
					producerVersion: "v1",
					status: "present",
					value: { type: "real", value, unit },
				}),
			).toThrow(/requires an integer typed value/);
		}
	});

	it("requires grounded stale evidence instead of treating age as staleness", () => {
		expect(() =>
			recordOutcomeEvidence(db, {
				evidenceId: id(40),
				dimension: "safety",
				evidenceType: "safety.stale_guidance",
				sourceClass: "derived",
				observedAt: OBSERVED_AT,
				producer: "age-only-rule",
				producerVersion: "v1",
				status: "present",
				references: { reference_codes: ["memory.old"] },
			}),
		).toThrow(/grounded checkout or adjudication/);
		expect(
			recordOutcomeEvidence(
				db,
				groundedStaleEvidence({
					evidenceId: id(41),
					observedAt: OBSERVED_AT,
					producer: "checkout-verifier",
					producerVersion: "v1",
					checkoutId: "git-abc123",
					referenceCodes: ["api.removed"],
				}),
			).evidence.references,
		).toMatchObject({ checkout_id: "git-abc123", reference_codes: ["api.removed"] });
	});

	it("requires grounded contradicted-guidance evidence", () => {
		expect(() =>
			recordOutcomeEvidence(db, {
				evidenceId: id(42),
				dimension: "safety",
				evidenceType: "safety.contradicted_guidance",
				sourceClass: "derived",
				observedAt: OBSERVED_AT,
				producer: "ungrounded-contradiction",
				producerVersion: "v1",
				status: "present",
				references: { reference_codes: ["api.conflict"] },
			}),
		).toThrow(/grounded checkout or adjudication/);

		expect(
			recordOutcomeEvidence(db, {
				evidenceId: id(43),
				dimension: "safety",
				evidenceType: "safety.contradicted_guidance",
				sourceClass: "derived",
				observedAt: OBSERVED_AT,
				producer: "checkout-contradiction",
				producerVersion: "v1",
				status: "present",
				references: { checkout_id: "git-def456", reference_codes: ["api.conflict"] },
			}).evidence.references,
		).toMatchObject({ checkout_id: "git-def456" });
		expect(
			recordOutcomeEvidence(db, {
				evidenceId: id(44),
				dimension: "safety",
				evidenceType: "safety.contradicted_guidance",
				sourceClass: "evaluator",
				observedAt: OBSERVED_AT,
				producer: "human-adjudication",
				producerVersion: "v1",
				status: "present",
				references: { adjudication_id: "review-44" },
			}).evidence.references,
		).toMatchObject({ adjudication_id: "review-44" });
	});

	it("gates explicit feedback and never accepts ordinary user text or sentiment", () => {
		expect(() =>
			recordOutcomeEvidence(db, {
				evidenceId: id(50),
				dimension: "feedback",
				evidenceType: "feedback.explicit_helpful",
				sourceClass: "derived",
				observedAt: OBSERVED_AT,
				producer: "sentiment-rule",
				producerVersion: "v1",
				status: "present",
			}),
		).toThrow(/must be user_reported/);
		const feedbackTypes = [
			"feedback.explicit_helpful",
			"feedback.explicit_irrelevant",
			"feedback.explicit_stale",
			"feedback.explicit_harmful",
			"feedback.explicit_correction",
		] as const;
		const invalidStatuses = ["fail", "mixed", "unknown"] as const;
		for (const [typeIndex, evidenceType] of feedbackTypes.entries()) {
			for (const [statusIndex, status] of invalidStatuses.entries()) {
				expect(() =>
					recordOutcomeEvidence(db, {
						evidenceId: id(130 + typeIndex * invalidStatuses.length + statusIndex),
						dimension: "feedback",
						evidenceType,
						sourceClass: "user_reported",
						observedAt: OBSERVED_AT,
						producer: "feedback-action",
						producerVersion: "v1",
						status,
						references: {
							feedback_action_id: `feedback-${typeIndex}-${statusIndex}`,
							feedback_gate: "structured_action",
						},
					}),
				).toThrow(/status must be present/);
			}
		}
		expect(
			recordOutcomeEvidence(
				db,
				explicitFeedbackEvidence({
					evidenceId: id(51),
					observedAt: OBSERVED_AT,
					producer: "feedback-action",
					producerVersion: "v1",
					feedback: "irrelevant",
					actionId: "feedback-51",
					gate: "structured_action",
				}),
			).evidence,
		).toMatchObject({ sourceClass: "user_reported", status: "present" });
	});

	it("records repository-relative source overlap and rejects absolute paths and unallowlisted content", () => {
		const evidence = recordOutcomeEvidence(
			db,
			sourceLocationOverlapEvidence({
				evidenceId: id(60),
				observedAt: OBSERVED_AT,
				producer: "path-overlap",
				producerVersion: "v1",
				retrievedPaths: ["packages/core/src/schema.ts", "packages/core/src/store.ts"],
				downstreamPaths: ["packages/core/src/schema.ts", "packages/cli/src/index.ts"],
			}),
		).evidence;
		expect(evidence.value).toEqual({ type: "integer", value: 1, unit: "count" });
		expect(evidence.references?.matched_paths).toEqual(["packages/core/src/schema.ts"]);
		expect(
			recordOutcomeEvidence(
				db,
				sourceLocationOverlapEvidence({
					evidenceId: id(64),
					observedAt: OBSERVED_AT,
					producer: "path-overlap",
					producerVersion: "v1",
					retrievedPaths: ["packages/core/src/../src/schema.ts"],
					downstreamPaths: ["packages/core/src/schema.ts"],
				}),
			).evidence.references?.matched_paths,
		).toEqual(["packages/core/src/schema.ts"]);
		expect(() =>
			recordOutcomeEvidence(
				db,
				sourceLocationOverlapEvidence({
					evidenceId: id(61),
					observedAt: OBSERVED_AT,
					producer: "path-overlap",
					producerVersion: "v1",
					retrievedPaths: ["/Users/name/private.ts"],
					downstreamPaths: [],
				}),
			),
		).toThrow(/repository-relative/);
		expect(() =>
			recordOutcomeEvidence(db, {
				...check(62),
				notes: "raw user text is not contract-v1 evidence",
			} as never),
		).toThrow(/unsupported key: notes/);
		expect(() =>
			recordOutcomeEvidence(
				db,
				sourceLocationOverlapEvidence({
					evidenceId: id(63),
					observedAt: OBSERVED_AT,
					producer: "path-overlap",
					producerVersion: "v1",
					retrievedPaths: Array.from(
						{ length: 50 },
						(_, index) => `paths/${"x".repeat(1000)}-${index}`,
					),
					downstreamPaths: [],
				}),
			),
		).toThrow(/exceeds 16384 bytes/);
	});

	it("requires source-location values to equal the matched path count", () => {
		const valid = sourceLocationOverlapEvidence({
			evidenceId: id(250),
			observedAt: OBSERVED_AT,
			producer: "path-overlap",
			producerVersion: "v1",
			retrievedPaths: ["packages/core/src/schema.ts", "packages/core/src/store.ts"],
			downstreamPaths: ["packages/core/src/schema.ts"],
		});
		const invalidValues = [
			[251, undefined],
			[252, { type: "real", value: 1.5, unit: "count" }],
			[253, { type: "integer", value: -1, unit: "count" }],
			[254, { type: "integer", value: 0, unit: "count" }],
		] as const;

		for (const [sequence, value] of invalidValues) {
			const invalid = { ...valid, evidenceId: id(sequence), value };
			expect(() => recordOutcomeEvidence(db, invalid)).toThrow(
				/non-negative integer count equal to matched_paths length/,
			);
			expect(tryRecordOutcomeEvidence(db, invalid)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
		}

		expect(recordOutcomeEvidence(db, valid).evidence).toMatchObject({
			evidenceId: id(250),
			value: { type: "integer", value: 1, unit: "count" },
			references: { matched_paths: ["packages/core/src/schema.ts"] },
		});
		db.prepare("UPDATE outcome_evidence SET value_integer = 0 WHERE evidence_id = ?").run(id(250));
		expect(getOutcomeEvidence(db, id(250))).toBeNull();
	});

	it("requires present status for source-location matches at write and read boundaries", () => {
		const valid = sourceLocationOverlapEvidence({
			evidenceId: id(260),
			observedAt: OBSERVED_AT,
			producer: "path-overlap",
			producerVersion: "v1",
			retrievedPaths: ["packages/core/src/schema.ts"],
			downstreamPaths: ["packages/core/src/schema.ts"],
		});

		for (const [offset, status] of (["pass", "fail", "mixed", "unknown"] as const).entries()) {
			const sequence = 261 + offset;
			const invalid = { ...valid, evidenceId: id(sequence), status };
			expect(() => recordOutcomeEvidence(db, invalid)).toThrow(/status must be present/);
			expect(tryRecordOutcomeEvidence(db, invalid)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
			expect(
				db
					.prepare("SELECT count(*) FROM outcome_evidence WHERE evidence_id = ?")
					.pluck()
					.get(id(sequence)),
			).toBe(0);
		}

		expect(valid.status).toBe("present");
		expect(recordOutcomeEvidence(db, valid).evidence.status).toBe("present");

		for (const [offset, status] of (["pass", "fail", "mixed", "unknown"] as const).entries()) {
			const sequence = 267 + offset;
			recordOutcomeEvidence(db, { ...valid, evidenceId: id(sequence) });
			db.prepare("UPDATE outcome_evidence SET status = ? WHERE evidence_id = ?").run(
				status,
				id(sequence),
			);
			expect(getOutcomeEvidence(db, id(sequence))).toBeNull();
		}
		expect(queryOutcomeEvidence(db, { evidenceType: "mechanism.source_location_match" })).toEqual([
			expect.objectContaining({ evidenceId: id(260), status: "present" }),
		]);
	});

	it("canonicalizes duplicate source-location paths across write, read, query, and retry", () => {
		const direct = {
			evidenceId: id(920),
			dimension: "mechanism" as const,
			evidenceType: "mechanism.source_location_match" as const,
			sourceClass: "derived" as const,
			observedAt: OBSERVED_AT,
			producer: "path-overlap",
			producerVersion: "v1",
			status: "present" as const,
			value: { type: "integer" as const, value: 1, unit: "count" as const },
			references: {
				repository_paths: ["packages/core/src/./schema.ts", "packages\\core\\src\\schema.ts"],
				matched_paths: ["packages/core/src/schema.ts", "packages/core/src/./schema.ts"],
			},
		};
		const first = recordOutcomeEvidence(db, direct, "linux");
		const expectedReferences = {
			matched_paths: ["packages/core/src/schema.ts"],
			repository_paths: ["packages/core/src/schema.ts"],
		};

		expect(first.evidence.references).toEqual(expectedReferences);
		expect(getOutcomeEvidence(db, id(920))).toEqual(first.evidence);
		expect(queryOutcomeEvidence(db, { evidenceType: "mechanism.source_location_match" })).toEqual([
			first.evidence,
		]);
		expect(recordOutcomeEvidence(db, direct, "linux")).toEqual({
			evidence: first.evidence,
			inserted: false,
		});

		const helper = sourceLocationOverlapEvidence(
			{
				...direct,
				evidenceId: id(921),
				retrievedPaths: direct.references.repository_paths,
				downstreamPaths: direct.references.matched_paths,
			},
			"linux",
		);
		expect(helper.references).toEqual(expectedReferences);
		expect(helper.value).toEqual(direct.value);

		const staleCount = {
			...direct,
			evidenceId: id(922),
			value: { ...direct.value, value: 2 },
		};
		expect(() => recordOutcomeEvidence(db, staleCount, "linux")).toThrow(
			/non-negative integer count equal to matched_paths length/,
		);
		expect(tryRecordOutcomeEvidence(db, staleCount, "linux")).toEqual({
			ok: false,
			errorCode: "outcome_evidence_write_failed",
			reason: "invalid_input",
		});

		const persisted = { ...helper, evidenceId: id(923) };
		recordOutcomeEvidence(db, persisted, "linux");
		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify({
				repository_paths: ["packages/core/src/schema.ts", "packages/core/src/schema.ts"],
				matched_paths: ["packages/core/src/schema.ts"],
			}),
			id(923),
		);
		expect(getOutcomeEvidence(db, id(923))).toBeNull();
		expect(
			queryOutcomeEvidence(db, { evidenceType: "mechanism.source_location_match" }).map(
				(evidence) => evidence.evidenceId,
			),
		).toEqual([id(920)]);
	});

	it("rejects every non-string path reference element before coercion", () => {
		const nonStringPaths = [
			42,
			true,
			false,
			null,
			{ path: "packages/core/src/schema.ts" },
			["src"],
		];
		let sequence = 510;

		for (const referenceKey of ["repository_paths", "matched_paths"] as const) {
			for (const nonStringPath of nonStringPaths) {
				const references =
					referenceKey === "repository_paths"
						? { repository_paths: [nonStringPath], matched_paths: [] }
						: {
								repository_paths: ["packages/core/src/schema.ts"],
								matched_paths: [nonStringPath],
							};
				const invalid = {
					evidenceId: id(sequence),
					dimension: "mechanism" as const,
					evidenceType: "mechanism.source_location_match" as const,
					sourceClass: "derived" as const,
					observedAt: OBSERVED_AT,
					producer: "path-overlap",
					producerVersion: "v1",
					status: "present" as const,
					value: {
						type: "integer" as const,
						value: referenceKey === "matched_paths" ? 1 : 0,
						unit: "count" as const,
					},
					references,
				};

				expect(() => recordOutcomeEvidence(db, invalid as never)).toThrow(
					OutcomeEvidenceValidationError,
				);
				expect(() => recordOutcomeEvidence(db, invalid as never)).toThrow(/only string paths/);
				expect(tryRecordOutcomeEvidence(db, invalid as never)).toEqual({
					ok: false,
					errorCode: "outcome_evidence_write_failed",
					reason: "invalid_input",
				});
				expect(
					db
						.prepare("SELECT count(*) FROM outcome_evidence WHERE evidence_id = ?")
						.pluck()
						.get(id(sequence)),
				).toBe(0);
				sequence += 1;
			}
		}

		const valid = {
			evidenceId: id(sequence),
			dimension: "mechanism" as const,
			evidenceType: "mechanism.source_location_match" as const,
			sourceClass: "derived" as const,
			observedAt: OBSERVED_AT,
			producer: "path-overlap",
			producerVersion: "v1",
			status: "present" as const,
			value: { type: "integer" as const, value: 1, unit: "count" as const },
			references: {
				repository_paths: ["packages/core/src/./schema.ts"],
				matched_paths: ["packages/core/src/schema.ts"],
			},
		};
		expect(recordOutcomeEvidence(db, valid).evidence.references).toEqual({
			matched_paths: ["packages/core/src/schema.ts"],
			repository_paths: ["packages/core/src/schema.ts"],
		});

		for (const [referenceKey, nonStringPath] of [
			["repository_paths", 42],
			["matched_paths", { path: "packages/core/src/schema.ts" }],
		] as const) {
			sequence += 1;
			const persisted = sourceLocationOverlapEvidence({
				evidenceId: id(sequence),
				observedAt: OBSERVED_AT,
				producer: "path-overlap",
				producerVersion: "v1",
				retrievedPaths: ["packages/core/src/schema.ts"],
				downstreamPaths: ["packages/core/src/schema.ts"],
			});
			recordOutcomeEvidence(db, persisted);
			db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
				JSON.stringify({
					repository_paths:
						referenceKey === "repository_paths" ? [nonStringPath] : ["packages/core/src/schema.ts"],
					matched_paths:
						referenceKey === "matched_paths" ? [nonStringPath] : ["packages/core/src/schema.ts"],
				}),
				id(sequence),
			);
			expect(getOutcomeEvidence(db, id(sequence))).toBeNull();
		}
	});

	it("requires every scalar reference identifier to be a runtime string before canonicalization", () => {
		const invalidValues = [42, true, false, null, ["reference-id"], { id: "reference-id" }];
		let sequence = 600;

		for (const key of SCALAR_REFERENCE_ID_KEYS) {
			for (const value of invalidValues) {
				const input = scalarReferenceEvidence(sequence, key, value);
				expect(() => recordOutcomeEvidence(db, input)).toThrow(OutcomeEvidenceValidationError);
				const expectedMessage =
					value === null
						? `references.${key} must not be null`
						: `references.${key} must be a string`;
				expect(() => recordOutcomeEvidence(db, input)).toThrow(expectedMessage);
				expect(tryRecordOutcomeEvidence(db, input)).toEqual({
					ok: false,
					errorCode: "outcome_evidence_write_failed",
					reason: "invalid_input",
				});
				expect(
					db
						.prepare("SELECT count(*) FROM outcome_evidence WHERE evidence_id = ?")
						.pluck()
						.get(id(sequence)),
				).toBe(0);
				sequence += 1;
			}
		}
	});

	it("rejects non-object references without persistence and preserves omission semantics", () => {
		const invalidReferences = [null, [], "reference", 42, true, new Date(), new Map()];
		let sequence = 640;
		for (const references of invalidReferences) {
			const input = {
				...check(sequence),
				references,
			} as never;
			expect(() => recordOutcomeEvidence(db, input)).toThrow(OutcomeEvidenceValidationError);
			expect(() => recordOutcomeEvidence(db, input)).toThrow(
				/references must be a plain object when provided/,
			);
			expect(tryRecordOutcomeEvidence(db, input)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
			expect(
				db
					.prepare("SELECT count(*) FROM outcome_evidence WHERE evidence_id = ?")
					.pluck()
					.get(id(sequence)),
			).toBe(0);
			sequence += 1;
		}

		const omitted = recordOutcomeEvidence(db, {
			evidenceId: id(sequence),
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "derived",
			observedAt: OBSERVED_AT,
			producer: "memory-reference",
			producerVersion: "v1",
			status: "present",
			references: undefined,
		}).evidence;
		expect(omitted.references).toBeNull();
	});

	it("preserves valid scalar reference identifiers and optional omission semantics", () => {
		let sequence = 650;
		for (const key of SCALAR_REFERENCE_ID_KEYS) {
			const value = `valid.${key}/v1`;
			const evidence = recordOutcomeEvidence(
				db,
				scalarReferenceEvidence(sequence, key, value),
			).evidence;
			expect(evidence.references?.[key]).toBe(value);
			sequence += 1;
		}

		const evaluatorWithoutOptionalIds = evaluationAssertionEvidence({
			evidenceId: id(sequence),
			observedAt: OBSERVED_AT,
			producer: "eval.harness",
			producerVersion: "fixture-v1",
			assertionId: "assert-required",
			rubricId: "rubric-required",
			status: "pass",
		});
		expect(recordOutcomeEvidence(db, evaluatorWithoutOptionalIds).evidence.references).toEqual({
			assertion_id: "assert-required",
			rubric_id: "rubric-required",
		});

		const mechanismWithoutReferences: RecordOutcomeEvidenceInput = {
			evidenceId: id(sequence + 1),
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "derived",
			observedAt: OBSERVED_AT,
			producer: "memory-reference",
			producerVersion: "v1",
			status: "present",
		};
		expect(recordOutcomeEvidence(db, mechanismWithoutReferences).evidence.references).toBeNull();
	});

	it("fails closed when persisted references are not object maps", () => {
		const malformedReferences = [null, [], "reference", 42, true];
		for (const [offset, references] of malformedReferences.entries()) {
			const sequence = 680 + offset;
			recordOutcomeEvidence(db, check(sequence));
			db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
				JSON.stringify(references),
				id(sequence),
			);
			expect(getOutcomeEvidence(db, id(sequence))).toBeNull();
		}
	});

	it("fails closed when any persisted scalar reference identifier is not a string", () => {
		const invalidValues = [42, true, false, null, ["reference-id"], { id: "reference-id" }];
		let sequence = 700;

		for (const key of SCALAR_REFERENCE_ID_KEYS) {
			for (const value of invalidValues) {
				const validValue = `stored.${key}/v1`;
				const input = scalarReferenceEvidence(sequence, key, validValue);
				const stored = recordOutcomeEvidence(db, input).evidence;
				db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
					JSON.stringify({ ...(stored.references ?? {}), [key]: value }),
					id(sequence),
				);
				expect(getOutcomeEvidence(db, id(sequence))).toBeNull();
				sequence += 1;
			}
		}
	});

	it("requires every reference code to be a runtime string before stable-code validation", () => {
		const invalidValues = [42, true, false, null, 1n, ["nested-code"], { code: "object-code" }];
		let sequence = 800;

		for (const value of invalidValues) {
			const input = groundedStaleEvidence({
				evidenceId: id(sequence),
				observedAt: OBSERVED_AT,
				producer: "checkout-verifier",
				producerVersion: "v1",
				checkoutId: `checkout-${sequence}`,
				referenceCodes: [value] as never,
			});
			expect(() => recordOutcomeEvidence(db, input)).toThrow(OutcomeEvidenceValidationError);
			expect(() => recordOutcomeEvidence(db, input)).toThrow(/only string values/);
			expect(tryRecordOutcomeEvidence(db, input)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
			expect(
				db
					.prepare("SELECT count(*) FROM outcome_evidence WHERE evidence_id = ?")
					.pluck()
					.get(id(sequence)),
			).toBe(0);
			sequence += 1;
		}

		const orderedCodes = ["code.beta", "code.alpha", "code.beta"];
		const valid = recordOutcomeEvidence(
			db,
			groundedStaleEvidence({
				evidenceId: id(sequence),
				observedAt: OBSERVED_AT,
				producer: "checkout-verifier",
				producerVersion: "v1",
				checkoutId: `checkout-${sequence}`,
				referenceCodes: orderedCodes,
			}),
		).evidence;
		expect(valid.references?.reference_codes).toEqual(orderedCodes);
	});

	it("fails closed when persisted reference codes contain non-string values", () => {
		const corruptValues = [42, true, false, null, ["nested-code"], { code: "object-code" }];
		let sequence = 850;

		for (const value of corruptValues) {
			const stored = recordOutcomeEvidence(
				db,
				groundedStaleEvidence({
					evidenceId: id(sequence),
					observedAt: OBSERVED_AT,
					producer: "checkout-verifier",
					producerVersion: "v1",
					checkoutId: `checkout-${sequence}`,
					referenceCodes: ["valid-code"],
				}),
			).evidence;
			db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
				JSON.stringify({ ...(stored.references ?? {}), reference_codes: [value] }),
				id(sequence),
			);
			expect(getOutcomeEvidence(db, id(sequence))).toBeNull();
			sequence += 1;
		}
	});

	it("requires evidenceId to be a runtime string before UUID parsing", () => {
		const invalidValues = [42, true, false, null, 1n, [id(900)], { id: id(900) }];

		for (const value of invalidValues) {
			const input = { ...check(900), evidenceId: value } as never;
			expect(() => recordOutcomeEvidence(db, input)).toThrow(OutcomeEvidenceValidationError);
			expect(() => recordOutcomeEvidence(db, input)).toThrow(/must be a string UUID/);
			expect(tryRecordOutcomeEvidence(db, input)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
			expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(0);
		}

		const uppercaseId = id(901).toUpperCase();
		expect(
			recordOutcomeEvidence(db, { ...check(901), evidenceId: uppercaseId }).evidence.evidenceId,
		).toBe(id(901));

		recordOutcomeEvidence(db, check(902));
		db.prepare("UPDATE outcome_evidence SET evidence_id = 42 WHERE evidence_id = ?").run(id(902));
		expect(getOutcomeEvidence(db, id(902))).toBeNull();
		expect(queryOutcomeEvidence(db).map((evidence) => evidence.evidenceId)).toEqual([id(901)]);
	});

	it("rejects repository paths that normalize to an empty path without persisting a row", () => {
		const invalidPathEvidence = {
			evidenceId: id(210),
			dimension: "mechanism" as const,
			evidenceType: "mechanism.source_location_match" as const,
			sourceClass: "derived" as const,
			observedAt: OBSERVED_AT,
			producer: "path-overlap",
			producerVersion: "v1",
			status: "present" as const,
			value: { type: "integer" as const, value: 0, unit: "count" as const },
			references: { repository_paths: ["./"], matched_paths: [] },
		};

		expect(() => recordOutcomeEvidence(db, invalidPathEvidence)).toThrow(
			OutcomeEvidenceValidationError,
		);
		expect(() => recordOutcomeEvidence(db, invalidPathEvidence)).toThrow(/repository-relative/);
		expect(tryRecordOutcomeEvidence(db, invalidPathEvidence)).toEqual({
			ok: false,
			errorCode: "outcome_evidence_write_failed",
			reason: "invalid_input",
		});
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(0);
	});

	it("rejects Windows drive-relative paths while preserving other colon-containing names", () => {
		const colonName = sourceLocationOverlapEvidence({
			evidenceId: id(224),
			observedAt: OBSERVED_AT,
			producer: "path-overlap",
			producerVersion: "v1",
			retrievedPaths: ["src/schema:private.ts"],
			downstreamPaths: ["src/schema:private.ts"],
		});
		expect(recordOutcomeEvidence(db, colonName).evidence.references?.matched_paths).toEqual([
			"src/schema:private.ts",
		]);

		for (const [sequence, path] of [
			[225, "C:private.ts"],
			[226, "c:private.ts"],
			[231, "./C:private.ts"],
			[232, "sub/../C:private.ts"],
			[233, ".\\C:private.ts"],
		] as const) {
			expect(() =>
				sourceLocationOverlapEvidence({
					evidenceId: id(sequence),
					observedAt: OBSERVED_AT,
					producer: "path-overlap",
					producerVersion: "v1",
					retrievedPaths: [path],
					downstreamPaths: [],
				}),
			).toThrow(/repository-relative/);
		}
		const nonSourceLocationBase = check(234);
		const nonSourceLocation = {
			...nonSourceLocationBase,
			references: {
				...(nonSourceLocationBase.references ?? {}),
				repository_paths: ["./C:private.ts"],
			},
		};
		expect(tryRecordOutcomeEvidence(db, nonSourceLocation)).toEqual({
			ok: false,
			errorCode: "outcome_evidence_write_failed",
			reason: "invalid_input",
		});
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(1);
	});

	it("rejects URI-scheme repository paths after normalization", () => {
		for (const [sequence, path] of [
			[235, "file:///private/source.ts"],
			[236, "https://example.test/source.ts"],
			[237, "git+ssh://example.test/repository/source.ts"],
			[238, "./https://example.test/source.ts"],
			[239, "sub/../file:private.ts"],
			[240, " file:///private/source.ts"],
		] as const) {
			expect(() =>
				sourceLocationOverlapEvidence({
					evidenceId: id(sequence),
					observedAt: OBSERVED_AT,
					producer: "path-overlap",
					producerVersion: "v1",
					retrievedPaths: [path],
					downstreamPaths: [],
				}),
			).toThrow(/repository-relative/);
		}

		const directWriteBase = check(241);
		expect(
			tryRecordOutcomeEvidence(db, {
				...directWriteBase,
				references: {
					...(directWriteBase.references ?? {}),
					repository_paths: ["file:///private/source.ts"],
				},
			}),
		).toEqual({
			ok: false,
			errorCode: "outcome_evidence_write_failed",
			reason: "invalid_input",
		});
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(0);

		recordOutcomeEvidence(
			db,
			sourceLocationOverlapEvidence({
				evidenceId: id(242),
				observedAt: OBSERVED_AT,
				producer: "path-overlap",
				producerVersion: "v1",
				retrievedPaths: ["packages/core/src/schema.ts"],
				downstreamPaths: [],
			}),
		);
		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify({ repository_paths: ["file:/private/source.ts"], matched_paths: [] }),
			id(242),
		);
		expect(getOutcomeEvidence(db, id(242))).toBeNull();
		expect(queryOutcomeEvidence(db).map((evidence) => evidence.evidenceId)).not.toContain(id(242));
	});

	it("rolls back an insert when transactional read verification fails", () => {
		db.exec(`
			CREATE TRIGGER corrupt_outcome_evidence_after_insert
			AFTER INSERT ON outcome_evidence
			BEGIN
				UPDATE outcome_evidence
				SET producer = 'not a stable producer'
				WHERE evidence_id = NEW.evidence_id;
			END
		`);

		expect(() => recordOutcomeEvidence(db, check(211))).toThrow(
			/outcome evidence was not persisted/,
		);
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(0);
	});

	it("uses normalized matched paths as the source of truth for source-location counts", () => {
		const emptyMatch = sourceLocationOverlapEvidence({
			evidenceId: id(125),
			observedAt: OBSERVED_AT,
			producer: "path-overlap",
			producerVersion: "v1",
			retrievedPaths: ["packages/core/src/schema.ts"],
			downstreamPaths: ["packages/core/src/store.ts"],
		});
		const invalidEmptyMatch = {
			...emptyMatch,
			value: { type: "integer" as const, value: 1, unit: "count" as const },
		};
		expect(() => recordOutcomeEvidence(db, invalidEmptyMatch)).toThrow(/matched_paths length/);
		expect(tryRecordOutcomeEvidence(db, invalidEmptyMatch)).toEqual({
			ok: false,
			errorCode: "outcome_evidence_write_failed",
			reason: "invalid_input",
		});

		const oneMatch = sourceLocationOverlapEvidence({
			evidenceId: id(126),
			observedAt: OBSERVED_AT,
			producer: "path-overlap",
			producerVersion: "v1",
			retrievedPaths: ["packages/core/src/schema.ts"],
			downstreamPaths: ["packages/core/src/schema.ts"],
		});
		for (const [sequence, count] of [
			[126, 0],
			[127, 2],
		] as const) {
			expect(() =>
				recordOutcomeEvidence(db, {
					...oneMatch,
					evidenceId: id(sequence),
					value: { type: "integer", value: count, unit: "count" },
				}),
			).toThrow(/matched_paths length/);
		}

		const valid = recordOutcomeEvidence(db, { ...oneMatch, evidenceId: id(128) }).evidence;
		expect(valid.value).toEqual({ type: "integer", value: 1, unit: "count" });
		db.prepare("UPDATE outcome_evidence SET value_integer = 0 WHERE evidence_id = ?").run(id(128));
		expect(getOutcomeEvidence(db, id(128))).toBeNull();
	});

	it("round-trips deterministic Windows source-location matching without compatibility folding", () => {
		const collected = sourceLocationOverlapEvidence(
			{
				evidenceId: id(65),
				observedAt: OBSERVED_AT,
				producer: "path-overlap",
				producerVersion: "v1",
				retrievedPaths: [
					"Packages/Core/Src/schema.ts",
					"packages/core/src/SCHEMA.ts",
					"packages/core/src/store.ts",
					"packages/core/src/ﬁle.ts",
					"packages/core/src/file.ts",
					"packages/core/src/FILE.ts",
				],
				downstreamPaths: ["packages/core/src/SCHEMA.ts", "packages/core/src/file.ts"],
			},
			"win32",
		);
		recordOutcomeEvidence(db, collected);
		const evidence = getOutcomeEvidence(db, id(65));

		expect(evidence).not.toBeNull();
		expect(evidence?.references?.repository_paths).toEqual([
			"Packages/Core/Src/schema.ts",
			"packages/core/src/store.ts",
			"packages/core/src/ﬁle.ts",
			"packages/core/src/file.ts",
		]);
		expect(evidence?.references?.matched_paths).toEqual([
			"Packages/Core/Src/schema.ts",
			"packages/core/src/file.ts",
		]);
		expect(evidence?.value).toEqual({ type: "integer", value: 2, unit: "count" });
		expect(() =>
			recordOutcomeEvidence(
				db,
				{
					...collected,
					evidenceId: id(67),
					value: { type: "integer", value: 1, unit: "count" },
					references: {
						repository_paths: ["src/Foo.ts"],
						matched_paths: ["src/foo.ts"],
					},
				},
				"linux",
			),
		).toThrow(/must come from repository_paths/);
	});

	it("uses Windows path equality for direct source-location validation", () => {
		const duplicatePaths = {
			evidenceId: id(68),
			dimension: "mechanism" as const,
			evidenceType: "mechanism.source_location_match" as const,
			sourceClass: "derived" as const,
			observedAt: OBSERVED_AT,
			producer: "path-overlap",
			producerVersion: "v1",
			status: "present" as const,
			value: { type: "integer" as const, value: 1, unit: "count" as const },
			references: {
				repository_paths: ["src/Foo.ts", "src/foo.ts", "src/./FOO.ts"],
				matched_paths: ["src/./foo.ts", "src/FOO.ts"],
			},
		};

		const duplicateResult = recordOutcomeEvidence(db, duplicatePaths, "win32");
		expect(duplicateResult.evidence).toMatchObject({
			value: { type: "integer", value: 1, unit: "count" },
			references: {
				repository_paths: ["src/Foo.ts"],
				matched_paths: ["src/Foo.ts"],
			},
		});
		expect(tryRecordOutcomeEvidence(db, duplicatePaths, "win32")).toEqual({
			ok: true,
			value: { evidence: duplicateResult.evidence, inserted: false },
		});
		expect(
			recordOutcomeEvidence(db, {
				...duplicatePaths,
				references: {
					repository_paths: ["src/Foo.ts"],
					matched_paths: ["src/Foo.ts"],
				},
			}),
		).toEqual({ evidence: duplicateResult.evidence, inserted: false });
		const helperResult = sourceLocationOverlapEvidence(
			{
				evidenceId: id(924),
				observedAt: OBSERVED_AT,
				producer: "path-overlap",
				producerVersion: "v1",
				retrievedPaths: duplicatePaths.references.repository_paths,
				downstreamPaths: duplicatePaths.references.matched_paths,
			},
			"win32",
		);
		expect(helperResult.references).toEqual(duplicateResult.evidence.references);
		expect(helperResult.value).toEqual(duplicateResult.evidence.value);

		const valid = {
			...duplicatePaths,
			evidenceId: id(69),
			value: { type: "integer" as const, value: 2, unit: "count" as const },
			references: {
				repository_paths: ["src/Foo.ts", "src/Bar.ts"],
				matched_paths: ["src/foo.ts", "src/bar.ts"],
			},
		};
		const first = recordOutcomeEvidence(db, valid, "win32");
		expect(first).toMatchObject({
			inserted: true,
			evidence: {
				value: { type: "integer", value: 2, unit: "count" },
				references: {
					repository_paths: ["src/Foo.ts", "src/Bar.ts"],
					matched_paths: ["src/Foo.ts", "src/Bar.ts"],
				},
			},
		});
		expect(recordOutcomeEvidence(db, valid, "win32")).toEqual({
			evidence: first.evidence,
			inserted: false,
		});
		expect(getOutcomeEvidence(db, id(69))).toEqual(first.evidence);

		const persisted = {
			...valid,
			evidenceId: id(70),
			references: {
				repository_paths: ["src/Foo.ts", "src/Bar.ts"],
				matched_paths: ["src/Foo.ts", "src/Bar.ts"],
			},
		};
		recordOutcomeEvidence(db, persisted, "win32");

		db.prepare("UPDATE outcome_evidence SET references_json = ? WHERE evidence_id = ?").run(
			JSON.stringify({
				repository_paths: ["src/Foo.ts", "src/Bar.ts"],
				matched_paths: ["src/Foo.ts", "src/Foo.ts"],
			}),
			id(70),
		);
		expect(getOutcomeEvidence(db, id(70))).toBeNull();
	});

	it("preserves source-location path case distinctions on POSIX", () => {
		const evidence = sourceLocationOverlapEvidence(
			{
				evidenceId: id(66),
				observedAt: OBSERVED_AT,
				producer: "path-overlap",
				producerVersion: "v1",
				retrievedPaths: ["src/Foo.ts", "src/foo.ts", "src/Foo.ts"],
				downstreamPaths: ["src/foo.ts"],
			},
			"linux",
		);

		expect(evidence.references?.repository_paths).toEqual(["src/Foo.ts", "src/foo.ts"]);
		expect(evidence.references?.matched_paths).toEqual(["src/foo.ts"]);
		expect(evidence.value).toEqual({ type: "integer", value: 1, unit: "count" });

		const direct = recordOutcomeEvidence(
			db,
			{
				...evidence,
				evidenceId: id(70),
				value: { type: "integer", value: 2, unit: "count" },
				references: {
					repository_paths: ["src/Foo.ts", "src/foo.ts"],
					matched_paths: ["src/Foo.ts", "src/foo.ts"],
				},
			},
			"linux",
		).evidence;
		expect(direct.references).toEqual({
			matched_paths: ["src/Foo.ts", "src/foo.ts"],
			repository_paths: ["src/Foo.ts", "src/foo.ts"],
		});
		expect(direct.value).toEqual({ type: "integer", value: 2, unit: "count" });
		expect(getOutcomeEvidence(db, id(70))).toEqual(direct);
	});

	it("requires explicit time zones on writes and correlation windows", () => {
		const acceptedTimestamps = [
			[212, "2026-08-03T12:00:00Z"],
			[213, "2026-08-03T14:00:00+02:00"],
			[214, "2026-08-03T07:00:00-05:00"],
		] as const;
		for (const [sequence, observedAt] of acceptedTimestamps) {
			expect(
				recordOutcomeEvidence(db, { ...check(sequence), observedAt }).evidence.observedAt,
			).toBe(OBSERVED_AT);
		}

		const correlated = recordOutcomeEvidence(db, {
			...check(215),
			windowStartAt: "2026-08-03T14:00:00+02:00",
			windowEndAt: "2026-08-03T07:05:00-05:00",
		}).evidence;
		expect(correlated).toMatchObject({
			windowStartAt: "2026-08-03T12:00:00.000Z",
			windowEndAt: "2026-08-03T12:05:00.000Z",
		});

		const invalidInputs = [
			{ ...check(216), observedAt: "2026-08-03T12:00:00" },
			{ ...check(217), observedAt: "2026-08-03" },
			{ ...check(218), observedAt: "2026-08-03T12:00:00Z trailing" },
			{ ...check(219), windowStartAt: "2026-08-03T12:00:00" },
			{ ...check(220), windowEndAt: "2026-08-03" },
		];
		for (const input of invalidInputs) {
			expect(() => recordOutcomeEvidence(db, input)).toThrow(OutcomeEvidenceValidationError);
			expect(() => recordOutcomeEvidence(db, input)).toThrow(/explicit time zone/);
			expect(tryRecordOutcomeEvidence(db, input)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
		}
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(4);
	});

	it("requires observedAt before storage and fails closed on corrupt stored timestamps", () => {
		const missingObservedAt = { ...check(540) } as Partial<ReturnType<typeof check>>;
		delete missingObservedAt.observedAt;
		const invalidInputs = [
			missingObservedAt,
			{ ...check(541), observedAt: null },
			{ ...check(542), observedAt: 42 },
			{ ...check(543), observedAt: true },
			{ ...check(544), observedAt: { timestamp: OBSERVED_AT } },
			{ ...check(545), observedAt: "not-a-timestamp" },
		];

		for (const input of invalidInputs) {
			expect(() => recordOutcomeEvidence(db, input as never)).toThrow(
				OutcomeEvidenceValidationError,
			);
			expect(tryRecordOutcomeEvidence(db, input as never)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
		}
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(0);

		const valid = recordOutcomeEvidence(db, {
			...check(546),
			observedAt: "2026-08-03T14:00:00+02:00",
			retentionDays: 7,
		}).evidence;
		expect(valid).toMatchObject({
			observedAt: OBSERVED_AT,
			retentionUntil: "2026-08-10T12:00:00.000Z",
		});

		db.prepare("UPDATE outcome_evidence SET observed_at = ? WHERE evidence_id = ?").run(
			"not-a-timestamp",
			id(546),
		);
		expect(getOutcomeEvidence(db, id(546))).toBeNull();
	});

	it("rejects nonexistent local calendar components through every timestamp boundary", () => {
		expect(
			recordOutcomeEvidence(db, {
				...check(227),
				observedAt: "2024-02-29T23:30:00-0200",
			}).evidence.observedAt,
		).toBe("2024-03-01T01:30:00.000Z");

		const invalidWrite = { ...check(228), observedAt: "2026-02-30T12:00:00Z" };
		expect(() => recordOutcomeEvidence(db, invalidWrite)).toThrow(OutcomeEvidenceValidationError);
		expect(tryRecordOutcomeEvidence(db, invalidWrite)).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});
		expect(() =>
			recordOutcomeEvidence(db, {
				...check(229),
				windowStartAt: "2025-02-29T12:00:00+02:00",
			}),
		).toThrow(OutcomeEvidenceValidationError);
		expect(() => queryOutcomeEvidence(db, { observedAtOrAfter: "2026-04-31T12:00:00Z" })).toThrow(
			OutcomeEvidenceValidationError,
		);
		expect(() =>
			queryOutcomeEvidence(db, { observedAtOrBefore: "2026-02-30T12:00:00-05:00" }),
		).toThrow(OutcomeEvidenceValidationError);
		expect(() => purgeExpiredOutcomeEvidence(db, "2026-02-30T12:00:00Z")).toThrow(
			OutcomeEvidenceValidationError,
		);

		recordOutcomeEvidence(db, check(230));
		db.prepare("UPDATE outcome_evidence SET observed_at = ? WHERE evidence_id = ?").run(
			"2026-02-30T12:00:00Z",
			id(230),
		);
		expect(getOutcomeEvidence(db, id(230))).toBeNull();
	});

	it("rejects invalid offset components through every timestamp boundary", () => {
		const invalidOffsets = ["+99:00", "-23:99"] as const;
		for (const [index, offset] of invalidOffsets.entries()) {
			const timestamp = `2026-08-03T12:00:00${offset}`;
			const write = { ...check(235 + index), observedAt: timestamp };
			expect(() => recordOutcomeEvidence(db, write)).toThrow(OutcomeEvidenceValidationError);
			expect(tryRecordOutcomeEvidence(db, write)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
			expect(() =>
				recordOutcomeEvidence(db, {
					...check(237 + index),
					windowStartAt: timestamp,
				}),
			).toThrow(OutcomeEvidenceValidationError);
			expect(() => queryOutcomeEvidence(db, { observedAtOrAfter: timestamp })).toThrow(
				OutcomeEvidenceValidationError,
			);
			expect(() => queryOutcomeEvidence(db, { observedAtOrBefore: timestamp })).toThrow(
				OutcomeEvidenceValidationError,
			);
			expect(() => purgeExpiredOutcomeEvidence(db, timestamp)).toThrow(
				OutcomeEvidenceValidationError,
			);

			const storedSequence = 239 + index;
			recordOutcomeEvidence(db, check(storedSequence));
			db.prepare("UPDATE outcome_evidence SET observed_at = ? WHERE evidence_id = ?").run(
				timestamp,
				id(storedSequence),
			);
			expect(getOutcomeEvidence(db, id(storedSequence))).toBeNull();
		}
	});

	it("requires explicit time zones on query bounds", () => {
		recordOutcomeEvidence(db, check(221));
		expect(
			queryOutcomeEvidence(db, {
				observedAtOrAfter: "2026-08-03T14:00:00+02:00",
				observedAtOrBefore: "2026-08-03T07:00:00-05:00",
			}).map((evidence) => evidence.evidenceId),
		).toEqual([id(221)]);
		expect(
			queryOutcomeEvidence(db, {
				observedAtOrAfter: OBSERVED_AT,
				observedAtOrBefore: OBSERVED_AT,
			}),
		).toHaveLength(1);

		for (const bounds of [
			{ observedAtOrAfter: "2026-08-03T12:00:00" },
			{ observedAtOrBefore: "2026-08-03" },
			{ observedAtOrAfter: "2026-08-03T12:00:00Z trailing" },
		]) {
			expect(() => queryOutcomeEvidence(db, bounds)).toThrow(OutcomeEvidenceValidationError);
			expect(() => queryOutcomeEvidence(db, bounds)).toThrow(/explicit time zone/);
		}
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(1);
	});

	it("requires an explicit time zone before purging expired evidence", () => {
		recordOutcomeEvidence(db, { ...check(222), retentionDays: 7 });
		expect(() => purgeExpiredOutcomeEvidence(db, null as never)).toThrow(
			OutcomeEvidenceValidationError,
		);
		expect(() => purgeExpiredOutcomeEvidence(db, null as never)).toThrow(/now is required/);
		expect(getOutcomeEvidence(db, id(222))).not.toBeNull();
		for (const now of ["2026-08-10T12:00:00", "2026-08-10", "2026-08-10T12:00:00Z trailing"]) {
			expect(() => purgeExpiredOutcomeEvidence(db, now)).toThrow(OutcomeEvidenceValidationError);
			expect(() => purgeExpiredOutcomeEvidence(db, now)).toThrow(/explicit time zone/);
			expect(getOutcomeEvidence(db, id(222))).not.toBeNull();
		}
		expect(purgeExpiredOutcomeEvidence(db, "2026-08-10T14:00:00+02:00")).toBe(1);

		recordOutcomeEvidence(db, { ...check(223), retentionDays: 7 });
		expect(purgeExpiredOutcomeEvidence(db, "2026-08-10T07:00:00-05:00")).toBe(1);
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(0);
	});

	it("preserves missing correlation and bounded downstream windows without job-span objects", () => {
		const evidence = recordOutcomeEvidence(db, {
			...check(70),
			sessionId: undefined,
			source: undefined,
			streamId: undefined,
			windowStartAt: "2026-08-03T12:00:00Z",
			windowEndAt: "2026-08-03T12:05:00Z",
		}).evidence;
		expect(evidence).toMatchObject({ sessionId: null, source: null, streamId: null });
		expect(evidence.windowEndAt).toBe("2026-08-03T12:05:00.000Z");
		expect(() => recordOutcomeEvidence(db, { ...check(71), jobSpan: {} } as never)).toThrow();
	});

	it("requires retentionPinned to be a runtime boolean when provided", () => {
		const defaultRetentionUntil = "2026-11-01T12:00:00.000Z";
		for (const [sequence, retentionPinned] of [
			[550, undefined],
			[551, false],
			[552, true],
		] as const) {
			const evidence = recordOutcomeEvidence(db, {
				...check(sequence),
				experimentId: retentionPinned === true ? "retention-study" : undefined,
				retentionPinned,
			}).evidence;
			expect(evidence.retentionPinned).toBe(retentionPinned ?? false);
			expect(evidence.retentionUntil).toBe(retentionPinned === true ? null : defaultRetentionUntil);
			expect(
				db
					.prepare(
						"SELECT retention_pinned, retention_until FROM outcome_evidence WHERE evidence_id = ?",
					)
					.get(id(sequence)),
			).toEqual({
				retention_pinned: retentionPinned === true ? 1 : 0,
				retention_until: retentionPinned === true ? null : defaultRetentionUntil,
			});
		}

		for (const [index, retentionPinned] of [null, "true", "false", 1, 0, [], {}].entries()) {
			const input = {
				...check(553 + index),
				experimentId: "retention-study",
				retentionPinned: retentionPinned as never,
			};
			expect(() => recordOutcomeEvidence(db, input)).toThrow(OutcomeEvidenceValidationError);
			expect(() => recordOutcomeEvidence(db, input)).toThrow(
				/retentionPinned must be a boolean when provided/,
			);
			expect(tryRecordOutcomeEvidence(db, input)).toEqual({
				ok: false,
				errorCode: "outcome_evidence_write_failed",
				reason: "invalid_input",
			});
		}
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(3);

		for (const [sequence, corruption] of [
			[560, "retention_pinned = 1, retention_until = '2026-09-02T12:00:00.000Z'"],
			[561, "retention_pinned = 0, retention_until = NULL"],
		] as const) {
			recordOutcomeEvidence(db, check(sequence));
			db.prepare(`UPDATE outcome_evidence SET ${corruption} WHERE evidence_id = ?`).run(
				id(sequence),
			);
			expect(getOutcomeEvidence(db, id(sequence))).toBeNull();
		}
	});

	it("applies retrieval-ledger retention bounds and privacy cleanup", () => {
		recordOutcomeEvidence(db, { ...check(80), retentionDays: 7 });
		recordOutcomeEvidence(db, { ...check(81), retentionDays: 365 });
		recordOutcomeEvidence(db, {
			...check(83),
			sessionId: undefined,
			source: undefined,
			streamId: undefined,
			experimentId: "retention-study",
			retentionPinned: true,
		});
		expect(purgeExpiredOutcomeEvidence(db, "2026-08-11T12:00:00.000Z")).toBe(1);
		expect(getOutcomeEvidence(db, id(80))).toBeNull();
		expect(getOutcomeEvidence(db, id(83))?.retentionUntil).toBeNull();
		expect(purgeOutcomeEvidenceForPrivacy(db, { source: "opencode", streamId: "stream-1" })).toBe(
			1,
		);
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(1);
		expect(() => recordOutcomeEvidence(db, { ...check(82), retentionDays: 6 })).toThrow(
			/7 through 365/,
		);
		expect(() =>
			recordOutcomeEvidence(db, {
				...check(84),
				retentionDays: null,
			} as unknown as RecordOutcomeEvidenceInput),
		).toThrow(/7 through 365/);
	});

	it("finalizes pinned outcome evidence idempotently and preserves recorder retry identity", () => {
		const pinned = {
			...check(570),
			experimentId: "retention-study",
			retentionPinned: true,
		};
		recordOutcomeEvidence(db, pinned);

		const finalized = finalizeOutcomeEvidenceRetention(db, pinned.evidenceId, {
			finalizedAt: "2026-08-10T12:00:00.000Z",
			retentionDays: 7,
		});
		expect(finalized).toMatchObject({
			changed: true,
			evidence: {
				retentionPinned: false,
				retentionUntil: "2026-08-17T12:00:00.000Z",
				retentionFinalizedAt: "2026-08-10T12:00:00.000Z",
			},
		});
		expect(
			tryFinalizeOutcomeEvidenceRetention(db, pinned.evidenceId, {
				finalizedAt: "2026-08-10T12:00:00.000Z",
				retentionDays: 7,
			}),
		).toMatchObject({ ok: true, value: { changed: false } });
		expect(recordOutcomeEvidence(db, pinned)).toMatchObject({ inserted: false });
		expect(queryOutcomeEvidence(db).map((evidence) => evidence.evidenceId)).toContain(
			pinned.evidenceId,
		);
	});

	it("rejects explicit null retention when finalizing pinned evidence", () => {
		const pinned = {
			...check(590),
			experimentId: "retention-study",
			retentionPinned: true,
		};
		recordOutcomeEvidence(db, pinned);
		const invalid = {
			finalizedAt: "2026-08-10T12:00:00.000Z",
			retentionDays: null,
		} as unknown as Parameters<typeof finalizeOutcomeEvidenceRetention>[2];

		expect(() => finalizeOutcomeEvidenceRetention(db, pinned.evidenceId, invalid)).toThrow(
			/7 through 365/,
		);
		expect(tryFinalizeOutcomeEvidenceRetention(db, pinned.evidenceId, invalid)).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});
		expect(getOutcomeEvidence(db, pinned.evidenceId)).toMatchObject({
			retentionPinned: true,
			retentionUntil: null,
			retentionFinalizedAt: null,
		});
	});

	it("rejects unsupported outcome finalization fields without changing retention", () => {
		const pinned = {
			...check(591),
			experimentId: "retention-study",
			retentionPinned: true,
		};
		recordOutcomeEvidence(db, pinned);
		const invalid = {
			finalizedAt: "2026-08-10T12:00:00.000Z",
			retentionDays: 7,
			retentionDay: 7,
		} as unknown as Parameters<typeof finalizeOutcomeEvidenceRetention>[2];

		expect(() => finalizeOutcomeEvidenceRetention(db, pinned.evidenceId, invalid)).toThrow(
			/unsupported key: retentionDay/,
		);
		expect(tryFinalizeOutcomeEvidenceRetention(db, pinned.evidenceId, invalid)).toEqual({
			ok: false,
			errorCode: "outcome_evidence_retention_write_failed",
			reason: "invalid_input",
		});
		expect(getOutcomeEvidence(db, pinned.evidenceId)).toMatchObject({
			retentionPinned: true,
			retentionUntil: null,
			retentionFinalizedAt: null,
		});
	});

	it("rolls back finalization when the canonical return record cannot be read", () => {
		const pinned = {
			...check(577),
			experimentId: "retention-study",
			retentionPinned: true,
		};
		recordOutcomeEvidence(db, pinned);
		db.prepare("UPDATE outcome_evidence SET status = 'present' WHERE evidence_id = ?").run(
			pinned.evidenceId,
		);

		expect(() =>
			finalizeOutcomeEvidenceRetention(db, pinned.evidenceId, {
				finalizedAt: "2026-08-10T12:00:00.000Z",
				retentionDays: 7,
			}),
		).toThrow(/outcome evidence does not exist/);
		expect(
			db
				.prepare(
					"SELECT retention_pinned, retention_until, retention_finalized_at FROM outcome_evidence WHERE evidence_id = ?",
				)
				.get(pinned.evidenceId),
		).toEqual({ retention_pinned: 1, retention_until: null, retention_finalized_at: null });
	});

	it("rejects invalid, unpinned, unsupported, and conflicting outcome finalization", () => {
		const pinned = {
			...check(571),
			experimentId: "retention-study",
			retentionPinned: true,
		};
		recordOutcomeEvidence(db, pinned);
		const predated = { finalizedAt: "2026-08-03T11:59:59.999Z", retentionDays: 7 };
		expect(() => finalizeOutcomeEvidenceRetention(db, pinned.evidenceId, predated)).toThrow(
			/finalizedAt cannot precede observedAt/,
		);
		expect(tryFinalizeOutcomeEvidenceRetention(db, pinned.evidenceId, predated)).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});
		expect(getOutcomeEvidence(db, pinned.evidenceId)).toMatchObject({
			retentionPinned: true,
			retentionUntil: null,
			retentionFinalizedAt: null,
		});

		const ordinary = recordOutcomeEvidence(db, check(572)).evidence;
		expect(() =>
			finalizeOutcomeEvidenceRetention(db, ordinary.evidenceId, {
				finalizedAt: "2026-08-10T12:00:00.000Z",
				retentionDays: 7,
			}),
		).toThrow(/conflicts with persisted data/);
		expect(
			tryFinalizeOutcomeEvidenceRetention(db, ordinary.evidenceId, {
				finalizedAt: "2026-08-10T12:00:00.000Z",
				retentionDays: 7,
			}),
		).toEqual({
			ok: false,
			errorCode: "outcome_evidence_retention_write_failed",
			reason: "idempotency_conflict",
		});
		expect(
			tryFinalizeOutcomeEvidenceRetention(db, id(573), {
				finalizedAt: "2026-08-10T12:00:00.000Z",
			}),
		).toMatchObject({ ok: false, reason: "evidence_not_found" });
		for (const retentionDays of [6, 366]) {
			expect(
				tryFinalizeOutcomeEvidenceRetention(db, pinned.evidenceId, {
					finalizedAt: "2026-08-10T12:00:00.000Z",
					retentionDays,
				}),
			).toMatchObject({ ok: false, reason: "invalid_input" });
		}

		db.prepare("UPDATE outcome_evidence SET contract_version = 2 WHERE evidence_id = ?").run(
			pinned.evidenceId,
		);
		expect(() =>
			finalizeOutcomeEvidenceRetention(db, pinned.evidenceId, {
				finalizedAt: "2026-08-10T12:00:00.000Z",
			}),
		).toThrow(/contract version is unsupported/);
		expect(
			tryFinalizeOutcomeEvidenceRetention(db, pinned.evidenceId, {
				finalizedAt: "2026-08-10T12:00:00.000Z",
			}),
		).toMatchObject({ ok: false, reason: "invalid_input" });
		expect(
			db
				.prepare(
					"SELECT retention_pinned, retention_until, retention_finalized_at FROM outcome_evidence WHERE evidence_id = ?",
				)
				.get(pinned.evidenceId),
		).toEqual({ retention_pinned: 1, retention_until: null, retention_finalized_at: null });

		const unavailableDb = new Database(":memory:");
		unavailableDb.close();
		expect(
			tryFinalizeOutcomeEvidenceRetention(unavailableDb, pinned.evidenceId, {
				finalizedAt: "2026-08-10T12:00:00.000Z",
			}),
		).toMatchObject({ ok: false, reason: "storage_unavailable" });
	});

	it("rejects conflicting finalization retries and internal finalization recorder input", () => {
		const pinned = {
			...check(574),
			experimentId: "retention-study",
			retentionPinned: true,
		};
		recordOutcomeEvidence(db, pinned);
		finalizeOutcomeEvidenceRetention(db, pinned.evidenceId, {
			finalizedAt: "2026-08-10T12:00:00.000Z",
			retentionDays: 7,
		});

		expect(
			tryFinalizeOutcomeEvidenceRetention(db, pinned.evidenceId, {
				finalizedAt: "2026-08-11T12:00:00.000Z",
				retentionDays: 7,
			}),
		).toMatchObject({ ok: false, reason: "idempotency_conflict" });
		expect(
			tryFinalizeOutcomeEvidenceRetention(db, pinned.evidenceId, {
				finalizedAt: "2026-08-10T12:00:00.000Z",
				retentionDays: 8,
			}),
		).toMatchObject({ ok: false, reason: "idempotency_conflict" });
		expect(() =>
			recordOutcomeEvidence(db, {
				...check(575),
				retentionFinalizedAt: "2026-08-10T12:00:00.000Z",
			} as never),
		).toThrow(/unsupported key: retentionFinalizedAt/);
	});

	it("fails closed when stored outcome finalization state is malformed", () => {
		const pinned = {
			...check(576),
			experimentId: "retention-study",
			retentionPinned: true,
		};
		recordOutcomeEvidence(db, pinned);
		finalizeOutcomeEvidenceRetention(db, pinned.evidenceId, {
			finalizedAt: "2026-08-10T12:00:00.000Z",
			retentionDays: 7,
		});
		db.prepare("UPDATE outcome_evidence SET retention_finalized_at = ? WHERE evidence_id = ?").run(
			"2026-08-03T11:59:59.999Z",
			pinned.evidenceId,
		);

		expect(getOutcomeEvidence(db, pinned.evidenceId)).toBeNull();
		expect(queryOutcomeEvidence(db)).toEqual([]);
	});

	it("scopes expiry to contract v1 while privacy cleanup remains version-agnostic", () => {
		const supported = { ...check(84), retentionDays: 7 };
		const future = { ...check(85), retentionDays: 7 };
		recordOutcomeEvidence(db, supported);
		recordOutcomeEvidence(db, future);
		db.prepare("UPDATE outcome_evidence SET contract_version = 2 WHERE evidence_id = ?").run(
			future.evidenceId,
		);

		expect(purgeExpiredOutcomeEvidence(db, "2026-08-11T12:00:00.000Z")).toBe(1);
		expect(
			db
				.prepare("SELECT count(*) FROM outcome_evidence WHERE evidence_id = ?")
				.pluck()
				.get(supported.evidenceId),
		).toBe(0);
		expect(
			db
				.prepare(
					"SELECT contract_version, retention_pinned, retention_until FROM outcome_evidence WHERE evidence_id = ?",
				)
				.get(future.evidenceId),
		).toEqual({
			contract_version: 2,
			retention_pinned: 0,
			retention_until: "2026-08-10T12:00:00.000Z",
		});

		expect(purgeOutcomeEvidenceForPrivacy(db, { source: "opencode", streamId: "stream-1" })).toBe(
			1,
		);
		expect(db.prepare("SELECT count(*) FROM outcome_evidence").pluck().get()).toBe(0);
	});

	it("adds the local-only table idempotently when opening an old database", () => {
		const freshSchema = outcomeSchemaSnapshot(db);
		db.exec("DROP INDEX idx_outcome_evidence_observed_id");
		db.exec("ALTER TABLE outcome_evidence DROP COLUMN retention_finalized_at");
		ensureRetrievalLedgerSchema(db);
		ensureRetrievalLedgerSchema(db);
		expect(outcomeSchemaSnapshot(db)).toEqual(freshSchema);

		db.exec("DROP TABLE outcome_evidence");
		db.pragma("user_version = 17");

		ensureAdditiveSchemaCompatibility(db);
		ensureRetrievalLedgerSchema(db);

		expect(
			db
				.prepare(
					"SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'outcome_evidence'",
				)
				.pluck()
				.get(),
		).toBe(1);
		expect(outcomeSchemaSnapshot(db)).toEqual(freshSchema);
		expect(recordOutcomeEvidence(db, check(90)).inserted).toBe(true);
	});

	it("rejects impossible integer ratios and fails closed on malformed stored rows", () => {
		expect(() =>
			recordOutcomeEvidence(db, {
				...efficiencyEvidence({
					evidenceId: id(91),
					observedAt: OBSERVED_AT,
					producer: "event-counter",
					producerVersion: "v1",
					evidenceType: "efficiency.tool_call_count",
					value: 1,
				}),
				value: { type: "integer", value: 1, unit: "ratio" },
			} as never),
		).toThrow(/requires count units/);
		expect(() =>
			recordOutcomeEvidence(db, {
				evidenceId: id(93),
				dimension: "mechanism",
				evidenceType: "mechanism.memory_reference",
				sourceClass: "derived",
				observedAt: OBSERVED_AT,
				producer: "mechanism-counter",
				producerVersion: "v1",
				status: "present",
				value: { type: "integer", value: 1, unit: "ratio" },
			} as never),
		).toThrow(/cannot use ratio/);
		expect(
			tryRecordOutcomeEvidence(db, {
				...check(94),
				references: { check_id: "bad-lists", reference_codes: "not-an-array" } as never,
			}),
		).toMatchObject({ ok: false, reason: "invalid_input" });

		const realValue = recordOutcomeEvidence(db, {
			evidenceId: id(92),
			dimension: "mechanism",
			evidenceType: "mechanism.memory_reference",
			sourceClass: "derived",
			observedAt: OBSERVED_AT,
			producer: "mechanism-ratio",
			producerVersion: "v1",
			status: "present",
			value: { type: "real", value: 0.5, unit: "ratio" },
		}).evidence;
		expect(realValue.value).toEqual({ type: "real", value: 0.5, unit: "ratio" });

		recordOutcomeEvidence(
			db,
			efficiencyEvidence({
				evidenceId: id(124),
				observedAt: OBSERVED_AT,
				producer: "event-counter",
				producerVersion: "v1",
				evidenceType: "efficiency.tool_call_count",
				value: 2,
			}),
		);
		db.prepare(
			"UPDATE outcome_evidence SET value_type = 'real', value_integer = NULL, value_real = 2.5 WHERE evidence_id = ?",
		).run(id(124));
		expect(getOutcomeEvidence(db, id(124))).toBeNull();

		recordOutcomeEvidence(
			db,
			explicitFeedbackEvidence({
				evidenceId: id(119),
				observedAt: OBSERVED_AT,
				producer: "feedback-action",
				producerVersion: "v1",
				feedback: "helpful",
				actionId: "feedback-119",
				gate: "structured_action",
			}),
		);
		db.prepare("UPDATE outcome_evidence SET status = 'fail' WHERE evidence_id = ?").run(id(119));
		expect(getOutcomeEvidence(db, id(119))).toBeNull();

		const corruptions = [
			["UPDATE outcome_evidence SET producer = 'not a stable code' WHERE evidence_id = ?", 95],
			[
				"UPDATE outcome_evidence SET producer_version = 'not a stable version' WHERE evidence_id = ?",
				96,
			],
			["UPDATE outcome_evidence SET observed_at = 'not-a-timestamp' WHERE evidence_id = ?", 97],
			[
				"UPDATE outcome_evidence SET window_start_at = '2026-08-03T12:00:00.000Z', window_end_at = '2026-08-03T11:59:59.999Z' WHERE evidence_id = ?",
				98,
			],
			["UPDATE outcome_evidence SET source = NULL WHERE evidence_id = ?", 99],
			["UPDATE outcome_evidence SET source = 'not a stable source' WHERE evidence_id = ?", 100],
			["UPDATE outcome_evidence SET prompt_number = -1 WHERE evidence_id = ?", 101],
			[
				"UPDATE outcome_evidence SET raw_event_start_seq = 10, raw_event_end_seq = 9 WHERE evidence_id = ?",
				102,
			],
			[
				"UPDATE outcome_evidence SET experiment_cell_id = 'cell-a', experiment_id = NULL WHERE evidence_id = ?",
				103,
			],
			["UPDATE outcome_evidence SET retention_pinned = 2 WHERE evidence_id = ?", 104],
			[
				"UPDATE outcome_evidence SET retention_until = '2026-08-11T12:00:00.001Z' WHERE evidence_id = ?",
				105,
			],
			[
				"UPDATE outcome_evidence SET value_type = 'integer', value_integer = 1, value_real = 1, value_unit = 'count' WHERE evidence_id = ?",
				106,
			],
			[
				"UPDATE outcome_evidence SET value_type = 'integer', value_integer = 1, value_unit = 'bogus' WHERE evidence_id = ?",
				107,
			],
			[
				"UPDATE outcome_evidence SET value_type = 'integer', value_integer = -1, value_unit = 'count' WHERE evidence_id = ?",
				108,
			],
			["UPDATE outcome_evidence SET contract_version = 2 WHERE evidence_id = ?", 109],
			["UPDATE outcome_evidence SET dimension = 'efficiency' WHERE evidence_id = ?", 110],
			["UPDATE outcome_evidence SET status = 'unsupported' WHERE evidence_id = ?", 111],
			["UPDATE outcome_evidence SET references_json = '{' WHERE evidence_id = ?", 112],
			[
				"UPDATE outcome_evidence SET source_session_id = 'not a stable session' WHERE evidence_id = ?",
				113,
			],
			[
				"UPDATE outcome_evidence SET evidence_type = 'quality.unsupported' WHERE evidence_id = ?",
				114,
			],
			["UPDATE outcome_evidence SET window_start_at = 'invalid' WHERE evidence_id = ?", 115],
		] as const;
		for (const [sql, sequence] of corruptions) {
			recordOutcomeEvidence(db, check(sequence));
			db.prepare(sql).run(id(sequence));
			expect(getOutcomeEvidence(db, id(sequence))).toBeNull();
		}
		expect(queryOutcomeEvidence(db).map((evidence) => evidence.evidenceId)).toEqual([id(92)]);
	});

	it("applies query limits after discarding malformed rows across bounded batches", () => {
		recordOutcomeEvidence(db, { ...check(400), observedAt: "2026-08-03T12:00:00Z" });
		for (let sequence = 401; sequence <= 500; sequence += 1) {
			recordOutcomeEvidence(db, { ...check(sequence), observedAt: "2026-08-03T12:01:00Z" });
			db.prepare("UPDATE outcome_evidence SET producer = ? WHERE evidence_id = ?").run(
				"not a stable producer",
				id(sequence),
			);
		}
		recordOutcomeEvidence(db, { ...check(501), observedAt: "2026-08-03T12:00:30Z" });
		db.prepare("UPDATE outcome_evidence SET producer = ? WHERE evidence_id = ?").run(
			"not a stable producer",
			id(501),
		);
		db.prepare("UPDATE outcome_evidence SET evidence_id = 42 WHERE evidence_id = ?").run(id(401));

		expect(
			queryOutcomeEvidence(db, { evidenceType: "quality.test_result", limit: 1 }).map(
				(evidence) => evidence.evidenceId,
			),
		).toEqual([id(400)]);
	});

	it("discards non-text observed-at cursor keys before paginating", () => {
		recordOutcomeEvidence(db, { ...check(600), observedAt: "2026-08-03T12:00:00Z" });
		for (let sequence = 601; sequence <= 700; sequence += 1) {
			recordOutcomeEvidence(db, { ...check(sequence), observedAt: "2026-08-03T12:02:00Z" });
			db.prepare("UPDATE outcome_evidence SET observed_at = ? WHERE evidence_id = ?").run(
				Buffer.from(`malformed-observed-at-${sequence}`),
				id(sequence),
			);
		}
		for (let sequence = 701; sequence <= 800; sequence += 1) {
			recordOutcomeEvidence(db, { ...check(sequence), observedAt: "2026-08-03T12:01:00Z" });
			db.prepare("UPDATE outcome_evidence SET producer = ? WHERE evidence_id = ?").run(
				"not a stable producer",
				id(sequence),
			);
		}

		expect(
			queryOutcomeEvidence(db, { evidenceType: "quality.test_result", limit: 1 }).map(
				(evidence) => evidence.evidenceId,
			),
		).toEqual([id(600)]);
	});
});

describe("outcome evidence data boundary", () => {
	it("stays local-only and excluded from ordinary export", () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-outcome-evidence-"));
		const dbPath = join(dir, "ledger.sqlite");
		const db = new Database(dbPath);
		try {
			seed(db);
			const replicationBefore = db.prepare("SELECT count(*) FROM replication_ops").pluck().get();
			recordOutcomeEvidence(db, check(100));
			expect(db.prepare("SELECT count(*) FROM replication_ops").pluck().get()).toBe(
				replicationBefore,
			);
		} finally {
			db.close();
		}

		try {
			const payload = exportMemories({ dbPath, allProjects: true, includeInactive: true });
			expect(payload).not.toHaveProperty("outcome_evidence");
			expect(JSON.stringify(payload)).not.toContain(id(100));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
