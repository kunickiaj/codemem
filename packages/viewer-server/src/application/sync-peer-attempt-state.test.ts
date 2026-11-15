import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTestSchema, MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { degradedDaemonState, latestFailedPeerIds } from "./sync-status.js";

const peers = {
	items: [
		{ peer_device_id: "peer-a", status: { peer_state: "online" } },
		{ peer_device_id: "peer-b", status: { peer_state: "online" } },
	],
	byId: {},
};

describe("derived daemon state across peers", () => {
	it("retains a peer failure when a different peer succeeds later", () => {
		expect(degradedDaemonState(peers, new Set(["peer-a"]))).toBe("degraded");
	});

	it("returns ok when no active peer has a recent failure", () => {
		expect(degradedDaemonState(peers, new Set())).toBe("ok");
	});

	it.each(["stale", "not_verified", undefined])(
		"does not degrade healthy online peers because an offline peer has %s history",
		(state) => {
			const mixed = {
				items: [
					{ peer_device_id: "online", status: { peer_state: "online" } },
					{
						peer_device_id: "offline",
						status: { peer_state: "offline" },
						...(state ? { sync_health: { state } } : {}),
					},
				],
				byId: {},
			};
			expect(degradedDaemonState(mixed, new Set(["offline"]))).toBe("ok");
		},
	);

	it.each(["offline", "stale", "unknown"])(
		"keeps an unavailable fleet informational when presence is %s",
		(availability) => {
			const offline = {
				items: [
					{
						peer_device_id: "offline",
						status: { peer_state: availability },
						sync_health: { state: "stale" },
					},
					{ peer_device_id: "legacy", status: { peer_state: availability } },
				],
				byId: {},
			};
			expect(degradedDaemonState(offline, new Set(["offline", "legacy"]))).toBe("offline-peers");
		},
	);

	it.each(["online", "degraded", "offline"])(
		"retains actionable transfer or negotiation errors when availability is %s",
		(availability) => {
			const failed = {
				items: [
					{
						peer_device_id: "failed",
						status: { peer_state: availability },
						sync_health: { state: "needs_attention" },
					},
				],
				byId: {},
			};
			expect(degradedDaemonState(failed, new Set())).toBe("degraded");
		},
	);

	it("uses directional health instead of old transport errors for a reachable peer", () => {
		const recovered = {
			items: [
				{
					peer_device_id: "recovered",
					status: { peer_state: "degraded" },
					sync_health: { state: "exchange_succeeded" },
				},
			],
			byId: {},
		};
		expect(degradedDaemonState(recovered, new Set(["recovered"]))).toBe("ok");
	});
});

it("finds a failed peer after more than 25 newer attempts by another peer", () => {
	const directory = mkdtempSync(join(tmpdir(), "codemem-recent-peer-test-"));
	const dbPath = join(directory, "mem.sqlite");
	const db = new Database(dbPath);
	initTestSchema(db);
	db.close();
	const store = new MemoryStore(dbPath);
	try {
		const insert = store.db.prepare(
			"INSERT INTO sync_attempts(peer_device_id, started_at, finished_at, ok, ops_in, ops_out, error) VALUES (?, ?, ?, ?, 0, 0, ?)",
		);
		const failedAt = new Date(Date.now() - 60_000).toISOString();
		insert.run("peer-a", failedAt, failedAt, 0, "sync failed");
		for (let index = 0; index < 26; index += 1) {
			const succeededAt = new Date(Date.now() - 30_000 + index * 1_000).toISOString();
			insert.run("peer-b", succeededAt, succeededAt, 1, null);
		}
		const activePeers = new Set(["peer-a", "peer-b"]);
		expect(latestFailedPeerIds(store, activePeers, () => true)).toEqual(new Set(["peer-a"]));
		const recoveredAt = new Date().toISOString();
		insert.run("peer-a", recoveredAt, recoveredAt, 1, null);
		expect(latestFailedPeerIds(store, activePeers, () => true)).toEqual(new Set());
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
