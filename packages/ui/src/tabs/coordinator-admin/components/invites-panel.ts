/* Coordinator-admin invites panel — renders the "Create teammate invite"
 * surface. Pulls invite form state from coordinatorAdminState and the
 * latest generated invite from `state.lastTeamInvite`. Takes the
 * `createInvite` callback and the shared `renderShell` as deps so the
 * RadixSelect onValueChange can trigger a re-render. */

import { h } from "preact";
import { RadixSelect } from "../../../components/primitives/radix-select";
import { RadixTabsContent } from "../../../components/primitives/radix-tabs";
import { TextArea } from "../../../components/primitives/text-area";
import { TextInput } from "../../../components/primitives/text-input";
import { copyToClipboard } from "../../../lib/dom";
import { state } from "../../../lib/state";
import { coordinatorAdminState } from "../data/state";
import type { CoordinatorAdminSummary } from "../data/summary";
import { currentAdminTargetGroup } from "../data/target-group";

export interface InvitesPanelDeps {
	summary: CoordinatorAdminSummary;
	fresh: boolean;
	createInvite: () => void;
	renderShell: () => void;
}

export function renderInvitesPanel(deps: InvitesPanelDeps) {
	const { summary, fresh, createInvite, renderShell } = deps;
	const status = state.lastCoordinatorAdminStatus;
	const activeGroup = currentAdminTargetGroup() || String(status?.active_group || "").trim();
	const effectiveGroup = coordinatorAdminState.inviteGroup.trim() || activeGroup;
	const output = String(state.lastTeamInvite?.encoded || "").trim();
	const warnings = Array.isArray(state.lastTeamInvite?.warnings)
		? state.lastTeamInvite?.warnings
		: [];
	const inviteDisabled = !fresh || coordinatorAdminState.invitePending;
	return h(
		RadixTabsContent,
		{ className: "coordinator-admin-panel", value: "invites" },
		h("h3", null, "Legacy coordinator invites"),
		h(
			"p",
			{ class: "peer-submeta" },
			fresh
				? "Legacy coordinator invites enroll a device in the selected group for discovery. They do not add policy Team membership or grant Project access; use Sharing for both."
				: summary.readiness === "ready"
					? "Legacy invite creation is disabled until current coordinator status and group data are available. Previously generated invites remain available to copy."
					: "Finish coordinator setup first. Legacy invite creation stays disabled until the local configuration is ready.",
		),
		h(
			"form",
			{
				class: "coordinator-admin-form",
				onSubmit: (event: Event) => {
					event.preventDefault();
					if (inviteDisabled) return;
					createInvite();
				},
			},
			h(
				"div",
				{ class: "coordinator-admin-form-grid" },
				h(
					"label",
					{ class: "coordinator-admin-field" },
					h("span", null, "Coordinator group"),
					h(TextInput, {
						class: "peer-scope-input",
						disabled: !fresh,
						onInput: (event) => {
							coordinatorAdminState.inviteGroup = String(
								(event.currentTarget as HTMLInputElement).value || "",
							);
							renderShell();
						},
						placeholder: activeGroup || "group-alpha",
						type: "text",
						value: coordinatorAdminState.inviteGroup,
					}),
				),
				h(
					"label",
					{ class: "coordinator-admin-field" },
					h("span", null, "Join policy"),
					h(RadixSelect, {
						ariaLabel: "Invite join policy",
						contentClassName: "sync-radix-select-content sync-actor-select-content",
						disabled: !fresh,
						id: "coordinatorAdminInvitePolicy",
						itemClassName: "sync-radix-select-item",
						onValueChange: (value) => {
							coordinatorAdminState.invitePolicy =
								value === "approval_required" ? "approval_required" : "auto_admit";
							renderShell();
						},
						options: [
							{ value: "auto_admit", label: "Auto-admit to coordinator group" },
							{ value: "approval_required", label: "Require approval to join group" },
						],
						triggerClassName: "sync-radix-select-trigger sync-actor-select",
						value: coordinatorAdminState.invitePolicy,
						viewportClassName: "sync-radix-select-viewport",
					}),
				),
				h(
					"label",
					{ class: "coordinator-admin-field" },
					h("span", null, "Expires in (hours)"),
					h(TextInput, {
						class: "peer-scope-input",
						disabled: !fresh,
						min: "1",
						onInput: (event) => {
							coordinatorAdminState.inviteTtlHours = String(
								(event.currentTarget as HTMLInputElement).value || "",
							);
						},
						type: "number",
						value: coordinatorAdminState.inviteTtlHours,
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
						disabled: inviteDisabled,
						type: "submit",
					},
					coordinatorAdminState.invitePending ? "Creating…" : "Create legacy coordinator invite",
				),
				effectiveGroup
					? h("span", { class: "peer-submeta" }, "Using the selected coordinator group")
					: null,
			),
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
		h("h3", null, "Project sharing operations"),
		h(
			"p",
			{ class: "peer-submeta" },
			"Read-only status from the project-first sharing flow. Start new sharing from Projects.",
		),
		state.lastShareOperations.length > 0
			? h(
					"ul",
					{ class: "peer-scope-rejections-list", "aria-label": "Project sharing operations" },
					...state.lastShareOperations.map((operation) =>
						h(
							"li",
							{ key: operation.operation_id },
							h("strong", null, operation.person.display_name),
							h(
								"span",
								null,
								` — ${operation.projects.map((project) => project.display_name).join(", ")} — ${operation.lifecycle.label}`,
							),
						),
					),
				)
			: h("div", { class: "peer-meta" }, "No project sharing operations yet."),
	);
}
