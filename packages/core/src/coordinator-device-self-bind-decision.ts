import { type SqlValue, sqlEq, sqlIn, sqlNe } from "./coordinator-sql-compare.js";

/** Trusted server values: the signed enrollment, the configuration, and derived key facts. */
export interface SelfBindSubject {
	coordinatorId: string;
	identityId: string;
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	keyId: string;
	issuer: string;
	nowMs: number;
	attemptId: string | null;
	/** Every stored text form of this device's key. */
	aliases: string[];
}

export interface SelfBindEnrollment {
	group_id: string;
	device_id: string;
	public_key: SqlValue;
	fingerprint: SqlValue;
	identity_id: SqlValue;
	enabled: SqlValue;
	created_at: SqlValue;
	/** For an enrollment in the signed group: 1 when that group exists and is not archived. */
	group_live: SqlValue;
}

export interface SelfBindAttestation {
	coordinator_id: string;
	attestation_id: string;
	identity_id: SqlValue;
	group_id: SqlValue;
	device_id: SqlValue;
	public_key: SqlValue;
	fingerprint: SqlValue;
	review_receipt_id: SqlValue;
	evidence_digest: SqlValue;
	enrollment_identity_id: SqlValue;
	revision: SqlValue;
	created_at: SqlValue;
	revoked_at: SqlValue;
}

export interface SelfBindLink {
	/** The pinned link columns, in pin order. */
	link: SqlValue[];
	issuer: SqlValue;
	/** SQL verdict: the link's immutable creation records verify. */
	proven: SqlValue;
	/** SQL verdict: a controller-reviewed link has its complete browser creation receipt. */
	controller_receipt: SqlValue;
	/** SQL verdict: the link came from a device without a browser. */
	headless: SqlValue;
	/** The pinned columns of the link's controller review and device claim, if any. */
	linkController: SqlValue[][];
	linkClaim: SqlValue[][];
}

/** Everything the decision looks at. A list named `...Conflicts` must be empty. */
export type SelfBindFacts = {
	/** Enrollments of this device or of any text form of its key. */
	enrollments: SelfBindEnrollment[];
	/** Controller reviews of this device or of any text form of its key. */
	attestations: SelfBindAttestation[];
	/** Active account links of the current Identity. */
	links: SelfBindLink[];
	/** Consumed invites that assigned this device, key or fingerprint to another Identity. */
	inviteConflicts: unknown[];
	bindingConflicts: unknown[];
	claimConflicts: unknown[];
	revocationConflicts: unknown[];
	otherIdentityLinkAttemptConflicts: unknown[];
	otherIdentityLinkAuditConflicts: unknown[];
	ownerAttemptConflicts: unknown[];
	linkAttemptConflicts: unknown[];
	rebindAttemptConflicts: unknown[];
	legacyDecisionConflicts: unknown[];
};

const CONFLICTS = [
	"inviteConflicts",
	"bindingConflicts",
	"claimConflicts",
	"revocationConflicts",
	"otherIdentityLinkAttemptConflicts",
	"otherIdentityLinkAuditConflicts",
	"ownerAttemptConflicts",
	"linkAttemptConflicts",
	"rebindAttemptConflicts",
	"legacyDecisionConflicts",
] as const satisfies readonly (keyof SelfBindFacts)[];

const ownEnrollments = (p: SelfBindSubject, facts: SelfBindFacts) =>
	facts.enrollments.filter((e) => e.device_id === p.deviceId);

/** The signed enrollment is live, and no enrollment of the device or key disagrees. */
function enrollmentsAllow(p: SelfBindSubject, facts: SelfBindFacts): boolean {
	const own = ownEnrollments(p, facts);
	const signedEnrollmentIsLive = own.some(
		(e) =>
			e.group_id === p.groupId &&
			sqlEq(e.public_key, p.publicKey) &&
			sqlEq(e.fingerprint, p.fingerprint) &&
			sqlEq(e.enabled, 1) &&
			sqlEq(e.group_live, 1) &&
			(e.identity_id === null || e.identity_id === p.identityId),
	);
	if (!signedEnrollmentIsLive || own.length > 50) return false;
	const ownDisagree = own.some(
		(e) => sqlNe(e.public_key, p.publicKey) || sqlNe(e.fingerprint, p.fingerprint),
	);
	// The read also returns other devices that hold a text form of this key.
	const anotherIdentity = facts.enrollments.some((e) => sqlNe(e.identity_id, p.identityId));
	const keyOnAnotherDevice = facts.enrollments.some(
		(e) => sqlIn(e.public_key, p.aliases) && sqlNe(e.device_id, p.deviceId),
	);
	return !ownDisagree && !anotherIdentity && !keyOnAnotherDevice;
}

/** The single active review of this device or key, when it is of exactly this enrollment. */
function ownController(p: SelfBindSubject, facts: SelfBindFacts): SelfBindAttestation | null {
	const [only, ...others] = facts.attestations;
	if (!only || others.length > 0) return null;
	if (only.revoked_at !== null || sqlNe(only.identity_id, p.identityId)) return null;
	const isThisEnrollment =
		sqlEq(only.device_id, p.deviceId) &&
		sqlEq(only.public_key, p.publicKey) &&
		sqlEq(only.fingerprint, p.fingerprint) &&
		sqlEq(only.identity_id, p.identityId) &&
		sqlEq(only.group_id, p.groupId);
	return isThisEnrollment ? only : null;
}

/** The single active account link, when its creation records verify for this issuer. */
function provenLink(p: SelfBindSubject, facts: SelfBindFacts): SelfBindLink | null {
	const [only, ...others] = facts.links;
	if (!only || others.length > 0) return null;
	const verified =
		sqlEq(only.proven, 1) && sqlEq(only.controller_receipt, 1) && !sqlEq(only.headless, 1);
	return verified && sqlEq(only.issuer, p.issuer) ? only : null;
}

function pin(
	p: SelfBindSubject,
	facts: SelfBindFacts,
	t: SelfBindAttestation,
	link: SelfBindLink,
): string {
	return JSON.stringify({
		groupId: p.groupId,
		keyId: p.keyId,
		controller: [
			t.coordinator_id,
			t.attestation_id,
			t.identity_id,
			t.group_id,
			t.device_id,
			t.public_key,
			t.fingerprint,
			t.review_receipt_id,
			t.evidence_digest,
			t.enrollment_identity_id,
			t.revision,
			t.created_at,
		],
		link: link.link,
		linkController: link.linkController,
		linkClaim: link.linkClaim,
		enrollments: ownEnrollments(p, facts).map((e) => [
			e.group_id,
			e.public_key,
			e.fingerprint,
			e.identity_id,
			e.enabled,
			e.created_at,
		]),
	});
}

/**
 * Pure decision over the facts read. Returns the pin that the start stores as
 * `start_authority_json` and every later step requires again, or null when this device
 * may not connect this way. The pin is byte-compatible with the SQL `json_object` that
 * produced it before, so attempts started by an earlier release still match.
 */
export function decideDeviceSelfBind(p: SelfBindSubject, facts: SelfBindFacts): string | null {
	if (CONFLICTS.some((name) => facts[name].length > 0)) return null;
	if (!enrollmentsAllow(p, facts)) return null;
	const controller = ownController(p, facts);
	const link = provenLink(p, facts);
	if (!controller || !link) return null;
	return pin(p, facts, controller, link);
}
