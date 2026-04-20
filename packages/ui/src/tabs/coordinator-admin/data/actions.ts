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
import { coordinatorAdminState } from "./state";
import { currentAdminTargetGroup } from "./target-group";

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

	async function createGroupFromAdminPanel() {
		if (coordinatorAdminState.groupActionPendingKind) return;
		const groupId = coordinatorAdminState.createGroupId.trim();
		if (!groupId) {
			showGlobalNotice("Enter a group id before creating a group.", "warning");
			return;
		}
		coordinatorAdminState.groupActionPendingKind = "create";
		renderShell();
		try {
			await api.createCoordinatorAdminGroup({
				group_id: groupId,
				display_name: coordinatorAdminState.createGroupDisplayName.trim() || null,
			});
			coordinatorAdminState.createGroupId = "";
			coordinatorAdminState.createGroupDisplayName = "";
			showGlobalNotice("Group created.", "success");
			await reloadData();
		} catch (error) {
			showGlobalNotice(
				error instanceof Error ? error.message : "Failed to create group.",
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
		if (!groupId || coordinatorAdminState.groupActionPendingId) return;
		if (
			(kind === "archive" || kind === "unarchive") &&
			!(await openSyncConfirmDialog({
				title: `${kind === "archive" ? "Archive" : "Unarchive"} ${displayName || groupId}?`,
				description:
					kind === "archive"
						? "Archived groups stay visible and restorable, but they stop being operational for new invites and joins."
						: "This group will become operational again for invites and coordinator-backed joins.",
				confirmLabel: kind === "archive" ? "Archive group" : "Unarchive group",
				cancelLabel: kind === "archive" ? "Keep group active" : "Keep group archived",
				tone: "danger",
			}))
		) {
			return;
		}
		coordinatorAdminState.groupActionPendingId = groupId;
		coordinatorAdminState.groupActionPendingKind = kind;
		renderShell();
		try {
			if (kind === "rename") {
				await api.renameCoordinatorAdminGroup(groupId, displayName);
				showGlobalNotice("Group renamed.", "success");
			}
			if (kind === "archive") {
				await api.archiveCoordinatorAdminGroup(groupId);
				showGlobalNotice("Group archived.", "success");
			}
			if (kind === "unarchive") {
				await api.unarchiveCoordinatorAdminGroup(groupId);
				showGlobalNotice("Group unarchived.", "success");
			}
			await reloadData();
		} catch (error) {
			showGlobalNotice(
				error instanceof Error ? error.message : `Failed to ${kind} group.`,
				"warning",
			);
		} finally {
			coordinatorAdminState.groupActionPendingId = "";
			coordinatorAdminState.groupActionPendingKind = "";
			renderShell();
		}
	}

	async function createInviteFromAdminPanel() {
		if (coordinatorAdminState.invitePending) return;
		const status = state.lastCoordinatorAdminStatus;
		const defaultGroup = currentAdminTargetGroup() || String(status?.active_group || "").trim();
		const groupId = coordinatorAdminState.inviteGroup.trim() || defaultGroup;
		const ttlHours = Number(coordinatorAdminState.inviteTtlHours);
		if (!groupId) {
			showGlobalNotice("Choose a coordinator group before creating an invite.", "warning");
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
			state.lastTeamInvite = result;
			coordinatorAdminState.inviteGroup = groupId;
			const warnings = Array.isArray(result.warnings) ? result.warnings : [];
			showGlobalNotice(
				warnings.length
					? `Invite created. Review ${warnings.length === 1 ? "the warning" : `${warnings.length} warnings`} before sharing it.`
					: "Invite created. Copy it from Coordinator Admin and share it with your teammate.",
				warnings.length ? "warning" : "success",
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to create invite.";
			showGlobalNotice(message, "warning");
		} finally {
			coordinatorAdminState.invitePending = false;
			renderShell();
		}
	}

	async function reviewJoinRequestFromAdminPanel(requestId: string, action: "approve" | "deny") {
		if (coordinatorAdminState.joinReviewPendingId) return;
		coordinatorAdminState.joinReviewPendingId = requestId;
		coordinatorAdminState.joinReviewPendingAction = action;
		renderShell();
		try {
			await api.reviewCoordinatorAdminJoinRequest(requestId, action);
			showGlobalNotice(
				action === "approve" ? "Join request approved." : "Join request denied.",
				"success",
			);
			await reloadData();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to review join request.";
			showGlobalNotice(message, "warning");
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
		if (!deviceId || coordinatorAdminState.deviceActionPendingId) return;
		if (
			(kind === "disable" || kind === "remove") &&
			!(await openSyncConfirmDialog({
				title: `${kind === "disable" ? "Disable" : "Remove"} ${displayName || deviceId}?`,
				description:
					kind === "disable"
						? "This device will stay enrolled but can no longer participate until you re-enable it."
						: "This removes the enrolled device record from the coordinator. The teammate would need a fresh invite or re-enrollment path to come back.",
				confirmLabel: kind === "disable" ? "Disable device" : "Remove device",
				cancelLabel: kind === "disable" ? "Keep device enabled" : "Keep device enrolled",
				tone: "danger",
			}))
		) {
			return;
		}
		coordinatorAdminState.deviceActionPendingId = deviceId;
		coordinatorAdminState.deviceActionPendingKind = kind;
		renderShell();
		try {
			if (kind === "rename") {
				const nextName = String(
					coordinatorAdminState.deviceRenameDrafts.get(deviceId) || "",
				).trim();
				if (!nextName) {
					showGlobalNotice("Enter a device name before renaming it.", "warning");
					return;
				}
				await api.renameCoordinatorAdminDevice(deviceId, groupId, nextName);
				showGlobalNotice("Device renamed.", "success");
			}
			if (kind === "disable") {
				await api.disableCoordinatorAdminDevice(deviceId, groupId);
				showGlobalNotice("Device disabled.", "success");
			}
			if (kind === "enable") {
				await api.enableCoordinatorAdminDevice(deviceId, groupId);
				showGlobalNotice("Device enabled.", "success");
			}
			if (kind === "remove") {
				await api.removeCoordinatorAdminDevice(deviceId, groupId);
				showGlobalNotice("Device removed.", "success");
			}
			await reloadData();
		} catch (error) {
			const message = error instanceof Error ? error.message : `Failed to ${kind} device.`;
			showGlobalNotice(message, "warning");
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
