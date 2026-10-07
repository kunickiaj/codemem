import { DEVICE_REVOCATION_SUBJECT_EXISTS_SQL } from "./coordinator-device-revocation.js";
import type {
	CoordinatorConsumeProjectInviteInput,
	CoordinatorEnrollment,
	CoordinatorInvite,
} from "./coordinator-store-contract.js";

const revocationSql = `${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL}
		OR ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL}`;
// Pin the reviewed Project intent and the enrollment used to derive the seed key.
// Every writer owns this guard: a zero-row batch statement does not stop its siblings.
const eligibilitySql = `EXISTS (SELECT 1 FROM coordinator_invites pi
		JOIN groups pg ON pg.group_id = pi.group_id AND pg.archived_at IS NULL
		WHERE pi.invite_id = ? AND pi.group_id = ? AND pi.revoked_at IS NULL
		AND pi.operation_id = ? AND pi.project_intent_json = ?
		AND pi.reviewed_project_set_digest IS ? AND pi.token_digest IS ?
		AND pi.project_summaries_json IS ? AND pi.inviter_actor_id IS ?
		AND pi.inviter_device_id IS ? AND pi.expires_at = ?
		AND ((? = 0 AND NOT EXISTS (SELECT 1 FROM enrolled_devices se
			WHERE se.group_id = pi.group_id AND se.device_id = pi.inviter_device_id))
			OR (? = 1 AND EXISTS (SELECT 1 FROM enrolled_devices se
				WHERE se.group_id = pi.group_id AND se.device_id = pi.inviter_device_id
				AND se.public_key = ? AND se.fingerprint = ? AND se.enabled = ?)))
		AND NOT EXISTS (SELECT 1 FROM enrolled_devices re
			WHERE re.group_id = pi.group_id AND re.device_id = ?
			AND (re.public_key <> ? OR re.fingerprint <> ?
				OR (re.identity_id IS NOT NULL AND re.identity_id <> ?)))
		AND NOT (${revocationSql}))`;
const bindingSql = `EXISTS (SELECT 1 FROM coordinator_invites bi
	WHERE bi.invite_id = ? AND bi.consumed_at IS NOT NULL
	AND bi.bound_device_id = ? AND bi.bound_public_key = ? AND bi.bound_fingerprint = ?
	AND bi.recipient_actor_id = ? AND bi.recipient_display_name = ?
	AND bi.recipient_device_display_name = ?)`;

export function projectInviteGuardEvidence(
	invite: CoordinatorInvite,
	opts: CoordinatorConsumeProjectInviteInput,
	inviter: CoordinatorEnrollment | null,
	keyIds: { recipient: string | null; inviter: string | null },
) {
	const revocationValues = [
		opts.deviceId,
		keyIds.recipient,
		invite.inviter_device_id ?? null,
		keyIds.inviter,
	];
	const eligibilityValues = [
		invite.invite_id,
		invite.group_id,
		invite.operation_id,
		invite.project_intent_json,
		invite.reviewed_project_set_digest ?? null,
		invite.token_digest ?? null,
		invite.project_summaries_json ?? null,
		invite.inviter_actor_id ?? null,
		invite.inviter_device_id ?? null,
		invite.expires_at,
		inviter ? 1 : 0,
		inviter ? 1 : 0,
		inviter?.public_key ?? null,
		inviter?.fingerprint ?? null,
		inviter?.enabled ?? null,
		opts.deviceId,
		opts.publicKey,
		opts.fingerprint,
		opts.recipientActorId,
		...revocationValues,
	];
	return {
		revocationSql,
		revocationValues,
		eligibilitySql,
		eligibilityValues,
		boundEligibilitySql: `${eligibilitySql} AND ${bindingSql}`,
		boundEligibilityValues: [
			...eligibilityValues,
			invite.invite_id,
			opts.deviceId,
			opts.publicKey,
			opts.fingerprint,
			opts.recipientActorId,
			opts.recipientDisplayName,
			opts.deviceDisplayName,
		],
	};
}
