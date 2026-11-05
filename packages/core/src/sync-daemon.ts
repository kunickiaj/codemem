/**
 * Sync daemon: periodic background sync with all configured peers.
 *
 * Uses AbortSignal for cancellation and setInterval for periodic ticks.
 * Ported from codemem/sync/daemon.py — HTTP server portion is deferred
 * to the viewer-server Hono routes.
 */

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
	coordinatorEnabled,
	fetchCoordinatorStalePeers,
	readCoordinatorSyncConfig,
	refreshAuthorizedCoordinatorPeerTrust,
	registerCoordinatorPresence,
} from "./coordinator-runtime.js";

import type { Database } from "./db.js";
import { connect as connectDb, ensureAdditiveSchemaCompatibility, resolveDbPath } from "./db.js";
import type { RelayPeerClient } from "./relay-peer-client.js";
import * as schema from "./schema.js";
import { refreshConfiguredScopeMembershipCache } from "./scope-membership-cache.js";
import type { SecretScanner } from "./secret-scanner.js";
import { advertiseMdns, mdnsEnabled } from "./sync-discovery.js";
import { DeviceIdentityError, ensureDeviceIdentity } from "./sync-identity.js";
import { runSyncPass, shouldSkipOfflinePeer, syncPassPreflight } from "./sync-pass.js";
import type {
	SyncPeerReachabilityResolver,
	SyncReachabilityMaintenance,
	SyncReachabilityOptions,
} from "./sync-reachability-pass.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Relay integration for the daemon. A per-peer resolver selects each peer's
 * route and lists the clients to maintain. A single options object is the
 * legacy form and applies the same route to every peer.
 */
export type SyncDaemonReachability = SyncReachabilityOptions | SyncPeerReachabilityResolver;

export interface SyncDaemonOptions {
	/** Explicit programmatic relay integration. The caller owns every client's lifecycle. */
	reachability?: SyncDaemonReachability;
	host?: string;
	port?: number;
	intervalS?: number;
	dbPath?: string;
	keysDir?: string;
	signal?: AbortSignal;
	onPhaseChange?: (phase: "starting" | "running" | "stopping") => void;
	/**
	 * Workspace-aware secret scanner. When provided, the daemon's inbound
	 * peer apply path uses this scanner so any rules from the workspace
	 * `secret_scanner` config block are applied to received payloads.
	 * Without it, the apply path falls back to the built-in default
	 * ruleset and emits a single "sync apply running without explicit
	 * scanner" warning per process. Pass `store.scanner` from the viewer
	 * (`packages/cli/src/commands/serve.ts`) so foreground deployments
	 * stay in lockstep with local writes.
	 */
	scanner?: SecretScanner;
	/**
	 * Optional maintenance work serialized with each daemon tick. It runs after
	 * coordinator presence and membership refresh have been attempted and before
	 * peer synchronization starts. Failures are recorded but do not stop peer sync.
	 */
	onAfterCoordinatorRefresh?: SyncDaemonTickCallback;
}

export interface SyncDaemonTickContext {
	db: Database;
	dbPath: string;
	keysDir?: string;
}

export type SyncDaemonTickCallback = (context: SyncDaemonTickContext) => Promise<void> | void;

export interface SyncTickResult {
	ok: boolean;
	skipped?: boolean;
	reason?: string;
	error?: string;
	opsIn?: number;
	opsOut?: number;
}

export function resolveSyncDaemonKeysDir(keysDir?: string): string | undefined {
	const explicit = keysDir?.trim();
	if (explicit) return explicit;
	return process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
}

function tableColumnExists(db: Database, table: string, column: string): boolean {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
	return rows.some((row) => row.name === column);
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
		.values({ id: 1, last_ok_at: now, phase: null })
		.onConflictDoUpdate({
			target: schema.syncDaemonState.id,
			set: { last_ok_at: sql`excluded.last_ok_at`, phase: null },
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

function logSyncDaemonFailure(details: {
	message: string;
	error: unknown;
	reportingError?: unknown;
}): void {
	try {
		if (details.reportingError === undefined) {
			console.error(details.message, details.error);
			return;
		}
		console.error(details.message, details.error, details.reportingError);
	} catch {
		// Diagnostics must never replace or rethrow the daemon failure being contained.
	}
}

function reportSyncDaemonError(
	db: Database,
	error: unknown,
	options?: { prefix?: string; phase?: Exclude<SyncDaemonPhase, null> },
): void {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? (error.stack ?? "") : "";
	const reportedMessage = options?.prefix ? `${options.prefix}: ${message}` : message;
	try {
		setSyncDaemonError(db, reportedMessage, stack);
		if (options?.phase) setSyncDaemonPhase(db, options.phase);
	} catch (reportingError) {
		logSyncDaemonFailure({
			message: `[codemem] sync daemon failed and could not persist its diagnostic: ${reportedMessage}`,
			error,
			reportingError,
		});
	}
}

/** Valid sync daemon phases for the rebootstrap safety gate. */
export type SyncDaemonPhase = "identity_error" | "needs_attention" | null;

/**
 * Get the current sync daemon phase from sync_daemon_state.
 * Returns null when sync is operating normally.
 */
export function getSyncDaemonPhase(db: Database): SyncDaemonPhase {
	const d = drizzle(db, { schema });
	const row = d
		.select({ phase: schema.syncDaemonState.phase })
		.from(schema.syncDaemonState)
		.where(eq(schema.syncDaemonState.id, 1))
		.get();
	const phase = row?.phase;
	if (phase === "identity_error" || phase === "needs_attention") return phase;
	return null;
}

/**
 * Set the sync daemon phase. Pass null to clear.
 */
export function setSyncDaemonPhase(db: Database, phase: SyncDaemonPhase): void {
	const d = drizzle(db, { schema });
	d.insert(schema.syncDaemonState)
		.values({ id: 1, phase })
		.onConflictDoUpdate({
			target: schema.syncDaemonState.id,
			set: { phase },
		})
		.run();
}

export interface CoordinatorDaemonRefresh {
	/** True when the coordinator is configured and the refresh ran. */
	refreshed: boolean;
	/**
	 * The peer snapshot this refresh already fetched, or null when the
	 * coordinator is not configured. Pass it to fetchCoordinatorStalePeers so
	 * one tick performs one /v1/peers lookup instead of two.
	 */
	peers: Record<string, unknown>[] | null;
}

export async function refreshCoordinatorForDaemon(
	db: Database,
	dbPath: string,
	keysDir?: string,
): Promise<CoordinatorDaemonRefresh> {
	const config = readCoordinatorSyncConfig();
	if (!coordinatorEnabled(config)) return { refreshed: false, peers: null };
	await registerCoordinatorPresence({ db, dbPath }, config, { keysDir });
	await refreshConfiguredScopeMembershipCache(db, config, { keysDir, dbPath });
	const { peers } = await refreshAuthorizedCoordinatorPeerTrust({ db, dbPath }, config, {
		keysDir,
	});
	return { refreshed: true, peers };
}

/**
 * Boolean-only form of refreshCoordinatorForDaemon, kept for callers that do
 * not need the peer snapshot.
 */
export async function refreshCoordinatorPresenceForDaemon(
	db: Database,
	dbPath: string,
	keysDir?: string,
): Promise<boolean> {
	return (await refreshCoordinatorForDaemon(db, dbPath, keysDir)).refreshed;
}

// ---------------------------------------------------------------------------
// Sync tick
// ---------------------------------------------------------------------------

/**
 * Run one sync tick: iterate over all enabled peers and sync each.
 *
 * Returns per-peer results. Peers in backoff or with expired coordinator
 * presence are skipped.
 */
export async function syncDaemonTick(
	db: Database,
	keysDir?: string,
	stalePeers?: Set<string>,
	scanner?: SecretScanner,
	dbPath?: string,
	reachability?: SyncDaemonReachability,
): Promise<SyncTickResult[]> {
	const hasPinnedFingerprint = tableColumnExists(db, "sync_peers", "pinned_fingerprint");
	const rows = db
		.prepare(
			hasPinnedFingerprint
				? "SELECT peer_device_id, pinned_fingerprint FROM sync_peers"
				: "SELECT peer_device_id, NULL AS pinned_fingerprint FROM sync_peers",
		)
		.all() as Array<{ peer_device_id: string; pinned_fingerprint: string | null }>;

	// Skip heavy preflight work when there are no peers configured.
	// This keeps startup and idle daemon ticks responsive on large local stores.
	if (rows.length === 0) {
		return [];
	}

	const opsLimit = readCoordinatorSyncConfig().syncOpsLimit;

	syncPassPreflight(db);
	const tickRoutes = tickReachability(reachability);

	const results: SyncTickResult[] = [];
	for (const row of rows) {
		const peerDeviceId = row.peer_device_id;
		const pinnedFingerprint = String(row.pinned_fingerprint ?? "").trim();
		const stalePeerKey = pinnedFingerprint ? `${peerDeviceId}:${pinnedFingerprint}` : "";

		if (stalePeers?.has(peerDeviceId) || (stalePeerKey && stalePeers?.has(stalePeerKey))) {
			results.push({
				ok: false,
				skipped: true,
				reason: "peer offline (coordinator presence expired)",
			});
			continue;
		}

		if (shouldSkipOfflinePeer(db, peerDeviceId)) {
			results.push({ ok: false, skipped: true, reason: "peer offline (backoff)" });
			continue;
		}

		const result = await runSyncPass(db, peerDeviceId, {
			keysDir,
			dbPath,
			limit: opsLimit,
			scanner,
			reachability: tickRoutes?.forPeer(db, peerDeviceId),
		});
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
	const keysDir = resolveSyncDaemonKeysDir(options?.keysDir);
	const signal = options?.signal;
	const onPhaseChange = options?.onPhaseChange;
	const scanner = options?.scanner;
	const onAfterCoordinatorRefresh = options?.onAfterCoordinatorRefresh;
	onPhaseChange?.("starting");

	// Ensure device identity
	const db = connectDb(dbPath);
	let mdnsHandle: { close(): void } | null = null;
	try {
		try {
			const [deviceId] = ensureDeviceIdentity(db, { keysDir });

			// Start mDNS advertising if enabled
			if (mdnsEnabled() && options?.port) {
				mdnsHandle = advertiseMdns(deviceId, options.port);
			}
		} catch (error) {
			if (!(error instanceof DeviceIdentityError)) throw error;
			setSyncDaemonError(db, error.message, error.stack ?? "");
			setSyncDaemonPhase(db, "identity_error");
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
		const runTick = createSerializedDaemonTickRunner(
			() =>
				runTickOnce(
					dbPath,
					keysDir,
					scanner,
					onAfterCoordinatorRefresh,
					daemonReachability(options),
				),
			() => onPhaseChange?.("running"),
		);

		const timer = setInterval(runTick, intervalS * 1000);
		setTimeout(runTick, 0).unref?.();
		const stopMaintenance = startRelayMaintenanceTimer(daemonReachability(options));

		const cleanup = () => {
			clearInterval(timer);
			stopMaintenance();
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

export function createSerializedDaemonTickRunner(
	runTick: () => Promise<void>,
	onFirstCompleted?: () => void,
): () => boolean {
	let tickRunning = false;
	let firstTickCompleted = false;
	return () => {
		if (tickRunning) return false;
		tickRunning = true;
		void runTick()
			.finally(() => {
				tickRunning = false;
				if (!firstTickCompleted) {
					firstTickCompleted = true;
					onFirstCompleted?.();
				}
			})
			.catch((error) => {
				logSyncDaemonFailure({
					message: "[codemem] scheduled sync daemon tick failed:",
					error,
				});
			});
		return true;
	};
}

/**
 * Run a single tick, opening and closing a DB connection.
 *
 * Errors are caught and recorded in sync_daemon_state.
 */
export async function runTickOnce(
	dbPath: string,
	keysDir?: string,
	scanner?: SecretScanner,
	onAfterCoordinatorRefresh?: SyncDaemonTickCallback,
	reachability?: SyncDaemonReachability,
): Promise<void> {
	const resolvedKeysDir = resolveSyncDaemonKeysDir(keysDir);
	const db = connectDb(dbPath);
	try {
		ensureAdditiveSchemaCompatibility(db);
		ensureDeviceIdentity(db, { keysDir: resolvedKeysDir });
		let coordinatorPeers: Record<string, unknown>[] | null = null;
		try {
			coordinatorPeers = (await refreshCoordinatorForDaemon(db, dbPath, resolvedKeysDir)).peers;
		} catch {
			// Coordinator discovery is a supplemental surface. Keep direct peer sync running
			// even when heartbeat posting fails for this tick. Leaving coordinatorPeers null
			// lets the stale-peer preflight below fall back to its own lookup.
		}
		let callbackFailed = false;
		try {
			await onAfterCoordinatorRefresh?.({ db, dbPath, keysDir: resolvedKeysDir });
		} catch (error) {
			callbackFailed = true;
			reportSyncDaemonError(db, error, { prefix: "daemon tick callback failed" });
		}
		await maintainDaemonReachability(db, reachability);
		// Best-effort: skip peers the coordinator reports as offline.
		// Returns empty set when coordinator is disabled or lookup fails.
		const stalePeers = await fetchCoordinatorStalePeers(db, dbPath, resolvedKeysDir, {
			peers: coordinatorPeers ?? undefined,
		});
		const results = await syncDaemonTick(
			db,
			resolvedKeysDir,
			stalePeers,
			scanner,
			dbPath,
			reachability,
		);
		const needsAttention = results.some((r) => !r.ok && r.error?.includes("needs_attention"));
		if (needsAttention) {
			setSyncDaemonPhase(db, "needs_attention");
		} else if (!callbackFailed) {
			// Clear any prior needs_attention phase — all peers are healthy.
			setSyncDaemonOk(db);
		}
	} catch (error: unknown) {
		reportSyncDaemonError(db, error, {
			phase: error instanceof DeviceIdentityError ? "identity_error" : undefined,
		});
	} finally {
		db.close();
	}
}

function isPeerResolver(value: SyncDaemonReachability): value is SyncPeerReachabilityResolver {
	return typeof (value as Partial<SyncPeerReachabilityResolver>).forPeer === "function";
}

function combinedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
	const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (present.length <= 1) return present[0];
	return AbortSignal.any(present);
}

interface TickReachability {
	forPeer(db: Database, peerDeviceId: string): SyncReachabilityOptions | undefined;
	maintenance(): SyncReachabilityMaintenance[];
}

function resolvePeerRoute(
	input: SyncPeerReachabilityResolver,
	db: Database,
	peerDeviceId: string,
): SyncReachabilityOptions | undefined {
	try {
		return input.forPeer(db, peerDeviceId);
	} catch (error) {
		// A resolver failure leaves this peer on direct sync rather than aborting the tick.
		logSyncDaemonFailure({ message: "[codemem] relay route resolution failed:", error });
		return undefined;
	}
}

function resolverClients(input: SyncPeerReachabilityResolver): readonly RelayPeerClient[] {
	try {
		return input.clients();
	} catch (error) {
		logSyncDaemonFailure({ message: "[codemem] relay client listing failed:", error });
		return [];
	}
}

/** Adapts both option shapes to one per-peer form for a single tick. */
function tickReachability(input?: SyncDaemonReachability): TickReachability | undefined {
	if (!input) return undefined;
	if (!isPeerResolver(input)) return { forPeer: () => input, maintenance: () => [input] };
	return {
		forPeer(db, peerDeviceId) {
			const route = resolvePeerRoute(input, db, peerDeviceId);
			if (!route) return undefined;
			// A daemon tick starts a new pass. Absolute deadlines apply only to one-shot calls.
			return {
				...route,
				signal: combinedSignal(input.signal, route.signal),
				deadlineMs: undefined,
			};
		},
		maintenance: () =>
			[...new Set(resolverClients(input))].map((relay) => ({ relay, signal: input.signal })),
	};
}

/**
 * Maintenance at the start of each tick registers relay clients before peer
 * sync. Each client's wait is capped at three seconds, and the clients are
 * maintained concurrently. Renewal between ticks comes from the separate
 * maintenance timer below, because a long tick delays the next one.
 */
async function maintainDaemonReachability(
	db: Database,
	reachability?: SyncDaemonReachability,
): Promise<void> {
	const targets = tickReachability(reachability)?.maintenance() ?? [];
	if (targets.length === 0 || !db.prepare("SELECT 1 FROM sync_peers LIMIT 1").get()) return;
	const { maintainSyncReachability } = await import("./sync-reachability-pass.js");
	await Promise.all(targets.map((target) => maintainSyncReachability(target)));
}

export const RELAY_MAINTENANCE_INTERVAL_MS = 60_000;

/**
 * A registration lasts 900 s and the client renews it once less than 150 s
 * remain. A scheduled tick is skipped while the previous one still runs, so
 * tick maintenance alone can miss that window. This timer runs outside the
 * serialized tick runner. Overlap with tick maintenance is safe because the
 * client coalesces concurrent registration attempts.
 */
function startRelayMaintenanceTimer(reachability: SyncDaemonReachability | undefined): () => void {
	if (!reachability) return () => {};
	let running = false;
	const maintain = async () => {
		const targets = (tickReachability(reachability)?.maintenance() ?? []).filter(
			(target) => target.relay !== undefined,
		);
		if (targets.length === 0) return;
		const { maintainSyncReachability } = await import("./sync-reachability-pass.js");
		await Promise.all(targets.map((target) => maintainSyncReachability(target)));
	};
	const timer = setInterval(() => {
		if (running) return;
		running = true;
		void maintain()
			.catch((error) => {
				logSyncDaemonFailure({ message: "[codemem] relay maintenance failed:", error });
			})
			.finally(() => {
				running = false;
			});
	}, RELAY_MAINTENANCE_INTERVAL_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

function daemonReachability(options?: SyncDaemonOptions): SyncDaemonReachability | undefined {
	const reachability = options?.reachability;
	if (!reachability) return undefined;
	const signal = combinedSignal(options?.signal, reachability.signal);
	if (isPeerResolver(reachability)) {
		return {
			forPeer: (db, peerDeviceId) => reachability.forPeer(db, peerDeviceId),
			clients: () => reachability.clients(),
			signal,
		};
	}
	// A daemon tick starts a new pass. Absolute deadlines apply only to one-shot calls.
	return { ...reachability, signal, deadlineMs: undefined };
}
