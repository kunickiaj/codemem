import * as api from "../lib/api";
import type {
	ProjectScopeGuardrailWarning,
	ProjectScopeInventoryProject,
	SharingDomainScope,
} from "../lib/api/sync";
import { showGlobalNotice } from "../lib/notice";

type RefreshFn = () => void;

const STATUS_OPTIONS = [
	["", "All statuses"],
	["local_only", "Local only"],
	["unmapped", "Unmapped"],
	["suggested", "Suggested assignment"],
	["explicitly_mapped", "Explicitly mapped"],
	["legacy_review", "Legacy review"],
	["needs_attention", "Review before mapping"],
] as const;

let refreshProjects: RefreshFn | null = null;
let currentOffset = 0;
const lastLimit = 25;
let scopes: SharingDomainScope[] = [];
const openProjectDetails = new Set<string>();
const draftDomainSelections = new Map<string, string>();
const pendingConfirmations = new Map<
	string,
	{ requiredGuardrailTokens: string[]; scopeId: string; warnings: ProjectScopeGuardrailWarning[] }
>();

function el<T extends HTMLElement>(id: string): T | null {
	return document.getElementById(id) as T | null;
}

function formatStatus(status: string): string {
	return STATUS_OPTIONS.find(([value]) => value === status)?.[1] ?? status.replaceAll("_", " ");
}

function formatResolution(reason: string): string {
	switch (reason) {
		case "exact_mapping":
			return "explicit project mapping";
		case "pattern_mapping":
			return "pattern mapping";
		case "explicit_override":
			return "explicit override";
		default:
			return "local-only fallback";
	}
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

function scopeLabel(scopeId: string | null | undefined): string {
	if (!scopeId) return "—";
	const scope = scopes.find((item) => item.scope_id === scopeId);
	return scope?.label ? `${scope.label} (${scope.scope_id})` : scopeId;
}

function assignableScopes(): SharingDomainScope[] {
	return scopes.filter((scope) => scope.scope_id !== "legacy-shared-review");
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
		showGlobalNotice("Project Sharing domain updated. Device access grants are unchanged.");
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
			error instanceof Error ? error.message : "Unable to update project Sharing domain.",
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
		showGlobalNotice("Project Sharing domain mapping removed. The next fallback now applies.");
		refreshProjects?.();
	} catch (error) {
		showGlobalNotice(
			error instanceof Error ? error.message : "Unable to remove project Sharing domain mapping.",
			"warning",
		);
	}
}

function renderProjectActions(project: ProjectScopeInventoryProject): HTMLElement {
	const actions = document.createElement("div");
	actions.className = "project-inventory-actions";
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
	label.textContent = `Sharing domain for ${project.display_project}`;
	const select = document.createElement("select");
	select.id = selectId;
	select.className = "project-domain-select";
	const currentAssignable = assignableScopes().some(
		(scope) => scope.scope_id === project.resolved_scope_id,
	);
	if (!currentAssignable && project.resolved_scope_id) {
		const current = document.createElement("option");
		current.value = project.resolved_scope_id;
		current.textContent = `${scopeLabel(project.resolved_scope_id)} — not assignable`;
		current.disabled = true;
		select.appendChild(current);
	}
	for (const scope of assignableScopes()) {
		const option = document.createElement("option");
		option.value = scope.scope_id;
		option.textContent = scope.label ? `${scope.label} · ${scope.scope_id}` : scope.scope_id;
		select.appendChild(option);
	}
	select.value =
		draftDomainSelections.get(project.workspace_identity) ??
		project.suggested_scope_id ??
		project.resolved_scope_id;

	const save = document.createElement("button");
	save.className = "settings-button";
	save.type = "button";
	save.textContent =
		project.suggested_scope_id && select.value === project.suggested_scope_id
			? "Confirm suggestion"
			: "Save domain";
	save.disabled = select.value === project.resolved_scope_id && !currentAssignable;
	save.addEventListener("click", () => void saveProjectMapping(project, select.value));
	select.addEventListener("change", () => {
		draftDomainSelections.set(project.workspace_identity, select.value);
		save.textContent = "Save domain";
		save.disabled = false;
	});

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

	actions.append(label, select, save, keepLocal, remove);
	const pending = pendingConfirmations.get(project.workspace_identity);
	if (pending) {
		const warningBox = document.createElement("div");
		warningBox.className = "settings-note project-guardrail-confirmation";
		warningBox.setAttribute("role", "alert");
		const title = document.createElement("strong");
		title.textContent = "Review before saving this Sharing domain.";
		const list = document.createElement("ul");
		for (const warning of pending.warnings) {
			const item = document.createElement("li");
			item.textContent = warning.message;
			list.appendChild(item);
		}
		const confirm = document.createElement("button");
		confirm.className = "settings-button";
		confirm.type = "button";
		confirm.textContent = "Confirm and save";
		confirm.addEventListener(
			"click",
			() => void saveProjectMapping(project, pending.scopeId, pending.requiredGuardrailTokens),
		);
		const cancel = document.createElement("button");
		cancel.className = "settings-button";
		cancel.type = "button";
		cancel.textContent = "Cancel";
		cancel.addEventListener("click", () => {
			pendingConfirmations.delete(project.workspace_identity);
			refreshProjects?.();
		});
		warningBox.append(title, list, confirm, cancel);
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
	domain.textContent = scopeLabel(project.resolved_scope_id);
	header.appendChild(domain);
	row.appendChild(header);

	const meta = document.createElement("div");
	meta.className = "project-inventory-meta";
	meta.textContent = `${formatResolution(project.resolution_reason)} · ${project.identity_source} · ${formatLatest(project.latest_session_at)}`;
	row.appendChild(meta);

	const signal = document.createElement("div");
	signal.className = "project-inventory-signal mono";
	signal.textContent = strongestSignal(project);
	row.appendChild(signal);

	if (project.suggested_scope_id && project.suggested_scope_id !== project.resolved_scope_id) {
		const suggestion = document.createElement("div");
		suggestion.className = "settings-note project-suggestion-note";
		suggestion.textContent = project.suggestion_reason
			? `Suggestion: ${project.suggestion_reason}`
			: `Suggestion: map this project to ${scopeLabel(project.suggested_scope_id)}.`;
		row.appendChild(suggestion);
	}

	const warnings = project.guardrail_warnings.filter((warning) => warning.severity === "warning");
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
		["Suggested domain", project.suggested_scope_id],
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

function renderEmpty(message: string) {
	const list = el<HTMLDivElement>("projectsInventoryList");
	if (!list) return;
	list.textContent = "";
	const empty = document.createElement("div");
	empty.className = "settings-note";
	empty.textContent = message;
	list.appendChild(empty);
}

export async function loadProjectsData() {
	const meta = el<HTMLDivElement>("projectsInventoryMeta");
	const list = el<HTMLDivElement>("projectsInventoryList");
	if (!meta || !list) return;
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
		list.textContent = "";
		if (result.projects.length === 0) {
			renderEmpty("No projects match those filters.");
		} else {
			for (const project of result.projects) list.appendChild(renderProjectRow(project));
		}
		meta.textContent =
			result.total === 0
				? "0 projects found"
				: `${result.total} project${result.total === 1 ? "" : "s"} found · showing ${result.offset + 1}-${Math.min(result.offset + result.projects.length, result.total)}`;
		const prev = el<HTMLButtonElement>("projectsPrevPage");
		const next = el<HTMLButtonElement>("projectsNextPage");
		if (prev) prev.disabled = result.offset === 0;
		if (next) next.disabled = !result.has_more;
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
