import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
		for (const name of [
			"0028_add_device_ownership_bindings.sql",
			"0039_guard_device_ownership_rowid.sql",
		]) {
			const migration = env.TEST_MIGRATIONS.find((entry) => entry.name === name);
			if (!migration) throw new Error(`Missing ownership fixture migration ${name}`);
			await env.COORDINATOR_DB.batch(
				migration.queries.map((sql) => env.COORDINATOR_DB.prepare(sql)),
			);
		}
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

describe("native D1 device ownership rowid guard", () => {
	it("rejects a REPLACE that reuses a binding's rowid with fresh keys", async () => {
		// Arrange
		const db = env.COORDINATOR_DB;
		const values = (suffix: string) => [
			`rowid-device-${suffix}`,
			suffix.repeat(64).slice(0, 64),
			`identity-${suffix}`,
			"coordinator-a",
			`rowid-binding-${suffix}`,
			"owner_enrollment",
			`rebind:${suffix}`,
			"2026-10-26T00:00:00Z",
		];
		const columns = `device_id, key_id, identity_id, coordinator_id, binding_id, provenance,
		 source_ref, bound_at`;
		await db
			.prepare(`INSERT INTO coordinator_device_ownership_bindings (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(...values("e"))
			.run();
		const rowid = await db
			.prepare("SELECT rowid FROM coordinator_device_ownership_bindings WHERE device_id = 'rowid-device-e'")
			.first<number>("rowid");
		// Act
		const replace = db
			.prepare(`INSERT OR REPLACE INTO coordinator_device_ownership_bindings (rowid, ${columns})
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(rowid, ...values("f"))
			.run();
		// Assert
		await expect(replace).rejects.toThrow("device_ownership_collision");
		const kept = await db
			.prepare("SELECT device_id FROM coordinator_device_ownership_bindings WHERE rowid = ?")
			.bind(rowid)
			.first<string>("device_id");
		expect(kept).toBe("rowid-device-e");
	});
});
