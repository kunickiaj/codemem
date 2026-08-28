/* Coordinator-admin tab lifecycle — owns the shell render, public init
 * entrypoint, and the data loader that fans out to the viewer admin
 * endpoints (status, groups, join requests, devices). Actions come from
 * the createCoordinatorAdminActions factory wired with renderShell +
 * loadCoordinatorAdminData closures. */

import { Fragment, h, render } from "preact";
import { RadixTabs } from "../../components/primitives/radix-tabs";
import * as api from "../../lib/api";
import { state } from "../../lib/state";
import { renderDevicesPanel } from "./components/devices-panel";
import { renderGroupsPanel } from "./components/groups-panel";
import { renderInvitesPanel } from "./components/invites-panel";
import { renderJoinRequestsPanel } from "./components/join-requests-panel";
import { createCoordinatorAdminActions } from "./data/actions";
import { stableDeviceDisplayNames, stableUnnamedDeviceAliases } from "./data/device-card";
import {
	beginSurfaceRefresh,
	completeSurfaceRefresh,
	coordinatorAdminRecoveryNotice,
	failSurfaceRefresh,
	markSurfaceNotApplicable,
	surfaceHasSnapshot,
	surfaceIsNotApplicable,
	surfacesAreFresh,
} from "./data/recovery";
import {
	type AdminSection,
	beginCoordinatorAdminLoadGeneration,
	coordinatorAdminState,
	isCurrentCoordinatorAdminLoadGeneration,
} from "./data/state";
import { refreshCoordinatorAdminStatusForGeneration } from "./data/status-refresh";
import { coordinatorAdminSummary } from "./data/summary";
import {
	adminSnapshotTargetMatchesCurrent,
	availableCoordinatorGroups,
	currentAdminSnapshotTarget,
	currentAdminTargetGroup,
	currentAdminTargetGroupRecord,
	reconcileDeviceRenameDrafts,
	reconcileGroupRenameDrafts,
	resolveAdminTargetGroup,
} from "./data/target-group";

const {
	createGroupFromAdminPanel,
	runGroupAction,
	createInviteFromAdminPanel,
	reviewJoinRequestFromAdminPanel,
	runDeviceAction,
} = createCoordinatorAdminActions({
	renderShell: () => renderShell(),
	reloadData: () => loadCoordinatorAdminData(),
});

function renderShell() {
	const mount = document.getElementById("coordinatorAdminMount");
	if (!mount) return;
	const status = state.lastCoordinatorAdminStatus;
	const summary = coordinatorAdminSummary();
	const coordinatorUrl = String(status?.coordinator_url || "").trim();
	const activeGroup = String(status?.active_group || "").trim();
	const targetGroupRecord = currentAdminTargetGroupRecord();
	const targetArchived = Boolean(targetGroupRecord?.archived_at);
	const groupsFresh = surfacesAreFresh(coordinatorAdminState.recovery, "status", "groups");
	const invitesFresh = groupsFresh && !targetArchived;
	const joinRequestsMatchTarget = adminSnapshotTargetMatchesCurrent(
		coordinatorAdminState.joinRequestsSnapshotTarget,
	);
	const devicesMatchTarget = adminSnapshotTargetMatchesCurrent(
		coordinatorAdminState.devicesSnapshotTarget,
	);
	const joinRequestsFresh =
		surfacesAreFresh(coordinatorAdminState.recovery, "status", "joinRequests") &&
		joinRequestsMatchTarget;
	const devicesFresh =
		surfacesAreFresh(coordinatorAdminState.recovery, "status", "devices") && devicesMatchTarget;
	const targetGroup = currentAdminTargetGroup();
	const activeGroupCount = availableCoordinatorGroups().filter(
		(group) => !group.archived_at,
	).length;
	const archivedGroupCount = availableCoordinatorGroups().filter(
		(group) => group.archived_at,
	).length;
	const joinRequestCount =
		joinRequestsMatchTarget && Array.isArray(state.lastCoordinatorAdminJoinRequests)
			? state.lastCoordinatorAdminJoinRequests.length
			: 0;
	const deviceCount =
		devicesMatchTarget && Array.isArray(state.lastCoordinatorAdminDevices)
			? state.lastCoordinatorAdminDevices.length
			: 0;
	const headerMessage =
		summary.readiness !== "ready"
			? summary.detail
			: targetArchived
				? "The selected coordinator group is archived. Restore it or switch groups before creating legacy invites."
				: "";
	const recoveryNotice = coordinatorAdminRecoveryNotice(coordinatorAdminState.recovery);
	const statusKnown = surfaceHasSnapshot(coordinatorAdminState.recovery, "status");
	const groupsKnown = surfaceHasSnapshot(coordinatorAdminState.recovery, "groups");
	const joinRequestsKnown =
		joinRequestsMatchTarget && surfaceHasSnapshot(coordinatorAdminState.recovery, "joinRequests");
	const devicesKnown =
		devicesMatchTarget && surfaceHasSnapshot(coordinatorAdminState.recovery, "devices");
	const groupsNotApplicable = surfaceIsNotApplicable(coordinatorAdminState.recovery, "groups");
	const joinsNotApplicable = surfaceIsNotApplicable(coordinatorAdminState.recovery, "joinRequests");
	const devicesNotApplicable = surfaceIsNotApplicable(coordinatorAdminState.recovery, "devices");
	render(
		h(
			"div",
			{ class: "coordinator-admin-shell" },
			h(
				"div",
				{ class: "card coordinator-admin-header" },
				h("div", { class: "section-header" }, h("h2", null, "Legacy coordinator administration")),
				h(
					"div",
					{
						"aria-atomic": "true",
						"aria-live": "polite",
						class: recoveryNotice
							? "coordinator-admin-inline-warning coordinator-admin-recovery-notice"
							: coordinatorAdminState.recoveryAnnouncement
								? "peer-meta coordinator-admin-recovery-status"
								: "coordinator-admin-recovery-status",
						id: "coordinatorAdminRecoveryStatus",
						role: "status",
						tabIndex: -1,
					},
					recoveryNotice
						? h(
								Fragment,
								null,
								h(
									"div",
									{ class: "coordinator-admin-legacy-notice-copy" },
									h("h3", null, "Advanced coordinator data needs attention"),
									coordinatorAdminState.recoveryAnnouncement
										? h("p", { class: "peer-submeta" }, coordinatorAdminState.recoveryAnnouncement)
										: null,
									recoveryNotice.stale.length
										? h(
												"p",
												{ class: "peer-submeta" },
												`Stale: ${recoveryNotice.stale.join(", ")}. Previously loaded data is still shown.`,
											)
										: null,
									recoveryNotice.unavailable.length
										? h(
												"p",
												{ class: "peer-submeta" },
												`Unavailable: ${recoveryNotice.unavailable.join(", ")}. No current data is shown for ${recoveryNotice.unavailable.length === 1 ? "that surface" : "those surfaces"}.`,
											)
										: null,
									h(
										"p",
										{ class: "peer-submeta" },
										"Actions that depend on current coordinator data are disabled. This does not mean coordinator data was deleted.",
									),
								),
								h(
									"button",
									{
										class: "settings-button",
										disabled: recoveryNotice.retrying,
										onClick: () => {
											coordinatorAdminState.recoveryAnnouncement = "Retrying coordinator data…";
											coordinatorAdminState.recoveryRetryRequested = true;
											void loadCoordinatorAdminData();
										},
										type: "button",
									},
									recoveryNotice.retrying ? "Retrying…" : "Retry",
								),
							)
						: coordinatorAdminState.recoveryAnnouncement,
				),
				h(
					"div",
					{ class: "coordinator-admin-summary-grid" },
					h(
						"div",
						{ class: "coordinator-admin-summary-card" },
						h("span", { class: "section-meta" }, "Coordinator group target"),
						h(
							"strong",
							null,
							statusKnown || groupsKnown ? targetGroup || "None selected" : "Unavailable",
						),
					),
					h(
						"div",
						{ class: "coordinator-admin-summary-card" },
						h("span", { class: "section-meta" }, "Node discovery group"),
						h("strong", null, statusKnown ? activeGroup || "None" : "Unavailable"),
					),
					h(
						"div",
						{ class: "coordinator-admin-summary-card" },
						h("span", { class: "section-meta" }, "Coordinator groups"),
						h(
							"strong",
							null,
							groupsKnown
								? `${activeGroupCount} active${archivedGroupCount ? ` · ${archivedGroupCount} archived` : ""}`
								: groupsNotApplicable
									? "Setup required"
									: "Unavailable",
						),
					),
					h(
						"div",
						{ class: "coordinator-admin-summary-card" },
						h("span", { class: "section-meta" }, "Selected group activity"),
						h(
							"strong",
							null,
							`${joinRequestsKnown ? joinRequestCount : joinsNotApplicable ? "Setup required" : "Unavailable"} join requests · ${devicesKnown ? deviceCount : devicesNotApplicable ? "Setup required" : "Unavailable"} devices`,
						),
					),
				),
				headerMessage
					? h("div", { class: "peer-meta coordinator-admin-inline-warning" }, headerMessage)
					: null,
				coordinatorUrl
					? h(
							"div",
							{ class: "section-meta coordinator-admin-inline-meta" },
							`Coordinator: ${coordinatorUrl}`,
						)
					: null,
			),
			h(
				"div",
				{ class: "card coordinator-admin-sections" },
				h(
					RadixTabs,
					{
						ariaLabel: "Legacy coordinator administration sections",
						listClassName: "coordinator-admin-tabs-list",
						onValueChange: (value) => {
							coordinatorAdminState.activeSection = (value as AdminSection) || "groups";
							renderShell();
						},
						tabs: [
							{ value: "groups", label: "Coordinator groups" },
							{ value: "invites", label: "Invites" },
							{ value: "join-requests", label: "Join requests" },
							{ value: "devices", label: "Devices" },
						],
						triggerClassName: "coordinator-admin-tab-trigger",
						value: coordinatorAdminState.activeSection,
					},
					renderGroupsPanel({
						summary,
						fresh: groupsFresh,
						createGroup: () => void createGroupFromAdminPanel(),
						runGroup: (groupId, displayName, kind) =>
							void runGroupAction(groupId, displayName, kind),
						renderShell,
						reloadData: () => void loadCoordinatorAdminData(),
					}),
					renderInvitesPanel({
						summary,
						fresh: invitesFresh,
						createInvite: () => void createInviteFromAdminPanel(),
						renderShell,
					}),
					renderJoinRequestsPanel({
						summary,
						fresh: joinRequestsFresh,
						snapshotMatchesTarget: joinRequestsMatchTarget,
						reviewJoinRequest: (requestId, action) =>
							void reviewJoinRequestFromAdminPanel(requestId, action),
					}),
					renderDevicesPanel({
						summary,
						fresh: devicesFresh,
						snapshotMatchesTarget: devicesMatchTarget,
						runDevice: (deviceId, groupId, displayName, kind) =>
							void runDeviceAction(deviceId, groupId, displayName, kind),
					}),
				),
				h(
					"div",
					{ class: "section-meta coordinator-admin-context-line" },
					targetArchived
						? "The selected coordinator group is archived. Switch or restore it to enable legacy invite operations."
						: targetGroup
							? "Actions below apply to the selected coordinator group."
							: "Select a coordinator group to manage legacy enrollment and Spaces.",
				),
			),
		),
		mount,
	);
	if (coordinatorAdminState.recoveryFocusPending) {
		coordinatorAdminState.recoveryFocusPending = false;
		queueMicrotask(() => document.getElementById("coordinatorAdminRecoveryStatus")?.focus());
	}
}

export function initCoordinatorAdminTab() {
	renderShell();
}

export async function loadCoordinatorAdminData() {
	const generation = beginCoordinatorAdminLoadGeneration();
	const isCurrent = () => isCurrentCoordinatorAdminLoadGeneration(generation);
	if (!coordinatorAdminState.recoveryRetryRequested) {
		coordinatorAdminState.recoveryAnnouncement = "";
	}
	beginSurfaceRefresh(coordinatorAdminState.recovery, "status");
	beginSurfaceRefresh(coordinatorAdminState.recovery, "groups");
	beginSurfaceRefresh(coordinatorAdminState.recovery, "joinRequests");
	beginSurfaceRefresh(coordinatorAdminState.recovery, "devices");
	renderShell();
	const statusResult = await refreshCoordinatorAdminStatusForGeneration(generation);
	if (statusResult === "superseded") return;
	const activeGroup = String(state.lastCoordinatorAdminStatus?.active_group || "").trim();
	resolveAdminTargetGroup();
	if (
		state.lastCoordinatorAdminStatus?.readiness === "ready" &&
		surfacesAreFresh(coordinatorAdminState.recovery, "status")
	) {
		try {
			const payload = await api.loadShareOperations();
			if (!isCurrent()) return;
			state.lastShareOperations = Array.isArray(payload.items) ? payload.items : [];
		} catch {
			if (!isCurrent()) return;
			// Keep the previous read-only reflection; Coordinator Administration remains usable.
		}
		try {
			const groupsPayload = (await api.loadCoordinatorAdminGroupsFiltered(
				coordinatorAdminState.showArchivedGroups,
			)) as {
				items?: typeof state.lastCoordinatorAdminGroups;
			};
			if (!isCurrent()) return;
			if (!Array.isArray(groupsPayload?.items)) throw new Error("Invalid groups payload");
			state.lastCoordinatorAdminGroups = groupsPayload.items;
			completeSurfaceRefresh(coordinatorAdminState.recovery, "groups");
			reconcileGroupRenameDrafts();
			resolveAdminTargetGroup();
		} catch {
			if (!isCurrent()) return;
			failSurfaceRefresh(coordinatorAdminState.recovery, "groups");
		}
		const targetGroup = currentAdminTargetGroup();
		const snapshotTarget = currentAdminSnapshotTarget();
		try {
			if (!snapshotTarget) throw new Error("Missing coordinator administration target");
			const payload = (await api.loadCoordinatorAdminJoinRequests(targetGroup || activeGroup)) as {
				items?: typeof state.lastCoordinatorAdminJoinRequests;
			};
			if (!isCurrent()) return;
			if (!Array.isArray(payload?.items)) throw new Error("Invalid join requests payload");
			state.lastCoordinatorAdminJoinRequests = payload.items;
			coordinatorAdminState.joinRequestsSnapshotTarget = snapshotTarget;
			completeSurfaceRefresh(coordinatorAdminState.recovery, "joinRequests");
		} catch {
			if (!isCurrent()) return;
			failSurfaceRefresh(
				coordinatorAdminState.recovery,
				"joinRequests",
				adminSnapshotTargetMatchesCurrent(coordinatorAdminState.joinRequestsSnapshotTarget),
			);
		}
		try {
			if (!snapshotTarget) throw new Error("Missing coordinator administration target");
			const devicesPayload = (await api.loadCoordinatorAdminDevices(
				targetGroup || activeGroup,
				true,
			)) as {
				items?: typeof state.lastCoordinatorAdminDevices;
			};
			if (!isCurrent()) return;
			if (!Array.isArray(devicesPayload?.items)) throw new Error("Invalid devices payload");
			state.lastCoordinatorAdminDevices = devicesPayload.items;
			coordinatorAdminState.devicesSnapshotTarget = snapshotTarget;
			completeSurfaceRefresh(coordinatorAdminState.recovery, "devices");
			reconcileDeviceRenameDrafts();
		} catch {
			if (!isCurrent()) return;
			failSurfaceRefresh(
				coordinatorAdminState.recovery,
				"devices",
				adminSnapshotTargetMatchesCurrent(coordinatorAdminState.devicesSnapshotTarget),
			);
		}
		try {
			const projects = await api.loadProjects();
			if (!isCurrent()) return;
			coordinatorAdminState.availableProjects = projects;
		} catch {
			if (!isCurrent()) return;
			// Non-fatal — picker falls back to free-text entry.
		}
	} else if (coordinatorAdminState.recovery.status.availability === "fresh") {
		markSurfaceNotApplicable(coordinatorAdminState.recovery, "groups");
		markSurfaceNotApplicable(coordinatorAdminState.recovery, "joinRequests");
		markSurfaceNotApplicable(coordinatorAdminState.recovery, "devices");
		coordinatorAdminState.joinRequestsSnapshotTarget = null;
		coordinatorAdminState.devicesSnapshotTarget = null;
	} else {
		failSurfaceRefresh(coordinatorAdminState.recovery, "groups");
		failSurfaceRefresh(
			coordinatorAdminState.recovery,
			"joinRequests",
			adminSnapshotTargetMatchesCurrent(coordinatorAdminState.joinRequestsSnapshotTarget),
		);
		failSurfaceRefresh(
			coordinatorAdminState.recovery,
			"devices",
			adminSnapshotTargetMatchesCurrent(coordinatorAdminState.devicesSnapshotTarget),
		);
	}
	if (!isCurrent()) return;
	stableUnnamedDeviceAliases(
		[
			...state.lastCoordinatorAdminDevices,
			...state.lastCoordinatorAdminJoinRequests.map((item) => ({
				device_id:
					String(item.device_id || "").trim() ||
					`join-request:${String(item.request_id || "").trim()}`,
				display_name: item.display_name,
			})),
		],
		coordinatorAdminState.unnamedDeviceAliases,
	);
	stableDeviceDisplayNames(
		state.lastCoordinatorAdminDevices,
		coordinatorAdminState.unnamedDeviceAliases,
	);
	if (coordinatorAdminState.recoveryRetryRequested) {
		coordinatorAdminState.recoveryAnnouncement = coordinatorAdminRecoveryNotice(
			coordinatorAdminState.recovery,
		)
			? "Retry finished, but some coordinator data still needs attention. Retained data remains unchanged."
			: state.lastCoordinatorAdminStatus?.readiness === "ready"
				? "Coordinator data refreshed. Current data is available."
				: "Coordinator status refreshed. Complete setup to load administration data.";
		coordinatorAdminState.recoveryFocusPending = true;
	}
	coordinatorAdminState.recoveryRetryRequested = false;
	renderShell();
}
