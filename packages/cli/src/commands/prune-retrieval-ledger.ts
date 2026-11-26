/* `codemem maintenance database prune-retrieval-ledger`: remove expired retrieval history now.
 *
 * The maintenance worker removes the same rows in the background, a few seconds of work at
 * a time. This runs passes until none remain, still one short transaction per batch.
 */
import * as p from "@clack/prompts";
import {
	connect,
	DEFAULT_LEDGER_RETENTION_BATCH_SIZE,
	NON_SELECTED_EXPOSURE_RETENTION_DAYS,
	type RetrievalLedgerStats,
	resolveDbPath,
	retrievalLedgerStats,
	runLedgerRetentionPass,
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

type PruneLedgerOpts = DbOpts & JsonOpts & { dryRun?: boolean; batchSize: string };

export function createDatabasePruneRetrievalLedgerCommand(): Command {
	const cmd = new Command("prune-retrieval-ledger")
		.configureHelp(helpStyle)
		.description(
			`Delete retrieval history and outcome evidence past their retention date, and candidates an attempt did not select after ${NON_SELECTED_EXPOSURE_RETENTION_DAYS} days (pinned rows are kept)`,
		)
		.option("--dry-run", "show what is past retention without deleting")
		.option(
			"--batch-size <n>",
			"retrieval attempts deleted per transaction",
			String(DEFAULT_LEDGER_RETENTION_BATCH_SIZE),
		);
	addDbOption(cmd);
	addJsonOption(cmd);
	return cmd.action(runPruneRetrievalLedger);
}

function parseBatchSize(raw: string): number | null {
	const value = raw.trim();
	if (!/^\d+$/.test(value)) return null;
	const parsed = Number.parseInt(value, 10);
	return parsed >= 1 && parsed <= 10_000 ? parsed : null;
}

function describeStats(stats: RetrievalLedgerStats): string {
	return [
		`Retrieval attempts: ${stats.retrieval_attempts.toLocaleString()} (${stats.expired_retrieval_attempts.toLocaleString()} past retention, removed with their candidates)`,
		`Retrieval exposures: ${stats.retrieval_exposures.toLocaleString()}`,
		`  Not selected: ${stats.non_selected_retrieval_exposures.toLocaleString()} (${stats.stale_non_selected_retrieval_exposures.toLocaleString()} older than ${NON_SELECTED_EXPOSURE_RETENTION_DAYS} days)`,
		`Outcome evidence: ${stats.outcome_evidence.toLocaleString()} (${stats.expired_outcome_evidence.toLocaleString()} past retention)`,
	].join("\n");
}

async function pruneUntilDone(db: ReturnType<typeof connect>, batchSize: number) {
	const now = new Date().toISOString();
	const totals = {
		retrieval_attempts: 0,
		non_selected_retrieval_exposures: 0,
		outcome_evidence: 0,
		batches: 0,
	};
	for (;;) {
		const pass = await runLedgerRetentionPass(db, { now, batchSize });
		totals.retrieval_attempts += pass.retrievalAttemptsPurged;
		totals.non_selected_retrieval_exposures += pass.nonSelectedExposuresPurged;
		totals.outcome_evidence += pass.outcomeEvidencePurged;
		totals.batches += pass.batches;
		// A pass that removed nothing cannot make progress by repeating.
		const progressed =
			pass.retrievalAttemptsPurged + pass.nonSelectedExposuresPurged + pass.outcomeEvidencePurged >
			0;
		if (pass.complete || !progressed) return totals;
	}
}

function reportFailure(opts: JsonOpts, code: string, message: string, exitCode: number): void {
	if (opts.json) {
		emitJsonError(code, message, exitCode);
		return;
	}
	p.log.error(message);
	process.exitCode = exitCode;
}

function reportHuman(purged: Awaited<ReturnType<typeof pruneUntilDone>> | null): void {
	if (!purged) {
		p.outro("Dry run only; no changes made");
		return;
	}
	p.log.success(
		`Deleted ${purged.retrieval_attempts.toLocaleString()} retrieval attempts with their exposures, ${purged.non_selected_retrieval_exposures.toLocaleString()} candidates that older attempts did not select, and ${purged.outcome_evidence.toLocaleString()} outcome evidence rows`,
	);
	// Deleted pages are reused for new rows; the file only shrinks after VACUUM.
	p.outro("Done. The database file keeps its size until `maintenance database vacuum`.");
}

async function runPruneRetrievalLedger(opts: PruneLedgerOpts): Promise<void> {
	const batchSize = parseBatchSize(opts.batchSize);
	if (batchSize === null) {
		const message = `--batch-size must be an integer from 1 to 10000 (got "${opts.batchSize}")`;
		reportFailure(opts, "invalid_batch_size", message, 2);
		return;
	}
	let db: ReturnType<typeof connect> | null = null;
	try {
		db = connect(resolveDbPath(resolveDbOpt(opts)));
		const before = retrievalLedgerStats(db);
		if (!opts.json) {
			p.intro("codemem maintenance database prune-retrieval-ledger");
			p.log.info(describeStats(before));
		}
		const purged = opts.dryRun ? null : await pruneUntilDone(db, batchSize);
		const after = purged ? retrievalLedgerStats(db) : before;
		if (opts.json) {
			const dryRun = Boolean(opts.dryRun);
			console.log(JSON.stringify({ dry_run: dryRun, before, purged, after }, null, 2));
		} else {
			reportHuman(purged);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		reportFailure(opts, "prune_retrieval_ledger_failed", message, 1);
	} finally {
		db?.close();
	}
}
