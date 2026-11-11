import { expect } from "vitest";
import { controllerHistoryDiscoveryFragments } from "./coordinator-auth-controller-history.js";
import { readSnapshot } from "./coordinator-auth-read-set.js";
// The per-category statements the read set replaced, from their verbatim copy.
import {
	EVIDENCE_QUERIES,
	readEvidenceQuery,
} from "./coordinator-device-ownership-evidence-original-sql-test-fixtures.js";
import {
	cfg,
	collectInput,
	controller,
	EXPECTED_KEY_ID,
	evidenceBackend,
	evidenceTest,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";
import { discoveredReads, evidenceReads } from "./coordinator-owner-negative-reads.js";

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
	// Assert: this is the old scan shape, which the production-read test rejects.
	expect(leftJoinsPerBranch(plan)).toContain(2);
});

test.for([0, 250, 500])(
	"evidence reads isolate category scans and preserve legacy results with %i controllers",
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
		const subject = {
			...input.actualSigner,
			coordinatorId: cfg.coordinatorId,
			keyId: EXPECTED_KEY_ID,
		};
		const encoded = JSON.stringify({
			subject: {
				...subject,
				fragments: controllerHistoryDiscoveryFragments(input.actualSigner.publicKey),
			},
			legacyHistory: input.verifiedHistory,
		});
		const db = evidenceBackend(f, "SQLite");
		type Rows = Record<string, (string | null)[]>;
		// Act: use SQLite's actual planner and execution, without timing thresholds.
		const reads = evidenceReads({ subject, history: input.verifiedHistory });
		const first = await readSnapshot<Rows>(db, reads);
		const ids = (first.rows.discovery ?? []).flatMap((row) =>
			row === null ? [] : [JSON.parse(row) as [string, string]],
		);
		const discovered = discoveredReads(subject, {
			controllers: ids.filter(([source]) => source === "controller").map(([, id]) => id),
			invites: ids.filter(([source]) => source === "invite").map(([, id]) => id),
		});
		const captured: Rows = { ...first.rows, ...(await readSnapshot<Rows>(db, discovered)).rows };
		const legacy = await Promise.all(
			EVIDENCE_QUERIES.map((query) => db.all<{ row: string }>(readEvidenceQuery(query, encoded))),
		);
		// Assert: separate reads must preserve every category and row.
		for (const category of ["discovery", "controllers"]) {
			expect(captured[category]?.filter((row) => row !== null)).toHaveLength(count);
		}
		EVIDENCE_QUERIES.forEach(({ name }, index) => {
			expect(captured[name]).toEqual(legacy[index]?.map(({ row }) => row));
		});
		// Each category is its own read, so no read can revisit another category's rowset
		// for every one of its rows. Chained joins inside one read would still be nested scans.
		for (const read of Object.values({ ...reads, ...discovered })) {
			const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.values) as PlanRow[];
			expect(leftJoinsPerBranch(plan).every((joins) => joins <= 1)).toBe(true);
		}
	},
);
