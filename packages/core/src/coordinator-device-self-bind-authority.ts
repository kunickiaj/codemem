import { hasConnectionSessionSchema } from "./coordinator-account-connection-session.js";
import {
	AUTH_DEVICE_CLAIM_INVITE_CONSUMED_SQL,
	AUTH_DEVICE_CLAIM_KEYS_READ,
	captureDeviceClaimSubject,
	deriveDeviceClaimKeyFacts,
	deviceClaimAssignmentInputs,
} from "./coordinator-auth-device-claim-eligibility.js";
import {
	HEADLESS_LINK_PROVENANCE_TABLE,
	hasHeadlessLinkProvenance,
} from "./coordinator-auth-headless-schema.js";
import { AUTH_LEGACY_ASSIGNMENT_READ_SQL } from "./coordinator-auth-legacy-assignment.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";
import { type AuthRead, readSnapshot } from "./coordinator-auth-read-set.js";
import {
	decideDeviceSelfBind,
	type SelfBindFacts,
	type SelfBindSubject,
} from "./coordinator-device-self-bind-decision.js";
import { legacyDecisionCountsAsOwnerSql } from "./coordinator-legacy-team-completion.js";
import { readNegativeOwnerConsistency } from "./coordinator-owner-negative-read-set.js";

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
const LIVE_STATES = "('pending','browser_claimed','oidc_verified','confirmed')";
const ALIASES = "(SELECT value FROM json_each(?))";

/** What the fact reads depend on besides the subject. */
interface ReadContext {
	connections: boolean;
	headless: boolean;
}

/**
 * One small plain read per fact, each ordered by its key. A `...Conflicts` read selects
 * only rows that forbid the ceremony, so the decision requires it to be empty and its
 * guard requires it to stay empty.
 */
const FACT_READS: {
	[Name in keyof SelfBindFacts]: (p: SelfBindSubject, context: ReadContext) => AuthRead;
} = {
	// Only the signed group has to be live, so only its rows carry that verdict. Another
	// group being archived must not abort the write.
	enrollments: (p) => ({
		sql: `SELECT json_object('group_id',e.group_id,'device_id',e.device_id,'public_key',e.public_key,
 'fingerprint',e.fingerprint,'identity_id',e.identity_id,'enabled',e.enabled,'created_at',e.created_at,
 'group_live',CASE WHEN e.group_id=? THEN EXISTS (SELECT 1 FROM groups g WHERE g.group_id=e.group_id AND g.archived_at IS NULL) END) AS row
 FROM enrolled_devices e WHERE e.device_id=? OR e.public_key IN ${ALIASES} ORDER BY e.device_id,e.group_id`,
		values: [p.groupId, p.deviceId, JSON.stringify(p.aliases)],
	}),
	attestations: (p) => ({
		sql: `SELECT json_object('coordinator_id',t.coordinator_id,'attestation_id',t.attestation_id,
 'identity_id',t.identity_id,'group_id',t.group_id,'device_id',t.device_id,'public_key',t.public_key,
 'fingerprint',t.fingerprint,'review_receipt_id',t.review_receipt_id,'evidence_digest',t.evidence_digest,
 'enrollment_identity_id',t.enrollment_identity_id,'revision',t.revision,'created_at',t.created_at,
 'revoked_at',t.revoked_at) AS row
 FROM coordinator_auth_controller_attestations t WHERE t.coordinator_id=?
 AND (t.device_id=? OR t.public_key IN ${ALIASES}) ORDER BY t.attestation_id`,
		values: [p.coordinatorId, p.deviceId, JSON.stringify(p.aliases)],
	}),
	// The creation-record proofs are verdict columns: each compares dozens of columns
	// across several tables, and the guard re-runs them with the read.
	links: (p, { connections, headless }) => ({
		sql: `SELECT json_object('link',json_array(l.coordinator_id,l.link_id,l.identity_id,l.issuer,l.subject,l.authority_kind,l.controller_attestation_id,l.device_claim_id,l.attempt_id,l.auth_config_revision,l.created_at_ms),
 'issuer',l.issuer,
 'proven',${authAccountLinkProvenanceSql("l", { connections })},
 'controller_receipt',(l.authority_kind<>'controller_attestation' OR ${CONTROLLER_BIRTH}),
 'headless',${headless ? `EXISTS (SELECT 1 FROM ${HEADLESS_LINK_PROVENANCE_TABLE} h WHERE h.coordinator_id=l.coordinator_id AND h.link_id=l.link_id)` : "0"},
 'linkController',json((SELECT json_group_array(json_array(s.attestation_id,s.identity_id,s.group_id,s.device_id,s.public_key,s.fingerprint,s.review_receipt_id,s.evidence_digest,s.enrollment_identity_id,s.revision,s.created_at,s.revoked_at)) FROM coordinator_auth_controller_attestations s WHERE s.coordinator_id=l.coordinator_id AND s.attestation_id=l.controller_attestation_id)),
 'linkClaim',json((SELECT json_group_array(json_array(d.claim_id,d.identity_id,d.group_id,d.device_id,d.public_key,d.fingerprint,d.key_id,d.attempt_id,d.issuer,d.auth_config_revision,d.created_at_ms)) FROM coordinator_auth_device_claims d WHERE d.coordinator_id=l.coordinator_id AND d.claim_id=l.device_claim_id))) AS row
 FROM coordinator_auth_account_links l WHERE l.coordinator_id=? AND l.identity_id=? AND l.revoked_at_ms IS NULL
 ORDER BY l.link_id`,
		values: [p.coordinatorId, p.identityId],
	}),
	inviteConflicts: (p) => ({
		sql: `SELECT json_object('invite_id',i.invite_id) AS row FROM coordinator_invites i
 WHERE ${AUTH_DEVICE_CLAIM_INVITE_CONSUMED_SQL}
 AND (i.bound_device_id=? OR i.bound_public_key IN ${ALIASES} OR i.bound_fingerprint=?)
 AND ((i.assigned_identity_id IS NOT NULL AND i.assigned_identity_id<>?)
 OR (i.target_identity_id IS NOT NULL AND i.target_identity_id<>?))
 ORDER BY i.invite_id`,
		values: [p.deviceId, JSON.stringify(p.aliases), p.fingerprint, p.identityId, p.identityId],
	}),
	bindingConflicts: (p) => ({
		sql: `SELECT json_object('device_id',b.device_id) AS row FROM coordinator_device_ownership_bindings b
 WHERE b.device_id=? OR b.key_id=? ORDER BY b.device_id`,
		values: [p.deviceId, p.keyId],
	}),
	claimConflicts: (p) => ({
		sql: `SELECT json_object('claim_id',d.claim_id) AS row FROM coordinator_auth_device_claims d
 WHERE d.coordinator_id=? AND (d.device_id=? OR d.key_id=?) ORDER BY d.claim_id`,
		values: [p.coordinatorId, p.deviceId, p.keyId],
	}),
	revocationConflicts: (p) => ({
		sql: `SELECT json_object('subject_kind',r.subject_kind) AS row FROM coordinator_device_revocations r
 WHERE (r.subject_kind='device_id' AND r.subject_value=?) OR (r.subject_kind='ed25519_key' AND r.subject_value=?)
 ORDER BY r.subject_kind`,
		values: [p.deviceId, p.keyId],
	}),
	otherIdentityLinkAttemptConflicts: (p) => ({
		sql: `SELECT json_object('link_id',l.link_id,'attempt_id',a.attempt_id) AS row
 FROM coordinator_auth_account_links l JOIN coordinator_auth_link_attempts a
 ON a.coordinator_id=l.coordinator_id AND a.link_id=l.link_id
 WHERE l.coordinator_id=? AND l.identity_id<>? AND (a.device_id=? OR a.public_key IN ${ALIASES})
 ORDER BY l.link_id,a.attempt_id`,
		values: [p.coordinatorId, p.identityId, p.deviceId, JSON.stringify(p.aliases)],
	}),
	otherIdentityLinkAuditConflicts: (p) => ({
		sql: `SELECT json_object('link_id',l.link_id,'action',a.action) AS row
 FROM coordinator_auth_account_links l JOIN coordinator_auth_link_audit_log a
 ON a.coordinator_id=l.coordinator_id AND a.link_id=l.link_id
 WHERE l.coordinator_id=? AND a.device_id=? AND l.identity_id<>? ORDER BY l.link_id,a.action`,
		values: [p.coordinatorId, p.deviceId, p.identityId],
	}),
	ownerAttemptConflicts: (p) => ({
		sql: `SELECT json_object('attempt_id',o.attempt_id) AS row FROM coordinator_owner_enrollment_attempts o
 WHERE o.coordinator_id=? AND o.state IN ${LIVE_STATES} AND o.expires_at_ms>? AND (o.device_id=? OR o.key_id=?)
 ORDER BY o.attempt_id`,
		values: [p.coordinatorId, p.nowMs, p.deviceId, p.keyId],
	}),
	linkAttemptConflicts: (p) => ({
		sql: `SELECT json_object('attempt_id',b.attempt_id) AS row FROM coordinator_auth_link_attempts b
 WHERE b.coordinator_id=? AND b.state IN ${LIVE_STATES} AND b.expires_at_ms>? AND b.identity_id<>?
 AND (b.device_id=? OR b.public_key IN ${ALIASES}) ORDER BY b.attempt_id`,
		values: [p.coordinatorId, p.nowMs, p.identityId, p.deviceId, JSON.stringify(p.aliases)],
	}),
	rebindAttemptConflicts: (p) => ({
		sql: `SELECT json_object('attempt_id',r.attempt_id) AS row FROM coordinator_device_rebind_attempts r
 WHERE r.coordinator_id=? AND r.attempt_id IS NOT ? AND r.state IN ${LIVE_STATES} AND r.expires_at_ms>?
 AND (r.device_id=? OR r.key_id=?) ORDER BY r.attempt_id`,
		values: [p.coordinatorId, p.attemptId, p.nowMs, p.deviceId, p.keyId],
	}),
	// No trigger makes completion rows immutable or undeletable, so the guard re-runs
	// this scan over every manifest. A cheaper projection could miss an edited manifest.
	legacyDecisionConflicts: (p) => ({
		sql: `SELECT json_object('group_id',c.group_id,'candidate_ref',c.candidate_ref,'decision',d.key) AS row
 FROM coordinator_legacy_team_completions c,json_each(${manifest},'$.device_decisions') d
 WHERE json_extract(${manifest},'$.coordinator_id')=?
 AND (json_extract(d.value,'$.device_id')=? OR json_extract(d.value,'$.key_fingerprint')=?)
 AND (${legacyDecisionCountsAsOwnerSql("d.value", "deny")})
 AND (json_extract(d.value,'$.decision')='excluded' OR json_extract(d.value,'$.identity_id') IS NOT ?)
 ORDER BY c.group_id,c.candidate_ref,d.key`,
		values: [p.coordinatorId, p.deviceId, p.fingerprint, p.identityId],
	}),
};

function factReads(
	p: SelfBindSubject,
	context: ReadContext,
): Record<keyof SelfBindFacts, AuthRead> {
	const names = Object.keys(FACT_READS) as (keyof SelfBindFacts)[];
	return Object.fromEntries(names.map((name) => [name, FACT_READS[name](p, context)])) as Record<
		keyof SelfBindFacts,
		AuthRead
	>;
}

export interface DeviceSelfBindAuthority {
	/** Stored as `start_authority_json` at start; every later step requires the same text. */
	snapshot: string;
	/** These go first in the batch that writes. They re-run every read behind the pin. */
	guards: AuthLinkStatement[];
}

/**
 * Validates the request, reads the stored keys and the legacy assignment, and derives
 * the key ID and the key's stored text forms. Null when the request is not acceptable.
 */
async function readSubject(
	backend: AuthLinkBackend,
	input: DeviceSelfBindInput,
	config: CoordinatorAuthLinkConfig,
	now: number,
): Promise<{ subject: SelfBindSubject; guards: AuthLinkStatement[] } | null> {
	const claim = await captureDeviceClaimSubject(
		{
			signer: input.signer,
			identityId: input.currentIdentityId,
			...(input.attemptId ? { attemptId: input.attemptId } : {}),
		},
		config,
	);
	if (!claim) return null;
	const stored = await readSnapshot<{ keys: string[]; assignment: unknown[] }>(backend, {
		keys: AUTH_DEVICE_CLAIM_KEYS_READ,
		assignment: {
			sql: AUTH_LEGACY_ASSIGNMENT_READ_SQL,
			values: deviceClaimAssignmentInputs(claim),
		},
	});
	const [assignment] = stored.rows.assignment;
	const keyFacts = deriveDeviceClaimKeyFacts(claim, {
		keys: stored.rows.keys,
		assignment: assignment ? JSON.stringify(assignment) : null,
	});
	// The assignment row holds a manifest of up to 1.5 MB and no trigger makes it
	// immutable, so its guard compares the whole row. That guard is needed only when
	// this device relies on the assignment; any other row does not affect the decision.
	const guards =
		keyFacts.assignmentSnapshot === null
			? [stored.guards.keys]
			: [stored.guards.keys, stored.guards.assignment];
	const subject: SelfBindSubject = {
		coordinatorId: claim.config.coordinatorId,
		identityId: claim.identityId,
		groupId: claim.signer.groupId,
		deviceId: claim.signer.deviceId,
		publicKey: claim.signer.publicKey,
		fingerprint: claim.signer.fingerprint,
		keyId: claim.keyId,
		issuer: claim.config.issuer,
		nowMs: now,
		attemptId: claim.attemptId,
		aliases: keyFacts.aliases,
	};
	return { subject, guards };
}

/**
 * Server proof only. Reads the facts, decides in TypeScript, and returns the pin with
 * the guards that re-run every read. The decision is void unless those guards run in
 * the batch that writes; never authorize from the pin alone.
 * The account link may originate on a peer. Its immutable genesis still has to verify.
 */
export async function prepareDeviceSelfBindAuthority(
	backend: AuthLinkBackend,
	input: DeviceSelfBindInput,
	config: CoordinatorAuthLinkConfig,
	now: number,
): Promise<DeviceSelfBindAuthority | null> {
	if (!(await hasDeviceRebindStartAuthorityColumn(backend))) return null;
	const prepared = await readSubject(backend, input, config, now);
	if (!prepared) return null;
	const negative = await readNegativeOwnerConsistency(backend, {
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
	const facts = await readSnapshot<SelfBindFacts>(
		backend,
		factReads(prepared.subject, { connections, headless }),
	);
	// The retained-ownership read set allowed this owner above; its guards join the batch.
	const snapshot = decideDeviceSelfBind(prepared.subject, facts.rows);
	if (snapshot === null) return null;
	return {
		snapshot,
		guards: [...prepared.guards, ...negative.guards, ...Object.values(facts.guards)],
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
		const authority = await prepareDeviceSelfBindAuthority(backend, input, config, now);
		return authority
			? { kind: "eligible", identityId: input.currentIdentityId }
			: { kind: "unavailable" };
	} catch {
		return { kind: "unavailable" };
	}
}
