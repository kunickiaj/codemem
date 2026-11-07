import { performance } from "node:perf_hooks";
import type { Database } from "./db.js";
import { createPeerHttpExecutor, type PeerHttpConnectionFactory } from "./peer-http-client.js";
import { adoptPeerHttpConnection } from "./peer-http-client-lifecycle.js";
import { parseRelayEd25519PublicKey } from "./relay-ed25519.js";
import type { RelayFailureReason } from "./relay-failure-reason.js";
import { readAuthenticatedRelayNoisePeerPin } from "./relay-noise.js";
import type { SecretScanner } from "./secret-scanner.js";
import { buildDirectPeerAuthHeaders } from "./sync-auth.js";
import {
	LOCAL_SYNC_FEATURES,
	SYNC_CAPABILITY_HEADER,
	SYNC_FEATURES_HEADER,
	supportsSyncFeature,
} from "./sync-capability.js";
import {
	clearSyncChannelProgress,
	getSyncChannelProgress,
	hasCompletedSyncChannelBoundary,
	type SyncChannelBoundary,
	saveSyncChannelCompletedBoundary,
	saveSyncChannelOutboundAck,
} from "./sync-channel-progress.js";
import type { RequestJsonExecutor } from "./sync-http-client.js";
import { ensureDeviceIdentity, fingerprintPublicKey } from "./sync-identity.js";
import { type SyncScopeResult, syncScopedPeerPull } from "./sync-pass.js";
import { filterReplicationOpsForSyncWithStatus } from "./sync-replication.js";
import { parseSyncScopeRequest } from "./sync-scope-protocol.js";
import {
	recordSyncTransferObservation,
	recordSyncTransferReceipts,
} from "./sync-transfer-activity.js";
import type { ReplicationOp } from "./types.js";

const MAX_BODY_BYTES = 1_048_576;
export interface ScopedChannelSyncOptions {
	db: Database;
	peerDeviceId: string;
	scopeId: string;
	logicalOrigin: string;
	/** Relay factories report their first route failure, which the result records locally. */
	factory: PeerHttpConnectionFactory & { failureReason?: () => RelayFailureReason | undefined };
	keysDir?: string;
	dbPath?: string;
	scanner?: SecretScanner;
	limit?: number;
	signal?: AbortSignal;
	deadlineMs?: number;
}
type Identity = { device_id: string; public_key: string; fingerprint: string };
type Peer = { public_key: string; pinned_fingerprint: string };
type Scope = Parameters<typeof syncScopedPeerPull>[1]["scope"];
type Context = ReturnType<typeof captureContext>;

function canonicalKey(key: string): string {
	return `ssh-ed25519 ${Buffer.from(parseRelayEd25519PublicKey(key).wireKey).toString("base64")}`;
}

function currentIdentity(db: Database): Identity {
	const row = db
		.prepare("SELECT device_id, public_key, fingerprint FROM sync_device LIMIT 1")
		.get() as Identity | undefined;
	if (!row?.device_id || fingerprintPublicKey(row.public_key) !== row.fingerprint)
		throw new Error("channel identity invalid");
	canonicalKey(row.public_key);
	return row;
}

function currentPeer(db: Database, peerDeviceId: string): Peer {
	const row = db
		.prepare("SELECT public_key, pinned_fingerprint FROM sync_peers WHERE peer_device_id = ?")
		.get(peerDeviceId) as Peer | undefined;
	if (
		!row?.public_key ||
		!row.pinned_fingerprint ||
		fingerprintPublicKey(row.public_key) !== row.pinned_fingerprint
	)
		throw new Error("channel peer trust invalid");
	canonicalKey(row.public_key);
	return row;
}

function captureContext(input: ScopedChannelSyncOptions) {
	const passDeadline = performance.now() + 60_000;
	const options = { ...input };
	const origin = new URL(options.logicalOrigin);
	if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== options.logicalOrigin)
		throw new Error("channel origin invalid");
	if (!options.scopeId || options.scopeId.trim() !== options.scopeId)
		throw new Error("channel scope invalid");
	if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1))
		throw new Error("channel limit invalid");
	if (options.deadlineMs !== undefined && !Number.isFinite(options.deadlineMs))
		throw new Error("channel deadline invalid");
	ensureDeviceIdentity(options.db, { keysDir: options.keysDir });
	return {
		...options,
		deadlineMs: Math.min(options.deadlineMs ?? passDeadline, passDeadline),
		limit: Math.min(options.limit ?? 500, 1000),
		local: currentIdentity(options.db),
		peer: currentPeer(options.db, options.peerDeviceId),
		open: options.factory.open.bind(options.factory),
	};
}

function checkAuthorization(context: Context): void {
	const local = currentIdentity(context.db);
	const peer = currentPeer(context.db, context.peerDeviceId);
	if (
		local.device_id !== context.local.device_id ||
		local.public_key !== context.local.public_key ||
		peer.public_key !== context.peer.public_key ||
		peer.pinned_fingerprint !== context.peer.pinned_fingerprint
	)
		throw new Error("channel trust changed");
	const admission = parseSyncScopeRequest(context.scopeId, true, {
		db: context.db,
		localDeviceId: local.device_id,
		localSigningPublicKey: local.public_key,
		peerDeviceId: context.peerDeviceId,
		authenticatedPeerSigningKey: peer.public_key,
		negotiatedCapability: "scoped",
	});
	if (!admission.ok) throw new Error("channel scope authorization denied");
}

function validatePullPayload(context: Context, url: URL, payload: Record<string, unknown>): void {
	if (payload.scope_id !== context.scopeId) throw new Error("channel response scope invalid");
	if (url.pathname === "/v1/ops") {
		if (!Array.isArray(payload.ops)) throw new Error("channel ops invalid");
		for (const raw of payload.ops) {
			const op = raw as Partial<ReplicationOp> | null;
			if (
				!op ||
				op.scope_id !== context.scopeId ||
				op.device_id !== context.peerDeviceId ||
				op.clock_device_id !== context.peerDeviceId
			)
				throw new Error("channel op source or scope invalid");
		}
	}
	if (url.pathname === "/v1/snapshot" && !Array.isArray(payload.items))
		throw new Error("channel snapshot invalid");
}

function channelExecutor(context: Context): RequestJsonExecutor {
	const execute = createPeerHttpExecutor({
		signal: context.signal,
		deadlineMs: context.deadlineMs,
		factory: {
			open: async (options) => {
				checkAuthorization(context);
				const connection = await context.open(options);
				const owned = adoptPeerHttpConnection(connection);
				try {
					checkAuthorization(context);
					if (
						!owned.valid ||
						readAuthenticatedRelayNoisePeerPin(owned.duplex) !==
							canonicalKey(context.peer.public_key)
					)
						throw new Error("channel peer pin mismatch");
					return owned;
				} catch {
					await owned.dispose(new Error("channel trust invalid"));
					throw new Error("channel trust invalid");
				}
			},
		},
	});
	return async (method, target, options = {}) => {
		checkAuthorization(context);
		const url = new URL(target);
		if (url.origin !== context.logicalOrigin) throw new Error("channel target invalid");
		const response = await execute(method, target, options);
		checkAuthorization(context);
		const [status, payload] = response;
		if (method === "GET" && url.pathname !== "/v1/status" && status === 200 && payload)
			validatePullPayload(context, url, payload);
		if (status >= 400 && status !== 409 && status !== 413)
			throw new Error("channel request failed");
		return response;
	};
}

function signedHeaders(context: Context, method: string, url: string, bodyBytes: Buffer) {
	return {
		...buildDirectPeerAuthHeaders({
			deviceId: context.local.device_id,
			recipientId: context.peerDeviceId,
			method,
			url,
			bodyBytes,
			keysDir: context.keysDir,
			dbPath: context.dbPath,
		}),
		[SYNC_CAPABILITY_HEADER]: "scoped",
		[SYNC_FEATURES_HEADER]: LOCAL_SYNC_FEATURES.join(","),
	};
}

function checkedBoundary(value: unknown, scopeId: string): Scope["sync_reset"] {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("channel status invalid");
	const b = value as Scope["sync_reset"];
	if (
		b.scope_id !== scopeId ||
		!Number.isSafeInteger(b.generation) ||
		b.generation < 1 ||
		typeof b.snapshot_id !== "string" ||
		!b.snapshot_id.trim() ||
		!(b.baseline_cursor === null || typeof b.baseline_cursor === "string") ||
		!(b.retained_floor_cursor === null || typeof b.retained_floor_cursor === "string")
	)
		throw new Error("channel status invalid");
	return b;
}

async function fetchStatus(context: Context, execute: RequestJsonExecutor) {
	const url = `${context.logicalOrigin}/v1/status?${new URLSearchParams({ scope_id: context.scopeId })}`;
	const [status, payload] = await execute("GET", url, {
		headers: signedHeaders(context, "GET", url, Buffer.alloc(0)),
	});
	if (
		status !== 200 ||
		!payload ||
		payload.device_id !== context.peerDeviceId ||
		payload.fingerprint !== context.peer.pinned_fingerprint ||
		String(payload.protocol_version) !== "2" ||
		payload.sync_capability !== "scoped" ||
		!Array.isArray(payload.authorized_scopes) ||
		payload.authorized_scopes.length !== 1
	)
		throw new Error("channel status invalid");
	const scope = payload.authorized_scopes[0] as Scope | null;
	if (!scope || scope.scope_id !== context.scopeId) throw new Error("channel status invalid");
	const boundary = checkedBoundary(scope.sync_reset, context.scopeId);
	const top = checkedBoundary(payload.sync_reset, context.scopeId);
	for (const key of [
		"generation",
		"snapshot_id",
		"baseline_cursor",
		"retained_floor_cursor",
	] as const)
		if (top[key] !== boundary[key]) throw new Error("channel status invalid");
	return { scope, features: payload.sync_features, appliedCursor: appliedCursor(scope) };
}

/** The peer's pull cursor for this device, when it reports one in the right shape. */
function appliedCursor(scope: Scope): string | null {
	const value = (scope as { applied_cursor?: unknown }).applied_cursor;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	const separator = trimmed.indexOf("|");
	return separator > 0 && separator < trimmed.length - 1 ? trimmed : null;
}

/** Cursors order by `created_at` text, then op ID, the same order the push window uses. */
function laterCursor(a: string | null, b: string | null): string | null {
	if (!a) return b;
	if (!b) return a;
	const [aTime, aOp] = [a.slice(0, a.indexOf("|")), a.slice(a.indexOf("|") + 1)];
	const [bTime, bOp] = [b.slice(0, b.indexOf("|")), b.slice(b.indexOf("|") + 1)];
	if (aTime !== bTime) return aTime > bTime ? a : b;
	return aOp >= bOp ? a : b;
}

function loadOutbound(
	context: Context,
	boundary: SyncChannelBoundary,
	appliedByPeer: string | null,
): ReplicationOp[] {
	const progress = getSyncChannelProgress(context.db, context.peerDeviceId, context.scopeId);
	if (!hasCompletedSyncChannelBoundary(progress, boundary))
		throw new Error("channel progress changed");
	// The peer may already hold ops this channel never sent, for example from
	// direct sync before relay. Start after whichever position is later.
	const cursor = laterCursor(progress?.last_acked_cursor ?? null, appliedByPeer);
	const separator = cursor?.indexOf("|") ?? -1;
	const timestamp = cursor?.slice(0, separator) ?? "";
	const opId = cursor?.slice(separator + 1) ?? "";
	return context.db
		.prepare(`SELECT * FROM replication_ops WHERE device_id = ? AND scope_id = ?
		AND (? IS NULL OR created_at > ? OR (created_at = ? AND op_id > ?))
		ORDER BY created_at, op_id LIMIT ?`)
		.all(
			context.local.device_id,
			context.scopeId,
			cursor,
			timestamp,
			timestamp,
			opId,
			context.limit,
		) as ReplicationOp[];
}

function pushBody(scopeId: string, ops: ReplicationOp[]): Buffer {
	return Buffer.from(
		JSON.stringify({
			scope_id: scopeId,
			ops,
			sync_capability: "scoped",
			sync_features: LOCAL_SYNC_FEATURES,
		}),
	);
}

function planBatches(scopeId: string, ops: ReplicationOp[]): ReplicationOp[][] {
	if (ops.length === 0) return [];
	if (pushBody(scopeId, ops).length <= MAX_BODY_BYTES) return [ops];
	if (ops.length === 1) throw new Error("channel operation too large");
	const middle = Math.floor(ops.length / 2);
	return [
		...planBatches(scopeId, ops.slice(0, middle)),
		...planBatches(scopeId, ops.slice(middle)),
	];
}

function checkPushReply(payload: Record<string, unknown> | null, scopeId: string): void {
	if (
		!payload ||
		payload.scope_id !== scopeId ||
		payload.error != null ||
		(payload.errors !== undefined &&
			(!Array.isArray(payload.errors) || payload.errors.length !== 0)) ||
		(payload.rejected !== undefined && payload.rejected !== 0) ||
		(payload.rejections !== undefined &&
			(!Array.isArray(payload.rejections) || payload.rejections.length !== 0))
	)
		throw new Error("channel push rejected");
}

async function pushBatch(
	context: Context,
	execute: RequestJsonExecutor,
	ops: ReplicationOp[],
): Promise<void> {
	const url = `${context.logicalOrigin}/v1/ops`;
	const bodyBytes = pushBody(context.scopeId, ops);
	const [status, payload] = await execute("POST", url, {
		bodyBytes,
		headers: signedHeaders(context, "POST", url, bodyBytes),
	});
	if (
		status === 413 &&
		(payload?.error === "payload_too_large" || payload?.error === "too_many_ops") &&
		ops.length > 1
	) {
		const middle = Math.floor(ops.length / 2);
		await pushBatch(context, execute, ops.slice(0, middle));
		await pushBatch(context, execute, ops.slice(middle));
		return;
	}
	if (status !== 200) throw new Error("channel push failed");
	checkPushReply(payload, context.scopeId);
	checkAuthorization(context);
	context.db.transaction(() => {
		recordSyncTransferReceipts(
			context.db,
			context.peerDeviceId,
			"send",
			ops.map((op) => op.op_id),
		);
		recordSyncTransferObservation(context.db, context.peerDeviceId, "send");
	})();
}

async function pushOutbound(
	context: Context,
	execute: RequestJsonExecutor,
	features: unknown,
	boundary: SyncChannelBoundary,
	appliedByPeer: string | null,
): Promise<number> {
	checkAuthorization(context);
	const window = loadOutbound(context, boundary, appliedByPeer);
	const [ops, cursor] = filterReplicationOpsForSyncWithStatus(
		context.db,
		window,
		context.peerDeviceId,
		{
			localDeviceId: context.local.device_id,
			supportsReassignScope: supportsSyncFeature(features, "reassign_scope"),
		},
	);
	const save = (acked: string) =>
		saveSyncChannelOutboundAck(context.db, {
			peerDeviceId: context.peerDeviceId,
			scopeId: context.scopeId,
			boundary,
			cursor: acked,
		});
	// Each confirmed batch saves its own ACK, so a pass that runs out of time keeps
	// what the peer already applied instead of resending the whole window next pass.
	for (const batch of planBatches(context.scopeId, ops)) {
		await pushBatch(context, execute, batch);
		checkAuthorization(context);
		const last = batch.at(-1);
		if (last) save(`${last.created_at}|${last.op_id}`);
	}
	checkAuthorization(context);
	// The window cursor also covers ops filtered out after the last one sent. An
	// empty window means the peer's reported position already covers everything.
	const saved = getSyncChannelProgress(context.db, context.peerDeviceId, context.scopeId);
	const reached = laterCursor(laterCursor(cursor, appliedByPeer), saved?.last_acked_cursor ?? null);
	// A peer whose reported position is behind the saved ACK changes nothing.
	if (reached && reached !== saved?.last_acked_cursor) save(reached);
	return ops.length;
}

/** Appends the factory's first relay reason, if any, to the existing generic local error. */
function failedResult(
	result: SyncScopeResult,
	factory: ScopedChannelSyncOptions["factory"],
	error: string,
): SyncScopeResult {
	const reason = factory.failureReason?.();
	if (!reason) return { ...result, ok: false, error };
	return { ...result, ok: false, error: `${error}: ${reason}`, relayFailureReason: reason };
}

function failedPullResult(
	options: ScopedChannelSyncOptions,
	result: SyncScopeResult,
): SyncScopeResult {
	const errorCode =
		result.receiveFailureCode ??
		(result.failureCategory === "scope" ? "scope_rejected" : "exchange_failed");
	recordSyncTransferObservation(options.db, options.peerDeviceId, "receive", { errorCode });
	return failedResult(result, options.factory, "channel pull failed");
}

/** Internal, opt-in scoped exchange. Never discovers addresses or refreshes authorization. */
export async function syncScopedChannelOnce(
	options: ScopedChannelSyncOptions,
): Promise<SyncScopeResult> {
	let sending = false;
	let result: SyncScopeResult = {
		scope_id: options.scopeId,
		ok: false,
		opsIn: 0,
		opsOut: 0,
		bootstrapped: false,
	};
	try {
		const context = captureContext(options);
		checkAuthorization(context);
		const execute = channelExecutor(context);
		const status = await fetchStatus(context, execute);
		checkAuthorization(context);
		const progress = getSyncChannelProgress(context.db, context.peerDeviceId, context.scopeId);
		result = await syncScopedPeerPull(context.db, {
			peerDeviceId: context.peerDeviceId,
			baseUrl: context.logicalOrigin,
			deviceId: context.local.device_id,
			scope: status.scope,
			requestExecutor: execute,
			keysDir: context.keysDir,
			dbPath: context.dbPath,
			scanner: context.scanner,
			limit: context.limit,
			completedNullBaseline: hasCompletedSyncChannelBoundary(progress, status.scope.sync_reset),
			sourceDeviceId: context.peerDeviceId,
			validateCurrentAuthorization: () => checkAuthorization(context),
			invalidateCompletedBoundary: () =>
				clearSyncChannelProgress(context.db, context.peerDeviceId, context.scopeId),
		});
		if (!result.ok) return failedPullResult(options, result);
		// One Space per pass proves the receive path works, but other scopes stay unretried.
		recordSyncTransferObservation(context.db, context.peerDeviceId, "receive", {
			preserveScopedError: true,
		});
		checkAuthorization(context);
		saveSyncChannelCompletedBoundary(context.db, {
			peerDeviceId: context.peerDeviceId,
			scopeId: context.scopeId,
			boundary: status.scope.sync_reset,
		});
		sending = true;
		const opsOut = await pushOutbound(
			context,
			execute,
			status.features,
			status.scope.sync_reset,
			status.appliedCursor,
		);
		return { ...result, opsOut };
	} catch {
		recordSyncTransferObservation(options.db, options.peerDeviceId, sending ? "send" : "receive", {
			errorCode: "exchange_failed",
		});
		return failedResult(result, options.factory, "scoped channel exchange failed");
	}
}
