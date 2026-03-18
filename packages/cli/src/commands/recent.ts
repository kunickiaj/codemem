import { MemoryStore, resolveDbPath, resolveProject } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

export const recentCommand = new Command("recent")
	.configureHelp(helpStyle)
	.description("Show recent memories")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--limit <n>", "max results", "5")
	.option("--project <project>", "project identifier (defaults to git repo root)")
	.option("--all-projects", "search across all projects")
	.option("--kind <kind>", "filter by memory kind")
	.action(
		(opts: {
			db?: string;
			dbPath?: string;
			limit: string;
			project?: string;
			allProjects?: boolean;
			kind?: string;
		}) => {
			const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
			try {
				const limit = Math.max(1, Number.parseInt(opts.limit, 10) || 5);
				const filters: { kind?: string; project?: string } = {};
				if (opts.kind) filters.kind = opts.kind;
				if (!opts.allProjects) {
					const defaultProject = process.env.CODEMEM_PROJECT?.trim() || null;
					const project = defaultProject || resolveProject(process.cwd(), opts.project ?? null);
					if (project) filters.project = project;
				}
				const items = store.recent(limit, filters);
				for (const item of items) {
					console.log(`#${item.id} [${item.kind}] ${item.title}`);
				}
			} finally {
				store.close();
			}
		},
	);
