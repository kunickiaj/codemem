import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDirectPeerAuthHeaders,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	initTestSchema,
	loadPublicKey,
	MemoryStore,
	readPairingInstanceId,
	removePairingState,
	removePeerFromThisDevice,
	SYNC_CAPABILITY_HEADER,
	setSyncResetState,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTestScopeRows } from "../../core/src/scope-membership-cache-test-fixtures.js";
import { syncProtocolRoutes } from "./routes/sync.js";

const COORDINATOR_URL = "https://coord.example.test";
const NOW = "2026-10-07T00:00:00.000Z";
/** Both devices are proven members of this coordinator scope. */
const SHARED_SCOPE = "shared-work";
/** This device is a proven member, and the peer is not a member at all. */
const NOT_SHARED_SCOPE = "not-shared-work";
const UNMANAGED_SCOPES = [
	["manual", "manual-work"],
	["invite", "invite-work"],
] as const;

let directory: string;
let store: MemoryStore;
let localId: string;
let localKey: string;
let peer: { deviceId: string; keysDir: string; publicKey: string };
let app: ReturnType<typeof syncProtocolRoutes>;

function createPeer() {
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		const keysDir = join(directory, "peer-keys");
		const [deviceId] = ensureDeviceIdentity(db, { keysDir });
		const publicKey = loadPublicKey(keysDir);
		if (!publicKey) throw new Error("Missing peer fixture key");
		return { deviceId, keysDir, publicKey };
	} finally {
		db.close();
	}
}

function pinPeer() {
	store.db
		.prepare(
			"INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(peer.deviceId, peer.publicKey, fingerprintPublicKey(peer.publicKey), NOW);
}

function seedScope(
	scopeId: string,
	authorityType: string,
	members: string[],
	group: string | null = "group-1",
) {
	store.db
		.prepare(
			`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at) VALUES (?, ?, 'team', ?, ?, ?, 1, 'active', ?, ?)`,
		)
		.run(scopeId, scopeId, authorityType, group && COORDINATOR_URL, group, NOW, NOW);
	for (const deviceId of members) {
		store.db
			.prepare(
				"INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at) VALUES (?, ?, 'member', 'active', 1, ?)",
			)
			.run(scopeId, deviceId, NOW);
	}
	setSyncResetState(
		store.db,
		{ generation: 1, snapshot_id: "snapshot-1", baseline_cursor: null },
		scopeId,
	);
	// A record the peer created earlier, which an update would target.
	const sessionId = store.db
		.prepare(
			"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, '/tmp/fixture', 'fixture', 'test', 'test')",
		)
		.run(NOW).lastInsertRowid;
	store.db
		.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text, created_at,
			 updated_at, metadata_json, import_key, origin_device_id, rev, visibility, scope_id, active)
			 VALUES (?, 'discovery', ?, 'Existing body', 0.5, '', ?, ?, ?, ?, ?, 1, 'shared', ?, 1)`,
		)
		.run(
			sessionId,
			`${scopeId}-existing`,
			NOW,
			NOW,
			JSON.stringify({ scope_id: scopeId }),
			`${scopeId}-existing`,
			peer.deviceId,
			scopeId,
		);
}

/** The coordinator's answer, which never covers manual or invite scopes. */
function refresh() {
	return refreshTestScopeRows(store.db, { [localId]: localKey, [peer.deviceId]: peer.publicKey });
}

function memoryOp(scopeId: string, entityId: string, rev: number) {
	return {
		op_id: `${entityId}-rev-${rev}`,
		entity_type: "memory_item",
		entity_id: entityId,
		op_type: "upsert",
		payload_json: JSON.stringify({
			body_text: "Peer content",
			created_at: NOW,
			kind: "discovery",
			scope_id: scopeId,
			title: entityId,
			updated_at: NOW,
			visibility: "shared",
			origin_device_id: peer.deviceId,
		}),
		clock_rev: rev,
		clock_updated_at: NOW,
		clock_device_id: peer.deviceId,
		device_id: peer.deviceId,
		created_at: NOW,
		scope_id: scopeId,
	};
}

async function request(
	path: string,
	options: { body?: Record<string, unknown>; bootstrapGrantId?: string } = {},
) {
	const url = `http://localhost${path}`;
	const method = options.body ? "POST" : "GET";
	const body = options.body && JSON.stringify(options.body);
	const headers = buildDirectPeerAuthHeaders({
		deviceId: peer.deviceId,
		recipientId: localId,
		method,
		url,
		bodyBytes: body ? Buffer.from(body) : Buffer.alloc(0),
		keysDir: peer.keysDir,
		bootstrapGrantId: options.bootstrapGrantId,
	});
	headers[SYNC_CAPABILITY_HEADER] = "scoped";
	headers["Content-Type"] = "application/json";
	const response = await app.request(url, { method, headers, body });
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Every read and write a peer can attempt for one scope. */
async function scopeRequests(scopeId: string) {
	const boundary = `generation=1&snapshot_id=snapshot-1&scope_id=${scopeId}`;
	return {
		snapshot: await request(`/v1/snapshot?${boundary}`),
		pull: await request(`/v1/ops?limit=10&${boundary}`),
		scopedPush: await request("/v1/ops", {
			body: {
				sync_capability: "scoped",
				scope_id: scopeId,
				ops: [memoryOp(scopeId, `${scopeId}-scoped`, 1)],
			},
		}),
		legacyNewRecord: await request("/v1/ops", {
			body: { sync_capability: "unsupported", ops: [memoryOp(scopeId, `${scopeId}-new`, 1)] },
		}),
		legacyUpdate: await request("/v1/ops", {
			body: {
				sync_capability: "unsupported",
				ops: [memoryOp(scopeId, `${scopeId}-existing`, 2)],
			},
		}),
	};
}

/** Responses with the scope ID replaced, so two scopes' answers can be compared. */
function withoutScopeId(responses: Awaited<ReturnType<typeof scopeRequests>>, scopeId: string) {
	return JSON.parse(JSON.stringify(responses).replaceAll(scopeId, "<scope>"));
}

function contentState() {
	return {
		memories: store.db.prepare("SELECT * FROM memory_items ORDER BY id").all(),
		operations: store.db.prepare("SELECT * FROM replication_ops ORDER BY op_id").all(),
	};
}

async function authorizedScopeIds() {
	const status = await request("/v1/status");
	expect(status.status).toBe(200);
	for (const [, scopeId] of UNMANAGED_SCOPES)
		expect(JSON.stringify(status.body)).not.toContain(scopeId);
	return (status.body.authorized_scopes as Array<{ scope_id: string }>).map(
		(scope) => scope.scope_id,
	);
}

/** Each manual or invite scope gets exactly the answers the peer gets for a scope it is not in. */
async function expectUnmanagedScopesRefused() {
	const before = contentState();
	const unauthorized = withoutScopeId(await scopeRequests(NOT_SHARED_SCOPE), NOT_SHARED_SCOPE);
	for (const [, scopeId] of UNMANAGED_SCOPES) {
		const responses = await scopeRequests(scopeId);
		expect(withoutScopeId(responses, scopeId)).toEqual(unauthorized);
		for (const response of Object.values(responses))
			expect(response).toMatchObject({ status: 409, body: { reason: "missing_scope" } });
	}
	expect(contentState()).toEqual(before);
}

/** The peer's grant for group g1, as the coordinator returns it. */
function bootstrapReceipt() {
	const enrollment = (deviceId: string, publicKey: string) => ({
		group_id: "g1",
		device_id: deviceId,
		public_key: publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		enabled: 1,
		identity_id: null,
		display_name: deviceId,
		created_at: "2026-01-01T00:00:00Z",
	});
	return {
		authorization_version: 1,
		grant: {
			grant_id: "grant-1",
			group_id: "g1",
			seed_device_id: localId,
			worker_device_id: peer.deviceId,
			expires_at: "2099-01-01T00:00:00Z",
			created_at: "2026-01-01T00:00:00Z",
			created_by: "admin",
			revoked_at: null,
		},
		seed_enrollment: enrollment(localId, localKey),
		worker_enrollment: enrollment(peer.deviceId, peer.publicKey),
	};
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(NOW));
	directory = mkdtempSync(join(tmpdir(), "codemem-unmanaged-scope-"));
	const keysDir = join(directory, "keys");
	const config = join(directory, "config.json");
	writeFileSync(
		config,
		JSON.stringify({ sync_coordinator_url: COORDINATOR_URL, sync_coordinator_groups: ["g1"] }),
	);
	vi.stubEnv("CODEMEM_CONFIG", config);
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", undefined);
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", undefined);
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network call");
		}),
	);
	store = new MemoryStore(join(directory, "store.sqlite"));
	[localId] = ensureDeviceIdentity(store.db, { keysDir });
	localKey = loadPublicKey(keysDir) ?? "";
	peer = createPeer();
	pinPeer();
	seedScope(SHARED_SCOPE, "coordinator", [localId, peer.deviceId]);
	seedScope(NOT_SHARED_SCOPE, "coordinator", [localId]);
	for (const [authorityType, scopeId] of UNMANAGED_SCOPES)
		seedScope(scopeId, authorityType, [localId, peer.deviceId], null);
	await refresh();
	app = syncProtocolRoutes(() => store);
});

afterEach(() => {
	store.close();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

describe("manual and invite scopes never authorize another device", () => {
	it("refuses a paired member everything in them, as for a scope it is not in", async () => {
		expect(await authorizedScopeIds()).toEqual([SHARED_SCOPE]);
		await expectUnmanagedScopesRefused();
	});

	it("keeps refusing a removed device that recreated its pairing through another group's grant, also after a refresh", async () => {
		// Arrange: Remove ends the pairing and retained proofs, but leaves membership rows.
		removePairingState(store.db, {
			localDeviceId: localId,
			reason: "removed",
			deviceIds: [peer.deviceId],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(bootstrapReceipt()), { status: 200 })),
		);

		// Act: the grant for group g1 recreates the pairing.
		const bootstrap = await request("/v1/status", { bootstrapGrantId: "grant-1" });

		// Assert
		expect(bootstrap.status).toBe(200);
		expect(
			store.db
				.prepare("SELECT COUNT(*) FROM sync_peers WHERE peer_device_id = ?")
				.pluck()
				.get(peer.deviceId),
		).toBe(1);
		// The recreated pin names no group, so only the history shows that a coordinator vouched for it.
		expect(
			store.db
				.prepare(`SELECT source FROM coordinator_history
				 WHERE subject_kind = 'device' AND device_id = ? AND fingerprint = ?`)
				.pluck()
				.get(peer.deviceId, fingerprintPublicKey(peer.publicKey)),
		).toBe("bootstrap_grant");
		expect(store.db.prepare("SELECT state FROM coordinator_free_attestation").pluck().get()).toBe(
			"managed",
		);
		expect(await authorizedScopeIds()).toEqual([]);
		await expectUnmanagedScopesRefused();

		// Act: the coordinator still grants the device its coordinator scope.
		await refresh();

		// Assert: the coordinator scope comes back, and manual and invite scopes stay refused.
		expect(await authorizedScopeIds()).toEqual([SHARED_SCOPE]);
		await expectUnmanagedScopesRefused();
	});
});

describe("a device unpaired here", () => {
	it("is paired again by a valid bootstrap grant, as the Unpair confirmation says, and keeps its coordinator Project at once", async () => {
		// Arrange: Unpair deletes the pairing but, unlike Remove, keeps the cached membership.
		const firstPairing = readPairingInstanceId(store.db, peer.deviceId);
		removePeerFromThisDevice(store.db, { localDeviceId: localId, peerDeviceId: peer.deviceId });
		expect(
			store.db
				.prepare("SELECT COUNT(*) FROM sync_peers WHERE peer_device_id = ?")
				.pluck()
				.get(peer.deviceId),
		).toBe(0);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(bootstrapReceipt()), { status: 200 })),
		);

		// Act: the grant for group g1 creates the pairing again.
		const bootstrap = await request("/v1/status", { bootstrapGrantId: "grant-1" });

		// Assert
		expect(bootstrap.status).toBe(200);
		expect(
			store.db
				.prepare("SELECT COUNT(*) FROM sync_peers WHERE peer_device_id = ?")
				.pluck()
				.get(peer.deviceId),
		).toBe(1);
		// A new pairing, so a pass that started before Unpair cannot save progress into it.
		expect(readPairingInstanceId(store.db, peer.deviceId)).not.toBe(firstPairing);
		expect(await authorizedScopeIds()).toEqual([SHARED_SCOPE]);
		await expectUnmanagedScopesRefused();
	});
});

/** A memory this device created, stored in a scope that never syncs. */
function holdLocalRow(scopeId: string, importKey: string) {
	if (scopeId !== "local-default")
		store.db
			.prepare(
				`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, membership_epoch,
				 status, created_at, updated_at) VALUES (?, ?, 'user', 'local', 1, 'active', ?, ?)`,
			)
			.run(scopeId, scopeId, NOW, NOW);
	const sessionId = store.db
		.prepare("INSERT INTO sessions(started_at, project) VALUES (?, 'fixture')")
		.run(NOW).lastInsertRowid;
	store.db
		.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text, created_at,
			 updated_at, metadata_json, import_key, origin_device_id, rev, visibility, scope_id, active)
			 VALUES (?, 'discovery', 'Local', 'Local body', 0.5, '', ?, ?, '{}', ?, ?, 1, 'shared', ?, 1)`,
		)
		.run(sessionId, NOW, NOW, importKey, localId, scopeId);
}

describe("a push naming a key stored here in a scope that never syncs", () => {
	it.each(["local-notes", "local-default"])(
		"is refused without naming the %s scope",
		async (scopeId) => {
			holdLocalRow(scopeId, "local-key");
			const before = contentState();

			const response = await request("/v1/ops", {
				body: { sync_capability: "scoped", ops: [memoryOp(SHARED_SCOPE, "local-key", 2)] },
			});

			expect(response).toMatchObject({ status: 200, body: { applied: 0, rejected: 1 } });
			expect(response.body.rejections).toEqual([
				expect.objectContaining({ reason: "sender_not_member", scope_id: SHARED_SCOPE }),
			]);
			expect(JSON.stringify(response.body)).not.toContain(scopeId);
			expect(contentState()).toEqual(before);
		},
	);
});
