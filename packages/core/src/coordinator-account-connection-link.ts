import { hasConnectionSessionSchema } from "./coordinator-account-connection-session.js";
import {
	AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import { authClaimGenesisSql } from "./coordinator-auth-link-provenance.js";

/** Additive definitions installed by the explicit account-schema migration. */
export { CONNECTION_LINK_SCHEMA_STATEMENTS } from "./coordinator-account-connection-schema.js";

/** p is the captured requester, d its original immutable claim. Head lookup is
 * one indexed row; the archived genesis is addressed by claim_id, not recursion. */
export const CONNECTION_RELINK_ELIGIBLE_SQL = `(EXISTS (SELECT 1 FROM coordinator_auth_device_claims d
 WHERE (d.coordinator_id = p.coordinator_id AND d.identity_id = p.identity_id AND d.group_id = p.group_id)
 AND (d.device_id = p.device_id AND d.public_key = p.public_key AND d.fingerprint = p.fingerprint)
 AND (d.key_id = p.key_id AND d.issuer = p.issuer) AND ${authClaimGenesisSql("d")})
 AND EXISTS (SELECT 1 FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id WHERE (e.group_id = p.group_id AND e.device_id = p.device_id AND e.public_key = p.public_key AND e.fingerprint = p.fingerprint) AND (e.enabled = 1 AND g.archived_at IS NULL AND (e.identity_id IS NULL OR e.identity_id = p.identity_id)))
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r WHERE (r.subject_kind = 'device_id' AND r.subject_value = p.device_id) OR (r.subject_kind = 'ed25519_key' AND r.subject_value = p.key_id)))
 AND (NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links l WHERE l.coordinator_id = p.coordinator_id AND l.identity_id = p.identity_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = p.coordinator_id AND h.identity_id = p.identity_id AND h.revoked_at_ms IS NOT NULL)
 AND EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = p.coordinator_id AND h.identity_id = p.identity_id AND h.successor_link_id IS NULL))
 AND ((${AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL}) AND (${AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL}))
 AND ((${AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL}) AND (${AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL}) AND (${AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL}))`;

/** A renewed same-Identity review is distinct from a contradictory assignment. */
export const CONNECTION_REQUESTER_IDENTITY_SQL = `NOT EXISTS (SELECT 1 FROM coordinator_auth_controller_attestations a
 WHERE a.coordinator_id=p.coordinator_id AND (a.device_id=p.device_id OR EXISTS (SELECT 1 FROM claim_same_keys k WHERE k.value=a.public_key)) AND a.identity_id<>p.identity_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_device_claims d WHERE d.coordinator_id=p.coordinator_id AND (d.device_id=p.device_id OR d.key_id=p.key_id) AND d.identity_id<>p.identity_id)`;
/** Additional contradictions only: the outer writer must independently require
 * its exact live attestation, current enrollment snapshot and revocation checks. */
export async function connectionRequesterGuard(
	backend: AuthLinkBackend,
	identityId: string,
	signer: CoordinatorAuthLinkSigner,
	config: CoordinatorAuthLinkConfig,
	now: number,
): Promise<AuthLinkStatement> {
	const p = await captureDeviceClaimEligibility(backend, { identityId, signer }, config, now);
	if (!p) return { sql: "0 = 1", values: [] };
	return {
		sql: `EXISTS (${AUTH_DEVICE_CLAIM_INPUT_SQL} SELECT 1 FROM claim_input p WHERE (${AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL}) AND (${CONNECTION_REQUESTER_IDENTITY_SQL}) AND (${AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL}) AND (${AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL}) AND (${AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL}))`,
		values: p.values,
	};
}

/** t is the exact winning attempt; source authority is checked independently. */
export function connectionFinalizeGuard(t: "coordinator_auth_link_attempts"): string {
	return `NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links l WHERE l.coordinator_id = ${t}.coordinator_id AND l.identity_id = ${t}.identity_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = ${t}.coordinator_id AND h.identity_id = ${t}.identity_id AND h.revoked_at_ms IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = ${t}.coordinator_id AND h.issuer = ${t}.issuer AND h.subject = ${t}.account_subject AND h.identity_id <> ${t}.identity_id)
 AND ((${t}.prior_link_id IS NULL AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = ${t}.coordinator_id AND h.identity_id = ${t}.identity_id)) OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = ${t}.coordinator_id AND h.identity_id = ${t}.identity_id AND h.link_id = ${t}.prior_link_id AND h.successor_link_id IS NULL))`;
}

/** Pin the server's head in the same transaction as an attested/first creation.
 * The INSERT must be fresh; exact retries are handled by the existing reader. */
export async function createPinnedConnection(
	backend: AuthLinkBackend,
	statement: AuthLinkStatement,
	pin: { coordinator: string; attempt: string; identity: string; now: number },
): Promise<number> {
	if (!(await hasConnectionSessionSchema(backend))) return backend.run(statement);
	const head = await backend.first<{ link_id: string }>({
		sql: "SELECT link_id FROM coordinator_auth_account_connection_history WHERE coordinator_id = ? AND identity_id = ? AND successor_link_id IS NULL",
		values: [pin.coordinator, pin.identity],
	});
	await backend.batch([
		statement,
		{
			sql: `UPDATE coordinator_auth_link_attempts AS t SET prior_link_id = ? WHERE changes() = 1 AND t.coordinator_id = ? AND t.attempt_id = ? AND t.state = 'pending' AND t.created_at_ms = ?
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links l WHERE l.coordinator_id = t.coordinator_id AND l.identity_id = t.identity_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = t.coordinator_id AND h.identity_id = t.identity_id AND h.revoked_at_ms IS NOT NULL)
 AND ((? IS NULL AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = t.coordinator_id AND h.identity_id = t.identity_id)) OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id = t.coordinator_id AND h.identity_id = t.identity_id AND h.link_id = ? AND h.successor_link_id IS NULL))`,
			values: [
				head?.link_id ?? null,
				pin.coordinator,
				pin.attempt,
				pin.now,
				head?.link_id ?? null,
				head?.link_id ?? null,
			],
		},
		{
			sql: "INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) SELECT NULL,0 WHERE changes() <> 1",
			values: [],
		},
	]);
	return 1;
}

/** Append after current/audit publication, before profile/session exposure. */
export function connectionSuccessorStatements(
	coordinator: string,
	attempt: string,
	link: string,
): AuthLinkStatement[] {
	const pins = [coordinator, attempt, link];
	return [
		{
			sql: `UPDATE coordinator_auth_account_connection_history SET successor_link_id = ? WHERE successor_link_id IS NULL AND coordinator_id = ? AND link_id = (SELECT prior_link_id FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND attempt_id = ? AND link_id = ? AND state = 'finalized')`,
			values: [link, coordinator, ...pins],
		},
		{
			sql: `INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) SELECT NULL,0 WHERE changes() <> 1 AND EXISTS (SELECT 1 FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND attempt_id = ? AND link_id = ? AND state = 'finalized' AND prior_link_id IS NOT NULL)`,
			values: pins,
		},
	];
}
