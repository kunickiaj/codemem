import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import { contractHarness } from "../../core/src/coordinator-identity-group-grant-test-harness.js";
import { grantRevocationTables, guardedGrantD1, registerIdentityGrantRevocationContract, registerIdentityGrantStatementGuards } from "../../core/src/coordinator-identity-grant-revocation-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 identity grant source revocation", () => {
	const test = contractHarness(async (use) => {
		const prefix = `grant-revocation-native-${++sequence}`;
		const review = { coordinatorId: `${prefix}-coordinator`, identityId: `${prefix}-identity`, groupId: `${prefix}-group`, deviceId: `${prefix}-device`, attestationId: `${prefix}-attestation`, reviewReceiptId: `${prefix}-receipt`, publicKey: "opaque-grant-fixture", fingerprint: "a".repeat(64), evidenceDigest: "b".repeat(64) };
		// Acquire the binding inside this fixture's request lifetime, never at module scope.
		const db = env.COORDINATOR_DB;
		const store = new D1CoordinatorStore(db, { authClock: () => 1791028800000 });
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({ store, review, exec: async (sql, ...values) => { await db.prepare(sql).bind(...values).run(); }, rows: async (table) => {
				if (!grantRevocationTables.includes(table)) throw new Error("Unknown fixture table");
				return (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
			} });
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await db.batch([
				...["coordinator_identity_group_grants", "coordinator_auth_controller_attestations"].map((table) => db.prepare(`DELETE FROM ${table} WHERE coordinator_id = ? OR coordinator_id = ?`).bind(review.coordinatorId, `${review.coordinatorId}-other`)),
				db.prepare("DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ?").bind(review.groupId),
				db.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(review.groupId),
				db.prepare("DELETE FROM groups WHERE group_id = ?").bind(review.groupId),
			]);
		}
	});
	registerIdentityGrantRevocationContract(test);
	registerIdentityGrantStatementGuards(test, (_f, hook) => guardedGrantD1(env.COORDINATOR_DB, hook));
});
