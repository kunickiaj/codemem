import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { parseRelayEd25519PublicKey } from "../../core/src/relay-ed25519.js";
import { RelayFailure } from "../../core/src/relay-failure-reason.js";
import { createRelayPeerClient } from "../../core/src/relay-peer-client.js";
import { disposableIdentity } from "../../core/src/relay-peer-client-test-fixtures.js";
import { relayAudienceId, relayBodyDigest } from "../../core/src/relay-service-proof.js";
import { runSyncPass } from "../../core/src/sync-orchestration.js";
import { setReplicationCursor } from "../../core/src/sync-replication.js";
import { readPeerSyncActivity } from "../../core/src/sync-transfer-activity.js";
import { ORIGIN, SCOPE } from "./sync-channel-dispatch-test-fixtures.js";
import { passFixture } from "./sync-channel-pass-test-fixtures.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("skips a manual pass on another SQLite connection while shared relay pull/push owns the peer", async () => {
	// Arrange: real file-backed stores, authorization, Noise, HTTP and scoped replication.
	const f = await passFixture();
	if (!f.options.dbPath) throw new Error("Missing fixture database path");
	const manualDb = new Database(f.options.dbPath);
	const identity = disposableIdentity(7);
	const relay = createRelayPeerClient({
		enabled: false,
		url: "wss://relay.invalid/v1/relay",
		servicePublicKey: identity.expectedPin,
		deviceId: f.remote.peerDeviceId,
		localIdentity: identity,
		authorityId: "authority",
		groupId: "group",
		relayAudienceId: relayAudienceId(
			"wss://relay.invalid",
			relayBodyDigest(parseRelayEd25519PublicKey(identity.expectedPin).wireKey),
		),
		externalPathname: "/v1/relay/admission-check",
		coordinator: { check: vi.fn(async () => null) },
		resolvePeerPin: () => f.remote.localPublicKey,
		validateLocal: () => true,
		onInbound: vi.fn(async () => {}),
	});
	// The external port models the real client's one-route-per-peer capacity without a 3 s wait.
	let occupied = false;
	const open = vi.fn<typeof f.factory.open>(async (options) => {
		if (occupied) throw new RelayFailure("relay_unavailable", "Relay capacity exhausted");
		occupied = true;
		try {
			const connection = await f.factory.open(options);
			void connection.completion
				.finally(() => {
					occupied = false;
				})
				.catch(() => {});
			return connection;
		} catch (error) {
			occupied = false;
			throw error;
		}
	});
	const factory = vi.spyOn(relay, "factory").mockReturnValue({
		open,
		failureReason: () => (occupied ? "relay_unavailable" : undefined),
	});
	setReplicationCursor(
		f.client.db,
		f.remote.localDeviceId,
		{
			lastApplied: "2025-01-01T00:00:00Z|initial",
		},
		SCOPE,
	);
	f.seed("remote", "remote-item");
	f.seed("client", "client-item");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let held = false;
	f.control.afterDispatch = async (request, response) => {
		if (!held && new URL(request.url).pathname === "/v1/status") {
			held = true;
			entered.resolve();
			await release.promise;
		}
		return response;
	};
	const opts = {
		keysDir: f.options.keysDir,
		dbPath: f.options.dbPath,
		scanner: f.options.scanner,
		reachability: { scopeId: SCOPE, logicalOrigin: ORIGIN, relay },
	};
	const pending = runSyncPass(f.client.db, f.remote.localDeviceId, opts);
	try {
		await entered.promise;
		const beforeActivity = readPeerSyncActivity(manualDb, [f.remote.localDeviceId]);
		// Act: the manual entrypoint opens the same actual file through a distinct Database instance.
		const busy = await runSyncPass(manualDb, f.remote.localDeviceId, opts);
		const attempts = manualDb.prepare("SELECT * FROM sync_attempts").all();
		const duringActivity = readPeerSyncActivity(manualDb, [f.remote.localDeviceId]);
		const opensDuring = open.mock.calls.length;
		const factoriesDuring = factory.mock.calls.length;
		release.resolve();
		const completed = await pending;
		// Assert: contention neither starts another OPEN nor publishes failure/backoff diagnostics.
		expect.soft(busy).toMatchObject({
			ok: false,
			transport: "wait",
			error: "Peer sync is already in progress",
		});
		expect.soft(attempts).toEqual([]);
		expect.soft(duringActivity).toEqual(beforeActivity);
		expect.soft(opensDuring).toBe(1);
		expect.soft(factoriesDuring).toBe(1);
		expect.soft(completed).toMatchObject({ ok: true, transport: "relay", opsIn: 1, opsOut: 1 });
		for (const store of [f.client, f.remote.store])
			expect(
				store.db
					.prepare("SELECT title FROM memory_items WHERE scope_id = ? ORDER BY title")
					.pluck()
					.all(SCOPE),
			).toEqual(["client-item", "remote-item"]);
		expect(manualDb.prepare("SELECT ok, transport FROM sync_attempts").all()).toEqual([
			{ ok: 1, transport: "relay" },
		]);
	} finally {
		release.resolve();
		await pending;
		await relay.close();
		manualDb.close();
		await f.cleanup();
	}
}, 15000);
