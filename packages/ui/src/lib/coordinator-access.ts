import { canChangePersonAccess } from "../tabs/recipient-policy-person-settings";
import type { CoordinatorAccess } from "../tabs/recipient-policy-team-create";

/**
 * Access changes and Team creation apply only on a device that holds the coordinator
 * admin secret and has a coordinator URL and group configured.
 */
export function coordinatorAccessFromStatus(
	result: PromiseSettledResult<unknown>,
): CoordinatorAccess {
	if (result.status !== "fulfilled") return "unknown";
	const status = result.value;
	if (!status || typeof status !== "object") return "unknown";
	// The same rule Person settings rechecks right before a merge or removal.
	if (canChangePersonAccess(status)) return "ready";
	const value = status as { readiness?: unknown; has_admin_secret?: unknown };
	if (value.readiness === "partial" && value.has_admin_secret !== true) {
		return "admin_secret_missing";
	}
	return "coordinator_missing";
}

const PEOPLE_CHANGE_BLOCKED: Record<Exclude<CoordinatorAccess, "ready">, string> = {
	coordinator_missing:
		"Adding or changing people needs a coordinator. Set the coordinator URL and group in Settings.",
	admin_secret_missing:
		"Only a device that holds the coordinator admin secret can add or change people. Use that device.",
	unknown:
		"codemem couldn't check whether this device can add or change people. Refresh to try again.",
};

/** Why this device may not add or change people, or null when it may. */
export function peopleChangeBlockedReason(access: CoordinatorAccess): string | null {
	return access === "ready" ? null : PEOPLE_CHANGE_BLOCKED[access];
}
