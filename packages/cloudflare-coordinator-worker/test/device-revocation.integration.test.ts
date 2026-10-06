import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import {
	registerDeviceRevocationContract, revocationHarness, revocationInput,
	revocationSideEffectTables,
} from "../../core/src/coordinator-device-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 device revocation and nonce admission", () => {
	const test = revocationHarness(async use => {
		const input = revocationInput(`revocation-native-${++sequence}`);
		const cleanupGroupPattern = `${input.groupId}%`;
		let clockTick = 0;
		const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => 1791244800000 + clockTick++ });
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		const tables = [...revocationSideEffectTables, "coordinator_device_revocations", "request_nonces"];
		try {
			await use({ store, input,
				exec: async (sql, ...values) => { await env.COORDINATOR_DB.prepare(sql).bind(...values).run(); },
				rows: async table => {
					if (!tables.includes(table)) throw new Error("Unknown fixture table");
					return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await env.COORDINATOR_DB.batch([
				env.COORDINATOR_DB.prepare("DELETE FROM coordinator_identity_group_grants WHERE group_id LIKE ?").bind(cleanupGroupPattern),
				env.COORDINATOR_DB.prepare("DELETE FROM coordinator_auth_controller_attestations WHERE group_id LIKE ?").bind(cleanupGroupPattern),
				env.COORDINATOR_DB.prepare("DELETE FROM coordinator_device_revocations"),
				env.COORDINATOR_DB.prepare("DELETE FROM request_nonces"),
				env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id LIKE ?").bind(cleanupGroupPattern),
				env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id LIKE ?").bind(cleanupGroupPattern),
			]);
		}
	});
	registerDeviceRevocationContract(test);
});
