import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	automaticRecallHealth,
	buildMemoryPackWithTrace,
	connect,
	getRetrievalAttempt,
	MemoryStore,
	search,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTestSchema, insertTestSession } from "../../../core/src/test-utils.js";
import {
	handleInstrumentedPackLedger,
	handlePromptPackLedger,
	parseInternalLedgerPayload,
} from "./pack.js";

function id(sequence: number): string {
	return `018f2db4-f9d3-7a22-8d18-${sequence.toString(16).padStart(12, "0")}`;
}

let directory: string;
let store: MemoryStore;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-cli-pack-ledger-"));
	const path = join(directory, "test.sqlite");
	const db = connect(path);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(path);
});

afterEach(() => {
	store.close();
	rmSync(directory, { recursive: true, force: true });
});

it("persists hybrid evidence through the CLI instrumented ledger handler", () => {
	const sessionId = insertTestSession(store.db);
	const memoryId = store.remember(sessionId, "decision", "quasar evidence", "quasar fact", 0.9);
	const semantic = search(store, "quasar", 10).map((item) => ({ ...item, score: 0.75 }));
	const artifacts = buildMemoryPackWithTrace(store, "quasar", 10, null, undefined, semantic);
	const outcome = handleInstrumentedPackLedger(
		store.db,
		{ attempt_id: id(500), source: "opencode", request_id: "hybrid-ledger" },
		"quasar",
		{},
		artifacts,
	);
	const fusion = artifacts.trace.retrieval.candidates.find((item) => item.id === memoryId)?.scores
		.fusion;
	if (!fusion) throw new Error("fixture must produce hybrid evidence");
	const recorded = getRetrievalAttempt(store.db, id(500));
	const scoreSummary = recorded?.exposures.find((item) => item.memoryId === memoryId)?.scoreSummary;
	expect(outcome.ok).toBe(true);
	expect(scoreSummary).toMatchObject(fusion);
	expect(scoreSummary).not.toHaveProperty("fusion");
});

it("enriches the same local ledger through CLI delivery with retry-safe measurements", () => {
	const sessionId = insertTestSession(store.db);
	store.remember(sessionId, "decision", "CLI measured candidate", "bounded body", 0.9);
	const artifacts = buildMemoryPackWithTrace(store, "CLI measured candidate", 10);
	handleInstrumentedPackLedger(
		store.db,
		{ attempt_id: id(10), source: "opencode", request_id: "measurement" },
		"CLI measured candidate",
		{},
		artifacts,
	);
	const tokens = Math.ceil(`[codemem context]\n${artifacts.response.pack_text}`.length / 4);
	const payload = parseInternalLedgerPayload(
		JSON.stringify({
			action: "delivery",
			attempt_id: id(10),
			delivery_status: "handed_off",
			evaluation_key: "c".repeat(64),
			automatic_recall: {
				v: 1,
				candidateItems: artifacts.response.metrics.total_items,
				duplicatesOmitted: 0,
				beforeTokens: tokens,
				afterTokens: tokens,
				missingRetainedMetadata: true,
				invalidRetainedMetadata: false,
				packMetadata: "missing",
			},
		}),
	);
	handlePromptPackLedger(store.db, payload);
	const dbPath = store.dbPath;
	store.close();
	store = new MemoryStore(dbPath);
	handlePromptPackLedger(store.db, payload);
	expect(
		automaticRecallHealth(store.db, { actorId: store.actorId, deviceId: store.deviceId }),
	).toMatchObject({
		freshEvaluations: 1,
		estimatedTokensAvoided: 0,
		missingRetainedMetadata: 1,
		packMetadataGaps: 1,
	});
	expect(
		handlePromptPackLedger(store.db, {
			...payload,
			automatic_recall: { raw_memory: "private" },
		}),
	).toMatchObject({ changed: false });
	expect(getRetrievalAttempt(store.db, id(10))).toMatchObject({ deliveryStatus: "handed_off" });
	expect(() =>
		handlePromptPackLedger(store.db, {
			...payload,
			action: "recall",
			automatic_recall: { raw_memory: "private" },
		}),
	).toThrow("invalid automatic recall");
});

it.each(["missing", "invalid", "no_results", "downgrade"])(
	"does not persist measurements for rejected %s CLI delivery",
	(scenario) => {
		if (scenario !== "no_results") {
			store.remember(insertTestSession(store.db), "decision", "CLI candidate", "bounded body", 0.9);
		}
		const artifacts = buildMemoryPackWithTrace(store, "CLI candidate", 10);
		handleInstrumentedPackLedger(
			store.db,
			{ attempt_id: id(13), source: "opencode", request_id: "rejected-delivery" },
			"CLI candidate",
			{},
			artifacts,
		);
		if (scenario === "downgrade") {
			handlePromptPackLedger(store.db, {
				action: "delivery",
				attempt_id: id(13),
				delivery_status: "handed_off",
			});
		}
		const before = store.db.prepare("SELECT * FROM retrieval_attempts").all();
		let deliveryStatus: string | undefined = "failed";
		if (scenario === "missing") deliveryStatus = undefined;
		if (scenario === "invalid") deliveryStatus = "invalid";
		expect(() =>
			handlePromptPackLedger(
				store.db,
				parseInternalLedgerPayload(
					JSON.stringify({
						action: "delivery",
						attempt_id: id(13),
						delivery_status: deliveryStatus,
						evaluation_key: "f".repeat(64),
						automatic_recall: {
							v: 1,
							candidateItems: artifacts.response.metrics.total_items,
							duplicatesOmitted: artifacts.response.metrics.total_items,
							beforeTokens:
								scenario === "no_results"
									? 0
									: Math.ceil(`[codemem context]\n${artifacts.response.pack_text}`.length / 4),
							afterTokens: 0,
							missingRetainedMetadata: false,
							invalidRetainedMetadata: false,
							packMetadata: "valid",
						},
					}),
				),
			),
		).toThrow();
		expect(store.db.prepare("SELECT * FROM retrieval_attempts").all()).toEqual(before);
		expect(
			automaticRecallHealth(store.db, { actorId: store.actorId, deviceId: store.deviceId }),
		).toMatchObject({ freshEvaluations: 0, estimatedTokensAvoided: 0 });
	},
);

it("keeps valid delivery receipts when recall diagnostics reject or storage fails", () => {
	const sessionId = insertTestSession(store.db);
	store.remember(sessionId, "decision", "Best effort diagnostics", "bounded body", 0.9);
	const artifacts = buildMemoryPackWithTrace(store, "Best effort diagnostics", 10);
	const recordAttempt = (sequence: number) => {
		handleInstrumentedPackLedger(
			store.db,
			{ attempt_id: id(sequence), source: "opencode", request_id: `diagnostic-${sequence}` },
			"Best effort diagnostics",
			{},
			artifacts,
		);
	};
	recordAttempt(11);
	const rejected = {
		action: "delivery" as const,
		attempt_id: id(11),
		delivery_status: "handed_off" as const,
		evaluation_key: "d".repeat(64),
		automatic_recall: {
			v: 1,
			candidateItems: 50,
			duplicatesOmitted: 0,
			beforeTokens: 0,
			afterTokens: 0,
			missingRetainedMetadata: false,
			invalidRetainedMetadata: false,
			packMetadata: "valid",
		},
	};
	expect(handlePromptPackLedger(store.db, rejected)).toMatchObject({ changed: true });

	recordAttempt(12);
	store.db.exec("ALTER TABLE retrieval_attempts DROP COLUMN automatic_recall_json");
	expect(
		handlePromptPackLedger(store.db, {
			...rejected,
			attempt_id: id(12),
			evaluation_key: "e".repeat(64),
		}),
	).toMatchObject({ changed: true });
	expect(
		store.db
			.prepare("SELECT delivery_status FROM retrieval_attempts WHERE attempt_id = ?")
			.get(id(12)),
	).toEqual({ delivery_status: "handed_off" });
	expect(() =>
		handlePromptPackLedger(store.db, { ...rejected, delivery_status: "not_attempted" as never }),
	).toThrow("invalid_input");
});

describe("prompt-pack ledger transport", () => {
	it("handles failure recording, successful delivery retry, and cache reuse", () => {
		const record = parseInternalLedgerPayload(
			JSON.stringify({
				action: "record",
				attempt_id: id(1),
				started_at: "2026-08-03T10:00:00.000Z",
				source: "opencode",
				request_id: "record-request",
				retrieval_status: "skipped",
				failure_code: "injection_disabled",
				failure_stage: "policy",
			}),
		);
		expect(handlePromptPackLedger(store.db, record)).toMatchObject({ inserted: true });

		const sessionId = insertTestSession(store.db);
		store.remember(sessionId, "decision", "Delivery candidate", "bounded body", 0.9);
		const artifacts = buildMemoryPackWithTrace(store, "Delivery candidate", 10);
		const successful = parseInternalLedgerPayload(
			JSON.stringify({
				attempt_id: id(3),
				started_at: "2026-08-03T10:00:00.500Z",
				source: "opencode",
				request_id: "delivery-request",
			}),
		);
		expect(
			handleInstrumentedPackLedger(store.db, successful, "Delivery candidate", {}, artifacts),
		).toMatchObject({ ok: true, value: { inserted: true } });

		const delivery = parseInternalLedgerPayload(
			JSON.stringify({
				action: "delivery",
				attempt_id: id(3),
				delivery_status: "handed_off",
			}),
		);
		expect(handlePromptPackLedger(store.db, delivery)).toMatchObject({ changed: true });
		expect(handlePromptPackLedger(store.db, delivery)).toMatchObject({ changed: false });

		const cacheReuse = parseInternalLedgerPayload(
			JSON.stringify({
				action: "cache_reuse",
				attempt_id: id(2),
				started_at: "2026-08-03T10:00:01.000Z",
				source: "opencode",
				request_id: "cache-request",
				original_attempt_id: id(3),
			}),
		);
		expect(handlePromptPackLedger(store.db, cacheReuse)).toMatchObject({ inserted: true });
		expect(handlePromptPackLedger(store.db, cacheReuse)).toMatchObject({ inserted: false });
		expect(getRetrievalAttempt(store.db, id(2))).toMatchObject({
			attemptId: id(2),
			deliveryStatus: "not_attempted",
			requestId: `cache_reuse:cache-request:from:${id(3)}`,
		});
	});

	it("records an instrumented combined pack through the CLI boundary", () => {
		const sessionId = insertTestSession(store.db);
		store.remember(sessionId, "decision", "CLI boundary candidate", "bounded body", 0.9);
		const artifacts = buildMemoryPackWithTrace(store, "CLI boundary candidate", 10);
		const payload = parseInternalLedgerPayload(
			JSON.stringify({
				attempt_id: id(3),
				started_at: "2026-08-03T10:00:00.000Z",
				source: "opencode",
				request_id: "pack-request",
			}),
		);

		expect(
			handleInstrumentedPackLedger(
				store.db,
				payload,
				"CLI boundary candidate",
				{ working_set_paths: ["packages/core/src/pack.ts"] },
				artifacts,
			),
		).toMatchObject({ ok: true, value: { inserted: true } });
		expect(getRetrievalAttempt(store.db, id(3))).toMatchObject({
			retrievalStatus: "succeeded",
			workingSetFiles: ["packages/core/src/pack.ts"],
			traceVersion: 1,
		});
	});

	it("surfaces a changed-artifact idempotency conflict after caller cache loss", () => {
		const sessionId = insertTestSession(store.db);
		store.remember(sessionId, "feature", "Restart candidate", "first artifact", 0.8);
		const payload = parseInternalLedgerPayload(
			JSON.stringify({
				attempt_id: id(4),
				started_at: "2026-08-03T10:00:00.000Z",
				source: "opencode",
				request_id: "restart-request",
			}),
		);
		const first = buildMemoryPackWithTrace(store, "Restart candidate", 10);
		expect(
			handleInstrumentedPackLedger(store.db, payload, "Restart candidate", {}, first),
		).toMatchObject({
			ok: true,
		});

		store.remember(sessionId, "decision", "Restart candidate changed", "second artifact", 0.9);
		const changed = buildMemoryPackWithTrace(store, "Restart candidate", 10);

		expect(
			handleInstrumentedPackLedger(store.db, payload, "Restart candidate", {}, changed),
		).toEqual({
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "idempotency_conflict",
		});
		expect(getRetrievalAttempt(store.db, id(4))).toMatchObject({
			deliveryStatus: "not_attempted",
			selectedCount: 1,
		});
	});

	it("delegates UUID and timestamp validation without echoing rejected values", () => {
		const malformed = parseInternalLedgerPayload(
			JSON.stringify({
				action: "record",
				attempt_id: "private-invalid-attempt-value",
				started_at: "private-invalid-timestamp-value",
				source: "opencode",
				request_id: "malformed-request",
				retrieval_status: "failed",
				failure_code: "pack_command_failed",
				failure_stage: "transport",
			}),
		);

		expect(() => handlePromptPackLedger(store.db, malformed)).toThrow("invalid_input");
		try {
			handlePromptPackLedger(store.db, malformed);
		} catch (error) {
			expect(String(error)).not.toContain("private-invalid-attempt-value");
			expect(String(error)).not.toContain("private-invalid-timestamp-value");
		}
	});
});
