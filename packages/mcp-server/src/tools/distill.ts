import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildDistillReport,
	type DistillContextDocument,
	type MemoryFilters,
	projectMatchesFilter,
	resolveProject,
	resolveProjectRoot,
} from "@codemem/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorContent, jsonContent } from "../content.js";
import { buildFilters } from "../project-scope.js";
import { filterSchema } from "../schemas.js";
import type { ToolRegistrationContext } from "../tool-context.js";

function readContextFile(
	path: string,
	displayPath: string,
	scope: DistillContextDocument["scope"],
): DistillContextDocument | null {
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	return text.trim() ? { path: displayPath, text, scope } : null;
}

function loadDefaultContextDocuments(
	includeProjectContext: boolean,
	cwd = process.cwd(),
): DistillContextDocument[] {
	// The repo-root AGENTS.md describes the current repo (scope "project") and is
	// gated to current-project runs; the user-global context (scope "user")
	// always applies and never suppresses other projects' candidates. Resolve the
	// repo root so running from a subdirectory still finds the project context.
	const projectRoot = resolveProjectRoot(cwd) ?? cwd;
	const documents = [
		includeProjectContext
			? readContextFile(join(projectRoot, "AGENTS.md"), "AGENTS.md", "project")
			: null,
		readContextFile(
			join(homedir(), ".config", "opencode", "AGENTS.md"),
			"~/.config/opencode/AGENTS.md",
			"user",
		),
	];
	return documents.filter((document): document is DistillContextDocument => document != null);
}

function shouldIncludeProjectContext(
	args: { all_projects?: boolean; project?: unknown },
	defaultProject: string | null,
): boolean {
	if (args.all_projects) return false;
	const currentProject = resolveProject(process.cwd());
	if (!currentProject) return false;
	const explicitProject = typeof args.project === "string" ? args.project.trim() : "";
	// Match the corpus filter: the cwd AGENTS.md is only valid when the mined
	// project (explicit arg or the server default project) is this repo.
	const targetProject = explicitProject
		? resolveProject(process.cwd(), explicitProject)
		: defaultProject;
	if (!targetProject) return false;
	return projectMatchesFilter(targetProject, currentProject);
}

function buildDistillFilters(
	args: { all_projects?: boolean } & Record<string, unknown>,
	defaultProject: string | null,
): MemoryFilters | undefined {
	if (args.all_projects && typeof args.project === "string" && args.project.trim()) {
		throw new Error("project cannot be combined with all_projects");
	}
	return buildFilters(args, args.all_projects ? null : defaultProject);
}

export function registerDistillTools(server: McpServer, context: ToolRegistrationContext): void {
	const { defaultProject, store } = context;

	server.tool(
		"memory_distill_candidates",
		"Mine recurring memories into reviewable context candidates. Read-only; does not modify context files.",
		{
			limit: z.number().int().min(1).max(50).default(10).describe("Max candidates"),
			min_recurrence: z
				.number()
				.int()
				.min(1)
				.max(50)
				.default(2)
				.describe("Minimum member count per candidate"),
			all_projects: z.boolean().default(false).describe("Mine memories across all projects"),
			include_documented: z
				.boolean()
				.default(false)
				.describe("Include candidates already represented in context files"),
			max_evidence_items: z
				.number()
				.int()
				.min(1)
				.max(20)
				.default(5)
				.describe("Evidence snippets per candidate"),
			...filterSchema,
		},
		async (args) => {
			try {
				const resolvedDefaultProject = defaultProject();
				const filters = buildDistillFilters(args, resolvedDefaultProject);
				const kinds = args.kind ? [args.kind] : undefined;
				const result = await buildDistillReport(store, {
					candidate: {
						includeDocumented: args.include_documented,
						maxEvidenceItems: args.max_evidence_items,
					},
					contextDocuments: loadDefaultContextDocuments(
						shouldIncludeProjectContext(args, resolvedDefaultProject),
					),
					corpus: { filters: filters ?? null, kinds },
					limit: args.limit,
					minRecurrence: args.min_recurrence,
				});
				return jsonContent(result);
			} catch (err) {
				return errorContent(err instanceof Error ? err.message : String(err));
			}
		},
	);
}
