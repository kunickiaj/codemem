import type { AuthLinkStatement } from "./coordinator-auth-link.js";

export interface AuthLifecycleFirstLinkOptions {
	coordinatorId: string;
	issuer: string;
	authConfigRevision: string;
	attemptId: string;
	linkId: string;
	now: number;
}

const RETAINED_FIRST_LINK_SQL = `EXISTS (SELECT 1 FROM coordinator_auth_account_links retained
 WHERE retained.coordinator_id = t.coordinator_id AND retained.link_id = t.link_id
 AND retained.attempt_id = t.attempt_id AND retained.identity_id = t.identity_id
 AND retained.issuer = t.issuer AND retained.subject = t.account_subject
 AND retained.auth_config_revision = t.auth_config_revision AND retained.created_at_ms = t.finalized_at_ms
 AND retained.authority_kind = t.authority_kind
 AND retained.controller_attestation_id IS t.controller_attestation_id
 AND retained.device_claim_id IS CASE WHEN t.authority_kind = 'device_claim' THEN t.link_id ELSE NULL END
 AND retained.generation = 1)`;

// A failed prerequisite must abort the enclosing batch, not filter away the
// link INSERT after its caller has already finalized the attempt. generation's
// NOT NULL constraint still enforces this when CHECK enforcement is disabled.
const FIRST_GENERATION_SQL = `CASE WHEN NOT EXISTS (
 SELECT 1 FROM coordinator_auth_account_links history
 WHERE history.coordinator_id = t.coordinator_id AND history.identity_id = t.identity_id)
 AND (t.authority_kind = 'controller_attestation'
  OR (t.authority_kind = 'device_claim' AND EXISTS (
   SELECT 1 FROM coordinator_auth_device_claims genesis
   WHERE genesis.coordinator_id = t.coordinator_id AND genesis.claim_id = t.link_id
   AND genesis.attempt_id = t.attempt_id AND genesis.identity_id = t.identity_id
   AND genesis.group_id = t.group_id AND genesis.device_id = t.device_id
   AND genesis.public_key = t.public_key AND genesis.fingerprint = t.fingerprint
   AND genesis.issuer = t.issuer AND genesis.auth_config_revision = t.auth_config_revision
   AND genesis.created_at_ms = t.finalized_at_ms))) THEN 1 END`;

/** First generation only, not an authorizer or reconnect implementation.
 * Append after the winning UPDATE and (for device claims) genesis claim insert;
 * append the winning audit/profile writes afterward in the same atomic batch.
 * Exact retained births are no-ops; all other Identity history aborts the batch.
 * Callers reconcile retained receipts rather than replaying audit/profile writes.
 */
export function authLifecycleFirstLinkStatements(
	options: AuthLifecycleFirstLinkOptions,
): AuthLinkStatement[] {
	const winning = `t.coordinator_id = ? AND t.issuer = ? AND t.auth_config_revision = ?
 AND t.attempt_id = ? AND t.link_id = ? AND t.finalized_at_ms = ? AND t.state = 'finalized'
 AND t.prior_link_id IS NULL AND t.prior_generation IS NULL AND t.account_subject IS NOT NULL
 AND NOT ${RETAINED_FIRST_LINK_SQL}`;
	const values = [
		options.coordinatorId,
		options.issuer,
		options.authConfigRevision,
		options.attemptId,
		options.linkId,
		options.now,
	];
	return [
		{
			sql: `INSERT INTO coordinator_auth_account_associations
 (coordinator_id,issuer,subject,identity_id,first_link_id,created_at_ms)
 SELECT t.coordinator_id,t.issuer,t.account_subject,t.identity_id,t.link_id,t.finalized_at_ms
 FROM coordinator_auth_link_attempts t WHERE ${winning}
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_associations reservation
  WHERE reservation.coordinator_id = t.coordinator_id AND reservation.issuer = t.issuer
  AND reservation.subject = t.account_subject)`,
			values,
		},
		{
			sql: `INSERT INTO coordinator_auth_account_links
 (coordinator_id,link_id,issuer,subject,identity_id,attempt_id,controller_attestation_id,
  auth_config_revision,created_at_ms,authority_kind,device_claim_id,generation,signin_sequence_floor)
 SELECT t.coordinator_id,t.link_id,t.issuer,t.account_subject,t.identity_id,t.attempt_id,
  t.controller_attestation_id,t.auth_config_revision,t.finalized_at_ms,t.authority_kind,
  CASE WHEN t.authority_kind = 'device_claim' THEN t.link_id ELSE NULL END,${FIRST_GENERATION_SQL},
  coalesce((SELECT max(b.browser_sequence) FROM coordinator_auth_browser_transactions b
   WHERE b.coordinator_id = t.coordinator_id),0)
 FROM coordinator_auth_link_attempts t WHERE ${winning}`,
			values,
		},
	];
}
