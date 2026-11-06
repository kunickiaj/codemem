import { MEMORY_FILTER_FIELD_TYPES, type MemoryFilters, resolveProject } from "@codemem/core";

function cleanProject(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/** Default read project: CODEMEM_PROJECT wins, then the Git-anchored name of the caller's directory. */
export function resolveDefaultProject(
	caller: { envProject?: string | null; cwd?: string } = {},
): string | null {
	const envProject =
		caller.envProject !== undefined ? caller.envProject : process.env.CODEMEM_PROJECT;
	return cleanProject(envProject) ?? resolveProject(caller.cwd ?? process.cwd());
}

export function resolveWriteProject(input: {
	project?: string | null;
	envProject?: string | null;
}): string | null {
	return cleanProject(input.project) ?? cleanProject(input.envProject) ?? null;
}

export function buildFilters(
	raw: Record<string, unknown>,
	// Required: callers pass the caller-scoped default (or null) so a shared
	// process never falls back to its own working directory.
	defaultProject: string | null,
): MemoryFilters | undefined {
	const filters: MemoryFilters = {};
	let hasAny = false;

	const explicitProject = typeof raw.project === "string" ? cleanProject(raw.project) : undefined;
	const resolvedProject = explicitProject || cleanProject(defaultProject) || undefined;
	if (resolvedProject) {
		filters.project = resolvedProject;
		hasAny = true;
	}

	for (const key of Object.keys(MEMORY_FILTER_FIELD_TYPES)) {
		if (key === "project") continue;
		const val = raw[key];
		if (val !== undefined && val !== null) {
			(filters as Record<string, unknown>)[key] = val;
			hasAny = true;
		}
	}

	return hasAny ? filters : undefined;
}
