import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import {
	BOUNDARY_READINESS_CLOCK_MS,
	boundaryReadinessHarness,
	registerBoundaryReadinessContract,
} from "../../core/src/coordinator-boundary-readiness-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 readiness records", () => {
	const test = boundaryReadinessHarness(async (use) => {
		const store = new D1CoordinatorStore(env.COORDINATOR_DB, {
			authClock: () => BOUNDARY_READINESS_CLOCK_MS,
		});
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({ store, prefix: `readiness-native-${++sequence}`, exec:async(sql,...params)=>{await env.COORDINATOR_DB.prepare(sql).bind(...params).run();} });
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
	registerBoundaryReadinessContract(test);
});
