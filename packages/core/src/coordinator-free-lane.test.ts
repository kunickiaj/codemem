import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markCoordinatorManaged } from "./coordinator-free-attestation.js";
import {
	applyCoordinatorFreeOps,
	coordinatorFreeEligibility,
	coordinatorFreeInboundRejections,
	coordinatorFreeOutboundOps,
} from "./coordinator-free-lane.js";
import { reconcileStalePeerReceivedRows, setPeerProjectFilter } from "./index.js";
import { MemoryStore } from "./store.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";
import { updatePeerAddresses } from "./sync-peer-addresses.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

const PEER = "peer-device";
const PEER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPeerFixtureKeyNotARealKey000000000000000";

let directory: string;
let store: MemoryStore;
let local: string;
let keysDir: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "coordinator-free-lane-"));
	keysDir = join(directory, "keys");
	writeFileSync(join(directory, "config.json"), "{}");
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	const db = new Database(join(directory, "mem.sqlite"));
	initTestSchema(db);
	[local] = ensureDeviceIdentity(db, { keysDir });
	db.close();
	store = new MemoryStore(join(directory, "mem.sqlite"));
	pairExplicitly();
});

afterEach(() => {
	store.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function pairExplicitly(peer = PEER) {
	updatePeerAddresses(store.db, peer, ["127.0.0.1:7337"], {
		pinnedFingerprint: fingerprintPublicKey(PEER_KEY),
		publicKey: PEER_KEY,
		replaceTrust: true,
	});
}

function eligibility(peer = PEER) {
	return coordinatorFreeEligibility(store.db, {
		peerDeviceId: peer,
		channelAuthenticated: true,
		keysDir,
	});
}

function remember(title: string, visibility: "shared" | "private" = "shared") {
	const session = store.startSession({ cwd: directory, project: "lane" });
	const id = store.remember(session, "discovery", title, `${title} body`, 0.5, [], { visibility });
	const op = store.db
		.prepare(
			"SELECT * FROM replication_ops WHERE entity_id = (SELECT import_key FROM memory_items WHERE id = ?) ORDER BY created_at DESC LIMIT 1",
		)
		.get(id) as ReplicationOp;
	return { id, op };
}

/** An upsert the peer would send for a memory it created. */
function peerOp(entityId: string, overrides: Record<string, unknown> = {}, payload = {}) {
	const now = "2026-11-27T00:00:00.000Z";
	return {
		op_id: `${entityId}-op`,
		entity_type: "memory_item",
		entity_id: entityId,
		op_type: "upsert",
		// A full body, as the shared outbound decision builds it from the stored copy.
		payload_json: JSON.stringify({
			kind: "discovery",
			title: entityId,
			subtitle: null,
			body_text: "Peer body",
			narrative: null,
			facts: null,
			concepts: null,
			files_read: null,
			files_modified: null,
			tags_text: "",
			active: 1,
			deleted_at: null,
			visibility: "shared",
			workspace_id: null,
			workspace_kind: null,
			actor_id: null,
			metadata_json: {},
			created_at: now,
			updated_at: now,
			project: "lane",
			scope_id: "local-default",
			origin_device_id: PEER,
			...payload,
		}),
		clock_rev: 1,
		clock_updated_at: now,
		clock_device_id: PEER,
		device_id: PEER,
		created_at: now,
		scope_id: "local-default",
		...overrides,
	} as ReplicationOp;
}

function apply(ops: ReplicationOp[]) {
	return applyCoordinatorFreeOps(store.db, ops, {
		localDeviceId: local,
		peerDeviceId: PEER,
		peerFingerprint: fingerprintPublicKey(PEER_KEY),
		scanner: store.scanner,
	});
}

describe("each device decides from its own state whether a peer may sync without a coordinator", () => {
	it("allows an explicitly paired peer of a store that never used a coordinator", () => {
		expect(eligibility()).toEqual({ eligible: true });
		expect(
			coordinatorFreeEligibility(store.db, {
				peerDeviceId: PEER,
				channelAuthenticated: false,
				keysDir,
			}),
		).toEqual({ eligible: false, reason: "channel_not_authenticated" });
	});

	it("refuses when a coordinator is configured or the store was ever managed", () => {
		vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", "team-a");
		expect(eligibility()).toEqual({ eligible: false, reason: "coordinator_configured" });
		vi.stubEnv("CODEMEM_SYNC_COORDINATOR_GROUPS", undefined);
		markCoordinatorManaged(store.db, { keysDir });
		expect(eligibility()).toEqual({ eligible: false, reason: "store_not_standalone" });
	});

	it.each([
		["a pin without an explicit pairing", "explicit_pairing_fingerprint = NULL"],
		["a pin that changed after pairing", "explicit_pairing_fingerprint = 'old-key'"],
		["a peer found through a coordinator group", "discovered_via_group_id = 'team-a'"],
		["a peer pinned by a bootstrap grant", "pending_bootstrap_grant_id = 'grant-1'"],
		["a peer the coordinator vouched for", "trust_provenance = 'coordinator_policy'"],
	])("refuses %s", (_case, change) => {
		store.db.prepare(`UPDATE sync_peers SET ${change} WHERE peer_device_id = ?`).run(PEER);
		const reason = eligibility();
		expect(reason.eligible).toBe(false);
	});

	it("refuses every peer once a coordinator listed any device in this store", () => {
		expect(eligibility()).toEqual({ eligible: true });
		store.db
			.prepare(
				`INSERT INTO coordinator_history(subject_kind, device_id, fingerprint, source, recorded_at)
				 VALUES ('device', ?, '', 'coordinator_peer_list', 'now')`,
			)
			.run(PEER);
		// Any coordinator record closes the whole store before the peer's own history is read.
		expect(eligibility()).toEqual({ eligible: false, reason: "store_not_standalone" });
	});
});

describe("only this device's shared local-default memories leave it", () => {
	function outbound(ops: ReplicationOp[]) {
		return coordinatorFreeOutboundOps(store.db, ops, { localDeviceId: local, peerDeviceId: PEER })
			.allowed;
	}

	it("sends a shared memory and holds back private, review and forwarded ones", () => {
		const shared = remember("shared");
		const hidden = remember("private", "private");
		const review = remember("review");
		store.db
			.prepare("UPDATE memory_items SET scope_id = 'legacy-shared-review' WHERE id = ?")
			.run(review.id);
		const reviewOp = { ...review.op, scope_id: "legacy-shared-review" };
		const forwarded = peerOp("peer-memory");

		expect(outbound([shared.op, hidden.op, reviewOp, forwarded]).map((op) => op.op_id)).toEqual([
			shared.op.op_id,
		]);
	});

	it("doesn't resend a memory made private, forgotten or duplicated since", () => {
		const madePrivate = remember("made private");
		store.db
			.prepare("UPDATE memory_items SET visibility = 'private' WHERE id = ?")
			.run(madePrivate.id);
		const forgotten = remember("forgotten");
		store.db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(forgotten.id);
		const duplicated = remember("duplicated");
		store.db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
				 import_key, origin_device_id, visibility, scope_id, active)
				 SELECT session_id, kind, title, body_text, created_at, updated_at, import_key,
				 origin_device_id, visibility, scope_id, 1 FROM memory_items WHERE id = ?`,
			)
			.run(duplicated.id);

		expect(outbound([madePrivate.op, forgotten.op, duplicated.op])).toEqual([]);
	});

	it("holds back a memory whose session moved to a Project the pairing excludes, on replay", () => {
		const moved = remember("moved");
		setPeerProjectFilter(store.db, PEER, { include: null, exclude: ["held-back"] });
		expect(outbound([moved.op])).toHaveLength(1);
		// The memory's session moves to the excluded Project. The recorded op still names "lane".
		store.db
			.prepare(
				"UPDATE sessions SET project = 'held-back' WHERE id = (SELECT session_id FROM memory_items WHERE id = ?)",
			)
			.run(moved.id);

		expect(outbound([moved.op])).toEqual([]);
	});

	it("sends the stored copy's current content, not the payload the op recorded", () => {
		const edited = remember("recorded title");
		store.db.prepare("UPDATE memory_items SET title = 'current title' WHERE id = ?").run(edited.id);

		const [sent] = outbound([edited.op]);

		expect(JSON.parse(String(sent?.payload_json))).toMatchObject({ title: "current title" });
	});

	it("holds back deletes and Projects the pairing excludes", () => {
		const kept = remember("kept");
		const deleted = { ...kept.op, op_id: "delete-op", op_type: "delete" };
		setPeerProjectFilter(store.db, PEER, { include: null, exclude: ["lane"] });

		expect(outbound([kept.op, deleted])).toEqual([]);
	});
});

describe("a peer may only add and change its own shared local-default memories here", () => {
	it.each([
		["another device's op", { device_id: "other" }, {}],
		["another clock device", { clock_device_id: "other" }, {}],
		["another origin", {}, { origin_device_id: "other" }],
		["another scope", { scope_id: "legacy-shared-review" }, {}],
		["a payload in another scope", {}, { scope_id: "team-scope" }],
		["a private memory", {}, { visibility: "private" }],
		["a payload without visibility", {}, { visibility: undefined }],
		[
			"visibility only in metadata",
			{},
			{ visibility: undefined, metadata_json: { visibility: "shared" } },
		],
		["a visibility spelled another way", {}, { visibility: "Shared" }],
		["a deletion time on an upsert", {}, { deleted_at: "2026-11-27T00:00:00.000Z" }],
		["an inactive flag on an upsert", {}, { active: 0 }],
		["a delete that carries content", { op_type: "delete" }, {}],
	])("refuses %s", (_case, overrides, payload) => {
		expect(
			coordinatorFreeInboundRejections(store.db, [peerOp("m", overrides, payload)], PEER),
		).toEqual([{ op_id: "m-op", reason: "op_not_allowed" }]);
	});

	it("refuses changes to rows the peer didn't create and to ambiguous targets", () => {
		const own = remember("mine");
		const key = store.db
			.prepare("SELECT import_key FROM memory_items WHERE id = ?")
			.pluck()
			.get(own.id);
		expect(coordinatorFreeInboundRejections(store.db, [peerOp(String(key))], PEER)).toEqual([
			{ op_id: `${key}-op`, reason: "target_not_owned_by_sender" },
		]);
		apply([peerOp("twice")]);
		store.db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
				 import_key, origin_device_id, visibility, scope_id)
				 SELECT session_id, kind, title, body_text, created_at, updated_at, import_key,
				 origin_device_id, visibility, scope_id FROM memory_items WHERE import_key = 'twice'`,
			)
			.run();
		expect(coordinatorFreeInboundRejections(store.db, [peerOp("twice")], PEER)).toEqual([
			{ op_id: "twice-op", reason: "ambiguous_target" },
		]);
	});

	it("applies nothing from a batch with one refused op, and skips excluded Projects", () => {
		const refused = apply([peerOp("good"), peerOp("bad", {}, { visibility: "private" })]);
		expect(refused).toMatchObject({ applied: 0, rejections: [{ op_id: "bad-op" }] });
		setPeerProjectFilter(store.db, PEER, { include: null, exclude: ["held-back"] });

		const result = apply([peerOp("good"), peerOp("held", {}, { project: "held-back" })]);

		expect(result).toMatchObject({ applied: 1, skipped: 1, rejections: [] });
		expect(
			store.db
				.prepare("SELECT import_key FROM memory_items WHERE origin_device_id = ?")
				.pluck()
				.all(PEER),
		).toEqual(["good"]);
	});
});

describe("accepted replicas record their source", () => {
	it("records each accepted row and drops the record with the row", () => {
		apply([peerOp("kept")]);
		const id = store.db
			.prepare("SELECT id FROM memory_items WHERE import_key = 'kept'")
			.pluck()
			.get();
		expect(
			store.db
				.prepare(
					"SELECT memory_id, peer_device_id, peer_fingerprint FROM coordinator_free_replicas",
				)
				.all(),
		).toEqual([
			{ memory_id: id, peer_device_id: PEER, peer_fingerprint: fingerprintPublicKey(PEER_KEY) },
		]);

		store.db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);

		expect(store.db.prepare("SELECT COUNT(*) FROM coordinator_free_replicas").pluck().get()).toBe(
			0,
		);
	});

	it("keeps only the recorded row in the stale-row cleanup, not a sibling or a leaked row", () => {
		apply([peerOp("replica")]);
		const original = store.db
			.prepare("SELECT id FROM memory_items WHERE import_key = 'replica'")
			.pluck()
			.get();
		const copy = (importKey: string) =>
			store.db
				.prepare(
					`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
					 import_key, origin_device_id, visibility, scope_id, active)
					 SELECT session_id, kind, title, body_text, created_at, updated_at, ?,
					 origin_device_id, visibility, scope_id, 1 FROM memory_items WHERE id = ?`,
				)
				.run(importKey, original).lastInsertRowid;
		const sibling = copy("replica");
		const leaked = copy("leaked");

		const result = reconcileStalePeerReceivedRows(store.db, {
			localDeviceId: local,
			peerDeviceId: PEER,
			keysDir,
		});

		expect(result.deleted_memory_ids.sort()).toEqual([Number(sibling), Number(leaked)].sort());
		expect(
			store.db
				.prepare("SELECT import_key FROM memory_items WHERE origin_device_id = ?")
				.pluck()
				.all(PEER),
		).toEqual(["replica"]);
		expect(loadPublicKey(keysDir)).toBeTruthy();
	});

	it("cleans up normally on a store that never accepted a row this way", () => {
		const leaked = store.db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
				 import_key, origin_device_id, visibility, scope_id, active)
				 VALUES (?, 'discovery', 'leaked', 'body', 'now', 'now', 'leaked', ?, 'shared', 'local-default', 1)`,
			)
			.run(store.startSession({ cwd: directory, project: "lane" }), PEER).lastInsertRowid;

		const result = reconcileStalePeerReceivedRows(store.db, {
			localDeviceId: local,
			peerDeviceId: PEER,
			keysDir,
		});

		expect(result.deleted_memory_ids).toEqual([Number(leaked)]);
	});

	it("doesn't let a losing revision protect an old leaked row", () => {
		const session = store.startSession({ cwd: directory, project: "lane" });
		const leaked = store.db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
				 import_key, origin_device_id, visibility, scope_id, active, rev)
				 VALUES (?, 'discovery', 'leaked', 'body', 'now', '2026-11-28T00:00:00.000Z', 'old-key',
				 ?, 'shared', 'local-default', 1, 5)`,
			)
			.run(session, PEER).lastInsertRowid;

		const result = apply([
			peerOp("old-key", { clock_rev: 1 }),
			peerOp("old-key", { clock_rev: 1 }),
		]);
		const cleanup = reconcileStalePeerReceivedRows(store.db, {
			localDeviceId: local,
			peerDeviceId: PEER,
			keysDir,
		});

		expect(result).toMatchObject({ applied: 0, rejections: [] });
		expect(cleanup.deleted_memory_ids).toEqual([Number(leaked)]);
	});

	it.each([
		["leaves out the body", (payload: Record<string, unknown>) => delete payload.body_text],
		["sends the title as null", (payload: Record<string, unknown>) => (payload.title = null)],
		["leaves out the narrative", (payload: Record<string, unknown>) => delete payload.narrative],
	])("refuses a newer update that %s, so it can't vouch for a leaked body", (_case, change) => {
		const session = store.startSession({ cwd: directory, project: "lane" });
		const leaked = store.db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
				 import_key, origin_device_id, visibility, scope_id, active, rev)
				 VALUES (?, 'discovery', 'leaked', 'leaked body', 'now', '2026-11-27T00:00:00.000Z',
				 'leaked-key', ?, 'shared', 'local-default', 1, 1)`,
			)
			.run(session, PEER).lastInsertRowid;
		const op = peerOp("leaked-key", { clock_rev: 2, clock_updated_at: "2026-11-28T00:00:00.000Z" });
		const payload = JSON.parse(String(op.payload_json)) as Record<string, unknown>;
		change(payload);

		const result = apply([{ ...op, payload_json: JSON.stringify(payload) }]);
		const cleanup = reconcileStalePeerReceivedRows(store.db, {
			localDeviceId: local,
			peerDeviceId: PEER,
			keysDir,
		});

		expect(result.rejections).toEqual([{ op_id: "leaked-key-op", reason: "op_not_allowed" }]);
		expect(cleanup.deleted_memory_ids).toEqual([Number(leaked)]);
	});

	it("records a row once when a batch repeats its op", () => {
		apply([peerOp("twice-sent"), peerOp("twice-sent")]);
		expect(
			store.db.prepare("SELECT import_key FROM coordinator_free_replicas").pluck().all(),
		).toEqual(["twice-sent"]);
	});
});

describe("a memory this device forgot stays forgotten", () => {
	it("skips the peer's later edit instead of bringing it back", () => {
		apply([peerOp("forgotten", { clock_rev: 1 })]);
		store.db
			.prepare(
				"UPDATE memory_items SET active = 0, deleted_at = 'now' WHERE import_key = 'forgotten'",
			)
			.run();

		const result = apply([
			peerOp("forgotten", {
				op_id: "edit-op",
				clock_rev: 2,
				clock_updated_at: "2026-11-28T00:00:00.000Z",
			}),
		]);

		expect(result).toMatchObject({ applied: 0, skipped: 1, rejections: [] });
		expect(
			store.db
				.prepare("SELECT active FROM memory_items WHERE import_key = 'forgotten'")
				.pluck()
				.get(),
		).toBe(0);
	});
});

describe("deletes travel as tombstones that carry no content", () => {
	function deleteOpOf(id: number | bigint) {
		return store.db
			.prepare(
				`SELECT * FROM replication_ops WHERE op_type = 'delete'
				 AND entity_id = (SELECT import_key FROM memory_items WHERE id = ?)`,
			)
			.get(id) as ReplicationOp;
	}

	function outbound(ops: ReplicationOp[]) {
		return coordinatorFreeOutboundOps(store.db, ops, { localDeviceId: local, peerDeviceId: PEER })
			.allowed;
	}

	it("sends a forgotten shared memory as a deletion without content", () => {
		const shared = remember("secret title");
		store.forget(Number(shared.id));
		const stored = {
			...deleteOpOf(shared.id),
			payload_json: JSON.stringify({ title: "secret title" }),
		};

		const [tombstone, ...rest] = outbound([stored]);

		expect(rest).toEqual([]);
		expect(tombstone).toMatchObject({
			op_id: stored.op_id,
			op_type: "delete",
			clock_rev: stored.clock_rev,
			payload_json: null,
		});
	});

	it("doesn't send a forgotten memory's earlier upsert with it", () => {
		const shared = remember("secret title");
		store.forget(Number(shared.id));

		const sent = outbound([shared.op, deleteOpOf(shared.id)]);

		expect(sent.map((op) => op.op_type)).toEqual(["delete"]);
	});

	it("sends no tombstone for a private memory or one restored since", () => {
		const hidden = remember("hidden", "private");
		store.forget(Number(hidden.id));
		const restored = remember("restored");
		store.forget(Number(restored.id));
		store.db
			.prepare("UPDATE memory_items SET active = 1, deleted_at = NULL WHERE id = ?")
			.run(restored.id);

		expect(outbound([deleteOpOf(hidden.id), deleteOpOf(restored.id)])).toEqual([]);
	});

	it("sends no tombstone for a memory in a Project the pairing excludes", () => {
		const excluded = remember("excluded");
		store.forget(Number(excluded.id));
		setPeerProjectFilter(store.db, PEER, { include: null, exclude: ["lane"] });

		expect(outbound([deleteOpOf(excluded.id)])).toEqual([]);
	});

	function tombstoneFrom(entityId: string, payload?: Record<string, unknown>) {
		return peerOp(
			entityId,
			{
				op_id: `${entityId}-delete`,
				op_type: "delete",
				clock_rev: 2,
				clock_updated_at: "2026-11-28T00:00:00.000Z",
				// The shared outbound decision sends every deletion without a payload.
				payload_json: payload ? JSON.stringify(payload) : null,
			},
			{},
		);
	}

	it("applies the peer's tombstone for a memory it created", () => {
		apply([peerOp("gone")]);

		const result = apply([tombstoneFrom("gone")]);

		expect(result).toMatchObject({ applied: 1, rejections: [] });
		expect(
			store.db
				.prepare(
					"SELECT active, deleted_at IS NOT NULL AS deleted FROM memory_items WHERE import_key = 'gone'",
				)
				.get(),
		).toEqual({ active: 0, deleted: 1 });
	});

	it.each([
		["another sender", { device_id: "other" }, undefined],
		["another clock device", { clock_device_id: "other" }, undefined],
		["another scope", { scope_id: "team-scope" }, undefined],
		["a payload, even an empty one", {}, {}],
	])("refuses a tombstone with %s", (_case, overrides, payload) => {
		apply([peerOp("theirs")]);
		const op = { ...tombstoneFrom("theirs", payload), ...overrides };

		expect(apply([op]).rejections).toEqual([{ op_id: "theirs-delete", reason: "op_not_allowed" }]);
		expect(
			store.db.prepare("SELECT active FROM memory_items WHERE import_key = 'theirs'").pluck().get(),
		).toBe(1);
	});

	it("refuses a tombstone that carries content or targets another device's row", () => {
		apply([peerOp("theirs")]);
		const mine = remember("mine");
		const myKey = String(
			store.db.prepare("SELECT import_key FROM memory_items WHERE id = ?").pluck().get(mine.id),
		);

		const withContent = apply([tombstoneFrom("theirs", { title: "theirs" })]);
		const notTheirs = apply([tombstoneFrom(myKey)]);

		expect(withContent.rejections).toEqual([{ op_id: "theirs-delete", reason: "op_not_allowed" }]);
		expect(notTheirs.rejections).toEqual([
			{ op_id: `${myKey}-delete`, reason: "target_not_owned_by_sender" },
		]);
		expect(
			store.db.prepare("SELECT COUNT(*) FROM memory_items WHERE active = 1").pluck().get(),
		).toBe(2);
	});
});
