import { DEVICE_REVOCATION_SUBJECT_EXISTS_SQL } from "./coordinator-device-revocation.js";
import type { CoordinatorEnrollDeviceInput } from "./coordinator-store-contract.js";

/** Global ownership metadata, not proof. Bind actual device ID and canonical key ID (or null). */
export const DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL = `EXISTS (
SELECT 1 FROM coordinator_device_ownership_bindings WHERE device_id = ? OR key_id = ?)`;

export const LEGACY_DEVICE_DENIAL_SQL = `SELECT CASE
WHEN ${DEVICE_REVOCATION_SUBJECT_EXISTS_SQL} THEN 'device_revoked'
WHEN ${DEVICE_OWNERSHIP_SUBJECT_EXISTS_SQL} THEN 'device_ownership_requires_verified_identity'
ELSE 'invite_identity_conflict' END AS denial`;

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
