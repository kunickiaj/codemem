import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import {
	revocationHarness,
	revocationInput,
} from "../../core/src/coordinator-device-revocation-test-harness.js";
import {
	recipientGuardedD1,
	recipientTables,
	registerRecipientRevocationContract,
	registerRecipientWriteGuards,
} from "../../core/src/coordinator-recipient-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 recipient revocation", () => {
	const test = revocationHarness(async (use) => {
		const input = revocationInput(`recipient-native-${++sequence}`);
		const store = new D1CoordinatorStore(env.COORDINATOR_DB);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store,
				input,
				exec: async (sql, ...values) => {
					await env.COORDINATOR_DB.prepare(sql)
						.bind(...values)
						.run();
				},
				rows: async (table) => {
					if (!recipientTables.includes(table)) throw new Error("Unknown recipient fixture table");
					return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
						.results;
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await env.COORDINATOR_DB.batch([
				env.COORDINATOR_DB.prepare(
					"DELETE FROM coordinator_bootstrap_grants WHERE group_id = ?",
				).bind(input.groupId),
				env.COORDINATOR_DB.prepare("DELETE FROM coordinator_invites WHERE group_id = ?").bind(
					input.groupId,
				),
				env.COORDINATOR_DB.prepare(
					"DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ?",
				).bind(input.groupId),
				env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(
					input.groupId,
				),
				env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = ?").bind(input.groupId),
			]);
		}
	});
	registerRecipientRevocationContract(test);
	registerRecipientWriteGuards(test, (_f, hook) => recipientGuardedD1(env.COORDINATOR_DB, hook));
});
