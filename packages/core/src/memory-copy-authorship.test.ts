import { expect, it } from "vitest";
import { exportMemories, importMemories } from "./export-import.js";
import { backfillTagsText } from "./maintenance/backfill-tags.js";
import { memoryCopyId, memoryWrittenHere } from "./memory-copy-provenance.js";
import { useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";

const { fixture, remember, row, enroll } = useLocalCaptureFixture();

it("treats a reimported replacement under a key this device created as foreign", () => {
	// Arrange: a memory this device created, exported, deleted and imported again.
	enroll();
	const db = fixture.store.db;
	const original = remember("Original capture");
	const importKey = String(row(original).import_key);
	expect(memoryWrittenHere(db, original, fixture.store.deviceId)).toBe(true);
	const payload = exportMemories({ dbPath: fixture.store.dbPath, allProjects: true });
	db.prepare("DELETE FROM memory_items WHERE id = ?").run(original);
	importMemories(payload, { dbPath: fixture.store.dbPath });
	const replacement = db
		.prepare("SELECT id, rev FROM memory_items WHERE import_key = ?")
		.get(importKey) as { id: number; rev: number };
	db.prepare("UPDATE memory_items SET tags_text = '' WHERE id = ?").run(replacement.id);
	// The replacement has a copy identity once any op is recorded for it.
	memoryCopyId(db, replacement.id);
	const opsBefore = db.prepare("SELECT COUNT(*) FROM replication_ops").pluck().get();

	// Act: maintenance changes the replacement.
	backfillTagsText(db, { memoryIds: [replacement.id] });

	// Assert: the change stays on this device.
	expect(memoryWrittenHere(db, replacement.id, fixture.store.deviceId)).toBe(false);
	expect(row(replacement.id)).toMatchObject({ rev: replacement.rev });
	expect(String(row(replacement.id).tags_text)).not.toBe("");
	expect(db.prepare("SELECT COUNT(*) FROM replication_ops").pluck().get()).toBe(opsBefore);
});
