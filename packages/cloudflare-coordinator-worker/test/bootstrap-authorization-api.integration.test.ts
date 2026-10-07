import { env } from "cloudflare:workers";
import { describe, expect, vi } from "vitest";
import { registerBootstrapAuthorizationApi } from "../../core/src/coordinator-bootstrap-authorization-api-test-harness.js";
import { authorizationNowMs } from "../../core/src/coordinator-bootstrap-authorization-test-harness.js";
import { contractHarness } from "../../core/src/coordinator-identity-group-grant-test-harness.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

let sequence = 0;
describe("native D1 versioned bootstrap API", () => {
	const test = contractHarness(async (use) => {
		const prefix = `bootstrap-api-native-${++sequence}`;
		const review = { coordinatorId: prefix, identityId: prefix, groupId: prefix, deviceId: prefix, attestationId: prefix, reviewReceiptId: prefix, publicKey: "opaque", fingerprint: "a".repeat(64), evidenceDigest: "b".repeat(64) };
		const db = env.COORDINATOR_DB;
		const store = new D1CoordinatorStore(db);
		vi.spyOn(Date, "now").mockReturnValue(authorizationNowMs);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({ store, review, exec: async (sql, ...values) => { await db.prepare(sql).bind(...values).run(); }, rows: async () => [] });
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			await db.batch([
				db.prepare("DELETE FROM coordinator_bootstrap_grants WHERE grant_id IN (SELECT grant_id FROM coordinator_bootstrap_grants WHERE group_id = ? OR group_id = 'foreign')").bind(review.groupId),
				db.prepare("DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ?").bind(review.groupId),
				db.prepare("DELETE FROM request_nonces WHERE device_id = ?").bind(`${prefix}-seed`),
				db.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(review.groupId),
				db.prepare("DELETE FROM groups WHERE group_id = ?").bind(review.groupId),
			]);
		}
	});
	registerBootstrapAuthorizationApi(test);
});
