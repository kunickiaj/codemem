import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import { peerRemovalApiHarness, registerPeerRemovalApiContract, checkValueBytes } from "../../core/src/coordinator-peer-removal-api-test-harness.js";
import { expectRemovalProgressListings } from "../../core/src/coordinator-removal-progress-listing-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { resetDeviceRemovals } from "./device-removal-reset.js";
import { verifyCloudflareCoordinatorRequest } from "../src/request-verifier.js";
import { DEVICE_REMOVAL_MIGRATION_NAME, ENROLLMENT_REMOVAL_MIGRATION_NAME } from "../../core/src/coordinator-device-removal.js";

describe("native D1 signed peer removal API", () => {
	let sequence = 0;
	const test = peerRemovalApiHarness(async (use) => {
		const db = env.COORDINATOR_DB;
		await resetDeviceRemovals(db, env.TEST_MIGRATIONS);
		const store = new D1CoordinatorStore(db);
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store, prefix: `peer-route-native-${++sequence}`, verifyRequest: verifyCloudflareCoordinatorRequest,
				freshStore: () => new D1CoordinatorStore(db),
				valueBound: async (action) => {
					const bytes: number[] = [];
					const original = db.prepare.bind(db);
					const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
						const statement = original(sql);
						const bind = statement.bind.bind(statement);
						statement.bind = (...values: unknown[]) => { checkValueBytes(values, bytes); return bind(...values); };
						return statement;
					});
					try { return { response: await action(), bytes }; }
					finally { spy.mockRestore(); }
				},
				restoreRemovalStorage: async () => {
					const migrations = env.TEST_MIGRATIONS.filter(({ name }) =>
						name === DEVICE_REMOVAL_MIGRATION_NAME || name === ENROLLMENT_REMOVAL_MIGRATION_NAME);
					expect(migrations).toHaveLength(2);
					await db.batch(migrations.flatMap(({ queries }) => queries).map((sql) => db.prepare(sql)));
				},
				exec: async (sql, ...values) => { await db.prepare(sql).bind(...values).run(); },
				rows: async <T>(sql: string, ...values: (string | number | null)[]) => (await db.prepare(sql).bind(...values).all<T>()).results,
				measure: async (action) => {
					const prepare = vi.spyOn(db, "prepare");
					try { return { response: await action(), sql: prepare.mock.calls.map(([sql]) => sql) }; }
					finally { prepare.mockRestore(); }
				},
			});
		} finally {
			try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
			finally { vi.restoreAllMocks(); await store.close(); }
		}
	});
	registerPeerRemovalApiContract(test);
	test("lists advertised removal progress even after presence expires", ({ fixture }) =>
		expectRemovalProgressListings(fixture),
	);
});
