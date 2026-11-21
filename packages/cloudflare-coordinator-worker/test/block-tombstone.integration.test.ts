import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import { registerBlockTombstoneContract } from "../../core/src/coordinator-block-tombstone-test-harness.js";
import { revocationHarness, revocationInput } from "../../core/src/coordinator-device-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { resetDeviceRemovals } from "./device-removal-reset.js";

describe("native D1 operator block from tombstone", () => {
	const test = revocationHarness(async (use) => {
		const db = env.COORDINATOR_DB;
		await resetDeviceRemovals(db, env.TEST_MIGRATIONS);
		await db.prepare("DELETE FROM coordinator_device_revocations").run();
		const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store: new D1CoordinatorStore(db),
				input: revocationInput("block-tombstone"),
				exec: async (sql, ...values) => { await db.prepare(sql).bind(...values).run(); },
				rows: async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results,
			});
			expect(network).not.toHaveBeenCalled();
		} finally {
			network.mockRestore();
		}
	});
	registerBlockTombstoneContract(test);
});
