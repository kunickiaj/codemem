import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";

/**
 * The device's ownership binding, if it has exactly one. A rebind (ADR 0005
 * Section 8) writes one, so admins can tell a rebound device from a conflict.
 */
export const ENROLLMENT_OWNERSHIP_COLUMNS = `(SELECT CASE WHEN count(*) = 1 THEN max(b.identity_id) END
	 FROM coordinator_device_ownership_bindings b
	 WHERE b.device_id = enrolled_devices.device_id) AS ownership_identity_id,
	(SELECT CASE WHEN count(*) = 1 THEN max(b.key_id) END
	 FROM coordinator_device_ownership_bindings b
	 WHERE b.device_id = enrolled_devices.device_id) AS ownership_key_id`;

/**
 * Keeps `ownership_identity_id` only when the binding names this enrollment's
 * exact key; a binding for another key says nothing about this enrollment.
 */
export async function withEnrollmentOwnership(
	rows: ReadonlyArray<CoordinatorEnrollment & { ownership_key_id?: unknown }>,
): Promise<CoordinatorEnrollment[]> {
	return Promise.all(
		rows.map(async (row) => {
			const { ownership_identity_id: identityId, ownership_key_id: keyId, ...base } = row;
			if (typeof identityId !== "string" || typeof keyId !== "string") return base;
			const enrollmentKeyId = await ed25519KeyIdForRevocation(row.public_key);
			return enrollmentKeyId === keyId ? { ...base, ownership_identity_id: identityId } : base;
		}),
	);
}
