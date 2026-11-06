import { generateKeyPairSync } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelayPeerClient, type RelayPeerClient } from "./relay-peer-client.js";
import { relayAudienceId, relayBodyDigest } from "./relay-service-proof.js";
import * as syncAuth from "./sync-auth.js";
import * as channelPass from "./sync-channel-pass.js";
import type { RequestJsonExecutor } from "./sync-http-client.js";
import * as syncIdentity from "./sync-identity.js";
import { runSyncPass } from "./sync-orchestration.js";
import type { SyncPassOptions } from "./sync-pass.js";
import { runReachableSyncPass, type SyncReachabilityOptions } from "./sync-reachability-pass.js";
import { initTestSchema } from "./test-utils.js";

// Relay fallback must not keep asking the realm for a route to a peer that runs no
// relay client. The peer says so in its sync features over direct sync, and a
// REJECTED reply is retried on a growing schedule.

const boundary = {
	generation: 1,
	snapshot_id: "snapshot",
	baseline_cursor: null,
	retained_floor_cursor: null,
};
const networkError = () => Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });

let db: Database.Database;
let scoped: ReturnType<typeof vi.spyOn<typeof channelPass, "syncScopedChannelOnce">>;

function approvedClient(): RelayPeerClient {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
	const wire = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), raw]);
	const pin = `ssh-ed25519 ${wire.toString("base64")}`;
	return createRelayPeerClient({
		enabled: false,
		url: "wss://relay.invalid/v1/relay",
		servicePublicKey: pin,
		deviceId: "local",
		localIdentity: { key: privateKey, expectedPin: pin },
		authorityId: "authority",
		groupId: "group",
		relayAudienceId: relayAudienceId("wss://relay.invalid", relayBodyDigest(wire)),
		externalPathname: "/v1/relay/admission-check",
		coordinator: { check: vi.fn(async () => null) },
		resolvePeerPin: () => pin,
		validateLocal: () => true,
		onInbound: vi.fn(async () => {}),
	});
}

function options(
	requestExecutor: RequestJsonExecutor,
	relay: RelayPeerClient,
): SyncPassOptions & { reachability: SyncReachabilityOptions } {
	return {
		requestExecutor,
		reachability: { scopeId: "space", logicalOrigin: "https://peer.invalid", relay },
	};
}

/** Direct sync succeeds once, with the peer advertising the given features. */
function directExchange(features: string[] | undefined) {
	return vi.fn<RequestJsonExecutor>(async (method, url) => {
		if (new URL(url).pathname === "/v1/status")
			return [
				200,
				{
					device_id: "peer",
					fingerprint: "pinned",
					protocol_version: "2",
					sync_capability: "enforcing",
					sync_reset: boundary,
					...(features ? { sync_features: features } : {}),
				},
			];
		if (method === "GET")
			return [200, { ...boundary, reset_required: false, ops: [], next_cursor: null, skipped: 0 }];
		return [200, { applied: 0, skipped: 0, errors: [] }];
	});
}

function rejected() {
	scoped.mockResolvedValueOnce({
		ok: false,
		scope_id: "space",
		opsIn: 0,
		opsOut: 0,
		bootstrapped: false,
		error: "scoped channel exchange failed: relay_rejected",
		failureCategory: "other",
		relayFailureReason: "relay_rejected",
	});
}

function peerRow() {
	return db
		.prepare(
			"SELECT sync_features_json, sync_features_observed_at, relay_retry_after, relay_rejections FROM sync_peers WHERE peer_device_id = 'peer'",
		)
		.get() as {
		sync_features_json: string | null;
		sync_features_observed_at: string | null;
		relay_retry_after: string | null;
		relay_rejections: number;
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-06T12:00:00Z"));
	db = new Database(":memory:");
	initTestSchema(db);
	db.prepare(
		"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES ('peer', 'pinned', 'current-public-key', '2026-01-01')",
	).run();
	db.prepare(
		"INSERT INTO replication_cursors(peer_device_id, last_applied_cursor, updated_at) VALUES ('peer', '2026-01-01T00:00:00Z|previous', '2026-01-01')",
	).run();
	vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue(["local", "public-key"]);
	vi.spyOn(syncAuth, "buildDirectPeerAuthHeaders").mockReturnValue({});
	scoped = vi.spyOn(channelPass, "syncScopedChannelOnce").mockResolvedValue({
		ok: true,
		scope_id: "space",
		opsIn: 0,
		opsOut: 0,
		bootstrapped: false,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	db.close();
});

it("stores the peer's advertised features over direct sync, including an older peer's empty list", async () => {
	const relay = approvedClient();
	await runReachableSyncPass(
		db,
		"peer",
		["http://127.0.0.1:19001"],
		options(directExchange(["relay", "relay_aware", "reassign_scope"]), relay),
	);
	expect(peerRow().sync_features_json).toBe('["reassign_scope","relay","relay_aware"]');
	await runReachableSyncPass(
		db,
		"peer",
		["http://127.0.0.1:19001"],
		options(directExchange(undefined), relay),
	);
	expect(peerRow().sync_features_json).toBe("[]");
});

it("waits instead of relaying to a relay-aware peer whose last direct exchange advertised no relay", async () => {
	// Arrange: the peer was seen directly with `relay_aware` but not `relay`, then becomes unreachable.
	const relay = approvedClient();
	await runReachableSyncPass(
		db,
		"peer",
		["http://127.0.0.1:19001"],
		options(directExchange(["reassign_scope", "relay_aware"]), relay),
	);
	const unreachable = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	// Act
	const result = await runReachableSyncPass(
		db,
		"peer",
		["http://127.0.0.1:19001"],
		options(unreachable, relay),
	);
	// Assert: no relay exchange was started.
	expect(result).toMatchObject({
		ok: false,
		transport: "wait",
		relaySkipped: "relay_peer_unsupported",
	});
	expect(scoped).not.toHaveBeenCalled();
	expect(peerRow().sync_features_observed_at).toBe("2026-11-06T12:00:00.000Z");
	// A day later the observation has expired: the peer may have turned relay on meanwhile.
	vi.setSystemTime(new Date("2026-11-07T12:00:01Z"));
	expect(await runReachableSyncPass(db, "peer", [], options(unreachable, relay))).toMatchObject({
		ok: true,
		transport: "relay",
	});
	expect(scoped).toHaveBeenCalledOnce();
});

it("still relays to a peer that predates the relay feature advertisement", async () => {
	// Arrange: a peer on the parent revision runs relay but advertises only reassign_scope.
	const relay = approvedClient();
	await runReachableSyncPass(
		db,
		"peer",
		["http://127.0.0.1:19001"],
		options(directExchange(["reassign_scope"]), relay),
	);
	const unreachable = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	// Act
	const result = await runReachableSyncPass(db, "peer", [], options(unreachable, relay));
	// Assert
	expect(result).toMatchObject({ ok: true, transport: "relay" });
	expect(scoped).toHaveBeenCalledOnce();
});

it("still relays to a peer it has never seen directly", async () => {
	const unreachable = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	const result = await runReachableSyncPass(db, "peer", [], options(unreachable, approvedClient()));
	expect(result).toMatchObject({ ok: true, transport: "relay" });
	expect(scoped).toHaveBeenCalledOnce();
});

it("backs off after REJECTED on a growing schedule and resets on relay success", async () => {
	const relay = approvedClient();
	const unreachable = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	const pass = () => runReachableSyncPass(db, "peer", [], options(unreachable, relay));
	// First rejection: wait two minutes.
	rejected();
	expect(await pass()).toMatchObject({ ok: false, transport: "relay" });
	expect(peerRow()).toMatchObject({
		relay_rejections: 1,
		relay_retry_after: "2026-11-06T12:02:00.000Z",
	});
	// Inside the window: no relay attempt.
	vi.setSystemTime(new Date("2026-11-06T12:01:00Z"));
	expect(await pass()).toMatchObject({
		ok: false,
		transport: "wait",
		relaySkipped: "relay_backoff",
	});
	expect(scoped).toHaveBeenCalledOnce();
	// After the window: a second rejection doubles the wait.
	vi.setSystemTime(new Date("2026-11-06T12:02:00Z"));
	rejected();
	await pass();
	expect(peerRow()).toMatchObject({
		relay_rejections: 2,
		relay_retry_after: "2026-11-06T12:06:00.000Z",
	});
	// A later success clears the back-off.
	vi.setSystemTime(new Date("2026-11-06T12:06:00Z"));
	expect(await pass()).toMatchObject({ ok: true, transport: "relay" });
	expect(peerRow()).toMatchObject({ relay_rejections: 0, relay_retry_after: null });
});

it("records a skipped relay as the direct attempt only, like a pass with no relay", async () => {
	// Arrange: the peer is relay-aware without relay, and has addresses that fail.
	const relay = approvedClient();
	await runReachableSyncPass(
		db,
		"peer",
		["http://127.0.0.1:19001"],
		options(directExchange(["reassign_scope", "relay_aware"]), relay),
	);
	db.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = 'peer'").run(
		JSON.stringify(["http://127.0.0.1:19001"]),
	);
	const unreachable = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	// Act
	const result = await runSyncPass(db, "peer", options(unreachable, relay));
	// Assert: one attempt, carrying the direct failure, with no relay reason appended.
	expect(result).toMatchObject({ transport: "wait", relaySkipped: "relay_peer_unsupported" });
	const attempts = db
		.prepare("SELECT ok, error FROM sync_attempts WHERE peer_device_id = 'peer'")
		.all() as { ok: number; error: string }[];
	expect(attempts).toHaveLength(1);
	expect(attempts[0]?.ok).toBe(0);
	expect(attempts[0]?.error).toContain("connection refused");
	expect(attempts[0]?.error).not.toContain("relay_");
});

it("caps the back-off at thirty minutes", async () => {
	const relay = approvedClient();
	const unreachable = vi.fn<RequestJsonExecutor>().mockRejectedValue(networkError());
	let now = Date.parse("2026-11-06T12:00:00Z");
	for (let i = 0; i < 7; i++) {
		vi.setSystemTime(new Date(now));
		rejected();
		await runReachableSyncPass(db, "peer", [], options(unreachable, relay));
		now = Date.parse(peerRow().relay_retry_after ?? "");
	}
	const row = peerRow();
	expect(row.relay_rejections).toBe(7);
	expect(Date.parse(row.relay_retry_after ?? "") - Date.now()).toBe(30 * 60_000);
});
