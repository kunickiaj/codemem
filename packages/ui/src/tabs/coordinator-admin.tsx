import { h, render } from "preact";
import { RadixSelect } from "../components/primitives/radix-select";
import { RadixTabs, RadixTabsContent } from "../components/primitives/radix-tabs";
import * as api from "../lib/api";
import { showGlobalNotice } from "../lib/notice";
import { state } from "../lib/state";

type AdminSection = "overview" | "invites" | "join-requests" | "devices";

let activeSection: AdminSection = "overview";
let inviteGroup = "";
let inviteTtlHours = "24";
let invitePolicy: "auto_admit" | "approval_required" = "auto_admit";
let invitePending = false;

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

function renderShell() {
	const mount = document.getElementById("coordinatorAdminMount");
	if (!mount) return;
	const status = state.lastCoordinatorAdminStatus;
	const summary = coordinatorAdminSummary();
	const groups = Array.isArray(status?.groups) ? status.groups.filter(Boolean) : [];
	const coordinatorUrl = String(status?.coordinator_url || "").trim();
	const activeGroup = String(status?.active_group || "").trim();
	const invitesEnabled = summary.readiness === "ready";
	if (
		activeSection !== "overview" &&
		!invitesEnabled &&
		activeSection !== "join-requests" &&
		activeSection !== "devices"
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
							{ value: "join-requests", label: "Join requests", disabled: true },
							{ value: "devices", label: "Devices", disabled: true },
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
					h(
						RadixTabsContent,
						{ className: "coordinator-admin-panel", forceMount: true, value: "join-requests" },
						h("h3", null, "Join request tools land in the next slice"),
						h(
							"p",
							{ class: "peer-submeta" },
							"This shell is intentionally separating the operator control plane before the review workflow lands.",
						),
					),
					h(
						RadixTabsContent,
						{ className: "coordinator-admin-panel", forceMount: true, value: "devices" },
						h("h3", null, "Device admin tools land in the next slice"),
						h(
							"p",
							{ class: "peer-submeta" },
							"Device management will live here once the tab shell and invite workflow settle.",
						),
					),
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
	}
	renderShell();
}
