import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAdditiveSchemaCompatibility, SCHEMA_VERSION } from "./db.js";
import { exportMemories } from "./export-import.js";
import {
	DEFAULT_RETRIEVAL_LEDGER_RETENTION_DAYS,
	finalizeRetrievalAttemptRetention,
	getRetrievalAttempt,
	hashRetrievalQuery,
	MAX_RETRIEVAL_DIAGNOSTIC_EXPOSURES,
	MAX_RETRIEVAL_JSON_BYTES,
	MAX_RETRIEVAL_QUERY_LIMIT,
	MAX_RETRIEVAL_SELECTED_EXPOSURES,
	purgeExpiredRetrievalAttempts,
	purgeRetrievalAttemptsForPrivacy,
	queryRetrievalAttempts,
	type RecordRetrievalAttemptInput,
	type RetrievalDeliveryStatus,
	type RetrievalExposureInput,
	type RetrievalStatus,
	reconcileFailedRetrievalAttempt,
	recordRetrievalAttempt,
	tryFinalizeRetrievalAttemptRetention,
	tryRecordRetrievalAttempt,
	tryUpdateRetrievalDelivery,
	updateRetrievalDelivery,
} from "./retrieval-ledger.js";
import { recordRetrievalSurface, sanitizeRetrievalFilters } from "./retrieval-surface-ledger.js";
import { ensureRetrievalLedgerSchema } from "./schema-bootstrap.js";
import { MemoryStore } from "./store.js";
import { TEST_SCHEMA_BASE_DDL } from "./test-schema.generated.js";
import { initTestSchema } from "./test-utils.js";
import type { MemoryFilters } from "./types.js";

const STARTED_AT = "2026-08-03T10:00:00.000Z";

function attemptId(sequence: number): string {
	return `018f2db4-f9d3-7a22-8d18-${sequence.toString(16).padStart(12, "0")}`;
}

function selectedExposures(count: number): RetrievalExposureInput[] {
	return Array.from({ length: count }, (_, index) => ({
		rank: index + 1,
		disposition: "selected" as const,
		handoffStatus: "not_attempted" as const,
		memoryImportKey: `selected-${index + 1}`,
	}));
}

function diagnosticExposures(count: number, rankOffset = 0): RetrievalExposureInput[] {
	return Array.from({ length: count }, (_, index) => ({
		rank: rankOffset + index + 1,
		disposition: "dropped" as const,
		handoffStatus: "not_attempted" as const,
		memoryImportKey: `diagnostic-${index + 1}`,
	}));
}

function filterSummaryAtBytes(targetBytes: number): { include_scope_ids: string[] } {
	const include_scope_ids = Array.from({ length: 40 }, () => "x");
	let cursor = 0;
	while (Buffer.byteLength(JSON.stringify({ include_scope_ids }), "utf8") < targetBytes) {
		const value = include_scope_ids[cursor];
		if (value == null) throw new Error("filter summary cursor escaped its bounded array");
		if (value.length >= 512) {
			cursor = (cursor + 1) % include_scope_ids.length;
			continue;
		}
		include_scope_ids[cursor] = `${value}x`;
		cursor = (cursor + 1) % include_scope_ids.length;
	}
	if (Buffer.byteLength(JSON.stringify({ include_scope_ids }), "utf8") !== targetBytes) {
		throw new Error(`could not construct ${targetBytes}-byte filter summary`);
	}
	return { include_scope_ids };
}

function withDelivery(
	deliveryStatus: RetrievalDeliveryStatus,
	overrides: Partial<RecordRetrievalAttemptInput> = {},
): RecordRetrievalAttemptInput {
	const base = input(overrides);
	return {
		...base,
		deliveryStatus,
		exposures: base.exposures.map((exposure) =>
			exposure.disposition === "selected"
				? { ...exposure, handoffStatus: deliveryStatus }
				: exposure,
		),
	};
}

function input(overrides: Partial<RecordRetrievalAttemptInput> = {}): RecordRetrievalAttemptInput {
	return {
		attemptId: "018f2db4-f9d3-7a22-8d18-d92a968cb111",
		surface: "prompt_pack",
		trigger: "explicit",
		startedAt: STARTED_AT,
		completedAt: "2026-08-03T10:00:00.025Z",
		retrievalStatus: "succeeded",
		deliveryStatus: "not_attempted",
		candidateCount: 3,
		selectedCount: 1,
		recorderVersion: "core-test/1",
		sessionId: 1,
		source: "opencode",
		streamId: "stream-1",
		requestId: "request-1",
		latencyMs: 25,
		project: "codemem",
		workingSetFileCount: 1,
		workingSetFiles: ["packages/core/src/store.ts"],
		...hashRetrievalQuery("fix the store"),
		filterSummary: { project: "codemem", include_scope_ids: ["local-default"] },
		traceVersion: 1,
		exposures: [
			{
				memoryId: 10,
				memoryImportKey: "memory-10",
				rank: 1,
				disposition: "selected",
				section: "summary",
				handoffStatus: "not_attempted",
				memoryRev: 2,
				memoryUpdatedAt: STARTED_AT,
				memoryKind: "decision",
				memoryActive: true,
				scoreSummary: { combined_score: 0.8, recency: 0.2 },
				reasonCodes: ["ranked.high"],
			},
			{
				memoryId: null,
				memoryImportKey: "diagnostic-11",
				rank: 2,
				disposition: "dropped",
				handoffStatus: "not_attempted",
				reasonCodes: ["budget.exceeded"],
			},
		],
		...overrides,
	};
}

function seed(db: Database.Database): void {
	initTestSchema(db);
	db.pragma("foreign_keys = ON");
	db.prepare(
		"INSERT INTO sessions(id, started_at, project, tool_version) VALUES (1, ?, 'codemem', 'test')",
	).run(STARTED_AT);
	db.prepare(
		"INSERT INTO sessions(id, started_at, project, tool_version) VALUES (2, ?, 'other', 'test')",
	).run(STARTED_AT);
	db.prepare(
		`INSERT INTO memory_items(
			id, session_id, kind, title, body_text, active, created_at, updated_at, rev, import_key
		) VALUES (10, 1, 'decision', 'Ledger fixture', 'snapshot source', 1, ?, ?, 2, 'memory-10')`,
	).run(STARTED_AT, STARTED_AT);
}

function removeDeletedAtForLegacyLedgerSchema(db: Database.Database): void {
	db.exec(`
		DROP TABLE IF EXISTS attribution_assessment_evidence;
		DROP TABLE IF EXISTS attribution_assessments;
		DROP TRIGGER trg_retrieval_exposures_detach_deleted_memory;
		DROP TRIGGER trg_retrieval_exposures_detach_unavailable_memory;
		DROP TRIGGER trg_retrieval_exposures_detach_reused_memory_id;
		DROP TABLE retrieval_exposures;
		DROP TABLE retrieval_attempts;
		ALTER TABLE memory_items DROP COLUMN deleted_at;
	`);
}

function ledgerSchemaSnapshot(db: Database.Database) {
	const tables = ["retrieval_attempts", "retrieval_exposures"] as const;
	return {
		tables: db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('retrieval_attempts', 'retrieval_exposures') ORDER BY name",
			)
			.pluck()
			.all(),
		columns: Object.fromEntries(
			tables.map((table) => [
				table,
				(db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>).map(
					(row) => ({
						name: row.name,
						type: String(row.type).toUpperCase(),
						notnull: row.notnull,
						dflt_value: row.dflt_value,
						pk: row.pk,
					}),
				),
			]),
		),
		foreignKeys: Object.fromEntries(
			tables.map((table) => [
				table,
				(db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<Record<string, unknown>>)
					.map((row) => ({
						table: row.table,
						from: row.from,
						to: row.to,
						onDelete: row.on_delete,
					}))
					.sort((a, b) => String(a.from).localeCompare(String(b.from))),
			]),
		),
		indexes: db
			.prepare(
				`SELECT name, tbl_name FROM sqlite_master
				 WHERE type = 'index'
				   AND tbl_name IN ('retrieval_attempts', 'retrieval_exposures')
				   AND name NOT LIKE 'sqlite_autoindex%'
				 ORDER BY name`,
			)
			.all()
			.map((index) => {
				const row = index as { name: string; tbl_name: string };
				const detail = db.prepare(`PRAGMA index_list(${row.tbl_name})`).all() as Array<{
					name: string;
					unique: number;
					partial: number;
				}>;
				return {
					...row,
					unique: detail.find((entry) => entry.name === row.name)?.unique,
					partial: detail.find((entry) => entry.name === row.name)?.partial,
					columns: db.prepare(`PRAGMA index_info(${row.name})`).all(),
				};
			}),
		triggers: db
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_retrieval_exposures_detach_%' ORDER BY name",
			)
			.all(),
	};
}

describe("retrieval attribution ledger", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = new Database(":memory:");
		seed(db);
	});

	afterEach(() => db.close());

	it("bootstraps the additive schema and records bounded typed attempt data", () => {
		expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
		expect(TEST_SCHEMA_BASE_DDL).toContain("CREATE TABLE IF NOT EXISTS `retrieval_attempts`");
		expect(TEST_SCHEMA_BASE_DDL).toContain("CREATE TABLE IF NOT EXISTS `retrieval_exposures`");
		expect(TEST_SCHEMA_BASE_DDL).toContain(
			"CREATE INDEX IF NOT EXISTS `idx_retrieval_attempts_experiment_cell`",
		);
		const result = recordRetrievalAttempt(db, input());

		expect(result.inserted).toBe(true);
		expect(result.attempt).toMatchObject({
			attemptId: "018f2db4-f9d3-7a22-8d18-d92a968cb111",
			contractVersion: 1,
			candidateCount: 3,
			selectedCount: 1,
			persistedCandidateCount: 2,
			workingSetFiles: ["packages/core/src/store.ts"],
			filterSummary: { project: "codemem", include_scope_ids: ["local-default"] },
		});
		expect(result.attempt.queryHashSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(result.attempt.retentionUntil).toBe("2026-11-01T10:00:00.000Z");
		expect(result.attempt.retentionFinalizedAt).toBeNull();
		expect(DEFAULT_RETRIEVAL_LEDGER_RETENTION_DAYS).toBe(90);
		expect(result.attempt.exposures[0]).toMatchObject({
			memoryId: 10,
			memoryRev: 2,
			memoryKind: "decision",
			scoreSummary: { combined_score: 0.8, recency: 0.2 },
			reasonCodes: ["ranked.high"],
		});
	});

	it("indexes randomized experiment-cell attempt lookup on fresh schemas", () => {
		const columns = db
			.prepare("PRAGMA index_info(idx_retrieval_attempts_experiment_cell)")
			.all()
			.map((row) => (row as { name: string }).name);
		expect(columns).toEqual(["experiment_id", "experiment_cell_id"]);

		const plan = db
			.prepare(
				`EXPLAIN QUERY PLAN
				 SELECT attempt_id FROM retrieval_attempts
				 WHERE experiment_id = ? AND experiment_cell_id = ?
				 ORDER BY attempt_id`,
			)
			.all("experiment-1", "cell-control") as Array<{ detail: string }>;
		expect(
			plan.some(({ detail }) => detail.includes("idx_retrieval_attempts_experiment_cell")),
		).toBe(true);
	});

	it("persists every retrieval and delivery status", () => {
		const retrievalStatuses: RetrievalStatus[] = [
			"succeeded",
			"no_results",
			"skipped",
			"failed",
			"unknown",
		];
		for (const [index, retrievalStatus] of retrievalStatuses.entries()) {
			const candidateCount = retrievalStatus === "succeeded" ? 1 : 0;
			const recorded = recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(100 + index),
					requestId: `retrieval-status-${retrievalStatus}`,
					retrievalStatus,
					candidateCount,
					selectedCount: 0,
					exposures: [],
				}),
			);
			expect(recorded.attempt.retrievalStatus).toBe(retrievalStatus);
		}

		const deliveryStatuses: RetrievalDeliveryStatus[] = [
			"not_attempted",
			"handed_off",
			"failed",
			"unknown",
		];
		for (const [index, deliveryStatus] of deliveryStatuses.entries()) {
			const recorded = recordRetrievalAttempt(
				db,
				withDelivery(deliveryStatus, {
					attemptId: attemptId(200 + index),
					requestId: `delivery-status-${deliveryStatus}`,
				}),
			);
			expect(recorded.attempt.deliveryStatus).toBe(deliveryStatus);
			expect(recorded.attempt.exposures[0]?.handoffStatus).toBe(deliveryStatus);
		}
	});

	it("requires no-results attempts to be empty and undelivered", () => {
		const valid = recordRetrievalAttempt(
			db,
			input({
				attemptId: attemptId(220),
				requestId: "no-results-empty",
				retrievalStatus: "no_results",
				candidateCount: 0,
				selectedCount: 0,
				exposures: [],
			}),
		);
		expect(valid.attempt).toMatchObject({
			retrievalStatus: "no_results",
			deliveryStatus: "not_attempted",
			candidateCount: 0,
			selectedCount: 0,
			exposures: [],
		});

		expect(() =>
			recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(221),
					requestId: "no-results-candidates",
					retrievalStatus: "no_results",
					candidateCount: 1,
					selectedCount: 0,
					exposures: [],
				}),
			),
		).toThrow(/no_results requires/);
		expect(() =>
			recordRetrievalAttempt(
				db,
				withDelivery("handed_off", {
					attemptId: attemptId(222),
					requestId: "no-results-handoff",
					retrievalStatus: "no_results",
				}),
			),
		).toThrow(/no_results requires/);
	});

	it("rejects succeeded attempts without candidates as typed invalid input", () => {
		const emptySucceeded = input({
			attemptId: attemptId(225),
			requestId: "empty-succeeded",
			retrievalStatus: "succeeded",
			candidateCount: 0,
			selectedCount: 0,
			exposures: [],
		});

		expect(() => recordRetrievalAttempt(db, emptySucceeded)).toThrow(
			/succeeded retrieval requires at least one candidate/,
		);
		expect(tryRecordRetrievalAttempt(db, emptySucceeded)).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "invalid_input",
		});
		expect(
			recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(226),
					requestId: "one-candidate-succeeded",
					candidateCount: 1,
					selectedCount: 0,
					exposures: [],
				}),
			).attempt,
		).toMatchObject({ retrievalStatus: "succeeded", candidateCount: 1, selectedCount: 0 });
	});

	it("requires a selected result before recording attempted delivery", () => {
		for (const [index, deliveryStatus] of (
			["handed_off", "failed", "unknown"] as const
		).entries()) {
			const attemptedDelivery = input({
				attemptId: attemptId(227 + index),
				requestId: `empty-delivery-${deliveryStatus}`,
				deliveryStatus,
				candidateCount: 1,
				selectedCount: 0,
				exposures: [],
			});

			expect(() => recordRetrievalAttempt(db, attemptedDelivery)).toThrow(
				/deliveryStatus requires selectedCount to be greater than zero/,
			);
			expect(tryRecordRetrievalAttempt(db, attemptedDelivery)).toEqual({
				ok: false,
				errorCode: "retrieval_ledger_write_failed",
				reason: "invalid_input",
			});
		}
	});

	it("requires failed retrievals to remain empty and undelivered", () => {
		const validFailure = input({
			attemptId: attemptId(235),
			requestId: "failed-retrieval-empty",
			retrievalStatus: "failed",
			deliveryStatus: "not_attempted",
			candidateCount: 1,
			selectedCount: 0,
			exposures: [],
			failureCode: "backend_unavailable",
			failureStage: "retrieve",
		});
		expect(recordRetrievalAttempt(db, validFailure).attempt).toMatchObject({
			retrievalStatus: "failed",
			deliveryStatus: "not_attempted",
			candidateCount: 1,
			selectedCount: 0,
			exposures: [],
			failureCode: "backend_unavailable",
			failureStage: "retrieve",
		});
		expect(recordRetrievalAttempt(db, validFailure).inserted).toBe(false);

		const selected = input().exposures[0];
		if (selected == null) throw new Error("fixture must contain a selected exposure");
		const invalidFailures = [
			withDelivery("handed_off", {
				attemptId: attemptId(236),
				requestId: "failed-retrieval-handed-off",
				retrievalStatus: "failed",
			}),
			withDelivery("failed", {
				attemptId: attemptId(237),
				requestId: "failed-retrieval-delivery-failed",
				retrievalStatus: "failed",
			}),
			input({
				attemptId: attemptId(238),
				requestId: "failed-retrieval-selected",
				retrievalStatus: "failed",
				candidateCount: 1,
				selectedCount: 1,
				exposures: [{ ...selected, handoffStatus: "not_attempted" }],
			}),
			input({
				attemptId: attemptId(239),
				requestId: "failed-retrieval-diagnostic",
				retrievalStatus: "failed",
				candidateCount: 1,
				selectedCount: 0,
				exposures: diagnosticExposures(1),
			}),
		];
		for (const invalidFailure of invalidFailures) {
			expect(() => recordRetrievalAttempt(db, invalidFailure)).toThrow(
				/failed retrieval requires zero selections, no exposures, and no delivery attempt/,
			);
			expect(tryRecordRetrievalAttempt(db, invalidFailure)).toEqual({
				ok: false,
				errorCode: "retrieval_ledger_write_failed",
				reason: "invalid_input",
			});
			expect(getRetrievalAttempt(db, invalidFailure.attemptId)).toBeNull();
		}

		const adapterFailure = recordRetrievalAttempt(
			db,
			withDelivery("failed", {
				attemptId: attemptId(240),
				requestId: "successful-retrieval-adapter-failure",
				retrievalStatus: "succeeded",
			}),
		).attempt;
		expect(adapterFailure).toMatchObject({
			retrievalStatus: "succeeded",
			deliveryStatus: "failed",
			selectedCount: 1,
			exposures: [{ disposition: "selected", handoffStatus: "failed" }, expect.any(Object)],
		});
	});

	it("requires skipped attempts to be empty and undelivered", () => {
		const skipped = input({
			attemptId: attemptId(223),
			requestId: "skipped-empty",
			retrievalStatus: "skipped",
			candidateCount: 0,
			selectedCount: 0,
			exposures: [],
		});
		const valid = recordRetrievalAttempt(db, skipped);
		expect(valid.attempt).toMatchObject({
			retrievalStatus: "skipped",
			deliveryStatus: "not_attempted",
			candidateCount: 0,
			selectedCount: 0,
			exposures: [],
		});

		expect(() =>
			recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(224),
					requestId: "skipped-candidates",
					retrievalStatus: "skipped",
				}),
			),
		).toThrow(/skipped requires/);
		expect(() => updateRetrievalDelivery(db, skipped.attemptId, "handed_off")).toThrow(
			/a skipped retrieval attempt cannot transition delivery status/,
		);
		expect(tryUpdateRetrievalDelivery(db, skipped.attemptId, "failed")).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_delivery_write_failed",
			reason: "invalid_input",
		});
		expect(getRetrievalAttempt(db, skipped.attemptId)?.deliveryStatus).toBe("not_attempted");
	});

	it("migrates a version-16 database additively and idempotently", () => {
		db.exec(
			"DROP TABLE attribution_assessment_evidence; DROP TABLE attribution_assessments; DROP TABLE retrieval_exposures; DROP TABLE retrieval_attempts;",
		);
		db.pragma("user_version = 16");
		db.exec(`
			CREATE TABLE IF NOT EXISTS schema_compat_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				applied_schema_version INTEGER NOT NULL,
				applied_at TEXT NOT NULL
			);
			INSERT OR REPLACE INTO schema_compat_state VALUES (1, 16, '${STARTED_AT}');
		`);

		ensureAdditiveSchemaCompatibility(db);
		ensureAdditiveSchemaCompatibility(db);

		expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('retrieval_attempts', 'retrieval_exposures') ORDER BY name",
				)
				.pluck()
				.all(),
		).toEqual(["retrieval_attempts", "retrieval_exposures"]);
		expect(
			db
				.prepare(
					"SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_retrieval_attempts_%'",
				)
				.pluck()
				.get(),
		).toBe(7);
		expect(
			db
				.prepare(
					"SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_retrieval_exposures_detach_%'",
				)
				.pluck()
				.get(),
		).toBe(3);
		expect(recordRetrievalAttempt(db, input()).inserted).toBe(true);
	});

	it("repairs legacy memory schemas before installing ledger triggers", () => {
		removeDeletedAtForLegacyLedgerSchema(db);

		ensureRetrievalLedgerSchema(db);
		ensureRetrievalLedgerSchema(db);

		expect(
			db
				.prepare("SELECT name FROM pragma_table_info('memory_items') WHERE name = 'deleted_at'")
				.pluck()
				.get(),
		).toBe("deleted_at");
		expect(
			db.prepare("SELECT deleted_at FROM memory_items WHERE id = 10").pluck().get(),
		).toBeNull();

		const recorded = recordRetrievalAttempt(db, input());
		expect(recorded.attempt.exposures[0]).toMatchObject({
			memoryId: 10,
			memoryImportKey: "memory-10",
			memoryRev: 2,
			memoryActive: true,
		});
		const delivered = updateRetrievalDelivery(db, input().attemptId, "handed_off");
		expect(delivered.attempt.exposures[0]).toMatchObject({
			memoryId: 10,
			memoryImportKey: "memory-10",
			memoryRev: 2,
			memoryActive: true,
			handoffStatus: "handed_off",
		});

		db.prepare("UPDATE memory_items SET active = 0 WHERE id = 10").run();
		expect(getRetrievalAttempt(db, input().attemptId)?.exposures[0]).toMatchObject({
			memoryId: null,
			memoryImportKey: "memory-10",
			memoryRev: 2,
			memoryActive: true,
			handoffStatus: "handed_off",
		});
	});

	it("keeps repeated ledger ensure a no-op for the modern memory schema", () => {
		db.prepare("UPDATE memory_items SET active = 0, deleted_at = ? WHERE id = 10").run(STARTED_AT);

		ensureRetrievalLedgerSchema(db);
		ensureRetrievalLedgerSchema(db);

		expect(db.prepare("SELECT deleted_at FROM memory_items WHERE id = 10").pluck().get()).toBe(
			STARTED_AT,
		);
		const recorded = recordRetrievalAttempt(
			db,
			input({
				exposures: input().exposures.map((exposure, index) =>
					index === 0
						? { ...exposure, memoryActive: false, memoryDeletedAt: STARTED_AT }
						: exposure,
				),
			}),
		);
		expect(recorded.attempt.exposures[0]).toMatchObject({
			memoryId: null,
			memoryImportKey: "memory-10",
			memoryActive: false,
			memoryDeletedAt: STARTED_AT,
		});
	});

	it("repairs missing ledger indexes and the handwritten trigger when tables already exist", () => {
		db.exec(`
			DROP INDEX idx_retrieval_attempts_started;
			DROP INDEX idx_retrieval_attempts_experiment_cell;
			DROP INDEX idx_retrieval_exposures_memory;
			DROP TRIGGER trg_retrieval_exposures_detach_deleted_memory;
			DROP TRIGGER trg_retrieval_exposures_detach_unavailable_memory;
			DROP TRIGGER trg_retrieval_exposures_detach_reused_memory_id;
			CREATE TRIGGER trg_retrieval_exposures_detach_unavailable_memory
			AFTER INSERT ON retrieval_exposures
			WHEN NEW.memory_id IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM memory_items
				WHERE id = NEW.memory_id AND active != 0 AND deleted_at IS NULL
			)
			BEGIN
				UPDATE retrieval_exposures SET memory_id = NULL WHERE exposure_id = NEW.exposure_id;
			END;
		`);

		ensureRetrievalLedgerSchema(db);
		ensureRetrievalLedgerSchema(db);

		for (const name of [
			"idx_retrieval_attempts_started",
			"idx_retrieval_attempts_experiment_cell",
			"idx_retrieval_exposures_memory",
			"trg_retrieval_exposures_detach_deleted_memory",
			"trg_retrieval_exposures_detach_unavailable_memory",
			"trg_retrieval_exposures_detach_reused_memory_id",
		]) {
			expect(
				db.prepare("SELECT count(*) FROM sqlite_master WHERE name = ?").pluck().get(name),
			).toBe(1);
		}
		const repairedTriggerSql = db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_retrieval_exposures_detach_unavailable_memory'",
			)
			.pluck()
			.get();
		expect(repairedTriggerSql).toContain("NEW.memory_import_key = import_key");
		expect(repairedTriggerSql).toContain("NEW.memory_rev = rev");
		expect(
			db
				.prepare("PRAGMA index_info(idx_retrieval_attempts_experiment_cell)")
				.all()
				.map((row) => (row as { name: string }).name),
		).toEqual(["experiment_id", "experiment_cell_id"]);
	});

	it.each([
		"import_key",
		"origin_device_id",
	])("skips additive ledger DDL when a legacy memory schema lacks %s", (missingColumn) => {
		const legacy = new Database(":memory:");
		try {
			legacy.exec(`
					CREATE TABLE sessions (id INTEGER PRIMARY KEY);
					CREATE TABLE memory_items (
						id INTEGER PRIMARY KEY,
						active INTEGER NOT NULL DEFAULT 1,
						deleted_at TEXT,
						${missingColumn === "import_key" ? "origin_device_id" : "import_key"} TEXT
					);
				`);

			expect(() => ensureRetrievalLedgerSchema(legacy)).not.toThrow();
			expect(
				legacy
					.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'retrieval_attempts'")
					.pluck()
					.get(),
			).toBe(0);
		} finally {
			legacy.close();
		}
	});

	it("adds nullable ledger columns to an existing ledger without rewriting rows", () => {
		recordRetrievalAttempt(db, input());
		db.exec(`
			ALTER TABLE retrieval_attempts DROP COLUMN evaluation_checkout_id;
			ALTER TABLE retrieval_attempts DROP COLUMN evaluation_fixture_id;
			ALTER TABLE retrieval_attempts DROP COLUMN evaluation_seed;
			ALTER TABLE retrieval_attempts DROP COLUMN retention_finalized_at;
		`);

		ensureRetrievalLedgerSchema(db);

		const columns = db
			.prepare("PRAGMA table_info(retrieval_attempts)")
			.all()
			.map((row) => (row as { name: string }).name);
		expect(columns).toEqual(
			expect.arrayContaining([
				"evaluation_checkout_id",
				"evaluation_fixture_id",
				"evaluation_seed",
				"retention_finalized_at",
			]),
		);
		expect(getRetrievalAttempt(db, input().attemptId)).toMatchObject({
			evaluationCheckoutId: null,
			evaluationFixtureId: null,
			evaluationSeed: null,
			retentionFinalizedAt: null,
		});
	});

	it("keeps fresh bootstrap and legacy migration ledger schemas in parity", () => {
		const fresh = new Database(":memory:");
		const legacy = new Database(":memory:");
		try {
			initTestSchema(fresh);
			initTestSchema(legacy);
			legacy.exec(`
				DROP TABLE attribution_assessment_evidence;
				DROP TABLE attribution_assessments;
				DROP TRIGGER trg_retrieval_exposures_detach_deleted_memory;
				DROP TRIGGER trg_retrieval_exposures_detach_reused_memory_id;
				DROP TABLE retrieval_exposures;
				DROP TABLE retrieval_attempts;
			`);
			legacy.pragma("user_version = 16");
			ensureAdditiveSchemaCompatibility(legacy);

			expect(ledgerSchemaSnapshot(legacy)).toEqual(ledgerSchemaSnapshot(fresh));
		} finally {
			fresh.close();
			legacy.close();
		}
	});

	it("makes exact writes, request retries, and delivery retries idempotent", () => {
		expect(recordRetrievalAttempt(db, input()).inserted).toBe(true);
		expect(recordRetrievalAttempt(db, input()).inserted).toBe(false);

		const delivered = updateRetrievalDelivery(
			db,
			"018f2db4-f9d3-7a22-8d18-d92a968cb111",
			"handed_off",
		);
		expect(delivered).toMatchObject({ changed: true, attempt: { deliveryStatus: "handed_off" } });
		expect(delivered.attempt.exposures.map((exposure) => exposure.handoffStatus)).toEqual([
			"handed_off",
			"not_attempted",
		]);
		expect(updateRetrievalDelivery(db, input().attemptId, "handed_off").changed).toBe(false);
		expect(recordRetrievalAttempt(db, input()).inserted).toBe(false);
		expect(() =>
			recordRetrievalAttempt(db, input({ attemptId: "018f2db4-f9d3-7a22-8d18-d92a968cb222" })),
		).toThrow(/request identity/);
	});

	it("keeps original failed and unknown delivery payloads idempotent after handoff", () => {
		for (const [index, deliveryStatus] of (["failed", "unknown"] as const).entries()) {
			const original = withDelivery(deliveryStatus, {
				attemptId: attemptId(930 + index),
				requestId: `delivery-advance-${deliveryStatus}`,
			});
			expect(recordRetrievalAttempt(db, original).inserted).toBe(true);
			expect(updateRetrievalDelivery(db, original.attemptId, "handed_off")).toMatchObject({
				changed: true,
				attempt: { deliveryStatus: "handed_off" },
			});
			expect(recordRetrievalAttempt(db, original).inserted).toBe(false);
		}

		const conflicting = withDelivery("failed", {
			attemptId: attemptId(930),
			requestId: "delivery-advance-failed",
			recorderVersion: "conflicting-version",
		});
		expect(() => recordRetrievalAttempt(db, conflicting)).toThrow(/retry conflicts/);
	});

	it("keeps exact retries idempotent across failed and unknown delivery transitions", () => {
		for (const [index, [originalStatus, nextStatus]] of (
			[
				["failed", "unknown"],
				["unknown", "failed"],
			] as const
		).entries()) {
			const original = withDelivery(originalStatus, {
				attemptId: attemptId(940 + index),
				requestId: `delivery-retry-${originalStatus}-to-${nextStatus}`,
			});
			expect(recordRetrievalAttempt(db, original).inserted).toBe(true);
			expect(updateRetrievalDelivery(db, original.attemptId, nextStatus)).toMatchObject({
				changed: true,
				attempt: { deliveryStatus: nextStatus },
			});
			expect(recordRetrievalAttempt(db, original).inserted).toBe(false);
		}

		const snapshotConflict = withDelivery("failed", {
			attemptId: attemptId(940),
			requestId: "delivery-retry-failed-to-unknown",
			exposures: withDelivery("failed").exposures.map((exposure, index) =>
				index === 0 ? { ...exposure, memoryRev: 3 } : exposure,
			),
		});
		expect(() => recordRetrievalAttempt(db, snapshotConflict)).toThrow(/retry conflicts/);
	});

	it("rejects retries when persisted delivery contradicts an empty selection", () => {
		const original = input({
			attemptId: attemptId(942),
			requestId: "invalid-persisted-delivery-retry",
			candidateCount: 1,
			selectedCount: 0,
			exposures: [],
		});
		recordRetrievalAttempt(db, original);
		db.prepare("UPDATE retrieval_attempts SET delivery_status = 'failed' WHERE attempt_id = ?").run(
			original.attemptId,
		);

		expect(() => recordRetrievalAttempt(db, original)).toThrow(
			/deliveryStatus requires selectedCount to be greater than zero/,
		);
		expect(tryRecordRetrievalAttempt(db, original)).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "invalid_input",
		});
	});

	it("rejects retries and delivery updates for tampered failed retrievals", () => {
		const failed = input({
			attemptId: attemptId(943),
			requestId: "tampered-failed-retrieval",
			retrievalStatus: "failed",
			candidateCount: 1,
			selectedCount: 0,
			exposures: [],
		});
		recordRetrievalAttempt(db, failed);
		db.prepare("UPDATE retrieval_attempts SET selected_count = 1 WHERE attempt_id = ?").run(
			failed.attemptId,
		);

		expect(() => recordRetrievalAttempt(db, failed)).toThrow(
			/failed retrieval requires zero selections, no exposures, and no delivery attempt/,
		);
		expect(tryRecordRetrievalAttempt(db, failed)).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "invalid_input",
		});
		for (const deliveryStatus of ["handed_off", "failed", "unknown"] as const) {
			expect(() => updateRetrievalDelivery(db, failed.attemptId, deliveryStatus)).toThrow(
				/a failed retrieval attempt cannot transition delivery status/,
			);
		}
		expect(tryUpdateRetrievalDelivery(db, failed.attemptId, "failed")).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_delivery_write_failed",
			reason: "invalid_input",
		});

		const deliveryTampered = {
			...failed,
			attemptId: attemptId(944),
			requestId: "delivery-tampered-failed-retrieval",
		};
		recordRetrievalAttempt(db, deliveryTampered);
		db.prepare("UPDATE retrieval_attempts SET delivery_status = 'failed' WHERE attempt_id = ?").run(
			deliveryTampered.attemptId,
		);
		expect(() => recordRetrievalAttempt(db, deliveryTampered)).toThrow(
			/failed retrieval requires zero selections, no exposures, and no delivery attempt/,
		);
		expect(tryRecordRetrievalAttempt(db, deliveryTampered)).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "invalid_input",
		});
	});

	it("normalizes UUIDs and canonicalizes exposure order for case-insensitive retries", () => {
		const mixedCaseId = "018F2DB4-F9D3-7A22-8D18-D92A968CB444";
		const base = input({ attemptId: mixedCaseId, requestId: "case-retry" });
		const reversed = [...base.exposures].reverse();
		const first = recordRetrievalAttempt(db, { ...base, exposures: reversed });

		expect(first.attempt.attemptId).toBe(mixedCaseId.toLowerCase());
		expect(first.attempt.exposures.map((exposure) => exposure.rank)).toEqual([1, 2]);
		expect(
			first.attempt.exposures.every((exposure) => exposure.attemptId === mixedCaseId.toLowerCase()),
		).toBe(true);
		expect(
			recordRetrievalAttempt(db, {
				...base,
				attemptId: mixedCaseId.toLowerCase(),
				exposures: base.exposures,
			}).inserted,
		).toBe(false);
		expect(getRetrievalAttempt(db, mixedCaseId)?.attemptId).toBe(mixedCaseId.toLowerCase());
		expect(updateRetrievalDelivery(db, mixedCaseId, "handed_off").attempt.deliveryStatus).toBe(
			"handed_off",
		);
	});

	it("uses request identity for retries but records cache reuse as a new attempt", () => {
		const first = input({ attemptId: attemptId(250), requestId: "cache-request-1" });
		const reused = input({ attemptId: attemptId(251), requestId: "cache-request-2" });
		expect(first.queryHashSha256).toBe(reused.queryHashSha256);
		expect(recordRetrievalAttempt(db, first).inserted).toBe(true);
		expect(recordRetrievalAttempt(db, first).inserted).toBe(false);
		expect(recordRetrievalAttempt(db, reused).inserted).toBe(true);
		expect(queryRetrievalAttempts(db, { source: "opencode" }).map((row) => row.attemptId)).toEqual([
			attemptId(251),
			attemptId(250),
		]);

		expect(
			recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(252),
					requestId: "cache-request-1",
					surface: "mcp_pack",
				}),
			).inserted,
		).toBe(true);
	});

	it("replaces only a matching failed request with its handed-off success", () => {
		const failed = input({
			attemptId: attemptId(253),
			requestId: "failed-request-retry",
			surface: "mcp_search",
			source: "mcp",
			retrievalStatus: "failed",
			deliveryStatus: "not_attempted",
			candidateCount: 0,
			selectedCount: 0,
			exposures: [],
			failureCode: "tool_failed",
			failureStage: "retrieval",
			retentionDays: 7,
		});
		recordRetrievalAttempt(db, failed);
		const succeeded = {
			...failed,
			startedAt: "2026-08-03T10:00:00.100Z",
			completedAt: "2026-08-03T10:00:00.250Z",
			latencyMs: 150,
			retentionDays: 7,
			retrievalStatus: "succeeded" as const,
			deliveryStatus: "handed_off" as const,
			candidateCount: 1,
			selectedCount: 1,
			failureCode: null,
			failureStage: null,
			exposures: [
				{
					rank: 1,
					disposition: "selected" as const,
					handoffStatus: "handed_off" as const,
					memoryImportKey: "retry-success",
				},
			],
		};

		expect(() =>
			reconcileFailedRetrievalAttempt(db, {
				...succeeded,
				requestId: "unrelated-request-content",
			}),
		).toThrow(/conflicts/);
		expect(() =>
			reconcileFailedRetrievalAttempt(db, {
				...succeeded,
				startedAt: "2026-08-03T09:59:59.000Z",
				completedAt: "2026-08-03T09:59:59.500Z",
			}),
		).toThrow(/conflicts/);
		expect(() =>
			reconcileFailedRetrievalAttempt(db, {
				...succeeded,
				retentionDays: 30,
			}),
		).toThrow(/conflicts/);
		expect(getRetrievalAttempt(db, failed.attemptId)?.retrievalStatus).toBe("failed");
		expect(reconcileFailedRetrievalAttempt(db, succeeded).attempt).toMatchObject({
			attemptId: failed.attemptId,
			retrievalStatus: "succeeded",
			deliveryStatus: "handed_off",
			failureCode: null,
			exposures: [{ attemptId: failed.attemptId, handoffStatus: "handed_off" }],
			startedAt: STARTED_AT,
			latencyMs: 250,
			retentionUntil: "2026-08-10T10:00:00.000Z",
		});
		expect(recordRetrievalAttempt(db, succeeded).inserted).toBe(false);
		expect(() => reconcileFailedRetrievalAttempt(db, succeeded)).toThrow(/conflicts/);
		expect(() => recordRetrievalAttempt(db, failed)).toThrow(/retry conflicts/);
		expect(getRetrievalAttempt(db, failed.attemptId)?.retrievalStatus).toBe("succeeded");
	});

	it("replaces only a matching failed request with its empty successful completion", () => {
		const failed = input({
			attemptId: attemptId(254),
			requestId: "failed-empty-request-retry",
			surface: "mcp_search",
			source: "mcp",
			retrievalStatus: "failed",
			deliveryStatus: "not_attempted",
			candidateCount: 0,
			selectedCount: 0,
			exposures: [],
			failureCode: "tool_failed",
			failureStage: "retrieval",
		});
		recordRetrievalAttempt(db, failed);
		const noResults = {
			...failed,
			completedAt: "2026-08-03T10:00:00.050Z",
			retrievalStatus: "no_results" as const,
			failureCode: null,
			failureStage: null,
		};

		expect(() =>
			reconcileFailedRetrievalAttempt(db, {
				...noResults,
				requestId: "unrelated-empty-request-content",
			}),
		).toThrow(/conflicts/);
		expect(reconcileFailedRetrievalAttempt(db, noResults).attempt).toMatchObject({
			attemptId: failed.attemptId,
			retrievalStatus: "no_results",
			deliveryStatus: "not_attempted",
			candidateCount: 0,
			selectedCount: 0,
			failureCode: null,
			exposures: [],
		});
		expect(recordRetrievalAttempt(db, noResults).inserted).toBe(false);
		expect(() => recordRetrievalAttempt(db, failed)).toThrow(/retry conflicts/);
		expect(queryRetrievalAttempts(db, { surface: "mcp_search" })).toHaveLength(1);
		expect(getRetrievalAttempt(db, failed.attemptId)?.retrievalStatus).toBe("no_results");
	});

	it("keeps missing session and source correlation null", () => {
		const recorded = recordRetrievalAttempt(
			db,
			input({
				attemptId: attemptId(260),
				sessionId: undefined,
				source: undefined,
				streamId: undefined,
				sourceSessionId: undefined,
				requestId: undefined,
			}),
		).attempt;
		expect(recorded).toMatchObject({
			sessionId: null,
			source: null,
			streamId: null,
			sourceSessionId: null,
			requestId: null,
		});
	});

	it("requires source whenever streamId is recorded", () => {
		const streamWithoutSource = input({
			attemptId: attemptId(261),
			source: undefined,
			streamId: "stream-without-source",
			requestId: undefined,
		});

		expect(() => recordRetrievalAttempt(db, streamWithoutSource)).toThrow(
			/source is required when streamId is provided/,
		);
		expect(tryRecordRetrievalAttempt(db, streamWithoutSource)).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "invalid_input",
		});
		expect(
			recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(262),
					source: "opencode",
					streamId: undefined,
					requestId: undefined,
				}),
			).attempt,
		).toMatchObject({ source: "opencode", streamId: null });
	});

	it("queries by session, source stream, surface, and time with bounded deterministic order", () => {
		const fixtures: Array<Partial<RecordRetrievalAttemptInput>> = [
			{
				attemptId: attemptId(401),
				requestId: "query-1",
				startedAt: "2026-08-03T10:00:00.000Z",
				surface: "mcp_search",
			},
			{
				attemptId: attemptId(402),
				requestId: "query-2",
				startedAt: "2026-08-03T10:05:00.000Z",
				surface: "mcp_search",
			},
			{
				attemptId: attemptId(403),
				requestId: "query-3",
				startedAt: "2026-08-03T10:05:00.000Z",
				sessionId: 2,
				source: "claude",
				streamId: "stream-2",
				surface: "mcp_pack",
			},
			{
				attemptId: attemptId(404),
				requestId: "query-4",
				startedAt: "2026-08-03T10:05:00.000Z",
				surface: "mcp_search",
			},
		];
		for (const fixture of fixtures) {
			recordRetrievalAttempt(
				db,
				input({
					...fixture,
					completedAt: fixture.startedAt,
					candidateCount: 1,
					selectedCount: 0,
					exposures: [],
				}),
			);
		}

		expect(queryRetrievalAttempts(db, { limit: 2 }).map((row) => row.attemptId)).toEqual([
			attemptId(404),
			attemptId(403),
		]);
		expect(
			queryRetrievalAttempts(db, {
				sessionId: 1,
				source: "opencode",
				streamId: "stream-1",
				surface: "mcp_search",
				startedAtOrAfter: "2026-08-03T10:04:00.000Z",
				startedAtOrBefore: "2026-08-03T10:06:00.000Z",
			}).map((row) => row.attemptId),
		).toEqual([attemptId(404), attemptId(402)]);
		expect(() => queryRetrievalAttempts(db, { streamId: "stream-1" })).toThrow(
			/source is required/,
		);
		expect(() => queryRetrievalAttempts(db, { limit: 0 })).toThrow(/limit must be/);
		expect(() => queryRetrievalAttempts(db, { limit: MAX_RETRIEVAL_QUERY_LIMIT + 1 })).toThrow(
			/limit must be/,
		);
	});

	it("accepts exactly 50 selected plus 20 diagnostics and rejects either bound plus one", () => {
		const selected = selectedExposures(MAX_RETRIEVAL_SELECTED_EXPOSURES);
		const diagnostics = diagnosticExposures(
			MAX_RETRIEVAL_DIAGNOSTIC_EXPOSURES,
			MAX_RETRIEVAL_SELECTED_EXPOSURES,
		);
		const atBoundary = recordRetrievalAttempt(
			db,
			input({
				attemptId: attemptId(300),
				requestId: "cardinality-boundary",
				candidateCount: 70,
				selectedCount: 50,
				exposures: [...selected, ...diagnostics],
			}),
		);
		expect(atBoundary.attempt.exposures).toHaveLength(70);

		expect(() =>
			recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(301),
					requestId: "selected-overflow",
					candidateCount: 51,
					selectedCount: 51,
					exposures: selectedExposures(51),
				}),
			),
		).toThrow(/selected exposures/);
		const selectedOne = input().exposures[0];
		if (selectedOne == null) throw new Error("fixture must contain a selected exposure");
		expect(() =>
			recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(302),
					requestId: "diagnostic-overflow",
					candidateCount: 22,
					selectedCount: 1,
					exposures: [selectedOne, ...diagnosticExposures(21, 1)],
				}),
			),
		).toThrow(/diagnostic exposures/);

		const persistedOverCandidateCount = input({
			attemptId: attemptId(303),
			requestId: "persisted-over-candidates",
			candidateCount: 1,
			selectedCount: 1,
		});
		expect(() => recordRetrievalAttempt(db, persistedOverCandidateCount)).toThrow(
			/persisted exposures cannot exceed candidateCount/,
		);
		expect(tryRecordRetrievalAttempt(db, persistedOverCandidateCount)).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "invalid_input",
		});
	});

	it("accepts an exposure rank at candidateCount and rejects ranks above it", () => {
		const selected = input().exposures[0];
		if (selected == null) throw new Error("fixture must contain a selected exposure");
		const atBoundary = recordRetrievalAttempt(
			db,
			input({
				attemptId: attemptId(309),
				requestId: "rank-at-candidate-count",
				candidateCount: 3,
				exposures: [{ ...selected, rank: 3 }],
			}),
		);
		expect(atBoundary.attempt.exposures[0]?.rank).toBe(3);

		expect(() =>
			recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(310),
					requestId: "rank-over-candidate-count",
					candidateCount: 3,
					exposures: [{ ...selected, rank: 4 }],
				}),
			),
		).toThrow(/exposure\.rank cannot exceed candidateCount/);
	});

	it("persists the bounded selected set when selectedCount exceeds the selected exposure cap", () => {
		const recorded = recordRetrievalAttempt(
			db,
			input({
				attemptId: attemptId(308),
				requestId: "bounded-selected-set",
				candidateCount: 55,
				selectedCount: 55,
				exposures: selectedExposures(MAX_RETRIEVAL_SELECTED_EXPOSURES),
			}),
		);

		expect(recorded.attempt).toMatchObject({
			candidateCount: 55,
			selectedCount: 55,
			persistedCandidateCount: 50,
		});
		expect(recorded.attempt.exposures).toHaveLength(50);
	});

	it("requires complete deterministic evaluation replay identity", () => {
		const replay = input({
			attemptId: attemptId(304),
			requestId: "evaluation-replay-valid",
			surface: "evaluation_replay",
			trigger: "evaluation",
			experimentId: "retrieval-study-v1",
			experimentCellId: "treatment-a",
			evaluationCheckoutId: "0123456789abcdef",
			evaluationSeed: 0,
		});
		expect(recordRetrievalAttempt(db, replay).attempt).toMatchObject({
			surface: "evaluation_replay",
			trigger: "evaluation",
			experimentId: "retrieval-study-v1",
			experimentCellId: "treatment-a",
			evaluationCheckoutId: "0123456789abcdef",
			evaluationFixtureId: null,
			evaluationSeed: 0,
			recorderVersion: "core-test/1",
		});
		expect(recordRetrievalAttempt(db, replay).inserted).toBe(false);
		expect(() => recordRetrievalAttempt(db, { ...replay, evaluationSeed: 1 })).toThrow(
			/retry conflicts/,
		);

		const requiredCases: Array<[string, Partial<RecordRetrievalAttemptInput>, RegExp]> = [
			["trigger", { trigger: "explicit" }, /requires the evaluation trigger/],
			["experiment", { experimentId: null }, /requires experimentId/],
			["experiment cell", { experimentCellId: null }, /requires experimentCellId/],
			["frozen identity", { evaluationCheckoutId: null }, /exactly one checkout or fixture/],
			[
				"one frozen identity",
				{ evaluationFixtureId: "fixture-a" },
				/exactly one checkout or fixture/,
			],
			["seed", { evaluationSeed: null }, /requires evaluationSeed/],
			["safe seed", { evaluationSeed: Number.MAX_SAFE_INTEGER + 1 }, /non-negative integer/],
			[
				"stable checkout ID",
				{ evaluationCheckoutId: "checkout with spaces" },
				/bounded stable identifier/,
			],
		];
		for (const [index, [label, overrides, pattern]] of requiredCases.entries()) {
			expect(() =>
				recordRetrievalAttempt(db, {
					...replay,
					attemptId: attemptId(400 + index),
					requestId: `invalid-replay-${label}`,
					...overrides,
				}),
			).toThrow(pattern);
		}
		expect(
			tryRecordRetrievalAttempt(db, {
				...replay,
				attemptId: attemptId(409),
				requestId: "invalid-replay-wrapper",
				evaluationSeed: null,
			}),
		).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "invalid_input",
		});

		const fixtureReplay = {
			...replay,
			attemptId: attemptId(305),
			requestId: "evaluation-fixture-valid",
			evaluationCheckoutId: null,
			evaluationFixtureId: "fixture-a.v1",
		};
		expect(recordRetrievalAttempt(db, fixtureReplay).attempt).toMatchObject({
			evaluationCheckoutId: null,
			evaluationFixtureId: "fixture-a.v1",
		});
		expect(() =>
			recordRetrievalAttempt(db, {
				...input({ attemptId: attemptId(306), requestId: "non-evaluation-fields" }),
				evaluationFixtureId: "fixture-a.v1",
				evaluationSeed: 1,
			}),
		).toThrow(/require the evaluation_replay surface/);
	});

	it("requires replay identities to be runtime strings before stable-ID validation", () => {
		const replay = input({
			surface: "evaluation_replay",
			trigger: "evaluation",
			experimentId: "retrieval-study-v1",
			experimentCellId: "treatment-a",
			evaluationSeed: 0,
		});
		const malformedIds = [123, true, ["coerced-id"], {}, null];
		let sequence = 1200;

		for (const field of ["evaluationCheckoutId", "evaluationFixtureId"] as const) {
			for (const malformedId of malformedIds) {
				const invalid = {
					...replay,
					attemptId: attemptId(sequence),
					requestId: `invalid-${field}-${sequence}`,
					evaluationCheckoutId: null,
					evaluationFixtureId: null,
					[field]: malformedId,
				} as RecordRetrievalAttemptInput;
				const expectedError =
					malformedId === null
						? /requires exactly one checkout or fixture identity/
						: new RegExp(`${field} must be a string when provided`);

				expect(() => recordRetrievalAttempt(db, invalid)).toThrow(expectedError);
				expect(tryRecordRetrievalAttempt(db, invalid)).toEqual({
					ok: false,
					errorCode: "retrieval_ledger_write_failed",
					reason: "invalid_input",
				});
				expect(
					db
						.prepare("SELECT count(*) FROM retrieval_attempts WHERE attempt_id = ?")
						.pluck()
						.get(invalid.attemptId),
				).toBe(0);
				sequence += 1;
			}
		}

		for (const [index, [field, stableId]] of (
			[
				["evaluationCheckoutId", "123"],
				["evaluationFixtureId", "true"],
			] as const
		).entries()) {
			const valid = recordRetrievalAttempt(db, {
				...replay,
				attemptId: attemptId(1220 + index),
				requestId: `valid-string-${field}`,
				evaluationCheckoutId: null,
				evaluationFixtureId: null,
				[field]: stableId,
			}).attempt;
			expect(valid[field]).toBe(stableId);
		}

		const nonReplay = recordRetrievalAttempt(
			db,
			input({ attemptId: attemptId(1222), requestId: "non-replay-without-evaluation-ids" }),
		).attempt;
		expect(nonReplay).toMatchObject({
			surface: "prompt_pack",
			evaluationCheckoutId: null,
			evaluationFixtureId: null,
		});
	});

	it("fails closed when stored replay identities are missing or malformed", () => {
		const checkoutReplay = input({
			attemptId: attemptId(1230),
			requestId: "stored-checkout-replay",
			surface: "evaluation_replay",
			trigger: "evaluation",
			experimentId: "retrieval-study-v1",
			experimentCellId: "treatment-a",
			evaluationCheckoutId: "checkout-a",
			evaluationSeed: 0,
		});
		const fixtureReplay = {
			...checkoutReplay,
			attemptId: attemptId(1231),
			requestId: "stored-fixture-replay",
			evaluationCheckoutId: null,
			evaluationFixtureId: "fixture-a",
		};
		recordRetrievalAttempt(db, checkoutReplay);
		recordRetrievalAttempt(db, fixtureReplay);

		db.prepare(
			"UPDATE retrieval_attempts SET evaluation_checkout_id = NULL WHERE attempt_id = ?",
		).run(checkoutReplay.attemptId);
		expect(getRetrievalAttempt(db, checkoutReplay.attemptId)).toBeNull();

		for (const malformedStoredId of ["checkout with spaces", Buffer.from("checkout-a")]) {
			db.prepare(
				"UPDATE retrieval_attempts SET evaluation_checkout_id = ? WHERE attempt_id = ?",
			).run(malformedStoredId, checkoutReplay.attemptId);
			expect(getRetrievalAttempt(db, checkoutReplay.attemptId)).toBeNull();
		}

		db.prepare(
			"UPDATE retrieval_attempts SET evaluation_fixture_id = NULL WHERE attempt_id = ?",
		).run(fixtureReplay.attemptId);
		expect(getRetrievalAttempt(db, fixtureReplay.attemptId)).toBeNull();
		const listedAttemptIds = queryRetrievalAttempts(db).map((attempt) => attempt.attemptId);
		expect(listedAttemptIds).not.toContain(checkoutReplay.attemptId);
		expect(listedAttemptIds).not.toContain(fixtureReplay.attemptId);
	});

	it("fails closed when stored evaluation replay correlation fields are incomplete", () => {
		const replay = input({
			surface: "evaluation_replay",
			trigger: "evaluation",
			experimentId: "retrieval-study-v1",
			experimentCellId: "treatment-a",
			evaluationCheckoutId: "checkout-a",
			evaluationSeed: 0,
		});
		const malformedCases = [
			["evaluation_seed", null],
			["experiment_id", null],
			["experiment_cell_id", null],
			["trigger", "explicit"],
		] as const;

		for (const [index, [column, value]] of malformedCases.entries()) {
			const malformed = {
				...replay,
				attemptId: attemptId(1300 + index),
				requestId: `malformed-stored-replay-${index}`,
			};
			recordRetrievalAttempt(db, malformed);
			db.prepare(`UPDATE retrieval_attempts SET ${column} = ? WHERE attempt_id = ?`).run(
				value,
				malformed.attemptId,
			);
			expect(getRetrievalAttempt(db, malformed.attemptId)).toBeNull();
		}

		const valid = {
			...replay,
			attemptId: attemptId(1304),
			requestId: "valid-stored-replay",
		};
		recordRetrievalAttempt(db, valid);
		expect(getRetrievalAttempt(db, valid.attemptId)).toMatchObject({
			trigger: "evaluation",
			experimentId: "retrieval-study-v1",
			experimentCellId: "treatment-a",
			evaluationCheckoutId: "checkout-a",
			evaluationSeed: 0,
		});

		const listedAttemptIds = queryRetrievalAttempts(db).map((attempt) => attempt.attemptId);
		for (const index of malformedCases.keys()) {
			expect(listedAttemptIds).not.toContain(attemptId(1300 + index));
		}
		expect(listedAttemptIds).toContain(valid.attemptId);
	});

	it("does not relabel or list attempts from unsupported stored contracts", () => {
		recordRetrievalAttempt(db, input());
		const supported = input({ attemptId: attemptId(307), requestId: "supported-contract" });
		recordRetrievalAttempt(db, supported);
		db.prepare("UPDATE retrieval_attempts SET contract_version = 2 WHERE attempt_id = ?").run(
			input().attemptId,
		);

		expect(getRetrievalAttempt(db, input().attemptId)).toBeNull();
		expect(queryRetrievalAttempts(db).map((attempt) => attempt.attemptId)).toEqual([
			supported.attemptId,
		]);
	});

	it("does not update delivery state for unsupported stored contracts", () => {
		const recorded = recordRetrievalAttempt(db, input());
		db.prepare("UPDATE retrieval_attempts SET contract_version = 2 WHERE attempt_id = ?").run(
			recorded.attempt.attemptId,
		);

		expect(() => updateRetrievalDelivery(db, recorded.attempt.attemptId, "handed_off")).toThrow(
			/contract version is unsupported/,
		);
		expect(
			db
				.prepare("SELECT delivery_status FROM retrieval_attempts WHERE attempt_id = ?")
				.pluck()
				.get(recorded.attempt.attemptId),
		).toBe("not_attempted");
		expect(
			db
				.prepare(
					"SELECT handoff_status FROM retrieval_exposures WHERE attempt_id = ? AND disposition = 'selected'",
				)
				.pluck()
				.all(recorded.attempt.attemptId),
		).toEqual(["not_attempted"]);
	});

	it("does not update delivery state for no-results attempts", () => {
		const noResults = input({
			attemptId: attemptId(309),
			requestId: "no-results-delivery-update",
			retrievalStatus: "no_results",
			candidateCount: 0,
			selectedCount: 0,
			exposures: [],
		});
		recordRetrievalAttempt(db, noResults);

		expect(() => updateRetrievalDelivery(db, noResults.attemptId, "handed_off")).toThrow(
			/no-results retrieval attempt cannot transition delivery status/,
		);
		expect(getRetrievalAttempt(db, noResults.attemptId)?.deliveryStatus).toBe("not_attempted");
		expect(tryUpdateRetrievalDelivery(db, noResults.attemptId, "failed")).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_delivery_write_failed",
			reason: "invalid_input",
		});
		expect(getRetrievalAttempt(db, noResults.attemptId)?.deliveryStatus).toBe("not_attempted");
	});

	it("does not update delivery state without a selected result", () => {
		const emptySelection = input({
			attemptId: attemptId(312),
			requestId: "empty-selection-delivery-update",
			candidateCount: 1,
			selectedCount: 0,
			exposures: [],
		});
		recordRetrievalAttempt(db, emptySelection);

		for (const deliveryStatus of ["handed_off", "failed", "unknown"] as const) {
			expect(() => updateRetrievalDelivery(db, emptySelection.attemptId, deliveryStatus)).toThrow(
				/deliveryStatus requires selectedCount to be greater than zero/,
			);
		}
		expect(tryUpdateRetrievalDelivery(db, emptySelection.attemptId, "failed")).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_delivery_write_failed",
			reason: "invalid_input",
		});
		expect(
			db
				.prepare("SELECT delivery_status FROM retrieval_attempts WHERE attempt_id = ?")
				.pluck()
				.get(emptySelection.attemptId),
		).toBe("not_attempted");
	});

	it("keeps returned selections beyond the persistence cap out of diagnostic rows", () => {
		const selectedIds = Array.from({ length: 55 }, (_, index) => index + 1);
		const outcome = recordRetrievalSurface(db, {
			attemptId: attemptId(303),
			surface: "mcp_get_observations",
			trigger: "explicit",
			startedAt: STARTED_AT,
			retrievalStatus: "succeeded",
			deliveryStatus: "handed_off",
			selectedIds,
			candidateIds: selectedIds,
			recorderVersion: "test",
			source: "mcp",
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.value.attempt.selectedCount).toBe(55);
		expect(outcome.value.attempt.exposures).toHaveLength(50);
		expect(outcome.value.attempt.exposures.every((row) => row.disposition === "selected")).toBe(
			true,
		);
		expect(
			outcome.value.attempt.exposures.every((row) =>
				row.reasonCodes.includes("surface.returned_truncated"),
			),
		).toBe(true);
	});

	it("drops filter strings outside the retrieval ledger bounds", () => {
		expect(
			sanitizeRetrievalFilters({
				project: "x".repeat(513),
				visibility: ["", "private", "x".repeat(513)],
			}),
		).toEqual({ visibility: ["private"] });
		expect(
			sanitizeRetrievalFilters({
				kind: 42,
				session_id: "wrong-type",
				include_scope_ids: [7],
				visibility: ["", "x".repeat(513)],
			} as unknown as MemoryFilters),
		).toBeNull();
		const byteBounded = sanitizeRetrievalFilters({
			include_scope_ids: Array.from({ length: 50 }, (_, index) => `${index}`.padEnd(512, "x")),
		});
		expect(byteBounded).not.toBeNull();
		expect(Buffer.byteLength(JSON.stringify(byteBounded), "utf8")).toBeLessThanOrEqual(
			MAX_RETRIEVAL_JSON_BYTES,
		);
		expect(byteBounded?.include_scope_ids?.length).toBeLessThan(50);
	});

	it("accepts JSON at 16 KiB and rejects one byte above", () => {
		const exact = filterSummaryAtBytes(MAX_RETRIEVAL_JSON_BYTES);
		expect(
			recordRetrievalAttempt(
				db,
				input({ attemptId: attemptId(310), requestId: "json-boundary", filterSummary: exact }),
			).attempt.filterSummary,
		).toEqual(exact);
		expect(() =>
			recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(311),
					requestId: "json-overflow",
					filterSummary: filterSummaryAtBytes(MAX_RETRIEVAL_JSON_BYTES + 1),
				}),
			),
		).toThrow(/exceeds 16384 bytes/);
	});

	it("decodes malformed persisted JSON as unavailable instead of trusting it", () => {
		recordRetrievalAttempt(db, input());
		db.prepare(
			"UPDATE retrieval_attempts SET working_set_files_json = ?, filter_summary_json = ?, retention_finalized_at = ? WHERE attempt_id = ?",
		).run("{not-json", '["not-an-object"]', "not-a-timestamp", input().attemptId);
		db.prepare(
			"UPDATE retrieval_exposures SET score_summary_json = ?, reason_codes_json = ? WHERE attempt_id = ?",
		).run('{"unknown_score":1}', '[1,"mixed"]', input().attemptId);

		const decoded = getRetrievalAttempt(db, input().attemptId);
		expect(decoded).toMatchObject({
			workingSetFiles: null,
			filterSummary: null,
			retentionFinalizedAt: null,
		});
		expect(decoded?.exposures[0]).toMatchObject({ scoreSummary: null, reasonCodes: null });
	});

	it("fails closed for structurally invalid persisted filter summaries and working-set files", () => {
		recordRetrievalAttempt(db, input());
		for (const filterSummaryJson of ["null", "true", "1", '"project"', "[]"]) {
			db.prepare("UPDATE retrieval_attempts SET filter_summary_json = ? WHERE attempt_id = ?").run(
				filterSummaryJson,
				input().attemptId,
			);
			expect(getRetrievalAttempt(db, input().attemptId)?.filterSummary).toBeNull();
		}

		for (const workingSetFilesJson of ["[1]", "[true]", "[null]", "[{}]"]) {
			db.prepare(
				"UPDATE retrieval_attempts SET working_set_files_json = ? WHERE attempt_id = ?",
			).run(workingSetFilesJson, input().attemptId);
			expect(getRetrievalAttempt(db, input().attemptId)?.workingSetFiles).toBeNull();
		}
	});

	it("runtime-validates memoryActive snapshots and decodes corruption fail-closed", () => {
		const selected = input().exposures[0];
		if (selected == null) throw new Error("fixture must contain a selected exposure");
		for (const [index, [memoryActive, persisted]] of (
			[
				[true, 1],
				[false, 0],
				[null, null],
				[undefined, null],
			] as const
		).entries()) {
			const valid = input({
				attemptId: attemptId(970 + index),
				requestId: `valid-memory-active-${index}`,
				candidateCount: 1,
				exposures: [{ ...selected, memoryActive }],
			});
			const recorded = recordRetrievalAttempt(db, valid);
			expect(recorded.attempt.exposures[0]?.memoryActive).toBe(memoryActive ?? null);
			expect(
				db
					.prepare("SELECT memory_active FROM retrieval_exposures WHERE attempt_id = ?")
					.pluck()
					.get(valid.attemptId),
			).toBe(persisted);
			expect(recordRetrievalAttempt(db, valid).inserted).toBe(false);
		}

		const conflictingFalseSnapshot = input({
			attemptId: attemptId(970),
			requestId: "valid-memory-active-0",
			candidateCount: 1,
			exposures: [{ ...selected, memoryActive: false }],
		});
		expect(() => recordRetrievalAttempt(db, conflictingFalseSnapshot)).toThrow(/retry conflicts/);

		for (const [index, memoryActive] of ["true", "false", 1, 0, [], {}].entries()) {
			const invalid = input({
				attemptId: attemptId(980 + index),
				requestId: `invalid-memory-active-${index}`,
				candidateCount: 1,
				exposures: [{ ...selected, memoryActive } as never],
			});
			expect(() => recordRetrievalAttempt(db, invalid)).toThrow(
				/exposure\.memoryActive must be a boolean or null/,
			);
			expect(tryRecordRetrievalAttempt(db, invalid)).toEqual({
				ok: false,
				errorCode: "retrieval_ledger_write_failed",
				reason: "invalid_input",
			});
			expect(getRetrievalAttempt(db, invalid.attemptId)).toBeNull();
		}

		for (const corrupted of [-1, 2, "true"]) {
			db.prepare(
				"UPDATE retrieval_exposures SET memory_active = ? WHERE attempt_id = ? AND rank = 1",
			).run(corrupted, attemptId(970));
			expect(getRetrievalAttempt(db, attemptId(970))?.exposures[0]?.memoryActive).toBeNull();
		}
	});

	it("requires neighboring retentionPinned input to be a runtime boolean when provided", () => {
		for (const [index, [retentionPinned, persisted]] of (
			[
				[undefined, 0],
				[false, 0],
				[true, 1],
			] as const
		).entries()) {
			const valid = input({
				attemptId: attemptId(990 + index),
				requestId: `valid-retention-pinned-${index}`,
				experimentId: retentionPinned ? "retention-study" : undefined,
				retentionPinned,
			});
			const recorded = recordRetrievalAttempt(db, valid);
			expect(recorded.attempt.retentionPinned).toBe(retentionPinned ?? false);
			expect(
				db
					.prepare("SELECT retention_pinned FROM retrieval_attempts WHERE attempt_id = ?")
					.pluck()
					.get(valid.attemptId),
			).toBe(persisted);
			expect(recordRetrievalAttempt(db, valid).inserted).toBe(false);
		}

		for (const [index, retentionPinned] of [null, "true", "false", 1, 0, [], {}].entries()) {
			const invalid = input({
				attemptId: attemptId(1000 + index),
				requestId: `invalid-retention-pinned-${index}`,
				experimentId: "retention-study",
				retentionPinned: retentionPinned as never,
			});
			expect(() => recordRetrievalAttempt(db, invalid)).toThrow(
				/retentionPinned must be a boolean when provided/,
			);
			expect(tryRecordRetrievalAttempt(db, invalid)).toEqual({
				ok: false,
				errorCode: "retrieval_ledger_write_failed",
				reason: "invalid_input",
			});
			expect(getRetrievalAttempt(db, invalid.attemptId)).toBeNull();
		}
	});

	it("rejects non-allowlisted metadata and absolute paths", () => {
		expect(() =>
			recordRetrievalAttempt(db, input({ filterSummary: { raw_query: "secret" } as never })),
		).toThrow(/unsupported key/);
		expect(() =>
			recordRetrievalAttempt(db, input({ workingSetFiles: ["/Users/name/private/file.ts"] })),
		).toThrow(/repository-relative/);
		expect(() =>
			recordRetrievalAttempt(db, input({ workingSetFiles: ["C:\\Users\\name\\private\\file.ts"] })),
		).toThrow(/repository-relative/);
	});

	it("classifies unsupported summary keys as invalid input", () => {
		expect(
			tryRecordRetrievalAttempt(db, input({ filterSummary: { raw_query: "secret" } as never })),
		).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "invalid_input",
		});
		for (const [index, filterSummary] of [
			{ project: null },
			{ project: { nested: "value" } },
		].entries()) {
			expect(
				tryRecordRetrievalAttempt(
					db,
					input({
						attemptId: attemptId(920 + index),
						requestId: `invalid-filter-scalar-${index}`,
						filterSummary: filterSummary as never,
					}),
				),
			).toEqual({
				ok: false,
				errorCode: "retrieval_ledger_write_failed",
				reason: "invalid_input",
			});
		}
		const selected = input().exposures[0];
		if (selected == null) throw new Error("fixture must contain a selected exposure");
		expect(
			tryRecordRetrievalAttempt(
				db,
				input({
					exposures: [{ ...selected, scoreSummary: { private_score: 1 } as never }],
				}),
			),
		).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "invalid_input",
		});
		expect(
			tryRecordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(922),
					requestId: "invalid-score-scalar-object",
					exposures: [{ ...selected, scoreSummary: { combined_score: { nested: 1 } } as never }],
				}),
			),
		).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "invalid_input",
		});
	});

	it("requires filterSummary to be a plain object record while preserving nullish omission", () => {
		const omitted = input({
			attemptId: attemptId(1100),
			requestId: "omitted-filter-summary",
			filterSummary: undefined,
		});
		expect(recordRetrievalAttempt(db, omitted).attempt.filterSummary).toBeNull();
		const explicitNull = input({
			attemptId: attemptId(1101),
			requestId: "null-filter-summary",
			filterSummary: null,
		});
		expect(recordRetrievalAttempt(db, explicitNull).attempt.filterSummary).toBeNull();

		const invalidSummaries = [true, 1, "project", [], new Date(), new Map()];
		for (const [index, filterSummary] of invalidSummaries.entries()) {
			const invalid = input({
				attemptId: attemptId(1102 + index),
				requestId: `invalid-filter-record-${index}`,
				filterSummary: filterSummary as never,
			});
			expect(() => recordRetrievalAttempt(db, invalid)).toThrow(
				/filterSummary must be a plain object record when provided/,
			);
			expect(tryRecordRetrievalAttempt(db, invalid)).toEqual({
				ok: false,
				errorCode: "retrieval_ledger_write_failed",
				reason: "invalid_input",
			});
			expect(getRetrievalAttempt(db, invalid.attemptId)).toBeNull();
		}
	});

	it("rejects malformed workingSetFiles before path normalization", () => {
		const invalidWorkingSets = ["packages/core/src/store.ts", {}, [1], [true], [null], [{}]];
		for (const [index, workingSetFiles] of invalidWorkingSets.entries()) {
			const invalid = input({
				attemptId: attemptId(1120 + index),
				requestId: `invalid-working-set-files-${index}`,
				workingSetFiles: workingSetFiles as never,
			});
			expect(() => recordRetrievalAttempt(db, invalid)).toThrow(
				/workingSetFiles must be an array of strings/,
			);
			expect(tryRecordRetrievalAttempt(db, invalid)).toEqual({
				ok: false,
				errorCode: "retrieval_ledger_write_failed",
				reason: "invalid_input",
			});
			expect(getRetrievalAttempt(db, invalid.attemptId)).toBeNull();
		}
	});

	it("validates filter summary values using decoder shapes and writes canonical key order", () => {
		const validFilterSummary = {
			widen_shared_when_weak: "auto",
			personal_first: true,
			visibility: ["private"],
			include_scope_ids: ["local-default"],
			scope_id: "local-default",
			project: "codemem",
			session_id: 1,
		};
		const valid = recordRetrievalAttempt(
			db,
			input({
				attemptId: attemptId(923),
				requestId: "valid-filter-shapes",
				filterSummary: validFilterSummary as never,
			}),
		);
		expect(valid.attempt.filterSummary).toEqual(validFilterSummary);
		expect(
			db
				.prepare("SELECT filter_summary_json FROM retrieval_attempts WHERE attempt_id = ?")
				.pluck()
				.get(valid.attempt.attemptId),
		).toBe(
			'{"session_id":1,"project":"codemem","scope_id":"local-default","include_scope_ids":["local-default"],"visibility":["private"],"personal_first":true,"widen_shared_when_weak":"auto"}',
		);

		const invalidSummaries = [
			{ project: 1 },
			{ include_scope_ids: [1] },
			{ project: true },
			{ session_id: "1" },
			{ include_actor_ids: "actor-1" },
			{ scope_id: 1 },
			{ personal_first: 1 },
			{ project: "x".repeat(513) },
			{ include_scope_ids: Array.from({ length: 51 }, () => "scope") },
		];
		for (const [index, filterSummary] of invalidSummaries.entries()) {
			const invalid = input({
				attemptId: attemptId(924 + index),
				requestId: `invalid-filter-shape-${index}`,
				filterSummary: filterSummary as never,
			});
			expect(() => recordRetrievalAttempt(db, invalid)).toThrow(
				/filterSummary contains an invalid value shape/,
			);
			expect(tryRecordRetrievalAttempt(db, invalid)).toEqual({
				ok: false,
				errorCode: "retrieval_ledger_write_failed",
				reason: "invalid_input",
			});
		}
	});

	it("writes score summaries canonically and accepts retries with reversed property order", () => {
		const selected = input().exposures[0];
		if (selected == null) throw new Error("fixture must contain a selected exposure");
		const original = input({
			attemptId: attemptId(932),
			requestId: "canonical-score-summary",
			exposures: [
				{
					...selected,
					scoreSummary: {
						tag_overlap: 0.1,
						recency: 0.2,
						combined_score: 0.8,
						base_score: null,
						kind_bonus: undefined,
					} as never,
				},
			],
			candidateCount: 1,
		});

		const first = recordRetrievalAttempt(db, original);
		expect(first.attempt.exposures[0]?.scoreSummary).toEqual({
			base_score: null,
			combined_score: 0.8,
			recency: 0.2,
			tag_overlap: 0.1,
		});
		expect(
			db
				.prepare("SELECT score_summary_json FROM retrieval_exposures WHERE attempt_id = ?")
				.pluck()
				.get(original.attemptId),
		).toBe('{"base_score":null,"combined_score":0.8,"recency":0.2,"tag_overlap":0.1}');

		const retry = {
			...original,
			exposures: [
				{
					...selected,
					scoreSummary: {
						base_score: null,
						combined_score: 0.8,
						recency: 0.2,
						tag_overlap: 0.1,
					},
				},
			],
		};
		expect(recordRetrievalAttempt(db, retry).inserted).toBe(false);
	});

	it("allows null only for nullable score components", () => {
		const selected = input().exposures[0];
		if (selected == null) throw new Error("fixture must contain a selected exposure");
		const nonNullableScoreKeys = [
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
		] as const;

		for (const [index, key] of nonNullableScoreKeys.entries()) {
			const invalid = input({
				attemptId: attemptId(1320 + index),
				requestId: `null-score-${key}`,
				exposures: [{ ...selected, scoreSummary: { [key]: null } as never }],
				candidateCount: 1,
			});
			expect(() => recordRetrievalAttempt(db, invalid)).toThrow(
				new RegExp(`scoreSummary\\.${key} must be a finite number`),
			);
			expect(tryRecordRetrievalAttempt(db, invalid)).toEqual({
				ok: false,
				errorCode: "retrieval_ledger_write_failed",
				reason: "invalid_input",
			});
		}

		const nullable = recordRetrievalAttempt(
			db,
			input({
				attemptId: attemptId(1332),
				requestId: "nullable-score-components",
				exposures: [{ ...selected, scoreSummary: { base_score: null, combined_score: null } }],
				candidateCount: 1,
			}),
		).attempt;
		expect(nullable.exposures[0]?.scoreSummary).toEqual({
			base_score: null,
			combined_score: null,
		});
	});

	it("rejects runtime-invalid score values and degrades malformed persisted values", () => {
		const selected = input().exposures[0];
		if (selected == null) throw new Error("fixture must contain a selected exposure");
		for (const [index, value] of ["0.8", true, [], {}, Number.NaN, Infinity, -Infinity].entries()) {
			const invalid = input({
				attemptId: attemptId(933 + index),
				requestId: `invalid-score-value-${index}`,
				exposures: [{ ...selected, scoreSummary: { combined_score: value } as never }],
				candidateCount: 1,
			});
			expect(() => recordRetrievalAttempt(db, invalid)).toThrow(
				/scoreSummary\.combined_score must be a finite number or null/,
			);
			expect(tryRecordRetrievalAttempt(db, invalid)).toEqual({
				ok: false,
				errorCode: "retrieval_ledger_write_failed",
				reason: "invalid_input",
			});
		}
		const invalidShape = input({
			attemptId: attemptId(964),
			requestId: "invalid-score-summary-shape",
			exposures: [{ ...selected, scoreSummary: [] as never }],
			candidateCount: 1,
		});
		expect(() => recordRetrievalAttempt(db, invalidShape)).toThrow(
			/scoreSummary contains an invalid value shape/,
		);
		expect(tryRecordRetrievalAttempt(db, invalidShape)).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});

		const recorded = recordRetrievalAttempt(
			db,
			input({ attemptId: attemptId(965), requestId: "invalid-persisted-score-value" }),
		);
		for (const persisted of [
			'{"combined_score":"0.8"}',
			'{"combined_score":true}',
			'{"combined_score":[]}',
			'{"combined_score":1e309}',
			'{"recency":null}',
		]) {
			db.prepare(
				"UPDATE retrieval_exposures SET score_summary_json = ? WHERE attempt_id = ? AND rank = 1",
			).run(persisted, recorded.attempt.attemptId);
			expect(
				getRetrievalAttempt(db, recorded.attempt.attemptId)?.exposures[0]?.scoreSummary,
			).toBeNull();
			expect(queryRetrievalAttempts(db).map((attempt) => attempt.attemptId)).toContain(
				recorded.attempt.attemptId,
			);
		}
	});

	it("rejects non-plain runtime score summaries while preserving nullish and object values", () => {
		const selected = input().exposures[0];
		if (selected == null) throw new Error("fixture must contain a selected exposure");
		const invalidSummaries = [new Date(0), new Map(), []];

		for (const [index, scoreSummary] of invalidSummaries.entries()) {
			const invalid = input({
				attemptId: attemptId(1340 + index),
				requestId: `invalid-score-summary-container-${index}`,
				exposures: [{ ...selected, scoreSummary: scoreSummary as never }],
				candidateCount: 1,
			});

			expect(() => recordRetrievalAttempt(db, invalid)).toThrow(
				/scoreSummary contains an invalid value shape/,
			);
			expect(tryRecordRetrievalAttempt(db, invalid)).toEqual({
				ok: false,
				errorCode: "retrieval_ledger_write_failed",
				reason: "invalid_input",
			});
		}

		for (const [index, scoreSummary] of [null, undefined, { combined_score: 0.5 }].entries()) {
			const recorded = recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(1343 + index),
					requestId: `valid-score-summary-container-${index}`,
					exposures: [{ ...selected, scoreSummary }],
					candidateCount: 1,
				}),
			).attempt;

			expect(recorded.exposures[0]?.scoreSummary).toEqual(scoreSummary ?? null);
		}
	});

	it("rejects non-array runtime reason code containers while preserving nullish and array values", () => {
		const selected = input().exposures[0];
		if (selected == null) throw new Error("fixture must contain a selected exposure");
		const invalidContainers = ["hit", { code: "ranked.high" }];

		for (const [index, reasonCodes] of invalidContainers.entries()) {
			const invalid = input({
				attemptId: attemptId(1350 + index),
				requestId: `invalid-reason-codes-container-${index}`,
				exposures: [{ ...selected, reasonCodes: reasonCodes as never }],
				candidateCount: 1,
			});

			expect(() => recordRetrievalAttempt(db, invalid)).toThrow(
				/reasonCodes must be an array when provided/,
			);
			expect(tryRecordRetrievalAttempt(db, invalid)).toMatchObject({
				ok: false,
				reason: "invalid_input",
			});
		}

		for (const [index, reasonCodes] of [null, undefined, ["ranked.high"]].entries()) {
			const recorded = recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(1352 + index),
					requestId: `valid-reason-codes-container-${index}`,
					exposures: [{ ...selected, reasonCodes }],
					candidateCount: 1,
				}),
			).attempt;

			expect(recorded.exposures[0]?.reasonCodes).toEqual(reasonCodes ?? null);
		}
	});

	it("requires runtime reason codes to be actual strings before validating their format", () => {
		const selected = input().exposures[0];
		if (selected == null) throw new Error("fixture must contain a selected exposure");
		for (const [index, reasonCode] of [123, true, null, { code: "ranked.high" }].entries()) {
			const invalid = input({
				attemptId: attemptId(960 + index),
				requestId: `invalid-reason-code-type-${index}`,
				exposures: [{ ...selected, reasonCodes: [reasonCode] as never }],
				candidateCount: 1,
			});
			expect(() => recordRetrievalAttempt(db, invalid)).toThrow(
				/reasonCodes must contain actual strings with bounded stable codes/,
			);
			expect(tryRecordRetrievalAttempt(db, invalid)).toEqual({
				ok: false,
				errorCode: "retrieval_ledger_write_failed",
				reason: "invalid_input",
			});
			expect(getRetrievalAttempt(db, invalid.attemptId)).toBeNull();
		}

		const valid = recordRetrievalAttempt(
			db,
			input({
				attemptId: attemptId(964),
				requestId: "string-like-reason-codes",
				exposures: [{ ...selected, reasonCodes: ["123", "true", "null", "object.value"] }],
				candidateCount: 1,
			}),
		).attempt;
		expect(valid.exposures[0]?.reasonCodes).toEqual(["123", "true", "null", "object.value"]);
	});

	it("runtime-validates disposition, section, and handoff state transitions", () => {
		const selected = input().exposures[0];
		if (selected == null) throw new Error("fixture must contain a selected exposure");
		expect(() =>
			recordRetrievalAttempt(
				db,
				input({
					candidateCount: 1,
					selectedCount: 0,
					exposures: [
						{
							rank: 1,
							disposition: "returned" as never,
							handoffStatus: "not_attempted",
						},
					],
				}),
			),
		).toThrow(/disposition is invalid/);
		expect(() =>
			recordRetrievalAttempt(
				db,
				input({
					exposures: [{ ...selected, section: "header" as never }],
					candidateCount: 1,
				}),
			),
		).toThrow(/section is invalid/);
		expect(() =>
			recordRetrievalAttempt(
				db,
				input({
					exposures: [{ ...selected, handoffStatus: "handed_off" }],
					candidateCount: 1,
				}),
			),
		).toThrow(/must match the attempt/);
		expect(() =>
			recordRetrievalAttempt(
				db,
				input({
					selectedCount: 0,
					candidateCount: 1,
					exposures: [{ rank: 1, disposition: "dropped", handoffStatus: "failed" }],
				}),
			),
		).toThrow(/diagnostic exposures/);

		recordRetrievalAttempt(db, input());
		updateRetrievalDelivery(db, input().attemptId, "handed_off");
		expect(() => updateRetrievalDelivery(db, input().attemptId, "failed")).toThrow(
			/cannot be downgraded/,
		);
		expect(() => updateRetrievalDelivery(db, attemptId(999), "failed")).toThrow(/does not exist/);
	});

	it("offers a failure-tolerant write wrapper for future instrumentation", () => {
		expect(tryRecordRetrievalAttempt(db, input({ attemptId: "not-a-uuid" }))).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "invalid_input",
		});
		recordRetrievalAttempt(db, input());
		expect(
			tryRecordRetrievalAttempt(
				db,
				input({ attemptId: attemptId(997), requestId: input().requestId }),
			),
		).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "idempotency_conflict",
		});
		expect(tryUpdateRetrievalDelivery(db, attemptId(998), "failed")).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_delivery_write_failed",
			reason: "attempt_not_found",
		});
		db.close();
		expect(tryRecordRetrievalAttempt(db, input())).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "storage_unavailable",
		});
		expect(tryUpdateRetrievalDelivery(db, input().attemptId, "handed_off")).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_delivery_write_failed",
			reason: "storage_unavailable",
		});
		db = new Database(":memory:");
	});

	it("applies default and configured retention, validates config, and retains pinned rows", () => {
		recordRetrievalAttempt(db, input({ retentionDays: 7 }));
		expect(
			recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(490),
					requestId: "maximum-retention",
					retentionDays: 365,
				}),
			).attempt.retentionUntil,
		).toBe("2027-08-03T10:00:00.000Z");
		recordRetrievalAttempt(
			db,
			input({
				attemptId: "018f2db4-f9d3-7a22-8d18-d92a968cb333",
				requestId: "request-pinned",
				experimentId: "retention-study",
				retentionPinned: true,
			}),
		);

		db.pragma("foreign_keys = OFF");
		expect(purgeExpiredRetrievalAttempts(db, "2026-08-11T10:00:00.000Z")).toBe(1);
		expect(getRetrievalAttempt(db, input().attemptId)).toBeNull();
		expect(
			db
				.prepare(
					`SELECT count(*) FROM retrieval_exposures e
					 LEFT JOIN retrieval_attempts a ON a.attempt_id = e.attempt_id
					 WHERE a.attempt_id IS NULL`,
				)
				.pluck()
				.get(),
		).toBe(0);
		expect(
			getRetrievalAttempt(db, "018f2db4-f9d3-7a22-8d18-d92a968cb333")?.retentionUntil,
		).toBeNull();
		for (const retentionDays of [6, 366, 7.5]) {
			expect(() =>
				recordRetrievalAttempt(
					db,
					input({
						attemptId: attemptId(500 + Math.ceil(retentionDays)),
						requestId: `invalid-retention-${retentionDays}`,
						retentionDays,
					}),
				),
			).toThrow(/retentionDays must be/);
		}
		expect(() =>
			recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(898),
					requestId: "invalid-null-retention",
					retentionDays: null,
				} as unknown as Partial<RecordRetrievalAttemptInput>),
			),
		).toThrow(/retentionDays must be/);
		expect(() =>
			recordRetrievalAttempt(
				db,
				input({
					attemptId: attemptId(900),
					requestId: "invalid-pinned-retention",
					experimentId: "retention-study",
					retentionPinned: true,
					retentionDays: 6,
				}),
			),
		).toThrow(/retentionDays must be/);
	});

	it("rejects an explicit null purge timestamp and preserves default purge behavior", () => {
		const expiring = input({
			attemptId: attemptId(899),
			requestId: "null-purge-timestamp",
			retentionDays: 7,
		});
		recordRetrievalAttempt(db, expiring);

		expect(() => purgeExpiredRetrievalAttempts(db, null as never)).toThrow(
			/now must be an ISO-8601 timestamp/,
		);
		expect(getRetrievalAttempt(db, expiring.attemptId)).not.toBeNull();

		db.prepare("UPDATE retrieval_attempts SET retention_until = ? WHERE attempt_id = ?").run(
			"2000-01-01T00:00:00.000Z",
			expiring.attemptId,
		);
		expect(purgeExpiredRetrievalAttempts(db)).toBe(1);
		expect(getRetrievalAttempt(db, expiring.attemptId)).toBeNull();
	});

	it("purges expired version 1 attempts without deleting future-contract rows", () => {
		const supported = input({ retentionDays: 7 });
		const future = input({
			attemptId: attemptId(901),
			requestId: "future-contract-retention",
			retentionDays: 7,
		});
		recordRetrievalAttempt(db, supported);
		recordRetrievalAttempt(db, future);
		db.prepare("UPDATE retrieval_attempts SET contract_version = 2 WHERE attempt_id = ?").run(
			future.attemptId,
		);
		db.pragma("foreign_keys = OFF");

		expect(purgeExpiredRetrievalAttempts(db, "2026-08-11T10:00:00.000Z")).toBe(1);
		expect(
			db
				.prepare("SELECT count(*) FROM retrieval_attempts WHERE attempt_id = ?")
				.pluck()
				.get(supported.attemptId),
		).toBe(0);
		expect(
			db
				.prepare("SELECT count(*) FROM retrieval_exposures WHERE attempt_id = ?")
				.pluck()
				.get(supported.attemptId),
		).toBe(0);
		expect(
			db
				.prepare(
					"SELECT contract_version, retention_pinned, retention_until FROM retrieval_attempts WHERE attempt_id = ?",
				)
				.get(future.attemptId),
		).toEqual({
			contract_version: 2,
			retention_pinned: 0,
			retention_until: "2026-08-10T10:00:00.000Z",
		});
		expect(
			db
				.prepare("SELECT count(*) FROM retrieval_exposures WHERE attempt_id = ?")
				.pluck()
				.get(future.attemptId),
		).toBe(future.exposures.length);
	});

	it("finalizes pinned retention without changing immutable retry identity", () => {
		const pinned = input({
			attemptId: attemptId(910),
			requestId: "finalize-pinned-retention",
			experimentId: "retention-study",
			retentionPinned: true,
		});
		recordRetrievalAttempt(db, pinned);

		const finalized = finalizeRetrievalAttemptRetention(db, pinned.attemptId, {
			finalizedAt: "2026-08-10T10:00:00.000Z",
			retentionDays: 7,
		});
		expect(finalized).toMatchObject({
			changed: true,
			attempt: {
				retentionPinned: false,
				retentionUntil: "2026-08-17T10:00:00.000Z",
				retentionFinalizedAt: "2026-08-10T10:00:00.000Z",
			},
		});
		expect(
			tryFinalizeRetrievalAttemptRetention(db, pinned.attemptId, {
				finalizedAt: "2026-08-10T10:00:00.000Z",
				retentionDays: 7,
			}),
		).toMatchObject({ ok: true, value: { changed: false } });
		expect(recordRetrievalAttempt(db, pinned).inserted).toBe(false);
	});

	it("rejects finalization before attempt start without mutating the pin", () => {
		const pinned = recordRetrievalAttempt(
			db,
			input({
				attemptId: attemptId(914),
				requestId: "predated-retention-finalization",
				experimentId: "retention-study",
				retentionPinned: true,
			}),
		).attempt;
		const predated = { finalizedAt: "2026-08-03T09:59:59.999Z", retentionDays: 7 };

		expect(() => finalizeRetrievalAttemptRetention(db, pinned.attemptId, predated)).toThrow(
			/finalizedAt cannot precede startedAt/,
		);
		expect(tryFinalizeRetrievalAttemptRetention(db, pinned.attemptId, predated)).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_retention_write_failed",
			reason: "invalid_input",
		});
		expect(getRetrievalAttempt(db, pinned.attemptId)).toMatchObject({
			retentionPinned: true,
			retentionUntil: null,
			retentionFinalizedAt: null,
		});
	});

	it("does not treat a never-pinned row as finalized during a pinned retry", () => {
		const ordinary = input({
			attemptId: attemptId(915),
			requestId: "never-pinned-retry",
			experimentId: "retention-study",
		});
		recordRetrievalAttempt(db, ordinary);

		expect(() => recordRetrievalAttempt(db, { ...ordinary, retentionPinned: true })).toThrow(
			/retry conflicts/,
		);
		expect(getRetrievalAttempt(db, ordinary.attemptId)).toMatchObject({
			retentionPinned: false,
			retentionFinalizedAt: null,
		});
	});

	it("rejects invalid or conflicting retention finalization without mutating rows", () => {
		const ordinary = recordRetrievalAttempt(
			db,
			input({ attemptId: attemptId(911), requestId: "ordinary-retention" }),
		).attempt;
		expect(() =>
			finalizeRetrievalAttemptRetention(db, ordinary.attemptId, {
				finalizedAt: "2026-08-10T10:00:00.000Z",
				retentionDays: 7,
			}),
		).toThrow(/conflicts with persisted data/);
		expect(getRetrievalAttempt(db, ordinary.attemptId)).toMatchObject({
			retentionPinned: false,
			retentionUntil: ordinary.retentionUntil,
		});
		expect(
			tryFinalizeRetrievalAttemptRetention(db, ordinary.attemptId, {
				finalizedAt: "2026-08-10T10:00:00.000Z",
				retentionDays: 7,
			}),
		).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_retention_write_failed",
			reason: "idempotency_conflict",
		});
		expect(
			tryFinalizeRetrievalAttemptRetention(db, attemptId(912), {
				finalizedAt: "not-a-timestamp",
			}),
		).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_retention_write_failed",
			reason: "invalid_input",
		});

		const pinned = recordRetrievalAttempt(
			db,
			input({
				attemptId: attemptId(913),
				requestId: "unsupported-pinned-retention",
				experimentId: "retention-study",
				retentionPinned: true,
			}),
		).attempt;
		db.prepare("UPDATE retrieval_attempts SET contract_version = 2 WHERE attempt_id = ?").run(
			pinned.attemptId,
		);
		expect(() =>
			finalizeRetrievalAttemptRetention(db, pinned.attemptId, {
				finalizedAt: "2026-08-10T10:00:00.000Z",
			}),
		).toThrow(/contract version is unsupported/);
		expect(
			db
				.prepare(
					"SELECT retention_pinned, retention_until, retention_finalized_at FROM retrieval_attempts WHERE attempt_id = ?",
				)
				.get(pinned.attemptId),
		).toEqual({
			retention_pinned: 1,
			retention_until: null,
			retention_finalized_at: null,
		});
	});

	it("purges by session or source stream and explicitly deletes exposure rows", () => {
		recordRetrievalAttempt(db, input());
		db.pragma("foreign_keys = OFF");
		expect(purgeRetrievalAttemptsForPrivacy(db, { source: "opencode", streamId: "stream-1" })).toBe(
			1,
		);
		expect(db.prepare("SELECT count(*) FROM retrieval_exposures").pluck().get()).toBe(0);

		recordRetrievalAttempt(db, input({ requestId: "request-2" }));
		expect(purgeRetrievalAttemptsForPrivacy(db, { sessionId: 1 })).toBe(1);
		expect(db.prepare("SELECT count(*) FROM retrieval_exposures").pluck().get()).toBe(0);
	});

	it("privacy-purges future-contract attempts and their exposures", () => {
		const future = input({
			attemptId: attemptId(916),
			requestId: "future-contract-privacy-purge",
		});
		recordRetrievalAttempt(db, future);
		db.prepare("UPDATE retrieval_attempts SET contract_version = 2 WHERE attempt_id = ?").run(
			future.attemptId,
		);
		db.pragma("foreign_keys = OFF");

		expect(
			purgeRetrievalAttemptsForPrivacy(db, {
				source: "opencode",
				streamId: "stream-1",
			}),
		).toBe(1);
		expect(
			db
				.prepare("SELECT count(*) FROM retrieval_attempts WHERE attempt_id = ?")
				.pluck()
				.get(future.attemptId),
		).toBe(0);
		expect(
			db
				.prepare("SELECT count(*) FROM retrieval_exposures WHERE attempt_id = ?")
				.pluck()
				.get(future.attemptId),
		).toBe(0);
	});

	it("purges retrieval attempts when optional attribution tables are absent", () => {
		recordRetrievalAttempt(db, input({ retentionDays: 7 }));
		db.exec("DROP TABLE attribution_assessment_evidence; DROP TABLE attribution_assessments;");
		db.pragma("foreign_keys = OFF");

		expect(purgeExpiredRetrievalAttempts(db, "2026-08-11T10:00:00.000Z")).toBe(1);
		expect(db.prepare("SELECT count(*) FROM retrieval_attempts").pluck().get()).toBe(0);
		expect(db.prepare("SELECT count(*) FROM retrieval_exposures").pluck().get()).toBe(0);

		recordRetrievalAttempt(db, input({ requestId: "privacy-without-attribution" }));
		expect(purgeRetrievalAttemptsForPrivacy(db, { sessionId: 1 })).toBe(1);
		expect(db.prepare("SELECT count(*) FROM retrieval_attempts").pluck().get()).toBe(0);
		expect(db.prepare("SELECT count(*) FROM retrieval_exposures").pluck().get()).toBe(0);
	});

	it("purges retrieval attempts when only the optional attribution link table is absent", () => {
		const attempt = recordRetrievalAttempt(
			db,
			input({ requestId: "partial-attribution-schema" }),
		).attempt;
		db.prepare(
			`INSERT INTO attribution_assessments (
				assessment_id, contract_version, subject_type, attempt_id, exposure_id,
				dimension, impact_label, basis, confidence_level, method, method_version,
				created_at, claim_type
			) VALUES (?, 1, 'attempt', ?, NULL, 'feedback', 'helpful', 'explicit_reference',
				'medium', 'test', 'v1', ?, 'observational')`,
		).run(attemptId(799), attempt.attemptId, STARTED_AT);
		db.pragma("foreign_keys = OFF");
		db.exec("DROP TABLE attribution_assessment_evidence;");

		expect(purgeRetrievalAttemptsForPrivacy(db, { sessionId: 1 })).toBe(1);
		expect(db.prepare("SELECT count(*) FROM attribution_assessments").pluck().get()).toBe(0);
		expect(db.prepare("SELECT count(*) FROM retrieval_attempts").pluck().get()).toBe(0);
		expect(db.prepare("SELECT count(*) FROM retrieval_exposures").pluck().get()).toBe(0);
	});

	it("rolls back explicit exposure deletion when attempt deletion fails", () => {
		recordRetrievalAttempt(db, input());
		db.pragma("foreign_keys = OFF");
		db.exec(`
			CREATE TRIGGER block_retrieval_attempt_delete
			BEFORE DELETE ON retrieval_attempts
			BEGIN
				SELECT RAISE(ABORT, 'blocked attempt deletion');
			END;
		`);

		expect(() =>
			purgeRetrievalAttemptsForPrivacy(db, { source: "opencode", streamId: "stream-1" }),
		).toThrow(/blocked attempt deletion/);
		expect(db.prepare("SELECT count(*) FROM retrieval_attempts").pluck().get()).toBe(1);
		expect(db.prepare("SELECT count(*) FROM retrieval_exposures").pluck().get()).toBe(2);
	});

	it("keeps exact retries idempotent after the store soft-deletes a referenced memory", () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-retrieval-ledger-soft-delete-"));
		const dbPath = join(dir, "ledger.sqlite");
		const store = new MemoryStore(dbPath);
		try {
			seed(store.db);
			recordRetrievalAttempt(store.db, input());
			store.forget(10);

			expect(getRetrievalAttempt(store.db, input().attemptId)?.exposures[0]).toMatchObject({
				memoryId: null,
				memoryImportKey: "memory-10",
				memoryRev: 2,
				memoryKind: "decision",
			});
			expect(recordRetrievalAttempt(store.db, input()).inserted).toBe(false);
			expect(() =>
				recordRetrievalAttempt(store.db, input({ recorderVersion: "conflicting-version" })),
			).toThrow(/retry conflicts/);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps exact retries idempotent after physical deletion but rejects snapshot conflicts", () => {
		recordRetrievalAttempt(db, input());
		db.prepare("DELETE FROM memory_items WHERE id = 10").run();

		expect(getRetrievalAttempt(db, input().attemptId)?.exposures[0]).toMatchObject({
			memoryId: null,
			memoryImportKey: "memory-10",
			memoryRev: 2,
			memoryKind: "decision",
			memoryActive: true,
		});
		expect(recordRetrievalAttempt(db, input()).inserted).toBe(false);
		const conflicting = input({
			exposures: input().exposures.map((exposure, index) =>
				index === 0 ? { ...exposure, memoryRev: 3 } : exposure,
			),
		});
		expect(() => recordRetrievalAttempt(db, conflicting)).toThrow(/retry conflicts/);
	});

	it("keeps local-only exact retries idempotent after the store soft-deletes their memory", () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-retrieval-ledger-local-soft-delete-"));
		const dbPath = join(dir, "ledger.sqlite");
		const store = new MemoryStore(dbPath);
		try {
			seed(store.db);
			const localOnly = input({
				attemptId: attemptId(945),
				requestId: "local-only-soft-delete-retry",
				exposures: input().exposures.map((exposure, index) =>
					index === 0
						? { ...exposure, memoryImportKey: undefined, originDeviceId: undefined }
						: exposure,
				),
			});
			recordRetrievalAttempt(store.db, localOnly);
			store.forget(10);

			expect(getRetrievalAttempt(store.db, localOnly.attemptId)?.exposures[0]).toMatchObject({
				memoryId: null,
				memoryImportKey: null,
				originDeviceId: null,
			});
			expect(recordRetrievalAttempt(store.db, localOnly).inserted).toBe(false);

			const conflicting = {
				...localOnly,
				exposures: localOnly.exposures.map((exposure, index) =>
					index === 0 ? { ...exposure, memoryRev: 3 } : exposure,
				),
			};
			expect(() => recordRetrievalAttempt(store.db, conflicting)).toThrow(/retry conflicts/);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps local-only exact retries idempotent after physical deletion", () => {
		db.prepare(
			`INSERT INTO memory_items(
				id, session_id, kind, title, body_text, active, created_at, updated_at, rev
			) VALUES (11, 1, 'decision', 'Unrelated fixture', 'still active', 1, ?, ?, 1)`,
		).run(STARTED_AT, STARTED_AT);
		const localOnly = input({
			attemptId: attemptId(946),
			requestId: "local-only-physical-delete-retry",
			exposures: input().exposures.map((exposure, index) =>
				index === 0
					? { ...exposure, memoryImportKey: undefined, originDeviceId: undefined }
					: exposure,
			),
		});
		recordRetrievalAttempt(db, localOnly);
		db.prepare("DELETE FROM memory_items WHERE id = 10").run();

		expect(getRetrievalAttempt(db, localOnly.attemptId)?.exposures[0]).toMatchObject({
			memoryId: null,
			memoryImportKey: null,
			originDeviceId: null,
		});
		expect(recordRetrievalAttempt(db, localOnly).inserted).toBe(false);

		const unrelatedLiveMemory = {
			...localOnly,
			exposures: localOnly.exposures.map((exposure, index) =>
				index === 0 ? { ...exposure, memoryId: 11 } : exposure,
			),
		};
		expect(() => recordRetrievalAttempt(db, unrelatedLiveMemory)).toThrow(/retry conflicts/);
	});

	it("detaches exposures inserted after their memory was soft-deleted", () => {
		const deletedAt = "2026-08-03T10:01:00.000Z";
		db.prepare("UPDATE memory_items SET active = 0, deleted_at = ? WHERE id = 10").run(deletedAt);
		const afterDeletion = input({
			attemptId: attemptId(950),
			requestId: "exposure-after-soft-delete",
			exposures: input().exposures.map((exposure, index) =>
				index === 0 ? { ...exposure, memoryActive: false, memoryDeletedAt: deletedAt } : exposure,
			),
		});

		const recorded = recordRetrievalAttempt(db, afterDeletion);

		expect(recorded).toMatchObject({
			inserted: true,
			attempt: {
				attemptId: afterDeletion.attemptId,
				exposures: [
					{
						memoryId: null,
						memoryImportKey: "memory-10",
						memoryRev: 2,
						memoryActive: false,
						memoryDeletedAt: deletedAt,
					},
					expect.any(Object),
				],
			},
		});
		expect(
			db
				.prepare("SELECT count(*) FROM retrieval_attempts WHERE attempt_id = ?")
				.pluck()
				.get(afterDeletion.attemptId),
		).toBe(1);
		expect(recordRetrievalAttempt(db, afterDeletion).inserted).toBe(false);
	});

	it("detaches exposures inserted after physical deletion or for a missing memory", () => {
		db.prepare("DELETE FROM memory_items WHERE id = 10").run();
		for (const [index, memoryId] of [10, 999].entries()) {
			const afterDeletion = input({
				attemptId: attemptId(951 + index),
				requestId: `exposure-after-missing-memory-${memoryId}`,
				exposures: input().exposures.map((exposure, exposureIndex) =>
					exposureIndex === 0 ? { ...exposure, memoryId } : exposure,
				),
			});

			const recorded = recordRetrievalAttempt(db, afterDeletion);

			expect(recorded.inserted).toBe(true);
			expect(recorded.attempt.exposures[0]).toMatchObject({
				memoryId: null,
				memoryImportKey: "memory-10",
				memoryRev: 2,
				memoryKind: "decision",
				memoryActive: true,
			});
			expect(
				db
					.prepare("SELECT count(*) FROM retrieval_attempts WHERE attempt_id = ?")
					.pluck()
					.get(afterDeletion.attemptId),
			).toBe(1);
			expect(recordRetrievalAttempt(db, afterDeletion).inserted).toBe(false);
		}
	});

	it("retains an active exposure with redacted identity when its memory snapshot matches", () => {
		const nonCanonicalUpdatedAt = "2026-08-03T10:00:00Z";
		db.prepare("UPDATE memory_items SET scope_id = ?, updated_at = ? WHERE id = 10").run(
			"scope-private",
			nonCanonicalUpdatedAt,
		);
		const privacyRedacted = input({
			attemptId: attemptId(957),
			requestId: "active-memory-redacted-identity",
			exposures: input().exposures.map((exposure, index) =>
				index === 0
					? {
							...exposure,
							memoryImportKey: undefined,
							originDeviceId: undefined,
							memoryUpdatedAt: nonCanonicalUpdatedAt,
							memoryScopeId: "scope-private",
						}
					: exposure,
			),
		});

		const recorded = recordRetrievalAttempt(db, privacyRedacted);

		expect(
			db.prepare("SELECT import_key, scope_id, updated_at FROM memory_items WHERE id = 10").get(),
		).toEqual({
			import_key: "memory-10",
			scope_id: "scope-private",
			updated_at: nonCanonicalUpdatedAt,
		});
		expect(recorded.attempt.exposures[0]).toMatchObject({
			memoryId: 10,
			memoryImportKey: null,
			originDeviceId: null,
			memoryRev: 2,
			memoryUpdatedAt: STARTED_AT,
			memoryScopeId: "scope-private",
			memoryKind: "decision",
			memoryActive: true,
		});
	});

	it("detaches a redacted-identity exposure when a required snapshot field is omitted", () => {
		const nonCanonicalUpdatedAt = "2026-08-03T10:00:00Z";
		db.prepare("UPDATE memory_items SET scope_id = ?, updated_at = ? WHERE id = 10").run(
			"scope-private",
			nonCanonicalUpdatedAt,
		);
		const missingScope = input({
			attemptId: attemptId(958),
			requestId: "active-memory-redacted-identity-missing-scope",
			exposures: input().exposures.map((exposure, index) =>
				index === 0
					? {
							...exposure,
							memoryImportKey: undefined,
							originDeviceId: undefined,
							memoryUpdatedAt: nonCanonicalUpdatedAt,
							memoryScopeId: undefined,
						}
					: exposure,
			),
		});

		const recorded = recordRetrievalAttempt(db, missingScope);

		expect(recorded.attempt.exposures[0]).toMatchObject({
			memoryId: null,
			memoryImportKey: null,
			memoryUpdatedAt: STARTED_AT,
			memoryScopeId: null,
		});
	});

	it("detaches delayed exposures whose reused memory ID has absent or mismatched identity", () => {
		db.prepare("DELETE FROM memory_items WHERE id = 10").run();
		db.prepare(
			`INSERT INTO memory_items(
				id, session_id, kind, title, body_text, active, created_at, updated_at, rev,
				import_key, origin_device_id
			) VALUES (
				10, 1, 'decision', 'Replacement fixture', 'reused row ID', 1, ?, ?, 1,
				'replacement-10', 'replacement-device'
			)`,
		).run(STARTED_AT, STARTED_AT);
		const selected = input().exposures[0];
		if (selected == null) throw new Error("fixture must contain a selected exposure");
		const staleIdentities = [
			{ memoryImportKey: "memory-10", originDeviceId: undefined },
			{ memoryImportKey: "replacement-10", originDeviceId: "original-device" },
		] as const;

		for (const [index, identity] of staleIdentities.entries()) {
			const delayed = input({
				attemptId: attemptId(953 + index),
				requestId: `delayed-reused-memory-${index}`,
				candidateCount: 1,
				exposures: [{ ...selected, ...identity }],
			});

			const recorded = recordRetrievalAttempt(db, delayed);
			expect(recorded.attempt.exposures[0]?.memoryId).toBeNull();
			expect(recordRetrievalAttempt(db, delayed).inserted).toBe(false);
		}

		const missingIdentity = input({
			attemptId: attemptId(955),
			requestId: "delayed-reused-memory-missing-identity",
			candidateCount: 1,
			exposures: [
				{
					...selected,
					memoryImportKey: undefined,
					originDeviceId: undefined,
				},
			],
		});
		expect(recordRetrievalAttempt(db, missingIdentity).attempt.exposures[0]?.memoryId).toBeNull();
		expect(() => recordRetrievalAttempt(db, missingIdentity)).toThrow(/retry conflicts/);

		const matching = input({
			attemptId: attemptId(956),
			requestId: "delayed-matching-memory-identity",
			candidateCount: 1,
			exposures: [
				{
					...selected,
					memoryImportKey: "replacement-10",
					originDeviceId: "replacement-device",
				},
			],
		});
		expect(recordRetrievalAttempt(db, matching).attempt.exposures[0]?.memoryId).toBe(10);
		expect(recordRetrievalAttempt(db, matching).inserted).toBe(false);

		db.prepare(
			"UPDATE retrieval_exposures SET memory_id = NULL WHERE attempt_id = ? AND rank = 1",
		).run(matching.attemptId);
		expect(() => recordRetrievalAttempt(db, matching)).toThrow(/retry conflicts/);
	});
});

describe("retrieval ledger data boundaries", () => {
	it("opens and records against a supported legacy memory schema without deleted_at", () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-retrieval-ledger-legacy-deleted-at-"));
		const dbPath = join(dir, "ledger.sqlite");
		const legacy = new Database(dbPath);
		try {
			seed(legacy);
			removeDeletedAtForLegacyLedgerSchema(legacy);
		} finally {
			legacy.close();
		}

		let store: MemoryStore | undefined;
		try {
			store = new MemoryStore(dbPath);
			expect(
				store.db
					.prepare("SELECT name FROM pragma_table_info('memory_items') WHERE name = 'deleted_at'")
					.pluck()
					.get(),
			).toBe("deleted_at");
			const recorded = recordRetrievalAttempt(store.db, input());
			expect(recorded.attempt.exposures[0]).toMatchObject({
				memoryId: 10,
				memoryImportKey: "memory-10",
				memoryRev: 2,
			});
			expect(
				updateRetrievalDelivery(store.db, input().attemptId, "handed_off").attempt,
			).toMatchObject({
				deliveryStatus: "handed_off",
				exposures: [
					{
						memoryId: 10,
						memoryImportKey: "memory-10",
						memoryRev: 2,
						handoffStatus: "handed_off",
					},
					expect.any(Object),
				],
			});
		} finally {
			store?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps compatibility and store opening fail-open when optional ledger DDL fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-retrieval-ledger-fail-open-"));
		const dbPath = join(dir, "ledger.sqlite");
		const db = new Database(dbPath);
		try {
			seed(db);
			db.pragma("user_version = 16");
			db.exec(`
				DROP TABLE attribution_assessment_evidence;
				DROP TABLE attribution_assessments;
				DROP TRIGGER trg_retrieval_exposures_detach_deleted_memory;
				DROP TABLE retrieval_exposures;
				DROP TABLE retrieval_attempts;
				CREATE VIEW retrieval_attempts AS SELECT 'blocked' AS attempt_id;
			`);
			expect(() => ensureRetrievalLedgerSchema(db)).toThrow();
			expect(() => ensureAdditiveSchemaCompatibility(db)).not.toThrow();
			expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
		} finally {
			db.close();
		}

		let store: MemoryStore | undefined;
		try {
			expect(() => {
				store = new MemoryStore(dbPath);
			}).not.toThrow();
		} finally {
			store?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not enter ordinary export or replication", () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-retrieval-ledger-"));
		const dbPath = join(dir, "ledger.sqlite");
		const db = new Database(dbPath);
		try {
			seed(db);
			const replicationBefore = db.prepare("SELECT count(*) FROM replication_ops").pluck().get();
			recordRetrievalAttempt(db, input());
			expect(db.prepare("SELECT count(*) FROM replication_ops").pluck().get()).toBe(
				replicationBefore,
			);
		} finally {
			db.close();
		}

		try {
			const payload = exportMemories({ dbPath, allProjects: true, includeInactive: true });
			expect(payload).not.toHaveProperty("retrieval_attempts");
			expect(payload).not.toHaveProperty("retrieval_exposures");
			expect(JSON.stringify(payload)).not.toContain("018f2db4-f9d3-7a22-8d18-d92a968cb111");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
