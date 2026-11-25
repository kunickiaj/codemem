import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import {
	applyReplicationOps,
	DEFAULT_SYNC_SCOPE_ID,
	filterReplicationOpsForSyncWithStatus,
	parseReassignScopePayload,
	recordReplicationOp,
	recordScopeReassignment,
} from "./sync-replication.js";
import { initTestSchema, initTestSchemaWithPeers } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

const now = "2026-07-20T14:00:00.000Z";

function insertMemory(
	db: InstanceType<typeof Database>,
	scopeId: string | null = "source",
	originDeviceId: string | null = null,
): number {
	const session = db
		.prepare("INSERT INTO sessions(started_at, project, git_remote) VALUES (?, 'api', ?)")
		.run(now, "https://example.invalid/acme/api.git");
	return Number(
		db
			.prepare(`INSERT INTO memory_items(
				session_id, kind, title, body_text, confidence, tags_text, active,
				created_at, updated_at, metadata_json, import_key, rev, visibility, scope_id, origin_device_id
			) VALUES (?, 'discovery', 'title', 'body', 0.8, '', 1, ?, ?, '{}', 'memory:key', 2, 'shared', ?, ?)`)
			.run(Number(session.lastInsertRowid), now, now, scopeId, originDeviceId).lastInsertRowid,
	);
}

function ops(db: InstanceType<typeof Database>): ReplicationOp[] {
	return db
		.prepare("SELECT * FROM replication_ops WHERE op_type = 'reassign_scope' ORDER BY scope_id")
		.all() as ReplicationOp[];
}

describe("reassign_scope replication", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	afterEach(() => db.close());

	it("records one logical revision as deterministic old and new scoped sides", () => {
		const memoryId = insertMemory(db);
		const first = recordScopeReassignment(db, {
			operationId: "share_operation",
			memoryId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const replay = recordScopeReassignment(db, {
			operationId: "share_operation",
			memoryId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});

		expect(replay).toEqual(first);
		expect(ops(db)).toHaveLength(2);
		expect(new Set(ops(db).map((op) => op.clock_rev))).toEqual(new Set([3]));
		expect(
			ops(db)
				.map(parseReassignScopePayload)
				.map((payload) => payload.side)
				.sort(),
		).toEqual(["new", "old"]);
		const newSide = ops(db).find((op) => parseReassignScopePayload(op).side === "new");
		expect(JSON.parse(newSide?.payload_json ?? "{}")).toMatchObject({ project: "api" });
		expect(db.prepare("SELECT scope_id, rev FROM memory_items WHERE id = ?").get(memoryId)).toEqual(
			{
				scope_id: "managed",
				rev: 3,
			},
		);
	});

	it("reassigns replicated legacy memories that use their numeric id as the entity id", () => {
		const memoryId = insertMemory(db);
		db.prepare("UPDATE memory_items SET import_key = NULL WHERE id = ?").run(memoryId);
		recordReplicationOp(db, {
			memoryId,
			opType: "upsert",
			deviceId: "owner",
			scopeId: "source",
			createdAt: now,
		});

		recordScopeReassignment(db, {
			operationId: "share_legacy",
			memoryId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});

		expect(new Set(ops(db).map((op) => op.entity_id))).toEqual(new Set([String(memoryId)]));
		expect(db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId)).toBe(
			"managed",
		);
	});

	it("applies either authorized side without needing or exposing the other side payload", () => {
		const sourceId = insertMemory(db);
		recordScopeReassignment(db, {
			operationId: "share_operation",
			memoryId: sourceId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const [newSide, oldSide] = ops(db);
		if (!newSide || !oldSide) throw new Error("missing fixture ops");

		const oldReceiver = new Database(":memory:");
		initTestSchema(oldReceiver);
		insertMemory(oldReceiver, "source");
		const oldResult = applyReplicationOps(oldReceiver, [oldSide], "old-receiver");
		expect(oldResult.errors).toEqual([]);
		expect(oldReceiver.prepare("SELECT active, scope_id FROM memory_items").get()).toEqual({
			active: 0,
			scope_id: "source",
		});

		const newReceiver = new Database(":memory:");
		initTestSchema(newReceiver);
		const newResult = applyReplicationOps(newReceiver, [newSide], "new-receiver");
		expect(newResult.errors).toEqual([]);
		expect(newReceiver.prepare("SELECT active, scope_id, title FROM memory_items").get()).toEqual({
			active: 1,
			scope_id: "managed",
			title: "title",
		});
		oldReceiver.close();
		newReceiver.close();
	});

	it("normalizes a legacy blank scope while applying a local-default reassignment", () => {
		const sourceId = insertMemory(db, DEFAULT_SYNC_SCOPE_ID);
		recordScopeReassignment(db, {
			operationId: "share_default",
			memoryId: sourceId,
			oldScopeId: DEFAULT_SYNC_SCOPE_ID,
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const receiver = new Database(":memory:");
		initTestSchema(receiver);
		insertMemory(receiver, null);
		receiver
			.prepare("UPDATE memory_items SET origin_device_id = 'owner' WHERE import_key = 'memory:key'")
			.run();

		const result = applyReplicationOps(receiver, ops(db), "receiver");

		expect(result.errors).toEqual([]);
		expect(receiver.prepare("SELECT active, scope_id, rev FROM memory_items").get()).toEqual({
			active: 1,
			scope_id: "managed",
			rev: 3,
		});
		receiver.close();
	});

	it("converges under either side ordering and rejects malformed payloads without mutation", () => {
		const sourceId = insertMemory(db);
		recordScopeReassignment(db, {
			operationId: "share_operation",
			memoryId: sourceId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const wireOps = ops(db);
		for (const ordered of [wireOps, [...wireOps].reverse()]) {
			const receiver = new Database(":memory:");
			initTestSchema(receiver);
			insertMemory(receiver, "source");
			const result = applyReplicationOps(receiver, ordered, "receiver");
			expect(result.errors).toEqual([]);
			expect(receiver.prepare("SELECT active, scope_id, rev FROM memory_items").get()).toEqual({
				active: 1,
				scope_id: "managed",
				rev: 3,
			});
			receiver.close();
		}

		const receiver = new Database(":memory:");
		initTestSchema(receiver);
		insertMemory(receiver, "source");
		const malformed = { ...wireOps[0], payload_json: "{}" } as ReplicationOp;
		const result = applyReplicationOps(receiver, [malformed], "receiver");
		expect(result.errors[0]).toContain("reassign_payload_invalid");
		expect(receiver.prepare("SELECT active, scope_id, rev FROM memory_items").get()).toEqual({
			active: 1,
			scope_id: "source",
			rev: 2,
		});
		receiver.close();
	});

	it("withholds reassignment from peers that did not negotiate the additive feature", () => {
		const memoryId = insertMemory(db);
		recordScopeReassignment(db, {
			operationId: "share_operation",
			memoryId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const wireOps = ops(db);
		const [legacy] = filterReplicationOpsForSyncWithStatus(db, wireOps, "peer", {
			applyScopeFilter: false,
		});
		const [supported] = filterReplicationOpsForSyncWithStatus(db, wireOps, "peer", {
			applyScopeFilter: false,
			supportsReassignScope: true,
		});
		expect(legacy).toEqual([]);
		expect(supported).toHaveLength(2);
	});

	it("keeps visibility filtering on new-side reassignment payloads", () => {
		const memoryId = insertMemory(db);
		db.prepare("UPDATE memory_items SET visibility = 'private' WHERE id = ?").run(memoryId);
		recordScopeReassignment(db, {
			operationId: "share_private",
			memoryId,
			oldScopeId: "source",
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const newSide = ops(db).find((op) => parseReassignScopePayload(op).side === "new");
		if (!newSide) throw new Error("missing new-side reassignment");

		const [allowed, cursor, skipped] = filterReplicationOpsForSyncWithStatus(
			db,
			[newSide],
			"peer",
			{ applyScopeFilter: false, supportsReassignScope: true },
		);

		expect(allowed).toEqual([]);
		expect(cursor).toContain(newSide.op_id);
		expect(skipped).toMatchObject({ reason: "visibility_filter", visibility: "private" });
	});

	it("sends local-default old-side cleanup only to peers allowed for the project", () => {
		const memoryId = insertMemory(db, DEFAULT_SYNC_SCOPE_ID, "owner");
		recordScopeReassignment(db, {
			operationId: "share_default",
			memoryId,
			oldScopeId: DEFAULT_SYNC_SCOPE_ID,
			newScopeId: "managed",
			deviceId: "owner",
			createdAt: now,
		});
		const oldSide = ops(db).find((op) => parseReassignScopePayload(op).side === "old");
		if (!oldSide) throw new Error("missing old-side reassignment");
		for (const [peerDeviceId, projects] of [
			["allowed-peer", ["api"]],
			["blocked-peer", ["other"]],
		] as const) {
			db.prepare(
				`INSERT INTO sync_peers(peer_device_id, projects_include_json, created_at)
				 VALUES (?, ?, ?)`,
			).run(peerDeviceId, JSON.stringify(projects), now);
		}

		const [allowed, allowedCursor] = filterReplicationOpsForSyncWithStatus(
			db,
			[oldSide],
			"allowed-peer",
			{ localDeviceId: "owner", supportsReassignScope: true },
		);
		const [blocked, blockedCursor, skipped] = filterReplicationOpsForSyncWithStatus(
			db,
			[oldSide],
			"blocked-peer",
			{ localDeviceId: "owner", supportsReassignScope: true },
		);

		expect(allowed).toEqual([oldSide]);
		expect(allowedCursor).toContain(oldSide.op_id);
		expect(blocked).toEqual([]);
		expect(blockedCursor).toContain(oldSide.op_id);
		expect(skipped).toMatchObject({ reason: "scope_filter", scope_id: DEFAULT_SYNC_SCOPE_ID });
	});
});

/** A shared memory written before sync setup, so its origin is "local". */
function insertPreSyncMemory(
	db: InstanceType<typeof Database>,
	input: { origin?: string | null; sessionUser?: string; metadataJson?: string } = {},
): number {
	const session = db
		.prepare(`INSERT INTO sessions(started_at, project, git_remote, user, tool_version)
			VALUES (?, 'api', ?, ?, ?)`)
		.run(
			now,
			"https://example.invalid/acme/api.git",
			input.sessionUser ?? "adam",
			input.sessionUser === "sync" ? "sync_replication" : "codemem",
		);
	return Number(
		db
			.prepare(`INSERT INTO memory_items(
				session_id, kind, title, body_text, confidence, tags_text, active, created_at,
				updated_at, metadata_json, import_key, rev, visibility, scope_id, origin_device_id
			) VALUES (?, 'discovery', 'title', 'body', 0.8, '', 1, ?, ?, ?, 'memory:key', 1, 'shared', ?, ?)`)
			.run(
				Number(session.lastInsertRowid),
				now,
				now,
				input.metadataJson ?? "{}",
				DEFAULT_SYNC_SCOPE_ID,
				input.origin === undefined ? "local" : input.origin,
			).lastInsertRowid,
	);
}

function reassignFromLocalDefault(
	owner: InstanceType<typeof Database>,
	memoryId: number,
	options: { claimLocalOrigin?: boolean } = {},
) {
	return recordScopeReassignment(owner, {
		operationId: "share_pre_sync",
		memoryId,
		oldScopeId: DEFAULT_SYNC_SCOPE_ID,
		newScopeId: "managed",
		deviceId: "owner",
		createdAt: now,
		...options,
	});
}

function sideOps(owner: InstanceType<typeof Database>, side: "old" | "new"): ReplicationOp[] {
	return ops(owner).filter((op) => parseReassignScopePayload(op).side === side);
}

describe("claiming a local origin while reassigning", () => {
	let owner: InstanceType<typeof Database>;

	beforeEach(() => {
		owner = new Database(":memory:");
		initTestSchema(owner);
	});

	afterEach(() => owner.close());

	function origin(memoryId: number): unknown {
		return owner
			.prepare("SELECT origin_device_id FROM memory_items WHERE id = ?")
			.pluck()
			.get(memoryId);
	}

	function newSideOrigin(): unknown {
		return JSON.parse(sideOps(owner, "new")[0]?.payload_json ?? "{}").origin_device_id;
	}

	it("records the owner as origin in the same write, so the new side carries it", () => {
		// Arrange
		const memoryId = insertPreSyncMemory(owner);

		// Act
		reassignFromLocalDefault(owner, memoryId, { claimLocalOrigin: true });

		// Assert
		expect(origin(memoryId)).toBe("owner");
		expect(newSideOrigin()).toBe("owner");
	});

	it("also claims a memory with no recorded origin", () => {
		// Arrange
		const memoryId = insertPreSyncMemory(owner, { origin: null });

		// Act
		reassignFromLocalDefault(owner, memoryId, { claimLocalOrigin: true });

		// Assert
		expect(origin(memoryId)).toBe("owner");
	});

	it("keeps a local origin when the caller doesn't ask to claim it", () => {
		// Arrange
		const memoryId = insertPreSyncMemory(owner);

		// Act
		reassignFromLocalDefault(owner, memoryId);

		// Assert
		expect(origin(memoryId)).toBe("local");
		expect(newSideOrigin()).toBe("local");
	});

	it("never replaces another device's origin", () => {
		// Arrange
		const memoryId = insertPreSyncMemory(owner, { origin: "other-device" });

		// Act
		reassignFromLocalDefault(owner, memoryId, { claimLocalOrigin: true });

		// Assert
		expect(origin(memoryId)).toBe("other-device");
	});

	it("leaves a local origin from a sync session alone", () => {
		// Arrange
		const memoryId = insertPreSyncMemory(owner, { sessionUser: "sync" });

		// Act
		reassignFromLocalDefault(owner, memoryId, { claimLocalOrigin: true });

		// Assert
		expect(origin(memoryId)).toBe("local");
	});
});

describe("a recipient applying a share of pre-sync memories", () => {
	let owner: InstanceType<typeof Database>;
	let receiver: InstanceType<typeof Database>;

	beforeEach(async () => {
		owner = new Database(":memory:");
		initTestSchema(owner);
		// The recipient is a member of the new boundary alongside the owner.
		receiver = new Database(":memory:");
		initTestSchemaWithPeers(receiver, ["owner"]);
		receiver
			.prepare(`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status,
				created_at, updated_at
			) VALUES ('managed', 'managed', 'team', 'coordinator', 'coordinator-1', 'group-1', 1, 'active', ?, ?)`)
			.run(now, now);
		for (const deviceId of ["owner", "recipient"]) {
			receiver
				.prepare(`INSERT INTO scope_memberships(
					scope_id, device_id, role, status, membership_epoch, updated_at
				) VALUES ('managed', ?, 'member', 'active', 1, ?)`)
				.run(deviceId, now);
		}
		await refreshTestScopeRows(receiver);
	});

	afterEach(() => {
		owner.close();
		receiver.close();
	});

	/** The new side arrives first, through the Project's own pull, then the old side. */
	function applyBothSides() {
		const validation = { inboundScopeValidation: { peerDeviceId: "owner" } };
		const received = applyReplicationOps(
			receiver,
			sideOps(owner, "new"),
			"recipient",
			undefined,
			validation,
		);
		const cleanup = applyReplicationOps(
			receiver,
			sideOps(owner, "old"),
			"recipient",
			undefined,
			validation,
		);
		return { received, cleanup };
	}

	it("applies both sides of a fresh share without a rejection", () => {
		// Arrange
		reassignFromLocalDefault(owner, insertPreSyncMemory(owner), { claimLocalOrigin: true });

		// Act
		const { received, cleanup } = applyBothSides();

		// Assert
		expect([received.rejected, cleanup.rejected]).toEqual([0, 0]);
		expect(
			receiver.prepare("SELECT origin_device_id, scope_id, active FROM memory_items").get(),
		).toEqual({
			origin_device_id: "owner",
			scope_id: "managed",
			active: 1,
		});
	});

	it("rejects the cleanup when a local origin is shared unclaimed", () => {
		// Arrange
		reassignFromLocalDefault(owner, insertPreSyncMemory(owner));

		// Act
		const { cleanup } = applyBothSides();

		// Assert
		expect(cleanup.rejections.map((rejection) => rejection.reason)).toEqual(["sender_not_member"]);
	});
});

/** A recipient that is a member of the new boundary alongside the owner. */
async function recipientStore(): Promise<InstanceType<typeof Database>> {
	const receiver = new Database(":memory:");
	initTestSchemaWithPeers(receiver, ["owner"]);
	receiver
		.prepare(`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status,
			created_at, updated_at
		) VALUES ('managed', 'managed', 'team', 'coordinator', 'coordinator-1', 'group-1', 1, 'active', ?, ?)`)
		.run(now, now);
	for (const deviceId of ["owner", "recipient"]) {
		receiver
			.prepare(`INSERT INTO scope_memberships(
				scope_id, device_id, role, status, membership_epoch, updated_at
			) VALUES ('managed', ?, 'member', 'active', 1, ?)`)
			.run(deviceId, now);
	}
	await refreshTestScopeRows(receiver);
	return receiver;
}

describe("an owner sending cleanups recipients can't accept", () => {
	let owner: InstanceType<typeof Database>;

	beforeEach(() => {
		owner = new Database(":memory:");
		initTestSchema(owner);
	});

	afterEach(() => owner.close());

	/** What this device sends: `sender` is the device filtering its outbound ops. */
	function outbound(sender = "owner") {
		const [allowed, nextCursor] = filterReplicationOpsForSyncWithStatus(
			owner,
			ops(owner),
			"recipient",
			{ localDeviceId: sender, supportsReassignScope: true, applyScopeFilter: false },
		);
		return { allowed: allowed.map((op) => op.op_id), nextCursor };
	}

	const opIds = (list: ReplicationOp[]) => list.map((op) => op.op_id);

	it("withholds the cleanup of a memory shared without the owner as origin, and moves past it", () => {
		// Arrange: a share recorded before shares claimed the origin.
		reassignFromLocalDefault(owner, insertPreSyncMemory(owner));
		const last = ops(owner).at(-1);

		// Act
		const sent = outbound();

		// Assert
		expect(sent.allowed).toEqual(opIds(sideOps(owner, "new")));
		expect(sent.nextCursor).toBe(`${last?.created_at}|${last?.op_id}`);
	});

	it("withholds the cleanup of an imported memory without a known author", () => {
		// Arrange: moved by an earlier version; the claim refuses imported memories.
		const memoryId = insertPreSyncMemory(owner, { metadataJson: '{"source":"export"}' });
		reassignFromLocalDefault(owner, memoryId, { claimLocalOrigin: true });

		// Act
		const sent = outbound();

		// Assert
		expect(sent.allowed).toEqual(opIds(sideOps(owner, "new")));
	});

	it("still sends the cleanup of a memory that names the owner as origin", () => {
		// Arrange
		reassignFromLocalDefault(owner, insertPreSyncMemory(owner), { claimLocalOrigin: true });

		// Act
		const sent = outbound();

		// Assert
		expect(sent.allowed).toEqual(opIds(ops(owner)));
	});

	it("leaves cleanups recorded by another device to the recipient's own checks", () => {
		// Arrange: the same operations, filtered by a device that didn't record them.
		reassignFromLocalDefault(owner, insertPreSyncMemory(owner));

		// Act
		const sent = outbound("recipient");

		// Assert
		expect(sent.allowed).toEqual(opIds(ops(owner)));
	});

	it("withholds the cleanup once this device no longer has the memory", () => {
		// Arrange
		const memoryId = insertPreSyncMemory(owner);
		reassignFromLocalDefault(owner, memoryId);
		owner.prepare("DELETE FROM memory_items WHERE id = ?").run(memoryId);

		// Act
		const sent = outbound();

		// Assert
		expect(sent.allowed).toEqual(opIds(sideOps(owner, "new")));
	});

	it("lets a recipient stuck on that cleanup pull again without a rejection", async () => {
		// Arrange: the recipient already holds the memory and refuses its cleanup.
		reassignFromLocalDefault(owner, insertPreSyncMemory(owner));
		const receiver = await recipientStore();
		const validation = { inboundScopeValidation: { peerDeviceId: "owner" } };
		applyReplicationOps(receiver, sideOps(owner, "new"), "recipient", undefined, validation);
		const stuck = applyReplicationOps(receiver, ops(owner), "recipient", undefined, validation);
		const sentIds = new Set(outbound().allowed);

		// Act
		const pulled = applyReplicationOps(
			receiver,
			ops(owner).filter((op) => sentIds.has(op.op_id)),
			"recipient",
			undefined,
			validation,
		);

		// Assert: the copy it already has stays as it was.
		expect(stuck.rejections.map((rejection) => rejection.reason)).toEqual(["sender_not_member"]);
		expect(pulled.rejected).toBe(0);
		expect(
			receiver.prepare("SELECT origin_device_id, scope_id, active FROM memory_items").get(),
		).toEqual({ origin_device_id: "local", scope_id: "managed", active: 1 });
		receiver.close();
	});
});
