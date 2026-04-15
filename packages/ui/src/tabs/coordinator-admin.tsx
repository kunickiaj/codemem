import { h, render } from "preact";
import { RadixSelect } from "../components/primitives/radix-select";
import { RadixSwitch } from "../components/primitives/radix-switch";
import { RadixTabs, RadixTabsContent } from "../components/primitives/radix-tabs";
import { TextArea } from "../components/primitives/text-area";
import { TextInput } from "../components/primitives/text-input";
import * as api from "../lib/api";
import { copyToClipboard } from "../lib/dom";
import { showGlobalNotice } from "../lib/notice";
import { state } from "../lib/state";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

type AdminSection = "groups" | "invites" | "join-requests" | "devices";

let activeSection: AdminSection = "groups";
let inviteGroup = "";
let inviteTtlHours = "24";
let invitePolicy: "auto_admit" | "approval_required" = "auto_admit";
let invitePending = false;
let showArchivedGroups = false;
let createGroupId = "";
let createGroupDisplayName = "";
let groupActionPendingId = "";
let groupActionPendingKind: "create" | "rename" | "archive" | "unarchive" | "" = "";
let joinReviewPendingId = "";
let joinReviewPendingAction: "approve" | "deny" | "" = "";
let deviceActionPendingId = "";
let deviceActionPendingKind: "rename" | "disable" | "remove" | "" = "";
const groupRenameDrafts = new Map<string, string>();
const deviceRenameDrafts = new Map<string, string>();
const ADMIN_TARGET_GROUP_KEY = "codemem-coordinator-admin-target-group";

function adminTargetStorageKey(coordinatorUrl: string | null | undefined): string {
	return `${ADMIN_TARGET_GROUP_KEY}:${String(coordinatorUrl || "").trim()}`;
}

function readStoredAdminTargetGroup(coordinatorUrl: string | null | undefined): string {
	try {
		return localStorage.getItem(adminTargetStorageKey(coordinatorUrl)) || "";
	} catch {
		return "";
	}
}

function writeStoredAdminTargetGroup(coordinatorUrl: string | null | undefined, groupId: string) {
	try {
		localStorage.setItem(adminTargetStorageKey(coordinatorUrl), groupId);
	} catch {
		// ignore storage errors
	}
}

function currentAdminTargetGroup(): string {
	return String(state.coordinatorAdminTargetGroup || "").trim();
}

function setAdminTargetGroup(groupId: string) {
	state.coordinatorAdminTargetGroup = groupId;
	writeStoredAdminTargetGroup(state.lastCoordinatorAdminStatus?.coordinator_url || null, groupId);
}

function availableCoordinatorGroups(): Array<{
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

function reconcileGroupRenameDrafts() {
	const next = new Map<string, string>();
	for (const group of availableCoordinatorGroups()) {
		next.set(group.group_id, group.display_name || group.group_id);
	}
	groupRenameDrafts.clear();
	for (const [groupId, name] of next.entries()) {
		groupRenameDrafts.set(groupId, name);
	}
}

function currentAdminTargetGroupRecord() {
	const target = currentAdminTargetGroup();
	return availableCoordinatorGroups().find((group) => group.group_id === target) || null;
}

function resolveAdminTargetGroup() {
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

function reconcileDeviceRenameDrafts() {
	const next = new Map<string, string>();
	const items = Array.isArray(state.lastCoordinatorAdminDevices)
		? state.lastCoordinatorAdminDevices
		: [];
	for (const item of items) {
		const deviceId = String(item.device_id || "").trim();
		if (!deviceId) continue;
		next.set(deviceId, String(item.display_name || ""));
	}
	deviceRenameDrafts.clear();
	for (const [deviceId, name] of next.entries()) {
		deviceRenameDrafts.set(deviceId, name);
	}
}

function coordinatorAdminSummary() {
	const status = state.lastCoordinatorAdminStatus;
	if (!status) {
		return {
			readiness: "partial",
			title: "Checking coordinator admin readiness…",
			detail: "Loading local coordinator admin configuration from the viewer server.",
		};
	}
	if (status.readiness === "ready") {
		return {
			readiness: "ready",
			title: "Coordinator admin is ready",
			detail:
				"This viewer can use the local admin configuration to manage invites, join requests, and enrolled devices without exposing the admin secret to the browser.",
		};
	}
	if (status.readiness === "partial") {
		return {
			readiness: "partial",
			title: "Coordinator admin setup is incomplete",
			detail:
				status.has_admin_secret === false
					? "Set a coordinator admin secret for the viewer server before using invite and device admin actions."
					: "Finish configuring the coordinator target and group before using admin actions.",
		};
	}
	return {
		readiness: "not_configured",
		title: "Coordinator admin is not configured",
		detail:
			"Set a coordinator URL, group, and admin secret locally to enable remote coordinator administration from this viewer.",
	};
}

async function createGroupFromAdminPanel() {
	if (groupActionPendingKind) return;
	const groupId = createGroupId.trim();
	if (!groupId) {
		showGlobalNotice("Enter a group id before creating a group.", "warning");
		return;
	}
	groupActionPendingKind = "create";
	renderShell();
	try {
		await api.createCoordinatorAdminGroup({
			group_id: groupId,
			display_name: createGroupDisplayName.trim() || null,
		});
		createGroupId = "";
		createGroupDisplayName = "";
		showGlobalNotice("Group created.", "success");
		await loadCoordinatorAdminData();
	} catch (error) {
		showGlobalNotice(error instanceof Error ? error.message : "Failed to create group.", "warning");
	} finally {
		groupActionPendingKind = "";
		renderShell();
	}
}

async function runGroupAction(
	groupId: string,
	displayName: string,
	kind: "rename" | "archive" | "unarchive",
) {
	if (!groupId || groupActionPendingId) return;
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
	groupActionPendingId = groupId;
	groupActionPendingKind = kind;
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
		await loadCoordinatorAdminData();
	} catch (error) {
		showGlobalNotice(
			error instanceof Error ? error.message : `Failed to ${kind} group.`,
			"warning",
		);
	} finally {
		groupActionPendingId = "";
		groupActionPendingKind = "";
		renderShell();
	}
}

async function createInviteFromAdminPanel() {
	if (invitePending) return;
	const status = state.lastCoordinatorAdminStatus;
	const defaultGroup = currentAdminTargetGroup() || String(status?.active_group || "").trim();
	const groupId = inviteGroup.trim() || defaultGroup;
	const ttlHours = Number(inviteTtlHours);
	if (!groupId) {
		showGlobalNotice("Choose a coordinator group before creating an invite.", "warning");
		return;
	}
	if (!Number.isFinite(ttlHours) || ttlHours < 1) {
		showGlobalNotice("Invite lifetime must be at least 1 hour.", "warning");
		return;
	}
	invitePending = true;
	renderShell();
	try {
		const result = await api.createCoordinatorInvite({
			group_id: groupId,
			policy: invitePolicy,
			ttl_hours: ttlHours,
		});
		state.lastTeamInvite = result;
		inviteGroup = groupId;
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
		invitePending = false;
		renderShell();
	}
}

function renderInvitesPanel(summary: ReturnType<typeof coordinatorAdminSummary>) {
	const status = state.lastCoordinatorAdminStatus;
	const activeGroup = currentAdminTargetGroup() || String(status?.active_group || "").trim();
	const effectiveGroup = inviteGroup.trim() || activeGroup;
	const output = String(state.lastTeamInvite?.encoded || "").trim();
	const warnings = Array.isArray(state.lastTeamInvite?.warnings)
		? state.lastTeamInvite?.warnings
		: [];
	return h(
		RadixTabsContent,
		{ className: "coordinator-admin-panel", value: "invites" },
		h("h3", null, "Create teammate invite"),
		h(
			"p",
			{ class: "peer-submeta" },
			summary.readiness === "ready"
				? "Generate a coordinator-backed invite from the same operator surface that will later handle join requests and device administration."
				: "Finish setup first. Invite creation stays disabled until the local coordinator admin configuration is ready.",
		),
		h(
			"div",
			{ class: "coordinator-admin-form-grid" },
			h(
				"label",
				{ class: "coordinator-admin-field" },
				h("span", null, "Group"),
				h(TextInput, {
					class: "peer-scope-input",
					disabled: summary.readiness !== "ready",
					onInput: (event) => {
						inviteGroup = String((event.currentTarget as HTMLInputElement).value || "");
					},
					placeholder: activeGroup || "team-alpha",
					type: "text",
					value: inviteGroup,
				}),
			),
			h(
				"label",
				{ class: "coordinator-admin-field" },
				h("span", null, "Join policy"),
				h(RadixSelect, {
					ariaLabel: "Invite join policy",
					contentClassName: "sync-radix-select-content sync-actor-select-content",
					disabled: summary.readiness !== "ready",
					id: "coordinatorAdminInvitePolicy",
					itemClassName: "sync-radix-select-item",
					onValueChange: (value) => {
						invitePolicy = value === "approval_required" ? "approval_required" : "auto_admit";
						renderShell();
					},
					options: [
						{ value: "auto_admit", label: "Auto-admit" },
						{ value: "approval_required", label: "Approval required" },
					],
					triggerClassName: "sync-radix-select-trigger sync-actor-select",
					value: invitePolicy,
					viewportClassName: "sync-radix-select-viewport",
				}),
			),
			h(
				"label",
				{ class: "coordinator-admin-field" },
				h("span", null, "Expires in (hours)"),
				h(TextInput, {
					class: "peer-scope-input",
					disabled: summary.readiness !== "ready",
					min: "1",
					onInput: (event) => {
						inviteTtlHours = String((event.currentTarget as HTMLInputElement).value || "");
					},
					type: "number",
					value: inviteTtlHours,
				}),
			),
		),
		h(
			"div",
			{ class: "section-actions" },
			h(
				"button",
				{
					class: "settings-button",
					disabled: summary.readiness !== "ready" || invitePending,
					onClick: () => {
						void createInviteFromAdminPanel();
					},
					type: "button",
				},
				invitePending ? "Creating…" : "Create invite",
			),
			effectiveGroup ? h("span", { class: "peer-submeta" }, `Using group ${effectiveGroup}`) : null,
		),
		output
			? h(
					"label",
					{ class: "coordinator-admin-field" },
					h("span", null, "Generated invite"),
					h(TextArea, {
						class: "feed-search coordinator-admin-output",
						readOnly: true,
						value: output,
					}),
					h(
						"button",
						{
							class: "settings-button sync-action-copy",
							type: "button",
							onClick: (event: MouseEvent) =>
								copyToClipboard(output, event.currentTarget as HTMLButtonElement),
						},
						"Copy",
					),
				)
			: null,
		warnings?.length
			? h("div", { class: "peer-meta coordinator-admin-warning-list" }, warnings.join(" · "))
			: null,
	);
}

function renderGroupsPanel(summary: ReturnType<typeof coordinatorAdminSummary>) {
	const configuredGroup = String(state.lastCoordinatorAdminStatus?.active_group || "").trim();
	const selectedGroup = currentAdminTargetGroup();
	const groups = availableCoordinatorGroups();
	const activeGroups = groups.filter((group) => !group.archived_at);
	const archivedGroups = groups.filter((group) => group.archived_at);
	const visibleGroups = showArchivedGroups ? groups : activeGroups;
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
					disabled: summary.readiness !== "ready" || groupActionPendingKind === "create",
					onInput: (event) => {
						createGroupId = String((event.currentTarget as HTMLInputElement).value || "");
					},
					placeholder: "team-alpha",
					type: "text",
					value: createGroupId,
				}),
			),
			h(
				"label",
				{ class: "coordinator-admin-field" },
				h("span", null, "Display name"),
				h(TextInput, {
					class: "peer-scope-input",
					disabled: summary.readiness !== "ready" || groupActionPendingKind === "create",
					onInput: (event) => {
						createGroupDisplayName = String((event.currentTarget as HTMLInputElement).value || "");
					},
					placeholder: "Team Alpha",
					type: "text",
					value: createGroupDisplayName,
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
						disabled: summary.readiness !== "ready" || groupActionPendingKind === "create",
						onClick: () => void createGroupFromAdminPanel(),
						type: "button",
					},
					groupActionPendingKind === "create" ? "Creating…" : "Create group",
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
						checked: showArchivedGroups,
						className: "coordinator-admin-switch",
						disabled: summary.readiness !== "ready",
						onCheckedChange: (checked) => {
							showArchivedGroups = checked;
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
						? showArchivedGroups
							? "No coordinator groups are available yet."
							: "No active groups yet. Create one to get started."
						: "Group browsing will appear here once setup is complete.",
				)
			: h(
					"div",
					{ class: "coordinator-admin-request-list" },
					visibleGroups.map((group) => {
						const selected = group.group_id === selectedGroup;
						const pending = groupActionPendingId === group.group_id;
						const archived = Boolean(group.archived_at);
						const draftName =
							groupRenameDrafts.get(group.group_id) ?? group.display_name ?? group.group_id;
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
										groupRenameDrafts.set(
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
									pending && groupActionPendingKind === "rename" ? "Renaming…" : "Rename",
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
									pending && groupActionPendingKind === (archived ? "unarchive" : "archive")
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

async function reviewJoinRequestFromAdminPanel(requestId: string, action: "approve" | "deny") {
	if (joinReviewPendingId) return;
	joinReviewPendingId = requestId;
	joinReviewPendingAction = action;
	renderShell();
	try {
		await api.reviewCoordinatorAdminJoinRequest(requestId, action);
		showGlobalNotice(
			action === "approve" ? "Join request approved." : "Join request denied.",
			"success",
		);
		await loadCoordinatorAdminData();
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to review join request.";
		showGlobalNotice(message, "warning");
	} finally {
		joinReviewPendingId = "";
		joinReviewPendingAction = "";
		renderShell();
	}
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
						const pending = joinReviewPendingId === requestId;
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
									pending && joinReviewPendingAction === "approve" ? "Approving…" : "Approve",
								),
								h(
									"button",
									{
										class: "danger",
										disabled: !requestId || pending,
										onClick: () => void reviewJoinRequestFromAdminPanel(requestId, "deny"),
										type: "button",
									},
									pending && joinReviewPendingAction === "deny" ? "Denying…" : "Deny",
								),
							),
						);
					}),
				),
	);
}

async function runDeviceAction(
	deviceId: string,
	groupId: string,
	displayName: string,
	kind: "rename" | "disable" | "remove",
) {
	if (!deviceId || deviceActionPendingId) return;
	if (
		(kind === "disable" || kind === "remove") &&
		!(await openSyncConfirmDialog({
			title: `${kind === "disable" ? "Disable" : "Remove"} ${displayName || deviceId}?`,
			description:
				kind === "disable"
					? "This device will stay enrolled but can no longer participate until you re-enable it from a future admin flow."
					: "This removes the enrolled device record from the coordinator. The teammate would need a fresh invite or re-enrollment path to come back.",
			confirmLabel: kind === "disable" ? "Disable device" : "Remove device",
			cancelLabel: kind === "disable" ? "Keep device enabled" : "Keep device enrolled",
			tone: "danger",
		}))
	) {
		return;
	}
	deviceActionPendingId = deviceId;
	deviceActionPendingKind = kind;
	renderShell();
	try {
		if (kind === "rename") {
			const nextName = String(deviceRenameDrafts.get(deviceId) || "").trim();
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
		if (kind === "remove") {
			await api.removeCoordinatorAdminDevice(deviceId, groupId);
			showGlobalNotice("Device removed.", "success");
		}
		await loadCoordinatorAdminData();
	} catch (error) {
		const message = error instanceof Error ? error.message : `Failed to ${kind} device.`;
		showGlobalNotice(message, "warning");
	} finally {
		deviceActionPendingId = "";
		deviceActionPendingKind = "";
		renderShell();
	}
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
				? "Rename, disable, or remove enrolled devices from the operator surface without confusing this with direct sync state."
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
						const pending = deviceActionPendingId === deviceId;
						const draft = deviceRenameDrafts.get(deviceId) ?? String(item.display_name || "");
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
											deviceRenameDrafts.set(
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
										disabled: !deviceId || pending || summary.readiness !== "ready",
										onClick: () => void runDeviceAction(deviceId, groupId, displayName, "rename"),
										type: "button",
									},
									pending && deviceActionPendingKind === "rename" ? "Renaming…" : "Rename",
								),
								h(
									"button",
									{
										class: "danger",
										disabled: !deviceId || pending || summary.readiness !== "ready" || !enabled,
										onClick: () => void runDeviceAction(deviceId, groupId, displayName, "disable"),
										type: "button",
									},
									pending && deviceActionPendingKind === "disable" ? "Disabling…" : "Disable",
								),
								h(
									"button",
									{
										class: "danger",
										disabled: !deviceId || pending || summary.readiness !== "ready",
										onClick: () => void runDeviceAction(deviceId, groupId, displayName, "remove"),
										type: "button",
									},
									pending && deviceActionPendingKind === "remove" ? "Removing…" : "Remove",
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
		(activeSection === "invites" && !invitesEnabled) ||
		(activeSection === "groups" && !groupsEnabled) ||
		(activeSection === "join-requests" && !joinRequestsEnabled) ||
		(activeSection === "devices" && !devicesEnabled)
	) {
		activeSection = summary.readiness === "ready" ? "groups" : "invites";
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
							activeSection = (value as AdminSection) || "groups";
							renderShell();
						},
						tabs: [
							{ value: "groups", label: "Groups", disabled: !groupsEnabled },
							{ value: "invites", label: "Invites", disabled: !invitesEnabled },
							{ value: "join-requests", label: "Join requests", disabled: !joinRequestsEnabled },
							{ value: "devices", label: "Devices", disabled: !devicesEnabled },
						],
						triggerClassName: "coordinator-admin-tab-trigger",
						value: activeSection,
					},
					renderGroupsPanel(summary),
					renderInvitesPanel(summary),
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
		deviceRenameDrafts.clear();
		renderShell();
		return;
	}
	const activeGroup = String(state.lastCoordinatorAdminStatus?.active_group || "").trim();
	resolveAdminTargetGroup();
	if (state.lastCoordinatorAdminStatus?.readiness === "ready") {
		try {
			const groupsPayload = (await api.loadCoordinatorAdminGroupsFiltered(showArchivedGroups)) as {
				items?: typeof state.lastCoordinatorAdminGroups;
			};
			state.lastCoordinatorAdminGroups = Array.isArray(groupsPayload?.items)
				? groupsPayload.items
				: [];
			reconcileGroupRenameDrafts();
			resolveAdminTargetGroup();
		} catch {
			state.lastCoordinatorAdminGroups = [];
			groupRenameDrafts.clear();
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
			deviceRenameDrafts.clear();
		}
	} else {
		state.lastCoordinatorAdminGroups = [];
		groupRenameDrafts.clear();
		state.lastCoordinatorAdminJoinRequests = [];
		state.lastCoordinatorAdminDevices = [];
		deviceRenameDrafts.clear();
	}
	renderShell();
}
