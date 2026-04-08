import { resolveProject } from "@codemem/core";
import type { Command } from "commander";

export type PackFilters = { project?: string; working_set_paths?: string[] };

export type PackRequestOptions = {
	limit: number;
	budget: number | undefined;
	filters: PackFilters;
};

export class PackUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PackUsageError";
	}
}

export function collectWorkingSetFile(value: string, previous: string[]): string[] {
	return [...previous, value];
}

export function addPackRequestOptions(command: Command): Command {
	return command
		.option("-n, --limit <n>", "max items", "10")
		.option("--budget <tokens>", "token budget")
		.option("--token-budget <tokens>", "token budget")
		.option(
			"--working-set-file <path>",
			"recently modified file path used as ranking hint",
			collectWorkingSetFile,
			[],
		)
		.option("--project <project>", "project identifier (defaults to git repo root)")
		.option("--all-projects", "search across all projects");
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
	const limit = parsePositiveInt(opts.limit ?? "10", "limit");
	const budgetRaw = opts.tokenBudget ?? opts.budget;
	const budget = budgetRaw ? parseNonNegativeInt(budgetRaw, "token budget") : undefined;
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

function parsePositiveInt(value: string, label: string): number {
	if (!/^\d+$/.test(value.trim())) {
		throw new PackUsageError(`${label} must be a positive integer`);
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new PackUsageError(`${label} must be a positive integer`);
	}
	return parsed;
}

function parseNonNegativeInt(value: string, label: string): number {
	if (!/^\d+$/.test(value.trim())) {
		throw new PackUsageError(`${label} must be a non-negative integer`);
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new PackUsageError(`${label} must be a non-negative integer`);
	}
	return parsed;
}
