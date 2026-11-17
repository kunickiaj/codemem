/* Coordinator-admin invites panel. New invitations are created in Sharing, so
 * this panel hands off to it. A code generated here before that change stays
 * visible so it can still be copied, along with the read-only Project sharing
 * operations. */

import { h } from "preact";
import { RadixTabsContent } from "../../../components/primitives/radix-tabs";
import { TextArea } from "../../../components/primitives/text-area";
import { copyToClipboard } from "../../../lib/dom";
import { state } from "../../../lib/state";

export interface InvitesPanelDeps {
	/** Opens the invitation creator in Sharing. */
	createInvite: () => void;
}

export function renderInvitesPanel({ createInvite }: InvitesPanelDeps) {
	const output = String(state.lastTeamInvite?.encoded || "").trim();
	const warnings = Array.isArray(state.lastTeamInvite?.warnings)
		? state.lastTeamInvite?.warnings
		: [];
	return h(
		RadixTabsContent,
		{ className: "coordinator-admin-panel", value: "invites" },
		h("h3", null, "Invitations"),
		h(
			"p",
			{ class: "peer-submeta" },
			"Invitations are created in Sharing. They add people to a Team or add a device for a person, and share only the Projects shown in their review.",
		),
		h(
			"div",
			{ class: "section-actions" },
			h(
				"button",
				{ class: "settings-button", onClick: () => createInvite(), type: "button" },
				"Create an invitation in Sharing",
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
