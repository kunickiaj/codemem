import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import {
	revocationHarness,
	revocationInput,
} from "../../core/src/coordinator-device-revocation-test-harness.js";
import {
	projectGuardedD1,
	registerProjectRevocationContract,
	registerProjectWriteGuards,
} from "../../core/src/coordinator-project-revocation-test-harness.js";
import { recipientTables } from "../../core/src/coordinator-recipient-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 project revocation", () => {
	const test = revocationHarness(async (use) => {
		const input = revocationInput(`project-native-${++sequence}`);
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
					if (!recipientTables.includes(table)) throw new Error("Unknown project fixture table");
					return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
						.results;
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await env.COORDINATOR_DB.batch([
				...recipientTables.map((table) =>
					env.COORDINATOR_DB.prepare(
						`DELETE FROM ${table} WHERE ${table === "coordinator_device_revocations" ? "evidence_group_id" : "group_id"} = ?`,
					).bind(input.groupId),
				),
				env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = ?").bind(input.groupId),
			]);
		}
	});
	registerProjectRevocationContract(test);
	registerProjectWriteGuards(test, (_f, hook, afterBatch) =>
		projectGuardedD1(env.COORDINATOR_DB, hook, afterBatch),
	);
});
