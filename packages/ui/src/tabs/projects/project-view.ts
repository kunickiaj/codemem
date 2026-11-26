import type { ProjectScopeInventoryProject, SharingDomainScope } from "../../lib/api/sync";
import { collapseHome } from "../../lib/format";
import type { ProjectsInventoryViewModel } from "../projects-inventory-model";

export function projectDomId(prefix: string, value: string): string {
	const encoded = Array.from(value, (character) =>
		(character.codePointAt(0) ?? 0).toString(16).padStart(6, "0"),
	).join("");
	return `${prefix}-${encoded || "empty"}`;
}

type ClusterEntry = Pick<
	ProjectScopeInventoryProject,
	| "display_project"
	| "git_remote"
	| "identity_source"
	| "project"
	| "repository_identity"
	| "resolved_scope_id"
	| "workspace_identity"
>;

/** The name a row shows, lower-cased, or null for an entry with only a generated workspace ID. */
function clusterNameKey(entry: ClusterEntry): string | null {
	const name = entry.display_project.trim();
	if (
		!entry.project &&
		entry.identity_source === "workspace_id" &&
		name === entry.workspace_identity
	)
		return null;
	const title = isAbsolutePath(name) ? pathBasename(name) || name : name;
	return title ? title.toLowerCase() : null;
}

function clusterRepository(entry: ClusterEntry): string | null {
	return entry.repository_identity?.trim() || entry.git_remote?.trim() || null;
}

/**
 * The row each Project entry belongs to. Entries form one row when they have the same name,
 * resolve to the same Space and carry the same repository identity; an entry with no
 * repository identity joins its name and Space's row when exactly one identity is recorded
 * there. The server groups the same way when it hides empty entries
 * (projectInventoryGroupKeys in packages/core/src/project-inventory-groups.ts). Change both
 * together; their tests use the same cases.
 */
export function projectClusterKeys<T extends ClusterEntry>(entries: readonly T[]): Map<T, string> {
	const base = (entry: T, name: string) => `name:${name}\u0000scope:${entry.resolved_scope_id}`;
	const repositories = new Map<string, Set<string>>();
	for (const entry of entries) {
		const name = clusterNameKey(entry);
		const repository = clusterRepository(entry);
		if (!name || !repository) continue;
		const key = base(entry, name);
		repositories.set(key, (repositories.get(key) ?? new Set()).add(repository));
	}
	const keys = new Map<T, string>();
	for (const entry of entries) {
		const name = clusterNameKey(entry);
		if (!name) {
			keys.set(entry, `identity:${entry.workspace_identity}`);
			continue;
		}
		const shared = base(entry, name);
		const known = repositories.get(shared);
		const only = known?.size === 1 ? [...known][0] : null;
		keys.set(entry, `${shared}\u0000repo:${clusterRepository(entry) ?? only ?? ""}`);
	}
	return keys;
}

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
	return project.git_remote || project.repository_identity || project.cwd || "";
}

function isAbsolutePath(value: string): boolean {
	return /^(\/|[A-Za-z]:[\\/])/.test(value);
}

function pathBasename(value: string): string {
	return value.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

/**
 * A Project's on-screen name and the secondary line that tells same-named Projects apart.
 * Presentation only: `display_project` also feeds mapping patterns and name guardrails,
 * so it stays as recorded.
 */
export function projectHeading(project: ProjectScopeInventoryProject): {
	title: string;
	signal: string;
} {
	const name = project.display_project;
	const signal = collapseHome(projectSignal(project));
	// Memories recorded without a project name carry only a generated workspace ID.
	// The inventory search matches this title server-side (UNNAMED_PROJECT_LABEL in
	// packages/core/src/project-scope-settings.ts). Change both together.
	const generatedIdOnly =
		!project.project &&
		project.identity_source === "workspace_id" &&
		name === project.workspace_identity;
	if (generatedIdOnly) return { title: "No project", signal };
	if (!isAbsolutePath(name)) return { title: name, signal };
	return { title: pathBasename(name) || name, signal: signal || collapseHome(name) };
}

export function identitySourceLabel(source: string): string {
	if (source === "git_repository") return "git repository";
	return source.replaceAll("_", " ");
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
		["Repository identity", project.repository_identity],
		["Project", project.project],
		["Project match source", identitySourceLabel(project.identity_source)],
		["Recorded workspace path", project.cwd],
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
		["Recorded sessions", project.session_count],
		["Active memories", project.memory_count ?? "count unavailable"],
		[
			"Latest recorded session",
			project.latest_session_at ? latestLabel(project.latest_session_at) : "Unknown",
		],
	];
}
