import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDirectPeerAuthHeaders,
	connect,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	initTestSchema,
	loadPublicKey,
	MemoryStore,
	recordSyncTransferObservation,
	recordSyncTransferReceipts,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerSyncHealth } from "./application/sync-health.js";
import { syncProtocolRoutes, syncRoutes } from "./routes/sync.js";

const now = new Date("2026-11-02T12:00:00.000Z");
const recent = new Date("2026-11-02T11:59:00.000Z");
const endpoints = ["/api/sync/status", "/api/sync/peers"] as const;
let directory: string;
let store: MemoryStore;

interface HealthPayload {
	sync_health: { state: string; peer_count: number };
	status: { sync_health: { state: string; peer_count: number } };
	peers?: Array<{ peer_device_id: string; sync_health: PeerSyncHealth }>;
	items?: Array<{ peer_device_id: string; sync_health: PeerSyncHealth }>;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	directory = mkdtempSync(join(tmpdir(), "codemem-transfer-health-"));
	const config = join(directory, "config.json");
	writeFileSync(config, JSON.stringify({ sync_enabled: true }));
	vi.stubEnv("CODEMEM_CONFIG", config);
	vi.stubEnv("CODEMEM_SYNC_ENABLED", "1");
	vi.stubEnv("CODEMEM_SYNC_INTERVAL_S", "120");
	vi.stubEnv("CODEMEM_KEYS_DIR", join(directory, "keys"));
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_URL", "");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", "");
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUP", "");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network request");
		}),
	);
	const path = join(directory, "memory.sqlite");
	const db = connect(path);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(path);
});

afterEach(() => {
	store?.close();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

function seedPeer(id: string) {
	store.db
		.prepare(`INSERT INTO sync_peers
			(peer_device_id, name, pinned_fingerprint, created_at, last_seen_at, last_sync_at)
			VALUES (?, ?, ?, ?, ?, ?)`)
		.run(
			id,
			id,
			`fingerprint-${id}`,
			recent.toISOString(),
			recent.toISOString(),
			recent.toISOString(),
		);
}

function seedAttempt(id: string, options: { ok: boolean; at?: Date }) {
	const at = (options.at ?? recent).toISOString();
	store.db
		.prepare(`INSERT INTO sync_attempts
			(peer_device_id, started_at, finished_at, ok, ops_in, ops_out, error)
			VALUES (?, ?, ?, ?, 123, 456, ?)`)
		.run(id, at, at, Number(options.ok), options.ok ? null : "Connection to example.test failed");
}

function seedExchange(id: string, at = recent) {
	for (const direction of ["send", "receive"] as const) {
		recordSyncTransferObservation(store.db, id, direction, { now: at });
	}
}

function signedInboundFixture() {
	const [localId] = ensureDeviceIdentity(store.db, {
		keysDir: join(directory, "keys"),
	});
	const peerDb = connect(":memory:");
	const keysDir = join(directory, "peer-keys");
	let peerId: string;
	try {
		initTestSchema(peerDb);
		[peerId] = ensureDeviceIdentity(peerDb, { keysDir });
	} finally {
		peerDb.close();
	}
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("Missing fixture public key");
	seedPeer(peerId);
	store.db
		.prepare(
			"UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ? WHERE peer_device_id = ?",
		)
		.run(publicKey, fingerprintPublicKey(publicKey), peerId);
	store.db
		.prepare(`INSERT INTO replication_scopes
			(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
			VALUES ('health-shared', 'Health fixture', 'user', 'manual', 1, 'active', ?, ?)`)
		.run(now.toISOString(), now.toISOString());
	for (const id of [localId, peerId]) {
		store.db
			.prepare(`INSERT INTO scope_memberships
				(scope_id, device_id, role, status, membership_epoch, updated_at)
				VALUES ('health-shared', ?, 'member', 'active', 1, ?)`)
			.run(id, now.toISOString());
	}
	const protocol = syncProtocolRoutes(() => store);
	return {
		peerId,
		post(body: string) {
			const url = "http://localhost/v1/ops";
			const headers = buildDirectPeerAuthHeaders({
				deviceId: peerId,
				recipientId: localId,
				method: "POST",
				url,
				bodyBytes: Buffer.from(body),
				keysDir,
			});
			return protocol.request(url, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body,
			});
		},
	};
}

function signedHealthOperation(peerId: string) {
	return {
		op_id: "signed-health-op",
		entity_type: "memory_item",
		entity_id: "signed-health-memory",
		op_type: "upsert",
		payload_json: JSON.stringify({
			body_text: "Synthetic inbound health fixture",
			title: "Inbound health fixture",
			kind: "discovery",
			visibility: "shared",
			scope_id: "health-shared",
			origin_device_id: peerId,
			created_at: now.toISOString(),
			updated_at: now.toISOString(),
		}),
		clock_rev: 1,
		clock_updated_at: now.toISOString(),
		clock_device_id: peerId,
		device_id: peerId,
		created_at: now.toISOString(),
		scope_id: "health-shared",
	};
}

function importedContentSnapshot() {
	return {
		memories: store.db.prepare("SELECT * FROM memory_items ORDER BY id").all(),
		operations: store.db.prepare("SELECT * FROM replication_ops ORDER BY op_id").all(),
		receipts: store.db.prepare("SELECT * FROM sync_transfer_receipts ORDER BY transfer_id").all(),
	};
}

describe("signed scope rejection health", () => {
	it.each([
		{ rejection: "revoked sender membership", status: 403, reason: "stale_epoch" },
		{ rejection: "explicit empty scope", status: 409, reason: "missing_scope" },
	])(
		"records $rejection without importing content and clears it on a valid retry",
		async (testCase) => {
			// Arrange: a prior successful exchange must not hide a newly rejected receive.
			const fixture = signedInboundFixture();
			seedExchange(fixture.peerId);
			const app = syncRoutes(() => store);
			const body = { sync_capability: "scoped", ops: [signedHealthOperation(fixture.peerId)] };
			if (testCase.status === 403) {
				store.db
					.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE device_id = ?")
					.run(fixture.peerId);
			}
			const rejectedBody = testCase.status === 409 ? { ...body, scope_id: "" } : body;
			const before = importedContentSnapshot();
			// Act: preserve the rejected result and API state before restoring valid membership.
			const rejected = await fixture.post(JSON.stringify(rejectedBody));
			const rejectedResult = await rejected.json();
			const failed = (await (await app.request("/api/sync/status")).json()) as HealthPayload;
			const afterRejection = importedContentSnapshot();
			store.db
				.prepare("UPDATE scope_memberships SET status = 'active' WHERE device_id = ?")
				.run(fixture.peerId);
			const retry = await fixture.post(JSON.stringify(body));
			const retryResult = await retry.json();
			const recovered = (await (await app.request("/api/sync/status")).json()) as HealthPayload;
			// Assert: rejection changes health only, and successful inbound work resolves its own error.
			expect(rejected.status, JSON.stringify(rejectedResult)).toBe(testCase.status);
			expect(rejectedResult).toMatchObject({
				error: testCase.status === 403 ? "scope_rejected" : "reset_required",
				reason: testCase.reason,
			});
			expect(afterRejection).toEqual(before);
			expect(
				failed.peers?.find((peer) => peer.peer_device_id === fixture.peerId)?.sync_health,
			).toMatchObject({
				state: "needs_attention",
				send: { state: "succeeded", last_attempt_at: recent.toISOString(), reason_code: null },
				receive: {
					state: "needs_attention",
					reason_code: "scope_rejected",
					last_attempt_at: now.toISOString(),
					last_success_at: recent.toISOString(),
					operations_24h: 0,
				},
			});
			expect(failed.sync_health.state).toBe("needs_attention");
			expect(failed.status.sync_health).toEqual(failed.sync_health);
			expect(retry.status, JSON.stringify(retryResult)).toBe(200);
			expect(retryResult).toMatchObject({ applied: 1, rejected: 0 });
			expect(
				recovered.peers?.find((peer) => peer.peer_device_id === fixture.peerId)?.sync_health,
			).toMatchObject({
				state: "exchange_succeeded",
				receive: { state: "succeeded", reason_code: null, operations_24h: 1 },
			});
			expect(recovered.sync_health.state).toBe("exchange_succeeded");
		},
	);

	it("does not record activity for an unauthenticated scope rejection attempt", async () => {
		// Arrange: an attacker cannot mark a paired peer's receive as failed.
		const fixture = signedInboundFixture();
		seedExchange(fixture.peerId);
		const before = store.db
			.prepare("SELECT * FROM sync_transfer_observations ORDER BY source, direction")
			.all();
		const contentBefore = importedContentSnapshot();
		const protocol = syncProtocolRoutes(() => store);
		// Act.
		const response = await protocol.request("http://localhost/v1/ops", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ scope_id: "", sync_capability: "scoped", ops: [] }),
		});
		// Assert: authentication fails before observation or content writes.
		expect(response.status).toBe(401);
		expect(
			store.db.prepare("SELECT * FROM sync_transfer_observations ORDER BY source, direction").all(),
		).toEqual(before);
		expect(importedContentSnapshot()).toEqual(contentBefore);
	});
});

describe("authenticated inbound transfer accounting", () => {
	it("counts a signed operation once across fresh-nonce retries and preserves unknown send", async () => {
		// Arrange: old contact history must not supply directional proof.
		const fixture = signedInboundFixture();
		store.db
			.prepare("UPDATE sync_peers SET last_sync_at = ? WHERE peer_device_id = ?")
			.run("2026-10-01T00:00:00.000Z", fixture.peerId);
		const body = JSON.stringify({
			sync_capability: "scoped",
			ops: [signedHealthOperation(fixture.peerId)],
		});
		const app = syncRoutes(() => store);
		// Act: each signature has a new nonce, so this is an operation retry rather than auth replay.
		const first = await fixture.post(body);
		const firstResult = await first.json();
		const beforeRetry = (await (await app.request("/api/sync/status")).json()) as HealthPayload;
		const retried = await fixture.post(body);
		const retryResult = await retried.json();
		const afterRetry = (await (await app.request("/api/sync/peers")).json()) as HealthPayload;
		// Assert: only durable applies count, and the receiver has no verified send.
		expect(first.status, JSON.stringify(firstResult)).toBe(200);
		expect(firstResult).toMatchObject({ applied: 1, rejected: 0 });
		expect(retried.status, JSON.stringify(retryResult)).toBe(200);
		expect(retryResult).toMatchObject({ applied: 0, skipped: 1, rejected: 0 });
		for (const peers of [beforeRetry.peers, afterRetry.items]) {
			expect(
				peers?.find((peer) => peer.peer_device_id === fixture.peerId)?.sync_health,
			).toMatchObject({
				state: "not_verified",
				send: { state: "not_verified", operations_24h: null, last_success_at: null },
				receive: { state: "succeeded", operations_24h: 1, last_success_at: now.toISOString() },
			});
		}
	});

	it("does not fabricate successful receive evidence for a malformed signed batch", async () => {
		// Arrange.
		const fixture = signedInboundFixture();
		const app = syncRoutes(() => store);
		// Act.
		const response = await fixture.post(JSON.stringify({ sync_capability: "scoped", ops: null }));
		const status = (await (await app.request("/api/sync/status")).json()) as HealthPayload;
		// Assert.
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_ops" });
		expect(
			status.peers?.find((peer) => peer.peer_device_id === fixture.peerId)?.sync_health.receive,
		).toMatchObject({ last_success_at: null, operations_24h: null });
	});
});

describe.each(["apply_failed", "scope_rejected"] as const)(
	"signed inbound requests preserve an initiated %s failure",
	(errorCode) => {
		it.each([0, 1])(
			"retains the failure after applying %i inbound operations until its source retries",
			async (count) => {
				// Arrange: only the initiated pull can resolve its receive error.
				const fixture = signedInboundFixture();
				recordSyncTransferObservation(store.db, fixture.peerId, "receive", {
					errorCode,
					now: recent,
				});
				const app = syncRoutes(() => store);
				const body = JSON.stringify({
					sync_capability: "scoped",
					ops: count === 0 ? [] : [signedHealthOperation(fixture.peerId)],
				});
				// Act: successful inbound work updates receive evidence but cannot resolve the pull.
				const response = await fixture.post(body);
				const result = await response.json();
				const afterPush = (await (await app.request("/api/sync/status")).json()) as HealthPayload;
				recordSyncTransferObservation(store.db, fixture.peerId, "receive", { now });
				const afterPull = (await (await app.request("/api/sync/peers")).json()) as HealthPayload;
				// Assert: measured progress and unresolved failure coexist until the owning source succeeds.
				expect(response.status, JSON.stringify(result)).toBe(200);
				expect(result).toMatchObject({ applied: count, rejected: 0 });
				expect(
					afterPush.peers?.find((peer) => peer.peer_device_id === fixture.peerId)?.sync_health,
				).toMatchObject({
					state: "needs_attention",
					send: { state: "not_verified", last_success_at: null, operations_24h: null },
					receive: {
						state: "needs_attention",
						reason_code: errorCode,
						last_attempt_at: now.toISOString(),
						last_success_at: now.toISOString(),
						operations_24h: count,
					},
				});
				expect(
					afterPull.items?.find((peer) => peer.peer_device_id === fixture.peerId)?.sync_health,
				).toMatchObject({
					state: "not_verified",
					send: { state: "not_verified", operations_24h: null },
					receive: { state: "succeeded", reason_code: null, operations_24h: count },
				});
			},
		);
	},
);

describe.each(endpoints)("%s directional health", (endpoint) => {
	it("keeps legacy last-sync and successful attempt counters unverified", async () => {
		// Arrange: pre-upgrade history has no durable directional observation.
		seedPeer("legacy-peer");
		seedAttempt("legacy-peer", { ok: true });
		const app = syncRoutes(() => store);
		// Act.
		const response = await app.request(endpoint);
		const body = (await response.json()) as HealthPayload;
		const peers = body.peers ?? body.items ?? [];
		// Assert: the old submitted totals cannot become verified transfer counts.
		expect(response.status).toBe(200);
		expect(peers).toHaveLength(1);
		const unknown = {
			state: "not_verified",
			last_attempt_at: null,
			last_success_at: null,
			operations_24h: null,
			pending_count: null,
		};
		expect(peers[0]?.sync_health).toMatchObject({
			state: "not_verified",
			send: unknown,
			receive: unknown,
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("shows inbound-only receipts without inventing a successful send", async () => {
		// Arrange: no locally initiated attempt exists for this receive-only peer.
		seedPeer("inbound-peer");
		recordSyncTransferObservation(store.db, "inbound-peer", "receive", { now: recent });
		recordSyncTransferReceipts(store.db, "inbound-peer", "receive", ["op-a", "op-b"], {
			now: recent,
		});
		const app = syncRoutes(() => store);
		// Act.
		const response = await app.request(endpoint);
		const body = (await response.json()) as HealthPayload;
		// Assert.
		expect(response.status).toBe(200);
		expect((body.peers ?? body.items)?.[0]?.sync_health).toMatchObject({
			state: "not_verified",
			send: { state: "not_verified", operations_24h: null, pending_count: null },
			receive: {
				state: "succeeded",
				last_success_at: recent.toISOString(),
				operations_24h: 2,
				pending_count: null,
			},
		});
	});

	it("keeps a measured empty successful exchange at zero with unknown pending work", async () => {
		// Arrange.
		seedPeer("empty-peer");
		seedExchange("empty-peer");
		const app = syncRoutes(() => store);
		// Act.
		const response = await app.request(endpoint);
		const body = (await response.json()) as HealthPayload;
		// Assert.
		expect(response.status).toBe(200);
		expect((body.peers ?? body.items)?.[0]?.sync_health).toMatchObject({
			state: "exchange_succeeded",
			send: { state: "succeeded", operations_24h: 0, pending_count: null },
			receive: { state: "succeeded", operations_24h: 0, pending_count: null },
		});
	});

	it("does not let a later inbound observation clear a failed send", async () => {
		// Arrange: a recorded send failure must recover independently of receives.
		seedPeer("failed-peer");
		seedExchange("failed-peer", new Date("2026-11-02T11:57:00.000Z"));
		seedAttempt("failed-peer", { ok: false, at: new Date("2026-11-02T11:58:00.000Z") });
		recordSyncTransferObservation(store.db, "failed-peer", "send", {
			now: new Date("2026-11-02T11:58:00.000Z"),
			errorCode: "exchange_failed",
		});
		recordSyncTransferObservation(store.db, "failed-peer", "receive", { now: recent });
		const app = syncRoutes(() => store);
		// Act.
		const response = await app.request(endpoint);
		const body = (await response.json()) as HealthPayload;
		// Assert: reasons are safe codes, without raw transport details.
		expect(response.status).toBe(200);
		expect((body.peers ?? body.items)?.[0]?.sync_health).toMatchObject({
			state: "needs_attention",
			send: { state: "needs_attention", reason_code: "transfer_failed" },
			receive: { state: "succeeded", reason_code: null },
		});
	});
});

describe.each(endpoints)("%s partial exchange and freshness", (endpoint) => {
	it("preserves an acknowledged send when a later receive fails scope validation", async () => {
		// Arrange: the generic attempt result cannot overwrite directional proof.
		seedPeer("partial-peer");
		seedExchange("partial-peer");
		const failedAt = new Date("2026-11-02T11:59:30.000Z");
		recordSyncTransferObservation(store.db, "partial-peer", "receive", {
			now: failedAt,
			errorCode: "scope_rejected",
		});
		seedAttempt("partial-peer", { ok: false, at: failedAt });
		const app = syncRoutes(() => store);
		// Act.
		const response = await app.request(endpoint);
		const body = (await response.json()) as HealthPayload;
		// Assert: the specific receive error and successful send timestamps survive the overlay.
		expect(response.status).toBe(200);
		expect((body.peers ?? body.items)?.[0]?.sync_health).toMatchObject({
			state: "needs_attention",
			send: {
				state: "succeeded",
				last_attempt_at: recent.toISOString(),
				last_success_at: recent.toISOString(),
				reason_code: null,
			},
			receive: {
				state: "needs_attention",
				last_attempt_at: failedAt.toISOString(),
				last_success_at: recent.toISOString(),
				reason_code: "scope_rejected",
			},
		});
	});

	it("keeps directions unknown when only a generic failed attempt exists", async () => {
		// Arrange.
		seedPeer("unobserved-peer");
		seedAttempt("unobserved-peer", { ok: false });
		const app = syncRoutes(() => store);
		// Act.
		const response = await app.request(endpoint);
		const body = (await response.json()) as HealthPayload;
		// Assert.
		const unknown = {
			state: "not_verified",
			last_attempt_at: null,
			last_success_at: null,
			reason_code: null,
			operations_24h: null,
		};
		expect(response.status).toBe(200);
		expect((body.peers ?? body.items)?.[0]?.sync_health).toMatchObject({
			state: "needs_attention",
			send: unknown,
			receive: unknown,
		});
	});

	it.each([
		{ at: "2026-11-02T11:30:00.000Z", state: "exchange_succeeded" },
		{ at: "2026-11-02T11:29:59.999Z", state: "stale" },
	])("respects a long configured interval at $at", async ({ at, state }) => {
		// Arrange: three ten-minute intervals define the freshness window.
		writeFileSync(
			join(directory, "config.json"),
			JSON.stringify({
				sync_enabled: true,
				sync_interval_s: 600,
			}),
		);
		vi.stubEnv("CODEMEM_SYNC_INTERVAL_S", "600");
		seedPeer("slow-peer");
		seedExchange("slow-peer", new Date(at));
		const app = syncRoutes(() => store);
		// Act.
		const response = await app.request(endpoint);
		const body = (await response.json()) as HealthPayload;
		// Assert.
		expect(response.status).toBe(200);
		expect((body.peers ?? body.items)?.[0]?.sync_health.state).toBe(state);
	});
});

describe("status aggregates every paired peer", () => {
	it.each(["not_verified", "stale", "needs_attention"])(
		"does not let a healthy peer hide another peer in state %s",
		async (state) => {
			// Arrange.
			seedPeer("healthy-peer");
			seedExchange("healthy-peer");
			seedPeer("other-peer");
			if (state === "stale") seedExchange("other-peer", new Date("2026-11-02T11:49:00.000Z"));
			if (state === "needs_attention") seedAttempt("other-peer", { ok: false });
			const app = syncRoutes(() => store);
			// Act.
			const response = await app.request("/api/sync/status");
			const body = (await response.json()) as HealthPayload;
			// Assert: the top-level and nested consumers receive the same conservative summary.
			expect(response.status).toBe(200);
			expect(body.sync_health).toMatchObject({ state, peer_count: 2 });
			expect(body.status.sync_health).toEqual(body.sync_health);
		},
	);

	it.each([
		{ enabled: true, state: "no_peers" },
		{ enabled: false, state: "disabled" },
	])("reports $state for an empty inventory", async ({ enabled, state }) => {
		// Arrange.
		vi.stubEnv("CODEMEM_SYNC_ENABLED", enabled ? "1" : "0");
		const app = syncRoutes(() => store);
		// Act.
		const response = await app.request("/api/sync/status");
		const body = (await response.json()) as HealthPayload;
		// Assert.
		expect(response.status).toBe(200);
		expect(body.sync_health).toMatchObject({ state, peer_count: 0 });
		expect(body.status.sync_health).toEqual(body.sync_health);
	});

	it("reports overall exchange success only with directional observations for every peer", async () => {
		// Arrange.
		for (const id of ["peer-a", "peer-b"]) {
			seedPeer(id);
			seedExchange(id);
		}
		const app = syncRoutes(() => store);
		// Act.
		const response = await app.request("/api/sync/status");
		const body = (await response.json()) as HealthPayload;
		// Assert.
		expect(response.status).toBe(200);
		expect(body.sync_health).toMatchObject({ state: "exchange_succeeded", peer_count: 2 });
		expect(body.status.sync_health).toEqual(body.sync_health);
	});
});
