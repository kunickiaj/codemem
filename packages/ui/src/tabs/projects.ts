import * as api from "../lib/api";
import type {
	ProjectScopeGuardrailWarning,
	ProjectScopeInventoryProject,
	SharingDomainScope,
} from "../lib/api/sync";
import { showGlobalNotice } from "../lib/notice";
import { state } from "../lib/state";
import { openSyncInputDialog } from "./sync/sync-dialogs";

type RefreshFn = () => void;

const STATUS_OPTIONS = [
	["", "All projects"],
	["needs_attention", "Needs review"],
	["suggested", "Has suggestion"],
	["local_only", "Stays on this device"],
	["received", "Received from peers"],
	["explicitly_mapped", "Already assigned"],
	["legacy_review", "Older shared data"],
	["unmapped", "Missing project identity"],
] as const;

let refreshProjects: RefreshFn | null = null;
let currentOffset = 0;
const lastLimit = 250;
let scopes: SharingDomainScope[] = [];
const openProjectDetails = new Set<string>();
const openProjectClusters = new Set<string>();
const draftDomainSelections = new Map<string, string>();
const draftClusterDomainSelections = new Map<string, string>();
const pendingConfirmations = new Map<
	string,
	{ requiredGuardrailTokens: string[]; scopeId: string; warnings: ProjectScopeGuardrailWarning[] }
>();
const pendingForgetConfirmations = new Map<
	string,
	{ confirmationToken: string; localOwnedMemoryCount: number; peerOwnedMemoryCount: number }
>();
let skippedProjectRefreshForActiveSelect = false;
let coordinatorGroupNamesCurrent = false;

function el<T extends HTMLElement>(id: string): T | null {
	return document.getElementById(id) as T | null;
}

function formatStatus(status: string): string {
	return STATUS_OPTIONS.find(([value]) => value === status)?.[1] ?? status.replaceAll("_", " ");
}

function formatResolution(reason: string): string {
	switch (reason) {
		case "exact_mapping":
			return "assigned to a Space";
		case "pattern_mapping":
			return "assigned by matching rule";
		case "explicit_override":
			return "manually assigned";
		default:
			return "stays on this device";
	}
}

function isPeerReceivedProject(project: ProjectScopeInventoryProject): boolean {
	return project.read_only === true && project.read_only_reason === "peer_received";
}

function isLocallyAssignableProject(project: ProjectScopeInventoryProject): boolean {
	return project.identity_source !== "unmapped" && !isPeerReceivedProject(project);
}

function projectDomainLabel(project: ProjectScopeInventoryProject): string {
	return isPeerReceivedProject(project)
		? "Received from peers"
		: scopeSummary(project.resolved_scope_id);
}

function projectResolutionLabel(project: ProjectScopeInventoryProject): string {
	return isPeerReceivedProject(project)
		? "source-owned project"
		: formatResolution(project.resolution_reason);
}

function formatLatest(value: string | null): string {
	if (!value) return "No recent sessions";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString();
}

function strongestSignal(project: ProjectScopeInventoryProject): string {
	if (project.git_remote) return project.git_remote;
	if (project.cwd) return project.cwd;
	return project.workspace_identity;
}

function projectClusterKey(project: ProjectScopeInventoryProject): string {
	if (project.git_remote) return `git:${project.git_remote}`;
	if (project.project) return `project:${project.project}`;
	return `identity:${project.workspace_identity}`;
}

function projectClusterLabel(project: ProjectScopeInventoryProject): string {
	return project.project || project.display_project || strongestSignal(project);
}

function teamName(groupId: string | null | undefined): string | null {
	const normalized = String(groupId || "").trim();
	if (!normalized) return null;
	const group = state.lastCoordinatorAdminGroups.find(
		(item) => String(item.group_id || "").trim() === normalized && !item.archived_at,
	);
	return group?.display_name || "Team details unavailable";
}

function knownActiveCoordinatorGroupIds(): Set<string> {
	return new Set(
		state.lastCoordinatorAdminGroups
			.filter((item) => !item.archived_at)
			.map((item) => String(item.group_id || "").trim())
			.filter(Boolean),
	);
}

function isFromKnownInactiveCoordinatorGroup(scope: SharingDomainScope): boolean {
	if (!coordinatorGroupNamesCurrent || scope.authority_type !== "coordinator" || !scope.group_id) {
		return false;
	}
	return !knownActiveCoordinatorGroupIds().has(String(scope.group_id).trim());
}

function isProjectSpaceSelectActive(): boolean {
	const active = document.activeElement;
	return active instanceof HTMLSelectElement && active.classList.contains("project-domain-select");
}

function refreshSkippedProjectDataAfterSelectBlur() {
	if (!skippedProjectRefreshForActiveSelect) return;
	skippedProjectRefreshForActiveSelect = false;
	refreshProjects?.();
}

async function refreshProjectCoordinatorGroupNames(): Promise<void> {
	try {
		const status = await api.loadCoordinatorAdminStatus();
		state.lastCoordinatorAdminStatus =
			status && typeof status === "object"
				? (status as typeof state.lastCoordinatorAdminStatus)
				: null;
	} catch {
		state.lastCoordinatorAdminStatus = null;
		state.lastCoordinatorAdminGroups = [];
		coordinatorGroupNamesCurrent = false;
		return;
	}
	if (
		state.lastCoordinatorAdminStatus?.readiness !== "ready" ||
		!state.lastCoordinatorAdminStatus.has_admin_secret
	) {
		state.lastCoordinatorAdminGroups = [];
		coordinatorGroupNamesCurrent = false;
		return;
	}
	try {
		const payload = (await api.loadCoordinatorAdminGroupsFiltered(false)) as {
			items?: typeof state.lastCoordinatorAdminGroups;
		};
		state.lastCoordinatorAdminGroups = Array.isArray(payload?.items) ? payload.items : [];
		coordinatorGroupNamesCurrent = true;
	} catch {
		state.lastCoordinatorAdminGroups = [];
		coordinatorGroupNamesCurrent = false;
	}
}

function isDefaultTeamSpace(scope: SharingDomainScope): boolean {
	return scope.kind === "team_default";
}

function spaceName(scope: SharingDomainScope): string {
	const label = scope.label || "Untitled Space";
	return isDefaultTeamSpace(scope) ? `${label} (default)` : label;
}

function spaceOptionName(scope: SharingDomainScope, siblingScopes: SharingDomainScope[]): string {
	const label = spaceName(scope);
	const duplicateLabel = siblingScopes.some(
		(sibling) => sibling.scope_id !== scope.scope_id && spaceName(sibling) === label,
	);
	return duplicateLabel ? `${label} · Space ID ${scope.scope_id}` : label;
}

function spaceOwner(scope: SharingDomainScope): string {
	const team = teamName(scope.group_id);
	if (team) return `Team: ${team}`;
	if (scope.authority_type === "local") return "Local device";
	if (scope.authority_type === "coordinator") return "Coordinator Space";
	return `${scope.authority_type || "Other"} Space`;
}

function scopeById(scopeId: string | null | undefined): SharingDomainScope | null {
	if (!scopeId) return null;
	return scopes.find((item) => item.scope_id === scopeId) ?? null;
}

function scopeSummary(scopeId: string | null | undefined): string {
	const scope = scopeById(scopeId);
	if (!scopeId) return "—";
	return scope ? `${spaceName(scope)} · ${spaceOwner(scope)}` : "Unknown Space";
}

function assignableScopes(): SharingDomainScope[] {
	return scopes.filter(
		(scope) =>
			scope.scope_id !== "legacy-shared-review" && !isFromKnownInactiveCoordinatorGroup(scope),
	);
}

function isAssignableScopeId(scopeId: string | null | undefined): boolean {
	return assignableScopes().some((scope) => scope.scope_id === scopeId);
}

function firstSafeSelection(...scopeIds: Array<string | null | undefined>): string {
	for (const scopeId of scopeIds) {
		if (scopeId && isAssignableScopeId(scopeId)) return scopeId;
	}
	return scopeIds.find((scopeId): scopeId is string => Boolean(scopeId)) ?? "";
}

function scopeGroupLabel(scope: SharingDomainScope): string {
	const team = teamName(scope.group_id);
	if (team) return `Team: ${team}`;
	if (scope.authority_type === "local") return "Local device";
	if (scope.authority_type === "coordinator") return "Coordinator Spaces";
	return "Other Spaces";
}

function scopeGroupKey(scope: SharingDomainScope): string {
	if (scope.group_id) return `team:${scope.group_id}`;
	return `${scope.authority_type || "other"}:${scope.kind || "space"}`;
}

function groupedAssignableScopes(): Array<{ label: string; scopes: SharingDomainScope[] }> {
	const groups = new Map<string, { label: string; scopes: SharingDomainScope[] }>();
	for (const scope of assignableScopes()) {
		const key = scopeGroupKey(scope);
		const label = scopeGroupLabel(scope);
		const current = groups.get(key) ?? { label, scopes: [] };
		groups.set(key, { label: current.label, scopes: [...current.scopes, scope] });
	}
	return [...groups.values()];
}

function appendAssignableScopeOptions(select: HTMLSelectElement) {
	for (const group of groupedAssignableScopes()) {
		const optgroup = document.createElement("optgroup");
		optgroup.label = group.label;
		for (const scope of group.scopes) {
			const option = document.createElement("option");
			option.value = scope.scope_id;
			option.textContent = spaceOptionName(scope, group.scopes);
			optgroup.appendChild(option);
		}
		select.appendChild(optgroup);
	}
}

function guardrailHeading(warning: ProjectScopeGuardrailWarning): string {
	switch (warning.code) {
		case "unknown_project_local_only":
			return "Current behavior";
		case "basename_collision_review":
			return "Name collision";
		case "scope_reassignment_old_copies":
			return "Previous copies";
		case "broad_org_domain_pattern":
		case "home_directory_org_domain_pattern":
			return "Broad mapping";
		default:
			return "Review item";
	}
}

async function saveProjectMapping(
	project: ProjectScopeInventoryProject,
	scopeId: string,
	confirmedGuardrailTokens: string[] = [],
) {
	try {
		await api.saveSharingDomainProjectMapping({
			...(project.mapping_id && project.resolution_reason === "exact_mapping"
				? { id: project.mapping_id }
				: {}),
			...(confirmedGuardrailTokens.length > 0
				? { confirmed_guardrail_tokens: confirmedGuardrailTokens }
				: {}),
			project_pattern: project.display_project,
			scope_id: scopeId,
			workspace_identity: project.workspace_identity,
		});
		pendingConfirmations.delete(project.workspace_identity);
		draftDomainSelections.delete(project.workspace_identity);
		showGlobalNotice("Project Space assignment updated. Device access grants are unchanged.");
		refreshProjects?.();
	} catch (error) {
		if (error instanceof api.SharingDomainGuardrailConfirmationError) {
			pendingConfirmations.set(project.workspace_identity, {
				requiredGuardrailTokens: error.requiredGuardrailTokens,
				scopeId,
				warnings: error.guardrailWarnings,
			});
			refreshProjects?.();
			return;
		}
		showGlobalNotice(
			error instanceof Error ? error.message : "Unable to update project Space.",
			"warning",
		);
	}
}

async function saveProjectClusterMapping(
	projects: ProjectScopeInventoryProject[],
	scopeId: string,
) {
	const assignable = projects.filter(isLocallyAssignableProject);
	if (assignable.length === 0) return;
	try {
		await api.saveSharingDomainProjectMappings({
			mappings: assignable.map((project) => ({
				...(project.mapping_id && project.resolution_reason === "exact_mapping"
					? { id: project.mapping_id }
					: {}),
				project_pattern: project.display_project,
				scope_id: scopeId,
				workspace_identity: project.workspace_identity,
			})),
		});
		showGlobalNotice(
			`Updated ${assignable.length} project identit${assignable.length === 1 ? "y" : "ies"}. Device access grants are unchanged.`,
		);
		draftClusterDomainSelections.delete(projectClusterKey(assignable[0]));
		refreshProjects?.();
	} catch (error) {
		showGlobalNotice(
			error instanceof api.SharingDomainGuardrailConfirmationError
				? "One or more identities in this group need review before bulk assignment. Expand the group and save those identities directly."
				: error instanceof Error
					? error.message
					: "Unable to update project Spaces.",
			"warning",
		);
	}
}

async function removeProjectMapping(project: ProjectScopeInventoryProject) {
	if (project.mapping_id == null) return;
	try {
		await api.deleteSharingDomainProjectMapping(project.mapping_id);
		pendingConfirmations.delete(project.workspace_identity);
		draftDomainSelections.delete(project.workspace_identity);
		showGlobalNotice("Project Space assignment removed. The next fallback now applies.");
		refreshProjects?.();
	} catch (error) {
		showGlobalNotice(
			error instanceof Error ? error.message : "Unable to remove project Space assignment.",
			"warning",
		);
	}
}

async function forgetProjectMemories(project: ProjectScopeInventoryProject, confirmed = false) {
	try {
		const pending = pendingForgetConfirmations.get(project.workspace_identity);
		const result = await api.forgetProjectInventoryMemories({
			...(confirmed && pending ? { confirmation_token: pending.confirmationToken } : {}),
			confirmed,
			workspace_identity: project.workspace_identity,
		});
		pendingForgetConfirmations.delete(project.workspace_identity);
		showGlobalNotice(
			`Forgot ${result.forgotten_memory_count.toLocaleString()} local memor${result.forgotten_memory_count === 1 ? "y" : "ies"}. ${result.peer_owned_memory_count.toLocaleString()} peer-owned memor${result.peer_owned_memory_count === 1 ? "y was" : "ies were"} left unchanged.`,
		);
		refreshProjects?.();
	} catch (error) {
		if (error instanceof api.ProjectForgetConfirmationError) {
			pendingForgetConfirmations.set(project.workspace_identity, {
				confirmationToken: error.preview.confirmation_token,
				localOwnedMemoryCount: error.preview.local_owned_memory_count,
				peerOwnedMemoryCount: error.preview.peer_owned_memory_count,
			});
			refreshProjects?.();
			return;
		}
		showGlobalNotice(
			error instanceof Error ? error.message : "Unable to forget project memories.",
			"warning",
		);
	}
}

async function reassignProject(project: ProjectScopeInventoryProject) {
	if (project.identity_source === "unmapped") return;
	const currentProject = String(project.project || project.display_project || "").trim();
	let suggestions: string[] = [];
	try {
		suggestions = (await api.loadProjects()).filter((name) => name && name !== currentProject);
	} catch {
		// Non-fatal — free-text correction still works.
	}
	const nextProject = await openSyncInputDialog({
		cancelLabel: "Cancel",
		confirmLabel: "Change project",
		description: `This will update ${project.session_count} session${project.session_count === 1 ? "" : "s"} and ${project.memory_count ?? 0} memor${project.memory_count === 1 ? "y" : "ies"} by changing the stored project. Space assignment stays unchanged.`,
		initialValue: currentProject,
		placeholder: "Project name",
		suggestions,
		title: "Change project",
		validate: (value) => {
			const trimmed = value.trim();
			if (!trimmed) return "Enter a project name.";
			if (trimmed === currentProject) return "Already assigned to this project.";
			return null;
		},
	});
	if (nextProject == null) return;
	try {
		const result = await api.reassignProjectInventoryProject({
			project: nextProject.trim(),
			workspace_identity: project.workspace_identity,
		});
		showGlobalNotice(
			`Changed project to ${result.project} for ${result.moved_session_count} session${result.moved_session_count === 1 ? "" : "s"}.`,
		);
		refreshProjects?.();
	} catch (error) {
		showGlobalNotice(
			error instanceof Error ? error.message : "Unable to change project.",
			"warning",
		);
	}
}

function renderProjectActions(project: ProjectScopeInventoryProject): HTMLElement {
	const actions = document.createElement("div");
	actions.className = "project-inventory-actions";
	if (isPeerReceivedProject(project)) {
		const note = document.createElement("div");
		note.className = "settings-note";
		note.textContent =
			"This project was received from a peer. Change its project or Space on the source device; this node keeps the received identity read-only.";
		actions.appendChild(note);
		return actions;
	}
	if (project.identity_source === "unmapped") {
		const note = document.createElement("div");
		note.className = "settings-note";
		note.textContent =
			"This project is missing a stable path, git remote, or workspace id. It stays Local only until it has a stable identity.";
		actions.appendChild(note);
		return actions;
	}
	const label = document.createElement("label");
	label.className = "sr-only";
	const selectId = `project-domain-${project.workspace_identity.replace(/[^a-z0-9_-]/gi, "-")}`;
	label.htmlFor = selectId;
	label.textContent = `Space for ${project.display_project}`;
	const select = document.createElement("select");
	select.id = selectId;
	select.className = "project-domain-select";
	const currentAssignable = assignableScopes().some(
		(scope) => scope.scope_id === project.resolved_scope_id,
	);
	if (!currentAssignable && project.resolved_scope_id) {
		const current = document.createElement("option");
		current.value = project.resolved_scope_id;
		current.textContent = `${scopeSummary(project.resolved_scope_id)} — not assignable`;
		current.disabled = true;
		select.appendChild(current);
	}
	appendAssignableScopeOptions(select);
	select.value = firstSafeSelection(
		draftDomainSelections.get(project.workspace_identity),
		project.suggested_scope_id,
		project.resolved_scope_id,
	);

	const save = document.createElement("button");
	save.className = "settings-button";
	save.type = "button";
	save.textContent =
		project.suggested_scope_id && select.value === project.suggested_scope_id
			? "Confirm suggestion"
			: "Save Space";
	save.disabled =
		!select.value || (select.value === project.resolved_scope_id && !currentAssignable);
	save.addEventListener("click", () => void saveProjectMapping(project, select.value));
	select.addEventListener("change", () => {
		draftDomainSelections.set(project.workspace_identity, select.value);
		pendingConfirmations.delete(project.workspace_identity);
		actions.querySelector(".project-space-guardrail-confirmation")?.remove();
		save.textContent = "Save Space";
		save.disabled = !select.value;
		refreshProjects?.();
	});
	select.addEventListener("blur", refreshSkippedProjectDataAfterSelectBlur);

	const keepLocal = document.createElement("button");
	keepLocal.className = "settings-button";
	keepLocal.type = "button";
	keepLocal.textContent = "Keep local-only";
	keepLocal.addEventListener("click", () => void saveProjectMapping(project, "local-default"));

	const remove = document.createElement("button");
	remove.className = "settings-button";
	remove.type = "button";
	remove.textContent = "Remove mapping";
	remove.disabled = project.mapping_id == null || project.resolution_reason !== "exact_mapping";
	remove.addEventListener("click", () => void removeProjectMapping(project));

	const changeProject = document.createElement("button");
	changeProject.className = "settings-button";
	changeProject.type = "button";
	changeProject.textContent = "Change project…";
	changeProject.disabled = project.session_count === 0;
	if (changeProject.disabled) {
		changeProject.title = "No sessions are available to reassign for this saved mapping.";
	}
	changeProject.addEventListener("click", () => void reassignProject(project));
	const forget = document.createElement("button");
	forget.className = "settings-button danger";
	forget.type = "button";
	forget.textContent = "Forget local memories…";
	forget.disabled = (project.memory_count ?? 0) === 0;
	forget.addEventListener("click", () => void forgetProjectMemories(project));

	actions.append(label, select, save, keepLocal, remove, changeProject, forget);
	const pending = pendingConfirmations.get(project.workspace_identity);
	if (pending) {
		const warningBox = document.createElement("div");
		warningBox.className =
			"settings-note project-guardrail-confirmation project-space-guardrail-confirmation";
		warningBox.setAttribute("role", "alert");
		const title = document.createElement("strong");
		title.textContent = "Confirmation required before saving this Space.";
		const intro = document.createElement("p");
		intro.textContent =
			"Codemem can save this change after you acknowledge the checks below. Verify the workspace details, then confirm to complete the save.";
		const list = document.createElement("ul");
		for (const warning of pending.warnings) {
			const item = document.createElement("li");
			const itemTitle = document.createElement("strong");
			itemTitle.textContent = `${guardrailHeading(warning)}: `;
			const message = document.createElement("span");
			message.textContent = warning.message;
			item.append(itemTitle, message);
			list.appendChild(item);
		}
		const confirm = document.createElement("button");
		confirm.className = "settings-button";
		confirm.type = "button";
		confirm.textContent = "I understand, save Space";
		confirm.addEventListener("click", () => {
			const currentPending = pendingConfirmations.get(project.workspace_identity);
			if (!currentPending || currentPending.scopeId !== select.value) return;
			void saveProjectMapping(
				project,
				currentPending.scopeId,
				currentPending.requiredGuardrailTokens,
			);
		});
		const cancel = document.createElement("button");
		cancel.className = "settings-button";
		cancel.type = "button";
		cancel.textContent = "Cancel";
		cancel.addEventListener("click", () => {
			pendingConfirmations.delete(project.workspace_identity);
			refreshProjects?.();
		});
		warningBox.append(title, intro, list, confirm, cancel);
		actions.appendChild(warningBox);
	}
	const pendingForget = pendingForgetConfirmations.get(project.workspace_identity);
	if (pendingForget) {
		const warningBox = document.createElement("div");
		warningBox.className = "settings-note project-guardrail-confirmation";
		warningBox.setAttribute("role", "alert");
		const title = document.createElement("strong");
		title.textContent = "Confirm project memory cleanup.";
		const intro = document.createElement("p");
		intro.textContent = `${pendingForget.localOwnedMemoryCount.toLocaleString()} locally owned memor${pendingForget.localOwnedMemoryCount === 1 ? "y" : "ies"} will be forgotten. ${pendingForget.peerOwnedMemoryCount.toLocaleString()} peer-owned memor${pendingForget.peerOwnedMemoryCount === 1 ? "y" : "ies"} will be left unchanged.`;
		const detail = document.createElement("p");
		detail.textContent =
			"Use this only to clean up wrongly attributed local project inventory; it forgets actual local memories on this device.";
		const confirm = document.createElement("button");
		confirm.className = "settings-button danger";
		confirm.type = "button";
		confirm.textContent = "I understand, forget local memories";
		confirm.addEventListener("click", () => void forgetProjectMemories(project, true));
		const cancel = document.createElement("button");
		cancel.className = "settings-button";
		cancel.type = "button";
		cancel.textContent = "Cancel";
		cancel.addEventListener("click", () => {
			pendingForgetConfirmations.delete(project.workspace_identity);
			refreshProjects?.();
		});
		warningBox.append(title, intro, detail, confirm, cancel);
		actions.appendChild(warningBox);
	}
	return actions;
}

function renderProjectRow(project: ProjectScopeInventoryProject): HTMLElement {
	const row = document.createElement("article");
	row.className = "project-inventory-row";
	const header = document.createElement("div");
	header.className = "project-inventory-row-header";

	const title = document.createElement("div");
	title.className = "project-inventory-title";
	title.textContent = project.display_project;
	header.appendChild(title);

	const domain = document.createElement("div");
	domain.className = "project-inventory-domain";
	domain.textContent = projectDomainLabel(project);
	header.appendChild(domain);
	row.appendChild(header);

	const meta = document.createElement("div");
	meta.className = "project-inventory-meta";
	meta.textContent = `${projectResolutionLabel(project)} · ${project.identity_source} · ${formatLatest(project.latest_session_at)}`;
	row.appendChild(meta);

	if (isPeerReceivedProject(project)) {
		const receivedNote = document.createElement("div");
		receivedNote.className = "settings-note";
		receivedNote.textContent =
			"Received memories keep the source device's project and Space assignment. Local reassignment controls are disabled here to avoid split-brain sync state.";
		row.appendChild(receivedNote);
	}

	const signal = document.createElement("div");
	signal.className = "project-inventory-signal mono";
	signal.textContent = strongestSignal(project);
	row.appendChild(signal);

	if (project.suggested_scope_id && project.suggested_scope_id !== project.resolved_scope_id) {
		const suggestion = document.createElement("div");
		suggestion.className = "settings-note project-suggestion-note";
		suggestion.textContent = project.suggestion_reason
			? `Suggestion: ${project.suggestion_reason}`
			: `Suggestion: assign this project to ${scopeSummary(project.suggested_scope_id)}.`;
		row.appendChild(suggestion);
	}

	const warnings = (project.guardrail_warnings ?? []).filter(
		(warning) => warning.severity === "warning",
	);
	if (warnings.length > 0) {
		const warningBox = document.createElement("div");
		warningBox.className = "settings-note project-attention-note";
		warningBox.textContent = `Needs attention: ${warnings.map((warning) => warning.message).join(" ")}`;
		row.appendChild(warningBox);
	}

	if (project.statuses.length > 0) {
		const badges = document.createElement("div");
		badges.className = "project-inventory-badges";
		for (const status of project.statuses) {
			const badge = document.createElement("span");
			badge.className = `project-status-badge ${status}`;
			badge.textContent = formatStatus(status);
			badges.appendChild(badge);
		}
		row.appendChild(badges);
	}

	const detail = document.createElement("details");
	detail.className = "project-inventory-details";
	detail.open = openProjectDetails.has(project.workspace_identity);
	detail.addEventListener("toggle", () => {
		if (detail.open) openProjectDetails.add(project.workspace_identity);
		else openProjectDetails.delete(project.workspace_identity);
	});
	const summary = document.createElement("summary");
	summary.textContent = "Identity and mapping details";
	detail.appendChild(summary);
	const list = document.createElement("dl");
	list.className = "project-detail-grid";
	const fields: Array<[string, string | number | null | undefined]> = [
		["Workspace identity", project.workspace_identity],
		["Project", project.project],
		["CWD", project.cwd],
		["Git remote", project.git_remote],
		["Git branch", project.git_branch],
		["Current Space", projectDomainLabel(project)],
		[
			"Suggested Space",
			project.suggested_scope_id ? scopeSummary(project.suggested_scope_id) : null,
		],
		["Advanced: current Space ID", project.resolved_scope_id],
		["Advanced: suggested Space ID", project.suggested_scope_id],
		["Suggestion reason", project.suggestion_reason],
		["Sessions", project.session_count],
		["Memories", project.memory_count ?? "count unavailable"],
	];
	for (const [label, value] of fields) {
		const dt = document.createElement("dt");
		dt.textContent = label;
		const dd = document.createElement("dd");
		dd.textContent = value == null || value === "" ? "—" : String(value);
		list.append(dt, dd);
	}
	detail.appendChild(list);
	detail.appendChild(renderProjectActions(project));
	row.appendChild(detail);
	return row;
}

function clusterDomainLabel(projects: ProjectScopeInventoryProject[]): string {
	const uniqueLabels = [...new Set(projects.map((project) => projectDomainLabel(project)))];
	return uniqueLabels.length === 1 ? uniqueLabels[0] : "Mixed Spaces";
}

function renderProjectCluster(projects: ProjectScopeInventoryProject[]): HTMLElement {
	if (projects.length === 1) return renderProjectRow(projects[0]);
	const clusterKey = projectClusterKey(projects[0]);
	const row = document.createElement("article");
	row.className = "project-inventory-row project-inventory-cluster";

	const header = document.createElement("div");
	header.className = "project-inventory-row-header";
	const title = document.createElement("div");
	title.className = "project-inventory-title";
	title.textContent = projectClusterLabel(projects[0]);
	header.appendChild(title);
	const domain = document.createElement("div");
	domain.className = "project-inventory-domain";
	domain.textContent = clusterDomainLabel(projects);
	header.appendChild(domain);
	row.appendChild(header);

	const memoryCount = projects.reduce((total, project) => total + (project.memory_count ?? 0), 0);
	const sessionCount = projects.reduce((total, project) => total + project.session_count, 0);
	const meta = document.createElement("div");
	meta.className = "project-inventory-meta";
	meta.textContent = `${projects.length} identities · ${sessionCount.toLocaleString()} sessions · ${memoryCount.toLocaleString()} memories`;
	row.appendChild(meta);

	const actions = document.createElement("div");
	actions.className = "project-inventory-actions";
	const assignableProjects = projects.filter(isLocallyAssignableProject);
	if (assignableProjects.length === 0) {
		const note = document.createElement("div");
		note.className = "settings-note";
		note.textContent = projects.every(isPeerReceivedProject)
			? "These project identities were received from peers. Change project or Space assignments on their source devices."
			: "These project identities cannot be bulk assigned until they have stable local identities. Expand each identity for details.";
		actions.appendChild(note);
		row.appendChild(actions);
	} else {
		const hasGuardrailWarnings = assignableProjects.some(
			(project) => (project.guardrail_warnings ?? []).length > 0,
		);
		const suggestedScopes = new Set(
			assignableProjects
				.map((project) => project.suggested_scope_id)
				.filter((scopeId): scopeId is string => Boolean(scopeId)),
		);
		const resolvedScopes = new Set(assignableProjects.map((project) => project.resolved_scope_id));
		const select = document.createElement("select");
		select.className = "project-domain-select";
		select.setAttribute("aria-label", `Space for ${projectClusterLabel(projects[0])} group`);
		const placeholder = document.createElement("option");
		placeholder.value = "";
		placeholder.textContent = "Choose Space…";
		select.appendChild(placeholder);
		appendAssignableScopeOptions(select);
		select.value = firstSafeSelection(draftClusterDomainSelections.get(clusterKey));
		const save = document.createElement("button");
		save.className = "settings-button";
		save.type = "button";
		save.textContent = `Save Space for ${assignableProjects.length} identit${assignableProjects.length === 1 ? "y" : "ies"}`;
		save.disabled = !select.value || hasGuardrailWarnings;
		save.addEventListener(
			"click",
			() => void saveProjectClusterMapping(assignableProjects, select.value),
		);
		select.addEventListener("change", () => {
			if (select.value) draftClusterDomainSelections.set(clusterKey, select.value);
			else draftClusterDomainSelections.delete(clusterKey);
			save.disabled = !select.value || hasGuardrailWarnings;
		});
		select.addEventListener("blur", refreshSkippedProjectDataAfterSelectBlur);
		actions.append(select, save);
		if (suggestedScopes.size > 1 || resolvedScopes.size > 1 || hasGuardrailWarnings) {
			const note = document.createElement("div");
			note.className = "settings-note project-attention-note";
			note.textContent = hasGuardrailWarnings
				? "One or more identities in this group need individual review before bulk assignment."
				: "This group has mixed suggestions or current Spaces. Choose a Space explicitly before bulk assignment.";
			actions.appendChild(note);
		}
		row.appendChild(actions);
	}

	const details = document.createElement("details");
	details.className = "project-inventory-details";
	details.open = openProjectClusters.has(clusterKey);
	details.addEventListener("toggle", () => {
		if (details.open) openProjectClusters.add(clusterKey);
		else openProjectClusters.delete(clusterKey);
	});
	const summary = document.createElement("summary");
	summary.textContent = "Show identities in this project";
	details.appendChild(summary);
	for (const project of projects) details.appendChild(renderProjectRow(project));
	row.appendChild(details);
	return row;
}

function projectClusters(
	projects: ProjectScopeInventoryProject[],
): ProjectScopeInventoryProject[][] {
	const byKey = new Map<string, ProjectScopeInventoryProject[]>();
	for (const project of projects) {
		const key = projectClusterKey(project);
		byKey.set(key, [...(byKey.get(key) ?? []), project]);
	}
	return [...byKey.values()];
}

function renderEmpty(message: string) {
	const list = el<HTMLDivElement>("projectsInventoryList");
	if (!list) return;
	list.textContent = "";
	const empty = document.createElement("div");
	empty.className = "settings-note";
	empty.textContent = message;
	list.appendChild(empty);
}

function renderProjectInventory(result: {
	projects: ProjectScopeInventoryProject[];
	total: number;
	offset: number;
	has_more: boolean;
}) {
	const meta = el<HTMLDivElement>("projectsInventoryMeta");
	const list = el<HTMLDivElement>("projectsInventoryList");
	if (!meta || !list) return;
	list.textContent = "";
	if (result.projects.length === 0) {
		renderEmpty("No projects match those filters.");
	} else {
		for (const cluster of projectClusters(result.projects))
			list.appendChild(renderProjectCluster(cluster));
	}
	meta.textContent =
		result.total === 0
			? "0 project identities found"
			: `${result.total} project identit${result.total === 1 ? "y" : "ies"} found · showing ${result.offset + 1}-${Math.min(result.offset + result.projects.length, result.total)}`;
	const prev = el<HTMLButtonElement>("projectsPrevPage");
	const next = el<HTMLButtonElement>("projectsNextPage");
	if (prev) prev.disabled = result.offset === 0;
	if (next) next.disabled = !result.has_more;
}

function refreshProjectCoordinatorGroupNamesInBackground(result: {
	projects: ProjectScopeInventoryProject[];
	total: number;
	offset: number;
	has_more: boolean;
}) {
	void refreshProjectCoordinatorGroupNames().then(() => {
		if (isProjectSpaceSelectActive()) return;
		renderProjectInventory(result);
	});
}

export async function loadProjectsData() {
	const meta = el<HTMLDivElement>("projectsInventoryMeta");
	const list = el<HTMLDivElement>("projectsInventoryList");
	if (!meta || !list) return;
	if (isProjectSpaceSelectActive()) {
		skippedProjectRefreshForActiveSelect = true;
		return;
	}
	skippedProjectRefreshForActiveSelect = false;
	meta.textContent = "Loading project inventory…";
	try {
		const [result, settings] = await Promise.all([
			api.loadProjectScopeInventory({
				limit: lastLimit,
				offset: currentOffset,
				q: el<HTMLInputElement>("projectsSearch")?.value.trim() || undefined,
				status: el<HTMLSelectElement>("projectsStatusFilter")?.value || undefined,
			}),
			api.loadSharingDomainSettings(),
		]);
		scopes = settings.scopes;
		renderProjectInventory(result);
		refreshProjectCoordinatorGroupNamesInBackground(result);
	} catch (error) {
		meta.textContent = "Project inventory failed to load.";
		renderEmpty(error instanceof Error ? error.message : "Unable to load project inventory.");
	}
}

export function initProjectsTab(refresh: RefreshFn) {
	refreshProjects = refresh;
	const status = el<HTMLSelectElement>("projectsStatusFilter");
	if (status && status.options.length === 0) {
		for (const [value, label] of STATUS_OPTIONS) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = label;
			status.appendChild(option);
		}
	}
	const requestRefresh = () => {
		currentOffset = 0;
		refreshProjects?.();
	};
	el<HTMLInputElement>("projectsSearch")?.addEventListener("input", requestRefresh);
	status?.addEventListener("change", requestRefresh);
	el<HTMLButtonElement>("projectsPrevPage")?.addEventListener("click", () => {
		currentOffset = Math.max(0, currentOffset - lastLimit);
		refreshProjects?.();
	});
	el<HTMLButtonElement>("projectsNextPage")?.addEventListener("click", () => {
		currentOffset += lastLimit;
		refreshProjects?.();
	});
}
