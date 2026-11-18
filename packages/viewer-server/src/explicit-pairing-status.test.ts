import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintPublicKey, MemoryStore } from "@codemem/core";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./index.js";

const peerId = "fixture-peer";
const publicKey = "fixture-public-key";
const pin = fingerprintPublicKey(publicKey);
const previously = "2026-11-17T00:00:00.000Z";
const cleanup: Array<() => void> = [];

afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
	vi.restoreAllMocks();
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "codemem-explicit-pair-"));
	cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
	const store = new MemoryStore(join(directory, "mem.sqlite"));
	cleanup.push(() => store.close());
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
	store.db
		.prepare(`INSERT INTO sync_peers
		(peer_device_id, pinned_fingerprint, public_key, discovered_via_coordinator_id, trust_provenance, created_at)
		VALUES (?, ?, ?, 'https://coordinator.invalid', 'coordinator_policy', ?)`)
		.run(peerId, pin, publicKey, previously);
	const app = createApp({ storeFactory: () => store });
	const pair = () =>
		app.request("/api/sync/invites/import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				invite: JSON.stringify({
					device_id: peerId,
					fingerprint: pin,
					public_key: publicKey,
					addresses: ["http://127.0.0.1:7337"],
				}),
			}),
		});
	const status = async () => {
		const response = await app.request("/api/sync/status");
		expect(response.status).toBe(200);
		const { peers } = (await response.json()) as { peers: Record<string, unknown>[] };
		return peers.find((peer) => peer.peer_device_id === peerId);
	};
	return { store, fetch, pair, status, app };
}

it("saves an explicit pair without claiming a connection or changing Space access", async () => {
	const f = fixture();
	// Prior sync history remains stored, but cannot verify the newly saved pair.
	const earlierSync = new Date(Date.now() - 1_000).toISOString();
	f.store.db
		.prepare("UPDATE sync_peers SET last_sync_at = ? WHERE peer_device_id = ?")
		.run(earlierSync, peerId);
	const saved = await f.pair();
	expect(saved.status).toBe(200);
	expect(await saved.json()).toMatchObject({ ok: true, type: "pair" });
	expect(await f.status()).toMatchObject({
		pairing_saved_at: expect.any(String),
		last_seen_at: expect.any(String),
		last_sync_at: earlierSync,
		authorized_scopes: [],
		status: { peer_state: "unknown", ping_status: "unknown", fresh: false },
	});
	const peers = await f.app.request("/api/sync/peers");
	expect(peers.status).toBe(200);
	expect(await peers.json()).toMatchObject({
		items: [
			expect.objectContaining({ peer_device_id: peerId, pairing_saved_at: expect.any(String) }),
		],
	});
	expect(f.fetch).not.toHaveBeenCalled();
	expect(
		f.store.db
			.prepare("SELECT trust_provenance FROM sync_peers WHERE peer_device_id = ?")
			.pluck()
			.get(peerId),
	).toBe("coordinator_policy");
});

it.each(["trust", "scope"] as const)(
	"shows %s refusal until a real successful sync supersedes it",
	async (category) => {
		const f = fixture();
		const refuse = f.store.db.prepare(`INSERT INTO sync_attempts
			(peer_device_id, started_at, finished_at, ok, ops_in, ops_out, error, failure_category)
			VALUES (?, ?, ?, 0, 0, 0, 'fixture refusal', ?)`);
		const earlier = new Date(Date.now() - 1_000).toISOString();
		refuse.run(peerId, earlier, earlier, category);
		expect((await f.pair()).status).toBe(200);
		expect((await f.status())?.sync_health).not.toHaveProperty("authorization_failure");
		const attempt = new Date().toISOString();
		refuse.run(peerId, attempt, attempt, category);
		expect(await f.status()).toMatchObject({ sync_health: { authorization_failure: category } });
		f.store.db
			.prepare(`INSERT INTO sync_attempts
		(peer_device_id, started_at, finished_at, ok, ops_in, ops_out) VALUES (?, ?, ?, 1, 0, 0)`)
			.run(peerId, attempt, attempt);
		f.store.db
			.prepare("UPDATE sync_peers SET last_sync_at = ? WHERE peer_device_id = ?")
			.run(attempt, peerId);
		const status = await f.status();
		expect(status).toMatchObject({ status: { peer_state: "online", sync_status: "ok" } });
		expect(status?.sync_health).not.toHaveProperty("authorization_failure");
	},
);
