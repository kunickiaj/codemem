/* Coordinator-admin target-group helpers — localStorage persistence of
 * the selected group per coordinator URL, plus lookup helpers that bridge
 * the global `state` snapshot and the coordinatorAdminState module. */

import { state } from "../../../lib/state";
import { ADMIN_TARGET_GROUP_KEY, coordinatorAdminState } from "./state";

export function adminTargetStorageKey(coordinatorUrl: string | null | undefined): string {
	return `${ADMIN_TARGET_GROUP_KEY}:${String(coordinatorUrl || "").trim()}`;
}

export function readStoredAdminTargetGroup(coordinatorUrl: string | null | undefined): string {
	try {
		return localStorage.getItem(adminTargetStorageKey(coordinatorUrl)) || "";
	} catch {
		return "";
	}
}

export function writeStoredAdminTargetGroup(
	coordinatorUrl: string | null | undefined,
	groupId: string,
) {
	try {
		localStorage.setItem(adminTargetStorageKey(coordinatorUrl), groupId);
	} catch {
		// ignore storage errors
	}
}

export function currentAdminTargetGroup(): string {
	return String(state.coordinatorAdminTargetGroup || "").trim();
}

export function setAdminTargetGroup(groupId: string) {
	state.coordinatorAdminTargetGroup = groupId;
	writeStoredAdminTargetGroup(state.lastCoordinatorAdminStatus?.coordinator_url || null, groupId);
}

export function availableCoordinatorGroups(): Array<{
	group_id: string;
	display_name: string | null;
	archived_at: string | null;
}> {
	const groups = Array.isArray(state.lastCoordinatorAdminGroups)
		? state.lastCoordinatorAdminGroups
		: [];
	return groups
		.map((group) => ({
			archived_at: group.archived_at ?? null,
			display_name: group.display_name ?? null,
			group_id: String(group.group_id || "").trim(),
		}))
		.filter((group) => group.group_id);
}

export function reconcileGroupRenameDrafts() {
	const next = new Map<string, string>();
	for (const group of availableCoordinatorGroups()) {
		next.set(group.group_id, group.display_name || group.group_id);
	}
	coordinatorAdminState.groupRenameDrafts.clear();
	for (const [groupId, name] of next.entries()) {
		coordinatorAdminState.groupRenameDrafts.set(groupId, name);
	}
}

export function currentAdminTargetGroupRecord() {
	const target = currentAdminTargetGroup();
	return availableCoordinatorGroups().find((group) => group.group_id === target) || null;
}

export function resolveAdminTargetGroup() {
	const status = state.lastCoordinatorAdminStatus;
	const groups = availableCoordinatorGroups();
	const configured = String(status?.active_group || "").trim();
	const stored = readStoredAdminTargetGroup(status?.coordinator_url || null);
	const current = currentAdminTargetGroup();
	const availableIds = new Set(groups.map((group) => group.group_id));
	const candidate = current || stored || configured || groups[0]?.group_id || "";
	const resolved =
		candidate && (availableIds.size === 0 || availableIds.has(candidate))
			? candidate
			: configured || groups[0]?.group_id || "";
	setAdminTargetGroup(resolved);
	return resolved;
}

export function reconcileDeviceRenameDrafts() {
	const next = new Map<string, string>();
	const items = Array.isArray(state.lastCoordinatorAdminDevices)
		? state.lastCoordinatorAdminDevices
		: [];
	for (const item of items) {
		const deviceId = String(item.device_id || "").trim();
		if (!deviceId) continue;
		next.set(deviceId, String(item.display_name || ""));
	}
	coordinatorAdminState.deviceRenameDrafts.clear();
	for (const [deviceId, name] of next.entries()) {
		coordinatorAdminState.deviceRenameDrafts.set(deviceId, name);
	}
}
