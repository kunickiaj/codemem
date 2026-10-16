/** Trusted SQL aliases only. Historical ownership is independent of current enrollment.
 * The immutable proof's key ID was derived at commit. Signed-device receipts also
 * pass a freshly derived canonical key ID; account sessions need no current key.
 * Link revocation is deliberately checked by the caller, including post-revoke audit.
 */
export function authDeviceClaimProvenanceSql(options: {
	link: "l" | "cl";
	canonicalKeyId?: "?";
}): string {
	// Keep provenance independent of the outer session/browser expression tree.
	// Native D1 limits expression depth to 100, including correlated subqueries.
	const l = "pl";
	return `EXISTS (WITH committed_claim AS MATERIALIZED (
 SELECT ct.coordinator_id, ct.link_id, cd.key_id FROM coordinator_auth_link_attempts ct
 JOIN coordinator_auth_account_links pl ON pl.coordinator_id = ct.coordinator_id AND pl.link_id = ct.link_id
 JOIN coordinator_auth_device_claims cd ON cd.coordinator_id = ct.coordinator_id AND cd.claim_id = ${l}.device_claim_id
 JOIN coordinator_auth_link_audit_log ca ON ca.coordinator_id = ct.coordinator_id AND ca.link_id = ct.link_id AND ca.action = 'link_created'
 WHERE ct.coordinator_id = ${options.link}.coordinator_id AND ct.link_id = ${options.link}.link_id
 AND ct.attempt_id = ${l}.attempt_id
 AND ct.authority_kind = 'device_claim' AND ct.controller_attestation_id IS NULL
 AND ct.controller_review_receipt_id IS NULL AND ct.controller_revision IS NULL AND ct.state IN ('finalized','session_redeemed')
 AND ${l}.authority_kind = 'device_claim' AND ${l}.controller_attestation_id IS NULL
 AND ct.identity_id = ${l}.identity_id AND ct.issuer = ${l}.issuer AND ct.account_subject = ${l}.subject
 AND ct.auth_config_revision = ${l}.auth_config_revision AND ct.finalized_at_ms = ${l}.created_at_ms
 AND ct.browser_transaction_hash IS NOT NULL AND ct.browser_start_hash IS NOT NULL
 AND ct.runtime_verifier_hash IS NOT NULL AND ct.completion_secret_hash IS NOT NULL
 AND ct.created_at_ms <= ct.claimed_at_ms AND ct.claimed_at_ms <= ct.oidc_verified_at_ms
 AND ct.oidc_verified_at_ms <= ct.confirmed_at_ms AND ct.confirmed_at_ms <= ct.finalized_at_ms AND ct.finalized_at_ms < ct.expires_at_ms
 AND cd.attempt_id = ct.attempt_id AND cd.identity_id = ct.identity_id AND cd.group_id = ct.group_id AND cd.device_id = ct.device_id
 AND cd.public_key = ct.public_key AND cd.fingerprint = ct.fingerprint
 AND cd.issuer = ct.issuer AND cd.auth_config_revision = ct.auth_config_revision AND cd.created_at_ms = ct.finalized_at_ms
 AND ca.authority_kind = 'device_claim' AND ca.controller_attestation_id IS NULL AND ca.device_claim_id IS ${l}.device_claim_id
 AND ca.attempt_id = ct.attempt_id AND ca.identity_id = ct.identity_id AND ca.group_id = ct.group_id AND ca.device_id = ct.device_id
 AND ca.fingerprint = ct.fingerprint AND ca.auth_config_revision = ct.auth_config_revision AND ca.created_at_ms = ct.finalized_at_ms)
 SELECT 1 FROM committed_claim cp WHERE cp.coordinator_id = ${options.link}.coordinator_id AND cp.link_id = ${options.link}.link_id
 ${options.canonicalKeyId ? `AND cp.key_id = ${options.canonicalKeyId}` : ""})`;
}

/** Account management only; privileged enrollment/grant proofs remain attested-only. */
export function authAccountLinkProvenanceSql(link: "l"): string {
	return `((${link}.authority_kind = 'controller_attestation' AND ${link}.controller_attestation_id IS NOT NULL AND ${link}.device_claim_id IS NULL)
 OR (${authDeviceClaimProvenanceSql({ link })}))`;
}
