import type { CachedCoordinatorAdminDevice } from "../../../lib/state";
import {
	createUnnamedDeviceAliasRegistry,
	stableDeviceDisplayNames,
	type UnnamedDeviceAliasRegistry,
} from "./device-card";
import type { CoordinatorAdminSummary } from "./summary";

export interface CoordinatorAdminScopeView {
	scope_id?: string;
	label?: string | null;
	kind?: string | null;
	authority_type?: string | null;
	membership_epoch?: number | null;
	status?: string | null;
}

export interface CoordinatorAdminScopeMemberView {
	device_id?: string;
	role?: string | null;
	status?: string | null;
	membership_epoch?: number | null;
	updated_at?: string | null;
}

export type ScopeMembershipStatus = "active" | "revoked" | "not_member";

export interface ScopeMembershipDeviceRow {
	deviceId: string;
	displayName: string;
	enabled: boolean;
	status: ScopeMembershipStatus;
	role: string;
	membershipEpoch: number | null;
	updatedAt: string | null;
}

export interface SpaceCardCopy {
	title: string;
	summary: string;
	advancedDetail: string;
}

export interface SpaceAccessDeviceCopy {
	statusLabel: string;
	detail: string;
	advancedDetail: string;
}

export function scopeManagementReadinessMessage(summary: CoordinatorAdminSummary): string | null {
	if (summary.readiness === "ready") return null;
	return "Legacy Space management needs the coordinator URL, target group, and admin secret before it can list Spaces or change transport memberships.";
}

export function scopeStatusLabel(status: string | null | undefined): string {
	const value = String(status || "active").trim();
	return value ? value.replaceAll("_", " ") : "active";
}

export function spaceCardCopy(scope: CoordinatorAdminScopeView): SpaceCardCopy {
	const title = String(scope.label || "").trim() || "Untitled Space";
	const status = scopeStatusLabel(scope.status);
	const kind = String(scope.kind || "user").replaceAll("_", " ");
	const scopeId = String(scope.scope_id || "").trim() || "unknown";
	const epoch = scope.membership_epoch == null ? "—" : String(scope.membership_epoch);
	return {
		title,
		summary: `${status} Space · ${kind}`,
		advancedDetail: `Space ID ${scopeId} · Membership epoch ${epoch}`,
	};
}

export function spaceAccessDeviceCopy(row: ScopeMembershipDeviceRow): SpaceAccessDeviceCopy {
	const statusLabel: Record<ScopeMembershipStatus, string> = {
		active: "Space access active",
		revoked: "Space access revoked",
		not_member: "No Space access",
	};
	const role = row.role.replaceAll("_", " ");
	const detail =
		row.status === "not_member" ? statusLabel[row.status] : `${statusLabel[row.status]} · ${role}`;
	const epoch = row.membershipEpoch == null ? "—" : String(row.membershipEpoch);
	return {
		statusLabel: statusLabel[row.status],
		detail,
		advancedDetail: `Device ID ${row.deviceId} · Membership epoch ${epoch}`,
	};
}

export function spaceRevokeMemberTitle(
	scope: CoordinatorAdminScopeView,
	displayName: string,
	_deviceId: string,
): string {
	const deviceLabel = displayName || "this device";
	return `Revoke ${deviceLabel} from ${spaceCardCopy(scope).title}?`;
}

export function deriveScopeMembershipDeviceRows(
	devices: CachedCoordinatorAdminDevice[],
	members: CoordinatorAdminScopeMemberView[],
	aliases: UnnamedDeviceAliasRegistry = createUnnamedDeviceAliasRegistry(),
): ScopeMembershipDeviceRow[] {
	const deviceDisplayNames = stableDeviceDisplayNames(devices, aliases);
	const memberByDevice = new Map(
		members
			.map((member) => [String(member.device_id || "").trim(), member] as const)
			.filter(([deviceId]) => deviceId.length > 0),
	);
	return devices
		.map((device) => {
			const deviceId = String(device.device_id || "").trim();
			if (!deviceId) return null;
			const member = memberByDevice.get(deviceId);
			const rawStatus = String(member?.status || "").trim();
			const status: ScopeMembershipStatus = member
				? rawStatus === "revoked"
					? "revoked"
					: "active"
				: "not_member";
			const membershipEpoch =
				typeof member?.membership_epoch === "number" && Number.isFinite(member.membership_epoch)
					? Math.trunc(member.membership_epoch)
					: null;
			return {
				deviceId,
				displayName: deviceDisplayNames.get(deviceId) || "Unnamed device",
				enabled: device.enabled !== false && device.enabled !== 0,
				status,
				role: String(member?.role || "member"),
				membershipEpoch,
				updatedAt: member?.updated_at ? String(member.updated_at) : null,
			};
		})
		.filter((row): row is ScopeMembershipDeviceRow => row !== null)
		.sort((a, b) => {
			const statusRank: Record<ScopeMembershipStatus, number> = {
				active: 0,
				revoked: 1,
				not_member: 2,
			};
			return (
				statusRank[a.status] - statusRank[b.status] ||
				a.displayName.localeCompare(b.displayName, undefined, { numeric: true })
			);
		});
}

export function coordinatorAdminDevicesForGroup(
	loadedDevices: CachedCoordinatorAdminDevice[],
	cachedDevices: CachedCoordinatorAdminDevice[],
	groupId: string,
	devicesLoaded: boolean,
): CachedCoordinatorAdminDevice[] {
	const targetGroupId = String(groupId || "").trim();
	if (devicesLoaded || loadedDevices.length > 0 || !targetGroupId) return loadedDevices;
	return cachedDevices.filter((device) => String(device.group_id || "").trim() === targetGroupId);
}
