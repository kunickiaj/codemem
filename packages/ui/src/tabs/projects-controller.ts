import * as api from "../lib/api";
import type {
	LegacyTeamSetupSummaryResponseV1,
	ProjectScopeGuardrailWarning,
	ProjectScopeInventoryProject,
	RecipientPolicyBlockedItemV1,
	RecipientPolicyIntentGraphV1,
	RecipientPolicyReviewListV1,
	SharingDomainScope,
} from "../lib/api/sync";
import { showGlobalNotice } from "../lib/notice";
import { state } from "../lib/state";
import { openProjectShareFlow, renderProjectShareFlow } from "./project-sharing";
import { renderProjectInventory as renderProjectInventoryView } from "./projects/ProjectInventory";
import type {
	ProjectInventoryCallbacks,
	ProjectInventoryClusterViewModel,
	ProjectInventoryProjectViewModel,
	ProjectsInventoryController,
	ProjectsInventoryViewModel,
} from "./projects-inventory-model";
import {
	markProjectTeamSetupEntryUnavailable,
	renderProjectTeamSetupEntry as renderProjectTeamSetupEntryView,
} from "./projects-team-setup-view";
import {
	mountRecipientPolicyManagement,
	openRecipientPolicyManagement,
} from "./recipient-policy-management";
import {
	isRecipientPolicyManageableProject,
	toRecipientPolicyManagementProjects,
} from "./recipient-policy-projects";
import {
	renderRecipientPolicyReview,
	renderRecipientPolicyReviewLoadError,
} from "./recipient-policy-review";
import { openSyncInputDialog } from "./sync/sync-dialogs";

type RefreshFn = () => void;

const STATUS_OPTIONS = [
	["", "All projects"],
	["needs_attention", "Sharing undecided"],
	["suggested", "Has suggestion"],
	["local_only", "Stays on this device"],
	["received", "From other devices"],
	["explicitly_mapped", "Already assigned"],
	["legacy_review", "Older shared data"],
	["unmapped", "Missing project identity"],
] as const;

let refreshProjects: RefreshFn | null = null;
let currentOffset = 0;
const lastLimit = 250;
const maxRepairLookupPages = 100;
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
const projectInventoryByIdentity = new Map<string, ProjectScopeInventoryProject>();
let coordinatorGroupNamesCurrent = false;
let projectShareInventoryReady = false;
let projectsLoadGeneration = 0;
let latestProjectsLoad: Promise<boolean> | null = null;
let projectsUserNavigationGeneration = 0;
let teamSetupEntryLoadGeneration = 0;
let recipientPolicyRepairInFlight: Promise<void> | null = null;
type TeamSetupSummaryResult =
	| { ok: true; summary: LegacyTeamSetupSummaryResponseV1 }
	| { ok: false };
let teamSetupSummaryInFlight: Promise<TeamSetupSummaryResult> | null = null;
const selectedProjectIds = new Set<string>();
const emptyRecipientPolicyIntent: RecipientPolicyIntentGraphV1 = {
	version: 1,
	identities: [],
	teams: [],
	teamMemberships: [],
	identityDevices: [],
	projectRecipients: [],
};
let recipientPolicyIntent = emptyRecipientPolicyIntent;
let recipientPolicyIntentReady = false;
let openTeamSetup: ((candidateRef: string) => void) | undefined;
let latestInventoryResult: {
	projects: ProjectScopeInventoryProject[];
	total: number;
	offset: number;
	has_more: boolean;
} = { projects: [], total: 0, offset: 0, has_more: false };
const projectInventoryListeners = new Set<(viewModel: ProjectsInventoryViewModel) => void>();

function notifyProjectInventoryChanged(): void {
	if (projectInventoryListeners.size === 0) return;
	const viewModel = projectsInventoryViewModel();
	for (const listener of projectInventoryListeners) listener(viewModel);
}

function loadTeamSetupSummaryOnce(
	forceFresh = false,
	options: { signal?: AbortSignal } = {},
): Promise<TeamSetupSummaryResult> {
	if (!forceFresh && teamSetupSummaryInFlight) return teamSetupSummaryInFlight;
	const request = api
		.loadLegacyTeamSetupSummary(options)
		.then((summary) => ({ ok: true as const, summary }))
		.catch(() => ({ ok: false as const }));
	teamSetupSummaryInFlight = request;
	void request.then(() => {
		if (teamSetupSummaryInFlight === request) teamSetupSummaryInFlight = null;
	});
	return request;
}

function loadRequiredTeamSetupSummary(
	options: ProjectsDataLoadOptions,
): Promise<TeamSetupSummaryResult> {
	return loadTeamSetupSummaryOnce(
		options.awaitTeamSetupSummary === true || options.requireTeamSetupSummary === true,
		options,
	);
}

function el<T extends HTMLElement>(id: string): T | null {
	return document.getElementById(id) as T | null;
}

function isPeerReceivedProject(project: ProjectScopeInventoryProject): boolean {
	return project.read_only === true && project.read_only_reason === "peer_received";
}

function isLocallyAssignableProject(project: ProjectScopeInventoryProject): boolean {
	return project.identity_source !== "unmapped" && !isPeerReceivedProject(project);
}

function isProjectShareEligible(project: ProjectScopeInventoryProject): boolean {
	return (
		isLocallyAssignableProject(project) &&
		project.memory_count != null &&
		project.guardrail_warnings.every((warning) => !warning.requires_confirmation)
	);
}

function cacheProjectInventoryProject(project: ProjectScopeInventoryProject): void {
	const existing = projectInventoryByIdentity.get(project.workspace_identity);
	if (!existing || (isPeerReceivedProject(existing) && !isPeerReceivedProject(project))) {
		projectInventoryByIdentity.set(project.workspace_identity, project);
	}
}

function uniqueProjectIds(projects: ProjectScopeInventoryProject[]): string[] {
	return [...new Set(projects.map((project) => project.workspace_identity))].sort();
}

function updateSelectionControls() {
	const count = selectedProjectIds.size;
	const shareSelected = el<HTMLButtonElement>("projectsShareSelected");
	if (shareSelected) {
		shareSelected.textContent =
			count === 0 ? "Add Teams or Identities" : `Add Teams or Identities (${count})`;
		shareSelected.disabled =
			count === 0 || !projectShareInventoryReady || !recipientPolicyIntentReady;
		shareSelected.classList.add("project-selection-target");
	}
	const status = el<HTMLElement>("projectsSelectionStatus");
	if (status) {
		status.setAttribute("role", "status");
		status.setAttribute("aria-live", "polite");
		status.textContent = `${count.toLocaleString()} Project${count === 1 ? "" : "s"} selected.`;
	}
	renderCurrentProjectInventory();
}

function setProjectSelection(projectIds: string[]) {
	const allSelected = projectIds.every((projectId) => selectedProjectIds.has(projectId));
	for (const projectId of projectIds) {
		if (allSelected) selectedProjectIds.delete(projectId);
		else selectedProjectIds.add(projectId);
	}
	updateSelectionControls();
	notifyProjectInventoryChanged();
}

type RecipientChip = { key: string; kind: "Team" | "Identity"; displayName: string };

function recipientChips(projectIds: string[]): RecipientChip[] {
	if (!recipientPolicyIntentReady) return [];
	const projectIdSet = new Set(projectIds);
	const teams = new Map(
		recipientPolicyIntent.teams
			.filter((team) => team.status === "active")
			.map((team) => [team.teamId, team.displayName]),
	);
	const identities = new Map(
		recipientPolicyIntent.identities
			.filter((identity) => identity.status === "active" || identity.status === "pending")
			.map((identity) => [identity.identityId, identity.displayName]),
	);
	const chips = new Map<string, RecipientChip>();
	for (const edge of recipientPolicyIntent.projectRecipients) {
		if (edge.status !== "active" || !projectIdSet.has(edge.canonicalProjectIdentity)) continue;
		if (edge.recipientKind === "team") {
			const displayName = teams.get(edge.teamId);
			if (displayName) {
				chips.set(`team:${edge.teamId}`, {
					key: `team:${edge.teamId}`,
					kind: "Team",
					displayName,
				});
			}
		} else {
			const displayName = identities.get(edge.identityId);
			if (displayName) {
				chips.set(`identity:${edge.identityId}`, {
					key: `identity:${edge.identityId}`,
					kind: "Identity",
					displayName,
				});
			}
		}
	}
	return [...chips.values()].sort((left, right) =>
		`${left.kind}:${left.displayName}`.localeCompare(`${right.kind}:${right.displayName}`),
	);
}

function projectClusterKey(project: ProjectScopeInventoryProject): string {
	if (project.git_remote) return `git:${project.git_remote}`;
	if (project.project) return `project:${project.project}`;
	return `identity:${project.workspace_identity}`;
}

function projectClusterLabel(project: ProjectScopeInventoryProject): string {
	return project.project || project.display_project || "Unnamed Project";
}

function teamName(groupId: string | null | undefined): string | null {
	const normalized = String(groupId || "").trim();
	if (!normalized) return null;
	const group = state.lastProjectCoordinatorAdminGroups.find(
		(item) => String(item.group_id || "").trim() === normalized && !item.archived_at,
	);
	return group?.display_name || "Team details unavailable";
}

function knownActiveCoordinatorGroupIds(): Set<string> {
	return new Set(
		state.lastProjectCoordinatorAdminGroups
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
	let status: typeof state.lastCoordinatorAdminStatus;
	try {
		const payload = await api.loadCoordinatorAdminStatus();
		status =
			payload && typeof payload === "object"
				? (payload as typeof state.lastCoordinatorAdminStatus)
				: null;
	} catch {
		state.lastProjectCoordinatorAdminGroups = [];
		coordinatorGroupNamesCurrent = false;
		return;
	}
	if (status?.readiness !== "ready" || !status.has_admin_secret) {
		state.lastProjectCoordinatorAdminGroups = [];
		coordinatorGroupNamesCurrent = false;
		return;
	}
	try {
		const payload = (await api.loadCoordinatorAdminGroupsFiltered(false)) as {
			items?: typeof state.lastProjectCoordinatorAdminGroups;
		};
		state.lastProjectCoordinatorAdminGroups = Array.isArray(payload?.items) ? payload.items : [];
		coordinatorGroupNamesCurrent = true;
	} catch {
		state.lastProjectCoordinatorAdminGroups = [];
		coordinatorGroupNamesCurrent = false;
	}
}

function scopeDisplayLabel(scope: SharingDomainScope): string {
	const name =
		scope.kind === "team_default"
			? `${scope.label || "Untitled Space"} (default)`
			: scope.label || "Untitled Space";
	const team = teamName(scope.group_id);
	if (team) return `${name} · Team: ${team}`;
	if (scope.authority_type === "local") return `${name} · Local device`;
	if (scope.authority_type === "coordinator") return `${name} · Coordinator Space`;
	return `${name} · ${scope.authority_type || "Other"} Space`;
}

function assignableScopes(): SharingDomainScope[] {
	return scopes.filter(
		(scope) =>
			scope.scope_id !== "legacy-shared-review" && !isFromKnownInactiveCoordinatorGroup(scope),
	);
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
		notifyProjectInventoryChanged();
		showGlobalNotice("Space assignment updated. Device access unchanged.");
		refreshProjects?.();
	} catch (error) {
		if (error instanceof api.SharingDomainGuardrailConfirmationError) {
			pendingConfirmations.set(project.workspace_identity, {
				requiredGuardrailTokens: error.requiredGuardrailTokens,
				scopeId,
				warnings: error.guardrailWarnings,
			});
			renderCurrentProjectInventory();
			notifyProjectInventoryChanged();
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
			`Updated ${assignable.length} project identit${assignable.length === 1 ? "y" : "ies"}. Device access unchanged.`,
		);
		draftClusterDomainSelections.delete(projectClusterKey(assignable[0]));
		notifyProjectInventoryChanged();
		refreshProjects?.();
	} catch (error) {
		showGlobalNotice(projectClusterMappingError(error), "warning");
	}
}

function projectClusterMappingError(error: unknown): string {
	if (error instanceof api.SharingDomainGuardrailConfirmationError) {
		return "One or more identities in this group need review before bulk assignment. Expand the group and save those identities directly.";
	}
	if (error instanceof Error) return error.message;
	return "Unable to update project Spaces.";
}

async function removeProjectMapping(project: ProjectScopeInventoryProject) {
	if (project.mapping_id == null) return;
	try {
		await api.deleteSharingDomainProjectMapping(project.mapping_id);
		pendingConfirmations.delete(project.workspace_identity);
		draftDomainSelections.delete(project.workspace_identity);
		notifyProjectInventoryChanged();
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
		notifyProjectInventoryChanged();
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
			renderCurrentProjectInventory();
			notifyProjectInventoryChanged();
			refreshProjects?.();
			return;
		}
		showGlobalNotice(
			error instanceof Error ? error.message : "Unable to forget project memories.",
			"warning",
		);
	}
}

async function reassignInventoryProject(project: ProjectScopeInventoryProject) {
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

async function projectForRepair(
	projectIdentity: string,
): Promise<{ offset: number; project: ProjectScopeInventoryProject } | null> {
	const cached = projectInventoryByIdentity.get(projectIdentity);
	if (cached && !isPeerReceivedProject(cached)) return { offset: currentOffset, project: cached };
	try {
		let offset = 0;
		let pagesScanned = 0;
		while (true) {
			const result = await api.loadProjectScopeInventory({
				limit: lastLimit,
				offset,
				q: projectIdentity,
			});
			pagesScanned += 1;
			const project = result.projects.find(
				(candidate) =>
					candidate.workspace_identity === projectIdentity && !isPeerReceivedProject(candidate),
			);
			if (project) return { offset: result.offset, project };
			if (!result.has_more || result.limit <= 0) return null;
			const nextOffset = result.offset + result.limit;
			if (nextOffset <= offset || pagesScanned >= maxRepairLookupPages) return null;
			offset = nextOffset;
		}
	} catch {
		return null;
	}
}

function focusProjectAdministration(projectIdentity: string): boolean {
	const row = [...document.querySelectorAll<HTMLElement>("[data-project-workspace-identity]")].find(
		(candidate) =>
			candidate.dataset.projectWorkspaceIdentity === projectIdentity &&
			candidate.dataset.projectRepairable === "true",
	);
	if (!row) return false;
	const details = row.querySelector<HTMLDetailsElement>(".project-inventory-details");
	if (!details) return false;
	const clusterKey = row.dataset.projectClusterKey;
	const cluster = clusterKey
		? [...document.querySelectorAll<HTMLElement>(".project-inventory-cluster")].find(
				(candidate) => candidate.dataset.projectClusterKey === clusterKey,
			)
		: null;
	const clusterDetails = cluster?.querySelector<HTMLDetailsElement>(".project-inventory-details");
	if (clusterDetails) {
		clusterDetails.open = true;
		const clusterKey = cluster?.dataset.projectClusterKey;
		if (clusterKey) openProjectClusters.add(clusterKey);
	}
	details.open = true;
	openProjectDetails.add(`${row.dataset.projectRepairable}:${projectIdentity}`);
	details.scrollIntoView?.({ block: "center", behavior: "smooth" });
	details.querySelector<HTMLElement>("summary")?.focus();
	return true;
}

interface ProjectNavigationSnapshot {
	generation: number;
	search: string;
	status: string;
	offset: number;
}

function projectNavigationSnapshot(): ProjectNavigationSnapshot {
	return {
		generation: projectsUserNavigationGeneration,
		search: el<HTMLInputElement>("projectsSearch")?.value ?? "",
		status: el<HTMLSelectElement>("projectsStatusFilter")?.value ?? "",
		offset: currentOffset,
	};
}

function projectNavigationChanged(snapshot: ProjectNavigationSnapshot): boolean {
	return (
		projectsUserNavigationGeneration !== snapshot.generation ||
		(el<HTMLInputElement>("projectsSearch")?.value ?? "") !== snapshot.search ||
		(el<HTMLSelectElement>("projectsStatusFilter")?.value ?? "") !== snapshot.status ||
		currentOffset !== snapshot.offset
	);
}

async function openProjectAdministrationFromRepair(target: {
	offset: number;
	project: ProjectScopeInventoryProject;
}): Promise<void> {
	const { project } = target;
	if (focusProjectAdministration(project.workspace_identity)) return;
	const search = el<HTMLInputElement>("projectsSearch");
	const status = el<HTMLSelectElement>("projectsStatusFilter");
	const previous = projectNavigationSnapshot();
	const repairSearch = project.workspace_identity;
	if (search) search.value = repairSearch;
	if (status) status.value = "";
	currentOffset = target.offset;
	const repairGeneration = projectsUserNavigationGeneration;
	await loadProjectsData();
	if (focusProjectAdministration(project.workspace_identity)) return;
	if (
		projectsUserNavigationGeneration !== repairGeneration ||
		(search && search.value !== repairSearch) ||
		(status && status.value !== "") ||
		currentOffset !== target.offset
	) {
		return;
	}
	if (search) search.value = previous.search;
	if (status) status.value = previous.status;
	currentOffset = previous.offset;
	await loadProjectsData();
	showGlobalNotice(
		"Project administration could not be opened. Refresh Projects and try again.",
		"warning",
	);
}

async function performRecipientPolicyRepair(
	repair: RecipientPolicyBlockedItemV1["repair"],
): Promise<void> {
	if (isProjectSpaceSelectActive()) {
		showGlobalNotice("Finish the open Space assignment, then try Repair again.", "warning");
		return;
	}
	const navigation = projectNavigationSnapshot();
	const target = await projectForRepair(repair.projectIdentity);
	if (projectNavigationChanged(navigation)) return;
	if (isProjectSpaceSelectActive()) {
		showGlobalNotice("Finish the open Space assignment, then try Repair again.", "warning");
		return;
	}
	if (!target) {
		showGlobalNotice(
			"This Project is not visible in the current inventory. Refresh Projects, then try Repair again.",
			"warning",
		);
		return;
	}
	const { project } = target;
	if (repair.kind === "reassign_project") {
		if (project.identity_source === "unmapped" || project.session_count === 0) {
			showGlobalNotice(
				"This Project cannot be reassigned yet because it has no local sessions with stable source evidence.",
				"warning",
			);
			return;
		}
		await reassignInventoryProject(project);
		return;
	}
	await openProjectAdministrationFromRepair(target);
}

function repairRecipientPolicyItem(repair: RecipientPolicyBlockedItemV1["repair"]): Promise<void> {
	const requestedNavigationGeneration = projectsUserNavigationGeneration;
	const operation = (
		recipientPolicyRepairInFlight?.catch(() => undefined) ?? Promise.resolve()
	).then(async () => {
		if (projectsUserNavigationGeneration !== requestedNavigationGeneration) return;
		try {
			await performRecipientPolicyRepair(repair);
		} catch (error) {
			showGlobalNotice(
				error instanceof Error ? error.message : "Unable to repair this Project.",
				"warning",
			);
		}
	});
	recipientPolicyRepairInFlight = operation;
	operation.then(
		() => {
			if (recipientPolicyRepairInFlight === operation) recipientPolicyRepairInFlight = null;
		},
		() => {
			if (recipientPolicyRepairInFlight === operation) recipientPolicyRepairInFlight = null;
		},
	);
	return operation;
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

function projectViewModel(project: ProjectScopeInventoryProject): ProjectInventoryProjectViewModel {
	const manageable = isRecipientPolicyManageableProject(project);
	const locallyAssignable = isLocallyAssignableProject(project);
	const detailKey = `${locallyAssignable}:${project.workspace_identity}`;
	const pending = locallyAssignable
		? pendingConfirmations.get(project.workspace_identity)
		: undefined;
	const pendingForget = locallyAssignable
		? pendingForgetConfirmations.get(project.workspace_identity)
		: undefined;
	return {
		kind: "project",
		key: project.workspace_identity,
		detailKey,
		project,
		manageable,
		selected: manageable && selectedProjectIds.has(project.workspace_identity),
		shareEligible: isProjectShareEligible(project),
		shareReady: projectShareInventoryReady,
		detailsOpen: openProjectDetails.has(detailKey),
		draftScopeId: draftDomainSelections.get(project.workspace_identity) ?? null,
		pendingConfirmation: pending
			? {
					requiredGuardrailTokens: [...pending.requiredGuardrailTokens],
					scopeId: pending.scopeId,
					warnings: [...pending.warnings],
				}
			: null,
		pendingForgetConfirmation: pendingForget ? { ...pendingForget } : null,
		recipients: recipientChips([project.workspace_identity]),
	};
}

function inventoryRowViewModel(
	projects: ProjectScopeInventoryProject[],
): ProjectInventoryProjectViewModel | ProjectInventoryClusterViewModel {
	if (projects.length === 1) return projectViewModel(projects[0]);
	const key = projectClusterKey(projects[0]);
	const projectIds = uniqueProjectIds(projects.filter(isRecipientPolicyManageableProject));
	return {
		kind: "cluster",
		key,
		label: projectClusterLabel(projects[0]),
		projects: projects.map(projectViewModel),
		projectIds,
		selectedProjectIds: projectIds.filter((projectId) => selectedProjectIds.has(projectId)),
		detailsOpen: openProjectClusters.has(key),
		draftScopeId: draftClusterDomainSelections.get(key) ?? null,
		recipients: recipientChips(projectIds),
	};
}

function projectsInventoryViewModel(): ProjectsInventoryViewModel {
	const selectedIds = [...selectedProjectIds].sort();
	return {
		rows: projectClusters(latestInventoryResult.projects).map(inventoryRowViewModel),
		recipientPolicyReady: recipientPolicyIntentReady,
		shareInventoryReady: projectShareInventoryReady,
		scopeLabels: Object.fromEntries(
			scopes.map((scope) => [scope.scope_id, scopeDisplayLabel(scope)]),
		),
		selection: {
			projectIds: selectedIds,
			count: selectedIds.length,
			ready: projectShareInventoryReady && recipientPolicyIntentReady,
		},
		pagination: {
			offset: latestInventoryResult.offset,
			limit: lastLimit,
			total: latestInventoryResult.total,
			hasMore: latestInventoryResult.has_more,
		},
		scopeGroups: groupedAssignableScopes().map((group) => ({
			label: group.label,
			scopes: [...group.scopes],
		})),
		statusOptions: STATUS_OPTIONS.map(([value, label]) => ({ label, value })),
	};
}

function hideProjectInventorySkeleton() {
	document.getElementById("projectsInventorySkeleton")?.remove();
}

function projectInventoryMetaText(result: {
	projects: ProjectScopeInventoryProject[];
	total: number;
	offset: number;
}): string {
	if (result.total === 0) return "0 projects";
	const lastVisible = Math.min(result.offset + result.projects.length, result.total);
	return `${result.total.toLocaleString()} projects · ${result.offset + 1}–${lastVisible}`;
}

function renderCurrentProjectInventory(error?: string): void {
	const list = el<HTMLDivElement>("projectsInventoryList");
	if (!list) return;
	renderProjectInventoryView(list, projectsInventoryViewModel(), projectInventoryCallbacks, error);
}

function renderProjectInventory(result: {
	projects: ProjectScopeInventoryProject[];
	total: number;
	offset: number;
	has_more: boolean;
}) {
	latestInventoryResult = {
		projects: [...result.projects],
		total: result.total,
		offset: result.offset,
		has_more: result.has_more,
	};
	const meta = el<HTMLDivElement>("projectsInventoryMeta");
	const list = el<HTMLDivElement>("projectsInventoryList");
	if (!meta || !list) return;
	hideProjectInventorySkeleton();
	projectInventoryByIdentity.clear();
	for (const project of result.projects) cacheProjectInventoryProject(project);
	renderCurrentProjectInventory();
	meta.textContent = projectInventoryMetaText(result);
	const prev = el<HTMLButtonElement>("projectsPrevPage");
	const next = el<HTMLButtonElement>("projectsNextPage");
	if (prev) prev.disabled = result.offset === 0;
	if (next) next.disabled = !result.has_more;
	updateSelectionControls();
	notifyProjectInventoryChanged();
}

function refreshProjectCoordinatorGroupNamesInBackground(
	result: {
		projects: ProjectScopeInventoryProject[];
		total: number;
		offset: number;
		has_more: boolean;
	},
	loadGeneration: number,
	filters: ProjectInventoryFilters,
) {
	void refreshProjectCoordinatorGroupNames().then(() => {
		if (loadGeneration !== projectsLoadGeneration) return;
		if (!projectInventoryFiltersAreCurrent(filters)) return;
		if (isProjectSpaceSelectActive()) return;
		renderProjectInventory(result);
	});
}

async function loadAllProjectShareChoices(
	options: { signal?: AbortSignal } = {},
): Promise<ProjectScopeInventoryProject[]> {
	const projects = new Map<string, ProjectScopeInventoryProject>();
	let offset = 0;
	while (true) {
		const page = await api.loadProjectScopeInventory({
			limit: 250,
			offset,
			signal: options.signal,
		});
		for (const project of page.projects) projects.set(project.workspace_identity, project);
		if (!page.has_more) break;
		offset += page.limit;
	}
	return [...projects.values()];
}

interface ProjectInventoryFilters {
	query: string;
	status: string;
	offset: number;
}

function readProjectInventoryFilters(): ProjectInventoryFilters {
	return {
		query: el<HTMLInputElement>("projectsSearch")?.value.trim() ?? "",
		status: el<HTMLSelectElement>("projectsStatusFilter")?.value ?? "",
		offset: currentOffset,
	};
}

function projectInventoryFiltersAreCurrent(filters: ProjectInventoryFilters): boolean {
	const current = readProjectInventoryFilters();
	return (
		current.query === filters.query &&
		current.status === filters.status &&
		current.offset === filters.offset
	);
}

function loadProjectInventoryPage(
	options: ProjectsDataLoadOptions,
	filters: ProjectInventoryFilters,
) {
	return api.loadProjectScopeInventory({
		limit: lastLimit,
		offset: filters.offset,
		q: filters.query || undefined,
		status: filters.status || undefined,
		signal: options.signal,
	});
}

function mountProjectRecipientManagement(
	projects: ProjectScopeInventoryProject[],
	intent: RecipientPolicyIntentGraphV1,
	loadError: boolean,
) {
	const mount = el<HTMLDivElement>("recipientPolicyManagementMount");
	if (!mount) return;
	mountRecipientPolicyManagement(mount, toRecipientPolicyManagementProjects(projects), intent, {
		loadError,
		onCommitted: (result) => {
			if (result.status === "applied") selectedProjectIds.clear();
			updateSelectionControls();
			notifyProjectInventoryChanged();
			refreshProjects?.();
		},
	});
}

function recipientPolicyReviewContentMount(mount: HTMLElement): HTMLElement {
	const existing = mount.querySelector<HTMLElement>(
		":scope > .project-recipient-policy-review-content",
	);
	if (existing) return existing;
	const content = document.createElement("div");
	content.className = "project-recipient-policy-review-content";
	mount.prepend(content);
	return content;
}

function renderProjectTeamSetupEntry(
	mount: HTMLElement,
	summary: LegacyTeamSetupSummaryResponseV1 | undefined,
): void {
	renderProjectTeamSetupEntryView(mount, summary, {
		onOpenTeamSetup: openTeamSetup,
		onFocusFallback: () => el<HTMLInputElement>("projectsSearch")?.focus(),
	});
}

export interface ProjectsDataLoadOptions {
	awaitTeamSetupSummary?: boolean;
	requireTeamSetupSummary?: boolean;
	signal?: AbortSignal;
}

export function loadProjectsData(options: ProjectsDataLoadOptions = {}): Promise<boolean> {
	const operation = loadProjectsDataOperation(options);
	latestProjectsLoad = operation;
	return operation;
}

async function supersededProjectsLoad(
	options: ProjectsDataLoadOptions,
	teamSetupSummaryPromise: Promise<TeamSetupSummaryResult> | null,
): Promise<boolean> {
	if (options.signal?.aborted) return false;
	if (!options.awaitTeamSetupSummary && !options.requireTeamSetupSummary)
		return latestProjectsLoad ?? false;
	await teamSetupSummaryPromise;
	return false;
}

function isCurrentProjectsLoad(loadGeneration: number, options: ProjectsDataLoadOptions): boolean {
	return !options.signal?.aborted && loadGeneration === projectsLoadGeneration;
}

function waitsForTeamSetupSummary(options: ProjectsDataLoadOptions): boolean {
	return options.awaitTeamSetupSummary === true || options.requireTeamSetupSummary === true;
}

async function loadProjectsWithoutInventory(options: ProjectsDataLoadOptions): Promise<boolean> {
	if (!waitsForTeamSetupSummary(options)) return true;
	const summary = await loadRequiredTeamSetupSummary(options);
	if (options.signal?.aborted) return false;
	return !options.requireTeamSetupSummary || summary.ok;
}

async function loadProjectsWhileSelectActive(options: ProjectsDataLoadOptions): Promise<boolean> {
	skippedProjectRefreshForActiveSelect = true;
	if (!waitsForTeamSetupSummary(options)) return true;
	const entryLoadGeneration = ++teamSetupEntryLoadGeneration;
	// Completion refresh must remove the setup card without replacing the
	// focused Space select or moving the user's cursor in Project inventory.
	const teamSetupSummary = await loadRequiredTeamSetupSummary(options);
	if (options.signal?.aborted || entryLoadGeneration !== teamSetupEntryLoadGeneration) return false;
	const reviewMount = el<HTMLDivElement>("recipientPolicyReviewMount");
	if (!teamSetupSummary.ok) {
		if (reviewMount) markProjectTeamSetupEntryUnavailable(reviewMount);
		return !options.requireTeamSetupSummary;
	}
	if (reviewMount) renderProjectTeamSetupEntry(reviewMount, teamSetupSummary.summary);
	return true;
}

function finishProjectsLoad(input: {
	entryLoadGeneration: number;
	loadGeneration: number;
	options: ProjectsDataLoadOptions;
	requiredLoadSucceeded: boolean;
	teamSetupSummaryPromise: Promise<TeamSetupSummaryResult>;
}): boolean | Promise<boolean> {
	if (!waitsForTeamSetupSummary(input.options)) return input.requiredLoadSucceeded;
	return input.teamSetupSummaryPromise.then((teamSetupSummary) => {
		if (
			!isCurrentProjectsLoad(input.loadGeneration, input.options) ||
			input.entryLoadGeneration !== teamSetupEntryLoadGeneration
		)
			return false;
		return (
			input.requiredLoadSucceeded && (!input.options.requireTeamSetupSummary || teamSetupSummary.ok)
		);
	});
}

async function finishFailedProjectsLoad(
	options: ProjectsDataLoadOptions,
	teamSetupSummaryPromise: Promise<TeamSetupSummaryResult> | null,
): Promise<false> {
	if (waitsForTeamSetupSummary(options)) await teamSetupSummaryPromise;
	return false;
}

type RecipientPolicyReviewLoadResult =
	| { ok: true; review: RecipientPolicyReviewListV1 }
	| { ok: false; error: unknown };

function renderProjectsRecipientPolicyReview(result: RecipientPolicyReviewLoadResult): void {
	const reviewMount = el<HTMLDivElement>("recipientPolicyReviewMount");
	if (!reviewMount) return;
	const reviewContent = recipientPolicyReviewContentMount(reviewMount);
	if ("review" in result) {
		renderRecipientPolicyReview(reviewContent, result.review, {
			isRepairAvailable: (repair) => !repair.projectIdentity.startsWith("unmapped:"),
			onRefresh: async () => {
				await loadProjectsData();
			},
			onRepair: repairRecipientPolicyItem,
		});
	} else {
		renderRecipientPolicyReviewLoadError(reviewContent, result.error);
	}
	reviewMount.hidden =
		reviewContent.hidden && !reviewMount.querySelector(".project-team-setup-entry");
}

type ProjectShareInventoryLoadResult =
	| { ok: true; projects: ProjectScopeInventoryProject[] }
	| { ok: false; projects: ProjectScopeInventoryProject[] };
type RecipientPolicyIntentLoadResult =
	| { ok: true; intent: RecipientPolicyIntentGraphV1 }
	| { ok: false; error: unknown };

async function loadProjectsResources(
	options: ProjectsDataLoadOptions,
	filters: ProjectInventoryFilters,
) {
	const [result, settings, shareInventory, recipientPolicyReview, intentResult] = await Promise.all(
		[
			loadProjectInventoryPage(options, filters),
			api.loadSharingDomainSettings(options),
			loadAllProjectShareChoices(options)
				.then((projects): ProjectShareInventoryLoadResult => ({ ok: true, projects }))
				.catch((): ProjectShareInventoryLoadResult => ({ ok: false, projects: [] })),
			api
				.loadRecipientPolicyReview(options)
				.then((review): RecipientPolicyReviewLoadResult => ({ ok: true, review }))
				.catch((error: unknown): RecipientPolicyReviewLoadResult => ({ ok: false, error })),
			api
				.loadRecipientPolicyIntent(options)
				.then((intent): RecipientPolicyIntentLoadResult => ({ ok: true, intent }))
				.catch((error: unknown): RecipientPolicyIntentLoadResult => ({ ok: false, error })),
		],
	);
	return { intentResult, recipientPolicyReview, result, settings, shareInventory };
}

function reconcileSelectedProjects(shareInventory: ProjectShareInventoryLoadResult): void {
	if (!shareInventory.ok) return;
	const availableProjectIds = new Set(
		toRecipientPolicyManagementProjects(shareInventory.projects).map(
			(project) => project.canonicalProjectIdentity,
		),
	);
	for (const selectedProjectId of selectedProjectIds) {
		if (!availableProjectIds.has(selectedProjectId)) selectedProjectIds.delete(selectedProjectId);
	}
}

function renderLoadedProjectResources(
	resources: Awaited<ReturnType<typeof loadProjectsResources>>,
	loadGeneration: number,
	filters: ProjectInventoryFilters,
): boolean {
	const { intentResult, recipientPolicyReview, result, settings, shareInventory } = resources;
	scopes = settings.scopes;
	projectShareInventoryReady = shareInventory.ok;
	recipientPolicyIntentReady = intentResult.ok;
	recipientPolicyIntent = intentResult.ok ? intentResult.intent : emptyRecipientPolicyIntent;
	reconcileSelectedProjects(shareInventory);
	const shareMount = el<HTMLDivElement>("projectShareFlowMount");
	if (shareMount) {
		renderProjectShareFlow(shareMount, shareInventory.projects, {
			inventoryError: !shareInventory.ok,
		});
	}
	renderProjectsRecipientPolicyReview(recipientPolicyReview);
	mountProjectRecipientManagement(
		shareInventory.projects,
		recipientPolicyIntent,
		!shareInventory.ok || !intentResult.ok,
	);
	renderProjectInventory(result);
	refreshProjectCoordinatorGroupNamesInBackground(result, loadGeneration, filters);
	return shareInventory.ok && "review" in recipientPolicyReview && intentResult.ok;
}

function updateProjectTeamSetupAfterLoad(input: {
	entryLoadGeneration: number;
	loadGeneration: number;
	options: ProjectsDataLoadOptions;
	teamSetupSummaryPromise: Promise<TeamSetupSummaryResult>;
}): void {
	void input.teamSetupSummaryPromise.then((teamSetupSummary) => {
		if (
			!isCurrentProjectsLoad(input.loadGeneration, input.options) ||
			input.entryLoadGeneration !== teamSetupEntryLoadGeneration
		)
			return;
		const reviewMount = el<HTMLDivElement>("recipientPolicyReviewMount");
		if (!reviewMount) return;
		if (!teamSetupSummary.ok) {
			markProjectTeamSetupEntryUnavailable(reviewMount);
			return;
		}
		renderProjectTeamSetupEntry(reviewMount, teamSetupSummary.summary);
	});
}

function renderProjectsLoadFailure(error: unknown, meta: HTMLElement): void {
	projectInventoryByIdentity.clear();
	latestInventoryResult = { projects: [], total: 0, offset: currentOffset, has_more: false };
	projectShareInventoryReady = false;
	recipientPolicyIntentReady = false;
	recipientPolicyIntent = emptyRecipientPolicyIntent;
	const shareMount = el<HTMLDivElement>("projectShareFlowMount");
	if (shareMount) renderProjectShareFlow(shareMount, [], { inventoryError: true });
	mountProjectRecipientManagement([], emptyRecipientPolicyIntent, true);
	updateSelectionControls();
	notifyProjectInventoryChanged();
	hideProjectInventorySkeleton();
	meta.textContent = "Project inventory failed to load.";
	renderCurrentProjectInventory(
		error instanceof Error ? error.message : "Unable to load project inventory.",
	);
}

async function loadProjectsDataOperation(options: ProjectsDataLoadOptions): Promise<boolean> {
	const meta = el<HTMLDivElement>("projectsInventoryMeta");
	const list = el<HTMLDivElement>("projectsInventoryList");
	if (!meta || !list) return loadProjectsWithoutInventory(options);
	if (isProjectSpaceSelectActive()) return loadProjectsWhileSelectActive(options);
	skippedProjectRefreshForActiveSelect = false;
	const loadGeneration = ++projectsLoadGeneration;
	const requestedFilters = readProjectInventoryFilters();
	projectShareInventoryReady = false;
	recipientPolicyIntentReady = false;
	updateSelectionControls();
	notifyProjectInventoryChanged();
	meta.textContent = "Loading project inventory…";
	let teamSetupSummaryPromise: Promise<TeamSetupSummaryResult> | null = null;
	try {
		const entryLoadGeneration = ++teamSetupEntryLoadGeneration;
		teamSetupSummaryPromise = loadRequiredTeamSetupSummary(options);
		const resources = await loadProjectsResources(options, requestedFilters);
		if (!isCurrentProjectsLoad(loadGeneration, options)) {
			return supersededProjectsLoad(options, teamSetupSummaryPromise);
		}
		if (!projectInventoryFiltersAreCurrent(requestedFilters)) return false;
		const requiredLoadSucceeded = renderLoadedProjectResources(
			resources,
			loadGeneration,
			requestedFilters,
		);
		// Register the DOM update before the strict await below: callers use the
		// resolved promise as proof that a completed setup card has disappeared.
		updateProjectTeamSetupAfterLoad({
			entryLoadGeneration,
			loadGeneration,
			options,
			teamSetupSummaryPromise,
		});
		return finishProjectsLoad({
			entryLoadGeneration,
			loadGeneration,
			options,
			requiredLoadSucceeded,
			teamSetupSummaryPromise,
		});
	} catch (error) {
		if (!isCurrentProjectsLoad(loadGeneration, options)) {
			return supersededProjectsLoad(options, teamSetupSummaryPromise);
		}
		if (!projectInventoryFiltersAreCurrent(requestedFilters)) return false;
		renderProjectsLoadFailure(error, meta);
		return finishFailedProjectsLoad(options, teamSetupSummaryPromise);
	}
}

function inventoryProject(projectIdentity: string): ProjectScopeInventoryProject | null {
	return (
		projectInventoryByIdentity.get(projectIdentity) ??
		latestInventoryResult.projects.find(
			(project) => project.workspace_identity === projectIdentity,
		) ??
		null
	);
}

const projectInventoryCallbacks: ProjectInventoryCallbacks = {
	toggleSelection(projectIds) {
		setProjectSelection(projectIds);
	},
	shareProject(projectIdentity) {
		const project = inventoryProject(projectIdentity);
		if (!project || !isProjectShareEligible(project) || !projectShareInventoryReady) return;
		openProjectShareFlow([project.workspace_identity]);
	},
	manageRecipients(projectIds) {
		const sortedProjectIds = [...new Set(projectIds)].sort();
		if (sortedProjectIds.length === 0) return;
		if (sortedProjectIds.length === 1) {
			openRecipientPolicyManagement({ mode: "project-manage", projectId: sortedProjectIds[0] });
			return;
		}
		for (const projectId of sortedProjectIds) selectedProjectIds.add(projectId);
		updateSelectionControls();
		notifyProjectInventoryChanged();
		openRecipientPolicyManagement({ mode: "project-add", projectIds: sortedProjectIds });
	},
	setProjectDetailsOpen(key, open) {
		if (open) openProjectDetails.add(key);
		else openProjectDetails.delete(key);
		notifyProjectInventoryChanged();
	},
	setClusterDetailsOpen(key, open) {
		if (open) openProjectClusters.add(key);
		else openProjectClusters.delete(key);
		notifyProjectInventoryChanged();
	},
	setProjectScopeDraft(projectIdentity, scopeId) {
		draftDomainSelections.set(projectIdentity, scopeId);
		pendingConfirmations.delete(projectIdentity);
		renderCurrentProjectInventory();
		notifyProjectInventoryChanged();
		refreshProjects?.();
	},
	setClusterScopeDraft(clusterKey, scopeId) {
		if (scopeId) draftClusterDomainSelections.set(clusterKey, scopeId);
		else draftClusterDomainSelections.delete(clusterKey);
		notifyProjectInventoryChanged();
	},
	async saveProjectScope(projectIdentity, scopeId) {
		const project = inventoryProject(projectIdentity);
		if (project) await saveProjectMapping(project, scopeId);
	},
	async saveClusterScope(clusterKey, scopeId) {
		const projects = latestInventoryResult.projects
			.filter((project) => projectClusterKey(project) === clusterKey)
			.filter(isLocallyAssignableProject);
		if (projects.length > 0) await saveProjectClusterMapping(projects, scopeId);
	},
	async removeProjectScope(projectIdentity) {
		const project = inventoryProject(projectIdentity);
		if (project) await removeProjectMapping(project);
	},
	async keepProjectLocal(projectIdentity) {
		const project = inventoryProject(projectIdentity);
		if (project) await saveProjectMapping(project, "local-default");
	},
	async reassignProject(projectIdentity) {
		const project = inventoryProject(projectIdentity);
		if (project) await reassignInventoryProject(project);
	},
	async forgetProject(projectIdentity, confirmed = false) {
		const project = inventoryProject(projectIdentity);
		if (project) await forgetProjectMemories(project, confirmed);
	},
	async confirmProjectScope(projectIdentity) {
		const project = inventoryProject(projectIdentity);
		const pending = pendingConfirmations.get(projectIdentity);
		if (!project || !pending) return;
		await saveProjectMapping(project, pending.scopeId, pending.requiredGuardrailTokens);
	},
	cancelProjectScopeConfirmation(projectIdentity) {
		pendingConfirmations.delete(projectIdentity);
		notifyProjectInventoryChanged();
		refreshProjects?.();
	},
	cancelProjectForgetConfirmation(projectIdentity) {
		pendingForgetConfirmations.delete(projectIdentity);
		notifyProjectInventoryChanged();
		refreshProjects?.();
	},
	onSpaceSelectBlur() {
		refreshSkippedProjectDataAfterSelectBlur();
	},
};

export function getProjectsInventoryController(): ProjectsInventoryController {
	return {
		getViewModel: projectsInventoryViewModel,
		subscribe(listener) {
			projectInventoryListeners.add(listener);
			return () => {
				projectInventoryListeners.delete(listener);
			};
		},
		callbacks: projectInventoryCallbacks,
	};
}

export function initProjectsTab(
	refresh: RefreshFn,
	options: { onOpenTeamSetup?: (candidateRef: string) => void } = {},
) {
	refreshProjects = refresh;
	openTeamSetup = options.onOpenTeamSetup;
	selectedProjectIds.clear();
	openProjectDetails.clear();
	openProjectClusters.clear();
	draftDomainSelections.clear();
	draftClusterDomainSelections.clear();
	pendingConfirmations.clear();
	pendingForgetConfirmations.clear();
	const status = el<HTMLSelectElement>("projectsStatusFilter");
	if (status && status.options.length === 0) {
		status.append(...STATUS_OPTIONS.map(([value, label]) => new Option(label, value)));
	}
	const requestRefresh = () => {
		projectsUserNavigationGeneration += 1;
		currentOffset = 0;
		refreshProjects?.();
	};
	el<HTMLInputElement>("projectsSearch")?.addEventListener("input", requestRefresh);
	status?.addEventListener("change", requestRefresh);
	el<HTMLButtonElement>("projectsPrevPage")?.addEventListener("click", () => {
		projectsUserNavigationGeneration += 1;
		currentOffset = Math.max(0, currentOffset - lastLimit);
		refreshProjects?.();
	});
	el<HTMLButtonElement>("projectsNextPage")?.addEventListener("click", () => {
		projectsUserNavigationGeneration += 1;
		currentOffset += lastLimit;
		refreshProjects?.();
	});
	const shareSelected = el<HTMLButtonElement>("projectsShareSelected");
	if (shareSelected && shareSelected.dataset.recipientPolicyBound !== "true") {
		shareSelected.dataset.recipientPolicyBound = "true";
		shareSelected.addEventListener("click", () => {
			if (selectedProjectIds.size === 0) return;
			openRecipientPolicyManagement({
				mode: "project-add",
				projectIds: [...selectedProjectIds].sort(),
			});
		});
	}
	updateSelectionControls();
}
