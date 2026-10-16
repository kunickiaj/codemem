import {
	AUTH_DEVICE_CLAIM_ELIGIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type { AuthLinkAttemptAuthorityRow } from "./coordinator-auth-link-authority.js";
import { readAuthLinkAttemptAuthority } from "./coordinator-auth-link-authority.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";

interface SourceRow extends AuthLinkAttemptAuthorityRow {
	identity_id: string;
	group_id: string;
	device_id: string;
	public_key: string;
	fingerprint: string;
	runtime_verifier_hash: string;
	browser_start_hash: string | null;
	loopback_redirect: string;
}

/** Fresh capture for one operation; the winning statement must include its SQL. */
export async function captureAuthLinkSource(
	backend: Pick<AuthLinkBackend, "first">,
	attemptId: string,
	config: CoordinatorAuthLinkConfig,
	now: number,
	alias: "a" | "coordinator_auth_link_attempts" = "coordinator_auth_link_attempts",
): Promise<AuthLinkStatement> {
	const row = await backend.first<SourceRow>({
		sql: "SELECT * FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND attempt_id = ?",
		values: [config.coordinatorId, attemptId],
	});
	const authority = row && readAuthLinkAttemptAuthority(row);
	if (!row || !authority) return { sql: "0 = 1", values: [] };
	if (authority.kind === "controller_attestation")
		return { sql: `${alias}.authority_kind = 'controller_attestation'`, values: [] };
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
