import { expect, it, vi } from "vitest";
import { useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";

const { fixture, remember, row, enroll } = useLocalCaptureFixture();

/** Legacy memories this store wrote before it had an identity, with no creation record. */
function insertLegacyRows(count: number): number[] {
	const insert = fixture.store.db.prepare(
		`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
		 visibility, origin_device_id, actor_id, active, metadata_json, import_key, rev)
		 VALUES (?, 'discovery', 'Legacy', 'Body', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
		 'shared', 'local', 'local:local', 1, '{}', ?, 1)`,
	);
	return Array.from({ length: count }, (_, index) =>
		Number(insert.run(fixture.sessionId, `legacy:${index}`).lastInsertRowid),
	);
}

function actorsOf(ids: number[]): Set<unknown> {
	return new Set(ids.map((id) => row(id).actor_id));
}

it("moves memories to the canonical actor a batch at a time, and finishes an interrupted run later", () => {
	// Arrange: one capture this device created, and 1,200 legacy rows. The 700th fails once.
	const captured = remember("Genuine capture");
	const legacy = insertLegacyRows(1_200);
	const failing = legacy[699];
	fixture.store.db.exec(`CREATE TRIGGER interrupt_canonicalization BEFORE UPDATE OF actor_id ON memory_items
		WHEN NEW.id = ${failing} BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);

	// Act: adoption commits the identity, then the second batch fails.
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	enroll();
	expect(warn).toHaveBeenCalledWith(expect.stringContaining("interrupted"));

	// Assert: the first batch committed on its own; the failed batch left its rows as they were.
	const canonical = fixture.store.actorId;
	expect(canonical).not.toBe("local:local");
	expect(actorsOf([captured, ...legacy.slice(0, 499)])).toEqual(new Set([canonical]));
	expect(actorsOf(legacy.slice(499))).toEqual(new Set(["local:local"]));

	// Act: the next identity check finishes the move.
	fixture.store.db.exec("DROP TRIGGER interrupt_canonicalization");
	fixture.store.adoptEnsuredDeviceIdentity("capture-device");

	// Assert: every row moved; only the capture this device created took a revision.
	expect(actorsOf([captured, ...legacy])).toEqual(new Set([canonical]));
	expect(row(captured).rev).toBe(2);
	expect(new Set(legacy.map((id) => row(id).rev))).toEqual(new Set([1]));
});
