import {
	AUTH_DEVICE_CLAIM_ELIGIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type { AuthLinkAttemptAuthorityRow } from "./coordinator-auth-link-authority.js";
import { readAuthLinkAttemptAuthority } from "./coordinator-auth-link-authority.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
import { authDeviceClaimProvenanceSql } from "./coordinator-auth-link-provenance.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";

interface SourceRow extends AuthLinkAttemptAuthorityRow {
	identity_id: string;
	group_id: string;
	device_id: string;
	public_key: string;
	fingerprint: string;
	runtime_verifier_hash: string;
	browser_start_hash: string | null;
	loopback_redirect: string;
	state: string;
	completion_secret_hash: string | null;
}

/** Private predicate preparation, never a browser status or authorization result. */
export async function captureAuthLinkBrowserSource(
	backend: Pick<AuthLinkBackend, "first">,
	i: { binderHash: string; stateHash?: string; attemptId?: string },
	c: CoordinatorAuthLinkConfig & { redirectUri: string },
	now: number,
): Promise<AuthLinkStatement> {
	const row = await backend.first<{ attempt_id: string | null }>({
		sql: `SELECT attempt_id FROM coordinator_auth_browser_transactions b WHERE b.coordinator_id = ? AND b.issuer = ? AND b.auth_config_revision = ? AND b.redirect_uri = ? AND b.binder_hash = ?
 AND (? IS NULL OR b.state_hash = ?) AND (? IS NULL OR b.attempt_id = ?) AND b.purpose = 'link'`,
		values: [
			c.coordinatorId,
			c.issuer,
			c.revision,
			c.redirectUri,
			i.binderHash,
			i.stateHash ?? null,
			i.stateHash ?? null,
			i.attemptId ?? null,
			i.attemptId ?? null,
		],
	});
	if (!row?.attempt_id) return { sql: "0 = 1", values: [] };
	return captureAuthLinkSource(backend, row.attempt_id, c, now, "a");
}

/** Fresh capture for one operation; the winning statement must include its SQL. */
export async function captureAuthLinkSource(
	backend: Pick<AuthLinkBackend, "first">,
	attemptId: string,
	config: CoordinatorAuthLinkConfig,
	now: number,
	alias: "a" | "coordinator_auth_link_attempts" = "coordinator_auth_link_attempts",
	options: { currentDevice?: boolean } = {},
): Promise<AuthLinkStatement> {
	const row = await backend.first<SourceRow>({
		sql: "SELECT * FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND attempt_id = ?",
		values: [config.coordinatorId, attemptId],
	});
	const authority = row && readAuthLinkAttemptAuthority(row);
	if (!row || !authority) return { sql: "0 = 1", values: [] };
	if (authority.kind === "controller_attestation")
		return { sql: `${alias}.authority_kind = 'controller_attestation'`, values: [] };
	if (["finalized", "session_redeemed"].includes(row.state)) {
		const keyId = await ed25519KeyIdForRevocation(row.public_key);
		if (!keyId || row.browser_start_hash === null || row.completion_secret_hash === null)
			return { sql: "0 = 1", values: [] };
		return {
			sql: `(${alias}.authority_kind = 'device_claim'
 AND ${alias}.controller_attestation_id IS NULL AND ${alias}.controller_review_receipt_id IS NULL AND ${alias}.controller_revision IS NULL
 AND ${alias}.state IN ('finalized','session_redeemed') AND ${alias}.browser_start_hash = ?
 AND ${alias}.runtime_verifier_hash = ? AND ${alias}.completion_secret_hash = ? AND ${alias}.loopback_redirect = ?
 AND ${authDeviceClaimReceiptSql(alias)}${options.currentDevice ? ` AND ${currentDeviceSql(alias)}` : ""})`,
			values: [
				row.browser_start_hash,
				row.runtime_verifier_hash,
				row.completion_secret_hash,
				row.loopback_redirect,
				keyId,
				...(options.currentDevice ? [keyId] : []),
			],
		};
	}
	const captured = await captureDeviceClaimEligibility(
		backend,
		{
			attemptId,
			identityId: row.identity_id,
			signer: {
				groupId: row.group_id,
				deviceId: row.device_id,
				publicKey: row.public_key,
				fingerprint: row.fingerprint,
			},
		},
		config,
		now,
	);
	if (!captured || row.browser_start_hash === null) return { sql: "0 = 1", values: [] };
	// Separate the full predicate from the correlated browser match to stay below
	// native D1's expression-depth limit, without moving authority outside SQL.
	return {
		sql: `(${alias}.authority_kind = 'device_claim'
 AND ${alias}.controller_attestation_id IS NULL AND ${alias}.controller_review_receipt_id IS NULL
 AND ${alias}.controller_revision IS NULL AND ${alias}.link_id IS NULL
 AND ${alias}.runtime_verifier_hash = ? AND ${alias}.browser_start_hash = ? AND ${alias}.loopback_redirect = ?
 AND EXISTS (${AUTH_DEVICE_CLAIM_INPUT_SQL}, claim_eligible AS MATERIALIZED (
 SELECT p.* FROM claim_input p WHERE ${AUTH_DEVICE_CLAIM_ELIGIBLE_SQL})
 SELECT 1 FROM claim_eligible p
 WHERE ${alias}.coordinator_id = p.coordinator_id AND ${alias}.attempt_id = p.attempt_id
 AND ${alias}.identity_id = p.identity_id AND ${alias}.group_id = p.group_id
 AND ${alias}.device_id = p.device_id AND ${alias}.public_key = p.public_key AND ${alias}.fingerprint = p.fingerprint
 AND ${alias}.issuer = p.issuer AND ${alias}.auth_config_revision = p.revision))`,
		values: [
			row.runtime_verifier_hash,
			row.browser_start_hash,
			row.loopback_redirect,
			...captured.values,
		],
	};
}

function currentDeviceSql(t: string): string {
	return `EXISTS (SELECT 1 FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
 WHERE e.group_id = ${t}.group_id AND e.device_id = ${t}.device_id AND e.public_key = ${t}.public_key
 AND e.fingerprint = ${t}.fingerprint AND e.enabled = 1 AND g.archived_at IS NULL
 AND (e.identity_id IS NULL OR e.identity_id = ${t}.identity_id))
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
 WHERE (r.subject_kind = 'device_id' AND r.subject_value = ${t}.device_id)
 OR (r.subject_kind = 'ed25519_key' AND r.subject_value = ?))`;
}

/** Historical committed provenance, not first-binding eligibility or operator authority.
 * The caller binds the canonical key ID derived from the attempt's exact public key.
 */
function authDeviceClaimReceiptSql(t: string): string {
	return `EXISTS (SELECT 1 FROM coordinator_auth_account_links cl
 WHERE cl.coordinator_id = ${t}.coordinator_id AND cl.link_id = ${t}.link_id AND cl.attempt_id = ${t}.attempt_id
 AND cl.revoked_at_ms IS NULL AND ${authDeviceClaimProvenanceSql({ link: "cl", canonicalKeyId: "?" })})`;
}
