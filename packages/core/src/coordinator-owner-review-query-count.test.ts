import { expect } from "vitest";
import { backendTest, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	atomicEvidenceQuery,
	type CapturedEvidenceRow,
	EVIDENCE_QUERIES,
	readCombinedEvidenceQuery,
	readEvidenceQuery,
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

const categories = new Map([
	[atomicEvidenceQuery("").sql, "evidence:atomic"],
	[readCombinedEvidenceQuery("").sql, "evidence:snapshot"],
]);

async function readLegacySnapshot(adapter: D1DatabaseLike, encoded: string) {
	const rows: CapturedEvidenceRow[] = [];
	const categoryCalls: string[] = [];
	for (const query of EVIDENCE_QUERIES) {
		const { sql, values } = readEvidenceQuery(query, encoded);
		const result = await adapter
			.prepare(sql)
			.bind(...values)
			.all<{ row: string | null }>();
		categoryCalls.push(query.name);
		const selected = result.results ?? [];
		const marked = selected.length ? selected : [{ row: null }];
		rows.push(
			...marked.map(({ row }) => ({ category: query.name, row_count: selected.length, row })),
		);
	}
	rows.sort((a, b) => (a.category < b.category ? -1 : Number(a.category > b.category)));
	return { rows, categoryCalls };
}

function measuredStore(f: LinkFixture) {
	const adapter = sqliteD1(f.db);
	const originals = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
	let calls: { method: string; category: string }[] = [];
	let snapshots: {
		combined: CapturedEvidenceRow[];
		legacy: Awaited<ReturnType<typeof readLegacySnapshot>>;
	}[] = [];
	// The call ledger contains only static classifications, never bindings or timings.
	const record = (method: string, sql: string) => {
		calls.push({ method, category: categories.get(sql) ?? "review:other" });
	};
	const db: D1DatabaseLike = {
		prepare(sql) {
			const statement = adapter.prepare(sql);
			let bindings: unknown[] = [];
			const wrapped: D1PreparedStatementLike = {
				bind(...values) {
					bindings = values;
					statement.bind(...values);
					return wrapped;
				},
				first<T>() {
					record("first", sql);
					return statement.first<T>();
				},
				async all<T>() {
					record("all", sql);
					if (categories.get(sql) === "evidence:snapshot") {
						// Replay only evidence reads on the same fixture before any writes.
						// Reference calls are separate from the production operation's ledger.
						const legacy = await readLegacySnapshot(adapter, String(bindings[0]));
						const result = await statement.all<CapturedEvidenceRow>();
						snapshots.push({ combined: result.results ?? [], legacy });
						return result as { results?: T[] };
					}
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
			snapshots = [];
		},
		counts: () => ({
			total: calls.length,
			methods: countBy(calls.map(({ method }) => method)),
			categories: countBy(calls.map(({ category }) => category)),
			snapshots,
		}),
	};
}

function countBy(keys: string[]) {
	const counts: Record<string, number> = {};
	for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
	return counts;
}

function expectEvidenceReduction(
	counts: ReturnType<ReturnType<typeof measuredStore>["counts"]>,
	options: { collections: number; fewerReads: number; atomicRechecks: number },
) {
	expect(counts.categories["evidence:snapshot"]).toBe(options.collections);
	expect(counts.categories["evidence:atomic"]).toBe(options.atomicRechecks);
	expect(counts.snapshots).toHaveLength(options.collections);
	for (const { combined, legacy } of counts.snapshots) {
		expect(legacy.categoryCalls).toEqual(EVIDENCE_QUERIES.map(({ name }) => name));
		expect(legacy.categoryCalls).toHaveLength(12);
		expect(combined).toEqual(legacy.rows);
		expect(combined.some(({ row_count, row }) => row_count === 0 && row === null)).toBe(true);
		expect(combined.some(({ row_count }) => row_count > 0)).toBe(true);
	}
	const legacyReads = counts.snapshots.reduce(
		(sum, { legacy }) => sum + legacy.categoryCalls.length,
		0,
	);
	// Compare executed evidence reads only, excluding schema checks and unrelated review I/O.
	expect(legacyReads - counts.categories["evidence:snapshot"]).toBe(options.fewerReads);
}

deterministicReviewTests();
const test = backendTest("D1");
for (const reused of [false, true]) {
	test(`one snapshot replaces twelve category reads for ${reused ? "reused" : "new"} scoped owner receipts`, async ({
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
		// Act: confirmation includes its own preview preparation and a second collection.
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
		expectEvidenceReduction(previewCalls, { collections: 1, fewerReads: 11, atomicRechecks: 2 });
		expectEvidenceReduction(confirmationCalls, {
			collections: 2,
			fewerReads: 22,
			atomicRechecks: 3,
		});
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
