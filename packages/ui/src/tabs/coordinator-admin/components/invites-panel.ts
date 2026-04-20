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
	createInvite: () => void;
	renderShell: () => void;
}

export function renderInvitesPanel(deps: InvitesPanelDeps) {
	const { summary, createInvite, renderShell } = deps;
	const status = state.lastCoordinatorAdminStatus;
	const activeGroup = currentAdminTargetGroup() || String(status?.active_group || "").trim();
	const effectiveGroup = coordinatorAdminState.inviteGroup.trim() || activeGroup;
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
						coordinatorAdminState.inviteGroup = String(
							(event.currentTarget as HTMLInputElement).value || "",
						);
					},
					placeholder: activeGroup || "team-alpha",
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
					disabled: summary.readiness !== "ready",
					id: "coordinatorAdminInvitePolicy",
					itemClassName: "sync-radix-select-item",
					onValueChange: (value) => {
						coordinatorAdminState.invitePolicy =
							value === "approval_required" ? "approval_required" : "auto_admit";
						renderShell();
					},
					options: [
						{ value: "auto_admit", label: "Auto-admit" },
						{ value: "approval_required", label: "Approval required" },
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
					disabled: summary.readiness !== "ready",
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
					disabled: summary.readiness !== "ready" || coordinatorAdminState.invitePending,
					onClick: () => {
						createInvite();
					},
					type: "button",
				},
				coordinatorAdminState.invitePending ? "Creating…" : "Create invite",
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
