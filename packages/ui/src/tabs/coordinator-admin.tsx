import { h, render } from "preact";
import { RadixSelect } from "../components/primitives/radix-select";
import { RadixTabs, RadixTabsContent } from "../components/primitives/radix-tabs";
import * as api from "../lib/api";
import { showGlobalNotice } from "../lib/notice";
import { state } from "../lib/state";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

type AdminSection = "overview" | "invites" | "join-requests" | "devices";

let activeSection: AdminSection = "overview";
let inviteGroup = "";
let inviteTtlHours = "24";
let invitePolicy: "auto_admit" | "approval_required" = "auto_admit";
let invitePending = false;
let joinReviewPendingId = "";
let joinReviewPendingAction: "approve" | "deny" | "" = "";
let deviceActionPendingId = "";
let deviceActionPendingKind: "rename" | "disable" | "remove" | "" = "";
const deviceRenameDrafts = new Map<string, string>();

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

async function createInviteFromAdminPanel() {
	if (invitePending) return;
	const status = state.lastCoordinatorAdminStatus;
	const defaultGroup = String(status?.active_group || "").trim();
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
	const groups = Array.isArray(status?.groups) ? status.groups.filter(Boolean) : [];
	const activeGroup = String(status?.active_group || "").trim();
	const effectiveGroup = inviteGroup.trim() || activeGroup;
	const output = String(state.lastTeamInvite?.encoded || "").trim();
	const warnings = Array.isArray(state.lastTeamInvite?.warnings)
		? state.lastTeamInvite?.warnings
		: [];
	return h(
		RadixTabsContent,
		{ className: "coordinator-admin-panel", forceMount: true, value: "invites" },
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
				h("input", {
					class: "peer-scope-input",
					disabled: summary.readiness !== "ready",
					onInput: (event) => {
						inviteGroup = String((event.currentTarget as HTMLInputElement).value || "");
					},
					placeholder: activeGroup || "team-alpha",
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
				h("input", {
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
		groups.length
			? h("p", { class: "peer-submeta" }, `Available groups: ${groups.join(", ")}`)
			: null,
		output
			? h(
					"label",
					{ class: "coordinator-admin-field" },
					h("span", null, "Generated invite"),
					h("textarea", {
						class: "feed-search coordinator-admin-output",
						readOnly: true,
						value: output,
					}),
				)
			: null,
		warnings?.length
			? h("div", { class: "peer-meta coordinator-admin-warning-list" }, warnings.join(" · "))
			: null,
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
		{ className: "coordinator-admin-panel", forceMount: true, value: "join-requests" },
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
		{ className: "coordinator-admin-panel", forceMount: true, value: "devices" },
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
									h("input", {
										class: "peer-scope-input",
										disabled: summary.readiness !== "ready" || pending,
										onInput: (event) => {
											deviceRenameDrafts.set(
												deviceId,
												String((event.currentTarget as HTMLInputElement).value || ""),
											);
										},
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
										disabled: !deviceId || pending || summary.readiness !== "ready" || !enabled,
										onClick: () => void runDeviceAction(deviceId, groupId, displayName, "disable"),
										type: "button",
									},
									pending && deviceActionPendingKind === "disable" ? "Disabling…" : "Disable",
								),
								h(
									"button",
									{
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
	const groups = Array.isArray(status?.groups) ? status.groups.filter(Boolean) : [];
	const coordinatorUrl = String(status?.coordinator_url || "").trim();
	const activeGroup = String(status?.active_group || "").trim();
	const invitesEnabled = summary.readiness === "ready";
	const joinRequestsEnabled = summary.readiness === "ready";
	const devicesEnabled = summary.readiness === "ready";
	if (
		activeSection !== "overview" &&
		((activeSection === "invites" && !invitesEnabled) ||
			(activeSection === "join-requests" && !joinRequestsEnabled) ||
			(activeSection === "devices" && !devicesEnabled))
	) {
		activeSection = "overview";
	}

	render(
		h(
			"div",
			{ class: "coordinator-admin-shell" },
			h(
				"div",
				{ class: "card coordinator-admin-hero" },
				h("div", { class: "section-header" }, h("h2", null, "Coordinator Admin")),
				h("p", { class: "peer-meta" }, summary.title),
				h("p", { class: "peer-submeta" }, summary.detail),
				h(
					"dl",
					{ class: "coordinator-admin-meta-grid" },
					h("div", null, h("dt", null, "Readiness"), h("dd", null, summary.readiness)),
					h(
						"div",
						null,
						h("dt", null, "Coordinator URL"),
						h("dd", null, coordinatorUrl || "Not configured"),
					),
					h("div", null, h("dt", null, "Active group"), h("dd", null, activeGroup || "None")),
					h(
						"div",
						null,
						h("dt", null, "Admin secret"),
						h("dd", null, status?.has_admin_secret ? "Available locally" : "Missing"),
					),
				),
				groups.length
					? h("p", { class: "peer-submeta" }, `Configured groups: ${groups.join(", ")}`)
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
							activeSection = (value as AdminSection) || "overview";
							renderShell();
						},
						tabs: [
							{ value: "overview", label: "Overview" },
							{ value: "invites", label: "Invites", disabled: !invitesEnabled },
							{ value: "join-requests", label: "Join requests", disabled: !joinRequestsEnabled },
							{ value: "devices", label: "Devices", disabled: !devicesEnabled },
						],
						triggerClassName: "coordinator-admin-tab-trigger",
						value: activeSection,
					},
					h(
						RadixTabsContent,
						{ className: "coordinator-admin-panel", forceMount: true, value: "overview" },
						h("h3", null, "What lives here"),
						h(
							"ul",
							{ class: "coordinator-admin-list" },
							h("li", null, "Create teammate invites with clear policy choices."),
							h("li", null, "Review and approve or deny pending join requests."),
							h("li", null, "Manage enrolled devices without mixing admin state into Sync."),
						),
					),
					renderInvitesPanel(summary),
					renderJoinRequestsPanel(summary),
					renderDevicesPanel(summary),
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
	if (state.lastCoordinatorAdminStatus?.readiness === "ready") {
		try {
			const payload = (await api.loadCoordinatorAdminJoinRequests(activeGroup)) as {
				items?: typeof state.lastCoordinatorAdminJoinRequests;
			};
			state.lastCoordinatorAdminJoinRequests = Array.isArray(payload?.items) ? payload.items : [];
		} catch {
			state.lastCoordinatorAdminJoinRequests = [];
		}
		try {
			const devicesPayload = (await api.loadCoordinatorAdminDevices(activeGroup, true)) as {
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
		state.lastCoordinatorAdminJoinRequests = [];
		state.lastCoordinatorAdminDevices = [];
		deviceRenameDrafts.clear();
	}
	renderShell();
}
