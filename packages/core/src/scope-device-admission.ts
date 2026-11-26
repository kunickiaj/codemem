import type { Database } from "./db.js";
import { getAnyRecipientPolicyDenyOverlayForScopeDevice } from "./recipient-policy-deny-overlay.js";
import { teamSetupRefusesScope } from "./team-setup-scope-admission.js";

/**
 * Whether a device is refused a scope regardless of its cached membership: a
 * recipient policy deny overlay names the pair, or a reviewed setup Team's current
 * state refuses it. Every check that admits a device to a scope asks this.
 */
export function isScopeDeviceAdmissionRefused(
	db: Database,
	input: { scopeId: string; deviceId: string },
): boolean {
	return (
		getAnyRecipientPolicyDenyOverlayForScopeDevice(db, input) != null ||
		teamSetupRefusesScope(db, input)
	);
}
