/* Coordinator-admin action handlers — factory that returns the 5 async
 * handlers (group create / group rename+archive+unarchive / invite
 * create / join-request review / device rename+enable+disable+remove).
 *
 * Takes `renderShell` and `reloadData` as deps so the handlers can
 * trigger a re-render after each pending-flag flip without pulling back
 * into coordinator-admin.tsx. */

import * as api from "../../../lib/api";
import { showGlobalNotice } from "../../../lib/notice";
import { state } from "../../../lib/state";
import { openSyncConfirmDialog } from "../../sync/sync-dialogs";
import { type CoordinatorAdminSurface, surfacesAreFresh } from "./recovery";
import { coordinatorAdminState } from "./state";
import {
	adminSnapshotTargetMatchesCurrent,
	coordinatorGroupPresentationName,
	coordinatorUrlForMatching,
	currentAdminSnapshotTarget,
	currentAdminTargetGroup,
	setAdminTargetGroup,
} from "./target-group";

const DEVICE_RENAME_ERROR_MESSAGES = new Map([
	["display_name_required", "Enter a device name before renaming it."],
	["display_name_invalid", "Enter a valid device name and retry."],
	["display_name_too_long", "The device name is too long. Use a shorter name and retry."],
]);

function safeInviteCreationError(cause: unknown): string {
	const message = cause instanceof Error ? cause.message : "";
	if (message.includes("group_archived") || message.includes("Group is archived")) {
		return "This legacy coordinator group is archived. Choose an active group or refresh coordinator groups.";
	}
	if (message.includes("group_not_found") || message.includes("Group not found")) {
		return "This legacy coordinator group no longer exists. Choose an active group or refresh coordinator groups.";
	}
	return "Could not create the legacy coordinator invite. Sharing policy is unchanged; check coordinator recovery status and retry.";
}

function isMissingJoinRequestError(cause: unknown): boolean {
	if (!(cause instanceof Error)) return false;
	return (
		cause.message.includes("request_not_found") || cause.message.includes("join request not found")
	);
}

function isStaleGroupMutationError(cause: unknown): boolean {
	if (!(cause instanceof Error)) return false;
	const message = cause.message.toLowerCase();
	return message.includes("group_not_found") || message.includes("group not found");
}

function isMissingDeviceError(cause: unknown): boolean {
	if (!(cause instanceof Error)) return false;
	const message = cause.message.toLowerCase();
	return message.includes("device_not_found") || message.includes("device not found");
}

export interface CoordinatorAdminActionDeps {
	renderShell: () => void;
	reloadData: () => Promise<void>;
}

export interface CoordinatorAdminActions {
	createGroupFromAdminPanel: () => Promise<void>;
	runGroupAction: (
		groupId: string,
		displayName: string,
		kind: "rename" | "archive" | "unarchive",
	) => Promise<void>;
	createInviteFromAdminPanel: () => Promise<void>;
	reviewJoinRequestFromAdminPanel: (requestId: string, action: "approve" | "deny") => Promise<void>;
	runDeviceAction: (
		deviceId: string,
		groupId: string,
		displayName: string,
		kind: "rename" | "disable" | "enable" | "remove",
	) => Promise<void>;
}

export function createCoordinatorAdminActions(
	deps: CoordinatorAdminActionDeps,
): CoordinatorAdminActions {
	const { renderShell, reloadData } = deps;
	const requireFresh = (...surfaces: CoordinatorAdminSurface[]): boolean => {
		if (surfacesAreFresh(coordinatorAdminState.recovery, ...surfaces)) return true;
		showGlobalNotice(
			"Coordinator data changed or is refreshing. Wait for recovery to finish, then try again.",
			"warning",
		);
		return false;
	};

	async function createGroupFromAdminPanel() {
		if (!requireFresh("status", "groups")) return;
		if (coordinatorAdminState.groupActionPendingKind) return;
		const operationCoordinatorUrl = coordinatorUrlForMatching(
			state.lastCoordinatorAdminStatus?.coordinator_url,
		);
		const groupId = coordinatorAdminState.createGroupId.trim();
		if (!groupId) {
			showGlobalNotice("Enter a coordinator group ID before creating a legacy group.", "warning");
			return;
		}
		const requestedDisplayName = coordinatorAdminState.createGroupDisplayName.trim();
		coordinatorAdminState.groupActionPendingKind = "create";
		renderShell();
		try {
			const result = (await api.createCoordinatorAdminGroup({
				group_id: groupId,
				display_name: requestedDisplayName || null,
			})) as {
				default_space?:
					| {
							scope?: { scope_id?: string; label?: string | null } | null;
							preferences?: { auto_grant_default_space_on_join?: boolean } | null;
					  }
					| { scope_id?: string; label?: string | null }
					| null;
				group?: { group_id?: string; display_name?: string | null } | null;
				setup_warning?: { step?: string; error?: string } | null;
			};
			if (
				coordinatorUrlForMatching(state.lastCoordinatorAdminStatus?.coordinator_url) !==
				operationCoordinatorUrl
			) {
				return;
			}
			const defaultSpaceContainer = result.default_space as
				| { scope?: { scope_id?: string; label?: string | null } | null }
				| { scope_id?: string; label?: string | null }
				| null
				| undefined;
			const defaultSpace = ((defaultSpaceContainer && "scope" in defaultSpaceContainer
				? defaultSpaceContainer.scope
				: defaultSpaceContainer) ?? {}) as { scope_id?: string; label?: string | null };
			const defaultSpacePreferences = (
				defaultSpaceContainer && "preferences" in defaultSpaceContainer
					? defaultSpaceContainer.preferences
					: null
			) as { auto_grant_default_space_on_join?: boolean } | null;
			const defaultSpaceScopeId = String(defaultSpace?.scope_id || "");
			coordinatorAdminState.createGroupId = "";
			coordinatorAdminState.createGroupDisplayName = "";
			coordinatorAdminState.teamSetupGuide = {
				groupId,
				displayName: String(result.group?.display_name || requestedDisplayName || ""),
				defaultSpaceScopeId,
				defaultSpaceLabel: String(defaultSpace?.label || ""),
				autoGrantDefaultSpaceOnJoin:
					typeof defaultSpacePreferences?.auto_grant_default_space_on_join === "boolean"
						? defaultSpacePreferences.auto_grant_default_space_on_join
						: null,
				setupWarning: result.setup_warning || null,
			};
			try {
				await reloadData();
				setAdminTargetGroup(groupId);
				await reloadData();
			} catch {
				showGlobalNotice(
					"Legacy coordinator group created, but coordinator data could not refresh. Check coordinator recovery status before retrying.",
					"warning",
				);
				return;
			}
			if (result.setup_warning) {
				showGlobalNotice(
					"Legacy coordinator group created, but default Space setup needs repair. Sharing policy is unchanged.",
					"warning",
				);
			} else if (defaultSpaceScopeId) {
				showGlobalNotice(
					"Legacy coordinator group created with a default Space. Sharing policy is unchanged.",
					"success",
				);
			} else {
				showGlobalNotice(
					"Legacy coordinator group created, but default Space status is unknown. Sharing policy is unchanged.",
					"warning",
				);
			}
		} catch {
			showGlobalNotice(
				"Could not create the legacy coordinator group. No Sharing policy or Project access changed; check coordinator recovery status and retry.",
				"warning",
			);
		} finally {
			coordinatorAdminState.groupActionPendingKind = "";
			renderShell();
		}
	}

	async function runGroupAction(
		groupId: string,
		displayName: string,
		kind: "rename" | "archive" | "unarchive",
	) {
		if (!requireFresh("status", "groups")) return;
		if (!groupId || coordinatorAdminState.groupActionPendingId) return;
		const requestedDisplayName = displayName.trim();
		if (kind === "rename" && !requestedDisplayName) {
			showGlobalNotice("Enter a legacy group display name before renaming it.", "warning");
			return;
		}
		const confirmationGroup = state.lastCoordinatorAdminGroups.find(
			(group) => group.group_id === groupId,
		);
		const target = coordinatorGroupPresentationName(groupId, confirmationGroup?.display_name);
		const confirmationTarget = currentAdminSnapshotTarget();
		const confirmed = await openSyncConfirmDialog({
			title:
				kind === "rename"
					? `Rename ${target}?`
					: `${kind === "archive" ? "Archive" : "Unarchive"} ${target}?`,
			description:
				kind === "rename"
					? `Target: ${target}. New name: ${requestedDisplayName}. This renames the technical coordinator group only. It does not rename a policy Team or change membership or Project access in Sharing.`
					: kind === "archive"
						? `Target: ${target}. The group stays visible and restorable, but coordinator presence, peer discovery, Space grants, legacy invites, and joins stop. Archiving also removes this group from this device's local coordinator configuration. Policy Team membership and Project access in Sharing are separate and unchanged.`
						: `Target: ${target}. This reactivates the remote coordinator group for devices still configured for it. It does not re-add this group to this device's local coordinator configuration; restore that separately before expecting coordinator presence or peer discovery here. It does not restore or change policy Team membership or Project access in Sharing.`,
			confirmLabel:
				kind === "rename"
					? "Rename coordinator group"
					: kind === "archive"
						? "Archive coordinator group"
						: "Unarchive coordinator group",
			cancelLabel:
				kind === "rename"
					? "Keep current group name"
					: kind === "archive"
						? "Keep group active"
						: "Keep group archived",
			tone: kind === "archive" ? "danger" : "default",
		});
		if (!confirmed) {
			return;
		}
		if (!adminSnapshotTargetMatchesCurrent(confirmationTarget)) {
			showGlobalNotice(
				"Coordinator group data changed while confirmation was open. Review the current group and try again.",
				"warning",
			);
			return;
		}
		if (!surfacesAreFresh(coordinatorAdminState.recovery, "status", "groups")) {
			showGlobalNotice(
				"Coordinator group data changed while confirmation was open. Review the current group and try again.",
				"warning",
			);
			return;
		}
		const currentGroup = state.lastCoordinatorAdminGroups.find(
			(group) => String(group.group_id || "") === groupId,
		);
		if (!currentGroup || coordinatorAdminState.groupActionPendingId) {
			showGlobalNotice(
				"Coordinator group data changed while confirmation was open. Review the current group and try again.",
				"warning",
			);
			return;
		}
		const currentDisplayName =
			coordinatorAdminState.groupRenameDrafts.get(groupId) ??
			String(currentGroup.display_name || "");
		coordinatorAdminState.groupActionPendingId = groupId;
		coordinatorAdminState.groupActionPendingKind = kind;
		renderShell();
		try {
			const completedAction =
				kind === "rename" ? "renamed" : kind === "archive" ? "archived" : "unarchived";
			if (kind === "rename") {
				await api.renameCoordinatorAdminGroup(groupId, currentDisplayName);
			}
			if (kind === "archive") {
				await api.archiveCoordinatorAdminGroup(groupId);
			}
			if (kind === "unarchive") {
				await api.unarchiveCoordinatorAdminGroup(groupId);
			}
			try {
				await reloadData();
			} catch {
				showGlobalNotice(
					`Legacy coordinator group ${completedAction}, but coordinator data could not refresh. Check coordinator recovery status before retrying.`,
					"warning",
				);
				return;
			}
			showGlobalNotice(
				kind === "rename"
					? "Legacy coordinator group renamed. Sharing Team names are unchanged."
					: kind === "archive"
						? "Legacy coordinator group archived. Sharing policy is unchanged."
						: "Legacy coordinator group unarchived. This device's local coordinator configuration and Sharing policy are unchanged.",
				"success",
			);
		} catch (cause) {
			if (isStaleGroupMutationError(cause)) {
				try {
					await reloadData();
					showGlobalNotice(
						"This legacy coordinator group changed or no longer exists. Coordinator groups were refreshed.",
						"warning",
					);
				} catch {
					showGlobalNotice(
						"This legacy coordinator group changed or no longer exists. Refresh coordinator groups before trying another action.",
						"warning",
					);
				}
			} else {
				showGlobalNotice(
					`Could not ${kind} the legacy coordinator group. Sharing policy is unchanged; check coordinator recovery status and retry.`,
					"warning",
				);
			}
		} finally {
			coordinatorAdminState.groupActionPendingId = "";
			coordinatorAdminState.groupActionPendingKind = "";
			renderShell();
		}
	}

	async function createInviteFromAdminPanel() {
		if (!requireFresh("status", "groups")) return;
		if (coordinatorAdminState.invitePending) return;
		const status = state.lastCoordinatorAdminStatus;
		const operationCoordinatorUrl = coordinatorUrlForMatching(status?.coordinator_url);
		const defaultGroup = currentAdminTargetGroup() || String(status?.active_group || "").trim();
		const groupId = coordinatorAdminState.inviteGroup.trim() || defaultGroup;
		const ttlHours = Number(coordinatorAdminState.inviteTtlHours);
		if (!groupId) {
			showGlobalNotice("Choose a coordinator group before creating a legacy invite.", "warning");
			return;
		}
		if (!Number.isFinite(ttlHours) || ttlHours < 1) {
			showGlobalNotice("Invite lifetime must be at least 1 hour.", "warning");
			return;
		}
		coordinatorAdminState.invitePending = true;
		renderShell();
		try {
			const result = await api.createCoordinatorInvite({
				group_id: groupId,
				policy: coordinatorAdminState.invitePolicy,
				ttl_hours: ttlHours,
			});
			const currentStatus = state.lastCoordinatorAdminStatus;
			const currentDefaultGroup =
				currentAdminTargetGroup() || String(currentStatus?.active_group || "").trim();
			const currentGroup = coordinatorAdminState.inviteGroup.trim() || currentDefaultGroup;
			if (
				coordinatorUrlForMatching(currentStatus?.coordinator_url) !== operationCoordinatorUrl ||
				currentGroup !== groupId
			) {
				return;
			}
			state.lastTeamInvite = result;
			coordinatorAdminState.inviteGroup = groupId;
			const warnings = Array.isArray(result.warnings) ? result.warnings : [];
			showGlobalNotice(
				warnings.length
					? `Invite created. Review ${warnings.length === 1 ? "the warning" : `${warnings.length} warnings`} before sharing it.`
					: "Legacy coordinator invite created. It does not grant Sharing Project access.",
				warnings.length ? "warning" : "success",
			);
		} catch (cause) {
			showGlobalNotice(safeInviteCreationError(cause), "warning");
		} finally {
			coordinatorAdminState.invitePending = false;
			renderShell();
		}
	}

	async function reviewJoinRequestFromAdminPanel(requestId: string, action: "approve" | "deny") {
		if (!adminSnapshotTargetMatchesCurrent(coordinatorAdminState.joinRequestsSnapshotTarget))
			return;
		if (!requireFresh("status", "joinRequests")) return;
		if (coordinatorAdminState.joinReviewPendingId) return;
		const operationTarget = coordinatorAdminState.joinRequestsSnapshotTarget;
		coordinatorAdminState.joinReviewPendingId = requestId;
		coordinatorAdminState.joinReviewPendingAction = action;
		renderShell();
		try {
			const result = (await api.reviewCoordinatorAdminJoinRequest(requestId, action)) as {
				setup_warning?: { step?: string; error?: string } | null;
			};
			if (!adminSnapshotTargetMatchesCurrent(operationTarget)) return;
			try {
				await reloadData();
			} catch {
				showGlobalNotice(
					`Join request ${action === "approve" ? "approved" : "denied"}, but pending requests could not refresh. Check coordinator recovery status before reviewing another request.`,
					"warning",
				);
				return;
			}
			if (action === "approve" && result.setup_warning) {
				showGlobalNotice(
					"Join request approved, but default Space access needs repair.",
					"warning",
				);
			} else {
				showGlobalNotice(
					action === "approve" ? "Join request approved." : "Join request denied.",
					"success",
				);
			}
		} catch (cause) {
			if (!adminSnapshotTargetMatchesCurrent(operationTarget)) return;
			if (isMissingJoinRequestError(cause)) {
				try {
					await reloadData();
					showGlobalNotice(
						"This legacy coordinator join request no longer exists. Pending requests were refreshed.",
						"warning",
					);
				} catch {
					showGlobalNotice(
						"This legacy coordinator join request no longer exists. Refresh pending requests before reviewing another request.",
						"warning",
					);
				}
			} else {
				showGlobalNotice(
					"Could not review the legacy coordinator join request. Sharing policy is unchanged; check coordinator recovery status and retry.",
					"warning",
				);
			}
		} finally {
			coordinatorAdminState.joinReviewPendingId = "";
			coordinatorAdminState.joinReviewPendingAction = "";
			renderShell();
		}
	}

	async function runDeviceAction(
		deviceId: string,
		groupId: string,
		displayName: string,
		kind: "rename" | "disable" | "enable" | "remove",
	) {
		if (!adminSnapshotTargetMatchesCurrent(coordinatorAdminState.devicesSnapshotTarget)) return;
		if (!requireFresh("status", "devices")) return;
		if (!deviceId || coordinatorAdminState.deviceActionPendingId) return;
		if (kind === "disable" || kind === "remove") {
			const confirmationTarget = currentAdminSnapshotTarget();
			const confirmed = await openSyncConfirmDialog({
				title: `${kind === "disable" ? "Disable" : "Remove"} ${displayName || "this device"}?`,
				description:
					kind === "disable"
						? "This device will stay enrolled but can no longer participate until you re-enable it."
						: "This removes the enrolled device record from the coordinator. The teammate would need a fresh invite or re-enrollment path to come back.",
				confirmLabel: kind === "disable" ? "Disable device" : "Remove device",
				cancelLabel: kind === "disable" ? "Keep device enabled" : "Keep device enrolled",
				tone: "danger",
			});
			if (!confirmed) return;
			if (!adminSnapshotTargetMatchesCurrent(confirmationTarget)) {
				showGlobalNotice(
					"Coordinator device data changed while confirmation was open. Review the current device and try again.",
					"warning",
				);
				return;
			}
			if (!surfacesAreFresh(coordinatorAdminState.recovery, "status", "devices")) {
				showGlobalNotice(
					"Coordinator device data changed while confirmation was open. Review the current device and try again.",
					"warning",
				);
				return;
			}
			const currentDevice = state.lastCoordinatorAdminDevices.find(
				(device) =>
					String(device.device_id || "") === deviceId && String(device.group_id || "") === groupId,
			);
			if (!currentDevice || coordinatorAdminState.deviceActionPendingId) {
				showGlobalNotice(
					"Coordinator device data changed while confirmation was open. Review the current device and try again.",
					"warning",
				);
				return;
			}
		}
		coordinatorAdminState.deviceActionPendingId = deviceId;
		coordinatorAdminState.deviceActionPendingKind = kind;
		renderShell();
		try {
			const completedAction =
				kind === "rename"
					? "renamed"
					: kind === "disable"
						? "disabled"
						: kind === "enable"
							? "enabled"
							: "removed";
			if (kind === "rename") {
				const nextName = String(
					coordinatorAdminState.deviceRenameDrafts.get(deviceId) || "",
				).trim();
				if (!nextName) {
					showGlobalNotice("Enter a device name before renaming it.", "warning");
					return;
				}
				await api.renameCoordinatorAdminDevice(deviceId, groupId, nextName);
			}
			if (kind === "disable") {
				await api.disableCoordinatorAdminDevice(deviceId, groupId);
			}
			if (kind === "enable") {
				await api.enableCoordinatorAdminDevice(deviceId, groupId);
			}
			if (kind === "remove") {
				await api.removeCoordinatorAdminDevice(deviceId, groupId);
			}
			try {
				await reloadData();
			} catch {
				showGlobalNotice(
					`Device ${completedAction}, but coordinator data could not refresh. Check coordinator recovery status before retrying.`,
					"warning",
				);
				return;
			}
			showGlobalNotice(`Device ${completedAction}.`, "success");
		} catch (error) {
			const knownRenameError =
				kind === "rename" && error instanceof Error
					? DEVICE_RENAME_ERROR_MESSAGES.get(error.message.trim())
					: undefined;
			if (isMissingDeviceError(error)) {
				try {
					await reloadData();
					showGlobalNotice(
						"This legacy coordinator device no longer exists. Enrolled devices were refreshed.",
						"warning",
					);
				} catch {
					showGlobalNotice(
						"This legacy coordinator device no longer exists. Refresh enrolled devices before trying another action.",
						"warning",
					);
				}
			} else {
				showGlobalNotice(
					knownRenameError ||
						`Could not ${kind} the legacy coordinator device. Sharing policy is unchanged; check coordinator recovery status and retry.`,
					"warning",
				);
			}
		} finally {
			coordinatorAdminState.deviceActionPendingId = "";
			coordinatorAdminState.deviceActionPendingKind = "";
			renderShell();
		}
	}

	return {
		createGroupFromAdminPanel,
		runGroupAction,
		createInviteFromAdminPanel,
		reviewJoinRequestFromAdminPanel,
		runDeviceAction,
	};
}
