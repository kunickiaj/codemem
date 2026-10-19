import { CONNECTION_BIRTH_COLUMNS } from "./coordinator-account-connection-storage.js";

export const CONNECTION_BIRTHS_SQL = `SELECT ${CONNECTION_BIRTH_COLUMNS.join(",")} FROM coordinator_auth_account_links UNION ALL SELECT ${CONNECTION_BIRTH_COLUMNS.join(",")} FROM coordinator_auth_account_connection_history`;
function rootBirths(coordinator: string, link: string): string {
	return `SELECT ${CONNECTION_BIRTH_COLUMNS.join(",")} FROM coordinator_auth_account_links WHERE coordinator_id = ${coordinator} AND link_id = ${link}
 UNION ALL SELECT ${CONNECTION_BIRTH_COLUMNS.join(",")} FROM coordinator_auth_account_connection_history WHERE coordinator_id = ${coordinator} AND link_id = ${link}`;
}

/** Trusted SQL aliases only. Historical ownership is independent of current enrollment.
 * The immutable proof's key ID was derived at commit. Signed-device receipts also
 * pass a freshly derived canonical key ID; account sessions need no current key.
 * Link revocation is deliberately checked by the caller, including post-revoke audit.
 */
export function authDeviceClaimProvenanceSql(options: {
	link: "l" | "cl";
	canonicalKeyId?: "?";
	connections?: boolean;
}): string {
	if (options.connections) return connectionClaimProvenance(options);
	return genesisClaimProvenance(
		options.link,
		"coordinator_auth_account_links",
		options.canonicalKeyId,
	);
}
function genesisClaimProvenance(link: string, births: string, canonicalKeyId?: "?"): string {
	// Keep provenance independent of the outer session/browser expression tree.
	// Native D1 limits expression depth to 100, including correlated subqueries.
	const l = "pl";
	return `EXISTS (WITH committed_claim AS MATERIALIZED (
 SELECT ct.coordinator_id, ct.link_id, cd.key_id FROM coordinator_auth_link_attempts ct
 JOIN ${births} pl ON pl.coordinator_id = ct.coordinator_id AND pl.link_id = ct.link_id
 JOIN coordinator_auth_device_claims cd ON cd.coordinator_id = ct.coordinator_id AND cd.claim_id = ${l}.device_claim_id
 JOIN coordinator_auth_link_audit_log ca ON ca.coordinator_id = ct.coordinator_id AND ca.link_id = ct.link_id AND ca.action = 'link_created'
 WHERE ct.coordinator_id = ${link}.coordinator_id AND ct.link_id = ${link}.link_id
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
 SELECT 1 FROM committed_claim cp WHERE cp.coordinator_id = ${link}.coordinator_id AND cp.link_id = ${link}.link_id
 ${canonicalKeyId ? `AND cp.key_id = ${canonicalKeyId}` : ""})`;
}

/** One immutable claim resolves its genesis directly; no recursive lineage walk. */
export function authClaimGenesisSql(claim: "d" | "cd"): string {
	return `EXISTS (WITH connection_births AS MATERIALIZED (${rootBirths(`${claim}.coordinator_id`, `${claim}.claim_id`)}) SELECT 1 FROM connection_births gl WHERE gl.coordinator_id = ${claim}.coordinator_id AND gl.link_id = ${claim}.claim_id AND ${genesisClaimProvenance("gl", "connection_births")})`;
}
function connectionClaimProvenance(options: { link: "l" | "cl"; canonicalKeyId?: "?" }): string {
	const l = options.link;
	return `EXISTS (WITH connection_births AS MATERIALIZED (${rootBirths(`${l}.coordinator_id`, `${l}.device_claim_id`)}), continuation AS MATERIALIZED (
 SELECT t.coordinator_id,t.link_id,d.key_id FROM coordinator_auth_link_attempts t
 JOIN coordinator_auth_link_audit_log a ON a.coordinator_id = t.coordinator_id AND a.link_id = t.link_id AND a.action = 'link_created'
 JOIN coordinator_auth_device_claims d ON d.coordinator_id = t.coordinator_id AND d.claim_id = ${l}.device_claim_id
 WHERE t.coordinator_id = ${l}.coordinator_id AND t.link_id = ${l}.link_id AND t.attempt_id = ${l}.attempt_id
 AND (${l}.authority_kind = 'device_claim' AND ${l}.controller_attestation_id IS NULL AND t.authority_kind = 'device_claim' AND t.controller_attestation_id IS NULL AND t.controller_review_receipt_id IS NULL AND t.controller_revision IS NULL)
 AND (t.state IN ('finalized','session_redeemed') AND t.identity_id = ${l}.identity_id AND t.issuer = ${l}.issuer AND t.account_subject = ${l}.subject AND t.auth_config_revision = ${l}.auth_config_revision AND t.finalized_at_ms = ${l}.created_at_ms)
 AND (t.browser_start_hash IS NOT NULL AND t.browser_transaction_hash IS NOT NULL AND t.runtime_verifier_hash IS NOT NULL AND t.completion_secret_hash IS NOT NULL AND t.created_at_ms <= t.claimed_at_ms AND t.claimed_at_ms <= t.oidc_verified_at_ms AND t.oidc_verified_at_ms <= t.confirmed_at_ms AND t.confirmed_at_ms <= t.finalized_at_ms AND t.finalized_at_ms < t.expires_at_ms)
 AND (d.identity_id = t.identity_id AND d.issuer = t.issuer AND d.group_id = t.group_id AND d.device_id = t.device_id AND d.public_key = t.public_key AND d.fingerprint = t.fingerprint)
 AND (a.attempt_id = t.attempt_id AND a.identity_id = t.identity_id AND a.group_id = t.group_id AND a.device_id = t.device_id AND a.fingerprint = t.fingerprint AND a.auth_config_revision = t.auth_config_revision AND a.created_at_ms = t.finalized_at_ms AND a.authority_kind = 'device_claim' AND a.controller_attestation_id IS NULL AND a.device_claim_id = d.claim_id)
 AND ((t.prior_link_id IS NULL AND t.link_id = d.claim_id) OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = t.coordinator_id AND h.link_id = t.prior_link_id AND h.identity_id = t.identity_id AND h.successor_link_id = t.link_id))
 AND EXISTS (SELECT 1 FROM connection_births gl WHERE gl.coordinator_id = d.coordinator_id AND gl.link_id = d.claim_id AND ${genesisClaimProvenance("gl", "connection_births")}))
 SELECT 1 FROM continuation cp ${options.canonicalKeyId ? "WHERE cp.key_id = ?" : ""})`;
}

/** Account management only; privileged enrollment/grant proofs remain attested-only. */
function controllerBirthProvenance(link: "l"): string {
	return `EXISTS (WITH controller_receipt AS MATERIALIZED (SELECT t.coordinator_id,t.link_id FROM coordinator_auth_link_attempts t
 JOIN coordinator_auth_controller_attestations origin ON origin.coordinator_id=t.coordinator_id AND origin.attestation_id=t.controller_attestation_id
 JOIN coordinator_auth_link_audit_log a ON a.coordinator_id=t.coordinator_id AND a.link_id=t.link_id AND a.action='link_created'
 WHERE (t.coordinator_id=${link}.coordinator_id AND t.link_id=${link}.link_id AND t.attempt_id=${link}.attempt_id AND t.authority_kind='controller_attestation' AND t.controller_attestation_id=${link}.controller_attestation_id)
 AND (t.identity_id=${link}.identity_id AND t.issuer=${link}.issuer AND t.account_subject=${link}.subject AND t.auth_config_revision=${link}.auth_config_revision AND t.finalized_at_ms=${link}.created_at_ms AND t.state IN ('finalized','session_redeemed'))
 AND (t.browser_transaction_hash IS NOT NULL AND t.runtime_verifier_hash IS NOT NULL AND t.completion_secret_hash IS NOT NULL AND t.created_at_ms<=t.claimed_at_ms AND t.claimed_at_ms<=t.oidc_verified_at_ms AND t.oidc_verified_at_ms<=t.confirmed_at_ms AND t.confirmed_at_ms<=t.finalized_at_ms AND t.finalized_at_ms<t.expires_at_ms)
 AND (origin.identity_id=t.identity_id AND origin.group_id=t.group_id AND origin.device_id=t.device_id AND origin.public_key=t.public_key AND origin.fingerprint=t.fingerprint AND origin.review_receipt_id=t.controller_review_receipt_id AND origin.revision=t.controller_revision)
 AND (t.prior_link_id IS NULL OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id=t.coordinator_id AND h.identity_id=t.identity_id AND h.link_id=t.prior_link_id AND h.successor_link_id=t.link_id))
 AND (a.attempt_id=t.attempt_id AND a.identity_id=t.identity_id AND a.group_id=t.group_id AND a.device_id=t.device_id AND a.fingerprint=t.fingerprint AND a.controller_attestation_id=t.controller_attestation_id AND a.authority_kind=t.authority_kind AND a.device_claim_id IS NULL AND a.auth_config_revision=t.auth_config_revision AND a.created_at_ms=t.finalized_at_ms)) SELECT 1 FROM controller_receipt)`;
}
export function authAccountLinkProvenanceSql(
	link: "l",
	options: { connections?: boolean } = {},
): string {
	return `((${link}.authority_kind = 'controller_attestation' AND ${link}.controller_attestation_id IS NOT NULL AND ${link}.device_claim_id IS NULL${options.connections ? ` AND ${controllerBirthProvenance(link)}` : ""})
 OR (${authDeviceClaimProvenanceSql({ link, connections: options.connections })}))`;
}
