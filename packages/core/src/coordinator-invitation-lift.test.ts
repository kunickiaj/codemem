import { describe, expect, vi } from "vitest";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";
import {
	LIFT_NOW,
	liftTables,
	registerInvitationLiftContract,
} from "./coordinator-invitation-lift-test-harness.js";
import { verifySignature } from "./sync-auth.js";

describe.each(["SQLite", "D1"] as const)("%s signed invitation removal lift", (backend) => {
	const test = revocationHarness(async (use) => {
		const local = setupStore(backend, { authClock: () => Date.parse(LIFT_NOW) });
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store: local.store,
				input: revocationInput("invitation-lift"),
				exec: async (sql, ...values) => {
					local.db.prepare(sql).run(...values);
				},
				rows: async (table) => {
					if (!liftTables.includes(table)) throw new Error("Unknown lift fixture table");
					return local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
				},
			});
		} finally {
			expect(fetch).not.toHaveBeenCalled();
			vi.restoreAllMocks();
			await local.store.close();
			if (local.db.open) local.db.close();
		}
	});
	registerInvitationLiftContract(test, (input) =>
		verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
	);
});
