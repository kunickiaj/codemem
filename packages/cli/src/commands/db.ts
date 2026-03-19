import { statSync } from "node:fs";
import * as p from "@clack/prompts";
import {
	connect,
	getRawEventStatus,
	initDatabase,
	rawEventsGate,
	resolveDbPath,
	retryRawEventFailures,
	vacuumDatabase,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const dbCommand = new Command("db")
	.configureHelp(helpStyle)
	.description("Database maintenance");

dbCommand
	.addCommand(
		new Command("init")
			.configureHelp(helpStyle)
			.description("Verify the SQLite database is present and schema-ready")
			.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.action((opts: { db?: string; dbPath?: string }) => {
				const result = initDatabase(opts.db ?? opts.dbPath);
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
			.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.action((opts: { db?: string; dbPath?: string }) => {
				const result = vacuumDatabase(opts.db ?? opts.dbPath);
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
			.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("-n, --limit <n>", "max rows to show", "25")
			.option("--json", "output as JSON")
			.action((opts: { db?: string; dbPath?: string; limit: string; json?: boolean }) => {
				const result = getRawEventStatus(
					opts.db ?? opts.dbPath,
					Number.parseInt(opts.limit, 10) || 25,
				);
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
			.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("-n, --limit <n>", "max failed batches to requeue", "25")
			.action((opts: { db?: string; dbPath?: string; limit: string }) => {
				const result = retryRawEventFailures(
					opts.db ?? opts.dbPath,
					Number.parseInt(opts.limit, 10) || 25,
				);
				p.intro("codemem db raw-events-retry");
				p.outro(`Requeued ${result.retried.toLocaleString()} failed batch(es)`);
			}),
	)
	.addCommand(
		new Command("raw-events-gate")
			.configureHelp(helpStyle)
			.description("Validate raw-event reliability thresholds (non-zero exit on failure)")
			.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--min-flush-success-rate <rate>", "minimum flush success rate", "0.95")
			.option("--max-dropped-event-rate <rate>", "maximum dropped event rate", "0.05")
			.option("--min-session-boundary-accuracy <rate>", "minimum session boundary accuracy", "0.9")
			.option("--window-hours <hours>", "lookback window in hours", "24")
			.option("--json", "output as JSON")
			.action(
				(opts: {
					db?: string;
					dbPath?: string;
					minFlushSuccessRate: string;
					maxDroppedEventRate: string;
					minSessionBoundaryAccuracy: string;
					windowHours: string;
					json?: boolean;
				}) => {
					const result = rawEventsGate(opts.db ?? opts.dbPath, {
						minFlushSuccessRate: Number.parseFloat(opts.minFlushSuccessRate),
						maxDroppedEventRate: Number.parseFloat(opts.maxDroppedEventRate),
						minSessionBoundaryAccuracy: Number.parseFloat(opts.minSessionBoundaryAccuracy),
						windowHours: Number.parseFloat(opts.windowHours),
					});

					if (opts.json) {
						console.log(JSON.stringify(result, null, 2));
						if (!result.passed) process.exitCode = 1;
						return;
					}

					p.intro("codemem db raw-events-gate");
					p.log.info(
						[
							`flush_success_rate:          ${result.metrics.rates.flush_success_rate.toFixed(4)}`,
							`dropped_event_rate:          ${result.metrics.rates.dropped_event_rate.toFixed(4)}`,
							`session_boundary_accuracy:   ${result.metrics.rates.session_boundary_accuracy.toFixed(4)}`,
							`window_hours:                ${result.metrics.window_hours ?? "all"}`,
						].join("\n"),
					);

					if (result.passed) {
						p.outro("reliability gate passed");
					} else {
						for (const f of result.failures) {
							p.log.error(f);
						}
						p.outro("reliability gate FAILED");
						process.exitCode = 1;
					}
				},
			),
	)
	.addCommand(
		new Command("size-report")
			.configureHelp(helpStyle)
			.description("Show SQLite file size and major storage consumers")
			.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--limit <n>", "number of largest tables/indexes to show", "12")
			.option("--json", "output as JSON")
			.action((opts: { db?: string; dbPath?: string; limit: string; json?: boolean }) => {
				const dbPath = resolveDbPath(opts.db ?? opts.dbPath);
				const db = connect(dbPath);
				try {
					const limit = Math.max(1, Number.parseInt(opts.limit, 10) || 12);
					const fileSizeBytes = statSync(dbPath).size;
					const pageInfo = db
						.prepare(
							"SELECT page_count * page_size as total FROM pragma_page_count, pragma_page_size",
						)
						.get() as { total: number } | undefined;
					const freePages = db.prepare("SELECT freelist_count FROM pragma_freelist_count").get() as
						| { freelist_count: number }
						| undefined;
					const pageSize = db.prepare("PRAGMA page_size").get() as
						| { page_size: number }
						| undefined;
					const tables = db
						.prepare(
							`SELECT name, SUM(pgsize) as size_bytes
							 FROM dbstat
							 GROUP BY name
							 ORDER BY size_bytes DESC
							 LIMIT ?`,
						)
						.all(limit) as Array<{ name: string; size_bytes: number }>;

					if (opts.json) {
						console.log(
							JSON.stringify(
								{
									file_size_bytes: fileSizeBytes,
									db_size_bytes: pageInfo?.total ?? 0,
									free_bytes: (freePages?.freelist_count ?? 0) * (pageSize?.page_size ?? 4096),
									tables: tables.map((t) => ({ name: t.name, size_bytes: t.size_bytes })),
								},
								null,
								2,
							),
						);
						return;
					}

					p.intro("codemem db size-report");
					p.log.info(
						[
							`File size:     ${formatBytes(fileSizeBytes)}`,
							`DB size:       ${formatBytes(pageInfo?.total ?? 0)}`,
							`Free space:    ${formatBytes((freePages?.freelist_count ?? 0) * (pageSize?.page_size ?? 4096))}`,
						].join("\n"),
					);
					if (tables.length > 0) {
						p.log.info("Largest objects:");
						for (const t of tables) {
							p.log.message(`  ${t.name.padEnd(40)} ${formatBytes(t.size_bytes).padStart(10)}`);
						}
					}
					p.outro("done");
				} finally {
					db.close();
				}
			}),
	);
