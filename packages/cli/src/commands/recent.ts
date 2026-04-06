import { MemoryStore, resolveDbPath, resolveProject } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addDbOption,
	addJsonOption,
	type DbOpts,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";

const cmd = new Command("recent")
	.configureHelp(helpStyle)
	.description("Show recent memories")
	.option("--limit <n>", "max results", "5")
	.option("--project <project>", "project identifier (defaults to git repo root)")
	.option("--all-projects", "search across all projects")
	.option("--kind <kind>", "filter by memory kind");

addDbOption(cmd);
addJsonOption(cmd);

cmd.action(
	(
		opts: DbOpts &
			JsonOpts & {
				limit: string;
				project?: string;
				allProjects?: boolean;
				kind?: string;
			},
	) => {
		const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
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
			if (opts.json) {
				console.log(JSON.stringify(items));
			} else {
				for (const item of items) {
					console.log(`#${item.id} [${item.kind}] ${item.title}`);
				}
			}
		} finally {
			store.close();
		}
	},
);

export const recentCommand = cmd;
