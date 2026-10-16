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

export const seedClaimSql = `INSERT INTO coordinator_auth_device_claims
 (claim_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,key_id,attempt_id,issuer,auth_config_revision,created_at_ms)
 VALUES ('claim-a','coordinator-a','identity-a','group-a','device-a','${CANONICAL_PUBLIC_KEY}','${"a".repeat(64)}','${EXPECTED_KEY_ID}','completed-attempt','https://accounts.example.test','${"a".repeat(64)}',${NOW});`;

export const seedLinkSql = `INSERT INTO coordinator_auth_account_links
 (coordinator_id,link_id,issuer,subject,identity_id,attempt_id,controller_attestation_id,auth_config_revision,created_at_ms,authority_kind)
 VALUES ('coordinator-a','link-a','https://accounts.example.test','private-subject','identity-a','historical-attempt','historical-controller','${"a".repeat(64)}',${NOW},'controller_attestation');`;

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
