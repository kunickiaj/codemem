import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { TEAM_MEMBER_REMOVAL_STORAGE_PRESENT_SQL } from "../../core/src/coordinator-team-member-removals.js";
import {
	registerTeamMemberRemovalContract,
	TEAM_MEMBER_REMOVAL_CLOCK_MS,
	teamMemberRemovalHarness,
} from "../../core/src/coordinator-team-member-removals-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 Team member removals", () => {
	it("has the storage that migration 0052 installs", async () => {
		const row = await env.COORDINATOR_DB.prepare(TEAM_MEMBER_REMOVAL_STORAGE_PRESENT_SQL).first<{
			present: number;
		}>();

		expect(row?.present).toBe(1);
	});

	const test = teamMemberRemovalHarness(async (use) => {
		const store = new D1CoordinatorStore(env.COORDINATOR_DB, {
			authClock: () => TEAM_MEMBER_REMOVAL_CLOCK_MS,
		});
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store,
				prefix: `team-removal-native-${++sequence}`,
				exec: (sql, ...values) =>
					env.COORDINATOR_DB.prepare(sql)
						.bind(...values)
						.run(),
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
	registerTeamMemberRemovalContract(test);
});
