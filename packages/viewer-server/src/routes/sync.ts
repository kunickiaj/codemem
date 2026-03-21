/**
 * Sync routes — status, peers, actors, attempts, pairing, mutations.
 */

import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import type { MemoryStore } from "@codemem/core";
import {
	coordinatorStatusSnapshot,
	ensureDeviceIdentity,
	listCoordinatorJoinRequests,
	readCoordinatorSyncConfig,
	schema,
} from "@codemem/core";
import { count, desc, eq, max, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Hono } from "hono";
import { queryBool, queryInt, safeJsonList } from "../helpers.js";

type StoreFactory = () => MemoryStore;

const SYNC_STALE_AFTER_SECONDS = 10 * 60;

const PAIRING_FILTER_HINT =
	"Run this on another device with codemem sync pair --accept '<payload>'. " +
	"On that accepting device, --include/--exclude only control what it sends to peers. " +
	"This device does not yet enforce incoming project filters.";

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

export function syncRoutes(getStore: StoreFactory) {
	const app = new Hono();

	// GET /api/sync/status
	app.get("/api/sync/status", async (c) => {
		const store = getStore();
		{
			const showDiag = queryBool(c.req.query("includeDiagnostics"));
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
			try {
				joinRequests = await listCoordinatorJoinRequests(config);
			} catch {
				joinRequests = [];
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

			return c.json({
				...statusPayload,
				status: statusBlock,
				peers: peersItems,
				attempts: attemptsItems.slice(0, 5),
				legacy_devices: legacyDevices,
				sharing_review: sharingReview,
				coordinator,
				join_requests: joinRequests,
			});
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
