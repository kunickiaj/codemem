import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import {
	authLinkGuardedD1,
	linkRevocationHarness,
	linkRevocationTables,
	NOW,
	registerAuthLinkAtomicGuards,
	registerAuthLinkRevocationContract,
} from "../../core/src/coordinator-auth-link-revocation-test-harness.js";
import { revocationInput } from "../../core/src/coordinator-device-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 account-link revocation", () => {
	const test = linkRevocationHarness(async (use) => {
		const input = revocationInput(`link-native-${++sequence}`);
		const clock = { now: NOW };
		const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => clock.now });
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store,
				input,
				get now() {
					return clock.now;
				},
				set now(value) {
					clock.now = value;
				},
				exec: async (sql, ...values) => {
					await env.COORDINATOR_DB.prepare(sql)
						.bind(...values)
						.run();
				},
				rows: async (table) => {
					if (!linkRevocationTables.includes(table as (typeof linkRevocationTables)[number]))
						throw new Error("Unknown account-link fixture table");
					return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
						.results;
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await env.COORDINATOR_DB.batch(
				linkRevocationTables.map((table) => {
					let column = "group_id";
					let value = input.groupId;
					if (table === "coordinator_device_revocations") column = "evidence_group_id";
					if (
						table === "coordinator_auth_link_attempts" ||
						table === "coordinator_auth_account_links" ||
						table === "coordinator_auth_link_audit_log"
					) {
						column = "coordinator_id";
						value = `${input.groupId}-coordinator`;
					}
					return env.COORDINATOR_DB.prepare(`DELETE FROM ${table} WHERE ${column} IN (?, ?)`).bind(
						value,
						`${value}-seed`,
					);
				}),
			);
		}
	});
	registerAuthLinkRevocationContract(test);
	registerAuthLinkAtomicGuards(test, (f, gate) =>
		authLinkGuardedD1(env.COORDINATOR_DB, gate, () => f.now),
	);
});
