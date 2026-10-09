import { existsSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { enrollFixtureSigningKey } from "./managed-scope-test-fixtures.js";
import {
	hasMatchingLocalCreation,
	hasRecordedLocalCreation,
	matchingLocalCreationClause,
	recordForeignMemoryRevision,
	recordLocalCreationSnapshot,
} from "./memory-creation-provenance.js";
import {
	adoptLocalCapture,
	getOrCreateLocalCaptureId,
	hasLocalCreationBinding,
	hasPendingLocalCapture,
	localCreationSourceIds,
} from "./memory-local-capture.js";
import { now, useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";
import {
	allocateLocalCaptureMemorySource,
	getVerifiedMemorySource,
} from "./memory-source-identity.js";

const { fixture, factRows } = useLocalCaptureFixture();
const tables = [
	"memory_local_capture",
	"memory_local_capture_adoption",
	"memory_local_creation_snapshots",
	"memory_foreign_revisions",
];
function schema() {
	return fixture.store.db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
}
function createCapture() {
	const db = fixture.store.db;
	const binding = allocateLocalCaptureMemorySource(db, "local");
	if (!binding) throw new Error("Missing direct storage binding");
	const inserted = db
		.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, import_key)
		VALUES (?, 'discovery', 'Storage capture', 'Body', 0.8, '', 1, ?, ?, '{}', ?)`)
		.run(fixture.sessionId, now, now, binding.entityId);
	const id = Number(inserted.lastInsertRowid);
	recordLocalCreationSnapshot(db, id);
	return { id, ...binding };
}
it("requires a transaction before issuing birth, binding, snapshot, adoption or foreign proof", () => {
	// Arrange: the ordinary writer is deliberately not activated in this stage.
	const db = fixture.store.db;
	const before = schema();
	const calls = [
		() => getOrCreateLocalCaptureId(db),
		() => allocateLocalCaptureMemorySource(db, "local"),
		() => recordLocalCreationSnapshot(db, -1),
		() => adoptLocalCapture(db, "source", {}),
		() => recordForeignMemoryRevision(db, "missing", "import"),
	];
	// Act / Assert: all rejections precede DDL or key creation.
	for (const call of calls) expect(call).toThrow("memory_source_transaction_required");
	expect(schema()).toEqual(before);
	expect(existsSync(fixture.keysDir)).toBe(false);
});
it("commits birth, binding, snapshot and foreign facts together and rolls all of them back", () => {
	// Arrange
	const db = fixture.store.db;
	const before = schema();
	let abortedKey = "";
	// Act
	expect(() =>
		db.transaction(() => {
			const capture = createCapture();
			abortedKey = capture.entityId;
			recordForeignMemoryRevision(db, capture.entityId, "bootstrap");
			throw new Error("abort capture");
		})(),
	).toThrow("abort capture");
	// Assert: even lazily created tables and the binding roll back.
	expect(schema()).toEqual(before);
	expect(getVerifiedMemorySource(db, abortedKey)).toBeNull();
	for (const table of tables) expect(factRows(table)).toEqual([]);
	const capture = db.transaction(() => {
		const result = createCapture();
		recordForeignMemoryRevision(db, result.entityId, "bootstrap");
		return result;
	})();
	expect(getVerifiedMemorySource(db, capture.entityId)?.evidence).toBe("local_creation");
	for (const table of tables.filter((name) => name !== "memory_local_capture_adoption"))
		expect(factRows(table)).toHaveLength(1);
});
it("keeps birth and adoption singletons and accepts only the actual ensured signing key", () => {
	// Arrange
	const db = fixture.store.db;
	const capture = db.transaction(createCapture)();
	const key = enrollFixtureSigningKey(db, fixture.keysDir, "capture-device");
	// Act / Assert: a mismatching key cannot associate the unsigned birth.
	db.transaction(() => adoptLocalCapture(db, "capture-device", { expectedPublicKey: "wrong" }))();
	expect(hasPendingLocalCapture(db)).toBe(true);
	expect(factRows("memory_local_capture_adoption")).toEqual([]);
	db.transaction(() => adoptLocalCapture(db, "capture-device", { expectedPublicKey: key }))();
	const before = factRows("memory_local_capture_adoption");
	db.transaction(() => adoptLocalCapture(db, "capture-device", { expectedPublicKey: key }))();
	expect(factRows("memory_local_capture_adoption")).toEqual(before);
	expect(db.transaction(() => getOrCreateLocalCaptureId(db))()).toBe(capture.sourceDeviceId);
	expect(hasPendingLocalCapture(db)).toBe(false);
	expect(localCreationSourceIds(db, "capture-device", { expectedPublicKey: key })).toEqual([
		"capture-device",
		capture.sourceDeviceId,
	]);
	expect(localCreationSourceIds(db, "capture-device", { expectedPublicKey: "wrong" })).toEqual([]);
});
it.each(["UPDATE", "DELETE", "INSERT OR REPLACE"])("rejects %s", (operation) => {
	// Arrange: two keys prove that per-key facts are not singletons.
	const db = fixture.store.db;
	const first = db.transaction(createCapture)();
	const second = db.transaction(createCapture)();
	const key = enrollFixtureSigningKey(db, fixture.keysDir, "capture-device");
	db.transaction(() => {
		adoptLocalCapture(db, "capture-device", { expectedPublicKey: key });
		for (const capture of [first, second])
			recordForeignMemoryRevision(db, capture.entityId, "replication");
	})();
	// Act / Assert
	for (const table of [...tables, "memory_source_bindings"]) {
		const before = factRows(table);
		let sql = `DELETE FROM ${table}`;
		if (operation === "UPDATE") sql = `UPDATE ${table} SET created_at = created_at`;
		if (operation === "INSERT OR REPLACE")
			sql = `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`;
		expect(() => db.exec(sql)).toThrow(/immutable/);
		expect(factRows(table)).toEqual(before);
	}
	expect(factRows("memory_local_capture")).toHaveLength(1);
	expect(factRows("memory_local_creation_snapshots")).toHaveLength(2);
	expect(factRows("memory_foreign_revisions")).toHaveLength(2);
});
it("matches original content and scope but permanently rejects a foreign revision", () => {
	// Arrange
	const db = fixture.store.db;
	const capture = db.transaction(createCapture)();
	const matches = () => hasMatchingLocalCreation(db, capture.entityId, [capture.sourceDeviceId]);
	// Act / Assert: content and scope must still match, regardless of mutable origin claims.
	expect(matches()).toBe(true);
	for (const [column, value] of [
		["title", "Changed"],
		["scope_id", "foreign"],
	]) {
		db.prepare(`UPDATE memory_items SET ${column} = ? WHERE id = ?`).run(value, capture.id);
		expect(matches()).toBe(false);
		db.prepare(`UPDATE memory_items SET ${column} = ? WHERE id = ?`).run(
			column === "title" ? "Storage capture" : null,
			capture.id,
		);
		expect(matches()).toBe(true);
	}
	db.transaction(() => recordForeignMemoryRevision(db, capture.entityId, "import"))();
	const before = factRows("memory_foreign_revisions");
	db.transaction(() => recordForeignMemoryRevision(db, capture.entityId, "bootstrap"))();
	expect(factRows("memory_foreign_revisions")).toEqual(before);
	expect(matches()).toBe(false);
	expect(hasRecordedLocalCreation(db, capture.entityId)).toBe(true);
	expect(hasMatchingLocalCreation(db, capture.entityId, ["impostor"])).toBe(false);
});
it("never backfills an unbound old key or creates schema and keys through read helpers", () => {
	// Arrange
	const db = fixture.store.db;
	const old = "unbound-old-key";
	const oldId = Number(
		db
			.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, import_key)
		VALUES (?, 'discovery', 'Old unbound memory', 'Body', 0.8, '', 1, ?, ?, '{}', ?)`)
			.run(fixture.sessionId, now, now, old).lastInsertRowid,
	);
	const before = schema();
	const loadKey = vi.fn(() => undefined);
	const exec = vi.spyOn(db, "exec");
	// Act / Assert: unbound historical rows cannot mint proof or load a key.
	expect(localCreationSourceIds(db, "local", { loadExpectedPublicKey: loadKey })).toEqual([]);
	expect(hasLocalCreationBinding(db, old, ["local"])).toBe(false);
	expect(hasRecordedLocalCreation(db, old)).toBe(false);
	expect(hasMatchingLocalCreation(db, old, ["local"])).toBe(false);
	expect(matchingLocalCreationClause(db)).toBeNull();
	db.transaction(() => {
		recordLocalCreationSnapshot(db, oldId);
		recordForeignMemoryRevision(db, old, "import");
	})();
	expect(schema()).toEqual(before);
	expect(exec).not.toHaveBeenCalled();
	expect(loadKey).not.toHaveBeenCalled();
	expect(existsSync(fixture.keysDir)).toBe(false);
	const capture = db.transaction(createCapture)();
	exec.mockClear();
	const after = schema();
	expect(localCreationSourceIds(db, "local")).toEqual([capture.sourceDeviceId]);
	expect(hasLocalCreationBinding(db, capture.entityId, [capture.sourceDeviceId])).toBe(true);
	expect(hasMatchingLocalCreation(db, capture.entityId, [capture.sourceDeviceId])).toBe(true);
	expect(hasMatchingLocalCreation(db, old, [capture.sourceDeviceId])).toBe(false);
	expect(hasMatchingLocalCreation(db, capture.entityId, [])).toBe(false);
	expect(getVerifiedMemorySource(db, old)).toBeNull();
	expect(schema()).toEqual(after);
	expect(exec).not.toHaveBeenCalled();
	expect(existsSync(fixture.keysDir)).toBe(false);
});
