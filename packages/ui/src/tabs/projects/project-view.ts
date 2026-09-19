import type { ProjectScopeInventoryProject, SharingDomainScope } from "../../lib/api/sync";
import type { ProjectsInventoryViewModel } from "../projects-inventory-model";

export function isPeerReceived(project: ProjectScopeInventoryProject): boolean {
	return project.read_only === true && project.read_only_reason === "peer_received";
}

export function isAssignable(project: ProjectScopeInventoryProject): boolean {
	return project.identity_source !== "unmapped" && !isPeerReceived(project);
}

export function latestLabel(value: string | null): string {
	if (!value) return "—";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function projectSignal(project: ProjectScopeInventoryProject): string {
	return project.git_remote || project.cwd || "";
}

export function scopeOptionLabel(
	scope: SharingDomainScope,
	siblings: SharingDomainScope[],
): string {
	const base =
		scope.kind === "team_default"
			? `${scope.label || "Untitled Space"} (default)`
			: scope.label || "Untitled Space";
	const duplicated = siblings.some(
		(sibling) =>
			sibling.scope_id !== scope.scope_id &&
			(sibling.label || "Untitled Space") === (scope.label || "Untitled Space"),
	);
	return duplicated ? `${base} · Space ID ${scope.scope_id}` : base;
}

export function scopeSummary(
	scopeId: string | null | undefined,
	view: ProjectsInventoryViewModel,
): string {
	if (!scopeId) return "—";
	if (view.scopeLabels[scopeId]) return view.scopeLabels[scopeId];
	for (const group of view.scopeGroups) {
		const scope = group.scopes.find((candidate) => candidate.scope_id === scopeId);
		if (scope) return `${scopeOptionLabel(scope, group.scopes)} · ${group.label}`;
	}
	return "Unknown Space";
}

export function scopeIsAvailable(
	scopeId: string | null | undefined,
	view: ProjectsInventoryViewModel,
): boolean {
	if (!scopeId) return false;
	return view.scopeGroups.some((group) => group.scopes.some((scope) => scope.scope_id === scopeId));
}

export function firstScopeSelection(
	project: ProjectScopeInventoryProject,
	draftScopeId: string | null,
	view: ProjectsInventoryViewModel,
): string {
	for (const candidate of [draftScopeId, project.suggested_scope_id, project.resolved_scope_id]) {
		if (scopeIsAvailable(candidate, view)) return candidate ?? "";
	}
	return project.resolved_scope_id || "";
}

export function projectDomainLabel(
	project: ProjectScopeInventoryProject,
	view: ProjectsInventoryViewModel,
): string {
	return isPeerReceived(project)
		? "From other devices"
		: scopeSummary(project.resolved_scope_id, view);
}

export function resolutionLabel(reason: string): string {
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

export function relationshipLabel(
	summary: NonNullable<ProjectScopeInventoryProject["sharing"]>[number],
): string {
	const name = summary.person.display_name;
	switch (summary.lifecycle.state) {
		case "waiting_for_acceptance":
			return `Invitation sent to ${name}`;
		case "active":
			return `Shared with ${name}`;
		case "waiting_for_device":
			return `Sharing with ${name}`;
		case "needs_attention":
			return `Sharing with ${name} needs attention`;
		case "revoking":
			return `Removing sharing with ${name}`;
		case "revoked":
			return `Previously shared with ${name}`;
		case "cancelled":
			return `Invitation to ${name} cancelled`;
		default:
			return `Setting up sharing with ${name}`;
	}
}

export function warningCount(project: ProjectScopeInventoryProject): number {
	return (project.guardrail_warnings ?? []).filter((warning) => warning.severity === "warning")
		.length;
}

export function projectBadges(
	project: ProjectScopeInventoryProject,
): Array<{ label: string; tone?: string }> {
	const badges: Array<{ label: string; tone?: string }> = [];
	if (warningCount(project) > 0 || project.statuses.includes("needs_attention"))
		badges.push({ label: "Needs attention", tone: "badge-offline" });
	if (project.statuses.includes("suggested")) badges.push({ label: "Suggested" });
	if (project.statuses.includes("legacy_review"))
		badges.push({ label: "Older shared data", tone: "badge-offline" });
	if (isPeerReceived(project)) badges.push({ label: "From another device" });
	if (project.identity_source === "unmapped")
		badges.push({ label: "No stable identity", tone: "badge-offline" });
	return badges;
}

export function detailFields(
	project: ProjectScopeInventoryProject,
	view: ProjectsInventoryViewModel,
): Array<[string, string | number | null | undefined]> {
	return [
		["Workspace identity", project.workspace_identity],
		["Project", project.project],
		["CWD", project.cwd],
		["Git remote", project.git_remote],
		["Git branch", project.git_branch],
		["Current Space", projectDomainLabel(project, view)],
		[
			"Suggested Space",
			project.suggested_scope_id ? scopeSummary(project.suggested_scope_id, view) : null,
		],
		["Advanced: current Space ID", project.resolved_scope_id],
		["Advanced: suggested Space ID", project.suggested_scope_id],
		["Suggestion reason", project.suggestion_reason],
		["Sessions", project.session_count],
		["Memories", project.memory_count ?? "count unavailable"],
	];
}
