import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, removePairingState } from "@codemem/core";
import { afterEach, expect, it } from "vitest";
import { syncScopedChannelOnce } from "../../core/src/sync-channel-pass.js";
import {
	getSyncChannelProgress,
	saveSyncChannelCompletedBoundary,
} from "../../core/src/sync-channel-progress.js";
import { getReplicationCursor } from "../../core/src/sync-replication.js";
import { createApp } from "./index.js";
import { SCOPE } from "./sync-channel-dispatch-test-fixtures.js";
import { passFixture } from "./sync-channel-pass-test-fixtures.js";

type Fixture = Awaited<ReturnType<typeof passFixture>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function titles(f: Fixture, side: "client" | "remote") {
	const store = side === "client" ? f.client : f.remote.store;
	return store.db
		.prepare("SELECT title FROM memory_items WHERE scope_id = ? ORDER BY title")
		.pluck()
		.all(SCOPE);
}

it("H7: remove, then pair the same device ID again: both sides exchange the full history, including operations the peer had acknowledged", async () => {
	const f = await passFixture();
	cleanups.push(f.cleanup);
	const peerDeviceId = f.remote.localDeviceId;
	f.seed("remote", "remote-before");
	f.seed("client", "client-before");
	expect((await syncScopedChannelOnce(f.options)).ok).toBe(true);
	expect(getSyncChannelProgress(f.client.db, peerDeviceId, SCOPE)?.last_acked_cursor).toContain(
		"client-before-op",
	);
	const pairing = f.client.db
		.prepare("SELECT * FROM sync_peers WHERE peer_device_id = ?")
		.get(peerDeviceId) as Record<string, unknown>;

	removePairingState(f.client.db, {
		localDeviceId: f.client.deviceId,
		reason: "local",
		deviceIds: [peerDeviceId],
	});
	expect(getReplicationCursor(f.client.db, peerDeviceId, SCOPE)).toEqual([null, null]);
	expect(getSyncChannelProgress(f.client.db, peerDeviceId, SCOPE)).toBeNull();

	// These sort before the acknowledged operations, so a kept position would skip them.
	f.seed("remote", "remote-after");
	f.seed("client", "client-after");
	const columns = Object.keys(pairing);
	f.client.db
		.prepare(
			`INSERT INTO sync_peers (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		)
		.run(...Object.values(pairing));
	const requestsBeforePairingAgain = f.requests.length;

	const result = await syncScopedChannelOnce(f.options);

	// Inbound: the peer's whole history arrives again as a snapshot.
	expect(result).toMatchObject({ ok: true, bootstrapped: true });
	const afterPairingAgain = f.requests.slice(requestsBeforePairingAgain);
	expect(afterPairingAgain.map((request) => new URL(request.url).pathname)).toContain(
		"/v1/snapshot",
	);
	// Outbound: the operation the peer had already acknowledged is sent again.
	const pushed = afterPairingAgain
		.filter((request) => request.method === "POST")
		.flatMap(
			(request) =>
				(JSON.parse(new TextDecoder().decode(request.bodyBytes)) as { ops: { op_id: string }[] })
					.ops,
		)
		.map((op) => op.op_id);
	expect(pushed).toEqual(["client-after-op", "client-before-op"]);
	const everything = ["client-after", "client-before", "remote-after", "remote-before"];
	expect(titles(f, "client")).toEqual(everything);
	expect(titles(f, "remote")).toEqual(everything);
});

it("DELETE /api/sync/peers/:peer_device_id deletes the pairing and all its sync progress and ends the binding", async () => {
	const directory = mkdtempSync(join(tmpdir(), "viewer-peer-delete-"));
	const store = new MemoryStore(join(directory, "mem.sqlite"));
	cleanups.push(async () => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	const now = "2026-11-17T00:00:00.000Z";
	store.db
		.prepare("INSERT INTO sync_peers(peer_device_id, name, created_at) VALUES ('peer-1', 'Old', ?)")
		.run(now);
	store.db
		.prepare(
			"INSERT INTO replication_cursors(peer_device_id, last_applied_cursor, updated_at) VALUES ('peer-1', 'c1', ?)",
		)
		.run(now);
	store.db
		.prepare(
			"INSERT INTO replication_cursors_v2(peer_device_id, scope_id, last_applied_cursor, updated_at) VALUES ('peer-1', 'scope-a', 'c2', ?)",
		)
		.run(now);
	store.db
		.prepare(
			`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
			 revision, migration_state, idempotency_key, created_at, updated_at)
			 VALUES ('peer-1', 'identity-a', 'Old', 'active', 'test', '1', 'user_managed', 'binding:peer-1', ?, ?)`,
		)
		.run(now, now);

	saveSyncChannelCompletedBoundary(store.db, {
		peerDeviceId: "peer-1",
		scopeId: "scope-a",
		boundary: { generation: 1, snapshot_id: "snapshot-1", baseline_cursor: null },
	});

	const response = await createApp({ storeFactory: () => store }).request(
		"/api/sync/peers/peer-1",
		{ method: "DELETE" },
	);

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ok: true });
	const count = (table: string) =>
		store.db.prepare(`SELECT COUNT(*) FROM ${table} WHERE peer_device_id = 'peer-1'`).pluck().get();
	expect([
		count("sync_peers"),
		count("replication_cursors"),
		count("replication_cursors_v2"),
		count("sync_channel_progress"),
	]).toEqual([0, 0, 0, 0]);
	expect(
		store.db
			.prepare("SELECT status FROM identity_devices WHERE device_id = 'peer-1'")
			.pluck()
			.get(),
	).toBe("removed");
});
