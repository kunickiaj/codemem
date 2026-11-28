import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePairingInstanceSchema, readPairingInstanceId } from "./pairing-instance.js";
import { removePeerFromThisDevice } from "./peer-removal.js";
import {
	saveSyncChannelCompletedBoundary,
	saveSyncChannelOutboundAck,
} from "./sync-channel-progress.js";
import { getReplicationCursor, setReplicationCursor } from "./sync-replication.js";
import { initTestSchema, insertTestPeer } from "./test-utils.js";

const LOCAL = "device-local";
const PEER = "device-peer";
const BOUNDARY = { generation: 1, snapshot_id: "snapshot-1", baseline_cursor: null };

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	insertTestPeer(db, PEER);
});

afterEach(() => db.close());

/** The pairing is deleted by Unpair and created again, as discovery or a bootstrap grant does. */
function unpairAndPairAgain() {
	removePeerFromThisDevice(db, { localDeviceId: LOCAL, peerDeviceId: PEER });
	insertTestPeer(db, PEER);
}

describe("pairing instance IDs", () => {
	it("gives each pairing its own ID, also one created again under the same device ID", () => {
		const first = readPairingInstanceId(db, PEER);
		unpairAndPairAgain();
		const second = readPairingInstanceId(db, PEER);

		expect(first).toMatch(/^[0-9a-f]{32}$/);
		expect(second).toMatch(/^[0-9a-f]{32}$/);
		expect(second).not.toBe(first);
	});

	it("keeps the ID when a pairing row is updated", () => {
		const before = readPairingInstanceId(db, PEER);
		db.prepare("UPDATE sync_peers SET name = 'Renamed' WHERE peer_device_id = ?").run(PEER);

		expect(readPairingInstanceId(db, PEER)).toBe(before);
	});

	it("adds the column and an ID to pairings that exist before it", () => {
		const old = new Database(":memory:");
		try {
			old.exec(
				"CREATE TABLE sync_peers (peer_device_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)",
			);
			old
				.prepare("INSERT INTO sync_peers(peer_device_id, created_at) VALUES ('older-peer', 'then')")
				.run();
			expect(readPairingInstanceId(old, "older-peer")).toBeNull();

			ensurePairingInstanceSchema(old);
			old
				.prepare("INSERT INTO sync_peers(peer_device_id, created_at) VALUES ('newer-peer', 'now')")
				.run();

			expect(readPairingInstanceId(old, "older-peer")).toMatch(/^[0-9a-f]{32}$/);
			expect(readPairingInstanceId(old, "newer-peer")).toMatch(/^[0-9a-f]{32}$/);
		} finally {
			old.close();
		}
	});

	it("is null for a peer with no pairing", () => {
		expect(readPairingInstanceId(db, "nobody")).toBeNull();
	});
});

describe("progress writes that carry a pairing instance", () => {
	it("save a cursor into the pairing they started under", () => {
		const instance = readPairingInstanceId(db, PEER);

		setReplicationCursor(db, PEER, { lastAcked: "c1", pairingInstanceId: instance });

		expect(getReplicationCursor(db, PEER)[1]).toBe("c1");
	});

	it("skip a late acknowledgement after Unpair and a new pairing, so no history is skipped", () => {
		const started = readPairingInstanceId(db, PEER);
		unpairAndPairAgain();

		setReplicationCursor(db, PEER, { lastAcked: "late-ack", pairingInstanceId: started });

		expect(getReplicationCursor(db, PEER)).toEqual([null, null]);
		// The new pairing still saves its own progress.
		setReplicationCursor(db, PEER, {
			lastAcked: "fresh",
			pairingInstanceId: readPairingInstanceId(db, PEER),
		});
		expect(getReplicationCursor(db, PEER)[1]).toBe("fresh");
	});

	it("skip a late scoped cursor the same way", () => {
		const started = readPairingInstanceId(db, PEER);
		unpairAndPairAgain();

		setReplicationCursor(db, PEER, { lastApplied: "late", pairingInstanceId: started }, "scope-a");

		expect(getReplicationCursor(db, PEER, "scope-a")).toEqual([null, null]);
	});

	it("skip a late channel boundary and acknowledgement without raising", () => {
		const started = readPairingInstanceId(db, PEER);
		unpairAndPairAgain();

		saveSyncChannelCompletedBoundary(db, {
			peerDeviceId: PEER,
			scopeId: "scope-a",
			boundary: BOUNDARY,
			pairingInstanceId: started,
		});
		expect(() =>
			saveSyncChannelOutboundAck(db, {
				peerDeviceId: PEER,
				scopeId: "scope-a",
				boundary: BOUNDARY,
				cursor: "late",
				pairingInstanceId: started,
			}),
		).not.toThrow();

		expect(db.prepare("SELECT COUNT(*) FROM sync_channel_progress").pluck().get()).toBe(0);
	});

	it("still write for a caller that carries no instance", () => {
		setReplicationCursor(db, PEER, { lastApplied: "c1" });

		expect(getReplicationCursor(db, PEER)[0]).toBe("c1");
	});
});
