import { env } from "cloudflare:workers";
import { describe, vi } from "vitest";
import {
	keyIdFillApiHarness,
	registerKeyIdFillApiContract,
} from "../../core/src/coordinator-key-id-fill-api-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { resetDeviceRemovals } from "./device-removal-reset.js";

describe("native D1 key ID fill API", () => {
	const test = keyIdFillApiHarness(async (use) => {
		await resetDeviceRemovals(env.COORDINATOR_DB, env.TEST_MIGRATIONS);
		const store = new D1CoordinatorStore(env.COORDINATOR_DB);
		try {
			await use({
				store,
				exec: async (sql) => {
					await env.COORDINATOR_DB.prepare(sql).run();
				},
			});
		} finally {
			vi.restoreAllMocks();
			await store.close();
		}
	});
	registerKeyIdFillApiContract(test);
});
