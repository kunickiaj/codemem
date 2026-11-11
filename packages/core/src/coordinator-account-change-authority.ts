import {
	type AccountChangeFacts,
	type AccountChangeGrant,
	type AccountChangeSubject,
	type AccountChangeTarget,
	type AccountChangeTargetCandidate,
	decideAccountChange,
	pickAccountChangeTarget,
} from "./coordinator-account-change-decision.js";
import {
	AUTH_DEVICE_CLAIM_INPUT_ROW_SQL,
	AUTH_DEVICE_CLAIM_INVITE_CONSUMED_SQL,
	AUTH_DEVICE_CLAIM_KEYS_READ,
	AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_LEGACY_UNWAIVABLE_SQL,
	captureDeviceClaimSubject,
	type DeviceClaimKeyFacts,
	type DeviceClaimSubject,
	deriveDeviceClaimKeyFacts,
	deviceClaimAssignmentInputs,
} from "./coordinator-auth-device-claim-eligibility.js";
import {
	AUTH_CURRENT_LEGACY_ASSIGNMENT_SQL,
	AUTH_LEGACY_ASSIGNMENT_READ_SQL,
} from "./coordinator-auth-legacy-assignment.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import {
	authClaimGenesisSql,
	authDeviceClaimProvenanceSql,
} from "./coordinator-auth-link-provenance.js";
import { type AuthRead, readSnapshot } from "./coordinator-auth-read-set.js";

/**
 * Account refresh and disconnect authority as read-set validation, in two stages of small
 * plain reads, each stage sent together through `readBatch` when the backend has one:
 *
 * 1. The base: the stored keys, the legacy assignment, the schema variant and, for a
 *    device request, the candidate target links.
 * 2. The facts about the subject, which need the key aliases classified from stage 1.
 *
 * decideAccountChange decides from those rows alone. Every write starts its batch with
 * one guard per read the decision depends on; any read that changed aborts the write.
 *
 * Not guarded, and why that matches the old single statement:
 * - The schema variant. The old builder also chose its SQL from a pre-read; a schema
 *   change makes the write's own statements fail.
 * - The legacy assignment when the device relies on none. The old statement then
 *   skipped the assignment checks, so a new assignment row could not deny it either.
 * - The change attempt row that callback and finalize read first. The old builder also
 *   took the target from that pre-read, and the UPDATE re-checks the row's target,
 *   Identity and enrollment columns in its own WHERE.
 */

const ALIASES = "(SELECT value FROM json_each(?))";

/** What the fact reads depend on besides the subject. */
interface ReadContext {
	/** The 15 values of AUTH_DEVICE_CLAIM_INPUT_ROW_SQL for this subject. */
	claimInput: AuthLinkStatement["values"];
	aliases: string;
	targetLinkId: string;
}

// The link's controller-review creation records, as the old controller_births join
// required them. Multi-table proof: the guard re-runs it with the read.
const controllerBirthSql = (
	connections: boolean,
) => `EXISTS (SELECT 1 FROM coordinator_auth_link_attempts b
 JOIN coordinator_auth_link_audit_log ca ON ca.coordinator_id=l.coordinator_id AND ca.link_id=l.link_id AND ca.action='link_created'
 JOIN coordinator_auth_controller_attestations origin ON origin.coordinator_id=l.coordinator_id AND origin.attestation_id=l.controller_attestation_id
 WHERE b.coordinator_id=l.coordinator_id AND b.link_id=l.link_id AND b.attempt_id=l.attempt_id
 AND (l.authority_kind='controller_attestation' AND l.device_claim_id IS NULL AND b.authority_kind=l.authority_kind AND b.controller_attestation_id=l.controller_attestation_id)
 AND (ca.attempt_id=b.attempt_id AND ca.identity_id=l.identity_id AND ca.controller_attestation_id=l.controller_attestation_id AND ca.authority_kind=l.authority_kind AND ca.auth_config_revision=l.auth_config_revision AND ca.group_id=b.group_id AND ca.device_id=b.device_id AND ca.fingerprint=b.fingerprint AND ca.created_at_ms=l.created_at_ms AND b.finalized_at_ms=l.created_at_ms)
 AND (origin.group_id=b.group_id AND origin.device_id=b.device_id AND origin.public_key=b.public_key AND origin.fingerprint=b.fingerprint AND origin.identity_id=b.identity_id AND origin.review_receipt_id=b.controller_review_receipt_id AND origin.revision=b.controller_revision)
 ${connections ? "AND (b.prior_link_id IS NULL OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id=b.coordinator_id AND h.identity_id=b.identity_id AND h.link_id=b.prior_link_id AND h.successor_link_id=b.link_id))" : ""})`;

/**
 * One small plain read per fact, each ordered by its key. A `...Conflicts` read selects
 * only rows that forbid the change, so the decision requires it to be empty and its
 * guard requires it to stay empty.
 */
const FACT_READS: {
	[Name in keyof AccountChangeFacts]: (p: AccountChangeSubject, context: ReadContext) => AuthRead;
} = {
	// Only the signed group has to be live, so only its rows carry that verdict.
	enrollments: (p, { aliases }) => ({
		sql: `SELECT json_object('group_id',e.group_id,'device_id',e.device_id,'public_key',e.public_key,
 'fingerprint',e.fingerprint,'identity_id',e.identity_id,'enabled',e.enabled,
 'group_live',CASE WHEN e.group_id=? THEN EXISTS (SELECT 1 FROM groups g WHERE g.group_id=e.group_id AND g.archived_at IS NULL) END) AS row
 FROM enrolled_devices e WHERE e.device_id=? OR e.public_key IN ${ALIASES} ORDER BY e.device_id,e.group_id`,
		values: [p.groupId, p.deviceId, aliases],
	}),
	bindings: (p) => ({
		sql: `SELECT json_object('coordinator_id',b.coordinator_id,'device_id',b.device_id,'key_id',b.key_id,'identity_id',b.identity_id) AS row
 FROM coordinator_device_ownership_bindings b WHERE b.device_id=? OR b.key_id=? ORDER BY b.device_id`,
		values: [p.deviceId, p.keyId],
	}),
	attestations: (p, { aliases }) => ({
		sql: `SELECT json_object('attestation_id',t.attestation_id,'identity_id',t.identity_id,'group_id',t.group_id,
 'device_id',t.device_id,'public_key',t.public_key,'fingerprint',t.fingerprint,'revision',t.revision,'revoked_at',t.revoked_at) AS row
 FROM coordinator_auth_controller_attestations t WHERE t.coordinator_id=?
 AND (t.device_id=? OR t.public_key IN ${ALIASES}) ORDER BY t.attestation_id`,
		values: [p.coordinatorId, p.deviceId, aliases],
	}),
	// active_link and genesis are verdicts: each joins other tables, and the guard re-runs them.
	claims: (p) => ({
		sql: `SELECT json_object('claim_id',d.claim_id,'identity_id',d.identity_id,'group_id',d.group_id,
 'device_id',d.device_id,'public_key',d.public_key,'fingerprint',d.fingerprint,'key_id',d.key_id,
 'active_link',EXISTS (SELECT 1 FROM coordinator_auth_account_links l WHERE l.coordinator_id=d.coordinator_id AND l.identity_id=d.identity_id AND l.revoked_at_ms IS NULL),
 'genesis',${p.connections ? authClaimGenesisSql("d") : "1"}) AS row
 FROM coordinator_auth_device_claims d WHERE d.coordinator_id=? AND (d.device_id=? OR d.key_id=?) ORDER BY d.claim_id`,
		values: [p.coordinatorId, p.deviceId, p.keyId],
	}),
	// The creation-record proofs are verdict columns: each compares dozens of columns
	// across several tables, and the guard re-runs them with the read.
	link: (p, { targetLinkId }) => ({
		sql: `SELECT json_object('coordinator_id',l.coordinator_id,'link_id',l.link_id,'identity_id',l.identity_id,
 'issuer',l.issuer,'subject',l.subject,'auth_config_revision',l.auth_config_revision,'revoked_at_ms',l.revoked_at_ms,
 'device_claim_id',l.device_claim_id,
 'attempts',json((SELECT json_group_array(json_object('identity_id',b.identity_id,'issuer',b.issuer,'account_subject',b.account_subject,'auth_config_revision',b.auth_config_revision,'state',b.state))
 FROM coordinator_auth_link_attempts b WHERE b.coordinator_id=l.coordinator_id AND b.link_id=l.link_id AND b.attempt_id=l.attempt_id)),
 'controller_birth',${controllerBirthSql(p.connections)},
 'device_birth',${authDeviceClaimProvenanceSql({ link: "l", connections: p.connections })}) AS row
 FROM coordinator_auth_account_links l WHERE l.coordinator_id=? AND l.link_id=? ORDER BY l.link_id`,
		values: [p.coordinatorId, targetLinkId],
	}),
	// The subject Identity is the link's Identity whenever the decision allows.
	revokedHistory: (p) => ({
		sql: `SELECT json_object('link_id',h.link_id) AS row FROM coordinator_auth_account_connection_history h
 WHERE h.coordinator_id=? AND h.identity_id=? AND h.revoked_at_ms IS NOT NULL ORDER BY h.link_id`,
		values: [p.coordinatorId, p.identityId],
	}),
	// Legacy Team manifests are JSON whose values may have any JSON type; SQL keeps the
	// json_extract comparisons exact. The peer branch and the current-assignment proof
	// also join enrollments. The guard re-runs all three verdicts.
	legacy: (_p, { claimInput }) => ({
		sql: `SELECT json_object('assignment_current',(p.assignment_snapshot IS NULL OR ${AUTH_CURRENT_LEGACY_ASSIGNMENT_SQL}),
 'unwaivable_clear',(${AUTH_DEVICE_CLAIM_LEGACY_UNWAIVABLE_SQL}),
 'compatible_clear',(${AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL})) AS row FROM ${AUTH_DEVICE_CLAIM_INPUT_ROW_SQL} p`,
		values: claimInput,
	}),
	revocationConflicts: (p) => ({
		sql: `SELECT json_object('subject_kind',r.subject_kind) AS row FROM coordinator_device_revocations r
 WHERE (r.subject_kind='device_id' AND r.subject_value=?) OR (r.subject_kind='ed25519_key' AND r.subject_value=?)
 ORDER BY r.subject_kind`,
		values: [p.deviceId, p.keyId],
	}),
	inviteConflicts: (p, { aliases }) => ({
		sql: `SELECT json_object('invite_id',i.invite_id) AS row FROM coordinator_invites i
 WHERE ${AUTH_DEVICE_CLAIM_INVITE_CONSUMED_SQL}
 AND (i.bound_device_id=? OR i.bound_public_key IN ${ALIASES} OR i.bound_fingerprint=?)
 AND ((i.assigned_identity_id IS NOT NULL AND i.assigned_identity_id<>?)
 OR (i.target_identity_id IS NOT NULL AND i.target_identity_id<>?))
 ORDER BY i.invite_id`,
		values: [p.deviceId, aliases, p.fingerprint, p.identityId, p.identityId],
	}),
	otherIdentityLinkAttemptConflicts: (p, { aliases }) => ({
		sql: `SELECT json_object('link_id',l.link_id,'attempt_id',a.attempt_id) AS row
 FROM coordinator_auth_account_links l JOIN coordinator_auth_link_attempts a
 ON a.coordinator_id=l.coordinator_id AND a.link_id=l.link_id
 WHERE l.coordinator_id=? AND l.identity_id<>? AND (a.device_id=? OR a.public_key IN ${ALIASES})
 ORDER BY l.link_id,a.attempt_id`,
		values: [p.coordinatorId, p.identityId, p.deviceId, aliases],
	}),
	otherIdentityLinkAuditConflicts: (p) => ({
		sql: `SELECT json_object('link_id',l.link_id,'action',a.action) AS row
 FROM coordinator_auth_account_links l JOIN coordinator_auth_link_audit_log a
 ON a.coordinator_id=l.coordinator_id AND a.link_id=l.link_id
 WHERE l.coordinator_id=? AND a.device_id=? AND l.identity_id<>? ORDER BY l.link_id,a.action`,
		values: [p.coordinatorId, p.deviceId, p.identityId],
	}),
};

function factReads(
	p: AccountChangeSubject,
	context: ReadContext,
): Record<keyof AccountChangeFacts, AuthRead> {
	const names = Object.keys(FACT_READS) as (keyof AccountChangeFacts)[];
	return Object.fromEntries(names.map((name) => [name, FACT_READS[name](p, context)])) as Record<
		keyof AccountChangeFacts,
		AuthRead
	>;
}

/**
 * Candidate target links, one row per link and binding verdict, in SQL link order. The
 * filters are the old derivation's; pickAccountChangeTarget picks the winner.
 */
function accountChangeTargetRead(
	c: CoordinatorAuthLinkConfig,
	signer: CoordinatorAuthLinkSigner,
	keyId: string,
): AuthRead {
	return {
		sql: `SELECT json_object('link_id',link_id,'identity_id',identity_id,'bound',bound) AS row FROM (
 SELECT DISTINCT l.link_id,l.identity_id,(ob.device_id = ? AND ob.key_id = ?) AS bound FROM coordinator_auth_account_links l
 LEFT JOIN coordinator_auth_device_claims d ON d.coordinator_id = l.coordinator_id AND d.identity_id = l.identity_id
 LEFT JOIN coordinator_auth_controller_attestations a ON a.coordinator_id = l.coordinator_id AND a.identity_id = l.identity_id
 LEFT JOIN coordinator_device_ownership_bindings ob ON ob.coordinator_id = l.coordinator_id AND ob.identity_id = l.identity_id
 WHERE l.coordinator_id = ? AND ((d.device_id = ? AND d.key_id = ?) OR
 (a.group_id = ? AND a.device_id = ? AND a.public_key = ? AND a.fingerprint = ? AND a.revoked_at IS NULL)
 OR (ob.device_id = ? AND ob.key_id = ?))) ORDER BY link_id,bound`,
		values: [
			signer.deviceId,
			keyId,
			c.coordinatorId,
			signer.deviceId,
			keyId,
			signer.groupId,
			signer.deviceId,
			signer.publicKey,
			signer.fingerprint,
			signer.deviceId,
			keyId,
		],
	};
}

const SESSION_READ: AuthRead = {
	sql: "SELECT json_object('present',count(*)) AS row FROM pragma_table_info('coordinator_auth_browser_transactions') WHERE name = 'start_order'",
	values: [],
};

type BaseRows = {
	keys: string[];
	assignment: unknown[];
	session: { present: number }[];
	candidates: AccountChangeTargetCandidate[];
};

/** Stage 1: what every account-change authority reads before it knows the key aliases. */
export interface AccountChangeBase {
	/** The derived target, when the request derives one. */
	target: AccountChangeTarget | null;
	keys: string[];
	assignment: string | null;
	connections: boolean;
	guards: Pick<Record<keyof BaseRows, AuthLinkStatement>, "keys" | "assignment"> & {
		candidates?: AuthLinkStatement;
	};
}

/**
 * Reads stage 1. With `deriveTarget`, it also reads the candidate links
 * for this signer and key; a change to them aborts the write even when the same link
 * would still win.
 */
export async function readAccountChangeBase(
	backend: Pick<AuthLinkBackend, "first" | "readBatch">,
	c: CoordinatorAuthLinkConfig,
	signer: CoordinatorAuthLinkSigner,
	options: { deriveTarget?: { keyId: string } } = {},
): Promise<AccountChangeBase> {
	const reads: Partial<Record<keyof BaseRows, AuthRead>> = {
		keys: AUTH_DEVICE_CLAIM_KEYS_READ,
		assignment: {
			sql: AUTH_LEGACY_ASSIGNMENT_READ_SQL,
			values: deviceClaimAssignmentInputs({ config: c, signer }),
		},
		session: SESSION_READ,
	};
	if (options.deriveTarget)
		reads.candidates = accountChangeTargetRead(c, signer, options.deriveTarget.keyId);
	const read = await readSnapshot<BaseRows>(backend, reads as Record<keyof BaseRows, AuthRead>);
	const [assignment] = read.rows.assignment;
	return {
		target: options.deriveTarget ? pickAccountChangeTarget(read.rows.candidates) : null,
		keys: read.rows.keys,
		assignment: assignment ? JSON.stringify(assignment) : null,
		connections: read.rows.session[0]?.present === 1,
		guards: {
			keys: read.guards.keys,
			assignment: read.guards.assignment,
			...(options.deriveTarget ? { candidates: read.guards.candidates } : {}),
		},
	};
}

/** The granted link, or null, with the guards for the batch that writes it. */
export interface AccountChangeAuthority {
	/** The link this device may change, or null when it may not. */
	grant: AccountChangeGrant | null;
	/** These go first in the batch that writes. Each aborts it when its read changed. */
	guards: AuthLinkStatement[];
	/** The same guards by read name. */
	parts: Record<string, AuthLinkStatement>;
}

function claimInputValues(
	claim: DeviceClaimSubject,
	keyFacts: DeviceClaimKeyFacts,
	now: number,
): AuthLinkStatement["values"] {
	return [
		claim.config.coordinatorId,
		claim.identityId,
		claim.signer.groupId,
		claim.signer.deviceId,
		claim.signer.publicKey,
		claim.signer.fingerprint,
		claim.keyId,
		now,
		new Date(now).toISOString(),
		claim.attemptId,
		claim.config.issuer,
		claim.config.revision,
		JSON.stringify(keyFacts.keys),
		JSON.stringify(keyFacts.aliases),
		keyFacts.assignmentSnapshot,
	];
}

function subjectFor(claim: DeviceClaimSubject, base: AccountChangeBase): AccountChangeSubject {
	return {
		coordinatorId: claim.config.coordinatorId,
		identityId: claim.identityId,
		groupId: claim.signer.groupId,
		deviceId: claim.signer.deviceId,
		publicKey: claim.signer.publicKey,
		fingerprint: claim.signer.fingerprint,
		keyId: claim.keyId,
		issuer: claim.config.issuer,
		enabled: claim.config.enabled,
		connections: base.connections,
	};
}

/** Stage 1 guards the decision depends on, by part name. */
function baseParts(base: AccountChangeBase, keyFacts: DeviceClaimKeyFacts) {
	return {
		...(base.guards.candidates ? { target: base.guards.candidates } : {}),
		keys: base.guards.keys,
		// Without an assignment snapshot the old statement skipped the assignment checks.
		...(keyFacts.assignmentSnapshot === null ? {} : { assignment: base.guards.assignment }),
	};
}

/**
 * Stage 2. Server proof only: reads the facts behind the account-change authority for
 * this signer and target, and decides in TypeScript. The grant is void
 * unless `guards` run first in the batch that writes. Null when the old builder built no
 * statement: the target Identity or the signer's key is not acceptable.
 */
export async function prepareAccountChangeAuthority(
	backend: Pick<AuthLinkBackend, "first" | "readBatch">,
	base: AccountChangeBase,
	c: CoordinatorAuthLinkConfig,
	signer: CoordinatorAuthLinkSigner,
	target: AccountChangeTarget,
	now: number,
): Promise<AccountChangeAuthority | null> {
	const claim = await captureDeviceClaimSubject({ identityId: target.identity_id, signer }, c);
	if (!claim) return null;
	return decideForClaim(backend, base, claim, target, now);
}

/** Stage 2 for a request already validated, with its key ID derived. */
async function decideForClaim(
	backend: Pick<AuthLinkBackend, "first" | "readBatch">,
	base: AccountChangeBase,
	claim: DeviceClaimSubject,
	target: AccountChangeTarget,
	now: number,
): Promise<AccountChangeAuthority> {
	const keyFacts = deriveDeviceClaimKeyFacts(claim, base);
	const subject = subjectFor(claim, base);
	const facts = await readSnapshot<AccountChangeFacts>(
		backend,
		factReads(subject, {
			claimInput: claimInputValues(claim, keyFacts, now),
			aliases: JSON.stringify(keyFacts.aliases),
			targetLinkId: target.target_link_id,
		}),
	);
	const parts: Record<string, AuthLinkStatement> = {
		...baseParts(base, keyFacts),
		...facts.guards,
	};
	return {
		grant: decideAccountChange(subject, facts.rows),
		guards: Object.values(parts),
		parts,
	};
}

/**
 * Both stages for a target the caller already holds, such as the one a stored change
 * attempt names. Checks the signer and Identity before reading anything, as the old
 * builder did.
 */
export async function prepareAccountChangeAuthorityFor(
	backend: Pick<AuthLinkBackend, "first" | "readBatch">,
	c: CoordinatorAuthLinkConfig,
	signer: CoordinatorAuthLinkSigner,
	target: AccountChangeTarget,
	now: number,
): Promise<AccountChangeAuthority | null> {
	const claim = await captureDeviceClaimSubject({ identityId: target.identity_id, signer }, c);
	if (!claim) return null;
	const base = await readAccountChangeBase(backend, c, signer);
	return decideForClaim(backend, base, claim, target, now);
}
