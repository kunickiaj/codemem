import type { CachedCoordinatorAdminDevice } from "../../../lib/state";
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

export function scopeManagementReadinessMessage(summary: CoordinatorAdminSummary): string | null {
	if (summary.readiness === "ready") return null;
	return "Sharing domain management needs the coordinator URL, target group, and admin secret before it can list scopes or change memberships.";
}

export function scopeStatusLabel(status: string | null | undefined): string {
	const value = String(status || "active").trim();
	return value ? value.replaceAll("_", " ") : "active";
}

export function deriveScopeMembershipDeviceRows(
	devices: CachedCoordinatorAdminDevice[],
	members: CoordinatorAdminScopeMemberView[],
): ScopeMembershipDeviceRow[] {
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
				displayName: String(device.display_name || deviceId || "Unnamed device"),
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
				statusRank[a.status] - statusRank[b.status] || a.displayName.localeCompare(b.displayName)
			);
		});
}
