import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import { bootstrapRevocationTables, guardedBootstrapD1, registerBootstrapReceiptFailures, registerBootstrapRevocationContract, registerBootstrapStatementGuards } from "../../core/src/coordinator-bootstrap-revocation-test-harness.js";
import { contractHarness } from "../../core/src/coordinator-identity-group-grant-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 raw bootstrap grant revocation", () => {
	const test = contractHarness(async (use) => {
		const prefix = `bootstrap-revocation-native-${++sequence}`;
		const review = { coordinatorId: `${prefix}-coordinator`, identityId: `${prefix}-identity`, groupId: `${prefix}-group`, deviceId: `${prefix}-device`, attestationId: `${prefix}-attestation`, reviewReceiptId: `${prefix}-receipt`, publicKey: "opaque-bootstrap-key", fingerprint: "a".repeat(64), evidenceDigest: "b".repeat(64) };
		const db = env.COORDINATOR_DB;
		const store = new D1CoordinatorStore(db);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({ store, review, exec: async (sql, ...values) => { await db.prepare(sql).bind(...values).run(); }, rows: async (table) => {
				if (!bootstrapRevocationTables.includes(table)) throw new Error("Unknown fixture table");
				return (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
			} });
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await db.batch([
				db.prepare("DELETE FROM coordinator_bootstrap_grants WHERE group_id = ?").bind(review.groupId),
				db.prepare("DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ?").bind(review.groupId),
				db.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(review.groupId),
				db.prepare("DELETE FROM groups WHERE group_id = ?").bind(review.groupId),
			]);
		}
	});
	registerBootstrapRevocationContract(test);
	registerBootstrapReceiptFailures(test, () => env.COORDINATOR_DB);
	registerBootstrapStatementGuards(test, (_f, hook) => guardedBootstrapD1(env.COORDINATOR_DB, hook));
});
