import type { Database } from "./db.js";
import { legacyTeamRosterFingerprint } from "./recipient-policy-identifiers.js";

/**
 * The fingerprint of a coordinator roster as this machine holds its devices
 * now: every device the roster lists, with its key, its enabled state and the
 * person its active assignment names.
 *
 * Discovery computes it for the roster it reads, and an activation saves it for
 * the roster it was given. A completed setup reads as ready only while the two
 * are equal, so both call this one function, on the roster as the coordinator
 * reports it. Neither leaves a device out, whatever the setup says about it.
 */
export function currentLegacyTeamRosterFingerprint(
	db: Database,
	roster: ReadonlyArray<{ deviceId: string; fingerprint: string; enabled: boolean }>,
): string {
	const activeIdentity = db
		.prepare(
			`SELECT identity_id FROM identity_devices
			 WHERE device_id = ? AND status = 'active' LIMIT 1`,
		)
		.pluck();
	return legacyTeamRosterFingerprint(
		roster.map((device) => ({
			deviceId: device.deviceId,
			fingerprint: device.fingerprint,
			enabled: device.enabled,
			identityId: (activeIdentity.get(device.deviceId) as string | undefined) ?? null,
		})),
	);
}
