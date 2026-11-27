import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { TEAM_GROUP_BINDING_STORAGE_PRESENT_SQL } from "../../core/src/coordinator-team-group-bindings.js";
import {
	registerTeamGroupBindingContract,
	TEAM_GROUP_BINDING_CLOCK_MS,
	teamGroupBindingHarness,
} from "../../core/src/coordinator-team-group-bindings-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 Team group bindings", () => {
	it("has the storage that migration 0053 installs", async () => {
		const row = await env.COORDINATOR_DB.prepare(TEAM_GROUP_BINDING_STORAGE_PRESENT_SQL).first<{
			present: number;
		}>();

		expect(row?.present).toBe(1);
	});

	const test = teamGroupBindingHarness(async (use) => {
		const store = new D1CoordinatorStore(env.COORDINATOR_DB, {
			authClock: () => TEAM_GROUP_BINDING_CLOCK_MS,
		});
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store,
				prefix: `team-binding-native-${++sequence}`,
				exec: (sql, ...values) =>
					env.COORDINATOR_DB.prepare(sql)
						.bind(...values)
						.run(),
				count: async (sql, ...values) =>
					Number(
						Object.values(
							(await env.COORDINATOR_DB.prepare(sql)
								.bind(...values)
								.first()) ?? {},
						)[0],
					),
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
	registerTeamGroupBindingContract(test);
});
