import { MemoryStore, resolveDbPath } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

export const recentCommand = new Command("recent")
	.configureHelp(helpStyle)
	.description("Show recent memories")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--limit <n>", "max results", "5")
	.option("--kind <kind>", "filter by memory kind")
	.action((opts: { db?: string; limit: string; kind?: string }) => {
		const store = new MemoryStore(resolveDbPath(opts.db));
		try {
			const limit = Math.max(1, Number.parseInt(opts.limit, 10) || 5);
			const filters = opts.kind ? { kind: opts.kind } : undefined;
			const items = store.recent(limit, filters);
			for (const item of items) {
				console.log(`#${item.id} [${item.kind}] ${item.title}`);
			}
		} finally {
			store.close();
		}
	});
