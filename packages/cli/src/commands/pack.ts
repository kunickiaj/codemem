import { MemoryStore, resolveDbPath } from "@codemem/core";
import chalk from "chalk";
import { Command } from "commander";

export const packCommand = new Command("pack")
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

				console.log(chalk.bold(`Memory pack for "${context}"\n`));

				if (result.items.length === 0) {
					console.log(chalk.dim("No relevant memories found."));
					return;
				}

				const m = result.metrics;
				console.log(
					chalk.dim(
						`  ${m.total_items} items, ~${m.pack_tokens} tokens` +
							(m.fallback_used ? " (fallback)" : "") +
							` [fts:${m.sources.fts} sem:${m.sources.semantic} fuzzy:${m.sources.fuzzy}]`,
					),
				);
				console.log();

				for (const item of result.items) {
					const kind = chalk.dim(`(${item.kind})`);
					console.log(`  ${chalk.cyan(`#${item.id}`)} ${kind} ${item.title}`);
				}

				console.log(chalk.dim("\n--- pack_text ---\n"));
				console.log(result.pack_text);
			} finally {
				store.close();
			}
		},
	);
