/**
 * Sync routes — status, peers, actors, attempts, pairing, mutations.
 */

import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import type { MemoryStore, ReplicationOp } from "@codemem/core";
import {
	applyReplicationOps,
	cleanupNonces,
	coordinatorCreateInviteAction,
	coordinatorImportInviteAction,
	coordinatorReviewJoinRequestAction,
	coordinatorStatusSnapshot,
	DEFAULT_TIME_WINDOW_S,
	ensureDeviceIdentity,
	extractReplicationOps,
	fingerprintPublicKey,
	getSyncResetState,
	listCoordinatorJoinRequests,
	loadMemorySnapshotPageForPeer,
	loadReplicationOpsForPeer,
	readCoordinatorSyncConfig,
	recordNonce,
	schema,
	verifySignature,
} from "@codemem/core";
import { count, desc, eq, max, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { queryBool, queryInt, safeJsonList } from "../helpers.js";

type StoreFactory = () => MemoryStore;
type SyncRuntimeStatus = {
	phase: "starting" | "running" | "stopping" | "error" | "disabled" | null;
	detail?: string | null;
};

const SYNC_STALE_AFTER_SECONDS = 10 * 60;
const SYNC_PROTOCOL_VERSION = "1";

function intEnvOr(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) ? value : fallback;
}

const MAX_SYNC_BODY_BYTES = intEnvOr("CODEMEM_SYNC_MAX_BODY_BYTES", 1_048_576);
const MAX_SYNC_OPS = intEnvOr("CODEMEM_SYNC_MAX_OPS", 2000);

const PAIRING_FILTER_HINT =
	"Run this on another device with codemem sync pair --accept '<payload>'. " +
	"On the accepting device, --include/--exclude control both what it sends and what it accepts from that peer.";

function pathWithQuery(url: string): string {
	const parsed = new URL(url);
	return parsed.search ? `${parsed.pathname}${parsed.search}` : parsed.pathname;
}

function unauthorizedPayload(reason: string): Record<string, string> {
	if (process.env.CODEMEM_SYNC_AUTH_DIAGNOSTICS === "1") {
		return { error: "unauthorized", reason };
	}
	return { error: "unauthorized" };
}

function authorizeSyncRequest(
	store: MemoryStore,
	request: { method: string; url: string; header(name: string): string | undefined },
	body: Buffer,
): { ok: boolean; reason: string; deviceId: string } {
	const deviceId = (request.header("X-Opencode-Device") ?? "").trim();
	const signature = request.header("X-Opencode-Signature") ?? "";
	const timestamp = request.header("X-Opencode-Timestamp") ?? "";
	const nonce = request.header("X-Opencode-Nonce") ?? "";
	if (!deviceId || !signature || !timestamp || !nonce) {
		return { ok: false, reason: "missing_headers", deviceId };
	}

	const peerRow = store.db
		.prepare(
			"SELECT pinned_fingerprint, public_key FROM sync_peers WHERE peer_device_id = ? LIMIT 1",
		)
		.get(deviceId) as { pinned_fingerprint: string | null; public_key: string | null } | undefined;
	if (!peerRow) {
		return { ok: false, reason: "unknown_peer", deviceId };
	}

	const pinnedFingerprint = String(peerRow.pinned_fingerprint ?? "").trim();
	const publicKey = String(peerRow.public_key ?? "").trim();
	if (!pinnedFingerprint || !publicKey) {
		return { ok: false, reason: "peer_record_incomplete", deviceId };
	}
	if (fingerprintPublicKey(publicKey) !== pinnedFingerprint) {
		return { ok: false, reason: "fingerprint_mismatch", deviceId };
	}

	let valid = false;
	try {
		valid = verifySignature({
			method: request.method,
			pathWithQuery: pathWithQuery(request.url),
			bodyBytes: body,
			timestamp,
			nonce,
			signature,
			publicKey,
			deviceId,
		});
	} catch {
		return { ok: false, reason: "signature_verification_error", deviceId };
	}

	if (!valid) {
		return { ok: false, reason: "invalid_signature", deviceId };
	}

	const createdAt = new Date().toISOString();
	if (!recordNonce(store.db, deviceId, nonce, createdAt)) {
		return { ok: false, reason: "nonce_replay", deviceId };
	}

	const cutoff = new Date(Date.now() - DEFAULT_TIME_WINDOW_S * 2 * 1000).toISOString();
	cleanupNonces(store.db, cutoff);
	return { ok: true, reason: "ok", deviceId };
}

function projectBasename(value: string | null | undefined): string {
	const project = String(value ?? "")
		.trim()
		.replaceAll("\\", "/");
	if (!project) return "";
	const parts = project.split("/").filter(Boolean);
	return parts.length > 0 ? (parts[parts.length - 1] ?? "") : "";
}

function parseJsonList(value: unknown): string[] {
	if (value == null) return [];
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.map((entry) => String(entry ?? "").trim()).filter(Boolean);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(value)) return [];
	return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function readPeerProjectFilters(
	store: MemoryStore,
	peerDeviceId: string,
): { include: string[]; exclude: string[] } {
	const globalConfig = readCoordinatorSyncConfig();
	const row = store.db
		.prepare(
			"SELECT projects_include_json, projects_exclude_json FROM sync_peers WHERE peer_device_id = ? LIMIT 1",
		)
		.get(peerDeviceId) as
		| { projects_include_json: string | null; projects_exclude_json: string | null }
		| undefined;
	if (!row) {
		return {
			include: globalConfig.syncProjectsInclude,
			exclude: globalConfig.syncProjectsExclude,
		};
	}
	const hasOverride = row.projects_include_json != null || row.projects_exclude_json != null;
	if (!hasOverride) {
		return {
			include: globalConfig.syncProjectsInclude,
			exclude: globalConfig.syncProjectsExclude,
		};
	}
	return {
		include: parseJsonList(row.projects_include_json),
		exclude: parseJsonList(row.projects_exclude_json),
	};
}

function peerClaimedLocalActor(store: MemoryStore, peerDeviceId: string): boolean {
	const row = store.db
		.prepare("SELECT claimed_local_actor FROM sync_peers WHERE peer_device_id = ? LIMIT 1")
		.get(peerDeviceId) as { claimed_local_actor: number | null } | undefined;
	return Boolean(row?.claimed_local_actor);
}

function parseOpPayload(op: { payload_json: string | null }): Record<string, unknown> | null {
	if (!op.payload_json || !String(op.payload_json).trim()) return null;
	try {
		const parsed = JSON.parse(op.payload_json) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function isSharedVisibility(payload: Record<string, unknown> | null): boolean {
	if (!payload) return false;
	let visibility = String(payload.visibility ?? "")
		.trim()
		.toLowerCase();
	const metadata =
		payload.metadata_json &&
		typeof payload.metadata_json === "object" &&
		!Array.isArray(payload.metadata_json)
			? (payload.metadata_json as Record<string, unknown>)
			: {};
	const metadataVisibility = String(metadata.visibility ?? "")
		.trim()
		.toLowerCase();
	if (!visibility && metadataVisibility) visibility = metadataVisibility;
	if (!visibility) {
		let workspaceKind = String(payload.workspace_kind ?? "")
			.trim()
			.toLowerCase();
		let workspaceId = String(payload.workspace_id ?? "")
			.trim()
			.toLowerCase();
		if (!workspaceKind)
			workspaceKind = String(metadata.workspace_kind ?? "")
				.trim()
				.toLowerCase();
		if (!workspaceId)
			workspaceId = String(metadata.workspace_id ?? "")
				.trim()
				.toLowerCase();
		if (workspaceKind === "shared" || workspaceId.startsWith("shared:")) {
			visibility = "shared";
		} else {
			return true;
		}
	}
	return visibility === "shared";
}

function projectAllowed(
	projectValue: string | null,
	filters: { include: string[]; exclude: string[] },
): boolean {
	const value = String(projectValue ?? "").trim();
	const valueBase = projectBasename(value);
	for (const blocked of filters.exclude) {
		if (blocked === value || blocked === valueBase) return false;
	}
	if (filters.include.length === 0) return true;
	for (const allowed of filters.include) {
		if (allowed === value || allowed === valueBase) return true;
	}
	return false;
}

function filterOpsForPeer(
	store: MemoryStore,
	peerDeviceId: string,
	ops: ReplicationOp[],
): { allowed: ReplicationOp[]; skipped: number } {
	const filters = readPeerProjectFilters(store, peerDeviceId);
	const allowPrivate = peerClaimedLocalActor(store, peerDeviceId);
	const allowed: ReplicationOp[] = [];
	let skipped = 0;
	for (const op of ops) {
		if (op.entity_type !== "memory_item") {
			allowed.push(op);
			continue;
		}
		const payload = parseOpPayload(op);
		if (!allowPrivate && !isSharedVisibility(payload)) {
			skipped++;
			continue;
		}
		const project = payload && typeof payload.project === "string" ? payload.project : null;
		if (!projectAllowed(project, filters)) {
			skipped++;
			continue;
		}
		allowed.push(op);
	}
	return { allowed, skipped };
}

// ---------------------------------------------------------------------------
// Peer row mapping — deduplicated helper (fix #4)
// ---------------------------------------------------------------------------

/**
 * Map a raw sync_peers DB row to the API response shape.
 * When showDiag is false, sensitive fields (fingerprint, last_error, addresses)
 * are redacted.
 */
function mapPeerRow(row: Record<string, unknown>, showDiag: boolean): Record<string, unknown> {
	return {
		peer_device_id: row.peer_device_id,
		name: row.name,
		fingerprint: showDiag ? row.pinned_fingerprint : null,
		pinned: Boolean(row.pinned_fingerprint),
		addresses: showDiag ? safeJsonList(row.addresses_json as string | null) : [],
		last_seen_at: row.last_seen_at,
		last_sync_at: row.last_sync_at,
		last_error: showDiag ? row.last_error : null,
		has_error: Boolean(row.last_error),
		claimed_local_actor: Boolean(row.claimed_local_actor),
		actor_id: row.actor_id ?? null,
		actor_display_name: row.actor_display_name ?? null,
		project_scope: {
			include: safeJsonList(row.projects_include_json as string | null),
			exclude: safeJsonList(row.projects_exclude_json as string | null),
			effective_include: safeJsonList(row.projects_include_json as string | null),
			effective_exclude: safeJsonList(row.projects_exclude_json as string | null),
			inherits_global: row.projects_include_json == null && row.projects_exclude_json == null,
		},
	};
}

// ---------------------------------------------------------------------------
// Peer status helpers
// ---------------------------------------------------------------------------

function isRecentIso(value: unknown, windowS = SYNC_STALE_AFTER_SECONDS): boolean {
	const raw = String(value ?? "").trim();
	if (!raw) return false;
	const normalized = raw.replace("Z", "+00:00");
	const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
	const ts = new Date(hasOffset ? normalized : `${normalized}+00:00`);
	if (Number.isNaN(ts.getTime())) return false;
	const ageS = (Date.now() - ts.getTime()) / 1000;
	return ageS >= 0 && ageS <= windowS;
}

function peerStatus(peer: Record<string, unknown>): Record<string, unknown> {
	const lastSyncAt = peer.last_sync_at;
	const lastPingAt = peer.last_seen_at;
	const hasError = Boolean(peer.has_error);

	const syncFresh = isRecentIso(lastSyncAt);
	const pingFresh = isRecentIso(lastPingAt);

	let peerState: string;
	if (hasError && !(syncFresh || pingFresh)) peerState = "offline";
	else if (hasError) peerState = "degraded";
	else if (syncFresh || pingFresh) peerState = "online";
	else if (lastSyncAt || lastPingAt) peerState = "stale";
	else peerState = "unknown";

	const syncStatus = hasError ? "error" : syncFresh ? "ok" : lastSyncAt ? "stale" : "unknown";
	const pingStatus = pingFresh ? "ok" : lastPingAt ? "stale" : "unknown";

	return {
		sync_status: syncStatus,
		ping_status: pingStatus,
		peer_state: peerState,
		fresh: syncFresh || pingFresh,
		last_sync_at: lastSyncAt,
		last_ping_at: lastPingAt,
	};
}

function attemptStatus(attempt: Record<string, unknown>): string {
	if (attempt.ok) return "ok";
	if (attempt.error) return "error";
	return "unknown";
}

function readViewerBinding(dbPath: string): { host: string; port: number } | null {
	try {
		const raw = readFileSync(join(dirname(dbPath), "viewer.pid"), "utf8");
		const parsed = JSON.parse(raw) as Partial<{ host: string; port: number }>;
		if (typeof parsed.host === "string" && typeof parsed.port === "number") {
			return { host: parsed.host, port: parsed.port };
		}
	} catch {
		// ignore missing/malformed pidfile
	}
	return null;
}

async function portOpen(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host, port });
		const done = (ok: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(300);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

const PEERS_QUERY = `
	SELECT p.peer_device_id, p.name, p.pinned_fingerprint, p.addresses_json,
	       p.last_seen_at, p.last_sync_at, p.last_error,
	       p.projects_include_json, p.projects_exclude_json, p.claimed_local_actor,
	       p.actor_id, a.display_name AS actor_display_name
	FROM sync_peers AS p
	LEFT JOIN actors AS a ON a.actor_id = p.actor_id
	ORDER BY name, peer_device_id
`;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Peer-to-peer sync protocol routes (/v1/*).
 *
 * These are mounted on the sync listener (0.0.0.0:7337) and are
 * network-accessible. All requests are auth-gated via signature
 * verification so unauthenticated callers are rejected.
 */
export function syncProtocolRoutes(getStore: StoreFactory) {
	const app = new Hono();

	// GET /v1/status (peer sync protocol)
	app.get("/v1/status", (c) => {
		const store = getStore();
		const auth = authorizeSyncRequest(store, c.req, Buffer.alloc(0));
		if (!auth.ok) return c.json(unauthorizedPayload(auth.reason), 401);

		try {
			let device = store.db
				.prepare("SELECT device_id, fingerprint FROM sync_device LIMIT 1")
				.get() as { device_id: string; fingerprint: string } | undefined;
			if (!device) {
				const [deviceId, fingerprint] = ensureDeviceIdentity(store.db);
				device = { device_id: deviceId, fingerprint };
			}
			const syncReset = getSyncResetState(store.db);
			return c.json({
				device_id: device.device_id,
				protocol_version: SYNC_PROTOCOL_VERSION,
				fingerprint: device.fingerprint,
				sync_reset: syncReset,
			});
		} catch {
			return c.json({ error: "internal_error" }, 500);
		}
	});

	// GET /v1/ops (peer sync protocol)
	app.get("/v1/ops", (c) => {
		const store = getStore();
		const auth = authorizeSyncRequest(store, c.req, Buffer.alloc(0));
		if (!auth.ok) return c.json(unauthorizedPayload(auth.reason), 401);
		const peerDeviceId = auth.deviceId;

		try {
			const since = c.req.query("since") ?? null;
			const rawLimit = Number.parseInt(c.req.query("limit") ?? "200", 10);
			const rawGeneration = c.req.query("generation");
			const generation =
				rawGeneration != null && rawGeneration.trim().length > 0
					? Number.parseInt(rawGeneration, 10)
					: null;
			const snapshotId = c.req.query("snapshot_id") ?? null;
			const baselineCursor = c.req.query("baseline_cursor") ?? null;
			const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 1000)) : 200;
			let localDeviceId = store.db.prepare("SELECT device_id FROM sync_device LIMIT 1").get() as
				| { device_id: string }
				| undefined;
			if (!localDeviceId) {
				const [deviceId] = ensureDeviceIdentity(store.db);
				localDeviceId = { device_id: deviceId };
			}
			const result = loadReplicationOpsForPeer(store.db, {
				since,
				limit,
				deviceId: localDeviceId.device_id,
				generation: Number.isFinite(generation) ? generation : null,
				snapshotId,
				baselineCursor,
			});
			if (result.reset_required) {
				return c.json(
					{
						error: "reset_required",
						...result.reset,
					},
					409,
				);
			}
			const { ops, nextCursor, boundary } = result;
			const filtered = filterOpsForPeer(store, peerDeviceId, ops);
			return c.json({
				reset_required: false,
				generation: boundary.generation,
				snapshot_id: boundary.snapshot_id,
				baseline_cursor: boundary.baseline_cursor,
				retained_floor_cursor: boundary.retained_floor_cursor,
				ops: filtered.allowed,
				next_cursor: nextCursor,
				skipped: filtered.skipped,
			});
		} catch {
			return c.json({ error: "internal_error" }, 500);
		}
	});

	// POST /v1/ops (peer sync protocol)
	app.post("/v1/ops", async (c) => {
		const store = getStore();
		const raw = Buffer.from(await c.req.arrayBuffer());
		if (raw.length > MAX_SYNC_BODY_BYTES) {
			return c.json({ error: "payload_too_large" }, 413);
		}

		const auth = authorizeSyncRequest(store, c.req, raw);
		if (!auth.ok) return c.json(unauthorizedPayload(auth.reason), 401);
		const peerDeviceId = auth.deviceId;

		let body: Record<string, unknown>;
		try {
			const parsed = JSON.parse(raw.toString("utf-8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return c.json({ error: "invalid_json" }, 400);
			}
			body = parsed as Record<string, unknown>;
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}

		if (!Array.isArray(body.ops)) {
			return c.json({ error: "invalid_ops" }, 400);
		}
		if (body.ops.length > MAX_SYNC_OPS) {
			return c.json({ error: "too_many_ops" }, 413);
		}

		const normalizedOps = extractReplicationOps(body);
		for (const op of normalizedOps) {
			if (op.device_id !== peerDeviceId || op.clock_device_id !== peerDeviceId) {
				return c.json(
					{
						error: "invalid_op_device",
						reason: "device_id_mismatch",
						op_id: op.op_id,
					},
					400,
				);
			}
		}
		let localDeviceId = store.db.prepare("SELECT device_id FROM sync_device LIMIT 1").get() as
			| { device_id: string }
			| undefined;
		if (!localDeviceId) {
			const [deviceId] = ensureDeviceIdentity(store.db);
			localDeviceId = { device_id: deviceId };
		}

		const filteredInbound = filterOpsForPeer(store, peerDeviceId, normalizedOps);
		const result = applyReplicationOps(store.db, filteredInbound.allowed, localDeviceId.device_id);
		return c.json({
			...result,
			skipped: result.skipped + filteredInbound.skipped,
		});
	});

	// GET /v1/bootstrap/memories (peer snapshot bootstrap protocol)
	app.get("/v1/bootstrap/memories", (c) => {
		const store = getStore();
		const auth = authorizeSyncRequest(store, c.req, Buffer.alloc(0));
		if (!auth.ok) return c.json(unauthorizedPayload(auth.reason), 401);
		const peerDeviceId = auth.deviceId;

		try {
			const rawLimit = Number.parseInt(c.req.query("limit") ?? "200", 10);
			const rawGeneration = c.req.query("generation");
			const generation =
				rawGeneration != null && rawGeneration.trim().length > 0
					? Number.parseInt(rawGeneration, 10)
					: null;
			const snapshotId = c.req.query("snapshot_id") ?? null;
			const baselineCursor = c.req.query("baseline_cursor") ?? null;
			const pageToken = c.req.query("page_token") ?? null;
			const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 1000)) : 200;
			const page = loadMemorySnapshotPageForPeer(store.db, {
				limit,
				pageToken,
				peerDeviceId,
				generation: Number.isFinite(generation) ? generation : null,
				snapshotId,
				baselineCursor,
			});
			return c.json({
				generation: page.boundary.generation,
				snapshot_id: page.boundary.snapshot_id,
				baseline_cursor: page.boundary.baseline_cursor,
				retained_floor_cursor: page.boundary.retained_floor_cursor,
				items: page.items,
				next_page_token: page.nextPageToken,
				has_more: page.hasMore,
			});
		} catch (err) {
			if (
				err instanceof Error &&
				(err.message === "generation_mismatch" || err.message === "boundary_mismatch")
			) {
				const boundary = getSyncResetState(store.db);
				return c.json(
					{ error: "reset_required", reset_required: true, reason: err.message, ...boundary },
					409,
				);
			}
			return c.json({ error: "internal_error" }, 500);
		}
	});

	return app;
}

/**
 * Viewer-facing sync management routes (/api/sync/*).
 *
 * These are mounted on the viewer listener (127.0.0.1:38888) and
 * provide sync status, peer management, and coordinator UI for the
 * local viewer.
 */
export function syncRoutes(
	getStore: StoreFactory,
	getSyncRuntimeStatus?: () => SyncRuntimeStatus | null,
) {
	const app = new Hono();

	// GET /api/sync/status
	app.get("/api/sync/status", async (c) => {
		const store = getStore();
		{
			const showDiag = queryBool(c.req.query("includeDiagnostics"));
			const includeJoinRequests = queryBool(c.req.query("includeJoinRequests"));
			const project = c.req.query("project") || null;
			const config = readCoordinatorSyncConfig();

			const d = drizzle(store.db, { schema });

			const deviceRow = d
				.select({
					device_id: schema.syncDevice.device_id,
					fingerprint: schema.syncDevice.fingerprint,
				})
				.from(schema.syncDevice)
				.limit(1)
				.get();

			const daemonState = d
				.select()
				.from(schema.syncDaemonState)
				.where(eq(schema.syncDaemonState.id, 1))
				.get();

			const peerCountRow = d.select({ total: count() }).from(schema.syncPeers).get();

			const lastSyncRow = d
				.select({ last_sync_at: max(schema.syncPeers.last_sync_at) })
				.from(schema.syncPeers)
				.get();

			const lastError = daemonState?.last_error as string | null;
			const lastErrorAt = daemonState?.last_error_at as string | null;
			const lastOkAt = daemonState?.last_ok_at as string | null;
			const viewerBinding = readViewerBinding(store.dbPath);
			const daemonRunning = viewerBinding
				? await portOpen(viewerBinding.host, viewerBinding.port)
				: false;
			const daemonDetail = viewerBinding
				? daemonRunning
					? `viewer pidfile at ${viewerBinding.host}:${viewerBinding.port}`
					: `pidfile present but ${viewerBinding.host}:${viewerBinding.port} is unreachable`
				: null;

			let daemonStateValue = "ok";
			if (!config.syncEnabled) {
				daemonStateValue = "disabled";
			} else if (lastError && (!lastOkAt || String(lastOkAt) < String(lastErrorAt ?? ""))) {
				daemonStateValue = "error";
			} else if (!daemonRunning) {
				daemonStateValue = "stopped";
			}

			const statusPayload: Record<string, unknown> = {
				enabled: config.syncEnabled,
				interval_s: config.syncIntervalS,
				peer_count: Number(peerCountRow?.total ?? 0),
				last_sync_at: lastSyncRow?.last_sync_at ?? null,
				daemon_state: daemonStateValue,
				daemon_running: daemonRunning,
				daemon_detail: daemonDetail,
				project_filter_active:
					config.syncProjectsInclude.length > 0 || config.syncProjectsExclude.length > 0,
				project_filter: {
					include: config.syncProjectsInclude,
					exclude: config.syncProjectsExclude,
				},
				redacted: !showDiag,
			};

			if (showDiag) {
				statusPayload.device_id = deviceRow?.device_id ?? null;
				statusPayload.fingerprint = deviceRow?.fingerprint ?? null;
				statusPayload.bind = `${config.syncHost}:${config.syncPort}`;
				statusPayload.daemon_last_error = lastError;
				statusPayload.daemon_last_error_at = lastErrorAt;
				statusPayload.daemon_last_ok_at = lastOkAt;
			}

			const runtimeStatus = getSyncRuntimeStatus?.() ?? null;
			if (runtimeStatus?.phase && runtimeStatus.phase !== "running") {
				daemonStateValue = runtimeStatus.phase;
				statusPayload.daemon_state = daemonStateValue;
				statusPayload.daemon_running = runtimeStatus.phase === "starting" || daemonRunning;
				statusPayload.daemon_detail = runtimeStatus.detail ?? daemonDetail;
			}

			// Build peers list using deduplicated mapPeerRow
			const peerRows = store.db.prepare(PEERS_QUERY).all() as Record<string, unknown>[];
			const peersItems = peerRows.map((row) => {
				const peer = mapPeerRow(row, showDiag);
				peer.status = peerStatus(peer);
				return peer;
			});

			const peersMap: Record<string, unknown> = {};
			for (const peer of peersItems) {
				peersMap[String(peer.peer_device_id)] = peer.status;
			}

			// Attempts
			const attemptRows = d
				.select({
					peer_device_id: schema.syncAttempts.peer_device_id,
					ok: schema.syncAttempts.ok,
					error: schema.syncAttempts.error,
					started_at: schema.syncAttempts.started_at,
					finished_at: schema.syncAttempts.finished_at,
					ops_in: schema.syncAttempts.ops_in,
					ops_out: schema.syncAttempts.ops_out,
				})
				.from(schema.syncAttempts)
				.orderBy(desc(schema.syncAttempts.finished_at))
				.limit(25)
				.all();
			const attemptsItems = attemptRows.map((row) => ({
				...row,
				status: attemptStatus(row),
				address: null,
			}));

			const statusBlock: Record<string, unknown> = {
				...statusPayload,
				peers: peersMap,
				pending: 0,
				sync: {},
				ping: {},
			};
			const legacyDevices = store.claimableLegacyDeviceIds();
			const sharingReview = store.sharingReviewSummary(project);
			const coordinator = await coordinatorStatusSnapshot(store, config);
			let joinRequests: Record<string, unknown>[] = [];
			if (includeJoinRequests && config.syncCoordinatorAdminSecret) {
				try {
					joinRequests = await listCoordinatorJoinRequests(config);
				} catch {
					joinRequests = [];
				}
			}

			if (daemonStateValue === "ok") {
				const peerStates = new Set(
					peersItems.map((peer) =>
						String((peer.status as Record<string, unknown> | undefined)?.peer_state ?? ""),
					),
				);
				const latestFailedRecently = Boolean(
					attemptsItems[0] &&
						attemptsItems[0].status === "error" &&
						isRecentIso(attemptsItems[0].finished_at),
				);
				const allOffline =
					peersItems.length > 0 &&
					peersItems.every(
						(peer) =>
							String((peer.status as Record<string, unknown>)?.peer_state ?? "") === "offline",
					);
				if (latestFailedRecently) {
					const hasLivePeer = peerStates.has("online") || peerStates.has("degraded");
					if (hasLivePeer) daemonStateValue = "degraded";
					else if (allOffline) daemonStateValue = "offline-peers";
					else if (peersItems.length > 0) daemonStateValue = "stale";
				} else if (peerStates.has("degraded")) {
					daemonStateValue = "degraded";
				} else if (allOffline) {
					daemonStateValue = "offline-peers";
				} else if (peersItems.length > 0 && !peerStates.has("online")) {
					daemonStateValue = "stale";
				}
				statusPayload.daemon_state = daemonStateValue;
				statusBlock.daemon_state = daemonStateValue;
			}

			const responsePayload: Record<string, unknown> = {
				...statusPayload,
				status: statusBlock,
				peers: peersItems,
				attempts: attemptsItems.slice(0, 5),
				legacy_devices: legacyDevices,
				sharing_review: sharingReview,
				coordinator,
			};
			if (includeJoinRequests) {
				responsePayload.join_requests = joinRequests;
			}
			return c.json(responsePayload);
		}
	});

	// GET /api/sync/peers
	app.get("/api/sync/peers", (c) => {
		const store = getStore();
		{
			const showDiag = queryBool(c.req.query("includeDiagnostics"));
			const rows = store.db.prepare(PEERS_QUERY).all() as Record<string, unknown>[];
			// Use deduplicated mapPeerRow helper (fix #4)
			const peers = rows.map((row) => mapPeerRow(row, showDiag));
			return c.json({ items: peers, redacted: !showDiag });
		}
	});

	// GET /api/sync/actors
	app.get("/api/sync/actors", (c) => {
		const store = getStore();
		{
			const d = drizzle(store.db, { schema });
			const includeMerged = queryBool(c.req.query("includeMerged"));
			const query = d.select().from(schema.actors);
			const rows = includeMerged
				? query.orderBy(schema.actors.display_name).all()
				: query.where(ne(schema.actors.status, "merged")).orderBy(schema.actors.display_name).all();
			return c.json({ items: rows });
		}
	});

	// GET /api/sync/attempts
	app.get("/api/sync/attempts", (c) => {
		const store = getStore();
		{
			const d = drizzle(store.db, { schema });
			let limit = queryInt(c.req.query("limit"), 25);
			if (limit <= 0) return c.json({ error: "invalid_limit" }, 400);
			limit = Math.min(limit, 500);
			const rows = d
				.select({
					peer_device_id: schema.syncAttempts.peer_device_id,
					ok: schema.syncAttempts.ok,
					error: schema.syncAttempts.error,
					started_at: schema.syncAttempts.started_at,
					finished_at: schema.syncAttempts.finished_at,
					ops_in: schema.syncAttempts.ops_in,
					ops_out: schema.syncAttempts.ops_out,
				})
				.from(schema.syncAttempts)
				.orderBy(desc(schema.syncAttempts.finished_at))
				.limit(limit)
				.all();
			return c.json({ items: rows });
		}
	});

	// GET /api/sync/pairing — uses ensureDeviceIdentity from core (fix #5 context)
	app.get("/api/sync/pairing", (c) => {
		const store = getStore();
		{
			const showDiag = queryBool(c.req.query("includeDiagnostics"));
			if (!showDiag) {
				return c.json({
					redacted: true,
					pairing_filter_hint: PAIRING_FILTER_HINT,
				});
			}
			const d = drizzle(store.db, { schema });
			const deviceRow = d
				.select({
					device_id: schema.syncDevice.device_id,
					public_key: schema.syncDevice.public_key,
					fingerprint: schema.syncDevice.fingerprint,
				})
				.from(schema.syncDevice)
				.limit(1)
				.get();

			let deviceId: string | undefined;
			let publicKey: string | undefined;
			let fingerprint: string | undefined;

			if (deviceRow) {
				deviceId = String(deviceRow.device_id);
				publicKey = String(deviceRow.public_key);
				fingerprint = String(deviceRow.fingerprint);
			} else {
				// Fall back to ensureDeviceIdentity if no row exists
				try {
					const [id, fp] = ensureDeviceIdentity(store.db);
					deviceId = id;
					fingerprint = fp;
					const newRow = d
						.select({ public_key: schema.syncDevice.public_key })
						.from(schema.syncDevice)
						.where(eq(schema.syncDevice.device_id, id))
						.get();
					publicKey = newRow?.public_key ?? "";
				} catch {
					return c.json({ error: "device identity unavailable" }, 500);
				}
			}

			if (!deviceId || !fingerprint) {
				return c.json({ error: "public key missing" }, 500);
			}

			return c.json({
				device_id: deviceId,
				fingerprint,
				public_key: publicKey ?? null,
				pairing_filter_hint: PAIRING_FILTER_HINT,
				addresses: [],
			});
		}
	});

	// ------------------------------------------------------------------
	// POST mutations
	// ------------------------------------------------------------------

	// POST /api/sync/peers/rename
	app.post("/api/sync/peers/rename", async (c) => {
		const store = getStore();
		{
			const d = drizzle(store.db, { schema });
			const body = await c.req.json<Record<string, unknown>>();
			const peerDeviceId = String(body.peer_device_id ?? "").trim();
			const name = String(body.name ?? "").trim();
			if (!peerDeviceId) return c.json({ error: "peer_device_id required" }, 400);
			if (!name) return c.json({ error: "name required" }, 400);
			const exists = d
				.select({ peer_device_id: schema.syncPeers.peer_device_id })
				.from(schema.syncPeers)
				.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
				.get();
			if (!exists) return c.json({ error: "peer not found" }, 404);
			d.update(schema.syncPeers)
				.set({ name })
				.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
				.run();
			return c.json({ ok: true });
		}
	});

	app.post("/api/sync/invites/create", async (c) => {
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const groupId = String(body.group_id ?? "").trim();
		const coordinatorUrl = body.coordinator_url == null ? null : String(body.coordinator_url ?? "");
		const policy = String(body.policy ?? "auto_admit").trim();
		const ttlHours = Number.parseInt(String(body.ttl_hours ?? 24), 10);
		if (!groupId) return c.json({ error: "group_id required" }, 400);
		if (body.coordinator_url != null && typeof body.coordinator_url !== "string") {
			return c.json({ error: "coordinator_url must be string" }, 400);
		}
		if (!["auto_admit", "approval_required"].includes(policy)) {
			return c.json({ error: "policy must be auto_admit or approval_required" }, 400);
		}
		if (!Number.isFinite(ttlHours)) return c.json({ error: "ttl_hours must be int" }, 400);
		try {
			const config = readCoordinatorSyncConfig();
			const result = await coordinatorCreateInviteAction({
				groupId,
				coordinatorUrl,
				policy,
				ttlHours,
				createdBy: null,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			return c.json(result);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});

	app.post("/api/sync/invites/import", async (c) => {
		const store = getStore();
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const inviteValue = String(body.invite ?? "").trim();
		if (!inviteValue) return c.json({ error: "invite required" }, 400);
		try {
			const result = await coordinatorImportInviteAction({ inviteValue, dbPath: store.dbPath });
			return c.json(result);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});

	app.post("/api/sync/join-requests/review", async (c) => {
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const requestId = String(body.request_id ?? "").trim();
		const action = String(body.action ?? "").trim();
		if (!requestId) return c.json({ error: "request_id required" }, 400);
		if (!["approve", "deny"].includes(action)) {
			return c.json({ error: "action must be approve or deny" }, 400);
		}
		try {
			const config = readCoordinatorSyncConfig();
			const result = await coordinatorReviewJoinRequestAction({
				requestId,
				approve: action === "approve",
				reviewedBy: null,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!result) return c.json({ error: "join request not found" }, 404);
			return c.json({ ok: true, request: result });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return c.json(
				{ error: message },
				message.includes("request_not_found") || message.includes("not found") ? 404 : 400,
			);
		}
	});

	// DELETE /api/sync/peers/:peer_device_id
	app.delete("/api/sync/peers/:peer_device_id", (c) => {
		const store = getStore();
		{
			const d = drizzle(store.db, { schema });
			const peerDeviceId = c.req.param("peer_device_id")?.trim();
			if (!peerDeviceId) return c.json({ error: "peer_device_id required" }, 400);
			const exists = d
				.select({ peer_device_id: schema.syncPeers.peer_device_id })
				.from(schema.syncPeers)
				.where(eq(schema.syncPeers.peer_device_id, peerDeviceId))
				.get();
			if (!exists) return c.json({ error: "peer not found" }, 404);
			d.delete(schema.syncPeers).where(eq(schema.syncPeers.peer_device_id, peerDeviceId)).run();
			return c.json({ ok: true });
		}
	});

	return app;
}
