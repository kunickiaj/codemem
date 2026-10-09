import { expect, it } from "vitest";
import { exportMemories, importMemories } from "./export-import.js";
import { reset, scopeId, useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";
import { applyBootstrapSnapshot, mergeBootstrapSnapshot } from "./sync-bootstrap.js";
import { applyReplicationOps } from "./sync-replication.js";
import type { ReplicationOp } from "./types.js";

const { fixture, remember, rememberScoped, captureOp, row, ledger, factRows } =
	useLocalCaptureFixture();
function foreignOp(id: number): ReplicationOp {
	const original = captureOp(id);
	return {
		...original,
		op_id: `foreign-${original.op_id}`,
		device_id: "peer",
		clock_device_id: "peer",
		clock_rev: original.clock_rev + 100,
		payload_json: JSON.stringify({
			...JSON.parse(original.payload_json ?? "{}"),
			title: "Foreign revision",
			body_text: "Foreign body",
		}),
	};
}
function rawRows(key: string) {
	return fixture.store.db.prepare("SELECT * FROM memory_items WHERE import_key = ?").all(key);
}
function foreignFacts() {
	return factRows("memory_foreign_revisions");
}
function failedReplicationFixture(mode: string) {
	const id = rememberScoped();
	const op = foreignOp(id);
	let event = "UPDATE";
	let table = "memory_items";
	if (mode === "insert") {
		fixture.store.db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);
		event = "INSERT";
	}
	if (mode === "delete") op.op_type = "delete";
	if (mode.startsWith("reassign")) {
		op.op_type = "reassign_scope";
		op.payload_json = JSON.stringify({
			operation_id: "failed-reassign",
			memory_id: op.entity_id,
			old_scope_id: scopeId,
			new_scope_id: "destination",
			revision: op.clock_rev,
			side: "old",
		});
	}
	if (mode === "reassign operation") {
		table = "replication_ops";
		event = "INSERT";
	}
	if (mode === "foreign marker") {
		table = "memory_foreign_revisions";
		event = "INSERT";
	}
	return { op, table, event };
}

it.each(["upsert", "reassign_scope", "delete"] as const)(
	"same-key replication %s records permanent foreign proof without changing creation facts",
	(type) => {
		// Arrange
		const id = rememberScoped();
		const before = ledger();
		const op = { ...foreignOp(id), op_type: type };
		if (type === "reassign_scope")
			op.payload_json = JSON.stringify({
				operation_id: "fixture-reassign",
				memory_id: op.entity_id,
				old_scope_id: scopeId,
				new_scope_id: "destination",
				revision: op.clock_rev,
				side: "old",
			});
		// Act
		const result = applyReplicationOps(fixture.store.db, [op], fixture.store.deviceId);
		// Assert
		expect(result).toMatchObject({ applied: 1, errors: [] });
		expect(foreignFacts()).toMatchObject([{ entity_id: op.entity_id, write_path: "replication" }]);
		expect(ledger()).toEqual(before);
		if (type === "upsert") expect(row(id).body_text).toBe("Foreign body");
		else expect(row(id).active).toBe(0);
		expect(applyReplicationOps(fixture.store.db, [op], fixture.store.deviceId).skipped).toBe(1);
		expect(foreignFacts()).toHaveLength(1);
	},
);
it.each([applyBootstrapSnapshot, mergeBootstrapSnapshot])(
	"%s records proof for an applied same-key snapshot, not a stale merge",
	(apply) => {
		// Arrange
		const id = rememberScoped();
		const op = foreignOp(id);
		const before = ledger();
		const snapshots = factRows("memory_local_creation_snapshots");
		// Act / Assert: stale merge does not issue a negative fact.
		expect(
			mergeBootstrapSnapshot(fixture.store.db, "peer", [{ ...op, clock_rev: 0 }], reset).applied,
		).toBe(0);
		expect(foreignFacts()).toEqual([]);
		const result = apply(fixture.store.db, "peer", [op], reset);
		expect(result).toMatchObject({ ok: true, applied: 1 });
		expect(foreignFacts()).toMatchObject([{ entity_id: op.entity_id, write_path: "bootstrap" }]);
		expect(rawRows(op.entity_id)).toMatchObject([{ body_text: "Foreign body" }]);
		expect(ledger()).toEqual(before);
		expect(factRows("memory_local_creation_snapshots")).toEqual(snapshots);
	},
);
it("import skips duplicates but marks a deleted local key on reinsertion without restoring proof", () => {
	// Arrange
	const id = remember();
	const key = String(row(id).import_key);
	const before = ledger();
	const snapshots = factRows("memory_local_creation_snapshots");
	const payload = exportMemories({ dbPath: fixture.store.dbPath, allProjects: true });
	const options = { dbPath: fixture.store.dbPath, keysDir: fixture.keysDir };
	// Act / Assert: duplicate import cannot taint an untouched local row.
	expect(importMemories(payload, options).memory_items).toBe(0);
	expect(foreignFacts()).toEqual([]);
	fixture.store.db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);
	expect(importMemories(payload, options).memory_items).toBe(1);
	expect(foreignFacts()).toMatchObject([{ entity_id: key, write_path: "import" }]);
	expect(rawRows(key)).toHaveLength(1);
	expect(ledger()).toEqual(before);
	expect(factRows("memory_local_creation_snapshots")).toEqual(snapshots);
});
it("rejected replication scope collisions and unauthorized import cannot issue foreign facts", () => {
	// Arrange
	const id = rememberScoped();
	const op = foreignOp(id);
	const before = rawRows(op.entity_id);
	// Act
	const result = applyReplicationOps(
		fixture.store.db,
		[{ ...op, scope_id: "local-default" }],
		fixture.store.deviceId,
		undefined,
		{ inboundScopeValidation: { peerDeviceId: "peer", enabled: false } },
	);
	// Assert
	expect(result.rejected).toBe(1);
	expect(rawRows(op.entity_id)).toEqual(before);
	expect(foreignFacts()).toEqual([]);
	const importId = remember("Unauthorized import control");
	const payload = exportMemories({ dbPath: fixture.store.dbPath, allProjects: true });
	expect(payload.memory_items).toHaveLength(1);
	for (const memory of payload.memory_items) memory.scope_id = scopeId;
	fixture.store.db.prepare("DELETE FROM memory_items WHERE id = ?").run(importId);
	expect(() => importMemories(payload, { dbPath: fixture.store.dbPath })).toThrow(
		"unauthorized_scope",
	);
	expect(rawRows(op.entity_id)).toEqual(before);
	expect(foreignFacts()).toEqual([]);
});
it.each(["replication", "replace", "merge", "import"])(
	"%s write failures preserve creation facts with the accepted transaction behavior",
	(path) => {
		// Arrange: replication catches each failed op; the other APIs abort their transaction.
		const id = path === "import" ? remember() : rememberScoped();
		const op = foreignOp(id);
		const before = ledger();
		const snapshots = factRows("memory_local_creation_snapshots");
		const payload = exportMemories({ dbPath: fixture.store.dbPath, allProjects: true });
		if (path === "import")
			fixture.store.db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);
		const content = rawRows(op.entity_id);
		const event = path === "replication" ? "UPDATE" : "INSERT";
		fixture.store.db.exec(`CREATE TRIGGER fail_foreign BEFORE ${event} ON memory_items
			BEGIN SELECT RAISE(ABORT, 'foreign_write_failed'); END`);
		const apply = () => {
			if (path === "replication")
				return applyReplicationOps(fixture.store.db, [op], fixture.store.deviceId);
			if (path === "import") return importMemories(payload, { dbPath: fixture.store.dbPath });
			const snapshot = path === "replace" ? applyBootstrapSnapshot : mergeBootstrapSnapshot;
			return snapshot(fixture.store.db, "peer", [op], reset);
		};
		// Act / Assert: failed content writes cannot taint unchanged genuine creation proof.
		if (path === "replication")
			expect(apply()).toMatchObject({
				applied: 0,
				errors: [expect.stringContaining("foreign_write_failed")],
			});
		else expect(apply).toThrow("foreign_write_failed");
		expect(foreignFacts()).toEqual([]);
		expect(rawRows(op.entity_id)).toEqual(content);
		expect(ledger()).toEqual(before);
		expect(factRows("memory_local_creation_snapshots")).toEqual(snapshots);
		fixture.store.db.exec("DROP TRIGGER fail_foreign");
		apply();
		expect(foreignFacts()).toHaveLength(1);
		expect(rawRows(op.entity_id)).toHaveLength(1);
	},
);
it.each(["insert", "delete", "reassign content", "reassign operation", "foreign marker"])(
	"failed replication %s rolls back every write in that op",
	(mode) => {
		// Arrange: late operation-record failure occurs after the old-side tombstone update.
		const { op, event, table } = failedReplicationFixture(mode);
		const db = fixture.store.db;
		const content = rawRows(op.entity_id);
		const before = ledger();
		const snapshots = factRows("memory_local_creation_snapshots");
		const operations = factRows("replication_ops");
		const resetState = factRows("sync_reset_state_v2");
		db.exec(`CREATE TRIGGER fail_replication BEFORE ${event} ON ${table}
			BEGIN SELECT RAISE(ABORT, 'replication_write_failed'); END`);
		// Act
		const result = applyReplicationOps(db, [op], fixture.store.deviceId);
		// Assert: failed operations are not counted as applied and cannot taint proof.
		expect(result).toMatchObject({
			applied: 0,
			errors: [expect.stringContaining("replication_write_failed")],
			vectorWork: { upsertMemoryIds: [], deleteMemoryIds: [] },
		});
		expect(foreignFacts()).toEqual([]);
		expect(rawRows(op.entity_id)).toEqual(content);
		expect(ledger()).toEqual(before);
		expect(factRows("memory_local_creation_snapshots")).toEqual(snapshots);
		expect(factRows("replication_ops")).toEqual(operations);
		expect(factRows("sync_reset_state_v2")).toEqual(resetState);
		db.exec("DROP TRIGGER fail_replication");
		expect(applyReplicationOps(db, [op], fixture.store.deviceId)).toMatchObject({
			applied: 1,
			errors: [],
		});
		expect(foreignFacts()).toHaveLength(1);
	},
);
