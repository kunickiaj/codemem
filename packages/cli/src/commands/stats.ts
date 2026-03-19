import * as p from "@clack/prompts";
import { MemoryStore, resolveDbPath } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

function fmtPct(n: number): string {
	return `${Math.round(n * 100)}%`;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000_000) return `~${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `~${(n / 1_000).toFixed(0)}K`;
	return `${n}`;
}

export const statsCommand = new Command("stats")
	.configureHelp(helpStyle)
	.description("Show database statistics")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--json", "output as JSON")
	.action((opts: { db?: string; dbPath?: string; json?: boolean }) => {
		const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
		try {
			const result = store.stats();
			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			const db = result.database;
			const sizeMb = (db.size_bytes / 1_048_576).toFixed(1);

			p.intro("codemem stats");

			p.log.info([`Path:        ${db.path}`, `Size:        ${sizeMb} MB`].join("\n"));

			p.log.success(
				[
					`Sessions:    ${db.sessions.toLocaleString()}`,
					`Memories:    ${db.active_memory_items.toLocaleString()} active / ${db.memory_items.toLocaleString()} total`,
					`Tags:        ${db.tags_filled.toLocaleString()} filled (${fmtPct(db.tags_coverage)} of active)`,
					`Artifacts:   ${db.artifacts.toLocaleString()}`,
					`Vectors:     ${db.vector_rows.toLocaleString()} (${fmtPct(db.vector_coverage)} coverage)`,
					`Raw events:  ${db.raw_events.toLocaleString()}`,
				].join("\n"),
			);

			if (result.usage.events.length > 0) {
				const lines = result.usage.events.map((e: (typeof result.usage.events)[number]) => {
					const parts = [`${e.event}: ${e.count.toLocaleString()}`];
					if (e.tokens_read > 0) parts.push(`read ${fmtTokens(e.tokens_read)} tokens`);
					if (e.tokens_saved > 0) parts.push(`est. saved ${fmtTokens(e.tokens_saved)} tokens`);
					return `  ${parts.join(", ")}`;
				});

				const t = result.usage.totals;
				lines.push("");
				lines.push(
					`  Total: ${t.events.toLocaleString()} events, read ${fmtTokens(t.tokens_read)} tokens, est. saved ${fmtTokens(t.tokens_saved)} tokens`,
				);

				p.log.step(`Usage\n${lines.join("\n")}`);
			}

			p.outro("done");
		} finally {
			store.close();
		}
	});
