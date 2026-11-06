import { performance } from "node:perf_hooks";
import type { Database } from "./db.js";
import { isRelayPeerClient, type RelayPeerClient } from "./relay-peer-client.js";
import { supportsSyncFeature } from "./sync-capability.js";
import { syncScopedChannelOnce } from "./sync-channel-pass.js";
import { type RequestJsonExecutor, requestJson } from "./sync-http-client.js";
import {
	type SyncPassOptions,
	type SyncResult,
	type SyncScopeResult,
	syncOnce,
} from "./sync-pass.js";

export interface SyncReachabilityOptions {
	/** One explicitly authorized Space for relay fallback. Direct sync retains its existing scope behavior. */
	readonly scopeId: string;
	readonly logicalOrigin: string;
	readonly relay?: RelayPeerClient;
	readonly signal?: AbortSignal;
	readonly deadlineMs?: number;
}

export type SyncReachabilityMaintenance = Pick<
	SyncReachabilityOptions,
	"relay" | "signal" | "deadlineMs"
>;

/**
 * Per-peer reachability for the sync daemon. The caller owns every relay
 * client's lifecycle and must close the clients during shutdown.
 */
export interface SyncPeerReachabilityResolver {
	/** This tick's relay route for one peer, or undefined for direct-only sync. */
	forPeer(db: Database, peerDeviceId: string): SyncReachabilityOptions | undefined;
	/** Relay clients whose registration the daemon maintains once per tick. */
	clients(): readonly RelayPeerClient[];
	/** Cancels maintenance and every pass this resolver selects. */
	readonly signal?: AbortSignal;
}

/** Reuses the existing reconciliation tick. Maintenance failure never blocks direct sync. */
export async function maintainSyncReachability(
	options: SyncReachabilityMaintenance,
): Promise<void> {
	if (!isRelayPeerClient(options.relay)) return;
	try {
		await options.relay.maintainRegistration(
			options.signal ?? new AbortController().signal,
			Math.min(options.deadlineMs ?? Infinity, performance.now() + 3000),
		);
	} catch {
		// A later selected relay attempt reports failure through the normal pass result.
	}
}

const activePeers = new WeakMap<Database, Set<string>>();
const NETWORK_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET",
]);

function networkFailure(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const value = error as { name?: string; code?: string; cause?: unknown };
	if (value.name === "TimeoutError" || (value.code && NETWORK_CODES.has(value.code))) return true;
	if (!value.cause || typeof value.cause !== "object") return false;
	const cause = value.cause as { code?: string };
	return cause.code !== undefined && NETWORK_CODES.has(cause.code);
}

function failure(transport: "direct" | "wait", error: string): SyncResult {
	return {
		ok: false,
		transport,
		error,
		failureCategory: "other",
		opsIn: 0,
		opsOut: 0,
		addressErrors: [],
	};
}

function requireActive(signal: AbortSignal, deadline: number): void {
	if (signal.aborted || performance.now() >= deadline)
		throw new Error("Sync pass cancelled or expired");
}

class DirectPass {
	committedOrigin: string | null = null;
	terminal = false;
	attempts = 0;
	private readonly probeDeadline: number;
	constructor(
		private readonly execute: RequestJsonExecutor,
		private readonly fingerprint: string,
		private readonly signal: AbortSignal,
		private readonly deadline: number,
		private readonly directDeadline: number,
	) {
		this.probeDeadline = Math.min(deadline, performance.now() + 10_000);
	}

	private requestOrigin(method: string, url: string): string {
		requireActive(this.signal, this.committedOrigin === null ? this.deadline : this.directDeadline);
		const origin = new URL(url).origin;
		if (this.terminal || (this.committedOrigin !== null && this.committedOrigin !== origin))
			throw new Error("Sync transport is already committed");
		if (
			this.committedOrigin === null &&
			(method !== "GET" || !new URL(url).pathname.endsWith("/v1/status"))
		) {
			this.terminal = true;
			throw new Error("Sync status is required before application requests");
		}
		return origin;
	}

	readonly request: RequestJsonExecutor = async (method, url, options = {}) => {
		const origin = this.requestOrigin(method, url);
		try {
			const remaining =
				(this.committedOrigin === null ? this.probeDeadline : this.directDeadline) -
				performance.now();
			if (remaining <= 0)
				throw new DOMException("Direct reachability deadline expired", "TimeoutError");
			this.attempts++;
			const response = await this.execute(method, url, {
				...options,
				redirect: "error",
				signal: this.signal,
				timeoutS: Math.min(options.timeoutS ?? 3, remaining / 1000),
			});
			requireActive(
				this.signal,
				this.committedOrigin === null ? this.deadline : this.directDeadline,
			);
			if (this.committedOrigin === null) {
				if (response[0] === 200 && response[1]?.fingerprint === this.fingerprint)
					this.committedOrigin = origin;
				else this.terminal = true;
			}
			return response;
		} catch (error) {
			if (this.committedOrigin !== null || this.signal.aborted || !networkFailure(error))
				this.terminal = true;
			throw error;
		}
	};
}

async function selectedPass(
	db: Database,
	peerDeviceId: string,
	addresses: string[],
	options: SyncPassOptions,
	reachability: SyncReachabilityOptions,
): Promise<SyncResult> {
	const deadline = Math.min(reachability.deadlineMs ?? Infinity, performance.now() + 60_000);
	const signal = reachability.signal ?? new AbortController().signal;
	if (
		(reachability.deadlineMs !== undefined && !Number.isFinite(reachability.deadlineMs)) ||
		!Number.isFinite(deadline) ||
		!reachability.scopeId.trim()
	)
		return failure("wait", "Invalid sync pass configuration");
	requireActive(signal, deadline);
	const peer = db
		.prepare("SELECT pinned_fingerprint, public_key FROM sync_peers WHERE peer_device_id = ?")
		.get(peerDeviceId) as { pinned_fingerprint: string; public_key: string } | undefined;
	if (!peer?.pinned_fingerprint)
		return { ...failure("direct", "Peer is not pinned"), failureCategory: "trust" };
	const direct = new DirectPass(
		options.requestExecutor ?? requestJson,
		peer.pinned_fingerprint,
		signal,
		deadline,
		reachability.deadlineMs ?? Infinity,
	);
	const result = await syncOnce(db, peerDeviceId, addresses, {
		...options,
		requestExecutor: direct.request,
		attemptRecorder: options.attemptRecorder ?? (() => {}),
	});
	if (result.ok || direct.committedOrigin !== null || direct.terminal)
		return { ...result, transport: "direct" };
	if (direct.attempts === 0 && result.error !== "no dialable peer addresses")
		return { ...result, transport: "direct" };
	// The traversal engine has no approved runtime capability. No RTC networking starts here.
	if (!reachability.relay) return { ...result, transport: "wait" };
	if (!isRelayPeerClient(reachability.relay))
		return failure("wait", "Relay transport is unavailable");
	requireActive(signal, deadline);
	return relayPass(db, peerDeviceId, peer.public_key, options, reachability, signal, result);
}

async function relayPass(
	db: Database,
	peerDeviceId: string,
	peerPublicKey: string,
	options: SyncPassOptions,
	reachability: SyncReachabilityOptions,
	signal: AbortSignal,
	direct: SyncResult,
): Promise<SyncResult> {
	if (!isRelayPeerClient(reachability.relay))
		return failure("wait", "Relay transport is unavailable");
	// A skipped relay is a wait, so the pass records only the direct attempt, as it
	// does when no relay is configured.
	const skip = relaySkipReason(db, peerDeviceId);
	if (skip) return { ...direct, transport: "wait", relaySkipped: skip };
	const scoped = await syncScopedChannelOnce({
		db,
		peerDeviceId,
		scopeId: reachability.scopeId,
		logicalOrigin: reachability.logicalOrigin,
		factory: reachability.relay.factory(peerDeviceId, peerPublicKey),
		keysDir: options.keysDir,
		dbPath: options.dbPath,
		scanner: options.scanner,
		limit: options.limit,
		signal,
		// Direct attempts to unreachable addresses can use most of the pass deadline.
		// Relay gets its own lifetime, bounded only by an explicit caller deadline.
		deadlineMs: reachability.deadlineMs,
	});
	recordRelayOutcome(db, peerDeviceId, scoped);
	return relayResult(scoped, direct);
}

const RELAY_REJECTION_BACKOFF_MS = [2, 4, 8, 16, 30].map((minutes) => minutes * 60_000);
/** A "no relay client" observation is trusted this long; after that the rejection back-off applies. */
const RELAY_UNSUPPORTED_TTL_MS = 24 * 60 * 60_000;

/**
 * Why relay is not tried for this peer right now, or null to try it.
 *
 * A peer that last advertised `relay_aware` without `relay` over direct sync runs
 * no relay client, so the realm has no route for it. That observation expires after
 * a day, because the peer may turn relay on while direct sync is unavailable. A peer
 * without `relay_aware` predates the feature and may still relay, so it is treated as
 * unknown. A peer that recently
 * sent REJECTED is retried on a growing schedule, since REJECTED carries no
 * reason and most often means the peer is offline or not on relay.
 */
function relaySkipReason(db: Database, peerDeviceId: string): SyncResult["relaySkipped"] | null {
	const row = db
		.prepare(
			`SELECT sync_features_json, sync_features_observed_at, relay_retry_after
			FROM sync_peers WHERE peer_device_id = ?`,
		)
		.get(peerDeviceId) as
		| {
				sync_features_json: string | null;
				sync_features_observed_at: string | null;
				relay_retry_after: string | null;
		  }
		| undefined;
	if (!row) return null;
	const features = row.sync_features_json === null ? null : parseJson(row.sync_features_json);
	const observedAt = Date.parse(row.sync_features_observed_at ?? "");
	if (
		features !== null &&
		Date.now() - observedAt < RELAY_UNSUPPORTED_TTL_MS &&
		supportsSyncFeature(features, "relay_aware") &&
		!supportsSyncFeature(features, "relay")
	)
		return "relay_peer_unsupported";
	if (row.relay_retry_after && row.relay_retry_after > new Date().toISOString())
		return "relay_backoff";
	return null;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function recordRelayOutcome(db: Database, peerDeviceId: string, result: SyncScopeResult): void {
	const now = new Date().toISOString();
	if (result.ok) {
		db.prepare(
			`UPDATE sync_peers SET last_sync_at = ?, last_seen_at = ?, last_error = NULL,
			relay_retry_after = NULL, relay_rejections = 0 WHERE peer_device_id = ?`,
		).run(now, now, peerDeviceId);
		return;
	}
	if (result.relayFailureReason !== "relay_rejected") return;
	const rejections =
		((
			db
				.prepare("SELECT relay_rejections FROM sync_peers WHERE peer_device_id = ?")
				.get(peerDeviceId) as { relay_rejections: number } | undefined
		)?.relay_rejections ?? 0) + 1;
	const backoff =
		RELAY_REJECTION_BACKOFF_MS[Math.min(rejections, RELAY_REJECTION_BACKOFF_MS.length) - 1];
	db.prepare(
		"UPDATE sync_peers SET relay_retry_after = ?, relay_rejections = ? WHERE peer_device_id = ?",
	).run(new Date(Date.now() + (backoff ?? 0)).toISOString(), rejections, peerDeviceId);
}

function relayResult(scoped: SyncScopeResult, direct: SyncResult): SyncResult {
	return {
		ok: scoped.ok,
		transport: "relay",
		opsIn: scoped.opsIn,
		opsOut: scoped.opsOut,
		error: scoped.error,
		failureCategory: scoped.failureCategory,
		resetRequired: scoped.resetRequired,
		perScopeResults: [scoped],
		addressErrors: direct.addressErrors,
	};
}

/** Opt-in direct → approved traversal when available → relay → wait. Never changes paths after status. */
export async function runReachableSyncPass(
	db: Database,
	peerDeviceId: string,
	addresses: string[],
	options: SyncPassOptions,
): Promise<SyncResult> {
	const reachability = options.reachability;
	if (!reachability) return syncOnce(db, peerDeviceId, addresses, options);
	let active = activePeers.get(db);
	if (!active) {
		active = new Set();
		activePeers.set(db, active);
	}
	if (active.has(peerDeviceId)) return failure("wait", "Peer sync is already in progress");
	active.add(peerDeviceId);
	try {
		return await selectedPass(db, peerDeviceId, addresses, options, reachability);
	} catch {
		return failure("wait", "Sync pass cancelled or failed");
	} finally {
		active.delete(peerDeviceId);
	}
}
