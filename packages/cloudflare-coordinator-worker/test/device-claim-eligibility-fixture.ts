import { createHash } from "node:crypto";
import { CANONICAL_PUBLIC_KEY, EXPECTED_KEY_ID } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";

export const NOW = 1_791_028_800_000;
export const config = { coordinatorId: "coordinator-a", issuer: "https://accounts.example.test", revision: "a".repeat(64), enabled: true };
export const input = { identityId: "identity-a", signer: { groupId: "group-a", deviceId: "device-a", publicKey: CANONICAL_PUBLIC_KEY, fingerprint: "a".repeat(64) } };
export const otherKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1AF8PoQ4lakrcKp00bfrycmCzPLsSWjMDNVfEq9GYM";
export const aliasKey = `${CANONICAL_PUBLIC_KEY} same-key-alias`;
export const eligible = { kind: "eligible", authority: "device_claim", identityId: input.identityId };
export const denied = { kind: "unavailable" };

export const seedEnrollmentSql = `
INSERT INTO groups (group_id,created_at) VALUES ('group-a','2026-10-01T00:00:00.000Z');
INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,created_at) VALUES
 ('group-a','device-a','${CANONICAL_PUBLIC_KEY}','${"a".repeat(64)}',NULL,'created'),
 ('group-a','unrelated-device','${otherKey}','${"b".repeat(64)}','unrelated-identity','created');
INSERT INTO coordinator_identity_group_grants (coordinator_id,identity_id,group_id,status,revision,source_kind,source_receipt_id,created_at)
 VALUES ('coordinator-a','unrelated-identity','group-a','active',1,'controller_attestation','unrelated-receipt','created');`;

export const seedAttestationSql = `INSERT INTO coordinator_auth_controller_attestations
 (attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,review_receipt_id,evidence_digest,created_at)
 VALUES ('attestation-a','coordinator-a','identity-a','group-a','device-a','${CANONICAL_PUBLIC_KEY}','${"a".repeat(64)}','receipt-a','${"a".repeat(64)}','created');`;

export const seedBindingSql = `INSERT INTO coordinator_device_ownership_bindings
 (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
 VALUES ('device-a','${EXPECTED_KEY_ID}','identity-a','coordinator-a','binding-a','reviewed_legacy_migration','source-a','bound');`;

const proofHash = (value: string) => createHash("sha256").update(value).digest("hex");
function insertEvidence(table: string, row: Record<string, string | number | null>) {
	const entries = Object.entries(row);
	const literal = (value: string | number | null) => {
		if (value === null) return "NULL";
		if (typeof value === "number") return String(value);
		return `'${value.replaceAll("'", "''")}'`;
	};
	return `INSERT INTO ${table} (${entries.map(([name]) => name).join(",")}) VALUES (${entries.map(([, value]) => literal(value)).join(",")});`;
}

// Synthetic persisted facts, not enrollment, controller review, or provider verification.
function genesisEvidence(pins: {
	identityId: string; deviceId: string; attemptId: string; linkId: string;
	publicKey: string; fingerprint: string;
	subject: string; authority: "controller_attestation" | "device_claim";
}) {
	const controller = pins.authority === "controller_attestation" ? "historical-controller" : null;
	const browserHash = proofHash(`device-claim-fixture:${pins.attemptId}`);
	const common = {
		coordinator_id: config.coordinatorId, identity_id: pins.identityId, group_id: input.signer.groupId,
		device_id: pins.deviceId, fingerprint: pins.fingerprint,
		controller_attestation_id: controller, auth_config_revision: config.revision,
		authority_kind: pins.authority,
	};
	const attempt = insertEvidence("coordinator_auth_link_attempts", {
		...common, attempt_id: pins.attemptId, public_key: pins.publicKey,
		controller_review_receipt_id: controller ? "historical-receipt" : null,
		controller_revision: controller ? 1 : null, issuer: config.issuer,
		runtime_verifier_hash: proofHash(`${browserHash}:runtime`),
		loopback_redirect: "http://127.0.0.1:4567/complete", state: "finalized",
		browser_transaction_hash: browserHash, account_subject: pins.subject,
		completion_secret_hash: proofHash(`${browserHash}:completion`), link_id: pins.linkId,
		browser_start_hash: proofHash(`${browserHash}:start`), created_at_ms: NOW - 100,
		expires_at_ms: NOW + 599900, claimed_at_ms: NOW - 80,
		oidc_verified_at_ms: NOW - 60, confirmed_at_ms: NOW - 40, finalized_at_ms: NOW,
	});
	const browser = insertEvidence("coordinator_auth_browser_transactions", {
		coordinator_id: config.coordinatorId, browser_transaction_hash: browserHash,
		purpose: "link", attempt_id: pins.attemptId, state_hash: proofHash(`${browserHash}:state`),
		binder_hash: proofHash(`${browserHash}:binder`), issuer: config.issuer,
		auth_config_revision: config.revision, redirect_uri: "https://coordinator.example.test/auth/callback",
		state: "consumed", nonce: null, pkce_verifier: null, claim_token: proofHash(`${browserHash}:claim`),
		created_at_ms: NOW - 90, expires_at_ms: NOW + 599910, consumed_at_ms: NOW - 70,
	});
	return { common, controller, sql: `${attempt}\n${browser}` };
}

export function deviceClaimEvidenceSql(changes: { identityId?: string; deviceId?: string } = {}) {
	const pins = {
		identityId: "identity-a", deviceId: "device-a", attemptId: "completed-attempt",
		linkId: "claim-a", subject: "private-claim-subject", authority: "device_claim" as const,
		publicKey: input.signer.publicKey, fingerprint: input.signer.fingerprint,
		...changes,
	};
	const genesis = genesisEvidence(pins);
	const claim = insertEvidence("coordinator_auth_device_claims", {
		claim_id: pins.linkId, coordinator_id: config.coordinatorId, identity_id: pins.identityId,
		group_id: input.signer.groupId, device_id: pins.deviceId, public_key: input.signer.publicKey,
		fingerprint: input.signer.fingerprint, key_id: EXPECTED_KEY_ID, attempt_id: pins.attemptId,
		issuer: config.issuer, auth_config_revision: config.revision, created_at_ms: NOW,
	});
	return `${genesis.sql}\n${claim}`;
}

export function controllerLinkEvidenceSql(changes: {
	identityId?: string; subject?: string; attemptId?: string;
	deviceId?: string; publicKey?: string; fingerprint?: string;
} = {}) {
	const pins = {
		identityId: "identity-a", deviceId: "device-a", attemptId: "historical-attempt",
		linkId: "link-a", subject: "private-subject", authority: "controller_attestation" as const,
		publicKey: input.signer.publicKey, fingerprint: input.signer.fingerprint,
		...changes,
	};
	const genesis = genesisEvidence(pins);
	// Activation seam: add association reservation, generation=1 and the browser
	// sequence floor here only when the installed schema and runtime become V3.
	const link = insertEvidence("coordinator_auth_account_links", {
		coordinator_id: config.coordinatorId, link_id: pins.linkId, issuer: config.issuer,
		subject: pins.subject, identity_id: pins.identityId, attempt_id: pins.attemptId,
		controller_attestation_id: genesis.controller, auth_config_revision: config.revision,
		created_at_ms: NOW, revoked_at_ms: null, authority_kind: pins.authority, device_claim_id: null,
	});
	const audit = insertEvidence("coordinator_auth_link_audit_log", {
		...genesis.common, link_id: pins.linkId, attempt_id: pins.attemptId,
		action: "link_created", device_claim_id: null, created_at_ms: NOW,
	});
	return `${genesis.sql}\n${link}\n${audit}`;
}

export const seedClaimSql = deviceClaimEvidenceSql();
export const seedLinkSql = controllerLinkEvidenceSql();

export const seedAttemptSql = `INSERT INTO coordinator_auth_link_attempts
 (coordinator_id,attempt_id,identity_id,group_id,device_id,public_key,fingerprint,issuer,auth_config_revision,runtime_verifier_hash,loopback_redirect,state,created_at_ms,expires_at_ms,authority_kind)
 VALUES ('coordinator-a','attempt-a','identity-a','group-a','device-a','${CANONICAL_PUBLIC_KEY}','${"a".repeat(64)}','https://accounts.example.test','${"a".repeat(64)}','${"b".repeat(64)}','http://127.0.0.1:4567/complete','pending',${NOW},${NOW + 600000},'device_claim');`;

export const seedInviteSql = `INSERT INTO coordinator_invites
 (invite_id,group_id,token,policy,expires_at,created_at,assigned_identity_id)
 VALUES ('invite-a','group-a','token-a','open','2027-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','identity-a');`;

export const seedUnrelatedCompletionSql = `INSERT INTO coordinator_legacy_team_completions
 (group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
 VALUES ('group-a','candidate-a',1,'${JSON.stringify({ coordinator_id: config.coordinatorId, memberships: [{ identity_id: "unrelated-identity", role: "member" }], device_decisions: [{ device_id: "unrelated-device", key_fingerprint: "b".repeat(64), identity_id: "unrelated-identity", decision: "included", enabled: true }] })}','completed','created');`;

export const seedKeyRevocationSql = `INSERT INTO coordinator_device_revocations
 (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at)
 VALUES ('ed25519_key','${EXPECTED_KEY_ID}','revocation-a','group-a','device-a','${CANONICAL_PUBLIC_KEY}','${"a".repeat(64)}','created');`;

export const seedOwnerAttemptSql = `INSERT INTO coordinator_owner_enrollment_attempts
 (coordinator_id,attempt_id,purpose,origin,device_id,public_key,key_id,fingerprint,issuer,auth_config_revision,loopback_redirect,browser_start_hash,state,created_at_ms,expires_at_ms)
 VALUES ('coordinator-a','owner-attempt','owner_enroll','https://coordinator.example.test','device-a','${CANONICAL_PUBLIC_KEY}','${EXPECTED_KEY_ID}','${"a".repeat(64)}','https://accounts.example.test','${"a".repeat(64)}','http://127.0.0.1:4567/complete','${"c".repeat(64)}','pending',${NOW},${NOW + 600000});`;
