import { type MemoryFilters, resolveProject } from "@codemem/core";

function cleanProject(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

export function resolveDefaultProject(): string | null {
	return cleanProject(process.env.CODEMEM_PROJECT) ?? resolveProject(process.cwd());
}

export function resolveWriteProject(input: {
	project?: string | null;
	envProject?: string | null;
}): string | null {
	return cleanProject(input.project) ?? cleanProject(input.envProject) ?? null;
}

export function buildFilters(
	raw: Record<string, unknown>,
	defaultProject = resolveDefaultProject(),
): MemoryFilters | undefined {
	const filters: MemoryFilters = {};
	let hasAny = false;

	const explicitProject = typeof raw.project === "string" ? cleanProject(raw.project) : undefined;
	const resolvedProject = explicitProject || cleanProject(defaultProject) || undefined;
	if (resolvedProject) {
		filters.project = resolvedProject;
		hasAny = true;
	}

	for (const key of [
		"kind",
		"visibility",
		"scope_id",
		"include_scope_ids",
		"exclude_scope_ids",
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
		"ownership_scope",
		"personal_first",
		"trust_bias",
		"widen_shared_when_weak",
		"widen_shared_min_personal_results",
		"widen_shared_min_personal_score",
	] as const) {
		const val = raw[key];
		if (val !== undefined && val !== null) {
			(filters as Record<string, unknown>)[key] = val;
			hasAny = true;
		}
	}

	return hasAny ? filters : undefined;
}
