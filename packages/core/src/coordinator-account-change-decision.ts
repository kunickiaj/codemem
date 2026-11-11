import { type SqlValue, sqlEq, sqlIn, sqlNe } from "./coordinator-sql-compare.js";

/** Trusted server values: the signed enrollment, the configuration, and derived key facts. */
export interface AccountChangeSubject {
	coordinatorId: string;
	/** The Identity of the target link, never a caller-selected one. */
	identityId: string;
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	keyId: string;
	issuer: string;
	enabled: boolean;
	/** Whether the claim proofs use the connection-session schema. */
	connections: boolean;
}

export interface AccountChangeEnrollment {
	group_id: string;
	device_id: string;
	public_key: SqlValue;
	fingerprint: SqlValue;
	identity_id: SqlValue;
	enabled: SqlValue;
	/** For an enrollment in the signed group: 1 when that group exists and is not archived. */
	group_live: SqlValue;
}

export interface AccountChangeBinding {
	coordinator_id: SqlValue;
	device_id: string;
	key_id: SqlValue;
	identity_id: SqlValue;
}

export interface AccountChangeAttestation {
	attestation_id: string;
	identity_id: SqlValue;
	group_id: SqlValue;
	device_id: SqlValue;
	public_key: SqlValue;
	fingerprint: SqlValue;
	revision: SqlValue;
	revoked_at: SqlValue;
}

export interface AccountChangeClaim {
	claim_id: string;
	identity_id: SqlValue;
	group_id: SqlValue;
	device_id: SqlValue;
	public_key: SqlValue;
	fingerprint: SqlValue;
	key_id: SqlValue;
	/** SQL verdict: the claim's Identity has an active account link. */
	active_link: SqlValue;
	/** SQL verdict: the claim's immutable genesis verifies (always 1 without connections). */
	genesis: SqlValue;
}

/** The creation attempt a link names, in the columns the check compares. */
export interface AccountChangeLinkAttempt {
	identity_id: SqlValue;
	issuer: SqlValue;
	account_subject: SqlValue;
	auth_config_revision: SqlValue;
	state: SqlValue;
}

export interface AccountChangeLink {
	coordinator_id: string;
	link_id: string;
	identity_id: SqlValue;
	issuer: SqlValue;
	subject: SqlValue;
	auth_config_revision: SqlValue;
	revoked_at_ms: SqlValue;
	device_claim_id: SqlValue;
	attempts: AccountChangeLinkAttempt[];
	/** SQL verdict: a controller-reviewed link has its complete creation records. */
	controller_birth: SqlValue;
	/** SQL verdict: a device-claim link's immutable creation records verify. */
	device_birth: SqlValue;
}

/** SQL verdicts over legacy Team manifests, evaluated for this subject. */
export interface AccountChangeLegacy {
	/** The legacy assignment the device relies on is still current, or it relies on none. */
	assignment_current: SqlValue;
	/** No legacy decision that an ownership binding cannot waive contradicts the device. */
	unwaivable_clear: SqlValue;
	/** No legacy decision contradicts the device at all. */
	compatible_clear: SqlValue;
}

/** Everything the decision looks at. A list named `...Conflicts` must be empty. */
export type AccountChangeFacts = {
	/** Enrollments of this device or of any text form of its key. */
	enrollments: AccountChangeEnrollment[];
	/** Ownership bindings of this device or key. */
	bindings: AccountChangeBinding[];
	/** Controller reviews of this device or of any text form of its key. */
	attestations: AccountChangeAttestation[];
	/** Device claims of this device or key. */
	claims: AccountChangeClaim[];
	/** The target link, when it exists. */
	link: AccountChangeLink[];
	/** Ended links of the subject Identity that record a revocation. */
	revokedHistory: unknown[];
	/** One row of legacy verdicts. */
	legacy: AccountChangeLegacy[];
	revocationConflicts: unknown[];
	inviteConflicts: unknown[];
	otherIdentityLinkAttemptConflicts: unknown[];
	otherIdentityLinkAuditConflicts: unknown[];
};

const CONFLICTS = [
	"revocationConflicts",
	"inviteConflicts",
	"otherIdentityLinkAttemptConflicts",
	"otherIdentityLinkAuditConflicts",
] as const satisfies readonly (keyof AccountChangeFacts)[];

/** The link that the device may refresh or disconnect, with the values the write records. */
export interface AccountChangeGrant {
	coordinatorId: string;
	linkId: string;
	identityId: SqlValue;
	issuer: SqlValue;
	subject: SqlValue;
	enrollmentIdentityId: SqlValue;
}

const isSigned = (p: AccountChangeSubject, row: { group_id: SqlValue; device_id: SqlValue }) =>
	sqlEq(row.group_id, p.groupId) && sqlEq(row.device_id, p.deviceId);

/** The exact signed enrollment, when it is live under the given Identity or none. */
function liveSignedEnrollment(
	p: AccountChangeSubject,
	facts: AccountChangeFacts,
	identityId: SqlValue,
): AccountChangeEnrollment | undefined {
	return facts.enrollments.find(
		(e) =>
			isSigned(p, e) &&
			sqlEq(e.public_key, p.publicKey) &&
			sqlEq(e.fingerprint, p.fingerprint) &&
			sqlEq(e.enabled, 1) &&
			sqlEq(e.group_live, 1) &&
			(e.identity_id === null || sqlEq(e.identity_id, identityId)),
	);
}

/** The exact active first-revision review of the signed enrollment, as the link reader sees it. */
function currentControllers(p: AccountChangeSubject, facts: AccountChangeFacts) {
	if (!p.enabled) return [];
	return facts.attestations.filter(
		(a) =>
			isSigned(p, a) &&
			sqlEq(a.public_key, p.publicKey) &&
			sqlEq(a.fingerprint, p.fingerprint) &&
			a.revoked_at === null &&
			sqlEq(a.revision, 1) &&
			liveSignedEnrollment(p, facts, a.identity_id) !== undefined,
	);
}

/** This exact device key's own ownership binding for the subject Identity. */
const hasRequesterBinding = (p: AccountChangeSubject, facts: AccountChangeFacts) =>
	facts.bindings.some(
		(b) =>
			sqlEq(b.coordinator_id, p.coordinatorId) &&
			sqlEq(b.device_id, p.deviceId) &&
			sqlEq(b.key_id, p.keyId) &&
			sqlEq(b.identity_id, p.identityId),
	);

/** Nothing stored about this device or key names another Identity. */
function noOtherIdentity(p: AccountChangeSubject, facts: AccountChangeFacts): boolean {
	return (
		!facts.enrollments.some((e) => sqlNe(e.identity_id, p.identityId)) &&
		!facts.bindings.some((b) => sqlNe(b.identity_id, p.identityId)) &&
		!facts.attestations.some((a) => sqlNe(a.identity_id, p.identityId))
	);
}

/** Another Identity's claim of this device or key is superseded only by this key's binding. */
function claimsAllow(p: AccountChangeSubject, facts: AccountChangeFacts, binding: boolean) {
	const others = facts.claims.filter((d) => sqlNe(d.identity_id, p.identityId));
	if (others.length === 0) return true;
	return binding && !others.some((d) => sqlEq(d.active_link, 1));
}

/** Every review of the device or key is active and of this Identity, or a current one is. */
function attestationsAllow(p: AccountChangeSubject, facts: AccountChangeFacts): boolean {
	const contradicted = facts.attestations.some(
		(a) => a.revoked_at !== null || sqlNe(a.identity_id, p.identityId),
	);
	return (
		!contradicted || currentControllers(p, facts).some((c) => sqlEq(c.identity_id, p.identityId))
	);
}

/** The requester checks: this device may speak for the subject Identity at all. */
function requesterAllowed(p: AccountChangeSubject, facts: AccountChangeFacts): boolean {
	const [legacy, ...extra] = facts.legacy;
	if (!legacy || extra.length > 0) return false;
	if (CONFLICTS.some((name) => facts[name].length > 0)) return false;
	const binding = hasRequesterBinding(p, facts);
	return (
		sqlEq(legacy.assignment_current, 1) &&
		noOtherIdentity(p, facts) &&
		claimsAllow(p, facts, binding) &&
		attestationsAllow(p, facts) &&
		sqlEq(legacy.unwaivable_clear, 1) &&
		(sqlEq(legacy.compatible_clear, 1) || binding)
	);
}

/** The target link's creation attempt agrees with it and finished. */
const birthAttemptMatches = (link: AccountChangeLink) =>
	link.attempts.some(
		(b) =>
			sqlEq(b.identity_id, link.identity_id) &&
			sqlEq(b.issuer, link.issuer) &&
			sqlEq(b.account_subject, link.subject) &&
			sqlEq(b.auth_config_revision, link.auth_config_revision) &&
			sqlIn(b.state, ["finalized", "session_redeemed"]),
	);

/** This device's own claim under the link's Identity: the link's claim, or with connections any. */
function hasOwnClaim(p: AccountChangeSubject, facts: AccountChangeFacts, link: AccountChangeLink) {
	return facts.claims.some(
		(d) =>
			sqlEq(d.identity_id, p.identityId) &&
			sqlEq(d.genesis, 1) &&
			(p.connections
				? sqlEq(d.identity_id, link.identity_id)
				: sqlEq(d.claim_id, link.device_claim_id)) &&
			isSigned(p, d) &&
			sqlEq(d.public_key, p.publicKey) &&
			sqlEq(d.fingerprint, p.fingerprint) &&
			sqlEq(d.key_id, p.keyId),
	);
}

/** The link is active, and its own records and this device's proof support managing it. */
function linkAllowed(p: AccountChangeSubject, facts: AccountChangeFacts, link: AccountChangeLink) {
	const live = link.revoked_at_ms === null && facts.revokedHistory.length === 0;
	const born = sqlEq(link.controller_birth, 1) || sqlEq(link.device_birth, 1);
	const proof =
		currentControllers(p, facts).some((c) => sqlEq(c.identity_id, link.identity_id)) ||
		hasOwnClaim(p, facts, link) ||
		hasRequesterBinding(p, facts);
	return (
		sqlEq(link.identity_id, p.identityId) &&
		sqlEq(link.issuer, p.issuer) &&
		birthAttemptMatches(link) &&
		live &&
		born &&
		proof
	);
}

/**
 * Pure decision over the facts read. Returns the target link that this device may
 * refresh or disconnect, or null. The primary and unique keys of the tables read allow
 * at most one row per joined fact, so the original statement selected at most one row.
 */
export function decideAccountChange(
	p: AccountChangeSubject,
	facts: AccountChangeFacts,
): AccountChangeGrant | null {
	const [link, ...others] = facts.link;
	if (!link || others.length > 0) return null;
	if (!requesterAllowed(p, facts) || !linkAllowed(p, facts, link)) return null;
	const enrollment = liveSignedEnrollment(p, facts, link.identity_id);
	if (!enrollment) return null;
	return {
		coordinatorId: link.coordinator_id,
		linkId: link.link_id,
		identityId: link.identity_id,
		issuer: link.issuer,
		subject: link.subject,
		enrollmentIdentityId: enrollment.identity_id,
	};
}

/** One candidate link that names this device by claim, review or binding. */
export interface AccountChangeTargetCandidate {
	link_id: string;
	identity_id: string;
	/** SQL `ob.device_id = ? AND ob.key_id = ?` for one joined binding row: 1, 0 or NULL. */
	bound: SqlValue;
}

export interface AccountChangeTarget {
	identity_id: string;
	target_link_id: string;
}

/** SQL `ORDER BY bound DESC`: 1, then 0, then NULL. */
const boundRank = (bound: SqlValue) => {
	if (bound === null) return 0;
	return Number(bound) + 1;
};

/**
 * The target link, as `ORDER BY bound DESC, link_id` picked its first row: this device's
 * binding wins a tie, and the lowest link ID breaks the rest. The candidates must arrive
 * in SQL `link_id` order, so SQLite's collation, not JavaScript's, decides that tie.
 */
export function pickAccountChangeTarget(
	candidatesByLinkId: readonly AccountChangeTargetCandidate[],
): AccountChangeTarget | null {
	let best: AccountChangeTargetCandidate | undefined;
	for (const candidate of candidatesByLinkId)
		if (!best || boundRank(candidate.bound) > boundRank(best.bound)) best = candidate;
	return best ? { identity_id: best.identity_id, target_link_id: best.link_id } : null;
}
