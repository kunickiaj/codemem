/* Coordinator-admin groups panel — renders the "Groups" surface:
 * create form, show-archived toggle, and a per-group card list with
 * rename / manage / archive-unarchive actions. Pulls form state from
 * coordinatorAdminState and group data from availableCoordinatorGroups.
 * Takes action callbacks plus renderShell + reloadData as deps so the
 * archive switch and manage button can trigger the surrounding shell. */

import * as Collapsible from "@radix-ui/react-collapsible";
import { Fragment, h } from "preact";
import { ProjectScopePicker } from "../../../components/primitives/project-scope-picker";
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
import { teamCardOverview } from "../data/team-card";
import {
	closeGroupScopeManagement,
	openGroupScopeManagement,
	renderGroupScopeManagementPanel,
} from "./scope-management-panel";

/* Inlined chevron SVG — matches the sync-tab device-row chevron so the
 * CSS `[data-state="open"]` rotation style is shared. Avoids depending
 * on the viewer's CDN lucide bootstrap inside a Collapsible.Content
 * that mounts after that sweep runs. */
function ChevronRightIcon() {
	return h(
		"svg",
		{
			"aria-hidden": "true",
			fill: "none",
			stroke: "currentColor",
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"stroke-width": "2",
			viewBox: "0 0 24 24",
			xmlns: "http://www.w3.org/2000/svg",
		},
		h("title", null, "Chevron"),
		h("path", { d: "m9 18 6-6-6-6" }),
	);
}

function emptyDraft(): GroupPreferencesDraft {
	return {
		projects_include: [],
		projects_exclude: [],
		auto_seed_scope: true,
		default_space_scope_id: "",
		auto_grant_default_space_on_join: false,
		loaded: false,
		saving: false,
		error: "",
	};
}

async function openGroupPreferences(groupId: string, renderShell: () => void): Promise<void> {
	const draft = emptyDraft();
	coordinatorAdminState.groupPreferencesDrafts.set(groupId, draft);
	coordinatorAdminState.groupPreferencesOpen.add(groupId);
	renderShell();
	try {
		const prefs = await api.loadCoordinatorGroupPreferences(groupId);
		coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
			projects_include: Array.isArray(prefs.projects_include) ? [...prefs.projects_include] : [],
			projects_exclude: Array.isArray(prefs.projects_exclude) ? [...prefs.projects_exclude] : [],
			auto_seed_scope: prefs.auto_seed_scope,
			default_space_scope_id: prefs.default_space_scope_id || "",
			auto_grant_default_space_on_join: prefs.auto_grant_default_space_on_join === true,
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
	// Snapshot the payload to send BEFORE awaiting, so chip edits during the
	// save don't alter what gets persisted this round. Empty arrays serialize
	// as `null` at the API layer; the store treats that as "no filter".
	const payload = {
		projects_include: initial.projects_include.length > 0 ? [...initial.projects_include] : null,
		projects_exclude: initial.projects_exclude.length > 0 ? [...initial.projects_exclude] : null,
		auto_seed_scope: initial.auto_seed_scope,
		default_space_scope_id: initial.default_space_scope_id || null,
		auto_grant_default_space_on_join: initial.auto_grant_default_space_on_join,
	};
	coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
		...initial,
		saving: true,
		error: "",
	});
	renderShell();
	try {
		await api.saveCoordinatorGroupPreferences(groupId, payload);
		showGlobalNotice("Team defaults saved. New devices use these filters and Space settings.");
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
		return h("div", { class: "peer-submeta" }, "Loading project defaults…");
	}
	const autoSeedLabelId = `coord-admin-scope-autoseed-${groupId}`;
	const autoGrantLabelId = `coord-admin-default-space-autogrant-${groupId}`;
	const includeLabelId = `coord-admin-scope-include-${groupId}`;
	const excludeLabelId = `coord-admin-scope-exclude-${groupId}`;
	const fieldsDisabled = !ready || draft.saving || !draft.auto_seed_scope;
	return h(
		Fragment,
		null,
		h("h4", { class: "coordinator-admin-drawer-title" }, "Team defaults"),
		h(
			"div",
			{ class: "peer-submeta" },
			"Project filters only narrow what future writes sync; they never grant Space access by themselves. Use the default Space toggle to control whether newly joined devices receive the Team's default Space.",
		),
		// Master toggle first — the include/exclude chips are only meaningful
		// when auto-seed is on, so the form reads top-down from decision
		// (toggle) to config (chips).
		h(
			"label",
			{ class: "coordinator-admin-inline-filter" },
			h("span", { class: "section-meta", id: autoSeedLabelId }, "Auto-seed project filters"),
			h(RadixSwitch, {
				"aria-labelledby": autoSeedLabelId,
				checked: draft.auto_seed_scope,
				className: "coordinator-admin-switch",
				disabled: !ready || draft.saving,
				onCheckedChange: (checked: boolean) => {
					const current = coordinatorAdminState.groupPreferencesDrafts.get(groupId) ?? draft;
					coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
						...current,
						auto_seed_scope: checked,
					});
					renderShell();
				},
				thumbClassName: "coordinator-admin-switch-thumb",
			}),
		),
		h(
			"label",
			{ class: "coordinator-admin-inline-filter" },
			h(
				"span",
				{ class: "section-meta", id: autoGrantLabelId },
				"Auto-grant default Space on join",
			),
			h(RadixSwitch, {
				"aria-labelledby": autoGrantLabelId,
				checked: draft.auto_grant_default_space_on_join,
				className: "coordinator-admin-switch",
				disabled: !ready || draft.saving || !draft.default_space_scope_id,
				onCheckedChange: (checked: boolean) => {
					const current = coordinatorAdminState.groupPreferencesDrafts.get(groupId) ?? draft;
					coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
						...current,
						auto_grant_default_space_on_join: checked,
					});
					renderShell();
				},
				thumbClassName: "coordinator-admin-switch-thumb",
			}),
		),
		draft.default_space_scope_id
			? h("div", { class: "peer-submeta" }, "Default Space configured.")
			: h("div", { class: "peer-submeta" }, "No default Space has been created yet."),
		h(
			"div",
			{ class: "coordinator-admin-field" },
			h("span", { id: includeLabelId }, "Include projects"),
			h(ProjectScopePicker, {
				"aria-labelledby": includeLabelId,
				availableProjects: coordinatorAdminState.availableProjects,
				disabled: fieldsDisabled,
				emptyLabel: "All projects allowed.",
				onValuesChange: (next: string[]) => {
					const current = coordinatorAdminState.groupPreferencesDrafts.get(groupId) ?? draft;
					coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
						...current,
						projects_include: next,
					});
					renderShell();
				},
				placeholder: "Add project",
				values: draft.projects_include,
			}),
			h(
				"span",
				{ class: "peer-submeta" },
				"Leave empty to allow every project. Type to search or create a new name.",
			),
		),
		h(
			"div",
			{ class: "coordinator-admin-field" },
			h("span", { id: excludeLabelId }, "Exclude projects"),
			h(ProjectScopePicker, {
				"aria-labelledby": excludeLabelId,
				availableProjects: coordinatorAdminState.availableProjects,
				disabled: fieldsDisabled,
				emptyLabel: "Nothing excluded.",
				onValuesChange: (next: string[]) => {
					const current = coordinatorAdminState.groupPreferencesDrafts.get(groupId) ?? draft;
					coordinatorAdminState.groupPreferencesDrafts.set(groupId, {
						...current,
						projects_exclude: next,
					});
					renderShell();
				},
				placeholder: "Add project",
				values: draft.projects_exclude,
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

function renderTeamSetupGuide(renderShell: () => void): ReturnType<typeof h> {
	const guide = coordinatorAdminState.teamSetupGuide;
	if (!guide) return null;
	const title = guide.displayName || guide.groupId;
	const warningStepById: Record<string, string> = {
		default_space: "default Space setup",
		default_space_grant: "default Space access grant",
	};
	const warningStep = warningStepById[guide.setupWarning?.step || ""] || "default Space setup";
	return h(
		"div",
		{ class: "peer-meta coordinator-admin-empty-state" },
		h("h4", { class: "coordinator-admin-drawer-title" }, `Set up ${title}`),
		h(
			"div",
			{ class: "peer-submeta" },
			"A Team organizes people and devices. The default Space is the memory boundary; Team membership only grants data access when default Space auto-grant is enabled.",
		),
		guide.setupWarning
			? h(
					"div",
					{ class: "peer-meta coordinator-admin-inline-warning" },
					`Team created, but ${warningStep} failed. Automatic repair is not available yet; use Spaces to inspect or create access manually before inviting teammates.`,
				)
			: h(
					"div",
					{ class: "peer-submeta" },
					guide.defaultSpaceScopeId
						? guide.defaultSpaceLabel
							? `Default Space ready: ${guide.defaultSpaceLabel}. New devices can receive this Space when auto-grant is enabled.`
							: "Default Space ready. New devices can receive this Space when auto-grant is enabled."
						: "Default Space status is unknown. Check Spaces before inviting teammates.",
				),
		h(
			"ol",
			{ class: "peer-submeta" },
			h("li", null, "Review Team defaults and the auto-grant default Space setting."),
			h("li", null, "Invite teammates or other devices."),
			h("li", null, "Assign projects to Spaces from the Projects tab."),
		),
		h(
			"div",
			{ class: "peer-actions" },
			h(
				"button",
				{
					class: "settings-button",
					onClick: () => {
						coordinatorAdminState.groupPreferencesOpen.add(guide.groupId);
						void openGroupPreferences(guide.groupId, renderShell);
					},
					type: "button",
				},
				"Review Team defaults",
			),
			h(
				"button",
				{
					class: "settings-button",
					onClick: () => {
						openGroupScopeManagement(guide.groupId, renderShell);
					},
					type: "button",
				},
				"Check Spaces",
			),
			h(
				"button",
				{
					class: "settings-button",
					onClick: () => {
						coordinatorAdminState.inviteGroup = guide.groupId;
						coordinatorAdminState.activeSection = "invites";
						renderShell();
					},
					type: "button",
				},
				"Invite devices",
			),
			h(
				"button",
				{
					class: "settings-button",
					onClick: () => {
						window.location.hash = "projects";
					},
					type: "button",
				},
				"Assign projects",
			),
			h(
				"button",
				{
					class: "settings-button",
					onClick: () => {
						coordinatorAdminState.teamSetupGuide = null;
						renderShell();
					},
					type: "button",
				},
				"Dismiss",
			),
		),
	);
}

function archiveButtonLabel(archived: boolean, pending: boolean): string {
	if (pending) return archived ? "Restoring…" : "Archiving…";
	return archived ? "Unarchive" : "Archive";
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
		h("h3", null, "Teams"),
		h(
			"p",
			{ class: "peer-submeta" },
			selectedGroup
				? `Managing ${selectedGroup}${configuredGroup && configuredGroup !== selectedGroup ? ` · this node uses ${configuredGroup} for discovery` : ""}`
				: configuredGroup
					? `This node uses ${configuredGroup} for discovery. Select a Team below to manage it.`
					: "No Team selected yet. Create one or select an existing Team to manage.",
		),
		groups.length ? h("p", { class: "peer-submeta" }, countParts.join(" · ")) : null,
		!targetExists && selectedGroup
			? h(
					"div",
					{ class: "peer-meta coordinator-admin-inline-warning" },
					`The selected Team (${selectedGroup}) is configured locally but does not exist in the coordinator yet. Create it below or switch to another Team once one exists.`,
				)
			: null,
		renderTeamSetupGuide(renderShell),
		h(
			"div",
			{ class: "coordinator-admin-form-grid" },
			h(
				"label",
				{ class: "coordinator-admin-field" },
				h("span", null, "New Team id"),
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
					coordinatorAdminState.groupActionPendingKind === "create" ? "Creating…" : "Create Team",
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
							? "No Teams are available yet."
							: "No active Teams yet. Create one to get started."
						: "Team browsing will appear here once setup is complete.",
				)
			: h(
					"div",
					{ class: "peer-list" },
					visibleGroups.map((group) => {
						const selected = group.group_id === selectedGroup;
						const pending = coordinatorAdminState.groupActionPendingId === group.group_id;
						const archived = Boolean(group.archived_at);
						const draftName =
							coordinatorAdminState.groupRenameDrafts.get(group.group_id) ??
							group.display_name ??
							group.group_id;
						const scopeOpen = coordinatorAdminState.groupPreferencesOpen.has(group.group_id);
						const domainsOpen = coordinatorAdminState.groupScopeManagementOpen.has(group.group_id);
						const archiveActionKind = archived ? "unarchive" : "archive";
						const archivePending =
							pending && coordinatorAdminState.groupActionPendingKind === archiveActionKind;
						const archiveActionLabel = archiveButtonLabel(archived, archivePending);
						const overview = teamCardOverview({
							groupId: group.group_id,
							preferences: coordinatorAdminState.groupPreferencesDrafts.get(group.group_id),
							scopeManagement: coordinatorAdminState.groupScopeManagementDrafts.get(group.group_id),
							setupGuide: coordinatorAdminState.teamSetupGuide,
						});
						return h(
							"div",
							{ class: "peer-card peer-card--padded", key: group.group_id },
							h("div", { class: "peer-title" }, h("strong", null, draftName)),
							h("div", { class: "peer-meta" }, `Team ID: ${group.group_id}`),
							h("div", { class: "peer-submeta" }, archived ? "Archived" : "Active"),
							h(
								"div",
								{ class: "coordinator-admin-summary-grid" },
								h(
									"div",
									{ class: "coordinator-admin-summary-card" },
									h("span", { class: "section-meta" }, "Default Space"),
									h("strong", null, overview.defaultSpace),
								),
								h(
									"div",
									{ class: "coordinator-admin-summary-card" },
									h("span", { class: "section-meta" }, "Auto-grant"),
									h("strong", null, overview.autoGrant),
								),
								h(
									"div",
									{ class: "coordinator-admin-summary-card" },
									h("span", { class: "section-meta" }, "Spaces"),
									h("strong", null, overview.spaces),
								),
							),
							configuredGroup === group.group_id
								? h(
										"div",
										{ class: "peer-submeta" },
										"This node uses this Team for coordinator-backed discovery.",
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
										"aria-expanded": scopeOpen,
										"aria-controls": `coord-admin-project-defaults-drawer-${group.group_id}`,
										class: "settings-button coordinator-admin-scope-trigger",
										"data-state": scopeOpen ? "open" : "closed",
										disabled: summary.readiness !== "ready" || pending,
										onClick: () => {
											if (scopeOpen) {
												closeGroupPreferences(group.group_id, renderShell);
											} else {
												void openGroupPreferences(group.group_id, renderShell);
											}
										},
										type: "button",
									},
									h("span", null, "Team defaults"),
									h(
										"span",
										{ "aria-hidden": "true", class: "device-row-chevron" },
										h(ChevronRightIcon, null),
									),
								),
								h(
									"button",
									{
										"aria-expanded": domainsOpen,
										"aria-controls": `coord-admin-spaces-drawer-${group.group_id}`,
										class: "settings-button coordinator-admin-scope-trigger",
										"data-state": domainsOpen ? "open" : "closed",
										disabled: summary.readiness !== "ready" || pending,
										onClick: () => {
											if (domainsOpen) {
												closeGroupScopeManagement(group.group_id, renderShell);
											} else {
												openGroupScopeManagement(group.group_id, renderShell);
											}
										},
										type: "button",
									},
									h("span", null, "Spaces & access"),
									h(
										"span",
										{ "aria-hidden": "true", class: "device-row-chevron" },
										h(ChevronRightIcon, null),
									),
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
												archiveActionKind,
											),
										type: "button",
									},
									archiveActionLabel,
								),
							),
							h(
								Collapsible.Root,
								{
									open: scopeOpen,
									onOpenChange: (open: boolean) => {
										if (open) void openGroupPreferences(group.group_id, renderShell);
										else closeGroupPreferences(group.group_id, renderShell);
									},
								},
								h(
									Collapsible.Content,
									{
										"aria-label": `Project defaults for ${draftName}`,
										class: "coordinator-admin-group-preferences",
										id: `coord-admin-project-defaults-drawer-${group.group_id}`,
									},
									scopeOpen
										? renderGroupPreferencesEditor(
												group.group_id,
												renderShell,
												summary.readiness === "ready",
											)
										: null,
								),
							),
							h(
								Collapsible.Root,
								{
									open: domainsOpen,
									onOpenChange: (open: boolean) => {
										if (open) openGroupScopeManagement(group.group_id, renderShell);
										else closeGroupScopeManagement(group.group_id, renderShell);
									},
								},
								h(
									Collapsible.Content,
									{
										"aria-label": `Spaces for ${draftName}`,
										class:
											"coordinator-admin-group-preferences coordinator-admin-domain-management",
										id: `coord-admin-spaces-drawer-${group.group_id}`,
									},
									domainsOpen
										? renderGroupScopeManagementPanel({
												groupId: group.group_id,
												ready: summary.readiness === "ready",
												renderShell,
												summary,
											})
										: null,
								),
							),
						);
					}),
				),
	);
}
