import * as p from "@clack/prompts";
import { MemoryStore, resolveDbPath } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addDbOption,
	addJsonOption,
	type DbOpts,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";
import { buildPackRequestOptions, collectWorkingSetFile } from "./pack-shared.js";

const packCmd = new Command("pack")
	.configureHelp(helpStyle)
	.description("Build a context-aware memory pack")
	.argument("<context>", "context string to search for")
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

addDbOption(packCmd);
addJsonOption(packCmd);

export const packCommand = packCmd.action(
	async (
		context: string,
		opts: DbOpts &
			JsonOpts & {
				limit: string;
				budget?: string;
				tokenBudget?: string;
				workingSetFile?: string[];
				project?: string;
				allProjects?: boolean;
			},
	) => {
		const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
		try {
			const { limit, budget, filters } = buildPackRequestOptions(opts, {
				envProject: process.env.CODEMEM_PROJECT,
			});
			const result = await store.buildMemoryPackAsync(context, limit, budget, filters);

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
