import { expect, it, vi } from "vitest";
import { useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";
import { refreshTestScopeRows } from "./scope-membership-cache-test-fixtures.js";
import {
	getSyncResetState,
	loadMemorySnapshotPageForPeer,
	recordScopeReassignment,
} from "./sync-replication.js";
import { insertTestPeer } from "./test-utils.js";

const SCOPE = "capture-revoked";

const { fixture, remember, row, enroll } = useLocalCaptureFixture();

/** Legacy memories this store wrote before it had an identity, with no creation record. */
function insertLegacyRows(count: number): number[] {
	const insert = fixture.store.db.prepare(
		`INSERT INTO memory_items(session_id, kind, title, body_text, created_at, updated_at,
		 visibility, origin_device_id, actor_id, active, metadata_json, import_key, rev, scope_id)
		 VALUES (?, 'discovery', 'Legacy', 'Body', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
		 'shared', 'local', 'local:local', 1, '{}', ?, 1, ?)`,
	);
	return Array.from({ length: count }, (_, index) =>
		Number(insert.run(fixture.sessionId, `legacy:${index}`, SCOPE).lastInsertRowid),
	);
}

function actorsOf(ids: number[]): Set<unknown> {
	return new Set(ids.map((id) => row(id).actor_id));
}

/** The legacy keys a snapshot page of the scope serves an authorized peer now. */
async function servedToPeer(scopeId = SCOPE): Promise<Set<string>> {
	const db = fixture.store.db;
	insertTestPeer(db, "peer-device");
	db.prepare(
		`INSERT OR IGNORE INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id,
		 group_id, membership_epoch, status, created_at, updated_at)
		 VALUES (?, ?, 'team', 'coordinator', 'capture-coordinator', 'capture-group', 1, 'active', ?, ?)`,
	).run(scopeId, scopeId, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
	for (const deviceId of [fixture.store.deviceId, "peer-device"])
		db.prepare(
			`INSERT OR IGNORE INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
			 VALUES (?, ?, 'member', 'active', 1, '2026-01-01T00:00:00Z')`,
		).run(scopeId, deviceId);
	await refreshTestScopeRows(db);
	const boundary = getSyncResetState(db, scopeId);
	const page = loadMemorySnapshotPageForPeer(db, {
		peerDeviceId: "peer-device",
		scopeId,
		limit: 5000,
		generation: boundary.generation,
		snapshotId: boundary.snapshot_id,
		baselineCursor: boundary.baseline_cursor,
	});
	return new Set(
		page.items.map((item) => item.entity_id).filter((key) => key.startsWith("legacy:")),
	);
}

it("moves memories to the canonical actor a batch at a time, and finishes an interrupted run later", async () => {
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

	// Assert: a sync pass between batches serves only the rows that moved.
	const served = await servedToPeer();
	expect(served.size).toBe(499);
	expect(served.has("legacy:0")).toBe(true);
	expect(served.has("legacy:499")).toBe(false);

	// Act: the next identity check finishes the move.
	fixture.store.db.exec("DROP TRIGGER interrupt_canonicalization");
	fixture.store.adoptEnsuredDeviceIdentity("capture-device");

	// Assert: every row moved; only the capture this device created took a revision.
	expect(actorsOf([captured, ...legacy])).toEqual(new Set([canonical]));
	expect(row(captured).rev).toBe(2);
	expect(new Set(legacy.map((id) => row(id).rev))).toEqual(new Set([1]));
});

it("withholds a memory pending adoption after sharing names this device as its origin", async () => {
	// Arrange: adoption stops after its first batch.
	remember("Genuine capture");
	const legacy = insertLegacyRows(1_200);
	fixture.store.db.exec(`CREATE TRIGGER interrupt_canonicalization BEFORE UPDATE OF actor_id ON memory_items
		WHEN NEW.id = ${legacy[699]} BEGIN SELECT RAISE(ABORT, 'interrupted'); END`);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	enroll();
	const pending = legacy[600] ?? 0;
	expect(row(pending).actor_id).toBe("local:local");

	// Act: a share moves the pending memory and claims this device as its origin.
	recordScopeReassignment(fixture.store.db, {
		operationId: "share-pending",
		memoryId: pending,
		oldScopeId: SCOPE,
		newScopeId: "shared-scope",
		deviceId: fixture.store.deviceId,
		createdAt: "2026-01-02T00:00:00Z",
		claimLocalOrigin: true,
	});

	// Assert: the fallback actor alone holds it back.
	expect(row(pending)).toMatchObject({
		actor_id: "local:local",
		origin_device_id: fixture.store.deviceId,
	});
	expect(await servedToPeer("shared-scope")).toEqual(new Set());

	// Act: the next identity check finishes adoption, origin and all.
	fixture.store.db.exec("DROP TRIGGER interrupt_canonicalization");
	fixture.store.adoptEnsuredDeviceIdentity("capture-device");

	// Assert
	expect(row(pending).actor_id).toBe(fixture.store.actorId);
	expect(await servedToPeer("shared-scope")).toEqual(new Set(["legacy:600"]));
});
