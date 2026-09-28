/**
 * RawEventSweeper — periodically processes raw events into memories.
 *
 * Ports codemem/viewer_raw_events.py RawEventSweeper class.
 *
 * Uses setInterval (Node single-threaded) instead of Python threads.
 * The sweeper takes a shared MemoryStore and an IngestOptions provider.
 *
 * Each tick():
 * 1. Check if enabled
 * 2. Check auth backoff
 * 3. Purge old events (if retention configured)
 * 4. Mark stuck batches as error
 * 5. Flush sessions with pending queue entries
 * 6. Flush sessions with unflushed events
 * 7. Handle auth errors by setting backoff
 */

import { readCoordinatorSyncConfig } from "./coordinator-runtime.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { ObserverAuthError } from "./observer-client.js";
import { readCodememConfigFile } from "./observer-config.js";
import { recoverOneMissingAuthWindow } from "./raw-event-auth-recovery.js";
import { flushRawEvents } from "./raw-event-flush.js";
import type { MemoryStore } from "./store.js";

const MS_PER_DAY = 86_400_000;

/** Back off after an auth error. 60s gives OpenCode time to refresh its
 *  OAuth token while staying longer than the default 30s sweep interval. */
const AUTH_BACKOFF_S = 60;

// ---------------------------------------------------------------------------
// Env helpers — read config from env vars matching Python exactly
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
	const value = process.env[name];
	if (value == null) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolDisabled(name: string): boolean {
	const value = (process.env[name] ?? "1").trim().toLowerCase();
	return value === "0" || value === "false" || value === "off";
}

// ---------------------------------------------------------------------------
// RawEventSweeper
// ---------------------------------------------------------------------------

export class RawEventSweeper {
	private store: MemoryStore;
	private ingestOpts: IngestOptions;
	private active = false;
	private stopping = false;
	private running = false; // reentrancy guard — prevents overlapping ticks
	private currentTick: Promise<void> | null = null;
	private wakeHandle: ReturnType<typeof setTimeout> | null = null;
	private loopHandle: ReturnType<typeof setTimeout> | null = null;
	private autoFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private sessionFlushPromises = new Map<string, Promise<void>>();
	private sessionBoundaryWaiters = new Map<string, number>();
	private autoFlushPending = new Set<string>();
	private autoFlushPromises = new Set<Promise<void>>();
	private authBackoffUntil = 0; // epoch seconds
	private authErrorLogged = false;

	constructor(store: MemoryStore, ingestOpts: IngestOptions) {
		this.store = store;
		this.ingestOpts = ingestOpts;
	}

	// -----------------------------------------------------------------------
	// Config readers (from env vars, matching Python)
	// -----------------------------------------------------------------------

	private enabled(): boolean {
		return !envBoolDisabled("CODEMEM_RAW_EVENTS_SWEEPER");
	}

	private intervalMs(): number {
		const envValue = process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS;
		if (envValue != null) {
			const parsed = Number.parseInt(envValue, 10);
			return Number.isFinite(parsed) ? Math.max(1000, parsed) : 30_000;
		}
		const configValue = readCodememConfigFile().raw_events_sweeper_interval_s;
		const configSeconds =
			typeof configValue === "number"
				? configValue
				: typeof configValue === "string"
					? Number.parseInt(configValue, 10)
					: Number.NaN;
		if (Number.isFinite(configSeconds) && configSeconds > 0) {
			return Math.max(1000, configSeconds * 1000);
		}
		return 30_000;
	}

	private limit(): number {
		return envInt("CODEMEM_RAW_EVENTS_SWEEPER_LIMIT", 25);
	}

	private workerMaxEvents(): number | null {
		const parsed = envInt("CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS", 100);
		return parsed <= 0 ? null : parsed;
	}

	private retentionMs(): number {
		// The new config key (raw_events_retention_enabled / _max_age_days) is the
		// authoritative control. An EXPLICIT value wins — enabled=true purges by
		// age in days, and an explicit enabled=false disables retention even if a
		// stale legacy CODEMEM_RAW_EVENTS_RETENTION_MS is still set. Only when the
		// new key is absent do we fall back to that legacy env var for back-compat.
		const config = readCoordinatorSyncConfig();
		if (config.rawEventsRetentionConfigured) {
			return config.rawEventsRetentionEnabled
				? Math.max(1, config.rawEventsRetentionMaxAgeDays) * MS_PER_DAY
				: 0;
		}
		return envInt("CODEMEM_RAW_EVENTS_RETENTION_MS", 0);
	}

	private autoFlushEnabled(): boolean {
		return (process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH ?? "").trim() === "1";
	}

	private debounceMs(): number {
		return envInt("CODEMEM_RAW_EVENTS_DEBOUNCE_MS", 60_000);
	}

	private stuckBatchMs(): number {
		return envInt("CODEMEM_RAW_EVENTS_STUCK_BATCH_MS", 300_000);
	}

	// -----------------------------------------------------------------------
	// Auth backoff
	// -----------------------------------------------------------------------

	private handleAuthError(exc: ObserverAuthError): void {
		this.authBackoffUntil = Date.now() / 1000 + AUTH_BACKOFF_S;
		if (!this.authErrorLogged) {
			this.authErrorLogged = true;
			const msg =
				`codemem: observer auth error — backing off for ${AUTH_BACKOFF_S}s. ` +
				`Refresh your provider credentials or update observer_provider in settings. ` +
				`(${exc.message})`;
			console.error(msg);
		}
	}

	/**
	 * Reset the auth backoff and wake the worker.
	 * Call this after credentials are refreshed.
	 */
	resetAuthBackoff(): void {
		this.authBackoffUntil = 0;
		this.authErrorLogged = false;
		this.wake();
	}

	/**
	 * Return the current auth backoff status.
	 */
	authBackoffStatus(): { active: boolean; remainingS: number } {
		const now = Date.now() / 1000;
		const remaining = Math.max(0, Math.round(this.authBackoffUntil - now));
		return { active: remaining > 0, remainingS: remaining };
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Start the sweeper loop.
	 * Uses a self-scheduling async loop (sleep → tick → sleep) to prevent
	 * overlapping ticks. This mirrors the Python threading pattern where
	 * the thread sleeps, runs tick() synchronously, then sleeps again.
	 * No-op if sweeper is disabled or already running.
	 */
	start(): void {
		this.stopping = false;
		if (!this.enabled()) return;
		if (this.active) return;
		this.active = true;
		this.scheduleNext();
	}

	/**
	 * Stop the sweeper. Cancels the next scheduled tick and waits for any
	 * in-progress tick to finish before returning.
	 */
	async stop(): Promise<void> {
		this.stopping = true;
		this.active = false;
		if (this.loopHandle != null) {
			clearTimeout(this.loopHandle);
			this.loopHandle = null;
		}
		if (this.wakeHandle != null) {
			clearTimeout(this.wakeHandle);
			this.wakeHandle = null;
		}
		for (const timer of this.autoFlushTimers.values()) clearTimeout(timer);
		this.autoFlushTimers.clear();
		this.autoFlushPending.clear();
		if (this.currentTick != null) {
			await this.currentTick;
		}
		while (this.autoFlushPromises.size > 0) {
			await Promise.allSettled([...this.autoFlushPromises]);
		}
	}

	/** Apply new observer settings after all previously dispatched work settles. */
	async reconfigureObserver(
		createObserver: () => IngestOptions["observer"],
		options: { shouldResume?: () => boolean } = {},
	): Promise<IngestOptions["observer"] | null> {
		await this.stop();
		if (options.shouldResume?.() === false) return null;
		const observer = createObserver();
		this.ingestOpts = { ...this.ingestOpts, observer };
		this.authBackoffUntil = 0;
		this.authErrorLogged = false;
		this.start();
		this.wake();
		return observer;
	}

	/**
	 * Notify the sweeper that config changed.
	 * Schedules an extra tick after a short delay.
	 */
	notifyConfigChanged(): void {
		this.wake();
	}

	/**
	 * Notify the debounced auto-flush path that new events arrived.
	 * Mirrors Python's RawEventAutoFlusher.note_activity() behavior.
	 */
	nudge(opencodeSessionId: string, source = "opencode"): void {
		if (this.stopping) return;
		if (!this.autoFlushEnabled()) return;
		if (Date.now() / 1000 < this.authBackoffUntil) return;
		const streamId = opencodeSessionId.trim();
		if (!streamId) return;
		const sourceNorm = source.trim().toLowerCase() || "opencode";
		const key = `${sourceNorm}:${streamId}`;
		if (this.sessionFlushPromises.has(key)) {
			this.autoFlushPending.add(key);
			return;
		}
		const delayMs = this.debounceMs();
		if (delayMs <= 0) {
			this.trackAutoFlush(this.flushNow(streamId, sourceNorm));
			return;
		}
		const existing = this.autoFlushTimers.get(key);
		if (existing) return;
		const timer = setTimeout(() => {
			this.autoFlushTimers.delete(key);
			this.trackAutoFlush(this.flushNow(streamId, sourceNorm));
		}, delayMs);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		this.autoFlushTimers.set(key, timer);
	}

	/** Flush one session immediately through the event visible at this boundary. */
	async flushBoundary(opencodeSessionId: string, source = "opencode"): Promise<void> {
		if (this.stopping) return;
		const streamId = opencodeSessionId.trim();
		if (!streamId) return;
		const sourceNorm = source.trim().toLowerCase() || "opencode";
		const boundaryEventSeq = Number(
			this.store.rawEventSessionMeta(streamId, sourceNorm).last_received_event_seq,
		);
		const drainThroughEventSeq =
			Number.isSafeInteger(boundaryEventSeq) && boundaryEventSeq >= 0
				? boundaryEventSeq
				: undefined;
		const flushing = this.flushNow(streamId, sourceNorm, {
			waitForActive: true,
			bypassAuthBackoff: true,
			drain: drainThroughEventSeq != null,
			drainThroughEventSeq,
		});
		this.trackAutoFlush(flushing);
		await flushing;
	}

	private async acquireSessionFlush(
		key: string,
		waitForActive: boolean,
	): Promise<(() => void) | null> {
		if (waitForActive) {
			this.sessionBoundaryWaiters.set(key, (this.sessionBoundaryWaiters.get(key) ?? 0) + 1);
		}
		try {
			while (true) {
				const active = this.sessionFlushPromises.get(key);
				if (active) {
					if (!waitForActive) return null;
					await active;
					continue;
				}
				// Ordinary work must also yield during the release-to-acquire gap after an
				// active flush wakes an explicit boundary waiter.
				if (!waitForActive && this.sessionBoundaryWaiters.has(key)) return null;

				let markComplete!: () => void;
				const completion = new Promise<void>((resolve) => {
					markComplete = resolve;
				});
				this.sessionFlushPromises.set(key, completion);
				return () => {
					this.sessionFlushPromises.delete(key);
					markComplete();
				};
			}
		} finally {
			if (waitForActive) {
				// Decrement on acquisition: any remaining count represents boundaries
				// still queued behind the lock holder and keeps ordinary work deferred.
				const remaining = (this.sessionBoundaryWaiters.get(key) ?? 1) - 1;
				if (remaining > 0) this.sessionBoundaryWaiters.set(key, remaining);
				else this.sessionBoundaryWaiters.delete(key);
			}
		}
	}

	private trackAutoFlush(promise: Promise<void>): void {
		this.autoFlushPromises.add(promise);
		void promise.finally(() => {
			this.autoFlushPromises.delete(promise);
		});
	}

	private scheduleAutoFlush(opencodeSessionId: string, source: string): void {
		if (this.stopping) return;
		const key = `${source}:${opencodeSessionId}`;
		if (this.sessionFlushPromises.has(key)) {
			this.autoFlushPending.add(key);
			return;
		}
		const delayMs = this.debounceMs();
		if (delayMs <= 0) {
			this.trackAutoFlush(this.flushNow(opencodeSessionId, source));
			return;
		}
		const existing = this.autoFlushTimers.get(key);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.autoFlushTimers.delete(key);
			this.trackAutoFlush(this.flushNow(opencodeSessionId, source));
		}, delayMs);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		this.autoFlushTimers.set(key, timer);
	}

	private async flushNow(
		opencodeSessionId: string,
		source: string,
		options: {
			waitForActive?: boolean;
			bypassAuthBackoff?: boolean;
			drain?: boolean;
			drainThroughEventSeq?: number;
		} = {},
	): Promise<void> {
		if (this.shouldDeferFlush(options)) return;
		const key = `${source}:${opencodeSessionId}`;
		const finishSessionFlush = await this.acquireSessionFlush(key, options.waitForActive === true);
		if (finishSessionFlush === null) {
			this.autoFlushPending.add(key);
			return;
		}
		const existing = this.autoFlushTimers.get(key);
		if (existing) {
			clearTimeout(existing);
			this.autoFlushTimers.delete(key);
		}
		try {
			const maxEvents = this.workerMaxEvents();
			let first = true;
			while (first || !this.stopping) {
				first = false;
				const result = await flushRawEvents(this.store, this.ingestOpts, {
					opencodeSessionId,
					source,
					cwd: null,
					project: null,
					startedAt: null,
					maxEvents,
					throughEventSeq: options.drainThroughEventSeq,
				});
				if (!options.drain || result.updatedState === 0) break;
				if (
					options.drainThroughEventSeq != null &&
					this.store.rawEventFlushState(opencodeSessionId, source) >= options.drainThroughEventSeq
				) {
					break;
				}
			}
		} catch (exc) {
			if (exc instanceof ObserverAuthError) {
				this.handleAuthError(exc);
				return;
			}
			console.error(
				`codemem: raw event auto flush failed for ${opencodeSessionId}:`,
				exc instanceof Error ? exc.message : exc,
			);
		} finally {
			finishSessionFlush();
			// Condition order is intentional: preserve the pending marker while any
			// explicit boundary remains queued, then resume ordinary work afterward.
			if (!this.sessionBoundaryWaiters.has(key) && this.autoFlushPending.delete(key)) {
				this.scheduleAutoFlush(opencodeSessionId, source);
			}
		}
	}

	private shouldDeferFlush(options: { bypassAuthBackoff?: boolean }): boolean {
		return (
			this.stopping || (!options.bypassAuthBackoff && Date.now() / 1000 < this.authBackoffUntil)
		);
	}

	/** Schedule the next tick after the configured interval. */
	private scheduleNext(): void {
		if (!this.active) return;
		this.loopHandle = setTimeout(async () => {
			this.loopHandle = null;
			await this.runTick();
			this.scheduleNext();
		}, this.intervalMs());
		if (typeof this.loopHandle === "object" && "unref" in this.loopHandle) {
			this.loopHandle.unref();
		}
	}

	/** Execute a tick with reentrancy protection. */
	private async runTick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.currentTick = (async () => {
			try {
				await this.tick();
			} catch (err) {
				console.error("codemem: sweeper tick failed unexpectedly:", err);
			} finally {
				this.running = false;
				this.currentTick = null;
			}
		})();
		await this.currentTick;
	}

	private wake(): void {
		if (!this.active) return;
		// Schedule a near-immediate extra tick (with reentrancy guard)
		if (this.wakeHandle != null) {
			clearTimeout(this.wakeHandle);
		}
		this.wakeHandle = setTimeout(async () => {
			this.wakeHandle = null;
			await this.runTick();
		}, 100);
		if (typeof this.wakeHandle === "object" && "unref" in this.wakeHandle) {
			this.wakeHandle.unref();
		}
	}

	private async recoverMissingAuthHistory(): Promise<void> {
		if (process.env.CODEMEM_RAW_EVENTS_RECOVERY_ENABLED === "0") return;
		try {
			await recoverOneMissingAuthWindow(this.store, this.ingestOpts);
		} catch (error) {
			if (error instanceof ObserverAuthError) {
				this.handleAuthError(error);
				return;
			}
			console.error("codemem: historical observer recovery paused after a failed window");
		}
	}

	private purgeExpiredRawEvents(): void {
		const retentionMs = this.retentionMs();
		if (retentionMs > 0) this.store.purgeRawEvents(retentionMs);
	}

	private handleSessionFlushError(
		error: unknown,
		streamId: string,
		phase: "queue" | "active",
	): boolean {
		if (error instanceof ObserverAuthError) {
			this.handleAuthError(error);
			return true;
		}
		const label = phase === "queue" ? "queue worker" : "sweeper";
		console.error(
			`codemem: raw event ${label} flush failed for ${streamId}:`,
			error instanceof Error ? error.message : error,
		);
		return false;
	}

	private async flushPendingQueueSessions(
		maxEvents: number | null,
		sessionLimit: number,
	): Promise<Set<string> | null> {
		const drained = new Set<string>();
		for (const { source, streamId } of this.store.rawEventSessionsWithPendingQueue(sessionLimit)) {
			if (this.stopping) return null;
			if (!streamId) continue;
			const key = `${source}:${streamId}`;
			const finish = await this.acquireSessionFlush(key, false);
			if (!finish) continue;
			try {
				if (this.stopping) return null;
				await flushRawEvents(this.store, this.ingestOpts, {
					opencodeSessionId: streamId,
					source,
					cwd: null,
					project: null,
					startedAt: null,
					maxEvents,
				});
				drained.add(key);
			} catch (error) {
				if (this.handleSessionFlushError(error, streamId, "queue")) return null;
			} finally {
				finish();
			}
		}
		return drained;
	}

	private async flushActiveSessions(
		maxEvents: number | null,
		sessionLimit: number,
		drained: ReadonlySet<string>,
	): Promise<boolean> {
		for (const { source, streamId } of this.store.rawEventSessionsPendingFlush(sessionLimit)) {
			if (this.stopping) return false;
			if (this.skipActiveSession(source, streamId, drained)) continue;
			const finish = await this.acquireSessionFlush(`${source}:${streamId}`, false);
			if (!finish) continue;
			try {
				if (this.stopping) return false;
				await flushRawEvents(this.store, this.ingestOpts, {
					opencodeSessionId: streamId,
					source,
					cwd: null,
					project: null,
					startedAt: null,
					maxEvents,
				});
			} catch (error) {
				if (this.handleSessionFlushError(error, streamId, "active")) return false;
			} finally {
				finish();
			}
		}
		return true;
	}

	private skipActiveSession(
		source: string,
		streamId: string,
		drained: ReadonlySet<string>,
	): boolean {
		return !streamId || drained.has(`${source}:${streamId}`);
	}

	// -----------------------------------------------------------------------
	// Tick — one sweep cycle
	// -----------------------------------------------------------------------

	/**
	 * Execute one sweep cycle. Public for testing.
	 *
	 * 1. Check enabled / auth backoff
	 * 2. Purge old events
	 * 3. Mark stuck batches
	 * 4. Flush pending queue sessions
	 * 5. Flush sessions with unflushed events
	 */
	async tick(): Promise<void> {
		if (!this.enabled() || this.stopping) return;

		// Skip while backing off from auth error
		const now = Date.now() / 1000;
		if (now < this.authBackoffUntil) return;

		// Backoff expired — reset so next auth error gets logged again
		if (this.authErrorLogged) {
			this.authErrorLogged = false;
		}

		const nowMs = Date.now();

		// Purge old events if retention configured
		this.purgeExpiredRawEvents();

		// Mark stuck batches as error
		const stuckMs = this.stuckBatchMs();
		if (stuckMs > 0) {
			const cutoff = new Date(nowMs - stuckMs).toISOString();
			this.store.markStuckRawEventBatchesAsError(cutoff, 100);
		}

		const maxEvents = this.workerMaxEvents();
		const sessionLimit = this.limit();
		const drained = await this.flushPendingQueueSessions(maxEvents, sessionLimit);
		if (!drained) return;
		if (!(await this.flushActiveSessions(maxEvents, sessionLimit, drained))) return;
		if (this.stopping) return;
		await this.recoverMissingAuthHistory();
	}
}
