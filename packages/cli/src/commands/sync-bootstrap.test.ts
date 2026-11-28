import { writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import {
	fingerprintPublicKey,
	MemoryStore,
	readPeerTransportPolicy,
	resolveDbPath,
} from "@codemem/core";
import { serve } from "@hono/node-server";
import { afterEach, expect, it, vi } from "vitest";
import { promotePeerToNoiseRequired } from "../../../core/src/sync-transport-policy.js";
import { createSyncApp } from "../../../viewer-server/src/sync-app.js";
import { channelStore } from "../../../viewer-server/src/sync-channel-dispatch-test-fixtures.js";
import { createGuardedSyncServer } from "../../../viewer-server/src/sync-listener-guard.js";
import { runSyncBootstrap } from "./sync-bootstrap.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	process.exitCode = undefined;
});

/**
 * A seed behind the guarded listener, and a worker store that pinned it.
 * The default stream's snapshot is empty, so these tests check where the
 * requests went, not what they carried.
 */
async function seedAndWorker(options: { gate: boolean }) {
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
	const workerDbPath = join(dirname(f.peerKeysDir), "peer.sqlite");
	const worker = new MemoryStore(workerDbPath);
	cleanups.push(() => worker.close());
	const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	worker.db
		.prepare(
			"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, public_key, addresses_json, created_at) VALUES (?, 'Seed', ?, ?, ?, ?)",
		)
		.run(
			f.localDeviceId,
			fingerprintPublicKey(f.localPublicKey),
			f.localPublicKey,
			JSON.stringify([address]),
			"2026-01-01T00:00:00Z",
		);
	const output: string[] = [];
	vi.spyOn(console, "log").mockImplementation((line: unknown) => {
		output.push(String(line));
	});
	const bootstrap = (extra: { bootstrapGrant?: string } = {}) =>
		runSyncBootstrap(
			f.localDeviceId,
			{
				pageSize: "100",
				dbPath: resolveDbPath(workerDbPath),
				keysDir: f.peerKeysDir,
				force: true,
				json: true,
				...extra,
			},
			{ directNoise: { active: true } },
		);
	const result = () => JSON.parse(output.at(-1) ?? "{}") as Record<string, unknown>;
	const policy = () => readPeerTransportPolicy(worker.db, f.localDeviceId);
	return { ...f, worker, plainPaths, bootstrap, result, policy };
}

const syncPaths = (paths: string[]) => paths.filter((path) => path !== "/v1/noise");

it("bootstraps over Noise with no plaintext sync request, and promotes the seed", async () => {
	const s = await seedAndWorker({ gate: true });

	await s.bootstrap();

	expect(s.result()).toMatchObject({ ok: true, applied: 0 });
	expect(s.plainPaths).toEqual([]);
	expect(s.policy()).toBe("noise_required");
});

it("sends no plaintext to a noise_required seed whose Upgrade is refused", async () => {
	const s = await seedAndWorker({ gate: false });
	promotePeerToNoiseRequired(s.worker.db, s.localDeviceId, "pairing_payload");

	await s.bootstrap();

	expect(s.result()).toMatchObject({ ok: false });
	expect(String(s.result().error)).toContain("noise_required");
	expect(syncPaths(s.plainPaths)).toEqual([]);
	expect(process.exitCode).toBe(1);
});

it("falls back to plaintext once for a legacy seed that does not offer Noise", async () => {
	const s = await seedAndWorker({ gate: false });

	await s.bootstrap();

	expect(s.result()).toMatchObject({ ok: true, applied: 0 });
	expect(syncPaths(s.plainPaths)).toEqual(["/v1/status", "/v1/snapshot"]);
	expect(s.policy()).toBe("legacy_plaintext");
});

it("pins with the grant in plaintext, then bootstraps over Noise", async () => {
	const s = await seedAndWorker({ gate: true });
	// The seed does not know the worker yet. A coordinator vouches for its grant.
	s.store.db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(s.peerDeviceId);
	const config = join(dirname(s.peerKeysDir), "config.json");
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
			seed_device_id: s.localDeviceId,
			worker_device_id: s.peerDeviceId,
			expires_at: "2099-01-01T00:00:00Z",
			created_at: "2026-01-01T00:00:00Z",
			created_by: null,
			revoked_at: null,
		},
		seed_enrollment: enrollment(s.localDeviceId, s.localPublicKey),
		worker_enrollment: enrollment(s.peerDeviceId, s.peerPublicKey),
	};
	const realFetch = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
		String(input).includes("/v1/admin/bootstrap-grants/grant-1")
			? new Response(JSON.stringify(receipt), { status: 200 })
			: realFetch(input, init),
	);
	promotePeerToNoiseRequired(s.worker.db, s.localDeviceId, "transport_statement");

	await s.bootstrap({ bootstrapGrant: "grant-1" });

	expect(s.result()).toMatchObject({ ok: true, applied: 0 });
	expect(s.plainPaths).toEqual(["/v1/status"]);
});

it("keeps today's plaintext requests while direct Noise is off, even for a noise_required seed", async () => {
	const s = await seedAndWorker({ gate: true });
	promotePeerToNoiseRequired(s.worker.db, s.localDeviceId, "pairing_payload");

	await runSyncBootstrap(s.localDeviceId, {
		pageSize: "100",
		dbPath: s.worker.dbPath,
		keysDir: s.peerKeysDir,
		force: true,
		json: true,
	});

	expect(s.result()).toMatchObject({ ok: true, applied: 0 });
	expect(s.plainPaths).toEqual(["/v1/status", "/v1/snapshot"]);
});
