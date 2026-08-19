import type { DeviceIdentityInventoryItemV1, DeviceIdentityInventoryV1 } from "./api/sync";

export function deviceNeedsIdentityAttention(item: DeviceIdentityInventoryItemV1): boolean {
	return item.state !== "configured";
}

export function deviceIdentityAttentionItems(
	inventory: DeviceIdentityInventoryV1 | undefined,
): DeviceIdentityInventoryItemV1[] {
	return inventory?.items.filter(deviceNeedsIdentityAttention) ?? [];
}

export function deviceIdentitySetupGate(
	inventory: DeviceIdentityInventoryV1,
	item: DeviceIdentityInventoryItemV1,
): { blocked: boolean; recovery: string | null } {
	if (inventory.truncated) {
		return {
			blocked: true,
			recovery: "Refresh Devices after the complete inventory is available.",
		};
	}
	if (inventory.coordinatorEvidence.availability === "available") {
		return { blocked: false, recovery: null };
	}
	if (
		inventory.coordinatorEvidence.safeErrorCode === "coordinator_not_configured" &&
		item.isLocal
	) {
		return { blocked: false, recovery: null };
	}
	return {
		blocked: true,
		recovery: "Refresh Devices after coordinator device information is available.",
	};
}
