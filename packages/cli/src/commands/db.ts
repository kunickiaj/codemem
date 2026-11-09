import { statSync } from "node:fs";
import * as p from "@clack/prompts";
import {
	ALLOWED_MEMORY_KINDS,
	aiBackfillStructuredContent,
	backfillMemoryDedupKeys,
	backfillNarrativeFromBody,
	backfillTagsText,
	connect,
	deactivateLowSignalMemories,
	dedupNearDuplicateMemories,
	getRawEventStatus,
	initDatabase,
	listRetentionScopeIds,
	MemoryStore,
	planReplicationOpsAgePrune,
	pruneReplicationOpsUntilCaughtUp,
	rawEventsGate,
	resolveDbPath,
	resolveProject,
	retryRawEventFailures,
	scanSecretsRetroactive,
	vacuumDatabase,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addDbOption,
	addJsonOption,
	type DbOpts,
	emitJsonError,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";

function escapeSqlLikePattern(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

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

// Preserve historical defaults, including legacy kinds, without adding exploration.
const DEFAULT_PRUNE_KINDS = [
	"observation",
	"discovery",
	"change",
	"feature",
	"bugfix",
	"refactor",
	"decision",
	"note",
	"entities",
	"session_summary",
];

function collectKind(value: string, previous: string[] = []): string[] {
	return [...previous, value];
}

function resolvePruneKinds(
	opts: { kind?: string[]; kinds?: string },
	defaultKinds: string[],
): string[] {
	if (!opts.kind?.length && opts.kinds === undefined) return [...defaultKinds];
	const selected = [...(opts.kind ?? []), ...(opts.kinds?.split(",") ?? [])].map((kind) =>
		kind.trim().toLowerCase(),
	);
	const allowed = new Set([...ALLOWED_MEMORY_KINDS, ...DEFAULT_PRUNE_KINDS]);
	for (const kind of selected) {
		if (!allowed.has(kind)) {
			throw new Error(`Invalid memory kind "${kind}". Allowed: ${[...allowed].join(", ")}`);
		}
	}
	return [...new Set(selected)];
}

function estimateReplicationOpsBytes(db: ReturnType<typeof connect>): number {
	try {
		const row = db
			.prepare(
				`SELECT COALESCE(SUM(pgsize), 0) AS total_bytes
				 FROM dbstat
				 WHERE name = 'replication_ops'
				    OR name LIKE 'idx_replication_ops_%'
				    OR name LIKE 'sqlite_autoindex_replication_ops_%'`,
			)
			.get() as { total_bytes?: number } | undefined;
		return Number(row?.total_bytes ?? 0);
	} catch {
		return 0;
	}
}

// --- db init ---
export function createDatabaseInitCommand(name = "init"): Command {
	const initCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Create or verify the SQLite database and schema");
	addDbOption(initCmd);
	initCmd.action((opts: DbOpts) => {
		try {
			const result = initDatabase(resolveDbOpt(opts));
			p.intro("codemem maintenance database init");
			p.log.success(`Database ready: ${result.path}`);
			p.outro(`Size: ${result.sizeBytes.toLocaleString()} bytes`);
		} catch (error) {
			p.log.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	});
	return initCmd;
}

// --- db vacuum ---
export function createDatabaseVacuumCommand(name = "vacuum"): Command {
	const vacuumCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Run VACUUM on the SQLite database");
	addDbOption(vacuumCmd);
	vacuumCmd.action((opts: DbOpts) => {
		try {
			const result = vacuumDatabase(resolveDbOpt(opts));
			p.intro("codemem maintenance database vacuum");
			p.log.success(`Vacuumed: ${result.path}`);
			p.outro(`Size: ${result.sizeBytes.toLocaleString()} bytes`);
		} catch (error) {
			p.log.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	});
	return vacuumCmd;
}

// --- db prune-replication-ops ---
export function createDatabasePruneHistoryCommand(name = "prune-history"): Command {
	const pruneReplCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Delete older sync history with approximate oldest-first retention")
		.option("--dry-run", "show current size/targets without deleting")
		.option("--max-age-days <days>", "retention age threshold in days", "30")
		.option("--max-size-mb <mb>", "target sync history size per sharing scope in MB", "512")
		.option("--batch-ops <n>", "max history entries deleted per batch", "5000")
		.option("--batch-runtime-ms <ms>", "max runtime per batch in ms", "2000")
		.option("--vacuum", "run VACUUM explicitly after prune completes");
	addDbOption(pruneReplCmd);
	return pruneReplCmd.action(runDatabasePruneHistory);
}

const runDatabasePruneHistory = (
	opts: DbOpts & {
		dryRun?: boolean;
		maxAgeDays: string;
		maxSizeMb: string;
		batchOps: string;
		batchRuntimeMs: string;
		vacuum?: boolean;
	},
) => {
	const dbPath = resolveDbPath(resolveDbOpt(opts));
	const db = connect(dbPath);
	let dbOpen = true;
	try {
		const maxAgeDays = Number.parseInt(opts.maxAgeDays, 10) || 30;
		const maxSizeMb = Number.parseInt(opts.maxSizeMb, 10) || 512;
		const batchOps = Number.parseInt(opts.batchOps, 10) || 5000;
		const batchRuntimeMs = Number.parseInt(opts.batchRuntimeMs, 10) || 2000;
		const beforeBytes = estimateReplicationOpsBytes(db);
		p.intro("codemem maintenance database prune-history");
		p.log.info(`Replication ops size: ${formatBytes(beforeBytes)}`);
		p.log.info(
			`Policy: across all replication scopes, approximately prune oldest-first toward <= ${maxSizeMb} MB PER SCOPE while removing history older than ${maxAgeDays} day(s), subject to per-pass batch/runtime limits (the size budget is applied per scope, matching the background retention runner; total ops across scopes may exceed it)`,
		);
		// Enumerate every replication scope present in the DB (DEFAULT first).
		// The background retention runner prunes all of them; the offline CLI
		// must too, otherwise scopes like legacy-shared-review/oss are never
		// reclaimed and the command is useless for a bloated multi-scope DB.
		const scopeIds = listRetentionScopeIds(db);
		// planReplicationOpsAgePrune is whole-table (no scope filter), so the
		// candidate count already reflects every scope the real prune will cover.
		const agePlan = planReplicationOpsAgePrune(db, maxAgeDays, batchOps);
		if (agePlan.candidate_ops > 0) {
			p.log.info(
				`Age pass plan (all scopes): ${agePlan.candidate_ops.toLocaleString()} ops, ~${formatBytes(agePlan.estimated_candidate_bytes)} in ~${agePlan.estimated_batches.toLocaleString()} batch(es), cutoff ${agePlan.cutoff_cursor}`,
			);
		} else {
			p.log.info("Age pass plan: no ops older than cutoff");
		}

		if (opts.dryRun) {
			p.outro("Dry run only; no changes made");
			return;
		}

		let totalDeleted = 0;
		let anyStoppedByBudget = false;
		let lastFloor: string | null = null;
		for (const scopeId of scopeIds) {
			const loopResult = pruneReplicationOpsUntilCaughtUp(db, {
				maxAgeDays,
				maxSizeBytes: maxSizeMb * 1024 * 1024,
				maxDeleteOps: batchOps,
				maxRuntimeMs: batchRuntimeMs,
				scopeId,
				onPass: (pass) => {
					if (pass.deleted === 0 && !pass.stoppedByBudget) return;
					const suffix = pass.stoppedByBudget ? " (budget-limited)" : "";
					p.log.step(
						`scope ${scopeId} pass ${pass.passNumber}: deleted ${pass.deleted.toLocaleString()} ops${suffix}`,
					);
				},
			});
			totalDeleted += loopResult.totalDeleted;
			if (loopResult.totalDeleted > 0) {
				p.log.info(`scope ${scopeId}: deleted ${loopResult.totalDeleted.toLocaleString()} ops`);
			}
			if (loopResult.lastFloor) lastFloor = loopResult.lastFloor;
			if (loopResult.stoppedByBudget) anyStoppedByBudget = true;
		}

		p.log.info(`Deleted ops (all scopes): ${totalDeleted.toLocaleString()}`);
		// Recompute the whole-table physical size so before/after are the same
		// dbstat measure. (Per-scope afterBytes is a logical content estimate and
		// is not comparable to the whole-table before-size.)
		const afterBytes = estimateReplicationOpsBytes(db);
		p.log.info(
			`Estimated replication ops size after prune: ${formatBytes(afterBytes)} (approximate)`,
		);
		if (lastFloor) p.log.info(`Retained floor: ${lastFloor}`);
		if (anyStoppedByBudget) {
			p.log.warn(
				"Prune stopped because the current batch/runtime budget was exhausted before retention caught up. Re-run with higher --batch-ops or --batch-runtime-ms for faster catch-up.",
			);
		}
		if (opts.vacuum) {
			p.log.step("Running VACUUM as requested...");
			db.close();
			dbOpen = false;
			const vacuumed = vacuumDatabase(dbPath);
			p.outro(`Done. VACUUM complete. File size is now ${formatBytes(vacuumed.sizeBytes)}.`);
			return;
		}
		p.outro(
			"Done. Retention is approximate oldest-first pruning. SQLite file size may not shrink until you run `codemem maintenance database vacuum` explicitly (or re-run this command with --vacuum).",
		);
	} finally {
		if (dbOpen) db.close();
	}
};

// --- db prune-raw-events ---
export function createDatabasePruneEventsCommand(name = "prune-events"): Command {
	const pruneRawEventsCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Delete older captured events, including events not yet processed")
		.option("--dry-run", "show current size/targets without deleting")
		.option("--max-age-days <days>", "retention age threshold in days", "90")
		.option("--vacuum", "run VACUUM explicitly after prune completes");
	addDbOption(pruneRawEventsCmd);
	return pruneRawEventsCmd.action(runDatabasePruneEvents);
}

const runDatabasePruneEvents = (
	opts: DbOpts & {
		dryRun?: boolean;
		maxAgeDays: string;
		vacuum?: boolean;
	},
) => {
	// Validate before opening the DB. This is a destructive command and
	// raw_events are the re-extraction source, so a mistyped/zero age must be
	// rejected rather than silently coerced to a real purge window. Match the
	// WHOLE string against digits: Number.parseInt would accept "1foo"/"1.5"
	// as 1 and proceed to delete.
	const rawAge = opts.maxAgeDays.trim();
	const maxAgeDays = Number.parseInt(rawAge, 10);
	if (!/^\d+$/.test(rawAge) || !Number.isInteger(maxAgeDays) || maxAgeDays < 1) {
		p.log.error(
			`--max-age-days must be a positive integer (got "${opts.maxAgeDays}"). ` +
				"Refusing to run a destructive prune on invalid input.",
		);
		process.exitCode = 1;
		return;
	}
	const dbPath = resolveDbPath(resolveDbOpt(opts));
	// Construct the store inside the guarded block so an unreadable or
	// schema-incompatible DB surfaces a clean error + exit code rather than an
	// uncaught throw from the command handler.
	let store: MemoryStore | null = null;
	try {
		store = new MemoryStore(dbPath);
		const maxAgeMs = maxAgeDays * 86_400_000;
		const status = store.rawEventsRetentionStatus(maxAgeMs);
		p.intro("codemem maintenance database prune-events");
		p.log.warn(
			"Captured events are the source for extracting memories again. Age-based purge does not check extraction progress: " +
				"pruning a window shorter than your extraction lag can delete un-extracted events. " +
				"The 90-day default mitigates this.",
		);
		p.log.info(
			`Captured events: ${status.total_rows.toLocaleString()} rows, ~${formatBytes(status.estimated_bytes)} on disk`,
		);
		p.log.info(
			`Older than ${maxAgeDays} day(s): ${status.candidate_rows.toLocaleString()} row(s) to delete`,
		);

		if (opts.dryRun) {
			p.outro("Dry run only; no changes made");
			return;
		}

		const deleted = store.purgeRawEvents(maxAgeMs);
		p.log.info(`Deleted captured events: ${deleted.toLocaleString()}`);
		if (opts.vacuum) {
			p.log.step("Running VACUUM as requested...");
			store.close();
			store = null;
			const vacuumed = vacuumDatabase(dbPath);
			p.outro(`Done. VACUUM complete. File size is now ${formatBytes(vacuumed.sizeBytes)}.`);
			return;
		}
		p.outro(
			"Done. SQLite file size may not shrink until you run `codemem maintenance database vacuum` explicitly (or re-run this command with --vacuum).",
		);
	} catch (error) {
		p.log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		store?.close();
	}
};

// --- db raw-events-status ---
export function createCaptureStatusCommand(name = "status"): Command {
	const rawEventsStatusCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Show captured events waiting to be processed by source")
		.option("-n, --limit <n>", "max rows to show", "25");
	addDbOption(rawEventsStatusCmd);
	addJsonOption(rawEventsStatusCmd);
	return rawEventsStatusCmd.action(runCaptureStatus);
}

const runCaptureStatus = (opts: DbOpts & JsonOpts & { limit: string }) => {
	try {
		const result = getRawEventStatus(resolveDbOpt(opts), Number.parseInt(opts.limit, 10) || 25);
		if (opts.json) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}
		p.intro("codemem diagnostics capture status");
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
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to read raw-event status";
		if (opts.json) {
			emitJsonError("raw_events_status_failed", message);
		} else {
			p.log.error(message);
			process.exitCode = 1;
		}
	}
};

// --- db raw-events-retry ---
export function createCaptureRetryCommand(name = "retry"): Command {
	const rawEventsRetryCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Retry failed capture batches (extraction may incur API costs)")
		.option("-n, --limit <n>", "max failed batches to requeue", "25");
	addDbOption(rawEventsRetryCmd);
	rawEventsRetryCmd.action((opts: DbOpts & { limit: string }) => {
		try {
			const result = retryRawEventFailures(
				resolveDbOpt(opts),
				Number.parseInt(opts.limit, 10) || 25,
			);
			p.intro("codemem diagnostics capture retry");
			p.outro(`Requeued ${result.retried.toLocaleString()} failed batch(es)`);
		} catch (error) {
			p.log.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	});
	return rawEventsRetryCmd;
}

// --- db raw-events-gate ---
export function createCaptureCheckCommand(name = "check"): Command {
	const rawEventsGateCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Check capture reliability thresholds (non-zero exit on failure)")
		.option("--min-flush-success-rate <rate>", "minimum successful capture batch rate", "0.95")
		.option("--max-dropped-event-rate <rate>", "maximum dropped event rate", "0.05")
		.option("--min-session-boundary-accuracy <rate>", "minimum session boundary accuracy", "0.9")
		.option("--window-hours <hours>", "lookback window in hours", "24");
	addDbOption(rawEventsGateCmd);
	addJsonOption(rawEventsGateCmd);
	rawEventsGateCmd.action(
		(
			opts: DbOpts &
				JsonOpts & {
					minFlushSuccessRate: string;
					maxDroppedEventRate: string;
					minSessionBoundaryAccuracy: string;
					windowHours: string;
				},
		) => {
			const result = rawEventsGate(resolveDbOpt(opts), {
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

			p.intro("codemem diagnostics capture check");
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
	);
	return rawEventsGateCmd;
}

export function createProjectRenameCommand(): Command {
	const renameProjectCmd = new Command("rename")
		.configureHelp(helpStyle)
		.description("Rename a project in stored history")
		.argument("<old-name>", "current project name")
		.argument("<new-name>", "new project name")
		.option("--apply", "apply changes (default is dry-run)");
	addDbOption(renameProjectCmd);
	return renameProjectCmd.action(runProjectRename);
}

const runProjectRename = (oldName: string, newName: string, opts: DbOpts & { apply?: boolean }) => {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		const dryRun = !opts.apply;
		const escapedOld = escapeSqlLikePattern(oldName);
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
		p.intro("codemem maintenance project rename");
		p.log.info(`${action} ${oldName} → ${newName}`);
		p.log.info(
			[`Sessions: ${counts.sessions}`, `Raw event sessions: ${counts.raw_event_sessions}`].join(
				"\n",
			),
		);
		if (dryRun) {
			p.outro("Pass --apply to execute");
		} else {
			p.outro("done");
		}
	} catch (error) {
		p.log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		store.close();
	}
};

export function createProjectNormalizeCommand(): Command {
	const normalizeProjectsCmd = new Command("normalize")
		.configureHelp(helpStyle)
		.description("Normalize project paths to directory names")
		.option("--apply", "apply changes (default is dry-run)");
	addDbOption(normalizeProjectsCmd);
	return normalizeProjectsCmd.action(runProjectNormalize);
}

const runProjectNormalize = (opts: DbOpts & { apply?: boolean }) => {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
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

		p.intro("codemem maintenance project normalize");
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
	} catch (error) {
		p.log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		store.close();
	}
};

// --- db size-report ---
export function createDatabaseStatsCommand(name = "stats"): Command {
	const sizeReportCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Show SQLite file size and major storage consumers")
		.option("--limit <n>", "number of largest tables/indexes to show", "12");
	addDbOption(sizeReportCmd);
	addJsonOption(sizeReportCmd);
	return sizeReportCmd.action(runDatabaseStats);
}

const runDatabaseStats = (opts: DbOpts & JsonOpts & { limit: string }) => {
	const dbPath = resolveDbPath(resolveDbOpt(opts));
	const db = connect(dbPath);
	try {
		const limit = Math.max(1, Number.parseInt(opts.limit, 10) || 12);
		const fileSizeBytes = statSync(dbPath).size;
		const pageInfo = db
			.prepare("SELECT page_count * page_size as total FROM pragma_page_count, pragma_page_size")
			.get() as { total: number } | undefined;
		const freePages = db.prepare("SELECT freelist_count FROM pragma_freelist_count").get() as
			| { freelist_count: number }
			| undefined;
		const pageSize = db.prepare("PRAGMA page_size").get() as { page_size: number } | undefined;
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

		p.intro("codemem maintenance database stats");
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
};

// --- db backfill-tags ---
export function createBackfillTagsCommand(name = "tags"): Command {
	const backfillTagsCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Fill missing memory tags from stored content")
		.option("--limit <n>", "max memories to check")
		.option("--since <iso>", "only memories created at/after this ISO timestamp")
		.option("--project <project>", "project identifier (defaults to git repo root)")
		.option("--all-projects", "backfill across all projects")
		.option("--inactive", "include inactive memories")
		.option("--dry-run", "preview updates without writing");
	addDbOption(backfillTagsCmd);
	addJsonOption(backfillTagsCmd);
	backfillTagsCmd.action(
		(
			opts: DbOpts &
				JsonOpts & {
					limit?: string;
					since?: string;
					project?: string;
					allProjects?: boolean;
					inactive?: boolean;
					dryRun?: boolean;
				},
		) => {
			const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
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
					scanner: store.scanner,
				});

				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}

				const action = opts.dryRun ? "Would update" : "Updated";
				p.intro("codemem maintenance backfill tags");
				p.log.success(`${action} ${result.updated} memories (skipped ${result.skipped})`);
				p.outro(`Checked ${result.checked} memories`);
			} catch (error) {
				p.log.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			} finally {
				store.close();
			}
		},
	);
	return backfillTagsCmd;
}

// --- db prune-memories ---
export function createMemoryPruneCommand(
	name = "prune",
	{ defaultKinds = DEFAULT_PRUNE_KINDS }: { defaultKinds?: string[] } = {},
): Command {
	const pruneMemCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Deactivate low-signal memories")
		.option("--limit <n>", "max memories to check")
		.option("--kind <kind>", "kind to target (repeatable, combined with --kinds)", collectKind)
		.option("--kinds <csv>", "comma-separated kinds, combined with --kind to replace defaults")
		.option("--dry-run", "preview deactivations without writing")
		.addHelpText(
			"after",
			`\nDefault kinds: ${defaultKinds.join(", ")}.\nEither kind flag replaces the defaults. Both flags combine into one set.\nWithout --dry-run, matching memories become inactive. Rows and stored secrets remain.`,
		);
	addDbOption(pruneMemCmd);
	addJsonOption(pruneMemCmd);
	pruneMemCmd.action(
		(
			opts: DbOpts &
				JsonOpts & {
					limit?: string;
					kinds?: string;
					kind?: string[];
					dryRun?: boolean;
				},
		) => {
			let store: MemoryStore | null = null;
			try {
				const limit = parseOptionalPositiveInt(opts.limit);
				const kinds = resolvePruneKinds(opts, defaultKinds);
				store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
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
				p.intro("codemem maintenance memory prune");
				p.outro(`${action} ${result.deactivated} of ${result.checked} memories`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (opts.json) emitJsonError("memory_prune_failed", message);
				else {
					p.log.error(message);
					process.exitCode = 1;
				}
			} finally {
				store?.close();
			}
		},
	);
	return pruneMemCmd;
}

// --- db dedup-memories ---
export function createMemoryDeduplicateCommand(name = "deduplicate"): Command {
	const dedupCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Deactivate near-duplicate memories across sessions without deleting rows")
		.option("--window <ms>", "max time gap in milliseconds between duplicates (default: 3600000)")
		.option("--limit <n>", "max pairs to check")
		.option("--dry-run", "preview deactivations without writing");
	addDbOption(dedupCmd);
	addJsonOption(dedupCmd);
	return dedupCmd.action(runMemoryDeduplicate);
}

const runMemoryDeduplicate = (
	opts: DbOpts &
		JsonOpts & {
			window?: string;
			limit?: string;
			dryRun?: boolean;
		},
) => {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		const windowMs = parseOptionalPositiveInt(opts.window);
		const limit = parseOptionalPositiveInt(opts.limit);
		const result = dedupNearDuplicateMemories(store.db, {
			windowMs,
			limit,
			dryRun: opts.dryRun === true,
		});

		if (opts.json) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}

		const action = opts.dryRun ? "Would deactivate" : "Deactivated";
		p.intro("codemem maintenance memory deduplicate");
		if (result.pairs.length > 0 && result.pairs.length <= 20) {
			for (const pair of result.pairs) {
				p.log.info(
					`${action} [${pair.deactivated_id}] (kept [${pair.kept_id}]): ${pair.title.slice(0, 80)}`,
				);
			}
		}
		p.outro(`${action} ${result.deactivated} duplicates from ${result.checked} pairs`);
	} catch (error) {
		p.log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		store.close();
	}
};

export function createBackfillDedupKeysCommand(name = "dedup-keys"): Command {
	const backfillDedupKeysCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Fill missing duplicate-detection keys for older memories")
		.option("--limit <n>", "max memories to check")
		.option("--dry-run", "preview updates without writing");
	addDbOption(backfillDedupKeysCmd);
	addJsonOption(backfillDedupKeysCmd);
	backfillDedupKeysCmd.action(
		(
			opts: DbOpts &
				JsonOpts & {
					limit?: string;
					dryRun?: boolean;
				},
		) => {
			const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
			try {
				const limit = parseOptionalPositiveInt(opts.limit);
				const result = backfillMemoryDedupKeys(store.db, {
					limit,
					dryRun: opts.dryRun === true,
				});

				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}

				const action = opts.dryRun ? "Would update" : "Updated";
				p.intro("codemem maintenance backfill dedup-keys");
				p.log.success(`${action} ${result.updated} memories (skipped ${result.skipped})`);
				p.outro(`Checked ${result.checked} memories`);
			} catch (error) {
				p.log.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			} finally {
				store.close();
			}
		},
	);
	return backfillDedupKeysCmd;
}

// --- db backfill-narrative ---
export function createBackfillNarrativeCommand(name = "narrative"): Command {
	const backfillNarrativeCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Fill missing narratives from stored session summaries")
		.option("--limit <n>", "max memories to check")
		.option("--dry-run", "preview updates without writing");
	addDbOption(backfillNarrativeCmd);
	addJsonOption(backfillNarrativeCmd);
	backfillNarrativeCmd.action(
		(
			opts: DbOpts &
				JsonOpts & {
					limit?: string;
					dryRun?: boolean;
				},
		) => {
			const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
			try {
				const limit = parseOptionalPositiveInt(opts.limit);
				const result = backfillNarrativeFromBody(store.db, {
					limit,
					dryRun: opts.dryRun === true,
					scanner: store.scanner,
				});

				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}

				const action = opts.dryRun ? "Would update" : "Updated";
				p.intro("codemem maintenance backfill narrative");
				p.log.success(`${action} ${result.updated} memories (skipped ${result.skipped})`);
				p.outro(`Checked ${result.checked} memories`);
			} catch (error) {
				p.log.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			} finally {
				store.close();
			}
		},
	);
	return backfillNarrativeCmd;
}

// --- db ai-backfill-structured ---
export function createBackfillStructuredCommand(name = "structured"): Command {
	const aiBackfillStructuredCmd = new Command(name)
		.configureHelp(helpStyle)
		.description(
			"Send older memories to GPT-5.4 to fill missing narratives, facts, and concepts (API costs apply)",
		)
		.option("--limit <n>", "max memories to check")
		.option("--kinds <csv>", "comma-separated kinds to target")
		.option(
			"--overwrite",
			"overwrite existing structured fields instead of only filling missing ones",
		)
		.option("--dry-run", "preview updates without writing");
	addDbOption(aiBackfillStructuredCmd);
	addJsonOption(aiBackfillStructuredCmd);
	aiBackfillStructuredCmd.action(
		async (
			opts: DbOpts &
				JsonOpts & {
					limit?: string;
					kinds?: string;
					overwrite?: boolean;
					dryRun?: boolean;
				},
		) => {
			const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
			try {
				const limit = parseOptionalPositiveInt(opts.limit);
				const kinds = parseKindsCsv(opts.kinds);
				const result = await aiBackfillStructuredContent(store.db, {
					limit,
					kinds,
					overwrite: opts.overwrite === true,
					dryRun: opts.dryRun === true,
					scanner: store.scanner,
				});

				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}

				const action = opts.dryRun ? "Would update" : "Updated";
				p.intro("codemem maintenance backfill structured");
				p.log.success(
					`${action} ${result.updated} memories (skipped ${result.skipped}, failed ${result.failed})`,
				);
				p.outro(`Checked ${result.checked} memories`);
			} catch (error) {
				p.log.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
			} finally {
				store.close();
			}
		},
	);
	return aiBackfillStructuredCmd;
}

// --- db scan-secrets ---
export function createMemoryRedactSecretsCommand(name = "redact-secrets"): Command {
	const scanSecretsCmd = new Command(name)
		.configureHelp(helpStyle)
		.description("Redact secrets in stored memories")
		.option("--limit <n>", "max memories to scan in this run")
		.option("--dry-run", "report detections without rewriting any rows");
	addDbOption(scanSecretsCmd);
	addJsonOption(scanSecretsCmd);
	return scanSecretsCmd.action(runMemoryRedactSecrets);
}

const runMemoryRedactSecrets = (
	opts: DbOpts &
		JsonOpts & {
			limit?: string;
			dryRun?: boolean;
		},
) => {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		const limit = parseOptionalPositiveInt(opts.limit);
		const result = scanSecretsRetroactive(store.db, {
			limit,
			dryRun: opts.dryRun === true,
			scanner: store.scanner,
		});

		if (opts.json) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}

		const action = opts.dryRun ? "Would redact" : "Redacted";
		p.intro("codemem maintenance memory redact-secrets");
		p.log.success(`${action} ${result.updated} of ${result.checked} memories`);
		if (result.skippedOversized > 0) {
			p.log.warn(`Skipped ${result.skippedOversized} oversized rows (above default 1 MiB cap)`);
		}
		if (result.detections.length > 0) {
			const summary = result.detections.map((d) => `${d.kind}=${d.count}`).join(", ");
			p.log.info(`Detections: ${summary}`);
		}
		if (result.samples.length > 0) {
			const lines = result.samples.map((s) => {
				const kinds = s.detections.map((d) => `${d.kind}=${d.count}`).join(", ");
				const title = (s.redactedTitle ?? "").slice(0, 80);
				return `  #${s.id} [${kinds}]  ${title}`;
			});
			p.log.info(`Affected memories:\n${lines.join("\n")}`);
		}
		p.outro("Re-run with no changes to confirm idempotency");
	} catch (error) {
		p.log.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		store.close();
	}
};
