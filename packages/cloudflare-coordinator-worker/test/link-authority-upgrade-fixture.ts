export const linkAuthorityTables = [
	"coordinator_auth_link_attempts",
	"coordinator_auth_account_links",
	"coordinator_auth_link_audit_log",
] as const;

const fingerprint = "a".repeat(64);
const revision = "b".repeat(64);

// Historical pins intentionally have no live controller or enrollment records.
export const legacyLinkAuthorityRowsSql = `
INSERT INTO coordinator_auth_link_attempts (
 rowid, coordinator_id, attempt_id, identity_id, group_id, device_id, public_key,
 fingerprint, controller_attestation_id, controller_review_receipt_id, controller_revision,
 issuer, auth_config_revision, runtime_verifier_hash, loopback_redirect, state,
 browser_transaction_hash, account_subject, completion_secret_hash, link_id,
 created_at_ms, expires_at_ms, claimed_at_ms, oidc_verified_at_ms, confirmed_at_ms,
 finalized_at_ms, browser_start_hash
) VALUES (42, 'coordinator-a', 'attempt-a', 'identity-a', 'old-group', 'old-device',
 'old-public-key', '${fingerprint}', 'old-attestation', 'old-receipt', 1,
 'https://accounts.example.test', '${revision}', '${"c".repeat(64)}',
 'http://127.0.0.1:4567/codemem/auth/complete', 'session_redeemed',
 '${"d".repeat(64)}', 'subject-a', '${"e".repeat(64)}', 'link-a',
 1000, 601000, 1001, 1002, 1003, 1004, '${"f".repeat(64)}');
INSERT INTO coordinator_auth_account_links (
 rowid, coordinator_id, link_id, issuer, subject, identity_id, attempt_id,
 controller_attestation_id, auth_config_revision, created_at_ms, revoked_at_ms
) SELECT 77, coordinator_id, link_id, issuer, account_subject, identity_id, attempt_id,
 controller_attestation_id, auth_config_revision, finalized_at_ms, 1005
 FROM coordinator_auth_link_attempts;
INSERT INTO coordinator_auth_link_audit_log (
 rowid, coordinator_id, link_id, action, attempt_id, identity_id, group_id, device_id,
 fingerprint, controller_attestation_id, auth_config_revision, created_at_ms
) SELECT 98, coordinator_id, link_id, 'link_created', attempt_id, identity_id, group_id,
 device_id, fingerprint, controller_attestation_id, auth_config_revision, finalized_at_ms
 FROM coordinator_auth_link_attempts;
INSERT INTO coordinator_auth_link_audit_log
 SELECT coordinator_id, link_id, 'link_revoked', attempt_id, identity_id, group_id,
 device_id, fingerprint, controller_attestation_id, auth_config_revision, 1005
 FROM coordinator_auth_link_attempts;
INSERT INTO coordinator_auth_link_attempts (
 coordinator_id, attempt_id, identity_id, group_id, device_id, public_key, fingerprint,
 controller_attestation_id, controller_review_receipt_id, controller_revision, issuer,
 auth_config_revision, runtime_verifier_hash, loopback_redirect, state, created_at_ms,
 expires_at_ms, failure_reason, failed_at_ms
) SELECT coordinator_id, 'retired', identity_id, group_id, device_id, public_key, fingerprint,
 controller_attestation_id, controller_review_receipt_id, controller_revision, issuer,
 auth_config_revision, '${"1".repeat(64)}', loopback_redirect, 'failed', 0, 600000,
 'device_cancelled', 50 FROM coordinator_auth_link_attempts WHERE attempt_id = 'attempt-a';
`;

export const linkAuthorityDefinitionsSql = `SELECT type, name, tbl_name, sql FROM sqlite_master
 WHERE tbl_name IN (${linkAuthorityTables.map((table) => `'${table}'`).join(",")})
 OR name LIKE 'coordinator_auth_%authority_upgrade%'
 ORDER BY type, name`;

export function withoutNewAuthorityColumns(rows: Record<string, unknown>[]) {
	return rows.map(({ authority_kind: _kind, device_claim_id: _claim, ...old }) => old);
}
