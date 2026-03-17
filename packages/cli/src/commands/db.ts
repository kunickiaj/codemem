import * as p from "@clack/prompts";
import {
	getRawEventStatus,
	initDatabase,
	retryRawEventFailures,
	vacuumDatabase,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

export const dbCommand = new Command("db")
	.configureHelp(helpStyle)
	.description("Database maintenance");

dbCommand
	.addCommand(
		new Command("init")
			.configureHelp(helpStyle)
			.description("Verify the SQLite database is present and schema-ready")
			.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.action((opts: { db?: string }) => {
				const result = initDatabase(opts.db);
				p.intro("codemem db init");
				p.log.success(`Database ready: ${result.path}`);
				p.outro(`Size: ${result.sizeBytes.toLocaleString()} bytes`);
			}),
	)
	.addCommand(
		new Command("vacuum")
			.configureHelp(helpStyle)
			.description("Run VACUUM on the SQLite database")
			.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.action((opts: { db?: string }) => {
				const result = vacuumDatabase(opts.db);
				p.intro("codemem db vacuum");
				p.log.success(`Vacuumed: ${result.path}`);
				p.outro(`Size: ${result.sizeBytes.toLocaleString()} bytes`);
			}),
	)
	.addCommand(
		new Command("raw-events-status")
			.configureHelp(helpStyle)
			.description("Show pending raw-event backlog by source stream")
			.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("-n, --limit <n>", "max rows to show", "25")
			.option("--json", "output as JSON")
			.action((opts: { db?: string; limit: string; json?: boolean }) => {
				const result = getRawEventStatus(opts.db, Number.parseInt(opts.limit, 10) || 25);
				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				p.intro("codemem db raw-events-status");
				p.log.info(
					`Totals: ${result.totals.pending.toLocaleString()} pending across ${result.totals.sessions.toLocaleString()} session(s)`,
				);
				if (result.items.length === 0) {
					p.outro("No pending raw events");
					return;
				}
				for (const item of result.items) {
					p.log.message(
						`${item.source}:${item.stream_id} pending=${Math.max(0, item.last_received_event_seq - item.last_flushed_event_seq)} ` +
							`received=${item.last_received_event_seq} flushed=${item.last_flushed_event_seq} project=${item.project ?? ""}`,
					);
				}
				p.outro("done");
			}),
	)
	.addCommand(
		new Command("raw-events-retry")
			.configureHelp(helpStyle)
			.description("Requeue failed raw-event flush batches")
			.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("-n, --limit <n>", "max failed batches to requeue", "25")
			.action((opts: { db?: string; limit: string }) => {
				const result = retryRawEventFailures(opts.db, Number.parseInt(opts.limit, 10) || 25);
				p.intro("codemem db raw-events-retry");
				p.outro(`Requeued ${result.retried.toLocaleString()} failed batch(es)`);
			}),
	);
