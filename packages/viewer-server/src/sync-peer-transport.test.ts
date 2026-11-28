import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, connect as connectSocket } from "node:net";
import { dirname, join } from "node:path";
import {
	applyReplicationOps,
	buildDirectPeerAuthHeaders,
	fingerprintPublicKey,
	generateKeypair,
	loadPublicKey,
	MemoryStore,
	PeerTransportRefused,
	peerTransportExecutor,
	readPeerTransportPolicy,
	resolveKeyPaths,
	syncOnce,
} from "@codemem/core";
import { serve } from "@hono/node-server";
import { afterEach, expect, it, vi } from "vitest";
import { directNoiseConnectionFactory } from "../../core/src/direct-noise-client.js";
import { refreshTestScopeRows } from "../../core/src/scope-membership-cache-test-fixtures.js";
import { runReachableSyncPass } from "../../core/src/sync-reachability-pass.js";
import { promotePeerToNoiseRequired } from "../../core/src/sync-transport-policy.js";
import { createSyncApp } from "./sync-app.js";
import {
	channelStore,
	memoryOp,
	nonceCount,
	SCOPE,
} from "./sync-channel-dispatch-test-fixtures.js";
import { createGuardedSyncServer, type SyncListenerLimits } from "./sync-listener-guard.js";
import type { DirectNoiseGateLimits } from "./sync-noise-gate.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/** A real server store behind the guarded listener, and a client store that pinned it. */
async function pair(options: {
	gate: boolean;
	/** Runs as the plain listener receives each request, before it answers. */
	onPlain?: (path: string) => void;
	/** Runs each time the upgrade gate opens the server store, during admission. */
	onGate?: () => void;
	gateLimits?: Partial<DirectNoiseGateLimits>;
	listenerLimits?: Partial<SyncListenerLimits>;
}) {
	const f = await channelStore();
	cleanups.push(f.cleanup);
	const plainPaths: string[] = [];
	const app = createSyncApp({ storeFactory: f.storeFactory });
	const fetch = (request: Request) => {
		const path = new URL(request.url).pathname;
		plainPaths.push(path);
		options.onPlain?.(path);
		return app.fetch(request);
	};
	const keysDir = join(dirname(f.peerKeysDir), "local-keys");
	const createServer = createGuardedSyncServer({
		limits: options.listenerLimits,
		directNoise: {
			storeFactory: () => {
				options.onGate?.();
				return f.storeFactory();
			},
			keysDir,
			active: options.gate,
			limits: options.gateLimits,
		},
	});
	const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
		const started = serve({ fetch, hostname: "127.0.0.1", port: 0, createServer }, () =>
			resolve(started),
		);
	});
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
	const client = new MemoryStore(join(dirname(f.peerKeysDir), "peer.sqlite"));
	cleanups.push(() => client.close());
	client.db
		.prepare(
			"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(
			f.localDeviceId,
			fingerprintPublicKey(f.localPublicKey),
			f.localPublicKey,
			"2026-01-01T00:00:00Z",
		);
	// The client knows the same Space as the server, as a paired device would.
	for (const table of ["replication_scopes", "scope_memberships"]) {
		for (const row of f.store.db.prepare(`SELECT * FROM ${table}`).all() as Record<
			string,
			unknown
		>[]) {
			const columns = Object.keys(row);
			client.db
				.prepare(
					`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
				)
				.run(...Object.values(row));
		}
	}
	await refreshTestScopeRows(client.db, {
		[f.localDeviceId]: f.localPublicKey,
		[f.peerDeviceId]: f.peerPublicKey,
	});
	const address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
	const sync = () =>
		syncOnce(client.db, f.localDeviceId, [address], {
			keysDir: f.peerKeysDir,
			dbPath: client.dbPath,
			scanner: client.scanner,
			directNoise: { active: true },
		});
	const policy = () => readPeerTransportPolicy(client.db, f.localDeviceId);
	return { ...f, client, address, sync, policy, plainPaths };
}

const syncPaths = (paths: string[]) => paths.filter((path) => path !== "/v1/noise");

it("syncs two stores over Noise with no plaintext sync request, and promotes the peer", async () => {
	const p = await pair({ gate: true });
	// A memory the server authored in the shared Space.
	const op = { ...memoryOp(p), op_id: "server-op", device_id: p.localDeviceId };
	op.clock_device_id = p.localDeviceId;
	op.entity_id = `memory-source-v1:${Buffer.from(p.localDeviceId).toString("base64url")}:server-memory`;
	op.payload_json = JSON.stringify({ ...JSON.parse(op.payload_json), title: "From the server" });
	expect(applyReplicationOps(p.store.db, [op], p.peerDeviceId, p.store.scanner).applied).toBe(1);

	const result = await p.sync();

	expect(result).toMatchObject({ ok: true });
	expect(p.client.db.prepare("SELECT title FROM memory_items").pluck().all()).toContain(
		"From the server",
	);
	expect(p.plainPaths).toEqual([]);
	expect(p.policy()).toBe("noise_required");
});

it("refuses plaintext to a noise_required peer whose Upgrade is stripped", async () => {
	const p = await pair({ gate: false });
	promotePeerToNoiseRequired(p.client.db, p.localDeviceId, "pairing_payload");

	const result = await p.sync();

	expect(result.ok).toBe(false);
	expect(result.error).toContain("noise_required");
	expect(syncPaths(p.plainPaths)).toEqual([]);
});

it("falls back to plaintext once for a legacy peer that does not offer Noise, without promoting it", async () => {
	const p = await pair({ gate: false });

	const result = await p.sync();

	expect(result).toMatchObject({ ok: true });
	expect(syncPaths(p.plainPaths)).toContain("/v1/status");
	expect(p.policy()).toBe("legacy_plaintext");
});

it("refuses a snapshot before a status exchange at the same address", async () => {
	const p = await pair({ gate: true });
	const execute = peerTransportExecutor({
		db: p.client.db,
		peerDeviceId: p.localDeviceId,
		localDeviceId: p.peerDeviceId,
		keysDir: p.peerKeysDir,
		active: true,
	});

	await expect(
		execute("GET", `http://${p.address}/v1/snapshot?limit=1`, { operation: "snapshot" }),
	).rejects.toThrow(PeerTransportRefused);
	expect(p.plainPaths).toEqual([]);
});

it("keeps the grant and never fetches a snapshot when a forged pin-only status answers in plaintext", async () => {
	const p = await pair({ gate: false });
	promotePeerToNoiseRequired(p.client.db, p.localDeviceId, "transport_statement");
	p.client.db
		.prepare(
			"UPDATE sync_peers SET pending_bootstrap_grant_id = 'grant-1' WHERE peer_device_id = ?",
		)
		.run(p.localDeviceId);
	const seen: string[] = [];
	// An on-path attacker answers the marked status with a full, forged status and offers no Noise.
	const forger = createHttpServer((request, response) => {
		seen.push(request.url ?? "");
		if (request.url === "/v1/status?transport=noise1") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					device_id: p.localDeviceId,
					fingerprint: fingerprintPublicKey(p.localPublicKey),
					protocol_version: "2",
					sync_reset: { generation: 1, snapshot_id: "forged", baseline_cursor: null },
				}),
			);
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => forger.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise((resolve) => forger.close(resolve)));

	const result = await syncOnce(
		p.client.db,
		p.localDeviceId,
		[`127.0.0.1:${(forger.address() as AddressInfo).port}`],
		{ keysDir: p.peerKeysDir, dbPath: p.client.dbPath, directNoise: { active: true } },
	);

	expect(result.ok).toBe(false);
	expect(seen).toEqual(["/v1/status?transport=noise1", expect.stringMatching(/^\/v1\/noise\?/)]);
	expect(
		p.client.db
			.prepare("SELECT pending_bootstrap_grant_id FROM sync_peers WHERE peer_device_id = ?")
			.pluck()
			.get(p.localDeviceId),
	).toBe("grant-1");
});

it("pins with a grant in plaintext, then clears the grant only after a Noise status", async () => {
	const p = await pair({ gate: true });
	// The seed does not know the worker yet. A coordinator vouches for the worker's grant.
	p.store.db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(p.peerDeviceId);
	const config = join(dirname(p.peerKeysDir), "config.json");
	writeFileSync(
		config,
		JSON.stringify({
			sync_coordinator_url: "http://coord.invalid",
			sync_coordinator_groups: ["g1"],
		}),
	);
	vi.stubEnv("CODEMEM_CONFIG", config);
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "fixture-secret");
	const enrollment = (deviceId: string, publicKey: string) => ({
		group_id: "g1",
		device_id: deviceId,
		public_key: publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		enabled: 1,
		identity_id: null,
		display_name: null,
		created_at: "2026-01-01T00:00:00Z",
	});
	const receipt = {
		authorization_version: 1,
		grant: {
			grant_id: "grant-1",
			group_id: "g1",
			seed_device_id: p.localDeviceId,
			worker_device_id: p.peerDeviceId,
			expires_at: "2099-01-01T00:00:00Z",
			created_at: "2026-01-01T00:00:00Z",
			created_by: null,
			revoked_at: null,
		},
		seed_enrollment: enrollment(p.localDeviceId, p.localPublicKey),
		worker_enrollment: enrollment(p.peerDeviceId, p.peerPublicKey),
	};
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
		String(input).includes("/v1/admin/bootstrap-grants/grant-1")
			? new Response(JSON.stringify(receipt), { status: 200 })
			: realFetch(input, init),
	);
	promotePeerToNoiseRequired(p.client.db, p.localDeviceId, "transport_statement");
	p.client.db
		.prepare(
			"UPDATE sync_peers SET pending_bootstrap_grant_id = 'grant-1' WHERE peer_device_id = ?",
		)
		.run(p.localDeviceId);

	const result = await p.sync();

	expect(result).toMatchObject({ ok: true });
	expect(p.plainPaths).toEqual(["/v1/status"]);
	expect(
		p.client.db
			.prepare("SELECT pending_bootstrap_grant_id FROM sync_peers WHERE peer_device_id = ?")
			.pluck()
			.get(p.localDeviceId),
	).toBeNull();
});

it("refuses plaintext when the peer is promoted while its upgrade is pending", async () => {
	let client: MemoryStore | undefined;
	let serverDeviceId = "";
	// The old listener answers the upgrade as an ordinary 404, and the promotion lands first.
	const p = await pair({
		gate: false,
		onPlain: (path) => {
			if (path === "/v1/noise" && client)
				promotePeerToNoiseRequired(client.db, serverDeviceId, "transport_statement");
		},
	});
	client = p.client;
	serverDeviceId = p.localDeviceId;

	const result = await p.sync();

	expect(result.ok).toBe(false);
	expect(result.error).toContain("noise_required");
	expect(syncPaths(p.plainPaths)).toEqual([]);
});

it("does not let a plaintext status unlock a snapshot over Noise", async () => {
	const p = await pair({ gate: false });
	const execute = peerTransportExecutor({
		db: p.client.db,
		peerDeviceId: p.localDeviceId,
		localDeviceId: p.peerDeviceId,
		keysDir: p.peerKeysDir,
		active: true,
	});
	const statusUrl = `http://${p.address}/v1/status`;
	const headers = buildDirectPeerAuthHeaders({
		deviceId: p.peerDeviceId,
		recipientId: p.localDeviceId,
		method: "GET",
		url: statusUrl,
		bodyBytes: Buffer.alloc(0),
		keysDir: p.peerKeysDir,
	});
	expect((await execute("GET", statusUrl, { operation: "status", headers }))[0]).toBe(200);
	promotePeerToNoiseRequired(p.client.db, p.localDeviceId, "transport_statement");

	await expect(
		execute("GET", `http://${p.address}/v1/snapshot?limit=1`, { operation: "snapshot" }),
	).rejects.toThrow(/status_first/);
	expect(syncPaths(p.plainPaths)).toEqual(["/v1/status"]);
});

it("sends no inner request and promotes nothing when the pin rotates during the handshake", async () => {
	let rotate = () => {};
	const p = await pair({ gate: true, onGate: () => rotate() });
	const otherDir = join(dirname(p.peerKeysDir), "local-keys-other");
	mkdirSync(otherDir, { recursive: true });
	generateKeypair(...resolveKeyPaths(otherDir));
	const other = loadPublicKey(otherDir);
	if (!other) throw new Error("second fixture key missing");
	rotate = () => {
		rotate = () => {};
		p.client.db
			.prepare(
				"UPDATE sync_peers SET public_key = ?, pinned_fingerprint = ? WHERE peer_device_id = ?",
			)
			.run(other, fingerprintPublicKey(other), p.localDeviceId);
	};

	const result = await p.sync();

	expect(result.ok).toBe(false);
	expect(result.error).toContain("peer key changed during the handshake");
	expect(p.policy()).toBe("legacy_plaintext");
	// Only the upgrade request used a nonce. No signed request crossed the stream.
	expect(nonceCount(p)).toBe(1);
});

it("sends no plaintext to any address when a reachability pass meets a required peer", async () => {
	const p = await pair({ gate: false });
	const second = await pair({ gate: false });
	promotePeerToNoiseRequired(p.client.db, p.localDeviceId, "pairing_payload");

	const result = await runReachableSyncPass(
		p.client.db,
		p.localDeviceId,
		[p.address, second.address],
		{
			keysDir: p.peerKeysDir,
			dbPath: p.client.dbPath,
			scanner: p.client.scanner,
			directNoise: { active: true },
			reachability: { scopeId: SCOPE, logicalOrigin: "https://relay.codemem.invalid" },
		},
	);

	expect(result.ok).toBe(false);
	expect(syncPaths(p.plainPaths)).toEqual([]);
	expect(syncPaths(second.plainPaths)).toEqual([]);
});

it("does not follow a redirect on the plaintext grant status", async () => {
	const p = await pair({ gate: false });
	promotePeerToNoiseRequired(p.client.db, p.localDeviceId, "transport_statement");
	p.client.db
		.prepare(
			"UPDATE sync_peers SET pending_bootstrap_grant_id = 'grant-1' WHERE peer_device_id = ?",
		)
		.run(p.localDeviceId);
	const redirected: string[] = [];
	const target = createHttpServer((request, response) => {
		redirected.push(request.url ?? "");
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise((resolve) => target.close(resolve)));
	const targetPort = (target.address() as AddressInfo).port;
	const redirector = createHttpServer((_request, response) => {
		response.writeHead(307, {
			location: `http://127.0.0.1:${targetPort}/v1/status?transport=noise1`,
		});
		response.end();
	});
	await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise((resolve) => redirector.close(resolve)));

	const result = await syncOnce(
		p.client.db,
		p.localDeviceId,
		[`127.0.0.1:${(redirector.address() as AddressInfo).port}`],
		{ keysDir: p.peerKeysDir, dbPath: p.client.dbPath, directNoise: { active: true } },
	);

	expect(result.ok).toBe(false);
	expect(redirected).toEqual([]);
});

/** A status request from the client peer through the shared policy, signed as a sync pass signs it. */
function statusThroughPolicy(
	p: Awaited<ReturnType<typeof pair>>,
	execute: ReturnType<typeof peerTransportExecutor>,
) {
	const url = `http://${p.address}/v1/status`;
	const headers = buildDirectPeerAuthHeaders({
		deviceId: p.peerDeviceId,
		recipientId: p.localDeviceId,
		method: "GET",
		url,
		bodyBytes: Buffer.alloc(0),
		keysDir: p.peerKeysDir,
	});
	return execute("GET", url, { operation: "status", headers });
}

it.each(["legacy_plaintext", "noise_required"] as const)(
	"sends no plaintext for a %s peer while the seed answers a flood with busy",
	async (policy) => {
		// One stream per peer, and the client already holds it, so every upgrade gets 503 busy.
		const p = await pair({ gate: true, gateLimits: { streamsPerPeer: 1 } });
		if (policy === "noise_required")
			promotePeerToNoiseRequired(p.client.db, p.localDeviceId, "transport_statement");
		const [host, port] = p.address.split(":");
		const held = await directNoiseConnectionFactory({
			db: p.client.db,
			host: host ?? "",
			port: Number(port),
			localDeviceId: p.peerDeviceId,
			peerDeviceId: p.localDeviceId,
			keysDir: p.peerKeysDir,
			expectedPin: p.localPublicKey,
		}).open({ signal: new AbortController().signal, deadlineMs: performance.now() + 5_000 });
		cleanups.push(() => held.dispose(new Error("test finished")));
		const execute = peerTransportExecutor({
			db: p.client.db,
			peerDeviceId: p.localDeviceId,
			localDeviceId: p.peerDeviceId,
			keysDir: p.peerKeysDir,
			active: true,
			busyRetry: { attempts: 3, baseMs: 5, maxMs: 20 },
		});

		const flood = await Promise.allSettled(
			Array.from({ length: 8 }, () => statusThroughPolicy(p, execute)),
		);

		for (const outcome of flood) {
			expect(outcome.status).toBe("rejected");
			expect(String((outcome as PromiseRejectedResult).reason)).toContain("noise_busy");
		}
		expect(p.plainPaths).toEqual([]);
		expect(p.policy()).toBe(policy);
	},
);

it("recovers a burst behind one address within the retry bound", async () => {
	// One pending handshake per address, so a burst of upgrades mostly starts with 503 busy.
	const p = await pair({ gate: true, gateLimits: { pendingPerIp: 1, streamsPerPeer: 64 } });
	promotePeerToNoiseRequired(p.client.db, p.localDeviceId, "transport_statement");
	const execute = peerTransportExecutor({
		db: p.client.db,
		peerDeviceId: p.localDeviceId,
		localDeviceId: p.peerDeviceId,
		keysDir: p.peerKeysDir,
		active: true,
	});

	const burst = await Promise.all(
		Array.from({ length: 12 }, () => statusThroughPolicy(p, execute)),
	);

	expect(burst.map(([status]) => status)).toEqual(Array(12).fill(200));
	expect(p.plainPaths).toEqual([]);
});

it("sends no plaintext for a legacy peer when the listener's socket cap closes its connections", async () => {
	const p = await pair({ gate: true, listenerLimits: { maxSocketsPerIp: 1 } });
	const [host, port] = p.address.split(":");
	// One idle socket from this address fills the cap, so the listener closes every new one at once.
	const idle = await new Promise<import("node:net").Socket>((resolve) => {
		const socket = connectSocket({ host, port: Number(port) }, () => resolve(socket));
	});
	cleanups.push(() => idle.destroy());
	const execute = peerTransportExecutor({
		db: p.client.db,
		peerDeviceId: p.localDeviceId,
		localDeviceId: p.peerDeviceId,
		keysDir: p.peerKeysDir,
		active: true,
		busyRetry: { attempts: 3, baseMs: 5, maxMs: 20 },
	});

	await expect(statusThroughPolicy(p, execute)).rejects.toThrow(
		"noise_busy: peer still busy (closed with no answer) after 3 attempts; try again later",
	);
	expect(p.plainPaths).toEqual([]);
	expect(p.policy()).toBe("legacy_plaintext");
});
