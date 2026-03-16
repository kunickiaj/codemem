import { MemoryStore } from "@codemem/core";
import chalk from "chalk";
import { Command } from "commander";

export const statsCommand = new Command("stats")
	.description("Show database statistics")
	.option("--db <path>", "database path")
	.option("--json", "output as JSON")
	.action((opts: { db?: string; json?: boolean }) => {
		const store = new MemoryStore(opts.db);
		try {
			const result = store.stats();
			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			const db = result.database;
			const sizeKb = Math.round(db.size_bytes / 1024);
			console.log(chalk.bold("codemem stats (TS backend)\n"));
			console.log(`  Database:  ${chalk.cyan(db.path)}`);
			console.log(`  Size:      ${sizeKb.toLocaleString()} KB`);
			console.log(`  Sessions:  ${db.sessions}`);
			console.log(`  Memories:  ${db.active_memory_items} active / ${db.memory_items} total`);
			console.log(`  Artifacts: ${db.artifacts}`);
			console.log(`  Vectors:   ${db.vector_rows}`);
			console.log(`  Raw events: ${db.raw_events}`);
		} finally {
			store.close();
		}
	});
