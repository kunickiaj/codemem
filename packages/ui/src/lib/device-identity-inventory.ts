import type { CoordinatorAccess } from "../tabs/recipient-policy-team-create";
import type { DeviceIdentityInventoryItemV1, DeviceIdentityInventoryV1 } from "./api/sync";

export function deviceNeedsIdentityAttention(item: DeviceIdentityInventoryItemV1): boolean {
	return item.state !== "configured" && item.state !== "service" && item.state !== "retired";
}

/**
 * Revoked devices from the sharing intent plus retired devices this viewer knows
 * through local evidence, counting a device once when both sources name it.
 */
export function revokedDeviceTotal(
	inventory: DeviceIdentityInventoryV1 | undefined,
	intentRevokedDeviceIds: readonly string[],
): number {
	// Coordinator-only devices belong to other people in the group, so they aren't this person's.
	const retired =
		inventory?.items.filter(
			(item) =>
				item.state === "retired" &&
				item.sources.some((source) => source !== "coordinator_enrollment"),
		) ?? [];
	const retiredIds = new Set(retired.flatMap((item) => item.evidenceDeviceIds));
	return retired.length + intentRevokedDeviceIds.filter((id) => !retiredIds.has(id)).length;
}

/** Coordinator infrastructure devices, listed apart from people's devices. */
export function serviceDeviceItems(
	inventory: DeviceIdentityInventoryV1 | undefined,
): DeviceIdentityInventoryItemV1[] {
	// A malformed or partial response has no items; treat it as having no service devices.
	return inventory?.items?.filter((item) => item.state === "service") ?? [];
}

/**
 * Drops coordinator service devices from the coordinator's discovered devices, so
 * infrastructure never shows up as a device to review. Discovered devices carry no
 * service marker, so this reuses the inventory classification. Until the inventory
 * has loaded nothing is known to be a service device, so the input is returned as is.
 */
export function withoutServiceDevices<
	T extends { discovered_devices?: Array<{ device_id?: string | null }> } | null | undefined,
>(coordinator: T, inventory: DeviceIdentityInventoryV1 | null | undefined): T {
	const devices = coordinator?.discovered_devices;
	if (!coordinator || !Array.isArray(devices)) return coordinator;
	const serviceIds = new Set(
		serviceDeviceItems(inventory ?? undefined).flatMap((item) => [
			item.deviceId,
			...item.evidenceDeviceIds,
		]),
	);
	if (serviceIds.size === 0) return coordinator;
	return {
		...coordinator,
		discovered_devices: devices.filter(
			(device) => !serviceIds.has(String(device.device_id ?? "").trim()),
		),
	};
}

export function deviceIdentityAttentionItems(
	inventory: DeviceIdentityInventoryV1 | undefined,
): DeviceIdentityInventoryItemV1[] {
	return inventory?.items.filter(deviceNeedsIdentityAttention) ?? [];
}

const NO_COORDINATOR_RECOVERY =
	"Identity setup needs a coordinator. Set the coordinator URL and group in Settings.";

const ACCESS_RECOVERY: Record<Exclude<CoordinatorAccess, "ready">, string> = {
	admin_secret_missing:
		"Only a device that holds the coordinator admin secret can change device Identities. Use that device.",
	coordinator_missing: NO_COORDINATOR_RECOVERY,
	unknown:
		"codemem couldn't check whether this device can change device Identities. Refresh Devices to try again.",
};

/**
 * Whether this device may set up or change the Identity a device belongs to. That
 * needs a coordinator and its admin secret, the same as other access changes.
 */
export function deviceIdentitySetupGate(
	inventory: DeviceIdentityInventoryV1,
	access: CoordinatorAccess,
): { blocked: boolean; recovery: string | null } {
	if (inventory.coordinatorEvidence.safeErrorCode === "coordinator_not_configured") {
		return { blocked: true, recovery: NO_COORDINATOR_RECOVERY };
	}
	if (access !== "ready") return { blocked: true, recovery: ACCESS_RECOVERY[access] };
	if (inventory.truncated) {
		return {
			blocked: true,
			recovery: "Refresh Devices after the complete inventory is available.",
		};
	}
	if (inventory.coordinatorEvidence.availability === "available") {
		return { blocked: false, recovery: null };
	}
	return {
		blocked: true,
		recovery: "Refresh Devices after coordinator device information is available.",
	};
}
