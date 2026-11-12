import { expect } from "vitest";
import { backendTest, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
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

function measuredStore(f: LinkFixture) {
	const adapter = sqliteD1(f.db);
	const originals = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
	const queries = new WeakMap<D1PreparedStatementLike, string>();
	let calls: string[] = [];
	// The call ledger contains only D1 methods, never SQL, bindings or timings.
	const record = (method: string) => {
		calls.push(method);
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
					record("first");
					return statement.first<T>();
				},
				all<T>() {
					record("all");
					return statement.all<T>();
				},
				run() {
					record("run");
					return statement.run();
				},
				raw<T>() {
					record("raw");
					return statement.raw<T>();
				},
			};
			originals.set(wrapped, statement);
			queries.set(wrapped, sql);
			return wrapped;
		},
		async batch(statements) {
			// One D1 call, not one call per statement executed inside the transaction. A batch
			// of reads only is a "readBatch"; any statement that writes makes it a "batch".
			const sqls = statements.map((statement) => queries.get(statement) ?? "");
			const writes = sqls.some((sql) => !f.db.prepare(sql).reader);
			record(writes ? "batch" : "readBatch");
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
		counts: () => ({ total: calls.length, methods: countBy(calls) }),
	};
}

function countBy(keys: string[]) {
	const counts: Record<string, number> = {};
	for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
	return counts;
}

deterministicReviewTests();
// The seed writes owner-resolution history on V2, then installs account management.
const test = backendTest("D1", { accountSchema: "v2" });
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
