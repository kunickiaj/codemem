import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import { registerGrantInputTests } from "../../core/src/coordinator-identity-group-grant-input-test-harness.js";
import {
	contractHarness,
	grantSideEffectTables,
	registerIdentityGroupGrantContract,
} from "../../core/src/coordinator-identity-group-grant-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { IDENTITY_GROUP_GRANT_RETRY_SQL } from "../../core/src/coordinator-identity-group-grant.js";

let sequence = 0;
describe("native D1 identity group grant contract", () => {
	const test = contractHarness(async (use) => {
		const prefix = `grant-native-${++sequence}`;
		const review = {
			coordinatorId: `${prefix}-coordinator`, identityId: `${prefix}-identity`,
			groupId: `${prefix}-group`, deviceId: `${prefix}-device`,
			attestationId: `${prefix}-attestation`, reviewReceiptId: `${prefix}-receipt`,
			publicKey: "fixture-reviewed-key", fingerprint: "a".repeat(64), evidenceDigest: "b".repeat(64),
		};
		const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => 1791028800000 });
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store, review,
				exec: async (sql, ...values) => {
					await env.COORDINATOR_DB.prepare(sql).bind(...values).run();
				},
				rows: async (table) => {
					if (!grantSideEffectTables.includes(table) && table !== "coordinator_identity_group_grants") {
						throw new Error("Unknown fixture table");
					}
					return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await env.COORDINATOR_DB.batch([
				...["coordinator_identity_group_grants", "coordinator_auth_controller_attestations", "coordinator_scope_membership_effect_receipts"].map((table) =>
					env.COORDINATOR_DB.prepare(`DELETE FROM ${table} WHERE coordinator_id = ? OR coordinator_id = ?`)
						.bind(review.coordinatorId, `${review.coordinatorId}-other`)),
				env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id LIKE ?").bind(`${review.groupId}%`),
				env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id LIKE ?").bind(`${review.groupId}%`),
			]);
		}
	});
	registerIdentityGroupGrantContract(test);
	registerGrantInputTests(test);
	test("propagates a simulated retry read failure and recovers the unchanged native D1 grant", async ({ fixture: f }) => {
		// Arrange: only the local adapter's retry read fails, not the native database.
		await f.store.createGroup(f.review.groupId);
		await f.store.enrollDevice(f.review.groupId, {
			deviceId: f.review.deviceId, publicKey: f.review.publicKey, fingerprint: f.review.fingerprint,
		});
		await f.store.createAuthControllerAttestation(f.review);
		const input = { coordinatorId: f.review.coordinatorId, attestationId: f.review.attestationId };
		await f.store.issueIdentityGroupGrantFromControllerAttestation(input);
		const before = await f.store.listIdentityGroupGrantRevisions(f.review);
		const faulting = new D1CoordinatorStore({ prepare(query) {
			if (query === IDENTITY_GROUP_GRANT_RETRY_SQL) throw new Error("test native D1 retry read failure");
			return env.COORDINATOR_DB.prepare(query);
		} });
		// Act
		const pending = faulting.issueIdentityGroupGrantFromControllerAttestation(input);
		// Assert: no error is converted into an existing-authority response.
		await expect(pending).rejects.toThrow("test native D1 retry read failure");
		expect(await f.store.issueIdentityGroupGrantFromControllerAttestation(input)).toEqual({ kind: "existing", grant: before[0] });
		expect(await f.store.listIdentityGroupGrantRevisions(f.review)).toEqual(before);
	});
});
