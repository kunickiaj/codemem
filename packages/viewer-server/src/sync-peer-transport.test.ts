import { writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import {
	applyReplicationOps,
	fingerprintPublicKey,
	MemoryStore,
	PeerTransportRefused,
	peerTransportExecutor,
	readPeerTransportPolicy,
	syncOnce,
} from "@codemem/core";
import { serve } from "@hono/node-server";
import { afterEach, expect, it, vi } from "vitest";
import { refreshTestScopeRows } from "../../core/src/scope-membership-cache-test-fixtures.js";
import { promotePeerToNoiseRequired } from "../../core/src/sync-transport-policy.js";
import { createSyncApp } from "./sync-app.js";
import { channelStore, memoryOp } from "./sync-channel-dispatch-test-fixtures.js";
import { createGuardedSyncServer } from "./sync-listener-guard.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

/** A real server store behind the guarded listener, and a client store that pinned it. */
async function pair(options: { gate: boolean }) {
	const f = await channelStore();
	cleanups.push(f.cleanup);
	const plainPaths: string[] = [];
	const app = createSyncApp({ storeFactory: f.storeFactory });
	const fetch = (request: Request) => {
		plainPaths.push(new URL(request.url).pathname);
		return app.fetch(request);
	};
	const keysDir = join(dirname(f.peerKeysDir), "local-keys");
	const createServer = createGuardedSyncServer({
		directNoise: { storeFactory: f.storeFactory, keysDir, active: options.gate },
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

	await expect(execute("GET", `http://${p.address}/v1/snapshot?limit=1`)).rejects.toThrow(
		PeerTransportRefused,
	);
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
