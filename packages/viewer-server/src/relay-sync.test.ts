import { createPrivateKey, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { applyReplicationOps } from "@codemem/core";
import { serve } from "@hono/node-server";
import { afterEach, expect, it, vi } from "vitest";
import { decodeRelayCheckPacket } from "../../core/src/relay-admission-codec.js";
import {
	observeRelayWrites,
	relayClientFixture,
	relayDeadline,
} from "../../core/src/relay-peer-client-test-fixtures.js";
import { syncScopedChannelOnce } from "../../core/src/sync-channel-pass.js";
import { getSyncChannelProgress } from "../../core/src/sync-channel-progress.js";
import { loadPrivateKey } from "../../core/src/sync-identity.js";
import { runSyncPass } from "../../core/src/sync-pass.js";
import { getReplicationCursor, setReplicationCursor } from "../../core/src/sync-replication.js";
import { createSyncApp } from "./index.js";
import { createSyncChannelDispatcher } from "./sync-channel-dispatch.js";
import { ORIGIN, SCOPE } from "./sync-channel-dispatch-test-fixtures.js";
import { passFixture } from "./sync-channel-pass-test-fixtures.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
function identity(keysDir: string, expectedPin: string) {
	const key = loadPrivateKey(keysDir);
	if (!key) throw new Error("Missing disposable identity");
	return { key: createPrivateKey(key), expectedPin };
}
async function fixture() {
	const stores = await passFixture();
	cleanups.push(stores.cleanup);
	const { remote } = stores;
	const serverKeys = join(dirname(remote.peerKeysDir), "local-keys");
	const relay = await relayClientFixture(
		{
			source: identity(remote.peerKeysDir, remote.peerPublicKey),
			target: identity(serverKeys, remote.localPublicKey),
		},
		{ source: remote.peerDeviceId, target: remote.localDeviceId },
	);
	cleanups.push(() => relay.dispose());
	const dispatch = createSyncChannelDispatcher({ storeFactory: remote.storeFactory });
	const control = { interruptPost: false };
	const target = relay.client("target", {
		onInbound: async (_connection, context) =>
			context.serve({
				origin: ORIGIN,
				dispatch: async (request) => {
					vi.stubEnv("CODEMEM_KEYS_DIR", serverKeys);
					const response = await dispatch(request);
					if (control.interruptPost && request.method === "POST") await source.close();
					return response;
				},
			}),
	});
	const source = relay.client("source");
	const original = source.factory(remote.localDeviceId, remote.localPublicKey);
	const factory = {
		open: vi.fn(original.open),
	};
	const options = { ...stores.options, factory };
	return { ...stores, relay, source, target, options, factory, control };
}

async function storeUnreachableAddress(f: Awaited<ReturnType<typeof fixture>>) {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing disposable listener");
	const url = `http://127.0.0.1:${address.port}`;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	f.client.db
		.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = ?")
		.run(JSON.stringify([url]), f.remote.localDeviceId);
	return url;
}

function persistedAddresses(f: Awaited<ReturnType<typeof fixture>>) {
	return f.client.db
		.prepare(
			"SELECT addresses_json, manual_addresses_json, last_success_address FROM sync_peers WHERE peer_device_id = ?",
		)
		.get(f.remote.localDeviceId);
}

async function ordinarySyncServer(f: Awaited<ReturnType<typeof fixture>>) {
	const app = createSyncApp({ storeFactory: f.remote.storeFactory });
	const requests: Request[] = [];
	const url = await new Promise<string>((resolve) => {
		const server = serve(
			{
				hostname: "127.0.0.1",
				port: 0,
				fetch: (request) => {
					vi.stubEnv("CODEMEM_KEYS_DIR", join(dirname(f.remote.peerKeysDir), "local-keys"));
					requests.push(request);
					return app.fetch(request);
				},
			},
			({ port }) => resolve(`http://127.0.0.1:${port}`),
		);
		cleanups.push(
			() =>
				new Promise<void>((resolveClose, reject) =>
					server.close((error) => (error ? reject(error) : resolveClose())),
				),
		);
	});
	f.client.db
		.prepare("UPDATE sync_peers SET addresses_json = ? WHERE peer_device_id = ?")
		.run(JSON.stringify([url]), f.remote.localDeviceId);
	return { url, requests };
}
function titles(f: Awaited<ReturnType<typeof fixture>>, side: "client" | "remote") {
	const store = side === "client" ? f.client : f.remote.store;
	return store.db
		.prepare("SELECT title FROM memory_items WHERE scope_id = ? ORDER BY title")
		.pluck()
		.all(SCOPE);
}

function seedOtherSpace(
	f: Awaited<ReturnType<typeof fixture>>,
	authored: ReturnType<typeof f.seed>,
) {
	const scope = f.client.db
		.prepare("SELECT * FROM replication_scopes WHERE scope_id = ?")
		.get(SCOPE) as Record<string, unknown>;
	const columns = Object.keys(scope);
	f.client.db
		.prepare(
			`INSERT INTO replication_scopes (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		)
		.run(...Object.values({ ...scope, scope_id: "other-space" }));
	const op = {
		...authored,
		op_id: "other-space-op",
		entity_id: `memory-source-v1:${Buffer.from(f.remote.peerDeviceId).toString("base64url")}:${randomUUID()}`,
		scope_id: "other-space",
		payload_json: JSON.stringify({
			...JSON.parse(authored.payload_json),
			scope_id: "other-space",
			title: "other-space-item",
		}),
	};
	const result = applyReplicationOps(f.client.db, [op], f.remote.localDeviceId, f.client.scanner);
	if (result.applied !== 1 || result.errors.length) throw new Error(JSON.stringify(result));
}

it("converges authorized Space pull/push through the actual relay and saves a completed outbound ACK", async () => {
	// Arrange: use the real scoped dispatcher, identities, replication operations and stores.
	const f = await fixture();
	setReplicationCursor(
		f.client.db,
		f.remote.localDeviceId,
		{ lastApplied: "2025-01-01T00:00:00Z|initial" },
		SCOPE,
	);
	f.seed("remote", "remote-relay-item");
	const authored = f.seed("client", "client-relay-item", "Private héllo relay marker");
	seedOtherSpace(f, authored);
	await f.target.connect(new AbortController().signal, relayDeadline());
	// Act.
	const result = await syncScopedChannelOnce(f.options);
	// Assert: both databases converge only after completed encrypted exchanges.
	expect(result).toMatchObject({ ok: true, opsIn: 1, opsOut: 1, bootstrapped: false });
	expect(titles(f, "client")).toEqual(["client-relay-item", "remote-relay-item"]);
	expect(titles(f, "remote")).toEqual(["client-relay-item", "remote-relay-item"]);
	expect(
		f.remote.store.db
			.prepare("SELECT title FROM memory_items WHERE scope_id = 'other-space'")
			.all(),
	).toEqual([]);
	expect(
		f.client.db
			.prepare("SELECT title FROM memory_items WHERE scope_id = 'other-space'")
			.pluck()
			.all(),
	).toEqual(["other-space-item"]);
	expect(
		getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE)?.last_acked_cursor,
	).toContain("|client-relay-item-op");
	expect(f.relay.runtime.counters().routes).toBe(0);
	expect(f.factory.open).toHaveBeenCalledTimes(3);
}, 30000);

it("does not save an outbound ACK or retry after an interrupted POST response", async () => {
	// Arrange: the remote applies the operation, but the physical relay disconnects before its reply.
	const f = await fixture();
	setReplicationCursor(
		f.client.db,
		f.remote.localDeviceId,
		{ lastApplied: "2025-01-01T00:00:00Z|initial" },
		SCOPE,
	);
	f.seed("client", "interrupted-item");
	f.control.interruptPost = true;
	await f.target.connect(new AbortController().signal, relayDeadline());
	// Act.
	const result = await syncScopedChannelOnce(f.options);
	// Assert.
	expect(result.ok).toBe(false);
	expect(titles(f, "remote")).toEqual(["interrupted-item"]);
	expect(
		getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE)?.last_acked_cursor ?? null,
	).toBeNull();
	expect(f.factory.open).toHaveBeenCalledTimes(3);
}, 30000);

it("requires current Space membership even after relay admission and Noise authentication", async () => {
	// Arrange.
	const f = await fixture();
	f.seed("client", "unauthorized-item");
	f.remote.store.db
		.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE device_id = ? AND scope_id = ?")
		.run(f.remote.peerDeviceId, SCOPE);
	await f.target.connect(new AbortController().signal, relayDeadline());
	// Act.
	const result = await syncScopedChannelOnce(f.options);
	// Assert.
	expect(result.ok).toBe(false);
	expect(titles(f, "remote")).toEqual([]);
	expect(
		getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE)?.last_acked_cursor ?? null,
	).toBeNull();
	expect(f.factory.open).toHaveBeenCalledTimes(1);
}, 10000);

it("leaves scoped progress and outbound ACK unchanged when the relay target is offline", async () => {
	// Arrange.
	const f = await fixture();
	f.seed("client", "pending-private-item");
	const before = getReplicationCursor(f.client.db, f.remote.localDeviceId, SCOPE);
	// Act.
	const result = await syncScopedChannelOnce(f.options);
	// Assert.
	expect(result.ok).toBe(false);
	expect(getReplicationCursor(f.client.db, f.remote.localDeviceId, SCOPE)).toEqual(before);
	expect(
		getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE)?.last_acked_cursor ?? null,
	).toBeNull();
	expect(titles(f, "remote")).toEqual([]);
	expect(f.factory.open).toHaveBeenCalledTimes(1);
}, 10000);

it("selects the actual relay after a persisted direct address fails and completes authorized Space sync", async () => {
	// Arrange: a closed, owned loopback port produces an actual pre-authentication network failure.
	const f = await fixture();
	const direct = await storeUnreachableAddress(f);
	f.seed("remote", "selected-remote-item");
	const authored = f.seed("client", "selected-client-item");
	seedOtherSpace(f, authored);
	await f.target.connect(new AbortController().signal, relayDeadline());
	// Act: use the public selector entry and the actual client, without replacing its capability.
	const result = await runSyncPass(f.client.db, f.remote.localDeviceId, {
		keysDir: f.remote.peerKeysDir,
		dbPath: f.options.dbPath,
		scanner: f.client.scanner,
		reachability: {
			scopeId: SCOPE,
			logicalOrigin: ORIGIN,
			relay: f.source,
			deadlineMs: performance.now() + 30000,
		},
	});
	// Assert: the selected path completes both directions and persists only ordinary addresses.
	expect(result).toMatchObject({
		ok: true,
		transport: "relay",
		opsIn: 1,
		opsOut: 1,
		perScopeResults: [{ scope_id: SCOPE, ok: true, opsIn: 1, opsOut: 1, bootstrapped: true }],
	});
	expect(result.addressErrors).toHaveLength(1);
	expect(titles(f, "client")).toEqual(["selected-client-item", "selected-remote-item"]);
	expect(titles(f, "remote")).toEqual(["selected-client-item", "selected-remote-item"]);
	expect(
		f.remote.store.db
			.prepare("SELECT title FROM memory_items WHERE scope_id = 'other-space'")
			.all(),
	).toEqual([]);
	expect(
		getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE)?.last_acked_cursor,
	).toContain("|selected-client-item-op");
	expect(persistedAddresses(f)).toEqual({
		addresses_json: JSON.stringify([direct]),
		manual_addresses_json: null,
		last_success_address: null,
	});
	expect(f.relay.runtime.counters().routes).toBe(0);
}, 30000);

it("reports failed relay selection without saving an ACK or replaying payload when both paths are offline", async () => {
	// Arrange.
	const f = await fixture();
	const direct = await storeUnreachableAddress(f);
	f.seed("client", "selected-pending-item");
	const cursor = getReplicationCursor(f.client.db, f.remote.localDeviceId, SCOPE);
	// Act.
	const result = await runSyncPass(f.client.db, f.remote.localDeviceId, {
		keysDir: f.remote.peerKeysDir,
		dbPath: f.options.dbPath,
		scanner: f.client.scanner,
		reachability: {
			scopeId: SCOPE,
			logicalOrigin: ORIGIN,
			relay: f.source,
			deadlineMs: relayDeadline(),
		},
	});
	// Assert: only one source/relay admission attempt occurs and no application bytes transfer.
	expect(result).toMatchObject({
		ok: false,
		transport: "relay",
		opsIn: 0,
		opsOut: 0,
		perScopeResults: [{ scope_id: SCOPE, ok: false }],
	});
	expect(result.addressErrors).toHaveLength(1);
	expect(
		f.relay.checks
			.map(({ packet }) => decodeRelayCheckPacket(packet))
			.filter((packet) => packet.kind === "admission")
			.map((packet) => packet.value.role)
			.sort(),
	).toEqual(["relay", "source"]);
	expect(getReplicationCursor(f.client.db, f.remote.localDeviceId, SCOPE)).toEqual(cursor);
	expect(
		getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE)?.last_acked_cursor ?? null,
	).toBeNull();
	expect(titles(f, "remote")).toEqual([]);
	expect(persistedAddresses(f)).toEqual({
		addresses_json: JSON.stringify([direct]),
		manual_addresses_json: null,
		last_success_address: null,
	});
}, 10000);

it("selects healthy ordinary HTTP for an authorized Space pull without contacting the available relay", async () => {
	// Arrange: ordinary HTTP and the registered relay target are both available with real identities.
	const f = await fixture();
	f.seed("remote", "ordinary-direct-item");
	await f.target.connect(new AbortController().signal, relayDeadline());
	const beforeChecks = f.relay.checks.length;
	const relayWrites = observeRelayWrites();
	const direct = await ordinarySyncServer(f);
	// Act: use the public selector and its normal HTTP executor without replacing any capability.
	const result = await runSyncPass(f.client.db, f.remote.localDeviceId, {
		keysDir: f.remote.peerKeysDir,
		dbPath: f.options.dbPath,
		scanner: f.client.scanner,
		reachability: {
			scopeId: SCOPE,
			logicalOrigin: ORIGIN,
			relay: f.source,
			deadlineMs: relayDeadline(),
		},
	});
	// Assert: legacy direct scope behavior pulls the authorized memory and uses both signature versions.
	expect(result).toMatchObject({ ok: true, transport: "direct", opsIn: 1 });
	expect(titles(f, "client")).toEqual(["ordinary-direct-item"]);
	expect(direct.requests.some((request) => new URL(request.url).pathname === "/v1/status")).toBe(
		true,
	);
	for (const request of direct.requests) {
		expect(request.headers.get("x-opencode-signature")).toBeTruthy();
		expect(request.headers.get("x-codemem-signature")).toBeTruthy();
		expect(request.headers.get("x-codemem-recipient")).toBe(f.remote.localDeviceId);
	}
	expect(f.relay.checks).toHaveLength(beforeChecks);
	expect(relayWrites()).toBe(0);
	expect(f.relay.runtime.counters()).toMatchObject({ sockets: 1, routes: 0, queuedBytes: 0 });
	expect(persistedAddresses(f)).toMatchObject({
		addresses_json: JSON.stringify([direct.url]),
		last_success_address: direct.url,
	});
}, 10000);
