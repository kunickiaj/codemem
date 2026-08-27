/* Coordinator-admin target-group helpers — localStorage persistence of
 * the selected group per coordinator URL, plus lookup helpers that bridge
 * the global `state` snapshot and the coordinatorAdminState module. */

import { state } from "../../../lib/state";
import {
	ADMIN_TARGET_GROUP_KEY,
	type CoordinatorAdminSnapshotTarget,
	coordinatorAdminState,
} from "./state";

export function coordinatorUrlForMatching(value: unknown): string {
	return String(value || "")
		.trim()
		.replace(/\/+$/u, "");
}

export function adminTargetStorageKey(coordinatorUrl: string | null | undefined): string {
	return `${ADMIN_TARGET_GROUP_KEY}:${coordinatorUrlForMatching(coordinatorUrl)}`;
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

export function currentAdminSnapshotTarget(): CoordinatorAdminSnapshotTarget | null {
	const coordinatorUrl = String(state.lastCoordinatorAdminStatus?.coordinator_url || "").trim();
	const groupId =
		currentAdminTargetGroup() ||
		String(state.lastCoordinatorAdminStatus?.active_group || "").trim() ||
		availableCoordinatorGroups()[0]?.group_id ||
		"";
	return coordinatorUrl && groupId ? { coordinatorUrl, groupId } : null;
}

export function adminSnapshotTargetMatchesCurrent(
	target: CoordinatorAdminSnapshotTarget | null,
): boolean {
	const current = currentAdminSnapshotTarget();
	return Boolean(
		target &&
			current &&
			coordinatorUrlForMatching(target.coordinatorUrl) ===
				coordinatorUrlForMatching(current.coordinatorUrl) &&
			target.groupId === current.groupId,
	);
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

export function coordinatorGroupPresentationName(
	groupId: string,
	displayName: string | null | undefined,
): string {
	const explicitName = String(displayName || "").trim();
	const groups = availableCoordinatorGroups();
	const reservedNames = new Set(
		groups.map((group) => String(group.display_name || "").trim()).filter(Boolean),
	);
	if (explicitName) reservedNames.add(explicitName);
	for (const [aliasedGroupId, alias] of coordinatorAdminState.groupPresentationAliases) {
		if (reservedNames.has(alias)) {
			coordinatorAdminState.groupPresentationAliases.delete(aliasedGroupId);
		}
	}
	if (explicitName) return explicitName;
	const existingAlias = coordinatorAdminState.groupPresentationAliases.get(groupId);
	if (existingAlias) return existingAlias;
	for (const alias of coordinatorAdminState.groupPresentationAliases.values()) {
		reservedNames.add(alias);
	}
	let suffix = 1;
	let alias = `Unnamed coordinator group ${suffix}`;
	while (reservedNames.has(alias)) {
		suffix += 1;
		alias = `Unnamed coordinator group ${suffix}`;
	}
	coordinatorAdminState.groupPresentationAliases.set(groupId, alias);
	return alias;
}

export function reconcileGroupRenameDrafts() {
	const next = new Map<string, string>();
	for (const group of availableCoordinatorGroups()) {
		next.set(group.group_id, group.display_name || "");
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
	const nextServerNames = new Map<string, string>();
	const items = Array.isArray(state.lastCoordinatorAdminDevices)
		? state.lastCoordinatorAdminDevices
		: [];
	for (const item of items) {
		const deviceId = String(item.device_id || "").trim();
		if (!deviceId) continue;
		const serverName = String(item.display_name || "");
		const existingDraft = coordinatorAdminState.deviceRenameDrafts.get(deviceId);
		const previousServerName = coordinatorAdminState.deviceRenameServerNames.get(deviceId);
		const hasDirtyDraft =
			existingDraft !== undefined &&
			(previousServerName === undefined || existingDraft !== previousServerName);
		next.set(deviceId, hasDirtyDraft ? existingDraft : serverName);
		nextServerNames.set(deviceId, serverName);
	}
	coordinatorAdminState.deviceRenameDrafts.clear();
	for (const [deviceId, name] of next.entries()) {
		coordinatorAdminState.deviceRenameDrafts.set(deviceId, name);
	}
	coordinatorAdminState.deviceRenameServerNames.clear();
	for (const [deviceId, name] of nextServerNames.entries()) {
		coordinatorAdminState.deviceRenameServerNames.set(deviceId, name);
	}
}
