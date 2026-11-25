import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { ensureMemorySourceIdentitySchema } from "./memory-source-identity.js";
import { removePairingState } from "./pairing-removal.js";
import { recordProjectBoundaryMigration } from "./project-boundary-migration-records.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { SecretScanner } from "./secret-scanner.js";
import * as syncAuth from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import type { RequestJsonExecutor } from "./sync-http-client.js";
import * as http from "./sync-http-client.js";
import * as identity from "./sync-identity.js";
import { syncOnce } from "./sync-pass.js";
import { DEFAULT_SYNC_SCOPE_ID, setReplicationCursor } from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

/*
 * Pulled operations and snapshots need the same sender authorization as a
 * pushed batch: a retained proof for the peer's pinned key in every scope the
 * write changes, whatever capability the peer reports, and the pairing that
 * was admitted when the pull started.
 */

const LOCAL = "pull-local";
const PEER = "pull-peer";
const FINGERPRINT = "pull-fingerprint";
/** Both devices are proven members. */
const SHARED = "pull-shared";
/** Only this device is a member. */
const OTHER = "pull-other";
const T = "2026-01-01T00:00:00Z";
const BASELINE = `${T}|baseline`;
const BOUNDARY = {
	generation: 1,
	snapshot_id: "pull-snapshot",
	baseline_cursor: BASELINE,
	retained_floor_cursor: null,
};
const BASE_URL = "http://pull.example.test:47337";

let db: InstanceType<typeof Database>;

function grant(scopeId: string, deviceIds: string[]) {
	db.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id,
		group_id, membership_epoch, status, created_at, updated_at)
		VALUES (?, ?, 'team', 'coordinator', 'coordinator-1', 'group-1', 1, 'active', ?, ?)`).run(
		scopeId,
		scopeId,
		T,
		T,
	);
	for (const deviceId of deviceIds) {
		db.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch,
			updated_at) VALUES (?, ?, 'member', 'active', 1, ?)`).run(scopeId, deviceId, T);
	}
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
	db = new Database(":memory:");
	initTestSchema(db);
	vi.spyOn(identity, "ensureDeviceIdentity").mockReturnValue([LOCAL, "ed25519 fixture"]);
	vi.spyOn(syncAuth, "buildDirectPeerAuthHeaders").mockReturnValue({});
	vi.spyOn(http, "requestJson").mockImplementation(async () => {
		throw new Error("unexpected_default_http");
	});
	db.prepare(
		"INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
	).run(PEER, CANONICAL_PUBLIC_KEY, FINGERPRINT, T);
	grant(SHARED, [LOCAL, PEER]);
	grant(OTHER, [LOCAL]);
	setReplicationCursor(db, PEER, { lastApplied: BASELINE, lastAcked: BASELINE });
	setReplicationCursor(db, PEER, { lastApplied: BASELINE, lastAcked: BASELINE }, SHARED);
	await refreshTestScopeRows(db);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	db.close();
});

function peerOp(id: string, scopeId: string, entityId = `${id}-memory`): ReplicationOp {
	return {
		op_id: id,
		entity_type: "memory_item",
		entity_id: entityId,
		op_type: "upsert",
		payload_json: JSON.stringify({
			kind: "discovery",
			title: `Peer ${id}`,
			body_text: "Peer content",
			visibility: "shared",
			scope_id: scopeId,
		}),
		clock_rev: 5,
		clock_updated_at: "2026-01-02T00:00:00Z",
		clock_device_id: PEER,
		device_id: PEER,
		created_at: "2026-01-02T00:00:00Z",
		scope_id: scopeId,
	};
}

function insertHeldRow(importKey: string, scopeId: string) {
	const session = db
		.prepare("INSERT INTO sessions(started_at, project) VALUES (?, 'fixture')")
		.run(T).lastInsertRowid;
	db.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text,
		active, created_at, updated_at, metadata_json, import_key, origin_device_id, rev, visibility,
		scope_id) VALUES (?, 'discovery', 'Held', 'Held body', 0.5, '', 1, ?, ?, '{}', ?, ?, 1,
		'shared', ?)`).run(session, T, T, importKey, PEER, scopeId);
}

interface PeerAnswers {
	capability?: string;
	defaultOps?: ReplicationOp[];
	scopes?: string[];
	scopedOps?: ReplicationOp[];
	snapshotItems?: unknown[];
	/** Runs while the peer answers a pull, before anything is applied. */
	duringPull?: () => void;
	/** Runs while the peer serves snapshot pages, after the pre-download check. */
	duringSnapshot?: () => void;
	fingerprint?: string;
	/** A scoped boundary the peer names for an initial bootstrap. */
	statusResetScope?: string;
	/** The default pull answers with a reset to this boundary, scoped or not. */
	defaultResetScope?: string | null;
	/** The peer's boundary, when it differs from this device's. */
	boundary?: typeof BOUNDARY;
}

type PeerReply = Awaited<ReturnType<RequestJsonExecutor>>;

function statusReply(answers: PeerAnswers): PeerReply {
	return [
		200,
		{
			fingerprint: answers.fingerprint ?? FINGERPRINT,
			protocol_version: "2",
			sync_capability: answers.capability ?? "scoped",
			sync_reset: { ...(answers.boundary ?? BOUNDARY), scope_id: answers.statusResetScope ?? null },
			authorized_scopes: (answers.scopes ?? []).map((id) => ({
				scope_id: id,
				label: id,
				authority_type: "coordinator",
				membership_epoch: 1,
				sync_reset: { ...BOUNDARY, scope_id: id },
			})),
		},
	];
}

function pageReply(answers: PeerAnswers, path: string, scopeId: string | null): PeerReply {
	answers.duringPull?.();
	const boundary = answers.boundary ?? BOUNDARY;
	const page = { ...boundary, scope_id: scopeId, reset_required: false, skipped: 0 };
	if (path === "/v1/snapshot") {
		answers.duringSnapshot?.();
		return [200, { ...page, items: answers.snapshotItems ?? [], has_more: false }];
	}
	const ops = (scopeId ? answers.scopedOps : answers.defaultOps) ?? [];
	const last = ops.at(-1);
	return [200, { ...page, ops, next_cursor: last ? `${last.created_at}|${last.op_id}` : null }];
}

function peer(answers: PeerAnswers): RequestJsonExecutor {
	return async (method, url) => {
		const { pathname, searchParams } = new URL(url);
		const scopeId = searchParams.get("scope_id");
		if (pathname === "/v1/status") return statusReply(answers);
		if (method === "POST") return [200, { applied: 0, skipped: 0, errors: [] }];
		const reset = !scopeId && pathname === "/v1/ops" ? answers.defaultResetScope : undefined;
		if (reset !== undefined) {
			const boundary = answers.boundary ?? BOUNDARY;
			return [409, { ...boundary, reset_required: true, reason: "stale_cursor", scope_id: reset }];
		}
		return pageReply(answers, pathname, scopeId);
	};
}

function pull(answers: PeerAnswers) {
	return syncOnce(db, PEER, [BASE_URL], {
		requestExecutor: peer(answers),
		scanner: new SecretScanner(),
	});
}

function memory(importKey: string) {
	return db
		.prepare("SELECT title, scope_id FROM memory_items WHERE import_key = ?")
		.all(importKey) as Array<{ title: string; scope_id: string }>;
}

const snapshotItem = {
	entity_id: "snapshot-key",
	op_type: "upsert",
	payload_json: JSON.stringify({
		kind: "discovery",
		title: "Snapshot memory",
		body_text: "Snapshot body",
		active: 1,
		created_at: T,
		updated_at: T,
		scope_id: SHARED,
		visibility: "shared",
	}),
	clock_rev: 1,
	clock_updated_at: T,
	clock_device_id: PEER,
};

describe("pulled operations need the sender's authorization", () => {
	it("refuses a scope the peer is not in when it reports the legacy capability", async () => {
		const result = await pull({ capability: "unsupported", defaultOps: [peerOp("legacy", OTHER)] });

		expect(result.ok).toBe(false);
		expect(memory("legacy-memory")).toEqual([]);
	});

	it("applies a scope the peer is proven in when it reports the legacy capability", async () => {
		const result = await pull({
			capability: "unsupported",
			defaultOps: [peerOp("legacy", SHARED)],
		});

		expect(result.ok).toBe(true);
		expect(memory("legacy-memory")).toEqual([{ title: "Peer legacy", scope_id: SHARED }]);
	});

	it("refuses an update of a record stored in a scope the peer is not in", async () => {
		insertHeldRow("held-key", OTHER);

		const result = await pull({ defaultOps: [peerOp("cross-scope", SHARED, "held-key")] });

		expect(result.ok).toBe(false);
		expect(memory("held-key")).toEqual([{ title: "Held", scope_id: OTHER }]);
	});

	it.each([
		["removed", () => db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(PEER)],
		[
			"replaced with another key",
			() =>
				db
					.prepare("UPDATE sync_peers SET pinned_fingerprint = 'other' WHERE peer_device_id = ?")
					.run(PEER),
		],
	])("applies nothing from a pull during which the pairing was %s", async (_case, change) => {
		const result = await pull({ defaultOps: [peerOp("paused", SHARED)], duringPull: change });

		expect(result.ok).toBe(false);
		expect(memory("paused-memory")).toEqual([]);
	});
});

describe("a removed device that recreated its pairing", () => {
	beforeEach(() => {
		// Remove ends the pairing and proofs. The same key pairs again, as a grant allows.
		removePairingState(db, { localDeviceId: LOCAL, reason: "removed", deviceIds: [PEER] });
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
		).run(PEER, CANONICAL_PUBLIC_KEY, FINGERPRINT, T);
		setReplicationCursor(db, PEER, { lastApplied: BASELINE, lastAcked: BASELINE });
	});

	it.each([
		["snapshot", { scopes: [SHARED], snapshotItems: [snapshotItem] }, "snapshot-key"],
		["operations", { defaultOps: [peerOp("removed-op", SHARED)] }, "removed-op-memory"],
	] as const)(
		"fills no scope from its %s until a refresh proves it again",
		async (_case, answers, key) => {
			const refused = await pull(answers);

			expect(refused.ok).toBe(false);
			expect(memory(key)).toEqual([]);

			await refreshTestScopeRows(db);
			const rejoined = await pull(answers);

			expect(rejoined.ok).toBe(true);
			expect(memory(key)).toHaveLength(1);
			expect(memory(key)[0]?.scope_id).toBe(SHARED);
		},
	);
	it("does not replace a copy held in an older scope under a migration record", async () => {
		// Arrange: the peer created the memory, and this device holds its older copy.
		grant("pull-source", [LOCAL, PEER]);
		recordProjectBoundaryMigration(db, {
			boundaryScopeId: SHARED,
			sourceScopeId: "pull-source",
			state: "committed",
			generation: 1,
			now: T,
		});
		ensureMemorySourceIdentitySchema(db);
		db.prepare(`INSERT INTO memory_source_bindings(entity_id, source_device_id, evidence, created_at)
			VALUES ('snapshot-key', ?, 'authenticated_namespace', ?)`).run(PEER, T);
		insertHeldRow("snapshot-key", "pull-source");

		const result = await pull({ scopes: [SHARED], snapshotItems: [snapshotItem] });

		expect(result.ok).toBe(false);
		expect(memory("snapshot-key")).toEqual([{ title: "Held", scope_id: "pull-source" }]);
	});
});

/** Ways the pairing loses standing while snapshot pages download. */
const LOST_DURING_DOWNLOAD = [
	[
		"revoked",
		() =>
			db
				.prepare(
					"UPDATE scope_memberships SET status = 'revoked' WHERE device_id = ? AND scope_id = ?",
				)
				.run(PEER, SHARED),
	],
	["removed", () => db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(PEER)],
] as const;

describe("a snapshot to a scoped boundary the peer names", () => {
	it.each(LOST_DURING_DOWNLOAD)(
		"replaces nothing in a reset when the pairing is %s during the download",
		async (_case, lose) => {
			const result = await pull({
				defaultResetScope: SHARED,
				snapshotItems: [snapshotItem],
				duringSnapshot: lose,
			});

			expect(result.ok).toBe(false);
			expect(memory("snapshot-key")).toEqual([]);
		},
	);

	it.each(LOST_DURING_DOWNLOAD)(
		"adds nothing in an initial bootstrap when the pairing is %s during the download",
		async (_case, lose) => {
			// No progress with the peer, so the pass starts with an initial bootstrap.
			db.prepare("DELETE FROM replication_cursors WHERE peer_device_id = ?").run(PEER);
			db.prepare("DELETE FROM replication_cursors_v2 WHERE peer_device_id = ?").run(PEER);

			const result = await pull({
				statusResetScope: SHARED,
				snapshotItems: [snapshotItem],
				duringSnapshot: lose,
			});

			expect(result.ok).toBe(false);
			expect(memory("snapshot-key")).toEqual([]);
		},
	);
});

describe("a pin with a fingerprint and no stored key", () => {
	it.each([
		["the key the proof is for", fingerprintPublicKey(CANONICAL_PUBLIC_KEY), 1],
		["another key", fingerprintPublicKey("ssh-ed25519 another-key"), 0],
	] as const)("binds proofs through a fingerprint of %s", async (_case, fingerprint, rows) => {
		db.prepare(
			"UPDATE sync_peers SET public_key = NULL, pinned_fingerprint = ? WHERE peer_device_id = ?",
		).run(fingerprint, PEER);

		await pull({ fingerprint, defaultOps: [peerOp("pinned-op", SHARED)] });
		db.prepare("DELETE FROM replication_cursors_v2 WHERE peer_device_id = ? AND scope_id = ?").run(
			PEER,
			SHARED,
		);
		await pull({ fingerprint, scopes: [SHARED], snapshotItems: [snapshotItem] });

		expect(memory("pinned-op-memory")).toHaveLength(rows);
		expect(memory("snapshot-key")).toHaveLength(rows);
	});
});

describe("a recorded move served by a peer proven only in the destination (current policy)", () => {
	it.each([
		["the memory's creator replaces", PEER, [{ title: "Snapshot memory", scope_id: SHARED }]],
		[
			"another device does not replace",
			"another-device",
			[{ title: "Held", scope_id: "pull-source" }],
		],
	] as const)("%s the older copy", async (_case, creator, expected) => {
		grant("pull-source", [LOCAL]);
		recordProjectBoundaryMigration(db, {
			boundaryScopeId: SHARED,
			sourceScopeId: "pull-source",
			state: "committed",
			generation: 1,
			now: T,
		});
		ensureMemorySourceIdentitySchema(db);
		db.prepare(`INSERT INTO memory_source_bindings(entity_id, source_device_id, evidence, created_at)
			VALUES ('snapshot-key', ?, 'authenticated_namespace', ?)`).run(creator, T);
		insertHeldRow("snapshot-key", "pull-source");
		db.prepare("DELETE FROM replication_cursors_v2 WHERE peer_device_id = ? AND scope_id = ?").run(
			PEER,
			SHARED,
		);

		await pull({ scopes: [SHARED], snapshotItems: [snapshotItem] });

		expect(memory("snapshot-key")).toEqual(expected);
	});
});

describe("an unscoped snapshot whose pairing changes during the download", () => {
	const NEXT = { ...BOUNDARY, generation: 2, snapshot_id: "pull-snapshot-2" };
	const PAIRING_CHANGES = [
		["removed", () => db.prepare("DELETE FROM sync_peers WHERE peer_device_id = ?").run(PEER)],
		[
			"replaced with another key",
			() =>
				db
					.prepare("UPDATE sync_peers SET pinned_fingerprint = 'other' WHERE peer_device_id = ?")
					.run(PEER),
		],
	] as const;
	const KINDS = [
		["initial", { boundary: NEXT }],
		["reset", { boundary: NEXT, defaultResetScope: null }],
	] as const;

	/** This peer's cursors and the default reset boundary. */
	function progress() {
		return ["replication_cursors", "replication_cursors_v2", "sync_reset_state_v2"].map((table) =>
			JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
		);
	}

	beforeEach(() => {
		// No progress with the peer, so an initial pass starts with an unscoped bootstrap.
		db.prepare("DELETE FROM replication_cursors WHERE peer_device_id = ?").run(PEER);
		db.prepare("DELETE FROM replication_cursors_v2 WHERE peer_device_id = ?").run(PEER);
	});

	it.each(
		KINDS.flatMap(([kind, answers]) =>
			PAIRING_CHANGES.map(([change, lose]) => ({ kind, answers, change, lose })),
		),
	)(
		"writes no cursor or boundary when the pairing is $change during an unscoped $kind download",
		async ({ answers, lose }) => {
			if ("defaultResetScope" in answers)
				setReplicationCursor(db, PEER, { lastApplied: BASELINE, lastAcked: BASELINE });
			let paused: string[] = [];
			const result = await pull({
				...answers,
				duringSnapshot: () => {
					lose();
					paused = progress();
				},
			});

			expect(result.ok).toBe(false);
			expect(progress()).toEqual(paused);
		},
	);

	it.each(KINDS)("completes an uninterrupted %s bootstrap", async (_kind, answers) => {
		if ("defaultResetScope" in answers)
			setReplicationCursor(db, PEER, { lastApplied: BASELINE, lastAcked: BASELINE });

		const result = await pull(answers);

		expect(result.ok).toBe(true);
		expect(
			db
				.prepare("SELECT snapshot_id FROM sync_reset_state_v2 WHERE scope_id = ?")
				.pluck()
				.get(DEFAULT_SYNC_SCOPE_ID),
		).toBe(NEXT.snapshot_id);
	});
});
