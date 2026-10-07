import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import {
	revocationHarness,
	revocationInput,
} from "../../core/src/coordinator-device-revocation-test-harness.js";
import {
	JOIN_NOW,
	joinTables,
	registerJoinReviewContract,
	registerJoinWriteGuards,
} from "../../core/src/coordinator-join-revocation-test-harness.js";
import { recipientGuardedD1 } from "../../core/src/coordinator-recipient-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 join review revocation", () => {
	const test = revocationHarness(async (use) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(JOIN_NOW));
		const input = revocationInput(`join-native-${++sequence}`);
		const store = new D1CoordinatorStore(env.COORDINATOR_DB);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store,
				input,
				exec: async (sql, ...values) => {
					await env.COORDINATOR_DB.prepare(sql).bind(...values).run();
				},
				rows: async (table) => {
					if (!joinTables.includes(table)) throw new Error("Unknown join fixture table");
					return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
						.results;
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			vi.useRealTimers();
			await env.COORDINATOR_DB.batch([
				env.COORDINATOR_DB.prepare("DROP TRIGGER IF EXISTS join_failure"),
				env.COORDINATOR_DB.prepare("DELETE FROM coordinator_bootstrap_grants"),
				env.COORDINATOR_DB.prepare("DELETE FROM coordinator_join_requests"),
				env.COORDINATOR_DB.prepare("DELETE FROM coordinator_device_revocations"),
				env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices"),
				env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id LIKE ?").bind(
					`${input.groupId}%`,
				),
			]);
		}
	});
	registerJoinReviewContract(test);
	registerJoinWriteGuards(test, (_f, hook) => recipientGuardedD1(env.COORDINATOR_DB, hook));
});
