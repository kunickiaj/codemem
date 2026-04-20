import { h, render } from "preact";
import { RadixSwitch } from "../components/primitives/radix-switch";
import { RadixTabs, RadixTabsContent } from "../components/primitives/radix-tabs";
import { TextInput } from "../components/primitives/text-input";
import * as api from "../lib/api";
import { state } from "../lib/state";
import { renderInvitesPanel } from "./coordinator-admin/components/invites-panel";
import { createCoordinatorAdminActions } from "./coordinator-admin/data/actions";
import { type AdminSection, coordinatorAdminState } from "./coordinator-admin/data/state";
import { coordinatorAdminSummary } from "./coordinator-admin/data/summary";
import {
	availableCoordinatorGroups,
	currentAdminTargetGroup,
	currentAdminTargetGroupRecord,
	reconcileDeviceRenameDrafts,
	reconcileGroupRenameDrafts,
	resolveAdminTargetGroup,
	setAdminTargetGroup,
} from "./coordinator-admin/data/target-group";

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

function renderGroupsPanel(summary: ReturnType<typeof coordinatorAdminSummary>) {
	const configuredGroup = String(state.lastCoordinatorAdminStatus?.active_group || "").trim();
	const selectedGroup = currentAdminTargetGroup();
	const groups = availableCoordinatorGroups();
	const activeGroups = groups.filter((group) => !group.archived_at);
	const archivedGroups = groups.filter((group) => group.archived_at);
	const visibleGroups = coordinatorAdminState.showArchivedGroups ? groups : activeGroups;
	const targetExists = selectedGroup
		? groups.some((group) => group.group_id === selectedGroup)
		: false;
	const countParts = [`${activeGroups.length} active`];
	if (archivedGroups.length) countParts.push(`${archivedGroups.length} archived`);
	return h(
		RadixTabsContent,
		{ className: "coordinator-admin-panel", value: "groups" },
		h("h3", null, "Groups"),
		h(
			"p",
			{ class: "peer-submeta" },
			selectedGroup
				? `Managing ${selectedGroup}${configuredGroup && configuredGroup !== selectedGroup ? ` · this node uses ${configuredGroup} for discovery` : ""}`
				: configuredGroup
					? `This node uses ${configuredGroup} for discovery. Select a group below to manage it.`
					: "No group selected yet. Create one or select an existing group to manage.",
		),
		groups.length ? h("p", { class: "peer-submeta" }, countParts.join(" · ")) : null,
		!targetExists && selectedGroup
			? h(
					"div",
					{ class: "peer-meta coordinator-admin-inline-warning" },
					`The selected admin target group (${selectedGroup}) is configured locally but does not exist in the coordinator yet. Create it below or switch to another group once one exists.`,
				)
			: null,
		h(
			"div",
			{ class: "coordinator-admin-form-grid" },
			h(
				"label",
				{ class: "coordinator-admin-field" },
				h("span", null, "New group id"),
				h(TextInput, {
					class: "peer-scope-input",
					disabled:
						summary.readiness !== "ready" ||
						coordinatorAdminState.groupActionPendingKind === "create",
					onInput: (event) => {
						coordinatorAdminState.createGroupId = String(
							(event.currentTarget as HTMLInputElement).value || "",
						);
					},
					placeholder: "team-alpha",
					type: "text",
					value: coordinatorAdminState.createGroupId,
				}),
			),
			h(
				"label",
				{ class: "coordinator-admin-field" },
				h("span", null, "Display name"),
				h(TextInput, {
					class: "peer-scope-input",
					disabled:
						summary.readiness !== "ready" ||
						coordinatorAdminState.groupActionPendingKind === "create",
					onInput: (event) => {
						coordinatorAdminState.createGroupDisplayName = String(
							(event.currentTarget as HTMLInputElement).value || "",
						);
					},
					placeholder: "Team Alpha",
					type: "text",
					value: coordinatorAdminState.createGroupDisplayName,
				}),
			),
		),
		h(
			"div",
			{ class: "section-actions coordinator-admin-groups-toolbar" },
			h(
				"div",
				{ class: "coordinator-admin-primary-actions" },
				h(
					"button",
					{
						class: "settings-button",
						disabled:
							summary.readiness !== "ready" ||
							coordinatorAdminState.groupActionPendingKind === "create",
						onClick: () => void createGroupFromAdminPanel(),
						type: "button",
					},
					coordinatorAdminState.groupActionPendingKind === "create" ? "Creating…" : "Create group",
				),
			),
			h(
				"div",
				{ class: "coordinator-admin-secondary-actions" },
				h(
					"label",
					{ class: "coordinator-admin-inline-filter" },
					h(
						"span",
						{ class: "section-meta", id: "coordinatorAdminShowArchivedLabel" },
						"Show archived",
					),
					h(RadixSwitch, {
						"aria-labelledby": "coordinatorAdminShowArchivedLabel",
						checked: coordinatorAdminState.showArchivedGroups,
						className: "coordinator-admin-switch",
						disabled: summary.readiness !== "ready",
						onCheckedChange: (checked) => {
							coordinatorAdminState.showArchivedGroups = checked;
							renderShell();
						},
						thumbClassName: "coordinator-admin-switch-thumb",
					}),
				),
			),
		),
		!visibleGroups.length
			? h(
					"div",
					{ class: "peer-meta coordinator-admin-empty-state" },
					summary.readiness === "ready"
						? coordinatorAdminState.showArchivedGroups
							? "No coordinator groups are available yet."
							: "No active groups yet. Create one to get started."
						: "Group browsing will appear here once setup is complete.",
				)
			: h(
					"div",
					{ class: "coordinator-admin-request-list" },
					visibleGroups.map((group) => {
						const selected = group.group_id === selectedGroup;
						const pending = coordinatorAdminState.groupActionPendingId === group.group_id;
						const archived = Boolean(group.archived_at);
						const draftName =
							coordinatorAdminState.groupRenameDrafts.get(group.group_id) ??
							group.display_name ??
							group.group_id;
						return h(
							"div",
							{ class: "peer-card", key: group.group_id },
							h("div", { class: "peer-title" }, h("strong", null, draftName)),
							h("div", { class: "peer-meta" }, `Group ID: ${group.group_id}`),
							h("div", { class: "peer-submeta" }, archived ? "Archived" : "Active"),
							configuredGroup === group.group_id
								? h(
										"div",
										{ class: "peer-submeta" },
										"This node is configured to use this group for coordinator-backed discovery.",
									)
								: null,
							h(
								"label",
								{ class: "coordinator-admin-field" },
								h("span", null, "Display name"),
								h(TextInput, {
									class: "peer-scope-input",
									disabled: summary.readiness !== "ready" || pending,
									onInput: (event) => {
										coordinatorAdminState.groupRenameDrafts.set(
											group.group_id,
											String((event.currentTarget as HTMLInputElement).value || ""),
										);
									},
									type: "text",
									value: draftName,
								}),
							),
							h(
								"div",
								{ class: "peer-actions" },
								h(
									"button",
									{
										class: "settings-button",
										disabled: summary.readiness !== "ready" || selected,
										onClick: () => {
											setAdminTargetGroup(group.group_id);
											void loadCoordinatorAdminData();
										},
										type: "button",
									},
									selected ? "Managing" : "Manage",
								),
								h(
									"button",
									{
										disabled: summary.readiness !== "ready" || pending,
										onClick: () => void runGroupAction(group.group_id, draftName, "rename"),
										type: "button",
									},
									pending && coordinatorAdminState.groupActionPendingKind === "rename"
										? "Renaming…"
										: "Rename",
								),
								h(
									"button",
									{
										class: archived ? undefined : "danger",
										disabled: summary.readiness !== "ready" || pending,
										onClick: () =>
											void runGroupAction(
												group.group_id,
												group.display_name || group.group_id,
												archived ? "unarchive" : "archive",
											),
										type: "button",
									},
									pending &&
										coordinatorAdminState.groupActionPendingKind ===
											(archived ? "unarchive" : "archive")
										? archived
											? "Restoring…"
											: "Archiving…"
										: archived
											? "Unarchive"
											: "Archive",
								),
							),
						);
					}),
				),
	);
}

function renderJoinRequestsPanel(summary: ReturnType<typeof coordinatorAdminSummary>) {
	const items = Array.isArray(state.lastCoordinatorAdminJoinRequests)
		? state.lastCoordinatorAdminJoinRequests
		: [];
	return h(
		RadixTabsContent,
		{ className: "coordinator-admin-panel", value: "join-requests" },
		h("h3", null, "Pending join requests"),
		h(
			"p",
			{ class: "peer-submeta" },
			summary.readiness === "ready"
				? "Approve or deny teammate join requests from the dedicated operator surface instead of burying them in Sync."
				: "Finish setup first. Join request review stays disabled until coordinator admin is ready.",
		),
		!items.length
			? h(
					"div",
					{ class: "peer-meta" },
					summary.readiness === "ready"
						? "No pending join requests right now."
						: "Join request review will appear here once setup is complete.",
				)
			: h(
					"div",
					{ class: "coordinator-admin-request-list" },
					items.map((item) => {
						const requestId = String(item.request_id || "").trim();
						const deviceId = String(item.device_id || "unknown-device");
						const displayName = String(item.display_name || deviceId);
						const pending = coordinatorAdminState.joinReviewPendingId === requestId;
						return h(
							"div",
							{ class: "peer-card", key: requestId || deviceId },
							h("div", { class: "peer-title" }, h("strong", null, displayName)),
							h("div", { class: "peer-meta" }, `Device: ${deviceId}`),
							h(
								"div",
								{ class: "peer-actions" },
								h(
									"button",
									{
										disabled: !requestId || pending,
										onClick: () => void reviewJoinRequestFromAdminPanel(requestId, "approve"),
										type: "button",
									},
									pending && coordinatorAdminState.joinReviewPendingAction === "approve"
										? "Approving…"
										: "Approve",
								),
								h(
									"button",
									{
										class: "danger",
										disabled: !requestId || pending,
										onClick: () => void reviewJoinRequestFromAdminPanel(requestId, "deny"),
										type: "button",
									},
									pending && coordinatorAdminState.joinReviewPendingAction === "deny"
										? "Denying…"
										: "Deny",
								),
							),
						);
					}),
				),
	);
}

function renderDevicesPanel(summary: ReturnType<typeof coordinatorAdminSummary>) {
	const items = Array.isArray(state.lastCoordinatorAdminDevices)
		? state.lastCoordinatorAdminDevices
		: [];
	return h(
		RadixTabsContent,
		{ className: "coordinator-admin-panel", value: "devices" },
		h("h3", null, "Enrolled devices"),
		h(
			"p",
			{ class: "peer-submeta" },
			summary.readiness === "ready"
				? "Rename, disable, re-enable, or remove enrolled devices from the operator surface without confusing this with direct sync state."
				: "Finish setup first. Device administration stays disabled until coordinator admin is ready.",
		),
		!items.length
			? h(
					"div",
					{ class: "peer-meta" },
					summary.readiness === "ready"
						? "No enrolled devices found for the active coordinator group."
						: "Device administration will appear here once setup is complete.",
				)
			: h(
					"div",
					{ class: "coordinator-admin-request-list" },
					items.map((item) => {
						const deviceId = String(item.device_id || "").trim();
						const groupId = String(
							item.group_id || state.lastCoordinatorAdminStatus?.active_group || "",
						).trim();
						const displayName = String(item.display_name || deviceId || "Unnamed device");
						const pending = coordinatorAdminState.deviceActionPendingId === deviceId;
						const draft =
							coordinatorAdminState.deviceRenameDrafts.get(deviceId) ??
							String(item.display_name || "");
						const enabled = item.enabled !== false && item.enabled !== 0;
						return h(
							"div",
							{ class: "peer-card", key: deviceId || String(item.fingerprint || "unknown") },
							h("div", { class: "peer-title" }, h("strong", null, draft || displayName)),
							h("div", { class: "peer-meta" }, `Device: ${deviceId || "unknown"}`),
							groupId ? h("div", { class: "peer-submeta" }, `Group: ${groupId}`) : null,
							h("div", { class: "peer-submeta" }, enabled ? "Enabled" : "Disabled"),
							h(
								"div",
								{ class: "coordinator-admin-form-grid" },
								h(
									"label",
									{ class: "coordinator-admin-field" },
									h("span", null, "Display name"),
									h(TextInput, {
										class: "peer-scope-input",
										disabled: summary.readiness !== "ready" || pending,
										onInput: (event) => {
											coordinatorAdminState.deviceRenameDrafts.set(
												deviceId,
												String((event.currentTarget as HTMLInputElement).value || ""),
											);
										},
										type: "text",
										value: draft,
									}),
								),
							),
							h(
								"div",
								{ class: "peer-actions" },
								h(
									"button",
									{
										class: "settings-button",
										disabled: !deviceId || pending || summary.readiness !== "ready",
										onClick: () => void runDeviceAction(deviceId, groupId, displayName, "rename"),
										type: "button",
									},
									pending && coordinatorAdminState.deviceActionPendingKind === "rename"
										? "Renaming…"
										: "Rename",
								),
								enabled
									? h(
											"button",
											{
												class: "settings-button danger",
												disabled: !deviceId || pending || summary.readiness !== "ready",
												onClick: () =>
													void runDeviceAction(deviceId, groupId, displayName, "disable"),
												type: "button",
											},
											pending && coordinatorAdminState.deviceActionPendingKind === "disable"
												? "Disabling…"
												: "Disable",
										)
									: h(
											"button",
											{
												class: "settings-button",
												disabled: !deviceId || pending || summary.readiness !== "ready",
												onClick: () =>
													void runDeviceAction(deviceId, groupId, displayName, "enable"),
												type: "button",
											},
											pending && coordinatorAdminState.deviceActionPendingKind === "enable"
												? "Enabling…"
												: "Enable",
										),
								h(
									"button",
									{
										class: "settings-button danger",
										disabled: !deviceId || pending || summary.readiness !== "ready",
										onClick: () => void runDeviceAction(deviceId, groupId, displayName, "remove"),
										type: "button",
									},
									pending && coordinatorAdminState.deviceActionPendingKind === "remove"
										? "Removing…"
										: "Remove",
								),
							),
						);
					}),
				),
	);
}

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
					renderGroupsPanel(summary),
					renderInvitesPanel({
						summary,
						createInvite: () => void createInviteFromAdminPanel(),
						renderShell,
					}),
					renderJoinRequestsPanel(summary),
					renderDevicesPanel(summary),
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
