import { env } from "cloudflare:workers";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	D1CoordinatorStore,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it, vi } from "vitest";
import { legacyTeamCandidateId } from "../../core/src/recipient-policy-identifiers.js";
import { config, eligible, input, NOW, otherKey, seedEnrollmentSql } from "./device-claim-eligibility-fixture.js";

it("native D1 links an assigned shared Identity and rejects ledger deletion after capture", async () => {
	// Arrange: reuse worker-pool TEST_MIGRATIONS and trusted provider metadata, no network.
	const db = env.COORDINATOR_DB;
	await db.batch(
		seedEnrollmentSql.split(";")
			.map((sql) => sql.trim())
			.filter(Boolean)
			.map((sql) => db.prepare(sql)),
	);
	await db.prepare("UPDATE enrolled_devices SET identity_id='identity-a'").run();
	const manifest = normalizeCoordinatorLegacyTeamCompletionManifest({
		version: 1,
		coordinator_id: config.coordinatorId,
		candidate_ref: legacyTeamCandidateId(config.coordinatorId, "group-a"),
		candidate_digest: "a".repeat(64),
		team_id: "team-a",
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: input.identityId, role: "member" }],
		device_decisions: [
			{
				device_id: "device-a",
				key_fingerprint: input.signer.fingerprint,
				identity_id: input.identityId,
				enabled: true,
				decision: "included",
			},
			{
				device_id: "unrelated-device",
				key_fingerprint: "b".repeat(64),
				identity_id: input.identityId,
				enabled: true,
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-10-01T00:00:00.000Z",
	});
	const insertLedger = () =>
		db.prepare("INSERT INTO coordinator_legacy_team_completions (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES (?,?,?,?,?,?)")
			.bind(
				"group-a",
				manifest.candidate_ref,
				1,
				canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
				manifest.completed_at,
				manifest.completed_at,
			)
			.run();
	await insertLedger();
	const store = new D1CoordinatorStore(db, { authClock: () => NOW });
	const request = {
		authority: { kind: "device_claim" as const, identityId: input.identityId },
		signer: input.signer,
		attemptId: "attempt-a",
		runtimeVerifierHash: "b".repeat(64),
		browserStartHash: "e".repeat(64),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const browserConfig = { ...config, redirectUri: "https://coordinator.example.test/auth/callback" };
	const transaction = {
		purpose: "link" as const,
		attemptId: request.attemptId,
		browserStartHash: request.browserStartHash,
		stateHash: "3".repeat(64),
		binderHash: "4".repeat(64),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	const tables = [
		"enrolled_devices",
		"coordinator_identity_group_grants",
		"coordinator_auth_link_attempts",
		"coordinator_auth_device_claims",
		"coordinator_auth_account_links",
		"coordinator_auth_link_audit_log",
	];
	const snapshot = () => Promise.all(
		tables.map(async (table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results),
	);
	const stable = (await snapshot()).slice(0, 2);
	// Act / Assert: exercise actual D1 readiness, browser binding and winning finalize SQL.
	expect(await store.readAuthDeviceClaimReadiness(input, config)).toEqual(eligible);
	expect(await store.createAuthLinkAttempt(request, config)).toMatchObject({ kind: "created" });
	expect(await store.startAuthBrowserTransaction(transaction, browserConfig)).toMatchObject({
		kind: "started",
	});
	const bound = await store.resolveAuthLinkBrowserTransaction(
		{ attemptId: request.attemptId, binderHash: transaction.binderHash },
		browserConfig,
	);
	if (!bound) throw new Error("shared Identity browser not bound");
	expect(await store.consumeAuthBrowserTransaction(
		{ stateHash: transaction.stateHash, binderHash: transaction.binderHash },
		browserConfig,
	)).toMatchObject({ kind: "consumed" });
	const browser = { attemptId: request.attemptId, ...bound };
	expect(await store.recordAuthLinkOidcVerified(
		{ ...browser, account: { issuer: config.issuer, subject: "synthetic-shared-subject" } },
		config,
	)).toMatchObject({ kind: "applied" });
	expect(await store.confirmAuthLinkAttempt(
		{ ...browser, completionSecretHash: "d".repeat(64) },
		config,
	)).toMatchObject({ kind: "applied" });
	const proof = {
		purpose: "coordinator-account-link-v1" as const,
		coordinatorId: config.coordinatorId,
		attemptId: request.attemptId,
		groupId: input.signer.groupId,
		identityId: input.identityId,
		deviceId: input.signer.deviceId,
		fingerprint: input.signer.fingerprint,
		runtimeVerifierHash: request.runtimeVerifierHash,
		completionSecretHash: "d".repeat(64),
		signer: input.signer,
	};
	const before = await snapshot();
	const batch = db.batch.bind(db);
	const hook = vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
		await db.prepare("DELETE FROM coordinator_legacy_team_completions").run();
		return batch(statements);
	});
	try {
		expect(await store.finalizeAuthLinkAttempt(proof, config)).toMatchObject({ kind: "rejected" });
		expect(hook).toHaveBeenCalledOnce();
		expect(await snapshot()).toEqual(before);
	} finally {
		hook.mockRestore();
	}
	await insertLedger();
	expect(await store.finalizeAuthLinkAttempt(proof, config)).toMatchObject({
		kind: "applied",
		status: { state: "finalized" },
	});
	const committed = await snapshot();
	expect(committed.slice(0, 2)).toEqual(stable);
	for (const records of committed.slice(3)) expect(records).toHaveLength(1);
	expect(await store.readAccountLinkStatus(
		input.signer, config, { identityId: input.identityId },
	)).toMatchObject({
		state: "linked", authority: "device_claim", identityId: input.identityId,
	});
	// Arrange: shared status would expose this profile without the requester attestation check.
	await db.prepare(`INSERT INTO coordinator_auth_account_profiles
		(coordinator_id,link_id,display_name,email,email_verified,source_session_id,source_signed_in_at_ms)
		SELECT coordinator_id,link_id,'Synthetic Person','synthetic@example.test',1,'synthetic-session',?
		FROM coordinator_auth_account_links`).bind(NOW).run();
	const peer = {
		groupId: "group-a", deviceId: "unrelated-device",
		publicKey: otherKey, fingerprint: "b".repeat(64),
	};
	expect(await store.readAccountLinkStatus(peer, config, { identityId: input.identityId }))
		.toMatchObject({ state: "linked", account: { displayName: "Synthetic Person", email: "synthetic@example.test" } });
	tables.push("groups", "coordinator_auth_account_profiles", "coordinator_auth_controller_attestations");
	for (const [identityId, groupId, revokedAt] of [
		["other", "group-a", "revoked"],
		["other", "other-group", null],
		[input.identityId, "group-a", "revoked"],
	]) {
		await db.prepare("UPDATE enrolled_devices SET identity_id=NULL WHERE device_id='unrelated-device'").run();
		await db.prepare("INSERT INTO groups (group_id,created_at) VALUES ('other-group','created')").run();
		await db.prepare(`INSERT INTO coordinator_auth_controller_attestations
			(attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,review_receipt_id,evidence_digest,created_at,revoked_at)
			VALUES ('att-peer','coordinator-a',?,?,'unrelated-device',?,?,'receipt-peer',?,'created',?)`)
			.bind(identityId, groupId, otherKey, peer.fingerprint, "a".repeat(64), revokedAt).run();
		const contradictory = await snapshot();
		// Act / Assert: neither a revoked nor a conflicting current requester inherits the profile.
		expect(await store.readAccountLinkStatus(peer, config, { identityId: input.identityId }))
			.toMatchObject({ account: null, identityId: null, authority: null });
		expect(await snapshot()).toEqual(contradictory);
		await db.batch([
			db.prepare("DELETE FROM coordinator_auth_controller_attestations WHERE attestation_id='att-peer'"),
			db.prepare("DELETE FROM groups WHERE group_id='other-group'"),
			db.prepare("UPDATE enrolled_devices SET identity_id='identity-a' WHERE device_id='unrelated-device'"),
		]);
	}
});
