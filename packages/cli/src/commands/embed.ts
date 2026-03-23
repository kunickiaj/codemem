import * as p from "@clack/prompts";
import { backfillVectors, MemoryStore, resolveDbPath, resolveProject } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`invalid positive integer: ${value}`);
	}
	return parsed;
}

export function resolveEmbedProjectScope(
	cwd: string,
	projectOpt: string | undefined,
	allProjects: boolean | undefined,
): string | null {
	if (allProjects === true) return null;
	const explicit = projectOpt?.trim();
	if (explicit) return explicit;
	const envProject = process.env.CODEMEM_PROJECT?.trim();
	if (envProject) return envProject;
	return resolveProject(cwd, null);
}

export const embedCommand = new Command("embed")
	.configureHelp(helpStyle)
	.description("Backfill semantic embeddings")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--limit <n>", "max memories to check")
	.option("--since <iso>", "only memories created at/after this ISO timestamp")
	.option("--project <project>", "project identifier (defaults to git repo root)")
	.option("--all-projects", "embed across all projects")
	.option("--inactive", "include inactive memories")
	.option("--dry-run", "preview work without writing vectors")
	.option("--json", "output as JSON")
	.action(
		async (opts: {
			db?: string;
			dbPath?: string;
			limit?: string;
			since?: string;
			project?: string;
			allProjects?: boolean;
			inactive?: boolean;
			dryRun?: boolean;
			json?: boolean;
		}) => {
			const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
			try {
				const limit = parseOptionalPositiveInt(opts.limit);
				const project = resolveEmbedProjectScope(process.cwd(), opts.project, opts.allProjects);

				const result = await backfillVectors(store.db, {
					limit,
					since: opts.since ?? null,
					project,
					activeOnly: !opts.inactive,
					dryRun: opts.dryRun === true,
				});

				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}

				const action = opts.dryRun ? "Would embed" : "Embedded";
				p.intro("codemem embed");
				p.log.success(
					`${action} ${result.embedded} vectors (${result.inserted} inserted, ${result.skipped} skipped)`,
				);
				p.outro(`Checked ${result.checked} memories`);
			} catch (error) {
				p.log.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			} finally {
				store.close();
			}
		},
	);
