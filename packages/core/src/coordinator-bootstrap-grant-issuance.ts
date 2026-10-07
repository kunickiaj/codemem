import { DEVICE_REVOCATION_SUBJECT_EXISTS_SQL } from "./coordinator-device-revocation.js";
import type { CoordinatorCreateBootstrapGrantInput } from "./coordinator-store-contract.js";

export interface BootstrapParticipantSource {
	public_key: string;
	fingerprint: string;
	identity_id: string | null;
}

// Disabled enrollment still supplies key metadata; raw issuance is not authorization.
export const BOOTSTRAP_PARTICIPANT_SOURCE_SQL = `SELECT public_key, fingerprint, identity_id
	FROM enrolled_devices WHERE group_id = ? AND device_id = ?`;
export const BOOTSTRAP_PARTICIPANTS_REVOKED_SQL = `SELECT 1 WHERE
	${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL} OR ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL}`;

const PINNED_PARTICIPANT_SQL = `((? = 0 AND NOT EXISTS (
	SELECT 1 FROM enrolled_devices WHERE group_id = ? AND device_id = ?))
	OR (? = 1 AND EXISTS (SELECT 1 FROM enrolled_devices
		WHERE group_id = ? AND device_id = ? AND public_key IS ?
		AND fingerprint IS ? AND identity_id IS ?)))`;

export const BOOTSTRAP_RAW_INSERT_SQL = `INSERT INTO coordinator_bootstrap_grants(
	grant_id, group_id, seed_device_id, worker_device_id, expires_at, created_at, created_by, revoked_at
) SELECT ?, ?, ?, ?, ?, ?, ?, NULL
WHERE ${PINNED_PARTICIPANT_SQL} AND ${PINNED_PARTICIPANT_SQL}
AND NOT (${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL} OR ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL})
RETURNING grant_id, group_id, seed_device_id, worker_device_id, expires_at, created_at, created_by, revoked_at`;

export function captureBootstrapParticipantSource(source: BootstrapParticipantSource | null) {
	if (!source) return null;
	if (
		typeof source.public_key !== "string" ||
		typeof source.fingerprint !== "string" ||
		(source.identity_id !== null && typeof source.identity_id !== "string")
	) {
		throw new Error("bootstrap_grant_write_incomplete");
	}
	return {
		public_key: source.public_key,
		fingerprint: source.fingerprint,
		identity_id: source.identity_id,
	};
}

function participantPinValues(
	groupId: string,
	deviceId: string,
	source: BootstrapParticipantSource | null,
) {
	const present = source ? 1 : 0;
	return [
		present,
		groupId,
		deviceId,
		present,
		groupId,
		deviceId,
		source?.public_key ?? null,
		source?.fingerprint ?? null,
		source?.identity_id ?? null,
	];
}

export function bootstrapRawInsertValues(
	input: CoordinatorCreateBootstrapGrantInput,
	grant: { grantId: string; createdAt: string },
	participants: {
		seed: BootstrapParticipantSource | null;
		worker: BootstrapParticipantSource | null;
	},
	revocationValues: (string | null)[],
) {
	return [
		grant.grantId,
		input.groupId,
		input.seedDeviceId,
		input.workerDeviceId,
		input.expiresAt,
		grant.createdAt,
		input.createdBy ?? null,
		...participantPinValues(input.groupId, input.seedDeviceId, participants.seed),
		...participantPinValues(input.groupId, input.workerDeviceId, participants.worker),
		...revocationValues,
	];
}
