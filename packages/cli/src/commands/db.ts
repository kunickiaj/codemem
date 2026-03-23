import { statSync } from "node:fs";
import * as p from "@clack/prompts";
import {
	backfillTagsText,
	connect,
	deactivateLowSignalMemories,
	deactivateLowSignalObservations,
	getRawEventStatus,
	initDatabase,
	MemoryStore,
	rawEventsGate,
	resolveDbPath,
	resolveProject,
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

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`invalid positive integer: ${value}`);
	}
	return parsed;
}

function parseKindsCsv(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const kinds = value
		.split(",")
		.map((kind) => kind.trim())
		.filter((kind) => kind.length > 0);
	return kinds.length > 0 ? kinds : undefined;
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
		new Command("rename-project")
			.configureHelp(helpStyle)
			.description("Rename a project across sessions and related tables")
			.argument("<old-name>", "current project name")
			.argument("<new-name>", "new project name")
			.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--apply", "apply changes (default is dry-run)")
			.action(
				(
					oldName: string,
					newName: string,
					opts: { db?: string; dbPath?: string; apply?: boolean },
				) => {
					const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
					try {
						const dryRun = !opts.apply;
						const escapedOld = oldName.replace(/%/g, "\\%").replace(/_/g, "\\_");
						const suffixPattern = `%/${escapedOld}`;
						const tables = ["sessions", "raw_event_sessions"] as const;
						const counts: Record<string, number> = {};
						const run = () => {
							for (const table of tables) {
								const rows = store.db
									.prepare(
										`SELECT COUNT(*) as cnt FROM ${table} WHERE project = ? OR project LIKE ? ESCAPE '\\'`,
									)
									.get(oldName, suffixPattern) as { cnt: number };
								counts[table] = rows.cnt;
								if (!dryRun && rows.cnt > 0) {
									store.db
										.prepare(`UPDATE ${table} SET project = ? WHERE project = ?`)
										.run(newName, oldName);
									store.db
										.prepare(
											`UPDATE ${table} SET project = ? WHERE project LIKE ? ESCAPE '\\' AND project != ?`,
										)
										.run(newName, suffixPattern, newName);
								}
							}
						};
						if (dryRun) {
							run();
						} else {
							store.db.transaction(run)();
						}
						const action = dryRun ? "Will rename" : "Renamed";
						p.intro("codemem db rename-project");
						p.log.info(`${action} ${oldName} → ${newName}`);
						p.log.info(
							[
								`Sessions: ${counts.sessions}`,
								`Raw event sessions: ${counts.raw_event_sessions}`,
							].join("\n"),
						);
						if (dryRun) {
							p.outro("Pass --apply to execute");
						} else {
							p.outro("done");
						}
					} finally {
						store.close();
					}
				},
			),
	)
	.addCommand(
		new Command("normalize-projects")
			.configureHelp(helpStyle)
			.description("Normalize path-like project identifiers to their basename")
			.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--apply", "apply changes (default is dry-run)")
			.action((opts: { db?: string; dbPath?: string; apply?: boolean }) => {
				const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
				try {
					const dryRun = !opts.apply;
					const tables = ["sessions", "raw_event_sessions"] as const;
					const rewrites: Map<string, string> = new Map();
					const counts: Record<string, number> = {};

					const run = () => {
						for (const table of tables) {
							const projects = store.db
								.prepare(
									`SELECT DISTINCT project FROM ${table} WHERE project IS NOT NULL AND project LIKE '%/%'`,
								)
								.all() as Array<{ project: string }>;
							let updated = 0;
							for (const row of projects) {
								const basename = row.project.split("/").pop() ?? row.project;
								if (basename !== row.project) {
									rewrites.set(row.project, basename);
									if (!dryRun) {
										const info = store.db
											.prepare(`UPDATE ${table} SET project = ? WHERE project = ?`)
											.run(basename, row.project);
										updated += info.changes;
									} else {
										const cnt = store.db
											.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE project = ?`)
											.get(row.project) as { cnt: number };
										updated += cnt.cnt;
									}
								}
							}
							counts[table] = updated;
						}
					};
					if (dryRun) {
						run();
					} else {
						store.db.transaction(run)();
					}

					p.intro("codemem db normalize-projects");
					p.log.info(`Dry run: ${dryRun}`);
					p.log.info(
						[
							`Sessions to update: ${counts.sessions}`,
							`Raw event sessions to update: ${counts.raw_event_sessions}`,
						].join("\n"),
					);
					if (rewrites.size > 0) {
						p.log.info("Rewritten paths:");
						for (const [from, to] of [...rewrites.entries()].sort()) {
							p.log.message(`  ${from} → ${to}`);
						}
					}
					if (dryRun) {
						p.outro("Pass --apply to execute");
					} else {
						p.outro("done");
					}
				} finally {
					store.close();
				}
			}),
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
	)
	.addCommand(
		new Command("backfill-tags")
			.configureHelp(helpStyle)
			.description("Populate tags_text for memories where tags are empty")
			.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--limit <n>", "max memories to check")
			.option("--since <iso>", "only memories created at/after this ISO timestamp")
			.option("--project <project>", "project identifier (defaults to git repo root)")
			.option("--all-projects", "backfill across all projects")
			.option("--inactive", "include inactive memories")
			.option("--dry-run", "preview updates without writing")
			.option("--json", "output as JSON")
			.action(
				(opts: {
					db?: string;
					dbPath?: string;
					limit?: string;
					since?: string;
					project?: string;
					allProjects?: boolean;
					inactive?: boolean;
					dryRun?: boolean;
					json?: boolean;
				}) => {
					const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
					try {
						const limit = parseOptionalPositiveInt(opts.limit);
						const project =
							opts.allProjects === true
								? null
								: opts.project?.trim() ||
									process.env.CODEMEM_PROJECT?.trim() ||
									resolveProject(process.cwd(), null);
						const result = backfillTagsText(store.db, {
							limit,
							since: opts.since ?? null,
							project,
							activeOnly: !opts.inactive,
							dryRun: opts.dryRun === true,
						});

						if (opts.json) {
							console.log(JSON.stringify(result, null, 2));
							return;
						}

						const action = opts.dryRun ? "Would update" : "Updated";
						p.intro("codemem db backfill-tags");
						p.log.success(`${action} ${result.updated} memories (skipped ${result.skipped})`);
						p.outro(`Checked ${result.checked} memories`);
					} catch (error) {
						p.log.error(error instanceof Error ? error.message : String(error));
						process.exitCode = 1;
					} finally {
						store.close();
					}
				},
			),
	)
	.addCommand(
		new Command("prune-observations")
			.configureHelp(helpStyle)
			.description("Deactivate low-signal observations (does not delete rows)")
			.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--limit <n>", "max observations to check")
			.option("--dry-run", "preview deactivations without writing")
			.option("--json", "output as JSON")
			.action(
				(opts: {
					db?: string;
					dbPath?: string;
					limit?: string;
					dryRun?: boolean;
					json?: boolean;
				}) => {
					const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
					try {
						const limit = parseOptionalPositiveInt(opts.limit);
						const result = deactivateLowSignalObservations(
							store.db,
							limit ?? null,
							opts.dryRun === true,
						);

						if (opts.json) {
							console.log(JSON.stringify(result, null, 2));
							return;
						}

						const action = opts.dryRun ? "Would deactivate" : "Deactivated";
						p.intro("codemem db prune-observations");
						p.outro(`${action} ${result.deactivated} of ${result.checked} observations`);
					} catch (error) {
						p.log.error(error instanceof Error ? error.message : String(error));
						process.exitCode = 1;
					} finally {
						store.close();
					}
				},
			),
	)
	.addCommand(
		new Command("prune-memories")
			.configureHelp(helpStyle)
			.description("Deactivate low-signal memories across selected kinds")
			.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
			.option("--limit <n>", "max memories to check")
			.option("--kinds <csv>", "comma-separated memory kinds (default set when omitted)")
			.option("--dry-run", "preview deactivations without writing")
			.option("--json", "output as JSON")
			.action(
				(opts: {
					db?: string;
					dbPath?: string;
					limit?: string;
					kinds?: string;
					dryRun?: boolean;
					json?: boolean;
				}) => {
					const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
					try {
						const limit = parseOptionalPositiveInt(opts.limit);
						const kinds = parseKindsCsv(opts.kinds);
						const result = deactivateLowSignalMemories(store.db, {
							kinds,
							limit: limit ?? null,
							dryRun: opts.dryRun === true,
						});

						if (opts.json) {
							console.log(JSON.stringify(result, null, 2));
							return;
						}

						const action = opts.dryRun ? "Would deactivate" : "Deactivated";
						p.intro("codemem db prune-memories");
						p.outro(`${action} ${result.deactivated} of ${result.checked} memories`);
					} catch (error) {
						p.log.error(error instanceof Error ? error.message : String(error));
						process.exitCode = 1;
					} finally {
						store.close();
					}
				},
			),
	);
