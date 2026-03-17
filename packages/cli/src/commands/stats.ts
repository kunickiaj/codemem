import * as p from "@clack/prompts";
import { MemoryStore, resolveDbPath } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

export const statsCommand = new Command("stats")
	.configureHelp(helpStyle)
	.description("Show database statistics")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--json", "output as JSON")
	.action((opts: { db?: string; json?: boolean }) => {
		const store = new MemoryStore(resolveDbPath(opts.db));
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
					`Artifacts:   ${db.artifacts.toLocaleString()}`,
					`Vectors:     ${db.vector_rows.toLocaleString()}`,
					`Raw events:  ${db.raw_events.toLocaleString()}`,
				].join("\n"),
			);

			p.outro("done");
		} finally {
			store.close();
		}
	});
