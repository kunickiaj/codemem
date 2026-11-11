/**
 * Test-only. This file exists only to pin equivalence with the pre-port SQL.
 *
 * Everything between the two markers is the account-change authority builder, its
 * requester-binding SQL and its target derivation as they were on main at 1088cf8de,
 * before the port to read-set validation, copied verbatim from AccountChangeOperations.
 * Only the method headers changed: each private method became a function that takes
 * the backend, so `this.backend` and `this.first` read `backend`. The helpers above the
 * copy are the file-local constants it used, also unchanged.
 * coordinator-account-change-equivalence.test.ts runs it beside the ported reads and
 * decision. Do not edit the copy to follow later changes; delete this file with that test
 * when the equivalence no longer needs pinning.
 */
import {
	CONNECTION_REQUESTER_ACTIVE_OTHER_CLAIM_SQL,
	CONNECTION_REQUESTER_ATTESTATION_IDENTITY_SQL,
	CONNECTION_REQUESTER_IDENTITY_SQL,
} from "./coordinator-account-connection-link.js";
import { CONNECTION_NOT_REVOKED_SQL } from "./coordinator-account-connection-storage.js";
import {
	AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_LEGACY_UNWAIVABLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import {
	AUTH_LINK_CONTROLLER_SOURCE_SQL,
	type AuthLinkBackend,
	type AuthLinkStatement,
	authLinkControllerSourceValues,
} from "./coordinator-auth-link.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import {
	authClaimGenesisSql,
	authDeviceClaimProvenanceSql,
} from "./coordinator-auth-link-provenance.js";

const current = "coordinator_auth_account_links";
const sql = (query: string, values: AuthLinkStatement["values"] = []): AuthLinkStatement => ({
	sql: query,
	values,
});
interface Signed {
	signer: CoordinatorAuthLinkSigner;
}
function signerValues(s: CoordinatorAuthLinkSigner): string[] {
	return [s.groupId, s.deviceId, s.publicKey, s.fingerprint];
}

// ---- verbatim copy starts ----
/** This exact device key's ownership binding for the requested Identity, if any. */
const REQUESTER_BINDING_SQL = `SELECT ob.binding_id, ob.identity_id FROM claim_input p
 JOIN coordinator_device_ownership_bindings ob ON ob.coordinator_id = p.coordinator_id
 AND ob.device_id = p.device_id AND ob.key_id = p.key_id AND ob.identity_id = p.identity_id`;

// An ownership binding (ADR 0005 Section 8 rebind) is this exact device key's own
// proof for its Identity, like its own claim or attestation, and it supersedes
// conflicting legacy Team history for that device.
export async function originalAccountChangeAuthority(
	backend: AuthLinkBackend,
	c: CoordinatorAuthLinkConfig,
	s: CoordinatorAuthLinkSigner,
	target: { identity_id: string; target_link_id: string },
	now: number,
) {
	const captured = await captureDeviceClaimEligibility(
		backend,
		{ identityId: target.identity_id, signer: s },
		c,
		now,
	);
	if (!captured) return null;
	// Independent proof facts keep native D1's expression depth below 100.
	const facts = `,
 device_births AS MATERIALIZED (SELECT l.coordinator_id,l.link_id FROM coordinator_auth_account_links l JOIN claim_input p ON p.coordinator_id=l.coordinator_id AND p.identity_id=l.identity_id WHERE ${authDeviceClaimProvenanceSql({ link: "l", connections: captured.connectionSession })}),
 original_claims AS MATERIALIZED (SELECT d.* FROM coordinator_auth_device_claims d JOIN claim_input p ON p.coordinator_id=d.coordinator_id AND p.identity_id=d.identity_id WHERE ${captured.connectionSession ? authClaimGenesisSql("d") : "1 = 1"}),
 controller_births AS MATERIALIZED (SELECT l.coordinator_id,l.link_id FROM coordinator_auth_account_links l
 JOIN coordinator_auth_link_attempts b ON b.coordinator_id=l.coordinator_id AND b.link_id=l.link_id AND b.attempt_id=l.attempt_id
 JOIN coordinator_auth_link_audit_log ca ON ca.coordinator_id=l.coordinator_id AND ca.link_id=l.link_id AND ca.action='link_created'
 JOIN coordinator_auth_controller_attestations origin ON origin.coordinator_id=l.coordinator_id AND origin.attestation_id=l.controller_attestation_id
 WHERE (l.authority_kind='controller_attestation' AND l.device_claim_id IS NULL AND b.authority_kind=l.authority_kind AND b.controller_attestation_id=l.controller_attestation_id)
 AND (ca.attempt_id=b.attempt_id AND ca.identity_id=l.identity_id AND ca.controller_attestation_id=l.controller_attestation_id AND ca.authority_kind=l.authority_kind AND ca.auth_config_revision=l.auth_config_revision AND ca.group_id=b.group_id AND ca.device_id=b.device_id AND ca.fingerprint=b.fingerprint AND ca.created_at_ms=l.created_at_ms AND b.finalized_at_ms=l.created_at_ms)
 AND (origin.group_id=b.group_id AND origin.device_id=b.device_id AND origin.public_key=b.public_key AND origin.fingerprint=b.fingerprint AND origin.identity_id=b.identity_id AND origin.review_receipt_id=b.controller_review_receipt_id AND origin.revision=b.controller_revision)
 ${captured.connectionSession ? "AND (b.prior_link_id IS NULL OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id=b.coordinator_id AND h.identity_id=b.identity_id AND h.link_id=b.prior_link_id AND h.successor_link_id=b.link_id))" : ""})`;
	return sql(
		`${AUTH_DEVICE_CLAIM_INPUT_SQL}, current_controller AS MATERIALIZED (SELECT a.* ${AUTH_LINK_CONTROLLER_SOURCE_SQL})${facts},
 requester_binding AS MATERIALIZED (${REQUESTER_BINDING_SQL}),
 requester_ok AS MATERIALIZED (SELECT p.* FROM claim_input p WHERE (${AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL}) AND (${CONNECTION_REQUESTER_ATTESTATION_IDENTITY_SQL}) AND ((${CONNECTION_REQUESTER_IDENTITY_SQL}) OR (EXISTS (SELECT 1 FROM requester_binding) AND ${CONNECTION_REQUESTER_ACTIVE_OTHER_CLAIM_SQL})) AND ((${AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL}) OR EXISTS (SELECT 1 FROM current_controller cc WHERE cc.identity_id=p.identity_id)) AND (${AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL}) AND (${AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL}) AND (${AUTH_DEVICE_CLAIM_LEGACY_UNWAIVABLE_SQL}) AND ((${AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL}) OR EXISTS (SELECT 1 FROM requester_binding))), change_authority AS MATERIALIZED (
 SELECT l.*,e.identity_id AS enrollment_identity_id FROM requester_ok p
 JOIN ${current} l ON l.coordinator_id = p.coordinator_id AND l.link_id = ? AND l.identity_id = p.identity_id AND l.issuer = p.issuer
 JOIN enrolled_devices e ON e.group_id = p.group_id AND e.device_id = p.device_id AND e.public_key = p.public_key AND e.fingerprint = p.fingerprint
 JOIN groups g ON g.group_id = e.group_id
 JOIN coordinator_auth_link_attempts b ON b.coordinator_id = l.coordinator_id AND b.link_id = l.link_id AND b.attempt_id = l.attempt_id
 LEFT JOIN controller_births cb ON cb.coordinator_id=l.coordinator_id AND cb.link_id=l.link_id
 LEFT JOIN device_births db ON db.coordinator_id=l.coordinator_id AND db.link_id=l.link_id
 LEFT JOIN current_controller cc ON cc.identity_id=l.identity_id
 LEFT JOIN requester_binding rb ON rb.identity_id=l.identity_id
 LEFT JOIN original_claims d ON d.coordinator_id=l.coordinator_id AND ${captured.connectionSession ? "d.identity_id=l.identity_id" : "d.claim_id=l.device_claim_id"} AND d.group_id=p.group_id AND d.device_id=p.device_id AND d.public_key=p.public_key AND d.fingerprint=p.fingerprint AND d.key_id=p.key_id
 WHERE (e.enabled = 1 AND g.archived_at IS NULL AND (e.identity_id IS NULL OR e.identity_id = l.identity_id))
 AND (b.identity_id = l.identity_id AND b.issuer = l.issuer AND b.account_subject = l.subject AND b.auth_config_revision = l.auth_config_revision AND b.state IN ('finalized','session_redeemed'))
 AND (${CONNECTION_NOT_REVOKED_SQL})
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r WHERE (r.subject_kind = 'device_id' AND r.subject_value = p.device_id) OR (r.subject_kind = 'ed25519_key' AND r.subject_value = p.key_id))
 AND (cb.link_id IS NOT NULL OR db.link_id IS NOT NULL) AND (cc.attestation_id IS NOT NULL OR d.claim_id IS NOT NULL OR rb.binding_id IS NOT NULL))`,
		[...captured.values, ...authLinkControllerSourceValues(c, s), target.target_link_id],
	);
}
// Expected Identity is checked after deriving authority, never used to grant it.
// This device's binding wins a tie; the authority check still denies when an
// older claim's link is active.
export function originalDeriveTarget(
	backend: AuthLinkBackend,
	c: CoordinatorAuthLinkConfig,
	i: Pick<Signed, "signer">,
	key: string,
) {
	return backend.first<{ identity_id: string; target_link_id: string }>(
		sql(
			`SELECT l.identity_id,l.link_id AS target_link_id FROM ${current} l
 LEFT JOIN coordinator_auth_device_claims d ON d.coordinator_id = l.coordinator_id AND d.identity_id = l.identity_id
 LEFT JOIN coordinator_auth_controller_attestations a ON a.coordinator_id = l.coordinator_id AND a.identity_id = l.identity_id
 LEFT JOIN coordinator_device_ownership_bindings ob ON ob.coordinator_id = l.coordinator_id AND ob.identity_id = l.identity_id
 WHERE l.coordinator_id = ? AND ((d.device_id = ? AND d.key_id = ?) OR
 (a.group_id = ? AND a.device_id = ? AND a.public_key = ? AND a.fingerprint = ? AND a.revoked_at IS NULL)
 OR (ob.device_id = ? AND ob.key_id = ?))
 ORDER BY (ob.device_id = ? AND ob.key_id = ?) DESC, l.link_id`,
			[
				c.coordinatorId,
				i.signer.deviceId,
				key,
				...signerValues(i.signer),
				i.signer.deviceId,
				key,
				i.signer.deviceId,
				key,
			],
		),
	);
}
// ---- verbatim copy ends ----

/** One row of the original change_authority, in the columns the writes record. */
export interface OriginalGrantRow {
	coordinator_id: string;
	link_id: string;
	identity_id: string;
	issuer: string;
	subject: string;
	enrollment_identity_id: string | null;
}

/** The original's change_authority rows, or null when it built no statement. */
export async function originalAccountChangeRows(
	backend: AuthLinkBackend,
	c: CoordinatorAuthLinkConfig,
	s: CoordinatorAuthLinkSigner,
	target: { identity_id: string; target_link_id: string },
	now: number,
): Promise<OriginalGrantRow[] | null> {
	const statement = await originalAccountChangeAuthority(backend, c, s, target, now);
	if (!statement) return null;
	if (!backend.all) throw new Error("fixture backend cannot read rows");
	return backend.all<OriginalGrantRow>({
		sql: `${statement.sql} SELECT coordinator_id,link_id,identity_id,issuer,subject,enrollment_identity_id FROM change_authority ORDER BY link_id`,
		values: statement.values,
	});
}

/**
 * The original statement's conjuncts, one check each: the eight requester_ok conditions
 * and the change_authority joins and WHERE conditions. They reuse the original WITH
 * clause; only this final SELECT is new. A join that finds no row fails its checks.
 */
const ORIGINAL_CHECKS = {
	requesterSubject: AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL,
	requesterAttestationIdentity: CONNECTION_REQUESTER_ATTESTATION_IDENTITY_SQL,
	requesterClaimIdentity: `(${CONNECTION_REQUESTER_IDENTITY_SQL}) OR (EXISTS (SELECT 1 FROM requester_binding) AND ${CONNECTION_REQUESTER_ACTIVE_OTHER_CLAIM_SQL})`,
	requesterAttestation: `(${AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL}) OR EXISTS (SELECT 1 FROM current_controller cc WHERE cc.identity_id=p.identity_id)`,
	requesterInvite: AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL,
	requesterLink: AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL,
	requesterLegacyUnwaivable: AUTH_DEVICE_CLAIM_LEGACY_UNWAIVABLE_SQL,
	requesterLegacy: `(${AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL}) OR EXISTS (SELECT 1 FROM requester_binding)`,
	link: "l.link_id IS NOT NULL AND l.identity_id = p.identity_id AND l.issuer = p.issuer",
	enrollment: "e.device_id IS NOT NULL",
	groupRow: "g.group_id IS NOT NULL",
	attempt: "b.attempt_id IS NOT NULL",
	enrollmentLive:
		"e.enabled = 1 AND g.archived_at IS NULL AND (e.identity_id IS NULL OR e.identity_id = l.identity_id)",
	attemptMatch:
		"b.identity_id = l.identity_id AND b.issuer = l.issuer AND b.account_subject = l.subject AND b.auth_config_revision = l.auth_config_revision AND b.state IN ('finalized','session_redeemed')",
	notRevoked: CONNECTION_NOT_REVOKED_SQL,
	deviceNotRevoked:
		"NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r WHERE (r.subject_kind = 'device_id' AND r.subject_value = p.device_id) OR (r.subject_kind = 'ed25519_key' AND r.subject_value = p.key_id))",
	birth: "cb.link_id IS NOT NULL OR db.link_id IS NOT NULL",
	proof: "cc.attestation_id IS NOT NULL OR d.claim_id IS NOT NULL OR rb.binding_id IS NOT NULL",
} as const;
export type OriginalCheck = keyof typeof ORIGINAL_CHECKS;
export const ORIGINAL_CHECK_NAMES = Object.keys(ORIGINAL_CHECKS) as OriginalCheck[];

/** The original checks that did not hold, or null when it built no statement. */
export async function originalFailedChecks(
	backend: AuthLinkBackend,
	c: CoordinatorAuthLinkConfig,
	s: CoordinatorAuthLinkSigner,
	target: { identity_id: string; target_link_id: string },
	now: number,
): Promise<OriginalCheck[] | null> {
	const statement = await originalAccountChangeAuthority(backend, c, s, target, now);
	if (!statement) return null;
	const session = await backend.first<{ present: number }>({
		sql: "SELECT count(*) AS present FROM pragma_table_info('coordinator_auth_browser_transactions') WHERE name = 'start_order'",
		values: [],
	});
	const claimJoin =
		session?.present === 1 ? "d.identity_id=l.identity_id" : "d.claim_id=l.device_claim_id";
	const columns = ORIGINAL_CHECK_NAMES.map(
		(name) => `coalesce((${ORIGINAL_CHECKS[name]}),0) AS ${name}`,
	);
	const row = await backend.first<Record<OriginalCheck, number>>({
		sql: `${statement.sql} SELECT ${columns.join(",")} FROM claim_input p
 LEFT JOIN ${current} l ON l.coordinator_id = p.coordinator_id AND l.link_id = ?
 LEFT JOIN enrolled_devices e ON e.group_id = p.group_id AND e.device_id = p.device_id AND e.public_key = p.public_key AND e.fingerprint = p.fingerprint
 LEFT JOIN groups g ON g.group_id = e.group_id
 LEFT JOIN coordinator_auth_link_attempts b ON b.coordinator_id = l.coordinator_id AND b.link_id = l.link_id AND b.attempt_id = l.attempt_id
 LEFT JOIN controller_births cb ON cb.coordinator_id=l.coordinator_id AND cb.link_id=l.link_id
 LEFT JOIN device_births db ON db.coordinator_id=l.coordinator_id AND db.link_id=l.link_id
 LEFT JOIN current_controller cc ON cc.identity_id=l.identity_id
 LEFT JOIN requester_binding rb ON rb.identity_id=l.identity_id
 LEFT JOIN original_claims d ON d.coordinator_id=l.coordinator_id AND ${claimJoin} AND d.group_id=p.group_id AND d.device_id=p.device_id AND d.public_key=p.public_key AND d.fingerprint=p.fingerprint AND d.key_id=p.key_id`,
		values: [...statement.values, target.target_link_id],
	});
	return ORIGINAL_CHECK_NAMES.filter((name) => row?.[name] !== 1);
}
