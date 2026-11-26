/**
 * Shared batching and scheduling for the maintenance worker's retention passes.
 *
 * A pass deletes rows in short transactions with a pause between them, so other writers get
 * the lock, and stops at a time budget so a large backlog is shed over several passes. The
 * runner repeats passes on a timer, sooner while rows remain, and contains failures: a failing
 * pass is logged once per failure streak and retried, and never reaches capture or retrieval.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Database } from "better-sqlite3";
import { connect, resolveDbPath } from "./db.js";

/** Work allowed in one pass before it stops and leaves the rest to the next pass. */
export const DEFAULT_RETENTION_MAX_RUNTIME_MS = 5_000;
/** Pause between batches, so other writers waiting on the lock get it. */
const BATCH_PAUSE_MS = 25;

export interface RetentionPassBudget {
	signal?: AbortSignal;
	maxRuntimeMs?: number;
	/** Milliseconds clock for the runtime budget; tests replace it. */
	clock?: () => number;
}

/** Starts a pass's runtime budget. `outOfBudget` is true once it is spent or aborted. */
export function startRetentionBudget(options: RetentionPassBudget) {
	const clock = options.clock ?? Date.now;
	const started = clock();
	const maxRuntimeMs = options.maxRuntimeMs ?? DEFAULT_RETENTION_MAX_RUNTIME_MS;
	return {
		outOfBudget: () => Boolean(options.signal?.aborted) || clock() - started >= maxRuntimeMs,
		elapsedMs: () => clock() - started,
	};
}

/** Runs `purge` batch by batch until a batch comes back short or the budget runs out. */
export async function drainInBatches(
	purge: (limit: number) => number,
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

export interface RetentionLogger {
	step(message: string): void;
	warn(message: string): void;
}

export interface PeriodicRetentionRunnerOptions {
	dbPath?: string;
	signal?: AbortSignal;
	logger?: RetentionLogger;
	/** Delay before the first pass, so it does not compete with startup work. */
	initialDelayMs?: number;
	/** Delay between passes once nothing is left to remove. */
	idleIntervalMs?: number;
	/** Delay between passes while rows remain. */
	backlogIntervalMs?: number;
}

/** What a pass reports to its runner. */
export interface RetentionPassOutcome {
	purged: number;
	complete: boolean;
	/** Logged when the pass removed rows. */
	summary: string;
}

const defaultLogger: RetentionLogger = {
	step: (message) => console.error(message),
	warn: (message) => console.error(`Warning: ${message}`),
};

/** Runs one kind of retention pass on a timer in a long-lived process. */
export abstract class PeriodicRetentionRunner {
	private readonly dbPath: string;
	protected readonly signal?: AbortSignal;
	private readonly logger: RetentionLogger;
	private readonly initialDelayMs: number;
	private readonly idleIntervalMs: number;
	private readonly backlogIntervalMs: number;
	private active = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private currentRun: Promise<void> | null = null;
	private failing = false;

	/** Names the pass in its failure warning, for example "Retrieval ledger retention". */
	protected abstract readonly label: string;

	protected abstract runPass(db: Database): Promise<RetentionPassOutcome>;

	constructor(options: PeriodicRetentionRunnerOptions = {}) {
		this.dbPath = resolveDbPath(options.dbPath);
		this.signal = options.signal;
		this.logger = options.logger ?? defaultLogger;
		this.initialDelayMs = options.initialDelayMs ?? 60_000;
		this.idleIntervalMs = options.idleIntervalMs ?? 60 * 60_000;
		this.backlogIntervalMs = options.backlogIntervalMs ?? 30_000;
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
	 * One pass. Returns true when the next pass should come soon: rows remain, or the pass
	 * failed. Never throws.
	 */
	async runOnce(): Promise<boolean> {
		if (this.signal?.aborted) return false;
		let db: Database | null = null;
		try {
			db = connect(this.dbPath) as Database;
			const outcome = await this.runPass(db);
			this.failing = false;
			if (outcome.purged > 0) this.logger.step(outcome.summary);
			return !outcome.complete;
		} catch (error) {
			// Log once per failure streak; capture and retrieval never depend on this pass.
			if (!this.failing) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger.warn(`${this.label} failed and will retry: ${message}`);
			}
			this.failing = true;
			return true;
		} finally {
			db?.close();
		}
	}
}
