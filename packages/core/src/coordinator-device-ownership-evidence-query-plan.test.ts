import { expect } from "vitest";
import { controllerHistoryDiscoveryFragments } from "./coordinator-auth-controller-history.js";
import {
	type CapturedEvidenceRow,
	EVIDENCE_QUERIES,
	readCombinedEvidenceQuery,
	readEvidenceQuery,
} from "./coordinator-device-ownership-evidence-queries.js";
import {
	cfg,
	collectInput,
	controller,
	EXPECTED_KEY_ID,
	evidenceBackend,
	evidenceTest,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";

interface PlanRow {
	parent: number;
	detail: string;
}

function leftJoinsPerBranch(plan: PlanRow[]): number[] {
	const counts = new Map<number, number>();
	for (const { parent, detail } of plan) {
		if (!detail.includes("LEFT-JOIN")) continue;
		counts.set(parent, (counts.get(parent) ?? 0) + 1);
	}
	return [...counts.values()];
}

const test = evidenceTest("SQLite");

test("the planner guard detects category-conditioned nested scans", ({ f }) => {
	// Arrange: even mutually exclusive categories leave both scans in one loop nest.
	const sql = `WITH categories(category) AS (VALUES ('discovery'), ('controllers')),
	 selected_discovery(row) AS MATERIALIZED (VALUES ('discovery-row')),
	 selected_controllers(row) AS MATERIALIZED (VALUES ('controller-row'))
	 SELECT category, d.row, c.row FROM categories
	 LEFT JOIN selected_discovery d ON category='discovery'
	 LEFT JOIN selected_controllers c ON category='controllers'`;
	// Act
	const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as PlanRow[];
	// Assert: this is the old scan shape, which the production-query test rejects.
	expect(leftJoinsPerBranch(plan)).toContain(2);
});

test.for([0, 250, 500])(
	"combined evidence isolates category scans and preserves legacy results with %i controllers",
	async (count, { f }) => {
		// Arrange: discovery and controllers both reach count, rather than testing one large category.
		f.db.transaction(() => {
			for (let index = 0; index < count; index++) {
				controller(f, {
					attestation_id: `controller-${index}`,
					review_receipt_id: `receipt-${index}`,
					group_id: `retained-${index}`,
				});
			}
		})();
		const input = await collectInput(f);
		const encoded = JSON.stringify({
			subject: {
				...input.actualSigner,
				coordinatorId: cfg.coordinatorId,
				keyId: EXPECTED_KEY_ID,
				fragments: controllerHistoryDiscoveryFragments(input.actualSigner.publicKey),
			},
			legacyHistory: input.verifiedHistory,
		});
		const db = evidenceBackend(f, "SQLite");
		const combined = readCombinedEvidenceQuery(encoded);
		// Act: use SQLite's actual planner and execution, without timing thresholds.
		const plan = f.db
			.prepare(`EXPLAIN QUERY PLAN ${combined.sql}`)
			.all(...combined.values) as PlanRow[];
		const captured = await db.all<CapturedEvidenceRow>(combined);
		const legacy = await Promise.all(
			EVIDENCE_QUERIES.map((query) => db.all<{ row: string }>(readEvidenceQuery(query, encoded))),
		);
		// Assert: independent branches must preserve every category, count, and empty marker.
		for (const category of ["discovery", "controllers"]) {
			expect(captured.filter((row) => row.category === category && row.row !== null)).toHaveLength(
				count,
			);
		}
		EVIDENCE_QUERIES.forEach(({ name }, index) => {
			const rows = legacy[index];
			expect(captured.filter(({ category }) => category === name)).toEqual(
				(rows.length ? rows : [{ row: null }]).map(({ row }) => ({
					category: name,
					row_count: rows.length,
					row,
				})),
			);
		});
		// Sibling joins in one SELECT are nested scans. Category conditions do not
		// prevent SQLite from revisiting a later rowset for every earlier row.
		// One empty-marker LEFT JOIN per branch is safe, but chained categories are not.
		const joinsPerBranch = leftJoinsPerBranch(plan);
		expect(joinsPerBranch).toHaveLength(EVIDENCE_QUERIES.length);
		expect(joinsPerBranch.every((joins) => joins <= 1)).toBe(true);
	},
);
