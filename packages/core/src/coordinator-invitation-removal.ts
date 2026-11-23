import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { DEVICE_REVOCATION_SUBJECT_EXISTS_SQL } from "./coordinator-device-revocation.js";

interface RemovalSubject {
	deviceId: string;
	keyId: string | null;
	publicKey: string;
}

type InviteRemovalSubject = RemovalSubject & { inviteId: string };

const RECIPIENT_MATCH = `(t.device_id = s.device_id OR
 (s.key_id IS NOT NULL AND t.key_id = s.key_id) OR
 (s.key_id IS NULL AND t.key_id IS NULL AND t.public_key = s.public_key))`;

// Read the issue sequence from the live invitation row, not from request data.
const STALE_SQL = `CASE
 WHEN EXISTS (SELECT 1 FROM coordinator_device_removals t
  LEFT JOIN enrolled_devices seed ON seed.group_id = i.group_id AND seed.device_id = i.inviter_device_id
  WHERE i.inviter_device_id IS NOT NULL AND t.removal_seq > COALESCE(i.issued_after_removal_seq, 0)
   AND (t.device_id = i.inviter_device_id OR t.key_id = NULLIF(seed.key_id, '')
    OR (seed.key_id = '' AND t.key_id IS NULL AND t.public_key = seed.public_key)))
 THEN 'invite_invalid'
 WHEN EXISTS (SELECT 1 FROM coordinator_device_removals t
  WHERE ${RECIPIENT_MATCH} AND t.removal_seq > COALESCE(i.issued_after_removal_seq, 0))
 THEN 'device_removed'
 ELSE 'fresh' END`;

export function invitationRemovalFence(ready: boolean, subject: InviteRemovalSubject) {
	return removalFence(ready, subject, {
		source: "coordinator_invites i",
		match: "i.invite_id = s.source_id",
		id: subject.inviteId,
	});
}

export function joinRequestRemovalFence(
	ready: boolean,
	subject: RemovalSubject & { requestId: string },
	tokenDigest: string,
) {
	return removalFence(ready, subject, {
		source: `(SELECT jr.request_id, jr.group_id, jr.issued_after_removal_seq,
		 (SELECT invite.inviter_device_id FROM coordinator_invites invite
		  WHERE invite.group_id = jr.group_id AND (invite.token = jr.token OR invite.token_digest = ?)
		  LIMIT 1) AS inviter_device_id FROM coordinator_join_requests jr) i`,
		match: "i.request_id = s.source_id",
		id: subject.requestId,
		values: [tokenDigest],
	});
}

function removalFence(
	ready: boolean,
	subject: RemovalSubject,
	source: { source: string; match: string; id: string; values?: string[] },
) {
	if (!ready) return null;
	const { deviceId, keyId, publicKey } = subject;
	// D1 repeats this guard within one statement. Bind the tuple once per use.
	const from = `FROM ${source.source}
 CROSS JOIN (SELECT json_extract(value,'$[0]') AS source_id, json_extract(value,'$[1]') AS device_id,
 json_extract(value,'$[2]') AS key_id, json_extract(value,'$[3]') AS public_key
 FROM json_each(?)) s WHERE ${source.match}`;
	const active = `EXISTS (SELECT 1 FROM coordinator_device_removals t WHERE t.lifted_at IS NULL AND ${RECIPIENT_MATCH})`;
	const values = [
		...(source.values ?? []),
		JSON.stringify([[source.id, deviceId, keyId, publicKey]]),
	];
	return {
		ordered: {
			sql: `EXISTS (SELECT 1 ${from} AND (${STALE_SQL}) = 'fresh')`,
			values,
		},
		eligible: {
			sql: `EXISTS (SELECT 1 ${from} AND (${STALE_SQL}) = 'fresh' AND NOT (${active}))`,
			values,
		},
		read: {
			sql: `SELECT (${STALE_SQL}) AS ordering, (${active}) AS active ${from}`,
			values,
		},
		denial: {
			sql: `SELECT CASE WHEN (${STALE_SQL}) = 'fresh' THEN 'device_removed' ELSE (${STALE_SQL}) END ${from}`,
			values,
		},
	};
}

export type InvitationRemovalState = { ordering: string; active: number };
export type InvitationRemovalFence = ReturnType<typeof invitationRemovalFence>;

export function withInvitationRemovalGuard<
	T extends {
		eligibilitySql: string;
		eligibilityValues: unknown[];
		boundEligibilitySql: string;
		boundEligibilityValues: unknown[];
	},
>(guard: T, fence: InvitationRemovalFence): T {
	if (!fence) return guard;
	return {
		...guard,
		eligibilitySql: `${guard.eligibilitySql} AND (${fence.eligible.sql})`,
		eligibilityValues: [...guard.eligibilityValues, ...fence.eligible.values],
		boundEligibilitySql: `${guard.boundEligibilitySql} AND (${fence.eligible.sql})`,
		boundEligibilityValues: [...guard.boundEligibilityValues, ...fence.eligible.values],
	};
}

export function joinRequestCreationDenial(
	fence: NonNullable<ReturnType<typeof invitationRemovalFence>>,
	subject: Pick<RemovalSubject, "deviceId" | "keyId">,
) {
	return {
		sql: `SELECT CASE WHEN ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL} THEN 'device_revoked'
 ELSE COALESCE((${fence.denial.sql}), 'invite_invalid') END AS denial`,
		values: [subject.deviceId, subject.keyId, ...fence.denial.values],
	};
}

export function invitationRemovalNeedsLift(
	state: InvitationRemovalState | null | undefined,
	options: { consumed: boolean; proofVerified?: boolean },
): boolean {
	if (state?.ordering === "invite_invalid") throw new Error("invite_invalid");
	if (state?.ordering === "device_removed") throw new Error("device_removed");
	if (state?.ordering !== "fresh" || (state.active !== 0 && state.active !== 1))
		throw new Error("device_ownership_authorization_unavailable");
	if (!state.active) return false;
	if (!options.proofVerified || options.consumed) throw new Error("device_removed");
	return true;
}

/** Run only inside fresh acceptance, with the existing authority predicates. */
export function liftInvitationRemovals(
	subject: InviteRemovalSubject,
	now: string,
	eligibility: AuthLinkStatement,
): AuthLinkStatement {
	const { inviteId, deviceId, keyId, publicKey } = subject;
	return {
		sql: `WITH s(device_id,key_id,public_key) AS (VALUES (?, ?, ?))
 UPDATE coordinator_device_removals AS t SET lifted_at = ?, lifted_by_invite_id = ?
 FROM s WHERE t.lifted_at IS NULL AND ${RECIPIENT_MATCH}
 AND s.key_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_removals other WHERE other.lifted_at IS NULL
  AND other.device_id = s.device_id AND other.key_id IS NOT s.key_id)
 AND EXISTS (SELECT 1 FROM coordinator_invites i
  WHERE i.invite_id = ? AND i.consumed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
   AND (i.inviter_device_id IS NULL OR EXISTS (
    SELECT 1 FROM enrolled_devices seed
    WHERE seed.group_id = i.group_id AND seed.device_id = i.inviter_device_id AND seed.enabled = 1))
   AND i.invite_kind IN ('team_member','add_device','project_share') AND (${STALE_SQL}) = 'fresh')
 AND (${eligibility.sql})`,
		values: [deviceId, keyId, publicKey, now, inviteId, inviteId, now, ...eligibility.values],
	};
}

export function invitationLiftStatements(
	subject: InviteRemovalSubject,
	now: string,
	eligibility: AuthLinkStatement,
	fence: NonNullable<InvitationRemovalFence>,
): AuthLinkStatement[] {
	return [
		liftInvitationRemovals(subject, now, eligibility),
		{
			sql: `SELECT CASE WHEN changes() > 0 AND (${fence.eligible.sql})
				THEN 1 ELSE json('device_removed') END`,
			values: fence.eligible.values,
		},
	];
}
