/* `codemem maintenance` — inspect background backfill / migration jobs.
 *
 * Opens the local sqlite db directly (no viewer required) and reads the
 * `maintenance_jobs` table, surfacing status, progress, and timestamps.
 * Pairs with the viewer's /api/stats which only shows active + recently-
 * completed jobs.
 */

import * as p from "@clack/prompts";
import {
	listMaintenanceJobs,
	type MaintenanceJobSnapshot,
	MemoryStore,
	resolveDbPath,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { startMaintenanceWorkerRuntime } from "../maintenance-worker-runtime.js";
import {
	addConfigOption,
	addDbOption,
	addJsonOption,
	type ConfigOpts,
	type DbOpts,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";

const maintenanceCmd = new Command("maintenance")
	.configureHelp(helpStyle)
	.description("Inspect background maintenance / backfill jobs");

const statusCmd = new Command("status")
	.configureHelp(helpStyle)
	.description("Print current status of all maintenance jobs");

addDbOption(statusCmd);
addJsonOption(statusCmd);

const workerCmd = new Command("worker")
	.configureHelp(helpStyle)
	.description("Run maintenance worker plumbing");

addDbOption(workerCmd);
addConfigOption(workerCmd);

statusCmd.action((opts: DbOpts & JsonOpts) => {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		const jobs = listMaintenanceJobs(store.db);
		if (opts.json) {
			console.log(JSON.stringify({ jobs }, null, 2));
			return;
		}
		printJobsTable(jobs);
	} finally {
		store.close();
	}
});

export async function runMaintenanceWorkerCommand(opts: DbOpts & ConfigOpts): Promise<void> {
	const dbPath = resolveDbPath(resolveDbOpt(opts));
	if (opts.config) process.env.CODEMEM_CONFIG = opts.config;
	process.env.CODEMEM_DB = dbPath;

	const abort = new AbortController();
	const runtime = startMaintenanceWorkerRuntime({
		dbPath,
		configPath: opts.config ?? null,
		signal: abort.signal,
	});
	const keepAlive = setInterval(() => undefined, 60_000);
	let stopping = false;

	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		abort.abort();
		clearInterval(keepAlive);
		const forceExit = setTimeout(() => {
			process.exit(1);
		}, 30_000);
		try {
			await runtime.stop();
			process.exit(0);
		} finally {
			clearTimeout(forceExit);
		}
	};

	await new Promise<void>((resolve, reject) => {
		process.once("SIGINT", () => void shutdown().then(resolve, reject));
		process.once("SIGTERM", () => void shutdown().then(resolve, reject));
	});
}

workerCmd.action(async (opts: DbOpts & ConfigOpts) => {
	try {
		await runMaintenanceWorkerCommand(opts);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
});

maintenanceCmd.addCommand(statusCmd);
maintenanceCmd.addCommand(workerCmd, { hidden: true });

export const maintenanceCommand = maintenanceCmd;

function printJobsTable(jobs: MaintenanceJobSnapshot[]): void {
	p.intro("codemem maintenance");
	if (jobs.length === 0) {
		p.log.info("No maintenance jobs recorded in this database.");
		p.outro("done");
		return;
	}

	// Sort: running first, then pending, then recently-finished, then older.
	const statusRank: Record<string, number> = {
		running: 0,
		pending: 1,
		failed: 2,
		cancelled: 3,
		completed: 4,
	};
	const sorted = [...jobs].sort((a, b) => {
		const rankDiff = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
		if (rankDiff !== 0) return rankDiff;
		return b.updated_at.localeCompare(a.updated_at);
	});

	for (const job of sorted) {
		const progress = formatProgress(job);
		const when = job.finished_at
			? `finished ${shortAge(job.finished_at)} ago`
			: job.started_at
				? `started ${shortAge(job.started_at)} ago`
				: `updated ${shortAge(job.updated_at)} ago`;
		const header = `${job.kind} · ${job.status}${progress ? ` · ${progress}` : ""} · ${when}`;
		const body = [job.title, job.message, job.error ? `error: ${job.error}` : null]
			.filter(Boolean)
			.join("\n");
		const logger =
			job.status === "failed"
				? p.log.error
				: job.status === "completed"
					? p.log.success
					: p.log.step;
		logger(`${header}\n${body}`);
	}

	p.outro("done");
}

function formatProgress(job: MaintenanceJobSnapshot): string | null {
	const { current, total, unit } = job.progress;
	if (!current && !total) return null;
	const unitLabel = unit || "items";
	if (total == null || total <= 0) return `${current.toLocaleString()} ${unitLabel}`;
	const pct = Math.round((100 * current) / total);
	return `${current.toLocaleString()}/${total.toLocaleString()} ${unitLabel} (${pct}%)`;
}

function shortAge(iso: string): string {
	const parsed = Date.parse(iso);
	if (!Number.isFinite(parsed)) return iso;
	const seconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	const days = Math.round(hours / 24);
	return `${days}d`;
}
