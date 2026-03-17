/**
 * Sync routes — status, peers, actors, attempts, pairing, mutations.
 *
 * Ports Python's viewer_routes/sync.py with fixes:
 * - addresses: parsed from addresses_json via safeJsonList() (not hardcoded [])
 * - peer mapping: deduplicated into mapPeerRow() helper
 * - ensureDeviceIdentity: reads from sync_device table
 */

import type { MemoryStore } from "@codemem/core";
import { ensureDeviceIdentity } from "@codemem/core";
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
		actor_id: row.actor_id,
		actor_display_name: row.actor_display_name,
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
	const ts = new Date(raw.replace("Z", "+00:00"));
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
	app.get("/api/sync/status", (c) => {
		const store = getStore();
		{
			const showDiag = queryBool(c.req.query("includeDiagnostics"));
			const _project = c.req.query("project") || null;

			const deviceRow = store.db
				.prepare("SELECT device_id, fingerprint FROM sync_device LIMIT 1")
				.get() as Record<string, unknown> | undefined;

			const daemonState = store.db.prepare("SELECT * FROM sync_daemon_state WHERE id = 1").get() as
				| Record<string, unknown>
				| undefined;

			const peerCountRow = store.db.prepare("SELECT COUNT(1) AS total FROM sync_peers").get() as
				| Record<string, unknown>
				| undefined;

			const lastSyncRow = store.db
				.prepare("SELECT MAX(last_sync_at) AS last_sync_at FROM sync_peers")
				.get() as Record<string, unknown> | undefined;

			const lastError = daemonState?.last_error as string | null;
			const lastErrorAt = daemonState?.last_error_at as string | null;
			const lastOkAt = daemonState?.last_ok_at as string | null;

			let daemonStateValue = "ok";
			// Simplified: without full config access, default to enabled
			if (lastError && (!lastOkAt || String(lastOkAt) < String(lastErrorAt ?? ""))) {
				daemonStateValue = "error";
			}

			const statusPayload: Record<string, unknown> = {
				enabled: true,
				interval_s: 60,
				peer_count: Number(peerCountRow?.total ?? 0),
				last_sync_at: lastSyncRow?.last_sync_at ?? null,
				daemon_state: daemonStateValue,
				daemon_running: false,
				daemon_detail: null,
				project_filter_active: false,
				project_filter: { include: [], exclude: [] },
				redacted: !showDiag,
			};

			if (showDiag) {
				statusPayload.device_id = deviceRow?.device_id ?? null;
				statusPayload.fingerprint = deviceRow?.fingerprint ?? null;
				statusPayload.bind = null;
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
			const attemptRows = store.db
				.prepare(
					`SELECT peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out
					 FROM sync_attempts
					 ORDER BY finished_at DESC
					 LIMIT ?`,
				)
				.all(25) as Record<string, unknown>[];
			const attemptsItems = attemptRows.map((row) => ({
				...row,
				status: attemptStatus(row),
				address: null,
			}));

			const statusBlock = {
				...statusPayload,
				peers: peersMap,
				pending: 0,
				sync: {},
				ping: {},
			};

			return c.json({
				...statusPayload,
				status: statusBlock,
				peers: peersItems,
				attempts: attemptsItems.slice(0, 5),
				legacy_devices: [],
				sharing_review: { unreviewed: 0 },
				coordinator: { enabled: false, configured: false },
				join_requests: [],
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
			const includeMerged = queryBool(c.req.query("includeMerged"));
			let rows: Record<string, unknown>[];
			if (includeMerged) {
				rows = store.db.prepare("SELECT * FROM actors ORDER BY display_name").all() as Record<
					string,
					unknown
				>[];
			} else {
				rows = store.db
					.prepare("SELECT * FROM actors WHERE status != 'merged' ORDER BY display_name")
					.all() as Record<string, unknown>[];
			}
			return c.json({ items: rows });
		}
	});

	// GET /api/sync/attempts
	app.get("/api/sync/attempts", (c) => {
		const store = getStore();
		{
			let limit = queryInt(c.req.query("limit"), 25);
			if (limit <= 0) return c.json({ error: "invalid_limit" }, 400);
			limit = Math.min(limit, 500);
			const rows = store.db
				.prepare(
					`SELECT peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out
					 FROM sync_attempts
					 ORDER BY finished_at DESC
					 LIMIT ?`,
				)
				.all(limit) as Record<string, unknown>[];
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
			// Read device identity from sync_device table (fix from core)
			const deviceRow = store.db
				.prepare("SELECT device_id, public_key, fingerprint FROM sync_device LIMIT 1")
				.get() as Record<string, unknown> | undefined;

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
					// Read the newly created public key
					const newRow = store.db
						.prepare("SELECT public_key FROM sync_device WHERE device_id = ?")
						.get(id) as { public_key: string } | undefined;
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
			const body = await c.req.json<Record<string, unknown>>();
			const peerDeviceId = String(body.peer_device_id ?? "").trim();
			const name = String(body.name ?? "").trim();
			if (!peerDeviceId) return c.json({ error: "peer_device_id required" }, 400);
			if (!name) return c.json({ error: "name required" }, 400);
			const exists = store.db
				.prepare("SELECT 1 FROM sync_peers WHERE peer_device_id = ?")
				.get(peerDeviceId);
			if (!exists) return c.json({ error: "peer not found" }, 404);
			store.db
				.prepare("UPDATE sync_peers SET name = ? WHERE peer_device_id = ?")
				.run(name, peerDeviceId);
			return c.json({ ok: true });
		}
	});

	// DELETE /api/sync/peers/:peer_device_id
	app.delete("/api/sync/peers/:peer_device_id", (c) => {
		const store = getStore();
		{
			const peerDeviceId = c.req.param("peer_device_id")?.trim();
			if (!peerDeviceId) return c.json({ error: "peer_device_id required" }, 400);
			const exists = store.db
				.prepare("SELECT 1 FROM sync_peers WHERE peer_device_id = ?")
				.get(peerDeviceId);
			if (!exists) return c.json({ error: "peer not found" }, 404);
			store.db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(peerDeviceId);
			return c.json({ ok: true });
		}
	});

	return app;
}
