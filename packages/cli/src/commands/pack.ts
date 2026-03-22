import * as p from "@clack/prompts";
import { MemoryStore, resolveDbPath, resolveProject } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

function collectWorkingSetFile(value: string, previous: string[]): string[] {
	return [...previous, value];
}

export const packCommand = new Command("pack")
	.configureHelp(helpStyle)
	.description("Build a context-aware memory pack")
	.argument("<context>", "context string to search for")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
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
	.option("--all-projects", "search across all projects")
	.option("--json", "output as JSON")
	.action(
		(
			context: string,
			opts: {
				db?: string;
				dbPath?: string;
				limit: string;
				budget?: string;
				tokenBudget?: string;
				workingSetFile?: string[];
				project?: string;
				allProjects?: boolean;
				json?: boolean;
			},
		) => {
			const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
			try {
				const limit = Number.parseInt(opts.limit, 10) || 10;
				const budgetRaw = opts.tokenBudget ?? opts.budget;
				const budget = budgetRaw ? Number.parseInt(budgetRaw, 10) : undefined;
				const filters: { project?: string; working_set_paths?: string[] } = {};
				if (!opts.allProjects) {
					const defaultProject = process.env.CODEMEM_PROJECT?.trim() || null;
					const project = defaultProject || resolveProject(process.cwd(), opts.project ?? null);
					if (project) filters.project = project;
				}
				if ((opts.workingSetFile?.length ?? 0) > 0) {
					filters.working_set_paths = opts.workingSetFile;
				}
				const result = store.buildMemoryPack(context, limit, budget, filters);

				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}

				p.intro(`Memory pack for "${context}"`);

				if (result.items.length === 0) {
					p.log.warn("No relevant memories found.");
					p.outro("done");
					return;
				}

				const m = result.metrics;
				p.log.info(
					`${m.total_items} items, ~${m.pack_tokens} tokens` +
						(m.fallback_used ? " (fallback)" : "") +
						`  [fts:${m.sources.fts} sem:${m.sources.semantic} fuzzy:${m.sources.fuzzy}]`,
				);

				for (const item of result.items) {
					p.log.step(`#${item.id}  ${item.kind}  ${item.title}`);
				}

				p.note(result.pack_text, "pack_text");

				p.outro("done");
			} finally {
				store.close();
			}
		},
	);
