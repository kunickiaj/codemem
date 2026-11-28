import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildDirectPeerAuthHeaders, fingerprintPublicKey } from "@codemem/core";
import { afterEach, expect, it, vi } from "vitest";
import { promotePeerToNoiseRequired } from "../../core/src/sync-transport-policy.js";
import { createSyncApp } from "./sync-app.js";
import { channelStore, ORIGIN } from "./sync-channel-dispatch-test-fixtures.js";

const cleanups: (() => unknown)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function enrollment(role: string, deviceId: string, publicKey: string) {
	return {
		group_id: "g1",
		device_id: deviceId,
		public_key: publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		enabled: 1,
		identity_id: null,
		display_name: role,
		created_at: "2026-01-01T00:00:00Z",
	};
}

/** A seed that does not know the worker yet, and a coordinator that vouches for its grant. */
async function seed(noiseActive: boolean) {
	const f = await channelStore();
	cleanups.push(f.cleanup);
	f.store.db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(f.peerDeviceId);
	const config = join(dirname(f.peerKeysDir), "config.json");
	writeFileSync(
		config,
		JSON.stringify({
			sync_coordinator_url: "http://coord.invalid",
			sync_coordinator_groups: ["g1"],
		}),
	);
	vi.stubEnv("CODEMEM_CONFIG", config);
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "fixture-secret");
	const receipt = {
		authorization_version: 1,
		grant: {
			grant_id: "grant-1",
			group_id: "g1",
			seed_device_id: f.localDeviceId,
			worker_device_id: f.peerDeviceId,
			expires_at: "2099-01-01T00:00:00Z",
			created_at: "2026-01-01T00:00:00Z",
			created_by: "admin",
			revoked_at: null,
		},
		seed_enrollment: enrollment("Seed", f.localDeviceId, f.localPublicKey),
		worker_enrollment: enrollment("Worker", f.peerDeviceId, f.peerPublicKey),
	};
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		if (!String(input).includes("/v1/admin/bootstrap-grants/grant-1"))
			throw new Error(`unexpected ${String(input)}`);
		return new Response(JSON.stringify(receipt), { status: 200 });
	});
	const app = createSyncApp({
		storeFactory: f.storeFactory,
		mode: { kind: "plain-direct", noiseActive },
	});
	const read = async (target: string, auth: { grant: boolean } = { grant: true }) => {
		const url = `${ORIGIN}${target}`;
		const headers = buildDirectPeerAuthHeaders({
			deviceId: f.peerDeviceId,
			recipientId: f.localDeviceId,
			method: "GET",
			url,
			bodyBytes: Buffer.alloc(0),
			keysDir: f.peerKeysDir,
			bootstrapGrantId: auth.grant ? "grant-1" : undefined,
		});
		const response = await app.fetch(new Request(url, { headers }));
		return { status: response.status, body: (await response.json()) as Record<string, unknown> };
	};
	return { ...f, read, fetch };
}

it("answers a marked grant status with the pin only, and pins the worker", async () => {
	const s = await seed(true);

	const { status, body } = await s.read("/v1/status?transport=noise1");

	expect(status).toBe(200);
	expect(body).toEqual({
		device_id: s.localDeviceId,
		fingerprint: fingerprintPublicKey(s.localPublicKey),
		transport: "noise1",
	});
	expect(
		s.store.db
			.prepare("SELECT public_key FROM sync_peers WHERE peer_device_id = ?")
			.pluck()
			.get(s.peerDeviceId),
	).toBe(s.peerPublicKey);
});

it("refuses an unmarked grant status from a worker known to speak Noise once Noise is on", async () => {
	const on = await seed(true);
	promotePeerToNoiseRequired(on.store.db, on.peerDeviceId, "transport_statement");
	const refused = await on.read("/v1/status");
	expect(refused).toEqual({ status: 401, body: { error: "unauthorized" } });
});

it("keeps today's full grant status while Noise is off, even for such a worker", async () => {
	const off = await seed(false);
	promotePeerToNoiseRequired(off.store.db, off.peerDeviceId, "transport_statement");
	const served = await off.read("/v1/status");
	expect(served.status).toBe(200);
	expect(served.body).toHaveProperty("sync_reset");
});

it("does not accept a grant on snapshots once Noise is on", async () => {
	const s = await seed(true);

	const { status } = await s.read("/v1/snapshot?generation=1&snapshot_id=x&limit=1");

	expect(status).toBe(401);
	expect(s.fetch).not.toHaveBeenCalled();
});

const pinOnly = (s: Awaited<ReturnType<typeof seed>>) => ({
	device_id: s.localDeviceId,
	fingerprint: fingerprintPublicKey(s.localPublicKey),
	transport: "noise1",
});

it("answers a pinned worker's marked retry with the pin only, with or without the grant", async () => {
	const s = await seed(true);
	expect((await s.read("/v1/status?transport=noise1")).status).toBe(200);

	const signedOnly = await s.read("/v1/status?transport=noise1", { grant: false });
	const withGrant = await s.read("/v1/status?transport=noise1");

	expect(signedOnly).toEqual({ status: 200, body: pinOnly(s) });
	expect(withGrant).toEqual({ status: 200, body: pinOnly(s) });
});

it("refuses a pinned noise_required worker's signed plaintext reads once Noise is on", async () => {
	const s = await seed(true);
	expect((await s.read("/v1/status?transport=noise1")).status).toBe(200);
	promotePeerToNoiseRequired(s.store.db, s.peerDeviceId, "authenticated_exchange");

	const status = await s.read("/v1/status", { grant: false });
	const snapshot = await s.read("/v1/snapshot?generation=1&snapshot_id=x&limit=1", {
		grant: false,
	});

	expect(status).toEqual({ status: 401, body: { error: "unauthorized" } });
	expect(snapshot).toEqual({ status: 401, body: { error: "unauthorized" } });
});

it("treats the marker as an ordinary status and serves required workers while Noise is off", async () => {
	const s = await seed(false);
	const marked = await s.read("/v1/status?transport=noise1");
	promotePeerToNoiseRequired(s.store.db, s.peerDeviceId, "authenticated_exchange");
	const unmarked = await s.read("/v1/status", { grant: false });

	expect(marked.status).toBe(200);
	expect(marked.body).not.toHaveProperty("transport");
	expect(marked.body).toHaveProperty("sync_reset");
	expect(unmarked.status).toBe(200);
	expect(Object.keys(marked.body).sort()).toEqual(Object.keys(unmarked.body).sort());
});
