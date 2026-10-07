import { describe, expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	type RevocationFixture,
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";
import {
	JOIN_NOW,
	joinSnapshot,
	joinTables,
	pendingJoin,
	registerJoinReviewContract,
	registerJoinWriteGuards,
} from "./coordinator-join-revocation-test-harness.js";
import { recipientGuardedD1 } from "./coordinator-recipient-revocation-test-harness.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

describe.each(["SQLite", "D1"] as const)("%s join review revocation", (backend) => {
	const databases = new WeakMap<RevocationFixture, ReturnType<typeof setupStore>>();
	const test = revocationHarness(async (use) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(JOIN_NOW));
		const local = setupStore(backend);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		const f: RevocationFixture = {
			store: local.store,
			input: revocationInput(),
			exec: async (sql, ...values) => {
				local.db.prepare(sql).run(...values);
			},
			rows: async (table) => {
				if (!joinTables.includes(table)) throw new Error("Unknown join fixture table");
				return local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
			},
		};
		databases.set(f, local);
		try {
			await use(f);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await local.store.close();
			if (local.db.open) local.db.close();
			vi.useRealTimers();
		}
	});
	registerJoinReviewContract(test);
	if (backend !== "D1") return;
	registerJoinWriteGuards(test, (f, hook) => {
		const local = databases.get(f);
		if (!local) throw new Error("Missing join fixture database");
		return recipientGuardedD1(sqliteD1(local.db), hook);
	});
	test("missing D1 receipts report incomplete without pretending committed writes rolled back", async ({
		fixture: f,
	}) => {
		// Arrange: execute the real atomic batch, but simulate an adapter losing its receipts.
		const { options } = await pendingJoin(f);
		const local = databases.get(f);
		if (!local) throw new Error("Missing join fixture database");
		const db = sqliteD1(local.db);
		const store = new D1CoordinatorStore({
			prepare: db.prepare,
			batch: async (statements) => {
				if (!db.batch) throw new Error("Missing fixture batch");
				await db.batch(statements);
				return [];
			},
		});
		// Act
		const pending = store.reviewJoinRequest(options);
		// Assert: uncertainty is an error, not an approval response or a rollback claim.
		await expect(pending).rejects.toThrow(/^join_review_incomplete$/);
		expect(await f.rows("coordinator_join_requests")).toMatchObject([{ status: "approved" }]);
		expect(await f.rows("enrolled_devices")).toHaveLength(2);
		expect(await f.rows("coordinator_bootstrap_grants")).toHaveLength(1);
	});
	for (const error of ["join_review_unavailable", "join_review_incomplete"]) {
		test(`admin API maps fixed ${error} to 503 without leaking details`, async ({ fixture: f }) => {
			// Arrange: error boundary test; real stores are covered by the shared contract.
			const { options } = await pendingJoin(f);
			const before = await joinSnapshot(f);
			const close = vi.spyOn(f.store, "close").mockResolvedValue();
			const review = vi.spyOn(f.store, "reviewJoinRequest").mockRejectedValue(new Error(error));
			const app = createCoordinatorApp({
				storeFactory: () => f.store,
				runtime: { adminSecret: () => "fixture-admin", now: () => JOIN_NOW },
				requestVerifier: vi.fn(async () => false),
			});
			try {
				// Act
				const response = await app.request("/v1/admin/join-requests/approve", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Codemem-Coordinator-Admin": "fixture-admin",
					},
					body: JSON.stringify({ request_id: options.requestId }),
				});
				// Assert
				expect(response.status).toBe(503);
				expect(await response.json()).toEqual({ error });
				expect(await joinSnapshot(f)).toEqual(before);
			} finally {
				review.mockRestore();
				close.mockRestore();
			}
		});
	}
});
