/* Coordinator-admin tab lifecycle — owns the shell render, public init
 * entrypoint, and the data loader that fans out to the viewer admin
 * endpoints (status, groups, join requests, devices). Actions come from
 * the createCoordinatorAdminActions factory wired with renderShell +
 * loadCoordinatorAdminData closures. */

import { h, render } from "preact";
import { RadixTabs } from "../../components/primitives/radix-tabs";
import * as api from "../../lib/api";
import { state } from "../../lib/state";
import { renderDevicesPanel } from "./components/devices-panel";
import { renderGroupsPanel } from "./components/groups-panel";
import { renderInvitesPanel } from "./components/invites-panel";
import { renderJoinRequestsPanel } from "./components/join-requests-panel";
import { createCoordinatorAdminActions } from "./data/actions";
import { type AdminSection, coordinatorAdminState } from "./data/state";
import { coordinatorAdminSummary } from "./data/summary";
import {
	availableCoordinatorGroups,
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
	const groupsEnabled = summary.readiness === "ready";
	const invitesEnabled = summary.readiness === "ready" && !targetArchived;
	const joinRequestsEnabled = summary.readiness === "ready";
	const devicesEnabled = summary.readiness === "ready";
	const targetGroup = currentAdminTargetGroup();
	const activeGroupCount = availableCoordinatorGroups().filter(
		(group) => !group.archived_at,
	).length;
	const archivedGroupCount = availableCoordinatorGroups().filter(
		(group) => group.archived_at,
	).length;
	const joinRequestCount = Array.isArray(state.lastCoordinatorAdminJoinRequests)
		? state.lastCoordinatorAdminJoinRequests.length
		: 0;
	const deviceCount = Array.isArray(state.lastCoordinatorAdminDevices)
		? state.lastCoordinatorAdminDevices.length
		: 0;
	const headerMessage =
		summary.readiness !== "ready"
			? summary.detail
			: targetArchived
				? "The selected admin target group is archived. Restore it or switch groups before creating invites."
				: "";
	if (
		(coordinatorAdminState.activeSection === "invites" && !invitesEnabled) ||
		(coordinatorAdminState.activeSection === "groups" && !groupsEnabled) ||
		(coordinatorAdminState.activeSection === "join-requests" && !joinRequestsEnabled) ||
		(coordinatorAdminState.activeSection === "devices" && !devicesEnabled)
	) {
		coordinatorAdminState.activeSection = summary.readiness === "ready" ? "groups" : "invites";
	}

	render(
		h(
			"div",
			{ class: "coordinator-admin-shell" },
			h(
				"div",
				{ class: "card coordinator-admin-header" },
				h("div", { class: "section-header" }, h("h2", null, "Coordinator Admin")),
				h(
					"div",
					{ class: "coordinator-admin-summary-grid" },
					h(
						"div",
						{ class: "coordinator-admin-summary-card" },
						h("span", { class: "section-meta" }, "Admin target"),
						h("strong", null, targetGroup || "None selected"),
					),
					h(
						"div",
						{ class: "coordinator-admin-summary-card" },
						h("span", { class: "section-meta" }, "Node discovery group"),
						h("strong", null, activeGroup || "None"),
					),
					h(
						"div",
						{ class: "coordinator-admin-summary-card" },
						h("span", { class: "section-meta" }, "Groups"),
						h(
							"strong",
							null,
							`${activeGroupCount} active${archivedGroupCount ? ` · ${archivedGroupCount} archived` : ""}`,
						),
					),
					h(
						"div",
						{ class: "coordinator-admin-summary-card" },
						h("span", { class: "section-meta" }, "Selected group activity"),
						h("strong", null, `${joinRequestCount} join requests · ${deviceCount} devices`),
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
						ariaLabel: "Coordinator admin sections",
						listClassName: "coordinator-admin-tabs-list",
						onValueChange: (value) => {
							coordinatorAdminState.activeSection = (value as AdminSection) || "groups";
							renderShell();
						},
						tabs: [
							{ value: "groups", label: "Groups", disabled: !groupsEnabled },
							{ value: "invites", label: "Invites", disabled: !invitesEnabled },
							{ value: "join-requests", label: "Join requests", disabled: !joinRequestsEnabled },
							{ value: "devices", label: "Devices", disabled: !devicesEnabled },
						],
						triggerClassName: "coordinator-admin-tab-trigger",
						value: coordinatorAdminState.activeSection,
					},
					renderGroupsPanel({
						summary,
						createGroup: () => void createGroupFromAdminPanel(),
						runGroup: (groupId, displayName, kind) =>
							void runGroupAction(groupId, displayName, kind),
						renderShell,
						reloadData: () => void loadCoordinatorAdminData(),
					}),
					renderInvitesPanel({
						summary,
						createInvite: () => void createInviteFromAdminPanel(),
						renderShell,
					}),
					renderJoinRequestsPanel({
						summary,
						reviewJoinRequest: (requestId, action) =>
							void reviewJoinRequestFromAdminPanel(requestId, action),
					}),
					renderDevicesPanel({
						summary,
						runDevice: (deviceId, groupId, displayName, kind) =>
							void runDeviceAction(deviceId, groupId, displayName, kind),
					}),
				),
				h(
					"div",
					{ class: "section-meta coordinator-admin-context-line" },
					targetArchived
						? `Selected group ${targetGroup || "—"} is archived. Switch or restore it to enable invite operations.`
						: targetGroup
							? `Actions below apply to ${targetGroup}.`
							: "Select a group to start managing coordinator state.",
				),
			),
		),
		mount,
	);
}

export function initCoordinatorAdminTab() {
	renderShell();
}

export async function loadCoordinatorAdminData() {
	try {
		state.lastCoordinatorAdminStatus =
			(await api.loadCoordinatorAdminStatus()) as typeof state.lastCoordinatorAdminStatus;
	} catch {
		state.lastCoordinatorAdminStatus = null;
		state.lastCoordinatorAdminJoinRequests = [];
		state.lastCoordinatorAdminDevices = [];
		coordinatorAdminState.deviceRenameDrafts.clear();
		renderShell();
		return;
	}
	const activeGroup = String(state.lastCoordinatorAdminStatus?.active_group || "").trim();
	resolveAdminTargetGroup();
	if (state.lastCoordinatorAdminStatus?.readiness === "ready") {
		try {
			const groupsPayload = (await api.loadCoordinatorAdminGroupsFiltered(
				coordinatorAdminState.showArchivedGroups,
			)) as {
				items?: typeof state.lastCoordinatorAdminGroups;
			};
			state.lastCoordinatorAdminGroups = Array.isArray(groupsPayload?.items)
				? groupsPayload.items
				: [];
			reconcileGroupRenameDrafts();
			resolveAdminTargetGroup();
		} catch {
			state.lastCoordinatorAdminGroups = [];
			coordinatorAdminState.groupRenameDrafts.clear();
		}
		const targetGroup = currentAdminTargetGroup();
		try {
			const payload = (await api.loadCoordinatorAdminJoinRequests(targetGroup || activeGroup)) as {
				items?: typeof state.lastCoordinatorAdminJoinRequests;
			};
			state.lastCoordinatorAdminJoinRequests = Array.isArray(payload?.items) ? payload.items : [];
		} catch {
			state.lastCoordinatorAdminJoinRequests = [];
		}
		try {
			const devicesPayload = (await api.loadCoordinatorAdminDevices(
				targetGroup || activeGroup,
				true,
			)) as {
				items?: typeof state.lastCoordinatorAdminDevices;
			};
			state.lastCoordinatorAdminDevices = Array.isArray(devicesPayload?.items)
				? devicesPayload.items
				: [];
			reconcileDeviceRenameDrafts();
		} catch {
			state.lastCoordinatorAdminDevices = [];
			coordinatorAdminState.deviceRenameDrafts.clear();
		}
	} else {
		state.lastCoordinatorAdminGroups = [];
		coordinatorAdminState.groupRenameDrafts.clear();
		state.lastCoordinatorAdminJoinRequests = [];
		state.lastCoordinatorAdminDevices = [];
		coordinatorAdminState.deviceRenameDrafts.clear();
	}
	renderShell();
}
