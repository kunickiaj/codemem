import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	automaticRecallHealth,
	isAutomaticRecallMeasurement,
	recordAutomaticRecall,
} from "./automatic-recall.js";
import { recordRetrievalAttempt } from "./retrieval-ledger.js";
import { ensureRetrievalLedgerSchema } from "./schema-bootstrap.js";
import { initTestSchema, seedMixedScopeFixture } from "./test-utils.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const key = "a".repeat(64);
const measurement = {
	v: 1,
	candidateItems: 0,
	duplicatesOmitted: 0,
	beforeTokens: 0,
	afterTokens: 0,
	missingRetainedMetadata: false,
	invalidRetainedMetadata: false,
	packMetadata: "valid",
};
const context = { actorId: "local", deviceId: "local" };
const id = (n: number) => `018f2db4-f9d3-7a22-8d18-${n.toString(16).padStart(12, "0")}`;

let db: Database.Database;
beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});
afterEach(() => db.close());
function attempt(n: number, memoryId?: number, startedAt = now.toISOString()) {
	const memory =
		memoryId == null
			? null
			: (db.prepare("SELECT import_key FROM memory_items WHERE id = ?").get(memoryId) as {
					import_key: string;
				});
	return recordRetrievalAttempt(db, {
		attemptId: id(n),
		startedAt,
		source: "opencode",
		requestId: `request-${n}`,
		surface: "prompt_pack",
		trigger: "automatic",
		recorderVersion: "test",
		deliveryStatus: "not_attempted",
		retrievalStatus: memory ? "succeeded" : "no_results",
		candidateCount: memory ? 1 : 0,
		selectedCount: memory ? 1 : 0,
		outputTokens: memory ? 20 : 0,
		exposures: memory
			? [
					{
						rank: 1,
						disposition: "selected",
						handoffStatus: "not_attempted",
						memoryId,
						memoryImportKey: memory.import_key,
					},
				]
			: [],
	});
}
describe("automatic recall ledger measurements", () => {
	it("deduplicates retries by attempt and stable evaluation key", () => {
		attempt(1);
		attempt(2);
		expect(recordAutomaticRecall(db, id(1), key, measurement)).toEqual({
			ok: true,
			value: { changed: true },
		});
		expect(recordAutomaticRecall(db, id(1), key, measurement)).toEqual({
			ok: true,
			value: { changed: false },
		});
		expect(
			recordAutomaticRecall(
				db,
				id(1),
				key,
				Object.fromEntries(Object.entries(measurement).reverse()),
			),
		).toMatchObject({ ok: true, value: { changed: false } });
		expect(
			recordAutomaticRecall(db, id(1), key, { ...measurement, missingRetainedMetadata: true }),
		).toMatchObject({ ok: false, reason: "idempotency_conflict" });
		expect(recordAutomaticRecall(db, id(2), key, measurement)).toEqual({
			ok: true,
			value: { changed: false },
		});
		expect(automaticRecallHealth(db, context, now)).toMatchObject({
			availability: "available",
			freshEvaluations: 1,
			evaluationsWithDuplicates: 0,
			estimatedTokensAvoided: 0,
			unmeasuredAttempts: 0,
		});
	});
	it("counts changed artifacts separately while collapsing durable retry markers", () => {
		attempt(1);
		attempt(2);
		attempt(3);
		expect(recordAutomaticRecall(db, id(1), key, measurement)).toMatchObject({ ok: true });
		expect(recordAutomaticRecall(db, id(2), key, measurement)).toEqual({
			ok: true,
			value: { changed: false },
		});
		expect(recordAutomaticRecall(db, id(3), "b".repeat(64), measurement)).toMatchObject({
			ok: true,
			value: { changed: true },
		});
		expect(automaticRecallHealth(db, context, now)).toMatchObject({
			freshEvaluations: 2,
			unmeasuredAttempts: 0,
		});
	});
	it("keeps retry markers unknown across visibility and time boundaries", () => {
		const fixture = seedMixedScopeFixture(db);
		attempt(1, fixture.unauthorizedId);
		attempt(2, fixture.authorizedId);
		const oneItem = {
			...measurement,
			candidateItems: 1,
			beforeTokens: 20,
			afterTokens: 20,
		};
		expect(recordAutomaticRecall(db, id(1), key, oneItem).ok).toBe(true);
		expect(recordAutomaticRecall(db, id(2), key, oneItem)).toEqual({
			ok: true,
			value: { changed: false },
		});
		expect(automaticRecallHealth(db, context, now)).toMatchObject({
			freshEvaluations: 0,
			unmeasuredAttempts: 1,
		});

		attempt(3, fixture.authorizedId, "2026-01-01T00:00:00.000Z");
		attempt(4, fixture.authorizedId);
		expect(recordAutomaticRecall(db, id(3), "c".repeat(64), oneItem).ok).toBe(true);
		expect(recordAutomaticRecall(db, id(4), "c".repeat(64), oneItem)).toEqual({
			ok: true,
			value: { changed: false },
		});
		expect(automaticRecallHealth(db, context, now)).toMatchObject({
			freshEvaluations: 0,
			unmeasuredAttempts: 2,
		});
	});
	it("reports unknown coverage rather than zero savings for older clients and unavailable storage", () => {
		attempt(1);
		expect(automaticRecallHealth(db, context, now)).toMatchObject({
			availability: "no_data",
			freshEvaluations: 0,
			unmeasuredAttempts: 1,
		});
		db.exec("ALTER TABLE retrieval_attempts DROP COLUMN automatic_recall_json");
		expect(automaticRecallHealth(db, context, now).availability).toBe("unavailable");
		expect(recordAutomaticRecall(db, id(1), key, measurement)).toMatchObject({
			ok: false,
			reason: "storage_unavailable",
		});
	});
	it("aggregates counts and estimates only while every selected memory remains visible", () => {
		const fixture = seedMixedScopeFixture(db);
		attempt(1, fixture.authorizedId);
		const m = {
			...measurement,
			candidateItems: 1,
			duplicatesOmitted: 1,
			beforeTokens: 25,
			missingRetainedMetadata: true,
			invalidRetainedMetadata: true,
		};
		expect(recordAutomaticRecall(db, id(1), key, m).ok).toBe(true);
		expect(automaticRecallHealth(db, context, now)).toMatchObject({
			freshEvaluations: 1,
			evaluationsWithDuplicates: 1,
			candidateItems: 1,
			duplicatesOmitted: 1,
			beforeTokens: 25,
			afterTokens: 0,
			estimatedTokensAvoided: 25,
			missingRetainedMetadata: 1,
			invalidRetainedMetadata: 1,
		});
		db.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?").run(
			fixture.authorizedScopeId,
		);
		const hidden = automaticRecallHealth(db, context, now);
		expect(hidden).toMatchObject({
			freshEvaluations: 0,
			unmeasuredAttempts: 0,
			availability: "no_data",
		});
		expect(JSON.stringify(hidden)).not.toContain(fixture.authorizedScopeId);
	});
});

describe("automatic recall validation and retention", () => {
	it("validates client counts against server-owned attempt bounds and rejects sensitive or invalid fields", () => {
		attempt(1);
		for (const m of [
			{ ...measurement, beforeTokens: 100, afterTokens: 100 },
			{ ...measurement, candidateItems: 1 },
			{ ...measurement, beforeTokens: -1 },
			{ ...measurement, v: 2 },
			{ ...measurement, path: "private" },
			{ ...measurement, afterTokens: Number.NaN },
			{ ...measurement, duplicatesOmitted: 0.5 },
		]) {
			expect(recordAutomaticRecall(db, id(1), key, m)).toMatchObject({
				ok: false,
				reason: "invalid_input",
			});
		}
		expect(isAutomaticRecallMeasurement({ ...measurement, missingRetainedMetadata: "false" })).toBe(
			false,
		);
		expect(recordAutomaticRecall(db, id(999), key, measurement)).toMatchObject({
			ok: false,
			reason: "attempt_not_found",
		});
		expect(automaticRecallHealth(db, context, now).freshEvaluations).toBe(0);
	});
	it("bounds the period and scan, excludes cache replay and policy skips", () => {
		for (let n = 1; n <= 1002; n++) attempt(n);
		attempt(1003, undefined, "2026-01-01T00:00:00.000Z");
		db.prepare(
			"UPDATE retrieval_attempts SET request_id = 'cache_reuse:one' WHERE attempt_id = ?",
		).run(id(1));
		db.prepare(
			"UPDATE retrieval_attempts SET retrieval_status = 'skipped', failure_code = 'allowance_exhausted' WHERE attempt_id = ?",
		).run(id(2));
		expect(recordAutomaticRecall(db, id(1), key, measurement)).toMatchObject({ ok: false });
		expect(recordAutomaticRecall(db, id(2), key, measurement)).toMatchObject({ ok: false });
		expect(automaticRecallHealth(db, context, now)).toMatchObject({
			unmeasuredAttempts: 1000,
			periodStart: "2026-08-08T12:00:00.000Z",
			periodEnd: now.toISOString(),
			windowLimit: 1000,
		});
	});
	it("adds optional columns to existing ledgers idempotently without touching attempts", () => {
		attempt(1);
		db.exec(
			"DROP INDEX idx_retrieval_attempts_automatic_recall_key; ALTER TABLE retrieval_attempts DROP COLUMN automatic_recall_key; ALTER TABLE retrieval_attempts DROP COLUMN automatic_recall_json;",
		);
		ensureRetrievalLedgerSchema(db);
		ensureRetrievalLedgerSchema(db);
		expect(recordAutomaticRecall(db, id(1), key, measurement).ok).toBe(true);
		expect(db.prepare("SELECT COUNT(*) AS n FROM retrieval_attempts").get()).toEqual({ n: 1 });
	});
});
