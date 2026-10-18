import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	aliasKey,
	config,
	controllerLinkEvidenceSql,
	denied,
	eligible,
	input,
	NOW,
	otherKey,
	seedAttemptSql,
	seedAttestationSql,
	seedBindingSql,
	seedClaimSql,
	seedEnrollmentSql,
	seedInviteSql,
	seedKeyRevocationSql,
	seedLinkSql,
	seedOwnerAttemptSql,
	seedUnrelatedCompletionSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import {
	AUTH_DEVICE_CLAIM_ELIGIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import { type Fixture, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { EXPECTED_KEY_ID } from "./coordinator-ed25519-key-id-test-fixtures.js";

const BLOCKED_CASES = [
	["disabled key", "UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'"],
	["archived group", "UPDATE groups SET archived_at='archived'"],
	[
		"different enrollment Identity",
		"UPDATE enrolled_devices SET identity_id='other' WHERE device_id='device-a'",
	],
	[
		"claim assigned to another device",
		"UPDATE enrolled_devices SET identity_id='identity-a' WHERE device_id='unrelated-device'",
	],
	[
		"canonical alias assigned elsewhere",
		`UPDATE enrolled_devices SET public_key='${aliasKey}' WHERE device_id='unrelated-device'`,
	],
	["key tombstone", seedKeyRevocationSql],
	[
		"device tombstone",
		seedKeyRevocationSql
			.replace("'ed25519_key'", "'device_id'")
			.replace(`'${EXPECTED_KEY_ID}'`, "'device-a'"),
	],
	["live owner-enrollment attempt", seedOwnerAttemptSql],
	["active exact attestation selects the separate attested path", seedAttestationSql],
	[
		"revoked attestation",
		`${seedAttestationSql} UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked'`,
	],
	[
		"attestation for another Identity",
		`${seedAttestationSql} UPDATE coordinator_auth_controller_attestations SET identity_id='other'`,
	],
	["conflicting ownership binding", seedBindingSql.replace("'identity-a'", "'other'")],
	["active claim grant", "UPDATE coordinator_identity_group_grants SET identity_id='identity-a'"],
	[
		"revoked claim grant",
		"UPDATE coordinator_identity_group_grants SET identity_id='identity-a',status='revoked',revoked_at='revoked'",
	],
	["committed proof", seedClaimSql],
	["existing account link", seedLinkSql],
	[
		"revoked account tombstone",
		`${seedLinkSql} UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW}`,
	],
	["pending assigned invitation", seedInviteSql],
	[
		"empty consumption marker is not consumed evidence",
		`${seedInviteSql} UPDATE coordinator_invites SET consumed_at=''`,
	],
	[
		"recipient claim on the same device with a different key",
		`${seedInviteSql} UPDATE coordinator_invites SET assigned_identity_id=NULL,recipient_actor_id='identity-a',bound_device_id='device-a',bound_public_key='${otherKey}'`,
	],
	[
		"historical committed target link with its original controller absent",
		`${controllerLinkEvidenceSql({ identityId: "other", attemptId: "attempt-a" })}
 UPDATE coordinator_auth_link_attempts SET state='session_redeemed' WHERE attempt_id='attempt-a';`,
	],
	[
		"other recipient binding footprint",
		`${seedInviteSql} UPDATE coordinator_invites SET assigned_identity_id=NULL,recipient_actor_id='identity-a',bound_device_id='unrelated-device',bound_public_key='${aliasKey}'`,
	],
	[
		"other inviter device footprint",
		`${seedInviteSql} UPDATE coordinator_invites SET assigned_identity_id=NULL,inviter_actor_id='identity-a',inviter_device_id='unrelated-device'`,
	],
	[
		"target consumed invitation assigns another Identity",
		`${seedInviteSql} UPDATE coordinator_invites SET assigned_identity_id='other',consumed_at='2026-02-01T00:00:00.000Z',bound_device_id='device-a'`,
	],
	[
		"target consumed invitation assigns another Identity even after token revocation",
		`${seedInviteSql} UPDATE coordinator_invites SET assigned_identity_id='other',consumed_at='2026-02-01T00:00:00.000Z',revoked_at='2026-03-01T00:00:00.000Z',bound_device_id='device-a'`,
	],
	[
		"live competing claim for target",
		`${seedAttemptSql} UPDATE coordinator_auth_link_attempts SET identity_id='other'`,
	],
	[
		"live claim on another device",
		`${seedAttemptSql} UPDATE coordinator_auth_link_attempts SET device_id='unrelated-device'`,
	],
	[
		"excluded target decision",
		`${seedUnrelatedCompletionSql} UPDATE coordinator_legacy_team_completions SET manifest_json=json_set(manifest_json,'$.device_decisions[0].device_id','device-a','$.device_decisions[0].decision','excluded')`,
	],
	[
		"completion gives claim to another device",
		`${seedUnrelatedCompletionSql} UPDATE coordinator_legacy_team_completions SET manifest_json=json_set(manifest_json,'$.device_decisions[0].identity_id','identity-a')`,
	],
] as const;

function registerGenesisEvidence(fixture: () => Fixture) {
	it.each([
		{
			authority: "device_claim",
			sql: seedClaimSql,
			attemptId: "completed-attempt",
			linkId: "claim-a",
			subject: "private-claim-subject",
		},
		{
			authority: "controller_attestation",
			sql: seedLinkSql,
			attemptId: "historical-attempt",
			linkId: "link-a",
			subject: "private-subject",
		},
	])(
		"retains coherent $authority genesis without manufacturing grants or permitting replacement",
		async (birth) => {
			// Arrange: synthetic persisted history, not new enrollment or provider authority.
			const f = fixture();
			const grants = () =>
				[
					"groups",
					"enrolled_devices",
					"coordinator_identity_group_grants",
					"coordinator_auth_controller_attestations",
				].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
			const before = grants();
			f.db.exec(birth.sql);
			const history = () =>
				[
					"coordinator_auth_link_attempts",
					"coordinator_auth_browser_transactions",
					"coordinator_auth_device_claims",
					"coordinator_auth_account_links",
					"coordinator_auth_link_audit_log",
				].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
			const retained = history();
			// Act: read actual joined evidence, then attempt to insert the same birth again.
			const evidence = f.db
				.prepare(`SELECT a.attempt_id, a.link_id, a.state, a.authority_kind,
		 a.account_subject, a.identity_id, a.device_id, a.public_key, a.fingerprint,
		 b.state AS browser_state, b.nonce, b.pkce_verifier,
		 a.created_at_ms <= a.claimed_at_ms AND a.claimed_at_ms <= b.consumed_at_ms
		 AND b.consumed_at_ms <= a.oidc_verified_at_ms AND a.oidc_verified_at_ms <= a.confirmed_at_ms
		 AND a.confirmed_at_ms <= a.finalized_at_ms AND a.finalized_at_ms < a.expires_at_ms AS ordered
		 FROM coordinator_auth_link_attempts a JOIN coordinator_auth_browser_transactions b
		 ON b.coordinator_id=a.coordinator_id AND b.browser_transaction_hash=a.browser_transaction_hash`)
				.get();
			const replace = () => f.db.exec(birth.sql);
			// Assert: exact proof pins survive, and fixture history grants no new trust.
			expect(evidence).toEqual({
				attempt_id: birth.attemptId,
				link_id: birth.linkId,
				state: "finalized",
				authority_kind: birth.authority,
				account_subject: birth.subject,
				identity_id: input.identityId,
				device_id: input.signer.deviceId,
				public_key: input.signer.publicKey,
				fingerprint: input.signer.fingerprint,
				browser_state: "consumed",
				nonce: null,
				pkce_verifier: null,
				ordered: 1,
			});
			expect(replace).toThrow(/UNIQUE constraint failed/);
			expect(history()).toEqual(retained);
			expect(grants()).toEqual(before);
		},
	);
}

function registerUnrelatedHistoryRead(fixture: () => Fixture) {
	it("writes nothing and returns no other account metadata when accepting pinned local Identities without ownership footprints", async () => {
		// Arrange: coherent history belongs to a different device and key.
		const f = fixture();
		const read = (changes = {}) =>
			f.store.readAuthDeviceClaimReadiness({ ...input, ...changes }, config);
		f.db.exec(
			controllerLinkEvidenceSql({
				identityId: "unrelated-identity",
				deviceId: "unrelated-device",
				publicKey: otherKey,
				fingerprint: "b".repeat(64),
			}),
		);
		const tables = f.db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as { name: string }[];
		const snapshot = () =>
			tables.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
		const before = snapshot();
		// Act
		const localClaim = await read({ identityId: "local:another-device" });
		const currentClaim = await read();
		const ownLocalClaim = await read({ identityId: "local:device-a" });
		// Assert
		expect(currentClaim).toEqual(eligible);
		expect(localClaim).toEqual({ ...eligible, identityId: "local:another-device" });
		expect(ownLocalClaim).toMatchObject({ kind: "eligible", identityId: "local:device-a" });
		expect(snapshot()).toEqual(before);
	});
}

describe.each(["SQLite", "D1"] as const)("%s device-claim readiness", (backend) => {
	let f: Fixture;
	beforeEach(() => {
		f = setupStore(backend, { authClock: () => NOW });
		f.db.exec(seedEnrollmentSql);
	});
	afterEach(async () => {
		await f.store.close();
		if (f.db.open) f.db.close();
	});
	const read = (changes = {}) =>
		f.store.readAuthDeviceClaimReadiness({ ...input, ...changes }, config);
	registerGenesisEvidence(() => f);
	registerUnrelatedHistoryRead(() => f);
	it("lets an unassigned legacy device claim its current Identity despite unrelated Team people and labels", async () => {
		f.db.exec(seedUnrelatedCompletionSql);
		f.db.exec(
			`${seedInviteSql} UPDATE coordinator_invites SET assigned_identity_id='unrelated-identity',inviter_actor_id='unrelated-identity',inviter_device_id='unrelated-device',inviter_display_name='identity-a';`,
		);
		expect(await read()).toEqual(eligible);
	});
	it("accepts matching existing enrollment and ownership evidence without granting operator authority", async () => {
		f.db.exec(
			`UPDATE enrolled_devices SET identity_id='identity-a' WHERE device_id='device-a'; ${seedBindingSql}`,
		);
		expect(await read()).toEqual(eligible);
	});
	it.each(BLOCKED_CASES)(
		"denies %s without disclosing the conflicting record",
		async (_label, sql) => {
			f.db.exec(sql);
			expect(await read()).toEqual(denied);
		},
	);
	it.each([
		[
			"failed after OIDC",
			"state='failed',failure_reason='device_cancelled',failed_at_ms=1,browser_transaction_hash='" +
				"c".repeat(64) +
				"',account_subject='private-oidc-subject'",
		],
		[
			"expired after OIDC",
			"state='expired',browser_transaction_hash='" +
				"c".repeat(64) +
				"',account_subject='private-oidc-subject'",
		],
		["overdue pending", `expires_at_ms=${NOW},created_at_ms=${NOW - 600000}`],
	])("does not burn a claim for uncommitted %s history", async (_label, assignments) => {
		f.db.exec(
			`${seedAttemptSql} UPDATE coordinator_auth_link_attempts SET identity_id='other',${assignments}`,
		);
		expect(await read()).toEqual(eligible);
	});
	it.each([
		"UPDATE coordinator_invites SET expires_at='2026-01-02T00:00:00.000Z'",
		"UPDATE coordinator_invites SET revoked_at='2026-01-02T00:00:00.000Z'",
		`UPDATE coordinator_invites SET consumed_at='2026-02-01T00:00:00.000Z',bound_device_id='device-a',bound_public_key='${aliasKey}'`,
	])("ignores an expired/revoked pending invite or agreeing consumed evidence: %s", async (sql) => {
		f.db.exec(`${seedInviteSql} ${sql}`);
		expect(await read()).toEqual(eligible);
	});
	it("does not let a retry ID exempt another device's live claim", async () => {
		f.db.exec(seedAttemptSql);
		expect(await read({ attemptId: "attempt-a" })).toEqual(eligible);
		f.db.exec("UPDATE coordinator_auth_link_attempts SET device_id='another-device'");
		expect(await read({ attemptId: "attempt-a" })).toEqual(denied);
	});
	it.each([
		["conflicting canonical alias", aliasKey, denied],
		["unrelated key text change", `${otherKey} changed-comment`, eligible],
	])(
		"rejects stale key capture after %s and rechecks fresh readiness",
		async (_label, key, freshExpected) => {
			const sqlBackend = {
				first: async <T>({ sql, values }: { sql: string; values: (string | number | null)[] }) =>
					(f.db.prepare(sql).get(...values) as T | undefined) ?? null,
			};
			const captured = await captureDeviceClaimEligibility(sqlBackend, input, config, NOW);
			if (!captured) throw new Error("Missing fixture eligibility input");
			expect(captured.values).toHaveLength(15);
			f.db
				.prepare("UPDATE enrolled_devices SET public_key=? WHERE device_id='unrelated-device'")
				.run(key);
			const staleResult = f.db
				.prepare(
					`${AUTH_DEVICE_CLAIM_INPUT_SQL} SELECT CASE WHEN ${AUTH_DEVICE_CLAIM_ELIGIBLE_SQL} THEN 1 ELSE 0 END AS eligible FROM claim_input p`,
				)
				.get(...captured.values);
			const freshResult = await read();
			expect(staleResult).toEqual({ eligible: 0 });
			expect(freshResult).toEqual(freshExpected);
		},
	);
	it("rejects a pinned local Identity when authoritative enrollment names another Identity", async () => {
		f.db.exec("UPDATE enrolled_devices SET identity_id='other' WHERE device_id='device-a'");
		const result = await read({ identityId: "local:another-device" });
		expect(result).toEqual(denied);
	});
});
