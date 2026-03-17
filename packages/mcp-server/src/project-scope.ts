import { type MemoryFilters, resolveProject } from "@codemem/core";

export function resolveDefaultProject(): string | null {
	const project = process.env.CODEMEM_PROJECT?.trim();
	return project || resolveProject(process.cwd());
}

export function buildFilters(
	raw: Record<string, unknown>,
	defaultProject = resolveDefaultProject(),
): MemoryFilters | undefined {
	const filters: MemoryFilters = {};
	let hasAny = false;

	const explicitProject = typeof raw.project === "string" ? raw.project.trim() : undefined;
	const resolvedProject = explicitProject || defaultProject || undefined;
	if (resolvedProject) {
		filters.project = resolvedProject;
		hasAny = true;
	}

	for (const key of [
		"kind",
		"include_visibility",
		"exclude_visibility",
		"include_workspace_ids",
		"exclude_workspace_ids",
		"include_workspace_kinds",
		"exclude_workspace_kinds",
		"include_actor_ids",
		"exclude_actor_ids",
		"include_trust_states",
		"exclude_trust_states",
	] as const) {
		const val = raw[key];
		if (val !== undefined && val !== null) {
			(filters as Record<string, unknown>)[key] = val;
			hasAny = true;
		}
	}

	return hasAny ? filters : undefined;
}
