import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillNarrativeFromBody } from "./maintenance/backfill-narrative.js";
import { listAmbiguousMemoryCopies, repairAmbiguousMemoryCopy } from "./memory-copy-ambiguity.js";
import { opCopyId } from "./memory-copy-provenance.js";
import { recordLocalCreationSnapshot } from "./memory-creation-provenance.js";
import { writeMemoryRevision } from "./memory-revision-writes.js";
import { upsertProjectScopeSettingsMapping } from "./project-scope-settings.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import { applyBootstrapSnapshot } from "./sync-bootstrap.js";
import {
	applyReplicationOps,
	backfillReplicationOps,
	filterReplicationOpsForSyncWithStatus,
	getSyncResetState,
	loadMemorySnapshotPageForPeer,
	loadReplicationOpsSince,
	opsStillSendableToPeer,
	recordReplicationOp,
	recordScopeReassignment,
} from "./sync-replication.js";
import { GROUP_ID, insertScope } from "./team-recovery-test-fixtures.js";
import { initTestSchema, insertTestPeer } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

const NOW = "2026-11-27T12:00:00.000Z";
const SOURCE = "source-device";
const PROJECT_REMOTE = "https://git.example.invalid/exampleco/api.git";
const KEY = "key:moved-memory";

let db: InstanceType<typeof Database>;

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});

afterEach(() => db.close());

/** Active coordinator memberships, so both this device and the peer are authorized in each scope. */
async function grant(memberships: Array<[scopeId: string, deviceId: string]>) {
	const insert = db.prepare(
		`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
		 VALUES (?, ?, 'member', 'active', 1, ?)`,
	);
	for (const [scopeId, deviceId] of memberships) insert.run(scopeId, deviceId, NOW);
	await refreshTestScopeRows(db);
}

function insertProjectMemory(scopeId: string): number {
	const session = Number(
		db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, git_branch, user, tool_version)
				 VALUES (?, '/workspace/api', 'api', ?, 'main', 'user', 'test')`,
			)
			.run(NOW, PROJECT_REMOTE).lastInsertRowid,
	);
	const memoryId = Number(
		db
			.prepare(
				`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
				 visibility, origin_device_id, active, metadata_json, project, scope_id, import_key, rev)
				 VALUES (?, 'discovery', 'Private title', 'Private body', ?, ?, 'shared', ?, 1, '{}',
				 'api', ?, ?, 1)`,
			)
			.run(session, NOW, NOW, SOURCE, scopeId, KEY).lastInsertRowid,
	);
	recordReplicationOp(db, {
		memoryId,
		opType: "upsert",
		deviceId: SOURCE,
		scopeId,
		clockRev: 1,
		createdAt: NOW,
	});
	return memoryId;
}

function memoryOps(): ReplicationOp[] {
	return db
		.prepare("SELECT * FROM replication_ops WHERE entity_id = ? ORDER BY created_at, op_id")
		.all(KEY) as ReplicationOp[];
}

/** Each op the filter sends to the peer, with the memory body it carries. */
function sentTo(peerDeviceId: string, ops = memoryOps()) {
	const [allowed] = filterReplicationOpsForSyncWithStatus(db, ops, peerDeviceId, {
		localDeviceId: SOURCE,
		supportsReassignScope: true,
	});
	return allowed.map((op) => ({
		op_type: op.op_type,
		scope_id: op.scope_id,
		body: (JSON.parse(op.payload_json ?? "{}") as { body_text?: string }).body_text ?? null,
	}));
}

function bodiesSentTo(peerDeviceId: string, ops?: ReplicationOp[]) {
	return sentTo(peerDeviceId, ops).filter((op) => op.body !== null);
}

describe("after a Project moves to another scope", () => {
	beforeEach(async () => {
		insertScope(db, "scope-old", GROUP_ID);
		insertScope(db, "scope-new", GROUP_ID);
		insertTestPeer(db, "peer-old");
		insertTestPeer(db, "peer-new");
		await grant([
			["scope-old", SOURCE],
			["scope-new", SOURCE],
			["scope-old", "peer-old"],
			["scope-new", "peer-new"],
		]);
	});

	function moveProject() {
		const mapping = upsertProjectScopeSettingsMapping(db, {
			deviceId: SOURCE,
			workspace_identity: PROJECT_REMOTE,
			project_pattern: "api",
			scope_id: "scope-old",
		});
		insertProjectMemory("scope-old");
		upsertProjectScopeSettingsMapping(db, {
			deviceId: SOURCE,
			id: mapping.id,
			workspace_identity: PROJECT_REMOTE,
			project_pattern: "api",
			scope_id: "scope-new",
		});
	}

	it("a device authorized only in the old scope receives none of the memory's content", () => {
		// Arrange: the memory was written in the old scope, so its first op still names that scope.
		moveProject();
		expect(
			db.prepare("SELECT scope_id FROM memory_items WHERE import_key = ?").pluck().get(KEY),
		).toBe("scope-new");
		expect(memoryOps()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ op_type: "upsert", scope_id: "scope-old" }),
			]),
		);

		// Act + Assert: the old-scope device gets the cleanup notice and no body.
		expect(bodiesSentTo("peer-old")).toEqual([]);
		expect(sentTo("peer-old")).toEqual([
			expect.objectContaining({ op_type: "access_cleanup", body: null }),
		]);
	});

	it("a device authorized in the new scope still receives the memory", () => {
		moveProject();

		expect(bodiesSentTo("peer-new")).toEqual([
			{ op_type: "upsert", scope_id: "scope-new", body: "Private body" },
		]);
	});

	it("moving the Project back makes the original scope's ops sendable again", () => {
		moveProject();
		const mapping = db
			.prepare("SELECT id FROM project_scope_mappings WHERE project_pattern = 'api'")
			.pluck()
			.get() as number;
		upsertProjectScopeSettingsMapping(db, {
			deviceId: SOURCE,
			id: mapping,
			workspace_identity: PROJECT_REMOTE,
			project_pattern: "api",
			scope_id: "scope-old",
		});

		expect(bodiesSentTo("peer-old").map((op) => op.scope_id)).toContain("scope-old");
		expect(bodiesSentTo("peer-new")).toEqual([]);
	});
});

describe("after a shared memory moves twice", () => {
	it("the first move's destination gets no content once the memory has left it", async () => {
		// Arrange: source -> managed through a share, then managed -> other.
		for (const scope of ["source", "managed", "other"]) insertScope(db, scope, GROUP_ID);
		insertTestPeer(db, "peer-managed");
		await grant([
			["source", SOURCE],
			["managed", SOURCE],
			["other", SOURCE],
			["managed", "peer-managed"],
		]);
		const memoryId = insertProjectMemory("source");
		recordScopeReassignment(db, {
			operationId: "share-first",
			memoryId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: SOURCE,
			createdAt: NOW,
		});
		const firstMove = memoryOps().filter((op) => op.op_type === "reassign_scope");
		expect(bodiesSentTo("peer-managed", firstMove)).toHaveLength(1);

		recordScopeReassignment(db, {
			operationId: "share-second",
			memoryId,
			oldScopeId: "managed",
			newScopeId: "other",
			deviceId: SOURCE,
			createdAt: "2026-11-27T12:05:00.000Z",
		});

		// Assert: the earlier move's new side named "managed", where the memory no longer is.
		expect(bodiesSentTo("peer-managed", firstMove)).toEqual([]);
	});
});

describe("a memory this device no longer stores", () => {
	it("sends no content through its earlier ops", async () => {
		insertScope(db, "scope-old", GROUP_ID);
		insertTestPeer(db, "peer-old");
		await grant([
			["scope-old", SOURCE],
			["scope-old", "peer-old"],
		]);
		const memoryId = insertProjectMemory("scope-old");
		expect(bodiesSentTo("peer-old")).toHaveLength(1);

		db.prepare("DELETE FROM memory_items WHERE id = ?").run(memoryId);

		expect(bodiesSentTo("peer-old")).toEqual([]);
	});
});

describe("a window of many ops", () => {
	it("looks up copies once per 500 ops, and still withholds a duplicate past the first lookup", async () => {
		// Arrange: 1,200 memories with ops, and a second copy of one far into the window.
		insertScope(db, "scope-old", GROUP_ID);
		insertTestPeer(db, "peer-old");
		await grant([
			["scope-old", SOURCE],
			["scope-old", "peer-old"],
		]);
		const session = Number(
			db
				.prepare("INSERT INTO sessions(started_at, cwd, project) VALUES (?, '/w/api', 'api')")
				.run(NOW).lastInsertRowid,
		);
		const insert = db.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
			 visibility, origin_device_id, active, metadata_json, project, scope_id, import_key, rev)
			 VALUES (?, 'discovery', 'Title', ?, ?, ?, 'shared', ?, 1, '{}', 'api', 'scope-old', ?, 1)`,
		);
		for (let i = 0; i < 1_200; i++) {
			const memoryId = Number(
				insert.run(session, `Body ${i}`, NOW, NOW, SOURCE, `key:${i}`).lastInsertRowid,
			);
			recordReplicationOp(db, {
				memoryId,
				opType: "upsert",
				deviceId: SOURCE,
				scopeId: "scope-old",
				clockRev: 1,
				createdAt: NOW,
			});
		}
		insert.run(session, "Another body", NOW, NOW, SOURCE, "key:1100");
		const ops = db
			.prepare("SELECT * FROM replication_ops ORDER BY created_at, op_id")
			.all() as ReplicationOp[];
		const prepared: string[] = [];
		const prepare = db.prepare.bind(db);
		db.prepare = ((sql: string) => {
			prepared.push(sql);
			return prepare(sql);
		}) as typeof db.prepare;

		// Act
		const [allowed] = filterReplicationOpsForSyncWithStatus(db, ops, "peer-old", {
			localDeviceId: SOURCE,
			supportsReassignScope: true,
		});

		// Assert: every other op carries its content, and each lookup ran once per 500 ops.
		expect(allowed.map((op) => op.entity_id).sort()).toEqual(
			Array.from({ length: 1_200 }, (_, i) => `key:${i}`)
				.filter((key) => key !== "key:1100")
				.sort(),
		);
		expect(allowed.every((op) => JSON.parse(op.payload_json ?? "{}").body_text)).toBe(true);
		expect(
			prepared.filter((sql) => sql.includes("FROM replication_op_copies AS op_copy")),
		).toHaveLength(3);
		expect(
			prepared.filter((sql) => sql.includes("GROUP BY import_key, scope_id HAVING COUNT(*) > 1")),
		).toHaveLength(3);
	});
});

describe("a deletion that replication backfill recorded", () => {
	it("goes out as a tombstone without the deleted memory's content", async () => {
		// Arrange: a memory deleted without a delete op, which backfill then records with the full row.
		insertScope(db, "scope-old", GROUP_ID);
		insertTestPeer(db, "peer-old");
		await grant([
			["scope-old", SOURCE],
			["scope-old", "peer-old"],
		]);
		const memoryId = insertProjectMemory("scope-old");
		db.prepare(`UPDATE memory_items SET active = 0, deleted_at = ?, rev = 2,
			 metadata_json = '{"clock_device_id":"source-device"}' WHERE id = ?`).run(NOW, memoryId);
		backfillReplicationOps(db);
		const deletion = memoryOps().find((op) => op.op_type === "delete");
		expect(JSON.parse(deletion?.payload_json ?? "null")).toMatchObject({
			body_text: "Private body",
		});

		// Act
		const [allowed] = filterReplicationOpsForSyncWithStatus(db, memoryOps(), "peer-old", {
			localDeviceId: SOURCE,
			supportsReassignScope: true,
		});

		// Assert: the deletion reaches the peer, and carries no content.
		expect(allowed.map((op) => ({ op_type: op.op_type, payload_json: op.payload_json }))).toEqual([
			{ op_type: "delete", payload_json: null },
		]);
	});
});

/** The creation record this device keeps for a memory it created, so its edits take revisions. */
function recordCreatedHere(memoryId: number) {
	db.transaction(() => {
		db.prepare(
			`INSERT INTO memory_source_bindings(entity_id, source_device_id, evidence, created_at)
			 VALUES (?, ?, 'local_creation', ?)`,
		).run(KEY, SOURCE, NOW);
		recordLocalCreationSnapshot(db, memoryId);
	})();
}

/** A local edit: the row changes, its revision goes up, and an op records the new content. */
function editMemory(memoryId: number, changes: Record<string, string>) {
	const columns = Object.keys(changes);
	db.prepare(
		`UPDATE memory_items SET ${columns.map((column) => `${column} = ?`).join(", ")}, rev = rev + 1
		 WHERE id = ?`,
	).run(...Object.values(changes), memoryId);
	recordReplicationOp(db, {
		memoryId,
		opType: "upsert",
		deviceId: SOURCE,
		createdAt: "2026-11-27T12:10:00.000Z",
	});
}

/** A second copy of the memory, under the same import key, in the given scope. */
function insertSiblingCopy(scopeId: string, changes: { body?: string; visibility?: string }) {
	db.prepare(
		`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
		 visibility, origin_device_id, active, metadata_json, project, scope_id, import_key, rev)
		 SELECT session_id, kind, title, ?, created_at, updated_at, ?, origin_device_id, active,
		 metadata_json, project, ?, import_key, rev FROM memory_items WHERE import_key = ? LIMIT 1`,
	).run(changes.body ?? "Private body", changes.visibility ?? "shared", scopeId, KEY);
}

describe("an op whose content no stored copy shows now", () => {
	beforeEach(async () => {
		insertScope(db, "scope-old", GROUP_ID);
		insertScope(db, "scope-new", GROUP_ID);
		insertTestPeer(db, "peer-old");
		await grant([
			["scope-old", SOURCE],
			["scope-new", SOURCE],
			["scope-old", "peer-old"],
		]);
	});

	it("is not sent after the memory turns private in the same scope", () => {
		const memoryId = insertProjectMemory("scope-old");
		editMemory(memoryId, { visibility: "private", workspace_kind: "personal" });

		expect(bodiesSentTo("peer-old")).toEqual([]);
	});

	it("is not sent after the memory's Project leaves the peer's Projects", () => {
		db.prepare("UPDATE sync_peers SET projects_include_json = ? WHERE peer_device_id = ?").run(
			JSON.stringify(["api"]),
			"peer-old",
		);
		insertProjectMemory("scope-old");
		expect(bodiesSentTo("peer-old")).toHaveLength(1);

		db.prepare("UPDATE sessions SET project = 'billing'").run();

		expect(bodiesSentTo("peer-old")).toEqual([]);
	});

	it("is not sent after an edit, while the edit itself is", () => {
		const memoryId = insertProjectMemory("scope-old");
		editMemory(memoryId, { body_text: "Edited body" });

		expect(bodiesSentTo("peer-old")).toEqual([
			{ op_type: "upsert", scope_id: "scope-old", body: "Edited body" },
		]);
	});

	it("carries nothing once its own copy moved, though a diverging copy under the key stayed", () => {
		// Arrange: the memory moved away, and a diverging copy under its key stayed behind.
		const memoryId = insertProjectMemory("scope-old");
		db.prepare("UPDATE memory_items SET scope_id = 'scope-new' WHERE id = ?").run(memoryId);
		insertSiblingCopy("scope-old", { body: "A different body" });

		expect(bodiesSentTo("peer-old")).toEqual([]);
	});

	it("sends no copy while two copies share the memory's import key in the scope", () => {
		insertProjectMemory("scope-old");
		insertSiblingCopy("scope-old", { body: "A different body" });

		expect(sentTo("peer-old")).toEqual([]);
	});

	it("carries nothing once its own copy is removed, though a diverging copy at its revision remains", () => {
		// Arrange: a sibling shares the op's import key, scope and revision.
		const memoryId = insertProjectMemory("scope-old");
		insertSiblingCopy("scope-old", { body: "A different body" });

		// Act: the copy the op was built from goes away, leaving the sibling the only copy.
		db.prepare("DELETE FROM memory_items WHERE id = ?").run(memoryId);

		// Assert: the sibling never inherits the op's id and clock.
		expect(bodiesSentTo("peer-old")).toEqual([]);
	});

	it("sends no content for an op from before copy identities, even to a lone replacement", () => {
		// Arrange: an op that names no copy, and a replacement stored after the original went.
		const memoryId = insertProjectMemory("scope-old");
		db.prepare("DELETE FROM replication_op_copies").run();
		db.prepare("DELETE FROM memory_items WHERE id = ?").run(memoryId);
		const unboundOpIds = memoryOps().map((op) => op.op_id);
		insertProjectMemory("scope-old");
		for (const op of memoryOps())
			if (!unboundOpIds.includes(op.op_id))
				db.prepare("DELETE FROM replication_ops WHERE op_id = ?").run(op.op_id);
		const unbound = memoryOps().filter((op) => !opCopyId(db, op.op_id));
		expect(unbound).toHaveLength(1);

		// Assert: the unbound op carries nothing.
		expect(bodiesSentTo("peer-old", unbound)).toEqual([]);
	});

	it("is not sent when the only copy showing it is private", () => {
		const memoryId = insertProjectMemory("scope-old");
		db.prepare("UPDATE memory_items SET scope_id = 'scope-new' WHERE id = ?").run(memoryId);
		insertSiblingCopy("scope-old", { visibility: "private" });

		expect(bodiesSentTo("peer-old")).toEqual([]);
	});
});

describe("an op's stored payload", () => {
	beforeEach(async () => {
		insertScope(db, "scope-old", GROUP_ID);
		insertTestPeer(db, "peer-old");
		db.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, 'key', 'fp', ?)",
		).run(SOURCE, NOW);
		await grant([
			["scope-old", SOURCE],
			["scope-old", "peer-old"],
		]);
	});

	function metadataSentTo(peerDeviceId: string) {
		const [allowed] = filterReplicationOpsForSyncWithStatus(db, memoryOps(), peerDeviceId, {
			localDeviceId: SOURCE,
		});
		return allowed.map(
			(op) => (JSON.parse(op.payload_json ?? "{}") as { metadata_json?: unknown }).metadata_json,
		);
	}

	it("is never sent after a metadata-only redaction, which goes out in its own revision", () => {
		// Arrange: the memory's op recorded a secret in its metadata.
		const memoryId = insertProjectMemory("scope-old");
		db.prepare("DELETE FROM replication_ops").run();
		db.prepare("UPDATE memory_items SET metadata_json = ? WHERE id = ?").run(
			JSON.stringify({ note: "token=ghp_secret" }),
			memoryId,
		);
		recordReplicationOp(db, { memoryId, opType: "upsert", deviceId: SOURCE, createdAt: NOW });
		recordCreatedHere(memoryId);

		// Act: only the metadata is redacted.
		writeMemoryRevision(db, {
			memoryId,
			changes: { metadata_json: JSON.stringify({ note: "token=[REDACTED]" }) },
		});

		expect(JSON.stringify(metadataSentTo("peer-old"))).not.toContain("ghp_secret");
		expect(metadataSentTo("peer-old")).toEqual([
			expect.objectContaining({ note: "token=[REDACTED]" }),
		]);
	});

	it("is replaced by the row as stored when the op goes out", () => {
		// Arrange: the op recorded metadata the row no longer holds.
		insertProjectMemory("scope-old");
		db.prepare(
			"UPDATE replication_ops SET payload_json = json_set(payload_json, '$.metadata_json', json(?))",
		).run(JSON.stringify({ note: "token=ghp_secret" }));
		expect(memoryOps()[0]?.payload_json).toContain("ghp_secret");

		expect(metadataSentTo("peer-old")).toEqual([{}]);
	});
});

describe("a maintenance edit", () => {
	it("reaches a peer that already holds the memory, through incremental sync", async () => {
		// Arrange: the peer has applied every op of a session summary without a narrative.
		insertScope(db, "scope-old", GROUP_ID);
		insertTestPeer(db, "peer-old");
		db.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, 'key', 'fp', ?)",
		).run(SOURCE, NOW);
		await grant([
			["scope-old", SOURCE],
			["scope-old", "peer-old"],
		]);
		const memoryId = insertProjectMemory("scope-old");
		recordCreatedHere(memoryId);
		db.prepare("UPDATE memory_items SET kind = 'session_summary', body_text = ? WHERE id = ?").run(
			"## Completed\nShipped the fix",
			memoryId,
		);
		const [, cursor] = loadReplicationOpsSince(db, null, 100, SOURCE);

		// Act
		backfillNarrativeFromBody(db);

		// Assert: the next incremental pull carries the narrative.
		const [later] = loadReplicationOpsSince(db, cursor, 100, SOURCE);
		const [allowed] = filterReplicationOpsForSyncWithStatus(db, later, "peer-old", {
			localDeviceId: SOURCE,
		});
		expect(
			allowed.map(
				(op) => (JSON.parse(op.payload_json ?? "{}") as { narrative?: string }).narrative,
			),
		).toEqual(["Shipped the fix"]);
	});
});

describe("a replica with two copies of a memory in one scope", () => {
	it("serves neither in a snapshot after one was redacted, and diagnostics count it", async () => {
		// Arrange: a redacted copy and an unredacted duplicate under the same key.
		insertScope(db, "scope-old", GROUP_ID);
		insertTestPeer(db, "peer-old");
		await grant([
			["scope-old", SOURCE],
			["scope-old", "peer-old"],
		]);
		insertProjectMemory("scope-old");
		insertSiblingCopy("scope-old", { body: "token=ghp_unredacted_secret" });
		db.prepare(
			"UPDATE memory_items SET body_text = '[REDACTED]' WHERE id = (SELECT MIN(id) FROM memory_items)",
		).run();
		const boundary = getSyncResetState(db, "scope-old");

		// Act
		const page = loadMemorySnapshotPageForPeer(db, {
			peerDeviceId: "peer-old",
			scopeId: "scope-old",
			generation: boundary.generation,
			snapshotId: boundary.snapshot_id,
			baselineCursor: boundary.baseline_cursor,
		});

		// Assert
		expect(page.items).toEqual([]);
		expect(listAmbiguousMemoryCopies(db)).toEqual([{ scope_id: "scope-old", memory_ids: [1, 2] }]);
	});
});

describe("a memory once stored twice in a scope", () => {
	it("stays withheld after a cleanup removes one copy, until a repair confirms the survivor", async () => {
		// Arrange: two copies another device wrote, both in the scope.
		insertScope(db, "scope-old", GROUP_ID);
		insertTestPeer(db, "peer-old");
		await grant([
			["scope-old", SOURCE],
			["scope-old", "peer-old"],
		]);
		insertProjectMemory("scope-old");
		insertSiblingCopy("scope-old", { body: "A different body" });
		db.prepare("UPDATE memory_items SET origin_device_id = 'peer-a'").run();
		const boundary = getSyncResetState(db, "scope-old");
		const snapshot = () =>
			loadMemorySnapshotPageForPeer(db, {
				peerDeviceId: "peer-old",
				scopeId: "scope-old",
				generation: boundary.generation,
				snapshotId: boundary.snapshot_id,
				baselineCursor: boundary.baseline_cursor,
			}).items;

		// Act: the writer's cleanup notice removes one of the two copies.
		const cleanup = applyReplicationOps(
			db,
			[
				{
					op_id: "cleanup-1",
					entity_type: "memory_item",
					entity_id: KEY,
					op_type: "access_cleanup",
					payload_json: JSON.stringify({ cleanup_scope_id: "scope-old" }),
					clock_rev: 2,
					clock_updated_at: NOW,
					clock_device_id: "peer-a",
					device_id: "peer-a",
					created_at: NOW,
					scope_id: "local-default",
				},
			],
			SOURCE,
		);
		const survivors = db.prepare("SELECT id FROM memory_items").pluck().all() as number[];

		// Assert: one copy is left, and it is still not served.
		expect(cleanup.applied).toBe(1);
		expect(survivors).toHaveLength(1);
		expect(snapshot()).toEqual([]);
		expect(listAmbiguousMemoryCopies(db)).toEqual([
			{ scope_id: "scope-old", memory_ids: survivors },
		]);

		// Act + Assert: an explicit repair confirms the survivor, and it is served again.
		expect(repairAmbiguousMemoryCopy(db, survivors[0] ?? 0)).toEqual({
			status: "repaired",
			scope_id: "scope-old",
		});
		expect(snapshot()).toHaveLength(1);
		expect(listAmbiguousMemoryCopies(db)).toEqual([]);
	});
});

describe("a memory this store wrote before it adopted its identity", () => {
	it("is withheld until adoption moves it to the canonical actor", async () => {
		insertScope(db, "scope-old", GROUP_ID);
		insertTestPeer(db, "peer-old");
		await grant([
			["scope-old", SOURCE],
			["scope-old", "peer-old"],
		]);
		const memoryId = insertProjectMemory("scope-old");
		db.prepare(
			"UPDATE memory_items SET actor_id = 'local:local', origin_device_id = 'local' WHERE id = ?",
		).run(memoryId);
		const boundary = getSyncResetState(db, "scope-old");
		const snapshot = () =>
			loadMemorySnapshotPageForPeer(db, {
				peerDeviceId: "peer-old",
				scopeId: "scope-old",
				generation: boundary.generation,
				snapshotId: boundary.snapshot_id,
				baselineCursor: boundary.baseline_cursor,
			}).items;

		expect(bodiesSentTo("peer-old")).toEqual([]);
		expect(snapshot()).toEqual([]);

		db.prepare("UPDATE memory_items SET actor_id = 'local:source-device' WHERE id = ?").run(
			memoryId,
		);

		expect(bodiesSentTo("peer-old")).toHaveLength(1);
		expect(snapshot()).toHaveLength(1);
	});
});

describe("the recheck before each push request", () => {
	it("drops an op whose stored copy the peer may not read, even when the op shows it exactly", async () => {
		// Arrange: a private memory, and an op recorded from it as it is now.
		insertScope(db, "scope-old", GROUP_ID);
		insertTestPeer(db, "peer-old");
		await grant([
			["scope-old", SOURCE],
			["scope-old", "peer-old"],
		]);
		const memoryId = insertProjectMemory("scope-old");
		editMemory(memoryId, { visibility: "private", workspace_kind: "personal" });
		const current = memoryOps().at(-1);
		if (!current) throw new Error("missing_op");

		// Act + Assert: the copy decides, by its own visibility.
		expect(opsStillSendableToPeer(db, [current], "peer-old", SOURCE)).toEqual([]);
	});
});

describe("a first snapshot of a forgotten memory", () => {
	it("names the deletion and carries none of the memory's content", async () => {
		insertScope(db, "scope-old", GROUP_ID);
		insertTestPeer(db, "peer-old");
		await grant([
			["scope-old", SOURCE],
			["scope-old", "peer-old"],
		]);
		const memoryId = insertProjectMemory("scope-old");
		db.prepare(
			"UPDATE memory_items SET active = 0, deleted_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?",
		).run("2026-11-27T12:20:00.000Z", "2026-11-27T12:20:00.000Z", memoryId);
		const boundary = getSyncResetState(db, "scope-old");

		const page = loadMemorySnapshotPageForPeer(db, {
			peerDeviceId: "peer-old",
			scopeId: "scope-old",
			generation: boundary.generation,
			snapshotId: boundary.snapshot_id,
			baselineCursor: boundary.baseline_cursor,
		});

		expect(page.items).toHaveLength(1);
		expect(page.items[0]).toMatchObject({ entity_id: KEY, op_type: "delete", clock_rev: 2 });
		expect(JSON.parse(page.items[0]?.payload_json ?? "{}")).toEqual({
			scope_id: "scope-old",
			origin_device_id: SOURCE,
			active: 0,
			deleted_at: "2026-11-27T12:20:00.000Z",
			has_deleted_at: true,
		});

		// A receiver bootstrapping from the page records the deletion and no content.
		const receiver = new Database(":memory:");
		initTestSchema(receiver);
		insertTestPeer(receiver, SOURCE);
		applyBootstrapSnapshot(receiver, SOURCE, page.items, {
			...boundary,
			reset_required: true,
			reason: "generation_mismatch",
			scope_id: "scope-old",
		});
		expect(
			receiver
				.prepare(
					"SELECT title, body_text, active, deleted_at FROM memory_items WHERE import_key = ?",
				)
				.get(KEY),
		).toEqual({ title: "", body_text: "", active: 0, deleted_at: "2026-11-27T12:20:00.000Z" });
		receiver.close();
	});
});

describe("ops a peer sends this device", () => {
	it("are still checked without the stored copy, since this device may not hold the memory yet", () => {
		insertScope(db, "scope-new", GROUP_ID);
		insertTestPeer(db, "peer-new");
		const inbound = {
			op_id: "inbound-1",
			entity_type: "memory_item",
			entity_id: "key:peer-memory",
			op_type: "upsert",
			payload_json: JSON.stringify({
				body_text: "Peer body",
				visibility: "shared",
				scope_id: "scope-new",
			}),
			clock_rev: 1,
			clock_updated_at: NOW,
			clock_device_id: "peer-new",
			device_id: "peer-new",
			created_at: NOW,
			scope_id: "scope-new",
		} as ReplicationOp;

		const [allowed] = filterReplicationOpsForSyncWithStatus(db, [inbound], "peer-new", {
			localDeviceId: SOURCE,
			applyScopeFilter: false,
		});

		expect(allowed).toHaveLength(1);
	});
});
