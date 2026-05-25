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
import { currentAdminTargetGroup, setAdminTargetGroup } from "./target-group";

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
			showGlobalNotice("Enter a Team id before creating a Team.", "warning");
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
				displayName: String(result.group?.display_name || requestedDisplayName || groupId),
				defaultSpaceScopeId,
				defaultSpaceLabel: String(defaultSpace?.label || ""),
				autoGrantDefaultSpaceOnJoin:
					typeof defaultSpacePreferences?.auto_grant_default_space_on_join === "boolean"
						? defaultSpacePreferences.auto_grant_default_space_on_join
						: null,
				setupWarning: result.setup_warning || null,
			};
			await reloadData();
			setAdminTargetGroup(groupId);
			await reloadData();
			if (result.setup_warning) {
				showGlobalNotice("Team created, but default Space setup needs repair.", "warning");
			} else if (defaultSpaceScopeId) {
				showGlobalNotice("Team created with a default Space.", "success");
			} else {
				showGlobalNotice("Team created, but default Space status is unknown.", "warning");
			}
		} catch (error) {
			showGlobalNotice(
				error instanceof Error ? error.message : "Failed to create Team.",
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
						? "Archived Teams stay visible and restorable, but they stop being operational for new invites and joins."
						: "This Team will become operational again for invites and coordinator-backed joins.",
				confirmLabel: kind === "archive" ? "Archive Team" : "Unarchive Team",
				cancelLabel: kind === "archive" ? "Keep Team active" : "Keep Team archived",
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
				showGlobalNotice("Team renamed.", "success");
			}
			if (kind === "archive") {
				await api.archiveCoordinatorAdminGroup(groupId);
				showGlobalNotice("Team archived.", "success");
			}
			if (kind === "unarchive") {
				await api.unarchiveCoordinatorAdminGroup(groupId);
				showGlobalNotice("Team unarchived.", "success");
			}
			await reloadData();
		} catch (error) {
			showGlobalNotice(
				error instanceof Error ? error.message : `Failed to ${kind} Team.`,
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
			showGlobalNotice("Choose a Team before creating an invite.", "warning");
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
					: "Invite created. Copy it from Teams and share it with your teammate.",
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
			const result = (await api.reviewCoordinatorAdminJoinRequest(requestId, action)) as {
				setup_warning?: { step?: string; error?: string } | null;
			};
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
