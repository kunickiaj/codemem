import { expect, it, vi } from "vitest";
import { hasMatchingLocalCreation } from "./memory-creation-provenance.js";
import { localCreationSourceIds } from "./memory-local-capture.js";
import { now, scopeId, useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";
import * as syncIdentity from "./sync-identity.js";
import { applyReplicationOps, DEFAULT_SYNC_SCOPE_ID } from "./sync-replication.js";
import type { ReplicationOp } from "./types.js";

const { fixture, rememberScoped, row, enroll, ledger } = useLocalCaptureFixture();

function cleanup(id: number, sender = "peer", scope = scopeId): ReplicationOp {
	return {
		op_id: `cleanup-${id}`,
		device_id: sender,
		entity_type: "memory_item",
		entity_id: String(row(id).import_key),
		op_type: "access_cleanup",
		payload_json: JSON.stringify({ cleanup_scope_id: scope, reason: "scope_revoked" }),
		clock_rev: 100,
		clock_updated_at: now,
		clock_device_id: sender,
		created_at: now,
		scope_id: DEFAULT_SYNC_SCOPE_ID,
	};
}

it.each(["unsigned capture", "adopted capture", "enrolled device"])(
	"cleanup batches retain %s and delete only matching imports without runtime key loads",
	(creator) => {
		// Arrange: maintained creation/enrollment APIs issue facts and real signing keys.
		if (creator === "enrolled device") enroll();
		const originals = [rememberScoped("Original one"), rememberScoped("Original two")];
		if (creator === "adopted capture") enroll();
		const db = fixture.store.db;
		const publicKey = syncIdentity.loadRuntimeSigningPublicKey(db, {
			deviceId: fixture.store.deviceId,
			keysDir: fixture.keysDir,
		});
		expect(publicKey === null).toBe(creator === "unsigned capture");
		const sources = localCreationSourceIds(db, fixture.store.deviceId, {
			expectedPublicKey: publicKey ?? undefined,
		});
		for (const id of originals) {
			expect(hasMatchingLocalCreation(db, String(row(id).import_key), sources)).toBe(true);
		}
		// Even a mutable sender label cannot turn a recorded original into an import.
		db.prepare("UPDATE memory_items SET origin_device_id = 'peer' WHERE id = ?").run(originals[1]);
		const imports = [0, 1, 2, 3].map((index) =>
			rememberScoped(`Imported ${index}`, {
				origin_device_id: "peer",
				import_key: `foreign-${index}`,
			}),
		);
		const ops = [
			...originals.map((id) => cleanup(id)),
			...imports.map((id, index) => {
				if (index === 2) return cleanup(id, "other-peer");
				if (index === 3) return cleanup(id, "peer", "other-scope");
				return cleanup(id);
			}),
		];
		const retainedIds = [...originals, ...imports.slice(2)];
		const before = retainedIds.map(row);
		const facts = ledger();
		const loadKey = vi.spyOn(syncIdentity, "loadRuntimeSigningPublicKey");
		// Act: exercise existing rows in one writer transaction, then replay its acknowledgements.
		const result = applyReplicationOps(db, ops, fixture.store.deviceId, undefined, {
			keysDir: fixture.keysDir,
		});
		const replay = applyReplicationOps(db, ops, fixture.store.deviceId, undefined, {
			keysDir: fixture.keysDir,
		});
		// Assert: key I/O is unnecessary for either retention or foreign sender/scope checks.
		expect(result).toMatchObject({
			applied: 2,
			skipped: 4,
			errors: [],
			vectorWork: { upsertMemoryIds: [], deleteMemoryIds: imports.slice(0, 2) },
		});
		expect(replay).toMatchObject({
			applied: 0,
			skipped: 6,
			errors: [],
			vectorWork: { upsertMemoryIds: [], deleteMemoryIds: [] },
		});
		expect(retainedIds.map(row)).toEqual(before);
		expect(imports.slice(0, 2).map(row)).toEqual([undefined, undefined]);
		expect(ledger()).toEqual(facts);
		for (const op of ops) {
			expect(
				db.prepare("SELECT COUNT(*) FROM replication_ops WHERE op_id = ?").pluck().get(op.op_id),
			).toBe(1);
		}
		expect(loadKey).not.toHaveBeenCalled();
	},
);
