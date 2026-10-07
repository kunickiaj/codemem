import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import { revocationHarness, revocationInput } from "../../core/src/coordinator-device-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { registerOwnedRecipientD1 } from "../../core/src/owned-recipient-d1-test-harness.js";
import { ownedRecipientTables, registerOwnedRecipientContract } from "../../core/src/shared-owned-recipient-invites-test-harness.js";

let sequence = 0;
describe("native D1 owned recipient invites (raw retained bindings, not owner proof)", () => {
	const test = revocationHarness(async (use) => {
		// Fixture-only reset: retained ledger intentionally has immutable rows.
		await env.COORDINATOR_DB.prepare("DROP TABLE IF EXISTS coordinator_device_ownership_bindings").run();
		const migration = env.TEST_MIGRATIONS.find((entry) => entry.name === "0028_add_device_ownership_bindings.sql");
		if (!migration) throw new Error("Missing ownership fixture migration");
		await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
		const input = revocationInput(`owned-recipient-native-${++sequence}`);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store: new D1CoordinatorStore(env.COORDINATOR_DB), input,
				exec: async (sql, ...values) => { await env.COORDINATOR_DB.prepare(sql).bind(...values).run(); },
				rows: async (table) => {
					if (!ownedRecipientTables.includes(table)) throw new Error("Unknown recipient fixture table");
					return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await env.COORDINATOR_DB.batch([
				env.COORDINATOR_DB.prepare("DELETE FROM coordinator_bootstrap_grants WHERE group_id = ?").bind(input.groupId),
				env.COORDINATOR_DB.prepare("DELETE FROM coordinator_invites WHERE group_id = ?").bind(input.groupId),
				env.COORDINATOR_DB.prepare("DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ?").bind(input.groupId),
				env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(input.groupId),
				env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = ?").bind(input.groupId),
			]);
		}
	});
	registerOwnedRecipientContract(test);
	registerOwnedRecipientD1(test, () => env.COORDINATOR_DB);
});
