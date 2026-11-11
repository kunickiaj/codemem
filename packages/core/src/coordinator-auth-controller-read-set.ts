import { CONNECTION_NOT_REVOKED_SQL } from "./coordinator-account-connection-storage.js";
import type { CoordinatorAuthControllerReviewInput } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";
import { type AuthRead, readSnapshot } from "./coordinator-auth-read-set.js";
import { controllerHistoryReads } from "./coordinator-owner-negative-reads.js";
import { sqlEq } from "./coordinator-sql-compare.js";

/**
 * Read-set form of the controller review's snapshot, history and owner checks. The old
 * statements carried them as WITH stages that production D1 refuses. Here each is a plain
 * read, the decision compares it with the reviewed snapshot in TypeScript, and the guards
 * pin what was read to the statement that writes or answers.
 *
 * The checks on the enrollment row itself stay in the statements, with bound values.
 */

type Values = AuthLinkStatement["values"];
type Review = CoordinatorAuthControllerReviewInput;

/** Every ordinary pin the old statements carried besides the snapshot stages. */
const AUTHORITY_GUARD = `
	AND e.group_id = ? AND e.device_id = ? AND e.public_key = ?
	AND e.fingerprint = ? AND e.identity_id IS ?
	AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations WHERE
		(subject_kind = 'device_id' AND subject_value = ?) OR
		(subject_kind = 'ed25519_key' AND subject_value = ?))`;
const SUBJECT = `FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
	WHERE e.group_id = ? AND e.device_id = ? AND e.enabled = 1 AND g.archived_at IS NULL
		AND e.public_key = ? AND e.fingerprint = ? AND (e.identity_id IS NULL OR e.identity_id = ?)`;
const CURRENT = `SELECT a.* FROM coordinator_auth_controller_attestations a
	JOIN enrolled_devices e ON e.group_id = a.group_id AND e.device_id = a.device_id
	JOIN groups g ON g.group_id = a.group_id
	WHERE a.coordinator_id = ? AND a.attestation_id = ? AND a.revoked_at IS NULL
		AND e.enabled = 1 AND g.archived_at IS NULL AND e.public_key = a.public_key
		AND e.fingerprint = a.fingerprint
		AND (e.identity_id IS NULL OR e.identity_id = a.identity_id)`;

/** The enrollment-row checks the snapshot made: its label and the history's subject. */
function snapshotRowChecks(review: Review): { sql: string; values: Values } {
	const snapshot = review.verifiedSnapshot;
	if (!snapshot) return { sql: "", values: [] };
	const history = snapshot.legacyHistory;
	return {
		sql: ` AND e.identity_id IS ?${history ? " AND e.device_id = ? AND e.public_key = ? AND e.fingerprint = ?" : ""}`,
		values: [
			snapshot.enrollmentIdentityId,
			...(history ? [history.deviceId, history.publicKey, history.fingerprint] : []),
		],
	};
}

function subjectValues(review: Review): Values {
	return [review.groupId, review.deviceId, review.publicKey, review.fingerprint, review.identityId];
}

/** The controller insert, with no WITH stage. */
export function controllerInsertStatement(
	review: Review,
	createdAt: string,
	authority: Values,
): AuthLinkStatement {
	const rows = snapshotRowChecks(review);
	return {
		sql: `INSERT INTO coordinator_auth_controller_attestations (
		attestation_id, coordinator_id, identity_id, group_id, device_id, public_key,
		fingerprint, review_receipt_id, evidence_digest, enrollment_identity_id, revision, created_at, revoked_at
	)
	SELECT ?, ?, ?, e.group_id, e.device_id, e.public_key, e.fingerprint, ?, ?, e.identity_id, 1, ?, NULL
	${SUBJECT}${rows.sql} ${AUTHORITY_GUARD}`,
		values: [
			review.attestationId,
			review.coordinatorId,
			review.identityId,
			review.reviewReceiptId,
			review.evidenceDigest,
			createdAt,
			...subjectValues(review),
			...rows.values,
			...authority,
		],
	};
}

/** Whether the reviewed enrollment may still be attested, with no WITH stage. */
export function controllerEligibleStatement(review: Review, authority: Values): AuthLinkStatement {
	const rows = snapshotRowChecks(review);
	return {
		sql: `SELECT 1 AS eligible ${SUBJECT}${rows.sql} ${AUTHORITY_GUARD}`,
		values: [...subjectValues(review), ...rows.values, ...authority],
	};
}

/** The current attestation checked against live authority, with no WITH stage. */
export function controllerActiveStatement(review: Review, authority: Values): AuthLinkStatement {
	const rows = snapshotRowChecks(review);
	return {
		sql: `${CURRENT} ${AUTHORITY_GUARD}${rows.sql}`,
		values: [review.coordinatorId, review.attestationId, ...authority, ...rows.values],
	};
}

const INVITES_READ = `SELECT json_array(i.invite_id, i.invite_kind, i.recipient_actor_id,
	i.assigned_identity_id, i.target_identity_id, i.reviewed_preview_digest) AS row
	FROM coordinator_invites i
	WHERE i.group_id = ? AND i.bound_device_id = ? AND i.bound_public_key = ?
		AND i.bound_fingerprint = ? AND i.revoked_at IS NULL
		AND i.consumed_at IS NOT NULL AND i.consumed_at != ''
		AND i.invite_kind IN ('team_member', 'add_device')
	ORDER BY row`;

// The account owner target's links, each with 0/1 verdicts: it still proves its creation,
// and neither it nor its Identity's connection history is revoked.
const OWNER_LINKS_READ = `SELECT json_object('link_id',l.link_id,
 'proven',${authAccountLinkProvenanceSql("l", { connections: true })},
 'live',(${CONNECTION_NOT_REVOKED_SQL})) AS row
 FROM coordinator_auth_account_links l
 WHERE l.coordinator_id=? AND l.identity_id=? AND l.issuer=? AND l.link_id=?
 AND l.auth_config_revision=? AND l.created_at_ms=? ORDER BY l.link_id`;
// Claims of this enrollment that disagree with the owner target.
const OWNER_CLAIM_CONFLICTS_READ = `SELECT json_object('claim_id',d.claim_id) AS row
 FROM coordinator_auth_device_claims d
 WHERE d.coordinator_id=? AND (d.device_id=? OR d.key_id=?)
 AND (d.identity_id<>? OR d.group_id<>? OR d.device_id<>? OR d.public_key<>? OR d.fingerprint<>?)
 ORDER BY d.claim_id`;
// Controller reviews that disagree: of this enrollment, or of its device or key family
// for another Identity.
const OWNER_CONTROLLER_CONFLICTS_READ = `SELECT json_object('attestation_id',other.attestation_id) AS row
 FROM coordinator_auth_controller_attestations other
 WHERE other.coordinator_id=? AND ((other.group_id=? AND other.device_id=? AND other.fingerprint=?
 AND (other.identity_id<>? OR other.public_key<>? OR other.revoked_at IS NOT NULL))
 OR (other.identity_id<>? AND (other.device_id=? OR other.public_key=?
 OR other.public_key IN (SELECT value FROM json_each(?)))))
 ORDER BY other.attestation_id`;

/** The owner target's reads, bound to the enrollment the review pins. */
function ownerReads(review: Review, authority: Values): Record<string, AuthRead> {
	const target = review.verifiedSnapshot?.accountOwnerTarget;
	if (!target) return {};
	const keyId = authority[authority.length - 1];
	if (typeof keyId !== "string" || keyId.length === 0)
		throw new Error("account_owner_authority_unavailable");
	const [group = null, device = null, publicKey = null, fingerprint = null] = authority;
	const keys = review.verifiedSnapshot?.legacyHistory?.keys.map((key) => key.public_key) ?? [];
	const owner = target.targetIdentityId;
	return {
		ownerLinks: {
			sql: OWNER_LINKS_READ,
			values: [
				target.coordinatorId,
				owner,
				target.issuer,
				target.linkId,
				target.authConfigRevision,
				target.createdAtMs,
			],
		},
		ownerClaimConflicts: {
			sql: OWNER_CLAIM_CONFLICTS_READ,
			values: [target.coordinatorId, device, keyId, owner, group, device, publicKey, fingerprint],
		},
		ownerControllerConflicts: {
			sql: OWNER_CONTROLLER_CONFLICTS_READ,
			values: [
				target.coordinatorId,
				group,
				device,
				fingerprint,
				owner,
				publicKey,
				owner,
				device,
				publicKey,
				JSON.stringify(keys),
			],
		},
	};
}

/** The reads behind the reviewed snapshot. None without a snapshot. */
export function controllerReviewReads(review: Review, authority: Values): Record<string, AuthRead> {
	const snapshot = review.verifiedSnapshot;
	if (!snapshot) return {};
	return {
		invites: {
			sql: INVITES_READ,
			values: [review.groupId, review.deviceId, review.publicKey, review.fingerprint],
		},
		...(snapshot.legacyHistory ? controllerHistoryReads(snapshot.legacyHistory) : {}),
		...ownerReads(review, authority),
	};
}

const rowSet = (rows: unknown[]) => JSON.stringify(rows.map((row) => JSON.stringify(row)).sort());

/**
 * Whether the live rows still match the reviewed snapshot: the same consumed invites,
 * the same legacy history and keys, and an owner target that is still allowed.
 */
export function decideControllerReview(review: Review, rows: Record<string, unknown[]>): boolean {
	const snapshot = review.verifiedSnapshot;
	if (!snapshot) return true;
	const invites = snapshot.invites.map((i) => [
		i.inviteId,
		i.kind,
		i.actorId,
		i.assignedIdentityId,
		i.targetIdentityId,
		i.digest,
	]);
	if (rowSet(rows.invites ?? []) !== rowSet(invites)) return false;
	const history = snapshot.legacyHistory;
	if (history) {
		const expected = {
			history: history.records.map((r) => [
				r.group_id,
				r.candidate_ref,
				r.manifest_version,
				r.completed_at,
				r.created_at,
				r.manifest_json,
			]),
			historyKeys: history.keys.map((key) => [key.public_key, key.fingerprint]),
			historyDiscovery: history.discoveryKeys.map((key) => [key]),
		};
		for (const [name, values] of Object.entries(expected))
			if (rowSet(rows[name] ?? []) !== rowSet(values)) return false;
	}
	if (!snapshot.accountOwnerTarget) return true;
	const links = (rows.ownerLinks ?? []) as { proven?: number | null; live?: number | null }[];
	const linked = links.some((link) => sqlEq(link.proven ?? null, 1) && sqlEq(link.live ?? null, 1));
	return linked && !rows.ownerClaimConflicts?.length && !rows.ownerControllerConflicts?.length;
}

export interface ControllerReviewAuthority {
	/** False when the live rows no longer match the reviewed snapshot. */
	allowed: boolean;
	/** Re-run every read. They lead the batch that writes or answers. */
	guards: AuthLinkStatement[];
}

/** Reads and decides the reviewed snapshot for one controller review. */
export async function readControllerReview(
	backend: Pick<AuthLinkBackend, "first" | "readBatch">,
	review: Review,
	authority: Values,
): Promise<ControllerReviewAuthority> {
	const facts = await readSnapshot<Record<string, unknown[]>>(
		backend,
		controllerReviewReads(review, authority),
	);
	return {
		allowed: decideControllerReview(review, facts.rows),
		guards: Object.values(facts.guards),
	};
}

/** The same decision inside an open SQLite transaction, from reads built beforehand. */
export function decideControllerReviewSync(
	all: (read: AuthRead) => { row: string }[],
	review: Review,
	reads: Record<string, AuthRead>,
): boolean {
	const rows = Object.fromEntries(
		Object.entries(reads).map(([name, read]) => [
			name,
			all(read).map(({ row }) => JSON.parse(row) as unknown),
		]),
	);
	return decideControllerReview(review, rows);
}
