import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDirectPeerAuthHeaders,
	connect,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	getReplicationCursor,
	initTestSchema,
	LOCAL_SYNC_CAPABILITY,
	loadPublicKey,
	MemoryStore,
	SYNC_CAPABILITY_HEADER,
	setSyncResetState,
	syncOnce,
} from "@codemem/core";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OwnedPeerHttpConnection } from "../../core/src/peer-http-client.js";
import { servePeerHttpConnection } from "../../core/src/peer-http-server.js";
import { syncCoordinatorFreeChannelOnce } from "../../core/src/sync-channel-pass.js";
import { updatePeerAddresses } from "../../core/src/sync-peer-addresses.js";
import { createSyncApp } from "./index.js";
import {
	createSyncChannelDispatcher,
	type SyncChannelRequest,
	type SyncChannelResponse,
} from "./sync-channel-dispatch.js";
import { openNoisePair } from "./sync-channel-pass-test-fixtures.js";

const ORIGIN = "https://peer.invalid";
const CURSOR_SCOPE = "coordinator-free-lane";

let directory: string;
const cleanups: (() => unknown)[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-coordinator-free-lane-"));
	writeFileSync(join(directory, "config.json"), "{}");
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

/** A device with its own store and keys, and no coordinator anywhere. */
function device(name: string) {
	const keysDir = join(directory, `${name}-keys`);
	const dbPath = join(directory, `${name}.sqlite`);
	const db = connect(dbPath);
	initTestSchema(db);
	const [deviceId] = ensureDeviceIdentity(db, { keysDir });
	db.close();
	const publicKey = loadPublicKey(keysDir) ?? "";
	const store = new MemoryStore(dbPath);
	cleanups.push(() => store.close());
	const pin = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
	return { name, store, keysDir, dbPath, deviceId, publicKey, pin };
}

type Device = ReturnType<typeof device>;

/** What `sync pair --accept` saves on each side. */
function pair(a: Device, b: Device) {
	for (const [self, other] of [
		[a, b],
		[b, a],
	] as const)
		updatePeerAddresses(self.store.db, other.deviceId, ["127.0.0.1:7337"], {
			pinnedFingerprint: fingerprintPublicKey(other.publicKey),
			publicKey: other.publicKey,
			replaceTrust: true,
		});
}

function remember(d: Device, title: string, visibility?: "private" | "shared") {
	const session = d.store.startSession({ cwd: directory, project: "lane" });
	return d.store.remember(session, "discovery", title, `${title} body`, 0.5, [], {
		...(visibility ? { visibility } : {}),
	});
}

function titles(d: Device) {
	return d.store.db.prepare("SELECT title FROM memory_items ORDER BY title").pluck().all();
}

type Intercept = (request: SyncChannelRequest) => SyncChannelResponse | null;

/** The client side of a direct Noise channel to `server`, as the sync listener admits it. */
function channelTo(server: Device, client: Device, intercept?: Intercept) {
	const dispatch = createSyncChannelDispatcher({
		storeFactory: () => server.store,
		mode: "noise-direct",
	});
	return {
		async open() {
			const pair = await openNoisePair({
				clientKeysDir: client.keysDir,
				clientPin: client.pin,
				serverKeysDir: server.keysDir,
				serverPin: server.pin,
			});
			cleanups.push(() => pair.close());
			void servePeerHttpConnection(pair.targetOwner, {
				origin: ORIGIN,
				async dispatch(request) {
					const intercepted = intercept?.(request);
					if (intercepted) return intercepted;
					vi.stubEnv("CODEMEM_KEYS_DIR", server.keysDir);
					return dispatch({ ...request, peerDeviceId: client.deviceId });
				},
			}).catch(() => {});
			return pair.sourceOwner as OwnedPeerHttpConnection;
		},
	};
}

function exchange(server: Device, client: Device, intercept?: Intercept) {
	return syncCoordinatorFreeChannelOnce({
		db: client.store.db,
		peerDeviceId: server.deviceId,
		logicalOrigin: ORIGIN,
		factory: channelTo(server, client, intercept),
		keysDir: client.keysDir,
		dbPath: client.dbPath,
		scanner: client.store.scanner,
	});
}

it("syncs shared memories both ways over the authenticated channel, never private ones", async () => {
	const server = device("server");
	const client = device("client");
	pair(server, client);
	remember(server, "server default");
	remember(server, "server shared", "shared");
	remember(server, "server private", "private");
	remember(client, "client shared", "shared");

	const first = await exchange(server, client);
	const second = await exchange(server, client);

	expect(first).toMatchObject({ ok: true, opsIn: 2, opsOut: 1 });
	expect(second).toMatchObject({ ok: true, opsIn: 0, opsOut: 0 });
	expect(titles(client)).toEqual(["client shared", "server default", "server shared"]);
	expect(titles(server)).toEqual([
		"client shared",
		"server default",
		"server private",
		"server shared",
	]);
	const replicas = (d: Device) =>
		d.store.db.prepare("SELECT peer_device_id FROM coordinator_free_replicas").pluck().all();
	expect(replicas(client)).toEqual([server.deviceId, server.deviceId]);
	expect(replicas(server)).toEqual([client.deviceId]);
});

it("moves nothing when the other device doesn't consider this one eligible", async () => {
	const server = device("server");
	const client = device("client");
	pair(server, client);
	// The server no longer has an explicit pairing with the client.
	server.store.db.prepare("UPDATE sync_peers SET explicit_pairing_fingerprint = NULL").run();
	remember(server, "server shared", "shared");
	remember(client, "client shared", "shared");

	const result = await exchange(server, client);

	expect(result).toMatchObject({ ok: true, opsIn: 0, opsOut: 0 });
	expect(titles(client)).toEqual(["client shared"]);
	expect(titles(server)).toEqual(["server shared"]);
});

it("records that recovery is unavailable and keeps its cursor when the peer can't continue", async () => {
	const server = device("server");
	const client = device("client");
	pair(server, client);
	remember(server, "before", "shared");
	await exchange(server, client);
	const cursor = getReplicationCursor(client.store.db, server.deviceId, CURSOR_SCOPE);
	setSyncResetState(server.store.db, { retained_floor_cursor: "9999-12-31T00:00:00Z|z" });
	remember(server, "after", "shared");

	const result = await exchange(server, client);

	expect(result).toMatchObject({ ok: false, error: "coordinator_free_recovery_unavailable" });
	expect(getReplicationCursor(client.store.db, server.deviceId, CURSOR_SCOPE)).toEqual(cursor);
	expect(titles(client)).toEqual(["before"]);
	expect(
		client.store.db
			.prepare("SELECT error FROM sync_attempts WHERE peer_device_id = ?")
			.pluck()
			.all(server.deviceId),
	).toEqual(["coordinator_free_recovery_unavailable"]);
});

it("carries nothing over plain HTTP, even between explicitly paired devices", async () => {
	const server = device("server");
	const client = device("client");
	pair(server, client);
	remember(server, "server shared", "shared");
	vi.stubEnv("CODEMEM_KEYS_DIR", server.keysDir);
	const url = await new Promise<string>((resolve) => {
		const listener = serve(
			{
				fetch: createSyncApp({ storeFactory: () => server.store }).fetch,
				hostname: "127.0.0.1",
				port: 0,
			},
			(info) => resolve(`http://127.0.0.1:${info.port}`),
		);
		cleanups.push(() => new Promise<void>((done) => listener.close(() => done())));
	});

	const result = await syncOnce(client.store.db, server.deviceId, [url], {
		keysDir: client.keysDir,
		scanner: client.store.scanner,
	});

	expect(result).toMatchObject({ ok: true });
	expect(titles(client)).toEqual([]);
});

/** One request from `client` as the server's channel dispatcher receives it. */
async function laneRequest(
	server: Device,
	client: Device,
	method: "GET" | "POST",
	target: string,
	body?: unknown,
) {
	const bodyBytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
	const url = ORIGIN + target;
	vi.stubEnv("CODEMEM_KEYS_DIR", server.keysDir);
	const response = await createSyncChannelDispatcher({
		storeFactory: () => server.store,
		mode: "noise-direct",
	})({
		peerDeviceId: client.deviceId,
		method,
		target,
		url,
		bodyBytes,
		peerPin: client.pin,
		signal: new AbortController().signal,
		headers: {
			...buildDirectPeerAuthHeaders({
				deviceId: client.deviceId,
				recipientId: server.deviceId,
				method,
				url,
				bodyBytes,
				keysDir: client.keysDir,
			}),
			[SYNC_CAPABILITY_HEADER]: LOCAL_SYNC_CAPABILITY,
			"Content-Type": "application/json",
		},
	});
	return {
		status: response.status,
		body: JSON.parse(new TextDecoder().decode(response.bodyBytes)) as Record<string, unknown>,
	};
}

/** A shared upsert as `from` would send it for a memory it created. */
function upsert(from: Device, entityId: string, payload: Record<string, unknown> = {}) {
	const now = new Date().toISOString();
	return {
		op_id: `${entityId}-op`,
		entity_type: "memory_item",
		entity_id: entityId,
		op_type: "upsert",
		payload_json: JSON.stringify({
			kind: "discovery",
			title: entityId,
			body_text: "body",
			created_at: now,
			updated_at: now,
			project: "lane",
			visibility: "shared",
			scope_id: "local-default",
			origin_device_id: from.deviceId,
			...payload,
		}),
		clock_rev: 1,
		clock_updated_at: now,
		clock_device_id: from.deviceId,
		device_id: from.deviceId,
		created_at: now,
		scope_id: "local-default",
	};
}

const LANE_OPS = "/v1/ops?lane=coordinator_free_v1";

it("refuses a pushed batch with any op the sender may not send, and applies none of it", async () => {
	const server = device("server");
	const client = device("client");
	pair(server, client);

	const forged = await laneRequest(server, client, "POST", LANE_OPS, {
		ops: [
			upsert(client, "ok"),
			upsert(client, "for-server", { origin_device_id: server.deviceId }),
		],
	});
	const hidden = await laneRequest(server, client, "POST", LANE_OPS, {
		ops: [upsert(client, "ok"), upsert(client, "private", { visibility: "private" })],
	});
	const malformed = await laneRequest(server, client, "POST", LANE_OPS, {
		ops: [upsert(client, "ok"), { op_id: "broken" }],
	});
	const otherDevice = await laneRequest(server, client, "POST", LANE_OPS, {
		ops: [upsert(server, "relayed")],
	});

	expect(forged).toMatchObject({ status: 200, body: { applied: 0, rejected: 1 } });
	expect(hidden).toMatchObject({ status: 200, body: { applied: 0, rejected: 1 } });
	expect(malformed).toMatchObject({ status: 400, body: { error: "invalid_ops" } });
	expect(otherDevice).toMatchObject({ status: 400, body: { error: "invalid_op_device" } });
	expect(titles(server)).toEqual([]);
});

it("serves no ops to a peer the server doesn't consider eligible", async () => {
	const server = device("server");
	const client = device("client");
	pair(server, client);
	remember(server, "server shared", "shared");
	server.store.db.prepare("UPDATE sync_peers SET explicit_pairing_fingerprint = NULL").run();

	const status = await laneRequest(server, client, "GET", "/v1/status?lane=coordinator_free_v1");
	const pulled = await laneRequest(server, client, "GET", `${LANE_OPS}&generation=1&snapshot_id=x`);

	expect(status).toMatchObject({ status: 200, body: { coordinator_free: { consent: false } } });
	expect(pulled).toMatchObject({ status: 403, body: { error: "coordinator_free_not_allowed" } });
});

it("decides each push request again, so a memory made private while a batch is in flight stays here", async () => {
	const server = device("server");
	const client = device("client");
	pair(server, client);
	remember(client, "first", "shared");
	const second = remember(client, "second", "shared");
	let refused = false;
	// The first push is answered as too large, so the client splits it and sends each half.
	// While that answer is in flight, the second memory is made private.
	const intercept: Intercept = (request) => {
		if (refused || request.method !== "POST") return null;
		refused = true;
		client.store.db
			.prepare("UPDATE memory_items SET visibility = 'private' WHERE id = ?")
			.run(second);
		return {
			status: 413,
			headers: { "content-type": "application/json" },
			bodyBytes: new TextEncoder().encode(JSON.stringify({ error: "payload_too_large" })),
		};
	};

	const result = await exchange(server, client, intercept);

	expect(refused).toBe(true);
	expect(result).toMatchObject({ ok: true });
	expect(titles(server)).toEqual(["first"]);
});

it("pushes the stored copy's current content, not the payload the op recorded", async () => {
	const server = device("server");
	const client = device("client");
	pair(server, client);
	const edited = remember(client, "recorded title", "shared");
	client.store.db
		.prepare("UPDATE memory_items SET title = 'current title' WHERE id = ?")
		.run(edited);

	await exchange(server, client);

	expect(titles(server)).toEqual(["current title"]);
});
