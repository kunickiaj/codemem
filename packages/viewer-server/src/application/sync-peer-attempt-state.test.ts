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
