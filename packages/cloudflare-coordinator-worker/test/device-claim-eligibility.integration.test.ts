import { env } from "cloudflare:workers";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it } from "vitest";
import { seedInviteSql } from "./device-claim-eligibility-fixture.js";
import { config, denied, eligible, input, NOW, aliasKey, seedEnrollmentSql, seedAttemptSql, seedClaimSql, seedUnrelatedCompletionSql } from "./device-claim-eligibility-fixture.js";

// These fixture inserts have no trigger bodies or semicolons in string literals.
async function seed(sql: string) {
	await env.COORDINATOR_DB.batch(sql.split(";").map((part) => part.trim()).filter(Boolean).map((part) => env.COORDINATOR_DB.prepare(part)));
}

it("native D1 evaluates the same read-only guard for unrelated people, key drift, terminal history and committed proof", async () => {
	await seed(`${seedEnrollmentSql} ${seedUnrelatedCompletionSql}`);
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW });
	const read = () => store.readAuthDeviceClaimReadiness(input, config);
	const snapshot = async () => Promise.all([
		"enrolled_devices", "coordinator_auth_link_attempts", "coordinator_auth_device_claims",
		"coordinator_auth_account_links", "coordinator_auth_link_audit_log", "coordinator_device_ownership_bindings", "coordinator_identity_group_grants",
	].map(async (table) => (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table}`).all()).results));
	const before = await snapshot();
	expect(await read()).toEqual(eligible);
	expect(await snapshot()).toEqual(before);
	// Consumed ownership evidence survives later token revocation.
	await seed(`${seedInviteSql}
		UPDATE coordinator_invites SET assigned_identity_id='other',consumed_at='2026-02-01T00:00:00.000Z',revoked_at='2026-03-01T00:00:00.000Z',bound_device_id='device-a';`);
	const consumedConflict = await read();
	expect(consumedConflict).toEqual(denied);
	await seed("DELETE FROM coordinator_invites");
	expect(await read()).toEqual(eligible);
	await seed("UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'");
	expect(await read()).toEqual(denied);
	await seed(`UPDATE enrolled_devices SET enabled=1 WHERE device_id='device-a'; UPDATE enrolled_devices SET public_key='${aliasKey}' WHERE device_id='unrelated-device';`);
	expect(await read()).toEqual(denied);
	await seed("DELETE FROM enrolled_devices WHERE device_id='unrelated-device'");
	await seed(`${seedAttemptSql} UPDATE coordinator_auth_link_attempts SET identity_id='other',state='failed',failure_reason='device_cancelled',failed_at_ms=${NOW},browser_transaction_hash='${"c".repeat(64)}',account_subject='private-oidc-subject';`);
	expect(await read()).toEqual(eligible);
	await seed(seedClaimSql);
	const committed = await snapshot();
	const genesis = await env.COORDINATOR_DB.prepare(`SELECT c.claim_id, a.link_id, a.state,
	 a.account_subject, a.authority_kind, b.state AS browser_state, b.nonce, b.pkce_verifier,
	 c.created_at_ms = a.finalized_at_ms AS matching_birth
	 FROM coordinator_auth_device_claims c
	 JOIN coordinator_auth_link_attempts a ON a.coordinator_id=c.coordinator_id AND a.attempt_id=c.attempt_id
	 JOIN coordinator_auth_browser_transactions b ON b.coordinator_id=a.coordinator_id AND b.browser_transaction_hash=a.browser_transaction_hash
	 WHERE c.claim_id='claim-a'`).first();
	expect(genesis).toEqual({ claim_id: "claim-a", link_id: "claim-a", state: "finalized",
		account_subject: "private-claim-subject", authority_kind: "device_claim",
		browser_state: "consumed", nonce: null, pkce_verifier: null, matching_birth: 1 });
	expect(await read()).toEqual(denied);
	expect(await snapshot()).toEqual(committed);
	await store.close();
});
