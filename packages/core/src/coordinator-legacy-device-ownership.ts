import { DEVICE_REVOCATION_SUBJECT_EXISTS_SQL } from "./coordinator-device-revocation.js";
import type { projectInviteGuardEvidence } from "./coordinator-project-invite-guards.js";
import type {
	CoordinatorConsumeProjectInviteInput,
	CoordinatorEnrollDeviceInput,
} from "./coordinator-store-contract.js";

export function captureLegacyProjectInviteInput(
	input: CoordinatorConsumeProjectInviteInput,
): CoordinatorConsumeProjectInviteInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_input");
	const captured: Record<string, unknown> = {};
	for (const field of [
		"token",
		"operationId",
		"deviceId",
		"publicKey",
		"fingerprint",
		"recipientActorId",
		"recipientDisplayName",
		"deviceDisplayName",
		"now",
	]) {
		const descriptor = legacyEnrollmentDescriptor(input, field);
		if (descriptor && !("value" in descriptor)) throw new Error("invalid_input");
		const value = descriptor?.value;
		if (typeof value !== "string") throw new Error("invalid_input");
		captured[field] = value;
	}
	return captured as unknown as CoordinatorConsumeProjectInviteInput;
}

/** Global ownership metadata, not proof. Bind actual device ID and canonical key ID (or null). */
export const DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL = `EXISTS (
SELECT 1 FROM coordinator_device_ownership_bindings WHERE device_id = ? OR key_id = ?)`;

/** Project actor labels never prove ownership; only the target enrollment is mutated. */
export function legacyProjectInviteOwnershipEvidence(
	evidence: ReturnType<typeof projectInviteGuardEvidence>,
	deviceId: string,
	keyIds: { incoming: string | null; current: string | null },
) {
	const ownershipSql = `${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL} OR ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL}`;
	const ownershipValues = [deviceId, keyIds.incoming, deviceId, keyIds.current];
	return {
		...evidence,
		ownershipSql,
		ownershipValues,
		eligibilitySql: `${evidence.eligibilitySql} AND NOT (${ownershipSql})`,
		eligibilityValues: [...evidence.eligibilityValues, ...ownershipValues],
		boundEligibilitySql: `${evidence.boundEligibilitySql} AND NOT (${ownershipSql})`,
		boundEligibilityValues: [...evidence.boundEligibilityValues, ...ownershipValues],
	};
}

export const LEGACY_DEVICE_DENIAL_SQL = `SELECT CASE
WHEN ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL} THEN 'device_revoked'
WHEN ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL} THEN 'device_ownership_requires_verified_identity'
ELSE 'invite_identity_conflict' END AS denial`;

/** Bind captured public key (null for absence), group/device, then group/device/public key. */
export const LEGACY_ENROLLMENT_SOURCE_MATCH_SQL = `((? IS NULL AND NOT EXISTS (
SELECT 1 FROM enrolled_devices WHERE group_id = ? AND device_id = ?)) OR EXISTS (
SELECT 1 FROM enrolled_devices WHERE group_id = ? AND device_id = ? AND public_key = ?))`;

/** Incoming revocation, incoming ownership, captured current ownership, then source tuple.
 * Source drift deliberately falls through the denial validator to the unavailable error.
 */
export const LEGACY_ENROLLMENT_DENIAL_SQL = `SELECT CASE
WHEN ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL} THEN 'device_revoked'
WHEN ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL} OR ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL}
THEN 'device_ownership_requires_verified_identity'
WHEN NOT ${LEGACY_ENROLLMENT_SOURCE_MATCH_SQL} THEN 'device_ownership_authorization_unavailable'
ELSE 'invite_identity_conflict' END AS denial`;

export const LEGACY_ENROLLMENT_WRITE_SQL = `INSERT INTO enrolled_devices(
group_id, device_id, public_key, fingerprint, identity_id, display_name, enabled, created_at
) SELECT ?, ?, ?, ?, ?, ?, 1, ?
WHERE NOT ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL}
AND NOT ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL}
AND NOT ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL}
AND ${LEGACY_ENROLLMENT_SOURCE_MATCH_SQL}
ON CONFLICT(group_id, device_id) DO UPDATE SET
public_key = excluded.public_key, fingerprint = excluded.fingerprint,
identity_id = COALESCE(enrolled_devices.identity_id, excluded.identity_id),
display_name = excluded.display_name, enabled = 1
WHERE (excluded.identity_id IS NULL OR enrolled_devices.identity_id IS NULL
OR enrolled_devices.identity_id = excluded.identity_id)
AND NOT ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL}
AND NOT ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL}
AND enrolled_devices.public_key = ?`;

export function captureLegacyEnrollmentPublicKey(row: unknown): string | null {
	if (row === null) return null;
	if (!row || typeof row !== "object")
		throw new Error("device_ownership_authorization_unavailable");
	const descriptor = Object.getOwnPropertyDescriptor(row, "public_key");
	if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
		throw new Error("device_ownership_authorization_unavailable");
	}
	return descriptor.value;
}

export function captureLegacyEnrollment(
	groupId: string,
	input: CoordinatorEnrollDeviceInput,
): CoordinatorEnrollDeviceInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_input");
	const captured: Record<string, unknown> = {};
	for (const field of ["deviceId", "publicKey", "fingerprint", "identityId", "displayName"]) {
		const descriptor = legacyEnrollmentDescriptor(input, field);
		if (descriptor && !("value" in descriptor)) throw new Error("invalid_input");
		captured[field] = descriptor?.value;
	}
	assertLegacyDeviceScope(groupId, captured.deviceId);
	if (
		typeof captured.publicKey !== "string" ||
		typeof captured.fingerprint !== "string" ||
		(captured.identityId != null && typeof captured.identityId !== "string") ||
		(captured.displayName != null && typeof captured.displayName !== "string")
	)
		throw new Error("invalid_input");
	return captured as unknown as CoordinatorEnrollDeviceInput;
}

function legacyEnrollmentDescriptor(input: object, field: string): PropertyDescriptor | undefined {
	try {
		return Object.getOwnPropertyDescriptor(input, field);
	} catch {
		throw new Error("invalid_input");
	}
}

export function assertLegacyDeviceScope(groupId: unknown, deviceId: unknown): void {
	if (typeof groupId !== "string" || typeof deviceId !== "string") throw new Error("invalid_input");
}

export function legacyDeviceWriteChanges(result: unknown): number {
	if (!result || typeof result !== "object" || ("success" in result && result.success === false)) {
		throw new Error("device_ownership_authorization_unavailable");
	}
	let changes: unknown;
	if (
		"meta" in result &&
		result.meta &&
		typeof result.meta === "object" &&
		"changes" in result.meta
	) {
		changes = result.meta.changes;
	}
	if (typeof changes !== "number" || !Number.isSafeInteger(changes) || changes < 0 || changes > 1) {
		throw new Error("device_ownership_authorization_unavailable");
	}
	return changes;
}

export function legacyDeviceDenial(row: unknown): string {
	if (
		row &&
		typeof row === "object" &&
		!("success" in row && row.success === false) &&
		"denial" in row
	) {
		const denial = row.denial;
		if (
			denial === "device_revoked" ||
			denial === "device_ownership_requires_verified_identity" ||
			denial === "invite_identity_conflict"
		)
			return denial;
	}
	throw new Error("device_ownership_authorization_unavailable");
}

export function legacyDeviceAuthorizationFailure(error: unknown): never {
	if (
		error instanceof Error &&
		[
			"device_revoked",
			"device_ownership_requires_verified_identity",
			"invite_identity_conflict",
		].includes(error.message)
	)
		throw error;
	throw new Error("device_ownership_authorization_unavailable");
}
