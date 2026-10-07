import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import {
	controllerGuardedD1,
	controllerTables,
	registerControllerReadWriteGuards,
	registerControllerRevocationContract,
} from "../../core/src/coordinator-controller-revocation-test-harness.js";
import {
	revocationHarness,
	revocationInput,
} from "../../core/src/coordinator-device-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 controller revocation", () => {
	const test = revocationHarness(async (use) => {
		const input = revocationInput(`controller-native-${++sequence}`);
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
					if (!controllerTables.includes(table)) throw new Error("Unknown controller fixture table");
					return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
						.results;
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await env.COORDINATOR_DB.batch([
				...controllerTables.map((table) => {
					let column = "group_id";
					let value = input.groupId;
					if (table === "coordinator_device_revocations") column = "evidence_group_id";
					if (
						table.startsWith("coordinator_auth_") &&
						table !== "coordinator_auth_controller_attestations"
					) {
						column = "coordinator_id";
						value = `${input.groupId}-coordinator`;
					}
					return env.COORDINATOR_DB.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(value);
				}),
				env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = ?").bind(input.groupId),
			]);
		}
	});
	registerControllerRevocationContract(test);
	registerControllerReadWriteGuards(test, (_f, gate) => controllerGuardedD1(env.COORDINATOR_DB, gate));
});
