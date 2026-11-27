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
