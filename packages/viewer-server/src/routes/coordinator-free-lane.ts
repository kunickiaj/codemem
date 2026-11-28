import {
	applyCoordinatorFreeOps,
	COORDINATOR_FREE_LANE,
	coordinatorFreeEligibility,
	coordinatorFreeOutboundOps,
	DEFAULT_SYNC_SCOPE_ID,
	extractReplicationOps,
	fingerprintPublicKey,
	getSyncResetState,
	LaneApplyError,
	LOCAL_SYNC_CAPABILITY,
	LOCAL_SYNC_FEATURES,
	loadReplicationOpsForPeer,
	type MemoryStore,
} from "@codemem/core";
import type { Context } from "hono";

/*
 * Serves sync without a coordinator. The caller reaches this only through the sync channel,
 * whose handshake proved the peer's pinned key, so a request over plain HTTP never gets here.
 * Every request rechecks this device's own eligibility for the peer.
 */

export interface CoordinatorFreeRequest {
	store: MemoryStore;
	peerDeviceId: string;
	peerSigningKey: string;
	localDeviceId: string;
	localFingerprint: string;
	keysDir: string | undefined;
	bodyBytes: Buffer;
}

function laneBoundary(store: MemoryStore) {
	return { ...getSyncResetState(store.db), scope_id: DEFAULT_SYNC_SCOPE_ID };
}

function status(c: Context, input: CoordinatorFreeRequest, consent: boolean): Response {
	return c.json({
		device_id: input.localDeviceId,
		fingerprint: input.localFingerprint,
		protocol_version: "2",
		sync_capability: LOCAL_SYNC_CAPABILITY,
		sync_features: LOCAL_SYNC_FEATURES,
		coordinator_free: consent
			? { lane: COORDINATOR_FREE_LANE, consent: true, sync_reset: laneBoundary(input.store) }
			: { lane: COORDINATOR_FREE_LANE, consent: false },
	});
}

function pull(c: Context, input: CoordinatorFreeRequest): Response {
	const query = (name: string) => c.req.query(name) ?? null;
	const rawLimit = Number.parseInt(query("limit") ?? "200", 10);
	const generation = Number.parseInt(query("generation") ?? "", 10);
	const result = loadReplicationOpsForPeer(input.store.db, {
		since: query("since"),
		limit: Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 1000)) : 200,
		deviceId: input.localDeviceId,
		generation: Number.isFinite(generation) ? generation : null,
		snapshotId: query("snapshot_id"),
		baselineCursor: query("baseline_cursor"),
		coordinatorFreeLane: true,
	});
	if (result.reset_required) {
		return c.json(
			{ error: "reset_required", ...result.reset, scope_id: DEFAULT_SYNC_SCOPE_ID },
			409,
		);
	}
	const { allowed, nextCursor } = coordinatorFreeOutboundOps(input.store.db, result.ops, {
		localDeviceId: input.localDeviceId,
		peerDeviceId: input.peerDeviceId,
	});
	return c.json({
		scope_id: DEFAULT_SYNC_SCOPE_ID,
		generation: result.boundary.generation,
		snapshot_id: result.boundary.snapshot_id,
		baseline_cursor: result.boundary.baseline_cursor,
		ops: allowed,
		next_cursor: result.nextCursor ?? nextCursor,
	});
}

function push(c: Context, input: CoordinatorFreeRequest): Response {
	let body: unknown;
	try {
		body = JSON.parse(input.bodyBytes.toString("utf8"));
	} catch {
		return c.json({ error: "invalid_json" }, 400);
	}
	const ops = extractReplicationOps(body);
	const sent = (body as { ops?: unknown } | null)?.ops;
	// A batch is applied whole or not at all, so one malformed op refuses it.
	if (!Array.isArray(sent) || ops.length !== sent.length)
		return c.json({ error: "invalid_ops" }, 400);
	if (ops.some((op) => op.device_id !== input.peerDeviceId))
		return c.json({ error: "invalid_op_device" }, 400);
	try {
		const applied = applyCoordinatorFreeOps(input.store.db, ops, {
			localDeviceId: input.localDeviceId,
			peerDeviceId: input.peerDeviceId,
			peerFingerprint: fingerprintPublicKey(input.peerSigningKey),
			scanner: input.store.scanner,
		});
		return c.json({
			scope_id: DEFAULT_SYNC_SCOPE_ID,
			applied: applied.applied,
			skipped: applied.skipped,
			rejected: applied.rejections.length,
			rejections: applied.rejections,
		});
	} catch (error) {
		if (error instanceof LaneApplyError) return c.json({ error: "apply_failed" }, 500);
		throw error;
	}
}

export function serveCoordinatorFree(c: Context, input: CoordinatorFreeRequest): Response {
	const eligibility = coordinatorFreeEligibility(input.store.db, {
		peerDeviceId: input.peerDeviceId,
		channelAuthenticated: true,
		keysDir: input.keysDir,
	});
	const path = new URL(c.req.url).pathname;
	if (path === "/v1/status") return status(c, input, eligibility.eligible);
	if (!eligibility.eligible) return c.json({ error: "coordinator_free_not_allowed" }, 403);
	if (path === "/v1/ops" && c.req.method === "GET") return pull(c, input);
	if (path === "/v1/ops" && c.req.method === "POST") return push(c, input);
	return c.json({ error: "not found" }, 404);
}
