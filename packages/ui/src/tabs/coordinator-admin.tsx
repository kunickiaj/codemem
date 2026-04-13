import { h, render } from "preact";
import { RadixTabs, RadixTabsContent } from "../components/primitives/radix-tabs";
import * as api from "../lib/api";
import { state } from "../lib/state";

type AdminSection = "overview" | "invites" | "join-requests" | "devices";

let activeSection: AdminSection = "overview";

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

function renderShell() {
	const mount = document.getElementById("coordinatorAdminMount");
	if (!mount) return;
	const status = state.lastCoordinatorAdminStatus;
	const summary = coordinatorAdminSummary();
	const groups = Array.isArray(status?.groups) ? status.groups.filter(Boolean) : [];
	const coordinatorUrl = String(status?.coordinator_url || "").trim();
	const activeGroup = String(status?.active_group || "").trim();

	const disabledTabs = summary.readiness !== "ready";

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
							{ value: "invites", label: "Invites", disabled: disabledTabs },
							{ value: "join-requests", label: "Join requests", disabled: disabledTabs },
							{ value: "devices", label: "Devices", disabled: disabledTabs },
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
					["invites", "join-requests", "devices"].map((section) =>
						h(
							RadixTabsContent,
							{ className: "coordinator-admin-panel", forceMount: true, value: section },
							h(
								"h3",
								null,
								`${section === "join-requests" ? "Join request" : section.slice(0, 1).toUpperCase() + section.slice(1)} tools land in the next slice`,
							),
							h(
								"p",
								{ class: "peer-submeta" },
								summary.readiness === "ready"
									? "This shell is intentionally keeping the operator boundary and readiness UX honest before the real admin workflows land."
									: "Finish setup first. This panel stays disabled until the local coordinator admin configuration is ready.",
							),
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
