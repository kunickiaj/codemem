import { hasConnectionSessionSchema } from "./coordinator-account-connection-session.js";
import {
	AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import {
	HEADLESS_LINK_PROVENANCE_TABLE,
	hasHeadlessLinkProvenance,
} from "./coordinator-auth-headless-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";
import { legacyDecisionCountsAsOwnerSql } from "./coordinator-legacy-team-completion.js";
import { prepareNegativeOwnerConsistency } from "./coordinator-owner-negative-consistency.js";

export interface DeviceSelfBindInput {
	signer: CoordinatorAuthLinkSigner;
	currentIdentityId: string;
	attemptId?: string;
}

export async function hasDeviceRebindStartAuthorityColumn(
	backend: AuthLinkBackend,
): Promise<boolean> {
	return (
		(await backend.first({
			sql: "SELECT 1 FROM pragma_table_info('coordinator_device_rebind_attempts') WHERE name='start_authority_json'",
			values: [],
		})) !== null
	);
}

const manifest = "CASE WHEN json_valid(c.manifest_json) THEN c.manifest_json ELSE '{}' END";
// The older account reader treats controller links as account-management evidence.
// This ownership ceremony additionally requires their complete browser creation receipt.
const CONTROLLER_BIRTH = `EXISTS (SELECT 1 FROM coordinator_auth_link_attempts b
 JOIN coordinator_auth_controller_attestations o ON o.coordinator_id=b.coordinator_id AND o.attestation_id=b.controller_attestation_id
 JOIN coordinator_auth_link_audit_log r ON r.coordinator_id=b.coordinator_id AND r.link_id=b.link_id AND r.action='link_created'
 WHERE (b.coordinator_id=l.coordinator_id AND b.attempt_id=l.attempt_id AND b.link_id=l.link_id AND b.authority_kind='controller_attestation' AND b.controller_attestation_id=l.controller_attestation_id)
 AND (b.identity_id=l.identity_id AND b.issuer=l.issuer AND b.account_subject=l.subject AND b.auth_config_revision=l.auth_config_revision AND b.finalized_at_ms=l.created_at_ms AND b.state IN ('finalized','session_redeemed'))
 AND (b.browser_start_hash IS NOT NULL AND b.browser_transaction_hash IS NOT NULL AND b.runtime_verifier_hash IS NOT NULL AND b.completion_secret_hash IS NOT NULL)
 AND (b.created_at_ms<=b.claimed_at_ms AND b.claimed_at_ms<=b.oidc_verified_at_ms AND b.oidc_verified_at_ms<=b.confirmed_at_ms AND b.confirmed_at_ms<=b.finalized_at_ms AND b.finalized_at_ms<b.expires_at_ms)
 AND (o.identity_id=b.identity_id AND o.group_id=b.group_id AND o.device_id=b.device_id AND o.public_key=b.public_key AND o.fingerprint=b.fingerprint AND o.review_receipt_id=b.controller_review_receipt_id AND o.revision=b.controller_revision)
 AND (r.attempt_id=b.attempt_id AND r.identity_id=b.identity_id AND r.group_id=b.group_id AND r.device_id=b.device_id AND r.fingerprint=b.fingerprint AND r.controller_attestation_id=b.controller_attestation_id AND r.authority_kind=b.authority_kind AND r.device_claim_id IS NULL AND r.auth_config_revision=b.auth_config_revision AND r.created_at_ms=b.finalized_at_ms))`;
const CHECKS = [
	`EXISTS (SELECT 1 FROM enrolled_devices e JOIN groups g ON g.group_id=e.group_id
 WHERE e.group_id=p.group_id AND e.device_id=p.device_id AND e.public_key=p.public_key
 AND e.fingerprint=p.fingerprint AND e.enabled=1 AND g.archived_at IS NULL
 AND (e.identity_id IS NULL OR e.identity_id=p.identity_id))`,
	`(SELECT count(*) FROM enrolled_devices e WHERE e.device_id=p.device_id) BETWEEN 1 AND 50
 AND NOT EXISTS (SELECT 1 FROM enrolled_devices e WHERE e.device_id=p.device_id
 AND (e.public_key<>p.public_key OR e.fingerprint<>p.fingerprint OR (e.identity_id IS NOT NULL AND e.identity_id<>p.identity_id)))`,
	`NOT EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings b WHERE b.device_id=p.device_id OR b.key_id=p.key_id)`,
	`NOT EXISTS (SELECT 1 FROM coordinator_auth_device_claims d WHERE d.coordinator_id=p.coordinator_id AND (d.device_id=p.device_id OR d.key_id=p.key_id))`,
	`NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r WHERE (r.subject_kind='device_id' AND r.subject_value=p.device_id) OR (r.subject_kind='ed25519_key' AND r.subject_value=p.key_id))`,
	AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL,
	`NOT EXISTS (SELECT 1 FROM enrolled_devices e,claim_same_keys k WHERE e.public_key=k.value AND e.device_id<>p.device_id)`,
	`NOT EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts o WHERE o.coordinator_id=p.coordinator_id
 AND o.state IN ('pending','browser_claimed','oidc_verified','confirmed') AND o.expires_at_ms>p.now_ms AND (o.device_id=p.device_id OR o.key_id=p.key_id))`,
	`NOT EXISTS (SELECT 1 FROM coordinator_auth_link_attempts b WHERE b.coordinator_id=p.coordinator_id
 AND b.state IN ('pending','browser_claimed','oidc_verified','confirmed') AND b.expires_at_ms>p.now_ms
 AND b.identity_id<>p.identity_id AND (b.device_id=p.device_id OR b.public_key IN (SELECT value FROM claim_same_keys)))`,
	`NOT EXISTS (SELECT 1 FROM coordinator_device_rebind_attempts r WHERE r.coordinator_id=p.coordinator_id
 AND r.attempt_id IS NOT p.attempt_id AND r.state IN ('pending','browser_claimed','oidc_verified','confirmed')
 AND r.expires_at_ms>p.now_ms AND (r.device_id=p.device_id OR r.key_id=p.key_id))`,
	`NOT EXISTS (SELECT 1 FROM coordinator_legacy_team_completions c,json_each(${manifest},'$.device_decisions') d
 WHERE json_extract(${manifest},'$.coordinator_id')=p.coordinator_id
 AND (json_extract(d.value,'$.device_id')=p.device_id OR json_extract(d.value,'$.key_fingerprint')=p.fingerprint)
 AND (${legacyDecisionCountsAsOwnerSql("d.value", "deny")})
 AND (json_extract(d.value,'$.decision')='excluded' OR json_extract(d.value,'$.identity_id') IS NOT p.identity_id))`,
	`(SELECT count(*) FROM self_bind_controllers)=1 AND (SELECT count(*) FROM self_bind_link_candidates)=1
 AND (SELECT count(*) FROM self_bind_links)=1`,
	`(SELECT count(*) FROM coordinator_auth_controller_attestations t WHERE t.coordinator_id=p.coordinator_id
 AND (t.device_id=p.device_id OR t.public_key IN (SELECT value FROM claim_same_keys)) AND t.revoked_at IS NULL)=1`,
];

/** Server proof only. Embed this SELECT in the winning statement, never authorize from a pre-read.
 * The account link may originate on a peer. Its immutable genesis still has to verify.
 */
export async function prepareDeviceSelfBindAuthority(
	backend: AuthLinkBackend,
	input: DeviceSelfBindInput,
	config: CoordinatorAuthLinkConfig,
	now: number,
): Promise<AuthLinkStatement | null> {
	if (!(await hasDeviceRebindStartAuthorityColumn(backend))) return null;
	const captured = await captureDeviceClaimEligibility(
		backend,
		{
			signer: input.signer,
			identityId: input.currentIdentityId,
			...(input.attemptId ? { attemptId: input.attemptId } : {}),
		},
		config,
		now,
	);
	if (!captured) return null;
	const negative = await prepareNegativeOwnerConsistency(backend, {
		coordinatorId: config.coordinatorId,
		deviceId: input.signer.deviceId,
		publicKey: input.signer.publicKey,
		fingerprint: input.signer.fingerprint,
		ownerIdentityId: input.currentIdentityId,
		enrollment: { groupId: input.signer.groupId },
	});
	if (!negative) return null;
	const connections = await hasConnectionSessionSchema(backend);
	const headless = await hasHeadlessLinkProvenance(backend);
	return {
		sql: `WITH self_bind_negative AS MATERIALIZED (${negative.sql}), ${AUTH_DEVICE_CLAIM_INPUT_SQL.slice(5)},
 self_bind_controllers AS MATERIALIZED (SELECT t.* FROM coordinator_auth_controller_attestations t JOIN claim_input p
 ON t.coordinator_id=p.coordinator_id AND t.device_id=p.device_id AND t.public_key=p.public_key AND t.fingerprint=p.fingerprint
 WHERE t.identity_id=p.identity_id AND t.group_id=p.group_id AND t.revoked_at IS NULL),
 self_bind_link_candidates AS MATERIALIZED (SELECT l.* FROM coordinator_auth_account_links l JOIN claim_input p
 ON l.coordinator_id=p.coordinator_id AND l.identity_id=p.identity_id WHERE l.revoked_at_ms IS NULL),
 self_bind_controller_receipts AS MATERIALIZED (SELECT l.link_id FROM self_bind_link_candidates l WHERE ${CONTROLLER_BIRTH}),
 self_bind_links AS MATERIALIZED (SELECT l.* FROM self_bind_link_candidates l WHERE ${authAccountLinkProvenanceSql("l", { connections })}
 AND (l.authority_kind<>'controller_attestation' OR l.link_id IN (SELECT link_id FROM self_bind_controller_receipts))${headless ? ` AND NOT EXISTS (SELECT 1 FROM ${HEADLESS_LINK_PROVENANCE_TABLE} h WHERE h.coordinator_id=l.coordinator_id AND h.link_id=l.link_id)` : ""}),
 self_bind_checks AS MATERIALIZED (SELECT ${CHECKS.map((sql, i) => `(${sql}) AS g${i}`).join(",")} FROM claim_input p),
 self_bind_ok AS MATERIALIZED (SELECT ${CHECKS.map((_, i) => `g${i}`).join(" AND ")} AND n.matches AS ok FROM self_bind_checks CROSS JOIN self_bind_negative n)
 SELECT json_object('groupId',p.group_id,'keyId',p.key_id,'controller',json_array(t.coordinator_id,t.attestation_id,t.identity_id,t.group_id,t.device_id,t.public_key,t.fingerprint,t.review_receipt_id,t.evidence_digest,t.enrollment_identity_id,t.revision,t.created_at),
 'link',json_array(l.coordinator_id,l.link_id,l.identity_id,l.issuer,l.subject,l.authority_kind,l.controller_attestation_id,l.device_claim_id,l.attempt_id,l.auth_config_revision,l.created_at_ms),
 'linkController',json((SELECT json_group_array(json_array(s.attestation_id,s.identity_id,s.group_id,s.device_id,s.public_key,s.fingerprint,s.review_receipt_id,s.evidence_digest,s.enrollment_identity_id,s.revision,s.created_at,s.revoked_at)) FROM coordinator_auth_controller_attestations s WHERE s.coordinator_id=l.coordinator_id AND s.attestation_id=l.controller_attestation_id)),
 'linkClaim',json((SELECT json_group_array(json_array(d.claim_id,d.identity_id,d.group_id,d.device_id,d.public_key,d.fingerprint,d.key_id,d.attempt_id,d.issuer,d.auth_config_revision,d.created_at_ms)) FROM coordinator_auth_device_claims d WHERE d.coordinator_id=l.coordinator_id AND d.claim_id=l.device_claim_id)),
 'enrollments',json((SELECT json_group_array(json_array(group_id,public_key,fingerprint,identity_id,enabled,created_at)) FROM (SELECT * FROM enrolled_devices WHERE device_id=p.device_id ORDER BY group_id)))) AS snapshot
 FROM claim_input p CROSS JOIN self_bind_controllers t CROSS JOIN self_bind_links l WHERE (SELECT ok FROM self_bind_ok)=1 AND l.issuer=p.issuer`,
		values: [...negative.values, ...captured.values],
	};
}

/** Readiness is deliberately fail closed on D1 before migration 0044. */
export async function readDeviceSelfBindEligibility(
	backend: AuthLinkBackend,
	input: DeviceSelfBindInput,
	config: CoordinatorAuthLinkConfig,
	now: number,
): Promise<{ kind: "eligible"; identityId: string } | { kind: "unavailable" }> {
	try {
		const query = await prepareDeviceSelfBindAuthority(backend, input, config, now);
		const row = query ? await backend.first<{ snapshot: string }>(query) : null;
		return row
			? { kind: "eligible", identityId: input.currentIdentityId }
			: { kind: "unavailable" };
	} catch {
		return { kind: "unavailable" };
	}
}
