/* Coordinator-admin groups panel — renders the "Groups" surface:
 * create form, show-archived toggle, and a per-group card list with
 * rename / manage / archive-unarchive actions. Pulls form state from
 * coordinatorAdminState and group data from availableCoordinatorGroups.
 * Takes action callbacks plus renderShell + reloadData as deps so the
 * archive switch and manage button can trigger the surrounding shell. */

import { h } from "preact";
import { RadixSwitch } from "../../../components/primitives/radix-switch";
import { RadixTabsContent } from "../../../components/primitives/radix-tabs";
import { TextInput } from "../../../components/primitives/text-input";
import { state } from "../../../lib/state";
import { coordinatorAdminState } from "../data/state";
import type { CoordinatorAdminSummary } from "../data/summary";
import {
	availableCoordinatorGroups,
	currentAdminTargetGroup,
	setAdminTargetGroup,
} from "../data/target-group";

export interface GroupsPanelDeps {
	summary: CoordinatorAdminSummary;
	createGroup: () => void;
	runGroup: (
		groupId: string,
		displayName: string,
		kind: "rename" | "archive" | "unarchive",
	) => void;
	renderShell: () => void;
	reloadData: () => void;
}

export function renderGroupsPanel(deps: GroupsPanelDeps) {
	const { summary, createGroup, runGroup, renderShell, reloadData } = deps;
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
						onClick: () => createGroup(),
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
											reloadData();
										},
										type: "button",
									},
									selected ? "Managing" : "Manage",
								),
								h(
									"button",
									{
										class: "settings-button",
										disabled: summary.readiness !== "ready" || pending,
										onClick: () => runGroup(group.group_id, draftName, "rename"),
										type: "button",
									},
									pending && coordinatorAdminState.groupActionPendingKind === "rename"
										? "Renaming…"
										: "Rename",
								),
								h(
									"button",
									{
										class: archived ? "settings-button" : "settings-button danger",
										disabled: summary.readiness !== "ready" || pending,
										onClick: () =>
											runGroup(
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
