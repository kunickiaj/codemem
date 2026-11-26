/**
 * Periodic retention for the retrieval ledger and outcome evidence.
 *
 * Each retrieval attempt and outcome evidence row carries a retention date. This removes
 * the rows whose date has passed, in short transactions, so a store with a large backlog
 * sheds it over several runs without holding the write lock for long. Pinned rows and rows
 * without a date are never removed.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Database } from "better-sqlite3";
import { connect, resolveDbPath } from "./db.js";
import {
	OUTCOME_EVIDENCE_CONTRACT_VERSION,
	purgeExpiredOutcomeEvidence,
} from "./outcome-evidence.js";
import {
	purgeExpiredRetrievalAttempts,
	RETRIEVAL_LEDGER_CONTRACT_VERSION,
} from "./retrieval-ledger.js";

/**
 * Attempts deleted per transaction. An attempt has about 20 exposure rows, so a batch
 * deletes a few thousand rows and commits in tens of milliseconds on a large store.
 */
export const DEFAULT_LEDGER_RETENTION_BATCH_SIZE = 200;
/** Work allowed in one pass before it stops and leaves the rest to the next pass. */
export const DEFAULT_LEDGER_RETENTION_MAX_RUNTIME_MS = 5_000;
/** Pause between batches, so other writers waiting on the lock get it. */
const BATCH_PAUSE_MS = 25;

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

type BatchPurge = (limit: number) => number;

/** Runs `purge` batch by batch until a batch comes back short or the budget runs out. */
async function drain(
	purge: BatchPurge,
	batchSize: number,
	outOfBudget: () => boolean,
	onBatch: () => void,
): Promise<{ purged: number; done: boolean }> {
	let purged = 0;
	while (!outOfBudget()) {
		const deleted = purge(batchSize);
		purged += deleted;
		onBatch();
		if (deleted < batchSize) return { purged, done: true };
		await sleep(BATCH_PAUSE_MS);
	}
	return { purged, done: false };
}

/** Removes expired retrieval attempts, then expired outcome evidence, within one budget. */
export async function runLedgerRetentionPass(
	db: Database,
	options: LedgerRetentionPassOptions = {},
): Promise<LedgerRetentionPassResult> {
	const clock = options.clock ?? Date.now;
	const started = clock();
	// One cutoff for the whole pass: rows that expire while it runs wait for the next one.
	const now = options.now ?? new Date().toISOString();
	const batchSize = options.batchSize ?? DEFAULT_LEDGER_RETENTION_BATCH_SIZE;
	const maxRuntimeMs = options.maxRuntimeMs ?? DEFAULT_LEDGER_RETENTION_MAX_RUNTIME_MS;
	const outOfBudget = () => Boolean(options.signal?.aborted) || clock() - started >= maxRuntimeMs;
	let batches = 0;
	const countBatch = () => {
		batches += 1;
	};
	const attempts = tableExists(db, "retrieval_attempts")
		? await drain(
				(limit) => purgeExpiredRetrievalAttempts(db, now, { limit }),
				batchSize,
				outOfBudget,
				countBatch,
			)
		: { purged: 0, done: true };
	const evidence = tableExists(db, "outcome_evidence")
		? await drain(
				(limit) => purgeExpiredOutcomeEvidence(db, now, { limit }),
				batchSize,
				outOfBudget,
				countBatch,
			)
		: { purged: 0, done: true };
	return {
		retrievalAttemptsPurged: attempts.purged,
		outcomeEvidencePurged: evidence.purged,
		batches,
		complete: attempts.done && evidence.done,
		durationMs: clock() - started,
	};
}

export interface LedgerRetentionLogger {
	step(message: string): void;
	warn(message: string): void;
}

export interface LedgerRetentionRunnerOptions {
	dbPath?: string;
	signal?: AbortSignal;
	logger?: LedgerRetentionLogger;
	/** Delay before the first pass, so it does not compete with startup work. */
	initialDelayMs?: number;
	/** Delay between passes once every expired row is gone. */
	idleIntervalMs?: number;
	/** Delay between passes while expired rows remain. */
	backlogIntervalMs?: number;
	pass?: Omit<LedgerRetentionPassOptions, "signal" | "now" | "clock">;
}

const defaultLogger: LedgerRetentionLogger = {
	step: (message) => console.error(message),
	warn: (message) => console.error(`Warning: ${message}`),
};

export function describeLedgerRetentionPass(result: LedgerRetentionPassResult): string {
	const remaining = result.complete ? "" : "; more expired rows remain";
	return `Retrieval ledger retention purged ${result.retrievalAttemptsPurged} attempts and ${result.outcomeEvidencePurged} outcome evidence rows in ${result.durationMs} ms${remaining}`;
}

/** Runs ledger retention passes on a timer in a long-lived process. */
export class LedgerRetentionRunner {
	private readonly dbPath: string;
	private readonly signal?: AbortSignal;
	private readonly logger: LedgerRetentionLogger;
	private readonly initialDelayMs: number;
	private readonly idleIntervalMs: number;
	private readonly backlogIntervalMs: number;
	private readonly passOptions: LedgerRetentionRunnerOptions["pass"];
	private active = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private currentRun: Promise<void> | null = null;
	private failing = false;

	constructor(options: LedgerRetentionRunnerOptions = {}) {
		this.dbPath = resolveDbPath(options.dbPath);
		this.signal = options.signal;
		this.logger = options.logger ?? defaultLogger;
		this.initialDelayMs = options.initialDelayMs ?? 60_000;
		this.idleIntervalMs = options.idleIntervalMs ?? 60 * 60_000;
		this.backlogIntervalMs = options.backlogIntervalMs ?? 30_000;
		this.passOptions = options.pass;
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.schedule(this.initialDelayMs);
	}

	async stop(): Promise<void> {
		this.active = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.currentRun) await this.currentRun;
	}

	private schedule(delayMs: number): void {
		if (!this.active || this.signal?.aborted) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			if (!this.active || this.signal?.aborted) return;
			this.currentRun = this.runOnce()
				.then((retrySoon) =>
					this.schedule(retrySoon ? this.backlogIntervalMs : this.idleIntervalMs),
				)
				.finally(() => {
					this.currentRun = null;
				});
		}, delayMs);
		if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
	}

	/**
	 * One pass. Returns true when the next pass should come soon: expired rows remain, or
	 * the pass failed. Never throws.
	 */
	async runOnce(): Promise<boolean> {
		if (this.signal?.aborted) return false;
		let db: Database | null = null;
		try {
			db = connect(this.dbPath) as Database;
			const result = await runLedgerRetentionPass(db, {
				...this.passOptions,
				signal: this.signal,
			});
			this.failing = false;
			if (result.retrievalAttemptsPurged + result.outcomeEvidencePurged > 0) {
				this.logger.step(describeLedgerRetentionPass(result));
			}
			return !result.complete;
		} catch (error) {
			// Log once per failure streak; capture and retrieval never depend on this pass.
			if (!this.failing) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger.warn(`Retrieval ledger retention failed and will retry: ${message}`);
			}
			this.failing = true;
			return true;
		} finally {
			db?.close();
		}
	}
}

export interface RetrievalLedgerStats {
	retrieval_attempts: number;
	retrieval_exposures: number;
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
	return {
		retrieval_attempts: attempts ? count("SELECT count(*) FROM retrieval_attempts") : 0,
		retrieval_exposures: tableExists(db, "retrieval_exposures")
			? count("SELECT count(*) FROM retrieval_exposures")
			: 0,
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
