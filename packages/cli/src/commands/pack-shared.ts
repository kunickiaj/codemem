import { resolveProject } from "@codemem/core";

export type PackFilters = { project?: string; working_set_paths?: string[] };

export type PackRequestOptions = {
	limit: number;
	budget: number | undefined;
	filters: PackFilters;
};

export function collectWorkingSetFile(value: string, previous: string[]): string[] {
	return [...previous, value];
}

export function buildPackRequestOptions(
	opts: {
		limit?: string;
		budget?: string;
		tokenBudget?: string;
		workingSetFile?: string[];
		project?: string;
		allProjects?: boolean;
	},
	ctx: {
		cwd?: string;
		envProject?: string | null;
		resolveProjectFn?: typeof resolveProject;
	} = {},
): PackRequestOptions {
	const limit = Number.parseInt(opts.limit ?? "10", 10) || 10;
	const budgetRaw = opts.tokenBudget ?? opts.budget;
	const budget = budgetRaw ? Number.parseInt(budgetRaw, 10) : undefined;
	const filters: PackFilters = {};

	if (!opts.allProjects) {
		const defaultProject = ctx.envProject?.trim() || null;
		const resolveProjectFn = ctx.resolveProjectFn ?? resolveProject;
		const cwd = ctx.cwd ?? process.cwd();
		const project = defaultProject || resolveProjectFn(cwd, opts.project ?? null);
		if (project) {
			filters.project = project;
		}
	}

	if ((opts.workingSetFile?.length ?? 0) > 0) {
		filters.working_set_paths = opts.workingSetFile;
	}

	return { limit, budget, filters };
}
