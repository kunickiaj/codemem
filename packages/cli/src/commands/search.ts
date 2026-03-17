import * as p from "@clack/prompts";
import { MemoryStore, resolveDbPath } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

export const searchCommand = new Command("search")
	.configureHelp(helpStyle)
	.description("Search memories by query")
	.argument("<query>", "search query")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("-n, --limit <n>", "max results", "10")
	.option("--kind <kind>", "filter by memory kind")
	.option("--json", "output as JSON")
	.action((query: string, opts: { db?: string; limit: string; kind?: string; json?: boolean }) => {
		const store = new MemoryStore(resolveDbPath(opts.db));
		try {
			const limit = Number.parseInt(opts.limit, 10) || 10;
			const filters = opts.kind ? { kind: opts.kind } : undefined;
			const results = store.search(query, limit, filters);

			if (opts.json) {
				console.log(JSON.stringify(results, null, 2));
				return;
			}

			if (results.length === 0) {
				p.log.warn("No results found.");
				return;
			}

			p.intro(`${results.length} result(s) for "${query}"`);

			for (const item of results) {
				const score = item.score.toFixed(3);
				const age = timeSince(item.created_at);
				const preview =
					item.body_text.length > 120 ? `${item.body_text.slice(0, 120)}…` : item.body_text;

				p.log.message(
					[`#${item.id}  ${item.kind}  ${age}  [${score}]`, item.title, preview].join("\n"),
				);
			}

			p.outro("done");
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
