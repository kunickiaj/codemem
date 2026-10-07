import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import { revocationHarness, revocationInput } from "../../core/src/coordinator-device-revocation-test-harness.js";
import { JOIN_NOW } from "../../core/src/coordinator-join-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { ownedJoinTables, registerOwnedJoinContract, registerOwnedJoinD1Guards } from "../../core/src/shared-owned-join-approval-test-harness.js";

describe("native D1 owned join approval", () => {
	const test = revocationHarness(async use => {
		// Recreate only this local immutable-ledger fixture, retaining production triggers.
		await env.COORDINATOR_DB.prepare("DROP TABLE IF EXISTS coordinator_device_ownership_bindings").run();
		const migration = env.TEST_MIGRATIONS.find(entry => entry.name === "0028_add_device_ownership_bindings.sql");
		if (!migration) throw new Error("Missing ownership fixture migration");
		await env.COORDINATOR_DB.batch(migration.queries.map(sql => env.COORDINATOR_DB.prepare(sql)));
		vi.useFakeTimers(); vi.setSystemTime(new Date(JOIN_NOW));
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store: new D1CoordinatorStore(env.COORDINATOR_DB), input: revocationInput("owned-join-native"),
				exec: async (sql, ...values) => { await env.COORDINATOR_DB.prepare(sql).bind(...values).run(); },
				rows: async table => {
					if (!ownedJoinTables.includes(table)) throw new Error("Unknown join fixture table");
					return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore(); vi.useRealTimers();
			await env.COORDINATOR_DB.batch([
				"DROP TRIGGER IF EXISTS join_owned_race",
				"DELETE FROM coordinator_bootstrap_grants", "DELETE FROM coordinator_join_requests",
				"DELETE FROM coordinator_device_revocations", "DELETE FROM enrolled_devices",
				"DELETE FROM groups WHERE group_id LIKE 'owned-join-native%'",
			].map(sql => env.COORDINATOR_DB.prepare(sql)));
		}
	});
	registerOwnedJoinContract(test);
	registerOwnedJoinD1Guards(test, () => env.COORDINATOR_DB);
});
