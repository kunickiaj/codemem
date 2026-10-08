import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import { contractHarness } from "../../core/src/coordinator-identity-group-grant-test-harness.js";
import { registerScopeApiQueryBudget, registerScopeAuthorizationApi, scopeApiNowMs } from "../../core/src/coordinator-scope-authorization-api-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 signed public scope API", () => {
	const test = contractHarness(async (use) => {
		const prefix = `scope-api-native-${++sequence}`;
		const review = { coordinatorId: prefix, identityId: prefix, groupId: prefix, deviceId: prefix, attestationId: prefix, reviewReceiptId: prefix, publicKey: "opaque", fingerprint: "a".repeat(64), evidenceDigest: "b".repeat(64) };
		const db = env.COORDINATOR_DB;
		vi.spyOn(Date, "now").mockReturnValue(scopeApiNowMs);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({ store: new D1CoordinatorStore(db), review, exec: async (sql, ...values) => { await db.prepare(sql).bind(...values).run(); }, rows: async () => [] });
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			await db.batch([
				...['coordinator_scope_membership_effect_receipts', 'coordinator_scope_membership_audit_log', 'coordinator_scope_memberships', 'coordinator_scopes'].map((table) => db.prepare(`DELETE FROM ${table} WHERE scope_id IN (SELECT scope_id FROM coordinator_scopes WHERE group_id = ?)`).bind(prefix)),
				db.prepare("DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ?").bind(prefix),
				db.prepare("DELETE FROM request_nonces WHERE device_id = ?").bind(`${prefix}-requester`),
				db.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(prefix),
				db.prepare("DELETE FROM groups WHERE group_id = ?").bind(prefix),
			]);
		}
	});
	registerScopeAuthorizationApi(test);
	registerScopeApiQueryBudget(test, () => env.COORDINATOR_DB);
});
