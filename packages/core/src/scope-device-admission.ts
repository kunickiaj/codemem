import type { Database } from "./db.js";
import { getAnyRecipientPolicyDenyOverlayForScopeDevice } from "./recipient-policy-deny-overlay.js";
import { teamMemberRemovalRefusesScope } from "./team-member-removal-admission.js";
import { teamSetupRefusesScope } from "./team-setup-scope-admission.js";

/**
 * Whether a device is refused a scope regardless of its cached membership: a
 * recipient policy deny overlay names the pair, a reviewed setup Team's current
 * state refuses it, or the device's person was removed from a Team whose
 * Projects the scope holds. Every check that admits a device to a scope asks
 * this. Add new current-state rules here, not beside it.
 */
export function isScopeDeviceAdmissionRefused(
	db: Database,
	input: { scopeId: string; deviceId: string },
): boolean {
	return (
		getAnyRecipientPolicyDenyOverlayForScopeDevice(db, input) != null ||
		teamSetupRefusesScope(db, input) ||
		teamMemberRemovalRefusesScope(db, input)
	);
}
