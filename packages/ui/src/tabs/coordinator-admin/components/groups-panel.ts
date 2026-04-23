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
import * as api from "../../../lib/api";
import { showGlobalNotice } from "../../../lib/notice";
import { state } from "../../../lib/state";
import { coordinatorAdminState, type GroupPreferencesDraft } from "../data/state";
import type { CoordinatorAdminSummary } from "../data/summary";
import {
	availableCoordinatorGroups,
	currentAdminTargetGroup,
	setAdminTargetGroup,
} from "../data/target-group";

function emptyDraft(): GroupPreferencesDraft {
	return {
		projects_include: "",
		projects_exclude: "",
		auto_seed_scope: true,
		loaded: false,
		saving: false,
		error: "",
	};
}

function listToText(list: string[] | null): string {
	return Array.isArray(list) ? list.join(", ") : "";
}

function textToList(text: string): string[] | null {
	const items = text
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return items.length === 0 ? null : items;
}

async function openGroupPreferences(groupId: string, renderShell: () => void): Promise<void> {
	const draft = emptyDraft();
	coordinatorAdminState.groupPreferencesDrafts.set(groupId, draft);
	coordinatorAdminState.groupPreferencesOpen.add(groupId);
	renderShell();
	try {
		const prefs = await api.loadCoordinatorGroupPreferences(groupId);
		coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
			projects_include: listToText(prefs.projects_include),
			projects_exclude: listToText(prefs.projects_exclude),
			auto_seed_scope: prefs.auto_seed_scope,
			loaded: true,
			saving: false,
			error: "",
		});
	} catch (error) {
		coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
			...draft,
			loaded: true,
			error: error instanceof Error ? error.message : "Failed to load preferences.",
		});
	}
	renderShell();
}

function closeGroupPreferences(groupId: string, renderShell: () => void): void {
	coordinatorAdminState.groupPreferencesOpen.delete(groupId);
	coordinatorAdminState.groupPreferencesDrafts.delete(groupId);
	renderShell();
}

async function saveGroupPreferences(groupId: string, renderShell: () => void): Promise<void> {
	const initial = coordinatorAdminState.groupPreferencesDrafts.get(groupId);
	if (!initial) return;
	// Re-entrancy guard: a second click before the first save resolves must not
	// kick off a parallel save. The Save button is disabled on `draft.saving`,
	// but a pre-render double-click can otherwise slip through.
	if (initial.saving) return;
	// Snapshot the payload to send BEFORE awaiting, so typing during the save
	// doesn't alter what gets persisted this round.
	const payload = {
		projects_include: textToList(initial.projects_include),
		projects_exclude: textToList(initial.projects_exclude),
		auto_seed_scope: initial.auto_seed_scope,
	};
	coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
		...initial,
		saving: true,
		error: "",
	});
	renderShell();
	try {
		await api.saveCoordinatorGroupPreferences(groupId, payload);
		showGlobalNotice(
			"Group scope defaults saved. New peers enrolled through this team will use these defaults.",
		);
		closeGroupPreferences(groupId, renderShell);
	} catch (error) {
		// Re-read the latest draft so any keystrokes landed during the save are
		// preserved; only clobber saving + error fields.
		const latest = coordinatorAdminState.groupPreferencesDrafts.get(groupId);
		if (!latest) return;
		coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
			...latest,
			saving: false,
			error: error instanceof Error ? error.message : "Failed to save preferences.",
		});
		renderShell();
	}
}

function renderGroupPreferencesEditor(
	groupId: string,
	renderShell: () => void,
	ready: boolean,
): ReturnType<typeof h> {
	const draft = coordinatorAdminState.groupPreferencesDrafts.get(groupId);
	if (!draft) return null;
	if (!draft.loaded) {
		return h(
			"div",
			{ class: "coordinator-admin-group-preferences" },
			h("div", { class: "peer-submeta" }, "Loading scope defaults…"),
		);
	}
	return h(
		"div",
		{ class: "coordinator-admin-group-preferences" },
		h(
			"div",
			{ class: "peer-submeta" },
			"New peers discovered through this team will default to this scope. Existing peers are not changed.",
		),
		h(
			"label",
			{ class: "coordinator-admin-field" },
			h("span", null, "Include projects (comma-separated)"),
			h(TextInput, {
				class: "peer-scope-input",
				disabled: !ready || draft.saving,
				onInput: (event) => {
					// Read the LATEST draft from the shared map rather than the
					// one captured at render time — text inputs don't re-render
					// between keystrokes, so `draft` here would otherwise stomp
					// other fields' edits with stale values.
					const current = coordinatorAdminState.groupPreferencesDrafts.get(groupId) ?? draft;
					const next = String((event.currentTarget as HTMLInputElement).value || "");
					coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
						...current,
						projects_include: next,
					});
				},
				placeholder: "e.g. work/*, shared-work-coworker/*",
				type: "text",
				value: draft.projects_include,
			}),
		),
		h(
			"label",
			{ class: "coordinator-admin-field" },
			h("span", null, "Exclude projects (comma-separated)"),
			h(TextInput, {
				class: "peer-scope-input",
				disabled: !ready || draft.saving,
				onInput: (event) => {
					const current = coordinatorAdminState.groupPreferencesDrafts.get(groupId) ?? draft;
					const next = String((event.currentTarget as HTMLInputElement).value || "");
					coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
						...current,
						projects_exclude: next,
					});
				},
				placeholder: "",
				type: "text",
				value: draft.projects_exclude,
			}),
		),
		h(
			"label",
			{ class: "coordinator-admin-field coordinator-admin-switch" },
			h("span", null, "Auto-seed scope on new peers"),
			h(RadixSwitch, {
				checked: draft.auto_seed_scope,
				disabled: !ready || draft.saving,
				onCheckedChange: (checked: boolean) => {
					const current = coordinatorAdminState.groupPreferencesDrafts.get(groupId) ?? draft;
					coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
						...current,
						auto_seed_scope: checked,
					});
					renderShell();
				},
			}),
		),
		draft.error ? h("div", { class: "peer-submeta coordinator-admin-error" }, draft.error) : null,
		h(
			"div",
			{ class: "peer-actions" },
			h(
				"button",
				{
					class: "settings-button",
					disabled: !ready || draft.saving,
					onClick: () => void saveGroupPreferences(groupId, renderShell),
					type: "button",
				},
				draft.saving ? "Saving…" : "Save defaults",
			),
			h(
				"button",
				{
					class: "settings-button",
					disabled: draft.saving,
					onClick: () => closeGroupPreferences(groupId, renderShell),
					type: "button",
				},
				"Cancel",
			),
		),
	);
}

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
										class: "settings-button",
										disabled: summary.readiness !== "ready" || pending,
										onClick: () => {
											if (coordinatorAdminState.groupPreferencesOpen.has(group.group_id)) {
												closeGroupPreferences(group.group_id, renderShell);
											} else {
												void openGroupPreferences(group.group_id, renderShell);
											}
										},
										type: "button",
									},
									coordinatorAdminState.groupPreferencesOpen.has(group.group_id)
										? "Close scope defaults"
										: "Scope defaults",
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
							coordinatorAdminState.groupPreferencesOpen.has(group.group_id)
								? renderGroupPreferencesEditor(
										group.group_id,
										renderShell,
										summary.readiness === "ready",
									)
								: null,
						);
					}),
				),
	);
}
