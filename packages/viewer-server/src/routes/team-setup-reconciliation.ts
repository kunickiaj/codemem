/**
 * Completion reconciliation for Team setup, run in the background instead of on
 * every summary read. A summary read serves the last result and its age, and
 * starts a refresh when that result is older than `refreshAfterMs`. At most one
 * reconciliation runs at a time: a refresh requested while one runs starts one
 * more pass after it. Each pass's access changes still take the same per-candidate
 * claim the draft and finish routes take.
 */

export type TeamSetupReconciliationState = "current" | "stale" | "never";

/** How current the Team setup summary is, as the summary response reports it. */
export interface TeamSetupReconciliationStatus {
	state: TeamSetupReconciliationState;
	/** A pass is running; the next read may show newer results. */
	refreshing: boolean;
	/** When the last successful pass finished. */
	checked_at: string | null;
	age_ms: number | null;
	/** Why the latest pass failed; the previous successful result is still served. */
	error_code: string | null;
}

export interface TeamSetupReconciliationRead<Result> {
	/** The last successful pass's result, or null before one finishes. */
	result: Result | null;
	status: TeamSetupReconciliationStatus;
}

export interface TeamSetupReconciliationOutcome {
	ok: boolean;
	checkedAtMs: number | null;
	errorCode: string | null;
}

export interface TeamSetupReconciliationOptions<Result> {
	/** One pass: read the coordinator and apply its answer. Throws when the pass fails. */
	run: () => Promise<Result>;
	errorCode: (error: unknown) => string;
	/** Records each pass's outcome, for example for the Health tab. Failures are ignored. */
	record?: (outcome: TeamSetupReconciliationOutcome) => void;
	/** A summary read older than this starts a refresh. */
	refreshAfterMs?: number;
	/** A result older than this, or one whose latest refresh failed, reads as stale. */
	staleAfterMs?: number;
	now?: () => number;
}

export interface TeamSetupReconciliation<Result> {
	/** The current result; starts a refresh when it is missing or old. Never waits. */
	read: () => TeamSetupReconciliationRead<Result>;
	/** Starts a pass, or one more after the running one; resolves when passes settle. */
	refresh: () => Promise<void>;
	/** Runs a pass now and then every `intervalMs` until `stop`. */
	startPeriodic: (intervalMs: number) => void;
	stop: () => void;
	/** Resolves once no pass is running; for tests. */
	settle: () => Promise<void>;
}

export const TEAM_SETUP_REFRESH_AFTER_MS = 30_000;
export const TEAM_SETUP_STALE_AFTER_MS = 5 * 60_000;
export const TEAM_SETUP_RECONCILIATION_INTERVAL_MS = 5 * 60_000;

class BackgroundTeamSetupReconciliation<Result> implements TeamSetupReconciliation<Result> {
	private readonly now: () => number;
	private readonly refreshAfterMs: number;
	private readonly staleAfterMs: number;
	private lastGood: { result: Result; checkedAtMs: number } | null = null;
	private lastAttemptAtMs: number | null = null;
	private lastErrorCode: string | null = null;
	private inFlight: Promise<void> | null = null;
	private rerun = false;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly options: TeamSetupReconciliationOptions<Result>) {
		this.now = options.now ?? Date.now;
		this.refreshAfterMs = options.refreshAfterMs ?? TEAM_SETUP_REFRESH_AFTER_MS;
		this.staleAfterMs = options.staleAfterMs ?? TEAM_SETUP_STALE_AFTER_MS;
	}

	read(): TeamSetupReconciliationRead<Result> {
		// Throttle by the last attempt, so a coordinator that keeps failing is not
		// asked again on every read.
		const due =
			this.lastAttemptAtMs === null || this.now() - this.lastAttemptAtMs >= this.refreshAfterMs;
		if (!this.inFlight && due) void this.refresh();
		return { result: this.lastGood?.result ?? null, status: this.status() };
	}

	refresh(): Promise<void> {
		if (this.inFlight) {
			this.rerun = true;
			return this.inFlight;
		}
		this.inFlight = this.runPasses().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	startPeriodic(intervalMs: number): void {
		if (this.timer) return;
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	async settle(): Promise<void> {
		while (this.inFlight) await this.inFlight;
	}

	private async runPasses(): Promise<void> {
		do {
			this.rerun = false;
			await this.pass();
		} while (this.rerun);
	}

	private async pass(): Promise<void> {
		try {
			const result = await this.options.run();
			this.lastGood = { result, checkedAtMs: this.now() };
			this.lastErrorCode = null;
		} catch (error) {
			// Keep the last good result, including its blockers: a failed read of the
			// coordinator says nothing about whether those blockers still hold.
			this.lastErrorCode = this.options.errorCode(error);
		} finally {
			this.lastAttemptAtMs = this.now();
		}
		try {
			this.options.record?.({
				ok: this.lastErrorCode === null,
				checkedAtMs: this.lastGood?.checkedAtMs ?? null,
				errorCode: this.lastErrorCode,
			});
		} catch {
			// Recording the outcome is informational and must not fail the pass.
		}
	}

	private status(): TeamSetupReconciliationStatus {
		const lastGood = this.lastGood;
		if (!lastGood) {
			return {
				state: "never",
				refreshing: this.inFlight !== null,
				checked_at: null,
				age_ms: null,
				error_code: this.lastErrorCode,
			};
		}
		const ageMs = Math.max(0, this.now() - lastGood.checkedAtMs);
		const stale = this.lastErrorCode !== null || ageMs >= this.staleAfterMs;
		return {
			state: stale ? "stale" : "current",
			refreshing: this.inFlight !== null,
			checked_at: new Date(lastGood.checkedAtMs).toISOString(),
			age_ms: ageMs,
			error_code: this.lastErrorCode,
		};
	}
}

export function createTeamSetupReconciliation<Result>(
	options: TeamSetupReconciliationOptions<Result>,
): TeamSetupReconciliation<Result> {
	return new BackgroundTeamSetupReconciliation(options);
}
