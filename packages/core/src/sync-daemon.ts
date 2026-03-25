/**
 * Sync daemon: periodic background sync with all configured peers.
 *
 * Uses AbortSignal for cancellation and setInterval for periodic ticks.
 * Ported from codemem/sync/daemon.py — HTTP server portion is deferred
 * to the viewer-server Hono routes.
 */

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import { connect as connectDb, resolveDbPath } from "./db.js";
import * as schema from "./schema.js";
import { advertiseMdns, mdnsEnabled } from "./sync-discovery.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import { runSyncPass, shouldSkipOfflinePeer, syncPassPreflight } from "./sync-pass.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncDaemonOptions {
	host?: string;
	port?: number;
	intervalS?: number;
	dbPath?: string;
	keysDir?: string;
	signal?: AbortSignal;
	onPhaseChange?: (phase: "starting" | "running" | "stopping") => void;
}

export interface SyncTickResult {
	ok: boolean;
	skipped?: boolean;
	reason?: string;
	error?: string;
	opsIn?: number;
	opsOut?: number;
}

// ---------------------------------------------------------------------------
// Daemon state helpers
// ---------------------------------------------------------------------------

/**
 * Record a successful daemon tick in sync_daemon_state.
 */
export function setSyncDaemonOk(db: Database): void {
	const d = drizzle(db, { schema });
	const now = new Date().toISOString();
	d.insert(schema.syncDaemonState)
		.values({ id: 1, last_ok_at: now })
		.onConflictDoUpdate({
			target: schema.syncDaemonState.id,
			set: { last_ok_at: sql`excluded.last_ok_at` },
		})
		.run();
}

/**
 * Record a daemon tick error in sync_daemon_state.
 */
export function setSyncDaemonError(db: Database, error: string, traceback?: string): void {
	const d = drizzle(db, { schema });
	const now = new Date().toISOString();
	d.insert(schema.syncDaemonState)
		.values({
			id: 1,
			last_error: error,
			last_traceback: traceback ?? null,
			last_error_at: now,
		})
		.onConflictDoUpdate({
			target: schema.syncDaemonState.id,
			set: {
				last_error: sql`excluded.last_error`,
				last_traceback: sql`excluded.last_traceback`,
				last_error_at: sql`excluded.last_error_at`,
			},
		})
		.run();
}

// ---------------------------------------------------------------------------
// Sync tick
// ---------------------------------------------------------------------------

/**
 * Run one sync tick: iterate over all enabled peers and sync each.
 *
 * Returns per-peer results. Peers in backoff are skipped.
 */
export async function syncDaemonTick(db: Database, keysDir?: string): Promise<SyncTickResult[]> {
	const d = drizzle(db, { schema });
	const rows = d
		.select({ peer_device_id: schema.syncPeers.peer_device_id })
		.from(schema.syncPeers)
		.all();

	// Skip heavy preflight work when there are no peers configured.
	// This keeps startup and idle daemon ticks responsive on large local stores.
	if (rows.length === 0) {
		return [];
	}

	syncPassPreflight(db);

	const results: SyncTickResult[] = [];
	for (const row of rows) {
		const peerDeviceId = row.peer_device_id;

		if (shouldSkipOfflinePeer(db, peerDeviceId)) {
			results.push({ ok: false, skipped: true, reason: "peer offline (backoff)" });
			continue;
		}

		const result = await runSyncPass(db, peerDeviceId, { keysDir });
		results.push({
			ok: result.ok,
			error: result.error,
			opsIn: result.opsIn,
			opsOut: result.opsOut,
		});
	}

	return results;
}

// ---------------------------------------------------------------------------
// Daemon loop
// ---------------------------------------------------------------------------

/**
 * Run the sync daemon loop.
 *
 * 1. Ensures device identity
 * 2. Starts mDNS advertising (if enabled)
 * 3. Runs an initial sync tick
 * 4. Sets up an interval timer for periodic sync
 * 5. Waits for abort signal to stop
 * 6. Cleans up on exit
 */
export async function runSyncDaemon(options?: SyncDaemonOptions): Promise<void> {
	const intervalS = options?.intervalS ?? 120;
	const dbPath = resolveDbPath(options?.dbPath);
	const keysDir = options?.keysDir;
	const signal = options?.signal;
	const onPhaseChange = options?.onPhaseChange;
	onPhaseChange?.("starting");

	// Ensure device identity
	const db = connectDb(dbPath);
	let mdnsHandle: { close(): void } | null = null;
	try {
		const [deviceId] = ensureDeviceIdentity(db, { keysDir });

		// Start mDNS advertising if enabled
		if (mdnsEnabled() && options?.port) {
			mdnsHandle = advertiseMdns(deviceId, options.port);
		}
	} finally {
		db.close();
	}

	// Check cancellation before startup tick
	if (signal?.aborted) {
		mdnsHandle?.close();
		return;
	}

	// Set up periodic ticks — serialized to avoid overlapping sync passes.
	// Importantly, the first tick is scheduled asynchronously so startup callers
	// are not blocked by large sync preflight work on the main request path.
	return new Promise<void>((resolve) => {
		let tickRunning = false;
		let firstTickCompleted = false;
		const runTick = () => {
			if (tickRunning) return; // Skip if previous tick still running
			tickRunning = true;
			runTickOnce(dbPath, keysDir).finally(() => {
				tickRunning = false;
				if (!firstTickCompleted) {
					firstTickCompleted = true;
					onPhaseChange?.("running");
				}
			});
		};

		const timer = setInterval(runTick, intervalS * 1000);
		setTimeout(runTick, 0).unref?.();

		const cleanup = () => {
			clearInterval(timer);
			mdnsHandle?.close();
			onPhaseChange?.("stopping");
			resolve();
		};

		if (signal) {
			if (signal.aborted) {
				cleanup();
				return;
			}
			signal.addEventListener("abort", cleanup, { once: true });
		}
	});
}

/**
 * Run a single tick, opening and closing a DB connection.
 *
 * Errors are caught and recorded in sync_daemon_state.
 */
async function runTickOnce(dbPath: string, keysDir?: string): Promise<void> {
	const db = connectDb(dbPath);
	try {
		await syncDaemonTick(db, keysDir);
		setSyncDaemonOk(db);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? (err.stack ?? "") : "";
		setSyncDaemonError(db, message, stack);
	} finally {
		db.close();
	}
}
