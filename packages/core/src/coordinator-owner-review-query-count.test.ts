import { expect } from "vitest";
import {
	ACCOUNT_CONNECTION_SCHEMA_READINESS_SQL,
	AUTH_V2_SCHEMA_READINESS_SQL,
	CONNECTION_SCHEMA_PRESENCE_SQL,
} from "./coordinator-account-connection-schema.js";
import { backendTest, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	atomicEvidenceQuery,
	readCombinedEvidenceQuery,
} from "./coordinator-device-ownership-evidence-queries.js";
import {
	deterministicReviewTests,
	selection,
	setupReview,
} from "./coordinator-owner-resolution-review-test-fixtures.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";

const presenceSql = `SELECT (${CONNECTION_SCHEMA_PRESENCE_SQL}) AS present, ((${AUTH_V2_SCHEMA_READINESS_SQL})=10) AS v2`;
const categories = new Map([
	[presenceSql, "schema:presence"],
	[ACCOUNT_CONNECTION_SCHEMA_READINESS_SQL, "schema:readiness"],
	[atomicEvidenceQuery("").sql, "evidence:atomic"],
	[readCombinedEvidenceQuery("").sql, "evidence:snapshot"],
]);

function measuredStore(f: LinkFixture) {
	const adapter = sqliteD1(f.db);
	const originals = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
	let calls: { method: string; category: string }[] = [];
	// Classify static SQL only. Never capture bindings, row contents, or timings.
	const record = (method: string, sql: string) => {
		calls.push({ method, category: categories.get(sql) ?? "review:other" });
	};
	const db: D1DatabaseLike = {
		prepare(sql) {
			const statement = adapter.prepare(sql);
			const wrapped: D1PreparedStatementLike = {
				bind(...values) {
					statement.bind(...values);
					return wrapped;
				},
				first<T>() {
					record("first", sql);
					return statement.first<T>();
				},
				all<T>() {
					record("all", sql);
					return statement.all<T>();
				},
				run() {
					record("run", sql);
					return statement.run();
				},
				raw<T>() {
					record("raw", sql);
					return statement.raw<T>();
				},
			};
			originals.set(wrapped, statement);
			return wrapped;
		},
		batch(statements) {
			// One D1 call, not one call per statement executed inside the transaction.
			record("batch", "");
			if (!adapter.batch) throw new Error("fixture D1 batch unavailable");
			return adapter.batch(
				statements.map((statement) => {
					const original = originals.get(statement);
					if (!original) throw new Error("unrecognized measured statement");
					return original;
				}),
			);
		},
	};
	return {
		store: new D1CoordinatorStore(db, { authClock: () => NOW }),
		reset: () => {
			calls = [];
		},
		counts: () => ({
			total: calls.length,
			methods: countBy(calls.map(({ method }) => method)),
			categories: countBy(calls.map(({ category }) => category)),
		}),
	};
}

function countBy(keys: string[]) {
	const counts: Record<string, number> = {};
	for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
	return counts;
}

deterministicReviewTests();
const test = backendTest("D1");
for (const reused of [false, true]) {
	test(`measures actual D1 calls for ${reused ? "reused" : "new"} scoped owner receipts`, async ({
		fixture: f,
	}) => {
		// Arrange: seed real provenance/schema without counting fixture setup.
		await setupReview(f, "D1");
		const measured = measuredStore(f);
		if (reused) {
			const initial = await measured.store.previewOwnerResolutionReview(selection, f.cfg);
			await measured.store.confirmOwnerResolutionReview(
				{ ...selection, confirmOwnerResolutionDigest: initial.owner_resolution_digest },
				f.cfg,
			);
		}
		measured.reset();
		// Act: confirmation counts include its own complete preview preparation.
		const preview = await measured.store.previewOwnerResolutionReview(selection, f.cfg);
		const previewCalls = measured.counts();
		measured.reset();
		const confirmed = await measured.store.confirmOwnerResolutionReview(
			{ ...selection, confirmOwnerResolutionDigest: preview.owner_resolution_digest },
			f.cfg,
		);
		const confirmationCalls = measured.counts();
		// Assert: measure successful real operations, not stubbed SQL responses.
		expect(preview.state).toBe(reused ? "restored" : "ready");
		expect(confirmed).toMatchObject({
			state: "ready",
			recovery_receipt: { disposition: reused ? "reused" : "created" },
			owner_resolution: { disposition: reused ? "reused" : "created" },
		});
		expect(previewCalls.total).toBe(reused ? 45 : 42);
		expect(previewCalls.methods).toEqual({ first: reused ? 33 : 30, all: 12 });
		expect(confirmationCalls.total).toBe(reused ? 70 : 64);
		expect(confirmationCalls.methods).toEqual({ first: reused ? 53 : 47, all: 16, batch: 1 });
		for (const category of ["schema:presence", "schema:readiness"]) {
			expect(previewCalls.categories[category]).toBe(reused ? 13 : 12);
			expect(confirmationCalls.categories[category]).toBe(reused ? 20 : 18);
		}
		expect(previewCalls.categories["evidence:snapshot"]).toBe(1);
		expect(confirmationCalls.categories["evidence:snapshot"]).toBe(2);
		expect(previewCalls.categories["evidence:atomic"]).toBe(2);
		expect(confirmationCalls.categories["evidence:atomic"]).toBe(3);
	});
}

test("rejected preview performs no D1 calls and stale confirmation never batches writes", async ({
	fixture: f,
}) => {
	// Arrange
	await setupReview(f, "D1");
	const measured = measuredStore(f);
	// Act
	const preview = await measured.store.previewOwnerResolutionReview(selection, {
		...f.cfg,
		enabled: false,
	});
	const previewCalls = measured.counts();
	const confirmation = measured.store.confirmOwnerResolutionReview(
		{ ...selection, confirmOwnerResolutionDigest: "0".repeat(64) },
		f.cfg,
	);
	// Assert
	expect(preview.state).toBe("needs_review");
	expect(previewCalls.total).toBe(0);
	await expect(confirmation).rejects.toMatchObject({ code: "review_stale" });
	expect(measured.counts().methods).not.toHaveProperty("batch");
	expect(measured.counts().methods).not.toHaveProperty("run");
});
