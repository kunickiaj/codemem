/**
 * Periodic retention for the retrieval ledger and outcome evidence.
 *
 * Each retrieval attempt and outcome evidence row carries a retention date. This removes
 * the rows whose date has passed, in short transactions, so a store with a large backlog
 * sheds it over several runs without holding the write lock for long. The candidates an
 * attempt did not select are removed sooner, after NON_SELECTED_EXPOSURE_RETENTION_DAYS; the
 * attempt and its selected candidates stay. Pinned rows and rows without a date are never
 * removed.
 */
import type { Database } from "better-sqlite3";
import {
	OUTCOME_EVIDENCE_CONTRACT_VERSION,
	purgeExpiredOutcomeEvidence,
} from "./outcome-evidence.js";
import {
	DEFAULT_RETENTION_MAX_RUNTIME_MS,
	drainInBatches,
	PeriodicRetentionRunner,
	type PeriodicRetentionRunnerOptions,
	type RetentionLogger,
	type RetentionPassOutcome,
	startRetentionBudget,
} from "./periodic-retention.js";
import {
	countStaleNonSelectedExposures,
	purgeExpiredRetrievalAttempts,
	purgeStaleNonSelectedExposures,
	RETRIEVAL_LEDGER_CONTRACT_VERSION,
} from "./retrieval-ledger.js";

/**
 * Attempts deleted per transaction. An attempt has about 20 exposure rows, so a batch
 * deletes a few thousand rows and commits in tens of milliseconds on a large store.
 */
export const DEFAULT_LEDGER_RETENTION_BATCH_SIZE = 200;
/** Work allowed in one pass before it stops and leaves the rest to the next pass. */
export const DEFAULT_LEDGER_RETENTION_MAX_RUNTIME_MS = DEFAULT_RETENTION_MAX_RUNTIME_MS;

export interface LedgerRetentionPassOptions {
	now?: string;
	batchSize?: number;
	maxRuntimeMs?: number;
	signal?: AbortSignal;
	/** Milliseconds clock for the runtime budget; tests replace it. */
	clock?: () => number;
}

export interface LedgerRetentionPassResult {
	retrievalAttemptsPurged: number;
	/** Exposures removed by the shorter retention of candidates an attempt did not select. */
	nonSelectedExposuresPurged: number;
	outcomeEvidencePurged: number;
	batches: number;
	/** Whether every expired row was removed; false when the pass stopped at its budget. */
	complete: boolean;
	durationMs: number;
}

function tableExists(db: Database, name: string): boolean {
	return (
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
		undefined
	);
}

/**
 * Removes expired retrieval attempts, then the non-selected exposures of attempts past the
 * shorter window, then expired outcome evidence, within one budget. A batch of the second rule
 * trims up to `batchSize` attempts.
 */
export async function runLedgerRetentionPass(
	db: Database,
	options: LedgerRetentionPassOptions = {},
): Promise<LedgerRetentionPassResult> {
	const budget = startRetentionBudget(options);
	// One cutoff for the whole pass: rows that expire while it runs wait for the next one.
	const now = options.now ?? new Date().toISOString();
	const batchSize = options.batchSize ?? DEFAULT_LEDGER_RETENTION_BATCH_SIZE;
	let batches = 0;
	const countBatch = () => {
		batches += 1;
	};
	const attempts = tableExists(db, "retrieval_attempts")
		? await drainInBatches(
				(limit) => purgeExpiredRetrievalAttempts(db, now, { limit }),
				batchSize,
				budget.outOfBudget,
				countBatch,
			)
		: { purged: 0, done: true };
	let nonSelectedExposuresPurged = 0;
	const nonSelected = tableExists(db, "retrieval_exposures")
		? await drainInBatches(
				(limit) => {
					const trimmed = purgeStaleNonSelectedExposures(db, now, { limit });
					nonSelectedExposuresPurged += trimmed.exposures;
					return trimmed.attempts;
				},
				batchSize,
				budget.outOfBudget,
				countBatch,
			)
		: { purged: 0, done: true };
	const evidence = tableExists(db, "outcome_evidence")
		? await drainInBatches(
				(limit) => purgeExpiredOutcomeEvidence(db, now, { limit }),
				batchSize,
				budget.outOfBudget,
				countBatch,
			)
		: { purged: 0, done: true };
	return {
		retrievalAttemptsPurged: attempts.purged,
		nonSelectedExposuresPurged,
		outcomeEvidencePurged: evidence.purged,
		batches,
		complete: attempts.done && nonSelected.done && evidence.done,
		durationMs: budget.elapsedMs(),
	};
}

export type LedgerRetentionLogger = RetentionLogger;

export interface LedgerRetentionRunnerOptions extends PeriodicRetentionRunnerOptions {
	pass?: Omit<LedgerRetentionPassOptions, "signal" | "now" | "clock">;
}

export function describeLedgerRetentionPass(result: LedgerRetentionPassResult): string {
	const remaining = result.complete ? "" : "; more expired rows remain";
	return `Retrieval ledger retention purged ${result.retrievalAttemptsPurged} attempts, ${result.nonSelectedExposuresPurged} non-selected candidates and ${result.outcomeEvidencePurged} outcome evidence rows in ${result.durationMs} ms${remaining}`;
}

/** Runs ledger retention passes on a timer in a long-lived process. */
export class LedgerRetentionRunner extends PeriodicRetentionRunner {
	protected readonly label = "Retrieval ledger retention";
	private readonly passOptions: LedgerRetentionRunnerOptions["pass"];

	constructor(options: LedgerRetentionRunnerOptions = {}) {
		super(options);
		this.passOptions = options.pass;
	}

	protected async runPass(db: Database): Promise<RetentionPassOutcome> {
		const result = await runLedgerRetentionPass(db, { ...this.passOptions, signal: this.signal });
		return {
			purged:
				result.retrievalAttemptsPurged +
				result.nonSelectedExposuresPurged +
				result.outcomeEvidencePurged,
			complete: result.complete,
			summary: describeLedgerRetentionPass(result),
		};
	}
}

export interface RetrievalLedgerStats {
	retrieval_attempts: number;
	retrieval_exposures: number;
	/** Exposures of candidates their attempt did not select. */
	non_selected_retrieval_exposures: number;
	/** Of those, the ones past the shorter non-selected window that retention will remove. */
	stale_non_selected_retrieval_exposures: number;
	/** Attempts past their retention date that retention has not removed yet. */
	expired_retrieval_attempts: number;
	oldest_retrieval_attempt_started_at: string | null;
	outcome_evidence: number;
	expired_outcome_evidence: number;
}

/** Row counts for the retrieval ledger. Counting exposures reads a whole index. */
export function retrievalLedgerStats(
	db: Database,
	now: string = new Date().toISOString(),
): RetrievalLedgerStats {
	const count = (sql: string, ...params: Array<string | number>) =>
		Number(
			db
				.prepare(sql)
				.pluck()
				.get(...params) ?? 0,
		);
	// The same condition the purge uses, so the count matches what retention will remove.
	const expired =
		"contract_version = ? AND retention_pinned = 0 AND retention_until IS NOT NULL AND retention_until <= ?";
	const attempts = tableExists(db, "retrieval_attempts");
	const evidence = tableExists(db, "outcome_evidence");
	const exposures = tableExists(db, "retrieval_exposures");
	return {
		retrieval_attempts: attempts ? count("SELECT count(*) FROM retrieval_attempts") : 0,
		retrieval_exposures: exposures ? count("SELECT count(*) FROM retrieval_exposures") : 0,
		non_selected_retrieval_exposures: exposures
			? count("SELECT count(*) FROM retrieval_exposures WHERE disposition <> 'selected'")
			: 0,
		stale_non_selected_retrieval_exposures:
			exposures && attempts ? countStaleNonSelectedExposures(db, now) : 0,
		expired_retrieval_attempts: attempts
			? count(
					`SELECT count(*) FROM retrieval_attempts WHERE ${expired}`,
					RETRIEVAL_LEDGER_CONTRACT_VERSION,
					now,
				)
			: 0,
		oldest_retrieval_attempt_started_at: attempts
			? ((db.prepare("SELECT min(started_at) FROM retrieval_attempts").pluck().get() as
					| string
					| null) ?? null)
			: null,
		outcome_evidence: evidence ? count("SELECT count(*) FROM outcome_evidence") : 0,
		expired_outcome_evidence: evidence
			? count(
					`SELECT count(*) FROM outcome_evidence WHERE ${expired}`,
					OUTCOME_EVIDENCE_CONTRACT_VERSION,
					now,
				)
			: 0,
	};
}
