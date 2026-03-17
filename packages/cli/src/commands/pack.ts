import * as p from "@clack/prompts";
import { MemoryStore, resolveDbPath } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

export const packCommand = new Command("pack")
	.configureHelp(helpStyle)
	.description("Build a context-aware memory pack")
	.argument("<context>", "context string to search for")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("-n, --limit <n>", "max items", "10")
	.option("--budget <tokens>", "token budget")
	.option("--json", "output as JSON")
	.action(
		(context: string, opts: { db?: string; limit: string; budget?: string; json?: boolean }) => {
			const store = new MemoryStore(resolveDbPath(opts.db));
			try {
				const limit = Number.parseInt(opts.limit, 10) || 10;
				const budget = opts.budget ? Number.parseInt(opts.budget, 10) : undefined;
				const result = store.buildMemoryPack(context, limit, budget);

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
