import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import {
	REMOVAL_CLOCK_MS,
	registerDeviceRemovalContract,
	removalHarness,
} from "../../core/src/coordinator-device-removal-test-harness.js";
import { registerEnrollmentWriterContract } from "../../core/src/coordinator-device-removal-writer-test-harness.js";
import {
	recipientGuardedD1,
} from "../../core/src/coordinator-recipient-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { dropEnrollmentRemovalTriggers, resetDeviceRemovals } from "./device-removal-reset.js";

let sequence = 0;
describe("native D1 device removal", () => {
	const test = removalHarness(async (use) => {
		const db = env.COORDINATOR_DB;
		await resetDeviceRemovals(db, env.TEST_MIGRATIONS);
		const store = new D1CoordinatorStore(db, { authClock: () => REMOVAL_CLOCK_MS });
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store,
				prefix: `removal-native-${++sequence}`,
				exec: async (sql, ...values) => {
					await db.prepare(sql).bind(...values).run();
				},
				rows: async <T>(sql: string, ...values: unknown[]) =>
					(await db.prepare(sql).bind(...values).all<T>()).results,
				interleave: (before, change) => {
					let done = false;
					return recipientGuardedD1(db, async (writes) => {
						if (done || !writes.some(({ query }) => before.some((text) => query.includes(text))))
							return;
						done = true;
						for (const { sql, values } of change) await db.prepare(sql).bind(...values).run();
					});
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await dropEnrollmentRemovalTriggers(db);
		}
	});
	registerDeviceRemovalContract(test);
	registerEnrollmentWriterContract(test);
});
