import { type MemoryStore, readCoordinatorSyncConfig, readPeerSyncActivity } from "@codemem/core";

const STALE_AFTER_MS = 10 * 60_000;

export interface DirectionEvidence {
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	operations24h: number | null;
	errorCode: string | null;
	snapshotItems24h?: number | null;
	observedSince?: string | null;
}

export interface DirectionSyncHealth {
	state: "succeeded" | "not_verified" | "stale" | "needs_attention";
	last_attempt_at: string | null;
	last_success_at: string | null;
	operations_24h: number | null;
	pending_count: number | null;
	reason_code: string | null;
	snapshot_items_24h?: number | null;
	observed_since?: string | null;
}

export interface PeerSyncHealth {
	state: "exchange_succeeded" | "not_verified" | "stale" | "needs_attention";
	send: DirectionSyncHealth;
	receive: DirectionSyncHealth;
}

interface LatestAttempt {
	peer_device_id: string;
	ok: number;
	finished_at: string | null;
}

function timestamp(value: string | null): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function safeReasonCode(value: string | null | undefined): string | null {
	if (!value) return null;
	if (["transfer_failed", "apply_failed", "snapshot_failed", "scope_rejected"].includes(value))
		return value;
	return "transfer_failed";
}

export function directionSyncHealth(
	evidence: DirectionEvidence | undefined,
	options: { now: number; staleAfterMs?: number },
): DirectionSyncHealth {
	return {
		state: directionState(evidence, options),
		last_attempt_at: evidence?.lastAttemptAt ?? null,
		last_success_at: evidence?.lastSuccessAt ?? null,
		operations_24h: evidence?.operations24h ?? null,
		snapshot_items_24h: evidence?.snapshotItems24h ?? null,
		observed_since: evidence?.observedSince ?? null,
		// A successful window does not prove that either eligible stream is exhausted.
		pending_count: null,
		reason_code: safeReasonCode(evidence?.errorCode),
	};
}

function directionState(
	evidence: DirectionEvidence | undefined,
	options: { now: number; staleAfterMs?: number },
): DirectionSyncHealth["state"] {
	if (evidence?.errorCode) return "needs_attention";
	const success = timestamp(evidence?.lastSuccessAt ?? null);
	if (success === null || success > options.now) return "not_verified";
	return options.now - success <= (options.staleAfterMs ?? STALE_AFTER_MS) ? "succeeded" : "stale";
}

function unresolvedExchangeFailure(
	send: DirectionSyncHealth,
	receive: DirectionSyncHealth,
	options: { now: number; failedAt?: string | null },
): boolean {
	const failedAt = timestamp(options.failedAt ?? null);
	if (failedAt === null || failedAt > options.now) return false;
	const confirmedAt = Math.min(
		timestamp(send.last_success_at) ?? 0,
		timestamp(receive.last_success_at) ?? 0,
	);
	return failedAt >= confirmedAt;
}

export function peerSyncHealth(
	evidence: { send: DirectionEvidence; receive: DirectionEvidence } | undefined,
	options: { now: number; failedAt?: string | null; staleAfterMs?: number },
): PeerSyncHealth {
	const send = directionSyncHealth(evidence?.send, options);
	const receive = directionSyncHealth(evidence?.receive, options);
	const states = [send.state, receive.state];
	let state: PeerSyncHealth["state"] = "exchange_succeeded";
	if (states.includes("needs_attention") || unresolvedExchangeFailure(send, receive, options))
		state = "needs_attention";
	else if (states.includes("not_verified")) state = "not_verified";
	else if (states.includes("stale")) state = "stale";
	return { state, send, receive };
}

export function readPeerSyncHealth(
	store: MemoryStore,
	peerIds: string[],
): Map<string, PeerSyncHealth> {
	const now = Date.now();
	const staleAfterMs = Math.max(STALE_AFTER_MS, readCoordinatorSyncConfig().syncIntervalS * 3_000);
	const activity = readPeerSyncActivity(store.db, peerIds, { now: new Date(now).toISOString() });
	// The indexed peer/start lookup includes failures before a directional exchange starts.
	const latest = store.db.prepare(`
		SELECT p.peer_device_id, a.ok, a.finished_at FROM sync_peers p
		JOIN sync_attempts a ON a.id = (
			SELECT id FROM sync_attempts WHERE peer_device_id = p.peer_device_id
			ORDER BY started_at DESC, id DESC LIMIT 1
		)`);
	const failed = new Map<string, string>();
	for (const row of latest.all() as LatestAttempt[]) {
		if (!row.ok && row.finished_at) failed.set(row.peer_device_id, row.finished_at);
	}
	return new Map(
		peerIds.map((id) => [
			id,
			peerSyncHealth(activity.get(id), { now, staleAfterMs, failedAt: failed.get(id) }),
		]),
	);
}

export function overallSyncHealth(
	peers: Array<{ pinned?: unknown; sync_health?: unknown }>,
	options: { enabled: boolean; daemonState?: unknown },
) {
	const paired = peers.filter((peer) => peer.pinned);
	const states = paired.map((peer) => (peer.sync_health as PeerSyncHealth | undefined)?.state);
	const attention = states.filter((state) => state === "needs_attention").length;
	const unverified = states.filter((state) => !state || state === "not_verified").length;
	const stale = states.filter((state) => state === "stale").length;
	const daemonFailed = ["error", "needs_attention"].includes(String(options.daemonState));
	let state = "exchange_succeeded";
	if (!options.enabled) state = "disabled";
	else if (daemonFailed || attention > 0) state = "needs_attention";
	else if (paired.length === 0) state = "no_peers";
	else if (unverified > 0) state = "not_verified";
	else if (stale > 0) state = "stale";
	return {
		state,
		peer_count: paired.length,
		attention_count: attention,
		unverified_count: unverified,
		stale_count: stale,
	};
}
