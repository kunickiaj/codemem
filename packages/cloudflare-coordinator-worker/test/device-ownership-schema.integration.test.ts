import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, vi } from "vitest";
import {
	ownershipHarness,
	registerOwnershipContract,
} from "../../core/src/coordinator-device-ownership-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

describe("native D1 device ownership schema foundation", () => {
	const definitionSql =
		"SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'coordinator_device_ownership_bindings' AND sql IS NOT NULL ORDER BY type, name";
	let migratedDefinition: unknown[];
	beforeAll(async () => {
		migratedDefinition = (await env.COORDINATOR_DB.prepare(definitionSql).all()).results;
	});
	// Local D1 fixture reset uses DDL, never disabling the immutable-row triggers.
	const test = ownershipHarness(async (use) => {
		await env.COORDINATOR_DB.prepare("DROP TABLE coordinator_device_ownership_bindings").run();
		const migration = env.TEST_MIGRATIONS.find(
			(entry) => entry.name === "0028_add_device_ownership_bindings.sql",
		);
		if (!migration) throw new Error("Missing ownership fixture migration");
		await env.COORDINATOR_DB.batch(migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)));
		expect((await env.COORDINATOR_DB.prepare(definitionSql).all()).results).toEqual(
			migratedDefinition,
		);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store: new D1CoordinatorStore(env.COORDINATOR_DB),
				exec: async (sql, ...values) => {
					await env.COORDINATOR_DB.prepare(sql).bind(...values).run();
				},
				query: async (sql, ...values) => (await env.COORDINATOR_DB.prepare(sql).bind(...values).all()).results,
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await env.COORDINATOR_DB.batch([
				env.COORDINATOR_DB.prepare("DELETE FROM presence_records WHERE group_id = 'ownership-group'"),
				env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id = 'ownership-group'"),
				env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = 'ownership-group'"),
			]);
		}
	});
	registerOwnershipContract(test);
});
