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
 * 6. Flush idle sessions with unflushed events
 * 7. Handle auth errors by setting backoff
 */

import type { IngestOptions } from "./ingest-pipeline.js";
import { ObserverAuthError } from "./observer-client.js";
import { flushRawEvents } from "./raw-event-flush.js";
import type { MemoryStore } from "./store.js";

/** Back off for 5 minutes after an auth error (seconds). */
const AUTH_BACKOFF_S = 300;

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
	private running = false; // reentrancy guard — prevents overlapping ticks
	private currentTick: Promise<void> | null = null;
	private wakeHandle: ReturnType<typeof setTimeout> | null = null;
	private loopHandle: ReturnType<typeof setTimeout> | null = null;
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
		return Math.max(1000, envInt("CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS", 30_000));
	}

	private idleMs(): number {
		return envInt("CODEMEM_RAW_EVENTS_SWEEPER_IDLE_MS", 120_000);
	}

	private limit(): number {
		return envInt("CODEMEM_RAW_EVENTS_SWEEPER_LIMIT", 25);
	}

	private workerMaxEvents(): number | null {
		const parsed = envInt("CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS", 250);
		return parsed <= 0 ? null : parsed;
	}

	private retentionMs(): number {
		return envInt("CODEMEM_RAW_EVENTS_RETENTION_MS", 0);
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
		this.active = false;
		if (this.loopHandle != null) {
			clearTimeout(this.loopHandle);
			this.loopHandle = null;
		}
		if (this.wakeHandle != null) {
			clearTimeout(this.wakeHandle);
			this.wakeHandle = null;
		}
		if (this.currentTick != null) {
			await this.currentTick;
		}
	}

	/**
	 * Notify the sweeper that config changed.
	 * Schedules an extra tick after a short delay.
	 */
	notifyConfigChanged(): void {
		this.wake();
	}

	/**
	 * Notify the sweeper that new events arrived (nudge it to flush soon).
	 * Mirrors Python's RawEventFlusher.note_activity() — schedules a near-
	 * immediate extra tick so events are processed without waiting for the
	 * full interval.
	 */
	nudge(): void {
		this.wake();
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
	 * 5. Flush idle sessions
	 */
	async tick(): Promise<void> {
		if (!this.enabled()) return;

		// Skip while backing off from auth error
		const now = Date.now() / 1000;
		if (now < this.authBackoffUntil) return;

		// Backoff expired — reset so next auth error gets logged again
		if (this.authErrorLogged) {
			this.authErrorLogged = false;
		}

		const nowMs = Date.now();
		const idleBefore = nowMs - this.idleMs();

		// Purge old events if retention configured
		const retentionMs = this.retentionMs();
		if (retentionMs > 0) {
			this.store.purgeRawEvents(retentionMs);
		}

		// Mark stuck batches as error
		const stuckMs = this.stuckBatchMs();
		if (stuckMs > 0) {
			const cutoff = new Date(nowMs - stuckMs).toISOString();
			this.store.markStuckRawEventBatchesAsError(cutoff, 100);
		}

		const maxEvents = this.workerMaxEvents();
		const sessionLimit = this.limit();
		const drained = new Set<string>();

		// Phase 1: Flush sessions with pending queue entries
		const queueSessions = this.store.rawEventSessionsWithPendingQueue(sessionLimit);
		for (const item of queueSessions) {
			const { source, streamId } = item;
			if (!streamId) continue;

			try {
				await flushRawEvents(this.store, this.ingestOpts, {
					opencodeSessionId: streamId,
					source,
					cwd: null,
					project: null,
					startedAt: null,
					maxEvents,
				});
				drained.add(`${source}:${streamId}`);
			} catch (exc) {
				if (exc instanceof ObserverAuthError) {
					this.handleAuthError(exc);
					return; // Stop all flush work during auth backoff
				}
				console.error(
					`codemem: raw event queue worker flush failed for ${streamId}:`,
					exc instanceof Error ? exc.message : exc,
				);
			}
		}

		// Phase 2: Flush idle sessions with unflushed events
		const idleSessions = this.store.rawEventSessionsPendingIdleFlush(idleBefore, sessionLimit);
		for (const item of idleSessions) {
			const { source, streamId } = item;
			if (!streamId) continue;
			if (drained.has(`${source}:${streamId}`)) continue;

			try {
				await flushRawEvents(this.store, this.ingestOpts, {
					opencodeSessionId: streamId,
					source,
					cwd: null,
					project: null,
					startedAt: null,
					maxEvents,
				});
			} catch (exc) {
				if (exc instanceof ObserverAuthError) {
					this.handleAuthError(exc);
					return; // Stop all flush work during auth backoff
				}
				console.error(
					`codemem: raw event sweeper flush failed for ${streamId}:`,
					exc instanceof Error ? exc.message : exc,
				);
			}
		}
	}
}
