import { MemoryStore } from "@codemem/core";
import chalk from "chalk";
import { Command } from "commander";

export const searchCommand = new Command("search")
	.description("Search memories by query")
	.argument("<query>", "search query")
	.option("--db <path>", "database path")
	.option("-n, --limit <n>", "max results", "10")
	.option("--kind <kind>", "filter by memory kind")
	.option("--json", "output as JSON")
	.action((query: string, opts: { db?: string; limit: string; kind?: string; json?: boolean }) => {
		const store = new MemoryStore(opts.db);
		try {
			const limit = Number.parseInt(opts.limit, 10) || 10;
			const filters = opts.kind ? { kind: opts.kind } : undefined;
			const results = store.search(query, limit, filters);

			if (opts.json) {
				console.log(JSON.stringify(results, null, 2));
				return;
			}

			if (results.length === 0) {
				console.log(chalk.dim("No results found."));
				return;
			}

			console.log(chalk.bold(`${results.length} result(s) for "${query}"\n`));
			for (const item of results) {
				const score = item.score.toFixed(3);
				const kind = chalk.dim(`(${item.kind})`);
				const age = timeSince(item.created_at);
				console.log(
					`  ${chalk.cyan(`#${item.id}`)} ${kind} ${item.title} ${chalk.dim(`[${score}] ${age}`)}`,
				);
				if (item.body_text.length > 120) {
					console.log(`    ${chalk.dim(item.body_text.slice(0, 120))}…`);
				} else {
					console.log(`    ${chalk.dim(item.body_text)}`);
				}
			}
		} finally {
			store.close();
		}
	});

function timeSince(isoDate: string): string {
	const ms = Date.now() - new Date(isoDate).getTime();
	const days = Math.floor(ms / 86_400_000);
	if (days === 0) return "today";
	if (days === 1) return "1d ago";
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	return `${months}mo ago`;
}
