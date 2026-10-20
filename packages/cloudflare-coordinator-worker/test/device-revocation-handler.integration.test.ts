import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import { registerDeviceRevocationHandlerContract } from "../../core/src/coordinator-device-revocation-handler-test-harness.js";
import { revocationHarness, revocationInput, revocationSideEffectTables } from "../../core/src/coordinator-device-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

describe("native D1 inactive operator revocation handler", () => {
	const test = revocationHarness(async use => {
		let tick = 0;
		const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => 1791244800000 + tick++ });
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		const tables = [...revocationSideEffectTables, "coordinator_device_revocations", "request_nonces", "sqlite_master"];
		try {
			await use({ store, input: revocationInput(),
				exec: async (sql, ...values) => { await env.COORDINATOR_DB.prepare(sql).bind(...values).run(); },
				rows: async table => {
					if (!tables.includes(table)) throw new Error("Unknown fixture table");
					return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			await env.COORDINATOR_DB.batch([
				...tables.filter(table => table !== "sqlite_master").reverse().map(table => env.COORDINATOR_DB.prepare(`DELETE FROM ${table}`)),
			]);
		}
	});
	registerDeviceRevocationHandlerContract(test);
});
