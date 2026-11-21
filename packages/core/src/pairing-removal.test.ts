import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revokeUnauthorizedCoordinatorPeerTrust } from "./coordinator-runtime.js";
import { ensureMemoryRetirementDeliverySchema } from "./memory-retirement-delivery-schema.js";
import { getRetirementPeer } from "./memory-retirement-trust.js";
import { type PairingRemovalInput, removePairingState } from "./pairing-removal.js";
import { readRetainedPeerProjectFilters } from "./peer-project-filter-retention.js";
import { listRetiredDeviceAliases } from "./retired-device-aliases.js";
import {
	getSyncChannelProgress,
	saveSyncChannelCompletedBoundary,
	saveSyncChannelOutboundAck,
} from "./sync-channel-progress.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import {
	getReplicationCursor,
	setReplicationCursor,
	syncProjectAllowed,
} from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-11-17T00:00:00.000Z";
const LOCAL = "local";
let db: InstanceType<typeof Database>;

/** A well-formed SSH Ed25519 key whose 32 key bytes all equal `byte`. */
function sshKey(byte: number): string {
	const type = Buffer.from("ssh-ed25519");
	const length = (value: number) => Buffer.from([0, 0, 0, value]);
	const wire = Buffer.concat([length(type.length), type, length(32), Buffer.alloc(32, byte)]);
	return `ssh-ed25519 ${wire.toString("base64")}`;
}

function pair(deviceId: string, publicKey: string, provenance: string | null = null) {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at,
		 trust_provenance, discovered_via_coordinator_id, discovered_via_group_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		deviceId,
		fingerprintPublicKey(publicKey),
		publicKey,
		NOW,
		provenance,
		provenance ? "coord" : null,
		provenance ? "group" : null,
	);
}

function bind(deviceId: string) {
	db.prepare(
		`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
		 revision, migration_state, idempotency_key, created_at, updated_at)
		 VALUES (?, 'identity-a', 'Laptop', 'active', 'test', '1', 'user_managed', ?, ?, ?)`,
	).run(deviceId, `key:${deviceId}`, NOW, NOW);
}

function addProgress(deviceId: string) {
	db.prepare(
		"INSERT INTO replication_cursors(peer_device_id, last_applied_cursor, updated_at) VALUES (?, 'c1', ?)",
	).run(deviceId, NOW);
	const scoped = db.prepare(
		"INSERT INTO replication_cursors_v2(peer_device_id, scope_id, last_applied_cursor, updated_at) VALUES (?, ?, 'c2', ?)",
	);
	scoped.run(deviceId, "scope-a", NOW);
	scoped.run(deviceId, "scope-b", NOW);
	saveSyncChannelCompletedBoundary(db, {
		peerDeviceId: deviceId,
		scopeId: "scope-a",
		boundary: { generation: 1, snapshot_id: "snapshot-1", baseline_cursor: null },
	});
}

function addHistory(deviceId: string) {
	db.prepare(
		"INSERT INTO sync_attempts(peer_device_id, started_at, ok, ops_in, ops_out) VALUES (?, ?, 1, 0, 0)",
	).run(deviceId, NOW);
	db.prepare(
		`INSERT INTO sync_scope_rejections(peer_device_id, op_id, entity_type, entity_id, reason, created_at)
		 VALUES (?, 'op-1', 'memory_item', 'm-1', 'scope_not_authorized', ?)`,
	).run(deviceId, NOW);
}

function count(table: string, column: string, deviceId: string): number {
	return Number(
		db.prepare(`SELECT COUNT(*) FROM ${table} WHERE ${column} = ?`).pluck().get(deviceId),
	);
}

function state(deviceId: string) {
	return {
		pairings: count("sync_peers", "peer_device_id", deviceId),
		cursors: count("replication_cursors", "peer_device_id", deviceId),
		cursorsV2: count("replication_cursors_v2", "peer_device_id", deviceId),
		channelProgress: count("sync_channel_progress", "peer_device_id", deviceId),
		binding:
			db.prepare("SELECT status FROM identity_devices WHERE device_id = ?").pluck().get(deviceId) ??
			null,
	};
}

const REMOVED = { pairings: 0, cursors: 0, cursorsV2: 0, channelProgress: 0, binding: "removed" };
const UNTOUCHED = { pairings: 1, cursors: 1, cursorsV2: 2, channelProgress: 1, binding: "active" };

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	ensureMemoryRetirementDeliverySchema(db);
	for (const [deviceId, byte] of [
		["peer-a", 2],
		["peer-b", 3],
		["peer-keep", 4],
	] as const) {
		pair(deviceId, sshKey(byte));
		bind(deviceId);
		addProgress(deviceId);
	}
});

afterEach(() => db.close());

const FILTER_PEER = "filter-peer";
const FILTERS = {
	projects_include_json: '["work","work-private"]',
	projects_exclude_json: '["work-private"]',
};
const REMOVAL_REASONS = ["local", "removed", "disconnect", "policy", "revoked"] as const;

function prepareRestrictedPeer(reason: PairingRemovalInput["reason"]): PairingRemovalInput {
	pair(FILTER_PEER, sshKey(6), reason === "policy" ? "coordinator_policy" : null);
	bind(FILTER_PEER);
	addProgress(FILTER_PEER);
	db.prepare(
		`UPDATE sync_peers SET projects_include_json = ?, projects_exclude_json = ?
		 WHERE peer_device_id = ?`,
	).run(FILTERS.projects_include_json, FILTERS.projects_exclude_json, FILTER_PEER);
	if (reason === "policy")
		return {
			localDeviceId: LOCAL,
			reason,
			pairings: [{ deviceId: FILTER_PEER, coordinatorId: "coord", groupId: "group" }],
		};
	return { localDeviceId: LOCAL, reason, deviceIds: [FILTER_PEER] };
}

describe("Project filters in the pairing removal transaction", () => {
	it.each(REMOVAL_REASONS)("retains restrictions when the reason is %s", (reason) => {
		const removal = prepareRestrictedPeer(reason);

		const counts = removePairingState(db, removal);

		expect(counts.syncPeers).toBe(1);
		expect(readRetainedPeerProjectFilters(db, FILTER_PEER)).toEqual(FILTERS);
		if (reason === "revoked") {
			expect(listRetiredDeviceAliases(db).has(FILTER_PEER)).toBe(true);
			return;
		}
		pair(FILTER_PEER, sshKey(6));
		expect(syncProjectAllowed(db, "work", FILTER_PEER)).toBe(true);
		expect(syncProjectAllowed(db, "play", FILTER_PEER)).toBe(false);
		expect(syncProjectAllowed(db, "work-private", FILTER_PEER)).toBe(false);
	});

	it.each(REMOVAL_REASONS)("rolls back retained filters when %s cleanup fails", (reason) => {
		const removal = prepareRestrictedPeer(reason);
		// Fail after the pairing delete stored the filters, before cleanup can commit.
		db.exec(`CREATE TRIGGER fail_after_retaining_filters BEFORE DELETE ON sync_channel_progress
			WHEN OLD.peer_device_id = 'filter-peer' AND EXISTS (
				SELECT 1 FROM peer_project_filter_retention WHERE peer_device_id = OLD.peer_device_id
			)
			BEGIN SELECT RAISE(ABORT, 'cleanup failed after retaining filters'); END`);

		expect(() => removePairingState(db, removal)).toThrow("cleanup failed after retaining filters");
		expect(readRetainedPeerProjectFilters(db, FILTER_PEER)).toBeNull();
		expect(state(FILTER_PEER)).toEqual(UNTOUCHED);
		expect(syncProjectAllowed(db, "work", FILTER_PEER)).toBe(true);
		expect(syncProjectAllowed(db, "play", FILTER_PEER)).toBe(false);
		expect(listRetiredDeviceAliases(db).has(FILTER_PEER)).toBe(false);
		expect(count("memory_retirement_peer_trust", "peer_device_id", FILTER_PEER)).toBe(0);
	});
});

describe("removePairingState", () => {
	it.each(["removed", "local", "revoked"] as const)(
		"H1: reason %s deletes the pairing and all three sync progress tables, ends the binding, and retains retirement trust for every ID",
		(reason) => {
			const counts = removePairingState(db, {
				localDeviceId: LOCAL,
				reason,
				deviceIds: ["peer-a", "peer-b"],
			});

			expect(counts).toEqual({
				syncPeers: 2,
				replicationCursors: 2,
				replicationCursorsV2: 4,
				syncChannelProgress: 2,
				identityDevices: 2,
			});
			expect(state("peer-a")).toEqual(REMOVED);
			expect(state("peer-b")).toEqual(REMOVED);
			expect(state("peer-keep")).toEqual(UNTOUCHED);
			expect(getRetirementPeer(db, { localDeviceId: LOCAL, peerDeviceId: "peer-a" })).toEqual({
				deviceId: "peer-a",
				publicKey: sshKey(2),
			});
		},
	);

	it("H1: ends an active binding that has no pairing", () => {
		bind("bound-only");

		const counts = removePairingState(db, {
			localDeviceId: LOCAL,
			reason: "removed",
			deviceIds: ["bound-only"],
		});

		expect(counts).toMatchObject({ syncPeers: 0, identityDevices: 1 });
		expect(state("bound-only").binding).toBe("removed");
	});

	it("H2: a failing statement leaves the pairing, all three sync progress tables, and the binding unchanged", () => {
		// The binding update is the last statement for peer-b, after peer-a fully succeeded.
		db.exec(`CREATE TRIGGER fail_binding_end BEFORE UPDATE ON identity_devices
			WHEN NEW.device_id = 'peer-b' BEGIN SELECT RAISE(ABORT, 'binding update failed'); END`);

		expect(() =>
			removePairingState(db, {
				localDeviceId: LOCAL,
				reason: "revoked",
				deviceIds: ["peer-a", "peer-b"],
			}),
		).toThrow("binding update failed");

		expect(state("peer-a")).toEqual(UNTOUCHED);
		expect(state("peer-b")).toEqual(UNTOUCHED);
		expect(listRetiredDeviceAliases(db).size).toBe(0);
		expect(count("memory_retirement_peer_trust", "peer_device_id", "peer-a")).toBe(0);
	});

	it("H3: per-Team device decisions survive because the binding row is not deleted", () => {
		db.prepare(
			`INSERT INTO policy_teams(team_id, display_name, status, provenance, revision,
			 migration_state, idempotency_key, created_at, updated_at)
			 VALUES ('team-a', 'Team', 'active', 'test', '1', 'native', 'team:a', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(team_id, device_id, decision, provenance,
			 revision, created_at, updated_at) VALUES ('team-a', 'peer-a', 'excluded', 'test', '1', ?, ?)`,
		).run(NOW, NOW);

		removePairingState(db, { localDeviceId: LOCAL, reason: "removed", deviceIds: ["peer-a"] });

		expect(count("identity_devices", "device_id", "peer-a")).toBe(1);
		expect(
			db
				.prepare("SELECT decision FROM policy_team_device_decisions WHERE device_id = 'peer-a'")
				.pluck()
				.all(),
		).toEqual(["excluded"]);
	});

	it("H4: records no retired alias for a removed device and one for a revoked device", () => {
		removePairingState(db, { localDeviceId: LOCAL, reason: "removed", deviceIds: ["peer-a"] });
		removePairingState(db, { localDeviceId: LOCAL, reason: "local", deviceIds: ["peer-keep"] });
		expect(listRetiredDeviceAliases(db).size).toBe(0);

		removePairingState(db, { localDeviceId: LOCAL, reason: "revoked", deviceIds: ["peer-b"] });

		expect([...listRetiredDeviceAliases(db)]).toEqual([
			["peer-b", expect.objectContaining({ kind: "key", fingerprint: expect.any(String) })],
		]);
	});

	it("H5: the coordinator-policy cleanup deletes all three sync progress tables and leaves the binding active", () => {
		pair("policy-peer", sshKey(5), "coordinator_policy");
		bind("policy-peer");
		addProgress("policy-peer");

		const counts = removePairingState(db, {
			localDeviceId: LOCAL,
			reason: "policy",
			pairings: [{ deviceId: "policy-peer", coordinatorId: "coord", groupId: "group" }],
		});

		expect(counts).toEqual({
			syncPeers: 1,
			replicationCursors: 1,
			replicationCursorsV2: 2,
			syncChannelProgress: 1,
			identityDevices: 0,
		});
		expect(state("policy-peer")).toEqual({ ...REMOVED, binding: "active" });
		expect(listRetiredDeviceAliases(db).size).toBe(0);
	});

	it("H5: the policy cleanup keeps the sync progress of a pairing that is no longer policy-derived", () => {
		const counts = removePairingState(db, {
			localDeviceId: LOCAL,
			reason: "policy",
			pairings: [{ deviceId: "peer-a", coordinatorId: "coord", groupId: "group" }],
		});

		expect(counts.syncPeers).toBe(0);
		expect(state("peer-a")).toEqual(UNTOUCHED);
	});

	it("H6: sync_attempts and sync_scope_rejections rows stay", () => {
		addHistory("peer-a");

		removePairingState(db, { localDeviceId: LOCAL, reason: "removed", deviceIds: ["peer-a"] });

		expect(count("sync_attempts", "peer_device_id", "peer-a")).toBe(1);
		expect(count("sync_scope_rejections", "peer_device_id", "peer-a")).toBe(1);
	});
});

describe("removePairingState with reason disconnect", () => {
	it("reason disconnect deletes the pairing and all three sync progress tables, keeps every binding, and retains retirement trust", () => {
		const bindingsBefore = db.prepare("SELECT * FROM identity_devices ORDER BY device_id").all();

		const counts = removePairingState(db, {
			localDeviceId: LOCAL,
			reason: "disconnect",
			deviceIds: ["peer-a", "peer-b"],
		});

		expect(counts).toEqual({
			syncPeers: 2,
			replicationCursors: 2,
			replicationCursorsV2: 4,
			syncChannelProgress: 2,
			identityDevices: 0,
		});
		expect(state("peer-a")).toEqual({ ...REMOVED, binding: "active" });
		expect(state("peer-b")).toEqual({ ...REMOVED, binding: "active" });
		expect(state("peer-keep")).toEqual(UNTOUCHED);
		expect(db.prepare("SELECT * FROM identity_devices ORDER BY device_id").all()).toEqual(
			bindingsBefore,
		);
		expect(getRetirementPeer(db, { localDeviceId: LOCAL, peerDeviceId: "peer-a" })).toEqual({
			deviceId: "peer-a",
			publicKey: sshKey(2),
		});
		expect(listRetiredDeviceAliases(db).size).toBe(0);
	});

	it("a failing statement under reason disconnect leaves the pairing and all three sync progress tables unchanged", () => {
		// The scoped cursor delete for peer-b runs after peer-a fully succeeded.
		db.exec(`CREATE TRIGGER fail_scoped_cursor_delete BEFORE DELETE ON replication_cursors_v2
			WHEN OLD.peer_device_id = 'peer-b' BEGIN SELECT RAISE(ABORT, 'cursor delete failed'); END`);

		expect(() =>
			removePairingState(db, {
				localDeviceId: LOCAL,
				reason: "disconnect",
				deviceIds: ["peer-a", "peer-b"],
			}),
		).toThrow("cursor delete failed");

		expect(state("peer-a")).toEqual(UNTOUCHED);
		expect(state("peer-b")).toEqual(UNTOUCHED);
		expect(count("memory_retirement_peer_trust", "peer_device_id", "peer-a")).toBe(0);
	});
});

describe("removePairingState boundaries", () => {
	it("H1: removes a pairing on a device that never installed the channel progress table, without installing it", () => {
		db.exec("DROP TABLE sync_channel_progress");

		const counts = removePairingState(db, {
			localDeviceId: LOCAL,
			reason: "removed",
			deviceIds: ["peer-a"],
		});

		expect(counts).toMatchObject({ syncPeers: 1, syncChannelProgress: 0 });
		expect(
			db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sync_channel_progress'").get(),
		).toBeUndefined();
	});

	it("never ends the binding of the device it runs on", () => {
		pair(LOCAL, sshKey(1));
		bind(LOCAL);

		const counts = removePairingState(db, {
			localDeviceId: LOCAL,
			reason: "local",
			deviceIds: [LOCAL],
		});

		expect(counts).toMatchObject({ syncPeers: 1, identityDevices: 0 });
		expect(state(LOCAL).binding).toBe("active");
	});
});

describe("coordinator-policy pairing cleanup", () => {
	it("H5: deletes all sync progress of a policy pairing with no shared Project and leaves its binding active", () => {
		pair("policy-peer", sshKey(5), "coordinator_policy");
		bind("policy-peer");
		addProgress("policy-peer");

		expect(revokeUnauthorizedCoordinatorPeerTrust(db, LOCAL)).toBe(1);

		expect(state("policy-peer")).toEqual({ ...REMOVED, binding: "active" });
		expect(state("peer-a")).toEqual(UNTOUCHED);
	});
});

describe("sync progress writes from a pass that outlives its pairing", () => {
	const boundary = { generation: 1, snapshot_id: "snapshot-1", baseline_cursor: null };
	const NO_PROGRESS = { cursors: 0, cursorsV2: 0, channelProgress: 0 };

	beforeEach(() => {
		removePairingState(db, { localDeviceId: LOCAL, reason: "local", deviceIds: ["peer-a"] });
	});

	it("setReplicationCursor writes nothing for the removed peer and still writes for a paired peer", () => {
		setReplicationCursor(db, "peer-a", { lastApplied: "late" }, "scope-a");
		setReplicationCursor(db, "peer-a", { lastApplied: "late", lastAcked: "late" });
		setReplicationCursor(db, "peer-keep", { lastApplied: "next" }, "scope-a");
		setReplicationCursor(db, "peer-keep", { lastAcked: "next-default" });

		expect(state("peer-a")).toMatchObject(NO_PROGRESS);
		expect(getReplicationCursor(db, "peer-keep", "scope-a")[0]).toBe("next");
		expect(getReplicationCursor(db, "peer-keep")).toEqual(["c1", "next-default"]);
	});

	it("saveSyncChannelCompletedBoundary writes nothing for the removed peer and still writes for a paired peer", () => {
		const next = { ...boundary, generation: 2 };

		saveSyncChannelCompletedBoundary(db, { peerDeviceId: "peer-a", scopeId: "scope-a", boundary });
		saveSyncChannelCompletedBoundary(db, {
			peerDeviceId: "peer-keep",
			scopeId: "scope-a",
			boundary: next,
		});

		expect(state("peer-a")).toMatchObject(NO_PROGRESS);
		expect(getSyncChannelProgress(db, "peer-keep", "scope-a")).toMatchObject({ generation: 2 });
	});

	it("saveSyncChannelOutboundAck skips the removed peer without an error and still saves for a paired peer", () => {
		const ack = (peerDeviceId: string) =>
			saveSyncChannelOutboundAck(db, { peerDeviceId, scopeId: "scope-a", boundary, cursor: "ack" });

		expect(() => ack("peer-a")).not.toThrow();
		ack("peer-keep");

		expect(state("peer-a")).toMatchObject(NO_PROGRESS);
		expect(getSyncChannelProgress(db, "peer-keep", "scope-a")?.last_acked_cursor).toBe("ack");
	});

	it("saveSyncChannelOutboundAck still reports changed progress for a paired peer", () => {
		expect(() =>
			saveSyncChannelOutboundAck(db, {
				peerDeviceId: "peer-keep",
				scopeId: "scope-a",
				boundary: { ...boundary, generation: 9 },
				cursor: "ack",
			}),
		).toThrow("channel progress changed");
	});
});
