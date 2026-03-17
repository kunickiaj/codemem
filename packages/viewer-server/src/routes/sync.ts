/**
 * Sync routes — port of codemem/viewer_routes/sync.py.
 *
 * GET routes:
 *   /api/sync/status   — device ID, peers, daemon state, attempts
 *   /api/sync/peers    — list peers with project scopes
 *   /api/sync/actors   — list actors
 *   /api/sync/attempts — recent sync attempts
 *   /api/sync/pairing  — pairing info (device ID, fingerprint)
 *
 * POST routes:
 *   /api/sync/now                   — trigger sync
 *   /api/sync/actors                — create actor
 *   /api/sync/actors/rename         — rename actor
 *   /api/sync/actors/merge          — merge actors
 *   /api/sync/invites/create        — create invite
 *   /api/sync/invites/import        — import invite
 *   /api/sync/join-requests/review  — review join request
 *   /api/sync/peers/scope           — set peer project filter
 *   /api/sync/peers/identity        — set peer identity
 *   /api/sync/legacy-devices/claim  — claim legacy devices
 *
 * DELETE routes:
 *   /api/sync/peers/:id — remove peer
 *
 * Many sync operations depend on Python-only runtime modules (sync daemon,
 * coordinator commands, identity management). Those are stubbed with 501.
 * Read-only operations that can use raw SQL are implemented.
 */

import { ensureDeviceIdentity, type MemoryStore } from "@codemem/core";
import { Hono } from "hono";
import type { ViewerVariables } from "../middleware.js";

const app = new Hono<{ Variables: ViewerVariables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function includeDiagnostics(c: { req: { query: (k: string) => string | undefined } }): boolean {
	return ["1", "true", "yes"].includes(c.req.query("includeDiagnostics") ?? "0");
}

function safeJsonList(raw: string | null | undefined): string[] {
	if (raw == null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// GET routes
// ---------------------------------------------------------------------------

// TODO: Full /api/sync/status requires: load_config(), effective_status(),
// coordinator.status_snapshot(), coordinator_list_join_requests_action(),
// claimable_legacy_device_ids(), sharing_review_summary()
// Python source: codemem/viewer_routes/sync.py lines 136-335
app.get("/api/sync/status", (c) => {
	const store = c.get("store") as MemoryStore;
	const diag = includeDiagnostics(c);

	const deviceRow = store.db
		.prepare("SELECT device_id, fingerprint FROM sync_device LIMIT 1")
		.get() as { device_id: string; fingerprint: string } | undefined;

	const peerCount =
		(store.db.prepare("SELECT COUNT(1) AS total FROM sync_peers").get() as { total: number })
			?.total ?? 0;

	const lastSync =
		(
			store.db.prepare("SELECT MAX(last_sync_at) AS last_sync_at FROM sync_peers").get() as
				| { last_sync_at: string | null }
				| undefined
		)?.last_sync_at ?? null;

	// Minimal status response — full daemon state requires ported config
	const statusPayload: Record<string, unknown> = {
		enabled: false,
		interval_s: 300,
		peer_count: peerCount,
		last_sync_at: lastSync,
		daemon_state: "stopped",
		daemon_running: false,
		daemon_detail: "TS viewer-server does not manage the sync daemon yet",
		project_filter_active: false,
		project_filter: { include: [], exclude: [] },
		redacted: !diag,
	};

	if (diag && deviceRow) {
		statusPayload.device_id = deviceRow.device_id;
		statusPayload.fingerprint = deviceRow.fingerprint;
	}

	// Build peers list
	const peerRows = store.db
		.prepare(
			`SELECT p.peer_device_id, p.name, p.pinned_fingerprint, p.addresses_json,
			        p.last_seen_at, p.last_sync_at, p.last_error,
			        p.projects_include_json, p.projects_exclude_json, p.claimed_local_actor,
			        p.actor_id, a.display_name AS actor_display_name
			 FROM sync_peers AS p
			 LEFT JOIN actors AS a ON a.actor_id = p.actor_id
			 ORDER BY name, peer_device_id`,
		)
		.all() as Array<Record<string, unknown>>;

	const peers = peerRows.map((row) => ({
		peer_device_id: row.peer_device_id,
		name: row.name,
		fingerprint: diag ? row.pinned_fingerprint : null,
		pinned: Boolean(row.pinned_fingerprint),
		addresses: [],
		last_seen_at: row.last_seen_at,
		last_sync_at: row.last_sync_at,
		last_error: diag ? row.last_error : null,
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
	}));

	// Build attempts list
	const attemptRows = store.db
		.prepare(
			`SELECT peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out
			 FROM sync_attempts ORDER BY finished_at DESC LIMIT 25`,
		)
		.all() as Array<Record<string, unknown>>;

	const attempts = attemptRows.slice(0, 5).map((row) => ({
		...row,
		status: row.ok ? "ok" : row.error ? "error" : "unknown",
		address: null,
	}));

	return c.json({
		...statusPayload,
		status: { ...statusPayload, peers: {}, pending: 0, sync: {}, ping: {} },
		peers,
		attempts,
		legacy_devices: [],
		sharing_review: { unreviewed: 0 },
		coordinator: { enabled: false, configured: false },
		join_requests: [],
	});
});

app.get("/api/sync/peers", (c) => {
	const store = c.get("store") as MemoryStore;
	const diag = includeDiagnostics(c);

	const rows = store.db
		.prepare(
			`SELECT p.peer_device_id, p.name, p.pinned_fingerprint, p.addresses_json,
			        p.last_seen_at, p.last_sync_at, p.last_error,
			        p.projects_include_json, p.projects_exclude_json, p.claimed_local_actor,
			        p.actor_id, a.display_name AS actor_display_name
			 FROM sync_peers AS p
			 LEFT JOIN actors AS a ON a.actor_id = p.actor_id
			 ORDER BY name, peer_device_id`,
		)
		.all() as Array<Record<string, unknown>>;

	const peers = rows.map((row) => ({
		peer_device_id: row.peer_device_id,
		name: row.name,
		fingerprint: diag ? row.pinned_fingerprint : null,
		pinned: Boolean(row.pinned_fingerprint),
		addresses: [],
		last_seen_at: row.last_seen_at,
		last_sync_at: row.last_sync_at,
		last_error: diag ? row.last_error : null,
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
	}));

	return c.json({ items: peers, redacted: !diag });
});

app.get("/api/sync/actors", (c) => {
	const store = c.get("store") as MemoryStore;
	const includeMerged = ["1", "true", "yes"].includes(c.req.query("includeMerged") ?? "0");

	let rows: Array<Record<string, unknown>>;
	if (includeMerged) {
		rows = store.db.prepare("SELECT * FROM actors ORDER BY display_name").all() as Array<
			Record<string, unknown>
		>;
	} else {
		rows = store.db
			.prepare("SELECT * FROM actors WHERE status != 'merged' ORDER BY display_name")
			.all() as Array<Record<string, unknown>>;
	}

	return c.json({ items: rows });
});

app.get("/api/sync/attempts", (c) => {
	const store = c.get("store") as MemoryStore;
	const limitRaw = c.req.query("limit") ?? "25";
	const limit = Number.parseInt(limitRaw, 10);
	if (Number.isNaN(limit) || limit <= 0) {
		return c.json({ error: "invalid_limit" }, 400);
	}
	const clampedLimit = Math.min(limit, 500);

	const rows = store.db
		.prepare(
			`SELECT peer_device_id, ok, error, started_at, finished_at, ops_in, ops_out
			 FROM sync_attempts ORDER BY finished_at DESC LIMIT ?`,
		)
		.all(clampedLimit) as Array<Record<string, unknown>>;

	return c.json({ items: rows });
});

// TODO: Port pairing info (device identity, public key, advertise hosts)
// Python source: codemem/viewer_routes/sync.py lines 426-469
app.get("/api/sync/pairing", (c) => {
	const store = c.get("store") as MemoryStore;
	const diag = includeDiagnostics(c);

	if (!diag) {
		return c.json({
			redacted: true,
			pairing_filter_hint:
				"Run this on another device with codemem sync pair --accept '<payload>'.",
		});
	}

	// Ensure device identity exists — creates keys + DB row if missing
	// (matches Python's behavior which calls ensure_device_identity on this route)
	let deviceId: string;
	let fingerprint: string;
	let publicKey: string;
	try {
		[deviceId, fingerprint] = ensureDeviceIdentity(store.db);
		const deviceRow = store.db
			.prepare("SELECT public_key FROM sync_device WHERE device_id = ?")
			.get(deviceId) as { public_key: string } | undefined;
		publicKey = deviceRow?.public_key ?? "";
	} catch (err) {
		const msg = err instanceof Error ? err.message : "unknown";
		return c.json({ error: `device identity initialization failed: ${msg}` }, 500);
	}

	return c.json({
		device_id: deviceId,
		fingerprint,
		public_key: publicKey,
		pairing_filter_hint: "Run this on another device with codemem sync pair --accept '<payload>'.",
		addresses: [],
	});
});

// ---------------------------------------------------------------------------
// POST routes
// ---------------------------------------------------------------------------

// TODO: Port sync_once() to TS
// Python source: codemem/viewer_routes/sync.py lines 717-749
app.post("/api/sync/actions/sync-now", (c) => {
	return c.json({ error: "not yet implemented" }, 501);
});

// Compatibility alias
app.post("/api/sync/run", (c) => {
	return c.json({ error: "not yet implemented" }, 501);
});

app.post("/api/sync/actors", async (c) => {
	const _store = c.get("store") as MemoryStore;
	let payload: Record<string, unknown>;
	try {
		payload = await c.req.json();
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}

	const displayName = payload.display_name;
	const actorId = payload.actor_id ?? null;

	if (typeof displayName !== "string" || !displayName.trim()) {
		return c.json({ error: "display_name required" }, 400);
	}
	if (actorId !== null && typeof actorId !== "string") {
		return c.json({ error: "actor_id must be string or null" }, 400);
	}

	// TODO: Port store.create_actor() to TS store
	// Python source: codemem/viewer_routes/sync.py lines 484-502
	return c.json({ error: "not yet implemented" }, 501);
});

app.post("/api/sync/actors/rename", async (c) => {
	// TODO: Port store.rename_actor() to TS store
	// Python source: codemem/viewer_routes/sync.py lines 504-525
	return c.json({ error: "not yet implemented" }, 501);
});

app.post("/api/sync/actors/merge", async (c) => {
	// TODO: Port store.merge_actor() to TS store
	// Python source: codemem/viewer_routes/sync.py lines 527-551
	return c.json({ error: "not yet implemented" }, 501);
});

app.post("/api/sync/peers/rename", async (c) => {
	const store = c.get("store") as MemoryStore;
	let payload: Record<string, unknown>;
	try {
		payload = await c.req.json();
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}

	const peerDeviceId = payload.peer_device_id;
	const name = payload.name;
	if (typeof peerDeviceId !== "string" || !peerDeviceId) {
		return c.json({ error: "peer_device_id required" }, 400);
	}
	if (typeof name !== "string" || !name.trim()) {
		return c.json({ error: "name required" }, 400);
	}

	const row = store.db
		.prepare("SELECT 1 FROM sync_peers WHERE peer_device_id = ?")
		.get(peerDeviceId);
	if (!row) {
		return c.json({ error: "peer not found" }, 404);
	}

	store.db
		.prepare("UPDATE sync_peers SET name = ? WHERE peer_device_id = ?")
		.run(name.trim(), peerDeviceId);

	return c.json({ ok: true });
});

app.post("/api/sync/peers/scope", async (c) => {
	// TODO: Port set_peer_project_filter() and _effective_sync_project_filters()
	// Python source: codemem/viewer_routes/sync.py lines 580-647
	return c.json({ error: "not yet implemented" }, 501);
});

app.post("/api/sync/peers/identity", async (c) => {
	// TODO: Port assign_peer_actor() to TS store
	// Python source: codemem/viewer_routes/sync.py lines 649-694
	return c.json({ error: "not yet implemented" }, 501);
});

app.post("/api/sync/legacy-devices/claim", async (c) => {
	// TODO: Port claim_legacy_device_id_as_self() to TS store
	// Python source: codemem/viewer_routes/sync.py lines 696-715
	return c.json({ error: "not yet implemented" }, 501);
});

app.post("/api/sync/invites/create", async (c) => {
	// TODO: Port coordinator_create_invite_action()
	// Python source: codemem/viewer_routes/sync.py lines 751-794
	return c.json({ error: "not yet implemented" }, 501);
});

app.post("/api/sync/invites/import", async (c) => {
	// TODO: Port coordinator_import_invite_action()
	// Python source: codemem/viewer_routes/sync.py lines 796-815
	return c.json({ error: "not yet implemented" }, 501);
});

app.post("/api/sync/join-requests/review", async (c) => {
	// TODO: Port coordinator_review_join_request_action()
	// Python source: codemem/viewer_routes/sync.py lines 817-850
	return c.json({ error: "not yet implemented" }, 501);
});

// ---------------------------------------------------------------------------
// DELETE routes
// ---------------------------------------------------------------------------

app.delete("/api/sync/peers/:peer_device_id", (c) => {
	const store = c.get("store") as MemoryStore;
	const peerDeviceId = c.req.param("peer_device_id");
	if (!peerDeviceId) {
		return c.json({ error: "peer_device_id required" }, 400);
	}

	const row = store.db
		.prepare("SELECT 1 FROM sync_peers WHERE peer_device_id = ?")
		.get(peerDeviceId);
	if (!row) {
		return c.json({ error: "peer not found" }, 404);
	}

	store.db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(peerDeviceId);
	return c.json({ ok: true });
});

export default app;
