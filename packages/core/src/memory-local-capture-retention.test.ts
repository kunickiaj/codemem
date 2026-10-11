import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import {
	enrollFixtureSigningKey,
	refreshManagedScopeFixture,
} from "./managed-scope-test-fixtures.js";
import { hasMatchingLocalCreation } from "./memory-creation-provenance.js";
import { localCreationSourceIds } from "./memory-local-capture.js";
import {
	now,
	reset,
	scopeId,
	useLocalCaptureFixture,
} from "./memory-local-capture-test-fixtures.js";
import { upsertCachedScopeMemberships } from "./scope-membership-cache.js";
import { MemoryStore } from "./store.js";
import { applyBootstrapSnapshot, mergeBootstrapSnapshot } from "./sync-bootstrap.js";
import * as syncIdentity from "./sync-identity.js";
import { loadRuntimeSigningPublicKey } from "./sync-identity.js";
import {
	applyReplicationOps,
	DEFAULT_SYNC_SCOPE_ID,
	diagnoseStalePeerReceivedRows,
	filterReplicationOpsForSyncWithStatus,
	pruneReplicationOps,
	reconcileStalePeerReceivedRows,
} from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

const { fixture, remember, rememberScoped, row, binding, captureOp, enroll, factRows, ledger } =
	useLocalCaptureFixture();

function options(keysDir = fixture.keysDir) {
	return { localDeviceId: fixture.store.deviceId, keysDir };
}
function proofFacts() {
	return { ...ledger(), snapshots: factRows("memory_local_creation_snapshots") };
}
function persistedState() {
	return [
		"memory_items",
		"replication_ops",
		"replication_cursors",
		"memory_file_refs",
		"memory_concept_refs",
		"sync_device",
		"scope_memberships",
		"replication_scopes",
		"memory_foreign_revisions",
	].map((table) => factRows(table));
}
function staleAuthorization(state: string) {
	upsertCachedScopeMemberships(fixture.store.db, [
		{
			scope_id: scopeId,
			device_id: fixture.store.deviceId,
			role: "member",
			status: state === "revoked" ? "revoked" : "active",
			membership_epoch: state === "stale epoch" ? 0 : 1,
			coordinator_id: "capture-coordinator",
			group_id: "capture-group",
			manifest_issuer_device_id: null,
			manifest_hash: null,
			signed_manifest_json: null,
			updated_at: now,
		},
	]);
	if (state === "inactive scope")
		fixture.store.db
			.prepare("UPDATE replication_scopes SET status = 'archived' WHERE scope_id = ?")
			.run(scopeId);
}
function actualSources() {
	const publicKey = loadRuntimeSigningPublicKey(fixture.store.db, {
		deviceId: fixture.store.deviceId,
		keysDir: fixture.keysDir,
	});
	return localCreationSourceIds(fixture.store.db, fixture.store.deviceId, {
		expectedPublicKey: publicKey ?? undefined,
	});
}
function createScoped(creator: string) {
	if (creator === "enrolled device") enroll();
	const id = rememberScoped();
	if (creator === "adopted capture") enroll();
	return id;
}
function otherKeys() {
	const keysDir = join(fixture.dir, "other-keys");
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		enrollFixtureSigningKey(db, keysDir, "other-device");
		return keysDir;
	} finally {
		db.close();
	}
}
function foreignControl() {
	return rememberScoped("Foreign imported control", {
		origin_device_id: "peer",
		import_key: "foreign-control",
	});
}
function cleanupOp(id: number, overrides: Partial<ReplicationOp> = {}): ReplicationOp {
	return {
		op_id: `cleanup-${id}`,
		device_id: "peer",
		entity_type: "memory_item",
		entity_id: String(row(id).import_key),
		op_type: "access_cleanup",
		payload_json: JSON.stringify({ cleanup_scope_id: scopeId, reason: "scope_revoked" }),
		clock_rev: 100,
		clock_updated_at: now,
		clock_device_id: "peer",
		created_at: now,
		scope_id: DEFAULT_SYNC_SCOPE_ID,
		...overrides,
	};
}

// Frozen reference cases 336–376: two creator modes, extended with absent actual keys.
it.each([
	{ creator: "adopted capture", keys: "wrong" },
	{ creator: "enrolled device", keys: "wrong" },
	{ creator: "adopted capture", keys: "missing" },
	{ creator: "enrolled device", keys: "missing" },
])("$keys actual key preserves $creator as restricted ambiguity", ({ creator, keys }) => {
	// Arrange: only maintained creation/enrollment APIs issue proof.
	const id = createScoped(creator);
	const original = row(id);
	const before = proofFacts();
	const keysDir = keys === "wrong" ? otherKeys() : join(fixture.dir, "missing-keys");
	const keyBytes = readFileSync(join(fixture.keysDir, "device.key"));
	const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
	const state = persistedState();
	// Act
	const diagnosis = diagnoseStalePeerReceivedRows(fixture.store.db, options(keysDir));
	expect(persistedState()).toEqual(state);
	expect(proofFacts()).toEqual(before);
	const result = reconcileStalePeerReceivedRows(fixture.store.db, options(keysDir));
	// Assert: no proof, deletion, key repair, or historical read authority.
	expect(diagnosis).toMatchObject({ would_delete: 0, retained: 0 });
	expect(result).toMatchObject({ deleted: 0, retained: 0 });
	expect(result.ambiguous).toEqual([
		expect.objectContaining({ memory_id: id, reason: "unverified_local_creation" }),
	]);
	expect(diagnosis.ambiguous).toEqual(result.ambiguous);
	expect(row(id)).toEqual(original);
	expect(proofFacts()).toEqual(before);
	// Reconciliation options do not configure the reader's actual key authority.
	fixture.store.close();
	fixture.store = new MemoryStore(join(fixture.dir, "memory.sqlite"), { keysDir });
	expect(fixture.store.get(id)).toBeNull();
	expect(ensure).not.toHaveBeenCalled();
	expect(readFileSync(join(fixture.keysDir, "device.key"))).toEqual(keyBytes);
	if (keys === "missing") expect(existsSync(keysDir)).toBe(false);
});

it.each(
	["unsigned capture", "adopted capture", "enrolled device"].flatMap((creator) =>
		["revoked", "inactive scope", "stale epoch"].map((state) => ({ creator, state })),
	),
)(
	"$state preserves readable genuine $creator without granting writes or transmission",
	({ creator, state }) => {
		// Arrange: stale cache states never supply enrollment or creation proof.
		const id = createScoped(creator);
		staleAuthorization(state);
		const original = row(id);
		const op = captureOp(id);
		const foreign = foreignControl();
		const before = proofFacts();
		const ensure = vi.spyOn(syncIdentity, "ensureDeviceIdentity");
		const persisted = persistedState();
		// Act
		const diagnosis = diagnoseStalePeerReceivedRows(fixture.store.db, options());
		expect(persistedState()).toEqual(persisted);
		expect(proofFacts()).toEqual(before);
		const result = reconcileStalePeerReceivedRows(fixture.store.db, options());
		const [outbound] = filterReplicationOpsForSyncWithStatus(fixture.store.db, [op], "peer", {
			localDeviceId: fixture.store.deviceId,
		});
		const replay = reconcileStalePeerReceivedRows(fixture.store.db, options());
		// Assert: actual proof preserves the original, not the imported control or permissions.
		expect(diagnosis).toMatchObject({
			would_delete_memory_ids: [foreign],
			retained: 1,
			ambiguous: [],
		});
		expect(result).toMatchObject({ deleted_memory_ids: [foreign], retained: 1, ambiguous: [] });
		expect(replay).toMatchObject({ deleted: 0, retained: 1, ambiguous: [] });
		expect(row(id)).toEqual(original);
		expect(binding(id)?.evidence).toBe("local_creation");
		expect(hasMatchingLocalCreation(fixture.store.db, op.entity_id, actualSources())).toBe(true);
		expect(fixture.store.get(id)?.id).toBe(id);
		expect(fixture.store.isScopeWritable(scopeId)).toBe(false);
		expect(outbound).toEqual([]);
		expect(proofFacts()).toEqual(before);
		expect(ensure).not.toHaveBeenCalled();
		if (creator === "unsigned capture") expect(existsSync(fixture.keysDir)).toBe(false);
	},
);

it.each(["content edit", "scope edit", "foreign revision"])(
	"preserves %s as ambiguous rather than matching creation",
	(change) => {
		// Arrange: the immutable original is real, while the current row no longer matches.
		const id = createScoped("adopted capture");
		const op = captureOp(id);
		const before = proofFacts();
		if (change === "content edit")
			fixture.store.db
				.prepare("UPDATE memory_items SET body_text = 'Edited body' WHERE id = ?")
				.run(id);
		if (change === "scope edit")
			fixture.store.db
				.prepare("UPDATE memory_items SET scope_id = 'other-scope' WHERE id = ?")
				.run(id);
		if (change === "foreign revision") {
			const result = applyReplicationOps(
				fixture.store.db,
				[
					{
						...op,
						op_id: `foreign-${op.op_id}`,
						device_id: "peer",
						clock_device_id: "peer",
						clock_rev: op.clock_rev + 100,
					},
				],
				fixture.store.deviceId,
			);
			expect(result).toMatchObject({ applied: 1, errors: [] });
		}
		const original = row(id);
		const negativeFacts = factRows("memory_foreign_revisions");
		// Act
		const result = reconcileStalePeerReceivedRows(fixture.store.db, options());
		// Assert: preservation is not proof that the current revision is locally authored.
		expect(result).toMatchObject({ deleted: 0, retained: 0 });
		expect(result.ambiguous).toContainEqual(
			expect.objectContaining({ memory_id: id, reason: "unverified_local_creation" }),
		);
		expect(hasMatchingLocalCreation(fixture.store.db, op.entity_id, actualSources())).toBe(false);
		expect(row(id)).toEqual(original);
		expect(proofFacts()).toEqual(before);
		expect(factRows("memory_foreign_revisions")).toEqual(negativeFacts);
		expect(fixture.store.get(id)).toBeNull();
	},
);

// Replacement is foreign; an unapplied merge preserves matching genuine history.
it.each([
	{ creator: "adopted capture", replace: true },
	{ creator: "adopted capture", replace: false },
	{ creator: "enrolled device", replace: true },
	{ creator: "enrolled device", replace: false },
])(
	"$creator survives bootstrap replace=$replace, pruning and reopen with revision-specific reads",
	async ({ creator, replace }) => {
		// Arrange: establish real enrollment before revoking its actual cached permission.
		const id = createScoped(creator);
		const control = remember("Unchanged local control");
		await refreshManagedScopeFixture(fixture.store.db, {
			keysDir: fixture.keysDir,
			deviceId: fixture.store.deviceId,
			scopeIds: [scopeId],
		});
		const op = captureOp(id);
		const entityId = String(row(id).import_key);
		const before = proofFacts();
		fixture.store.db
			.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
			.run(scopeId);
		// Act: maintained bootstrap writes permanent negative provenance only if applied.
		const bootstrap = replace ? applyBootstrapSnapshot : mergeBootstrapSnapshot;
		if (op.payload_json === null) throw new Error("capture upsert requires a JSON payload");
		const applied = bootstrap(
			fixture.store.db,
			"peer",
			[{ ...op, op_type: "upsert", payload_json: op.payload_json }],
			reset,
		);
		const restoredId = fixture.store.db
			.prepare("SELECT id FROM memory_items WHERE import_key = ?")
			.pluck()
			.get(entityId) as number;
		const ambiguous = rememberScoped("Unverified local origin", {
			origin_device_id: fixture.store.deviceId,
			import_key: "unverified-local",
		});
		const originalAmbiguous = row(ambiguous);
		const foreign = foreignControl();
		const diagnosis = diagnoseStalePeerReceivedRows(fixture.store.db, options());
		const result = reconcileStalePeerReceivedRows(fixture.store.db, options());
		vi.spyOn(Date, "now").mockReturnValue(new Date("2026-10-20T00:00:00Z").getTime());
		const retention = pruneReplicationOps(fixture.store.db, { maxAgeDays: 1 });
		// Assert: peer replacement retains original facts, never inheriting current-revision proof.
		expect(applied).toMatchObject({ ok: true, applied: replace ? 1 : 0 });
		expect(diagnosis.would_delete_memory_ids).toContain(foreign);
		expect(result.deleted_memory_ids).toContain(foreign);
		expect(result.retained).toBeGreaterThanOrEqual(1);
		expect(result.ambiguous).toContainEqual(
			expect.objectContaining({ memory_id: ambiguous, reason: "unverified_local_creation" }),
		);
		expect(row(ambiguous)).toEqual(originalAmbiguous);
		expect(row(restoredId)).toBeDefined();
		expect(fixture.store.get(ambiguous)).toBeNull();
		expect(fixture.store.get(restoredId)?.id ?? null).toBe(replace ? null : restoredId);
		expect(fixture.store.get(control)?.id).toBe(control);
		expect(fixture.store.isScopeWritable(scopeId)).toBe(false);
		expect(hasMatchingLocalCreation(fixture.store.db, entityId, actualSources())).toBe(!replace);
		expect(factRows("memory_foreign_revisions")).toEqual(
			replace ? [expect.objectContaining({ entity_id: entityId, write_path: "bootstrap" })] : [],
		);
		expect(proofFacts()).toEqual(before);
		expect(retention.deleted).toBeGreaterThan(0);
		fixture.store.close();
		fixture.store = new MemoryStore(join(fixture.dir, "memory.sqlite"), {
			keysDir: fixture.keysDir,
		});
		expect(fixture.store.get(restoredId)?.id ?? null).toBe(replace ? null : restoredId);
		expect(fixture.store.get(control)?.id).toBe(control);
		expect(proofFacts()).toEqual(before);
	},
);

it.each(["unsigned capture", "adopted capture", "enrolled device"])(
	"inbound cleanup cannot delete recorded %s even when mutable origin names its sender",
	(creator) => {
		// Arrange: a mutable peer label is not evidence that the creator was a peer.
		const id = createScoped(creator);
		fixture.store.db
			.prepare("UPDATE memory_items SET origin_device_id = 'peer' WHERE id = ?")
			.run(id);
		const original = row(id);
		const before = proofFacts();
		const op = cleanupOp(id);
		// Act
		const result = applyReplicationOps(fixture.store.db, [op], fixture.store.deviceId);
		const replay = applyReplicationOps(fixture.store.db, [op], fixture.store.deviceId);
		// Assert: neither physical deletion nor vector deletion escapes the skip.
		expect(result).toMatchObject({
			applied: 0,
			skipped: 1,
			errors: [],
			vectorWork: { deleteMemoryIds: [] },
		});
		expect(replay).toMatchObject({ applied: 0, skipped: 1, errors: [] });
		expect(row(id)).toEqual(original);
		expect(proofFacts()).toEqual(before);
		expect(fixture.store.get(id)?.id).toBe(id);
		expect(
			fixture.store.db
				.prepare("SELECT COUNT(*) FROM replication_ops WHERE op_id = ?")
				.pluck()
				.get(op.op_id),
		).toBe(1);
	},
);

it.each(["matching sender", "wrong sender", "wrong scope"])(
	"inbound foreign cleanup handles %s and replay without altering creator facts",
	(mode) => {
		// Arrange: this imported control has no fabricated local-creation proof.
		const id = foreignControl();
		const original = row(id);
		const before = proofFacts();
		const op = cleanupOp(id);
		if (mode === "wrong sender") {
			op.device_id = "other-peer";
			op.clock_device_id = "other-peer";
		}
		if (mode === "wrong scope")
			op.payload_json = JSON.stringify({ cleanup_scope_id: "other-scope" });
		// Act
		const result = applyReplicationOps(fixture.store.db, [op], fixture.store.deviceId);
		const replay = applyReplicationOps(fixture.store.db, [op], fixture.store.deviceId);
		// Assert: only a matching foreign sender/scope deletes; replay never repeats vector work.
		const matches = mode === "matching sender";
		expect(result).toMatchObject({
			applied: matches ? 1 : 0,
			skipped: matches ? 0 : 1,
			errors: [],
		});
		expect(result.vectorWork.deleteMemoryIds).toEqual(matches ? [id] : []);
		expect(row(id)).toEqual(matches ? undefined : original);
		expect(replay).toMatchObject({
			applied: 0,
			skipped: 1,
			errors: [],
			vectorWork: { deleteMemoryIds: [] },
		});
		expect(proofFacts()).toEqual(before);
		expect(
			fixture.store.db
				.prepare("SELECT COUNT(*) FROM replication_ops WHERE op_id = ?")
				.pluck()
				.get(op.op_id),
		).toBe(1);
	},
);
