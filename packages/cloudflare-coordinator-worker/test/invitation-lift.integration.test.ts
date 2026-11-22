import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import {
	revocationHarness,
	revocationInput,
} from "../../core/src/coordinator-device-revocation-test-harness.js";
import {
	LIFT_NOW,
	liftTables,
	registerInvitationLiftContract,
} from "../../core/src/coordinator-invitation-lift-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { verifyCloudflareCoordinatorRequest } from "../src/request-verifier.js";
import { resetDeviceRemovals } from "./device-removal-reset.js";

let sequence = 0;
describe("native D1 signed invitation removal lift", () => {
	const test = revocationHarness(async (use) => {
		await resetDeviceRemovals(env.COORDINATOR_DB, env.TEST_MIGRATIONS);
		await env.COORDINATOR_DB.batch(
			[
				"coordinator_scope_membership_effect_receipts",
				"coordinator_scope_membership_audit_log",
				"coordinator_scope_memberships",
				"coordinator_scopes",
				"coordinator_bootstrap_grants",
				"coordinator_device_revocations",
				"request_nonces",
				"groups",
			].map((table) => env.COORDINATOR_DB.prepare(`DELETE FROM ${table}`)),
		);
		const store = new D1CoordinatorStore(env.COORDINATOR_DB, {
			authClock: () => Date.parse(LIFT_NOW),
		});
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store,
				input: revocationInput(`invitation-lift-native-${++sequence}`),
				exec: async (sql, ...values) => {
					await env.COORDINATOR_DB.prepare(sql).bind(...values).run();
				},
				rows: async (table) => {
					if (!liftTables.includes(table)) throw new Error("Unknown lift fixture table");
					return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
						.results;
				},
			});
		} finally {
			expect(fetch).not.toHaveBeenCalled();
			vi.restoreAllMocks();
			await store.close();
		}
	});
	registerInvitationLiftContract(test, verifyCloudflareCoordinatorRequest);
});
