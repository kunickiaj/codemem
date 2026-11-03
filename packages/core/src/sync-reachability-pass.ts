import { performance } from "node:perf_hooks";
import type { Database } from "./db.js";
import { isRelayPeerClient, type RelayPeerClient } from "./relay-peer-client.js";
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

/** Reuses the existing reconciliation tick. Maintenance failure never blocks direct sync. */
export async function maintainSyncReachability(options: SyncReachabilityOptions): Promise<void> {
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
	const scoped = await syncScopedChannelOnce({
		db,
		peerDeviceId,
		scopeId: reachability.scopeId,
		logicalOrigin: reachability.logicalOrigin,
		factory: reachability.relay.factory(peerDeviceId, peer.public_key),
		keysDir: options.keysDir,
		dbPath: options.dbPath,
		scanner: options.scanner,
		limit: options.limit,
		signal,
		deadlineMs: deadline,
	});
	recordRelaySuccess(db, peerDeviceId, scoped);
	return relayResult(scoped, result);
}

function recordRelaySuccess(db: Database, peerDeviceId: string, result: SyncScopeResult): void {
	if (!result.ok) return;
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE sync_peers SET last_sync_at = ?, last_seen_at = ?, last_error = NULL
		WHERE peer_device_id = ?`,
	).run(now, now, peerDeviceId);
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
