import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memoryOwnershipRoutes } from "../../viewer-server/src/routes/memory-ownership.js";
import { connect } from "./db.js";
import {
	commitMemoryOwnershipRecovery,
	previewMemoryOwnershipRecovery,
	verifyMemoryOwnership,
} from "./memory-ownership-recovery.js";
import { getVerifiedMemorySource } from "./memory-source-identity.js";
import { MemoryStore } from "./store.js";
import { getSyncResetState, loadMemorySnapshotPageForPeer } from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";

let store: MemoryStore;
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "ownership-recovery-"));
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_ACTOR_ID", "fixture-actor");
	const db = connect(join(directory, "test.sqlite"));
	initTestSchema(db);
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES ('fixture-device', 'fixture-key', 'fixture-fingerprint', '2026-01-01')",
	).run();
	vi.stubEnv("CODEMEM_DEVICE_ID", "fixture-device");
	db.close();
	store = new MemoryStore(join(directory, "test.sqlite"));
});
afterEach(() => {
	store.close();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function memory(visibility = "shared", actor = store.actorId) {
	const session = store.db
		.prepare("INSERT INTO sessions(started_at, project) VALUES ('2026-01-01', 'fixture')")
		.run();
	return Number(
		store.db
			.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, import_key, origin_device_id, actor_id, visibility, scope_id)
		VALUES (?, 'discovery', 'Fixture title', 'Fixture body', 0.5, '', 1, '2026-01-01', '2026-01-01', '{}', ?, 'unavailable-source', ?, ?, 'local-default')`)
			.run(session.lastInsertRowid, `legacy-${session.lastInsertRowid}`, actor, visibility)
			.lastInsertRowid,
	);
}
function confirmed(ids: number[]) {
	const preview = previewMemoryOwnershipRecovery(store, { version: 1, memoryIds: ids });
	return {
		...preview.request,
		reviewedDigest: preview.reviewedDigest,
		operationId: "fixture_operation_01",
		acknowledgeOriginalsRetained: true,
	};
}
function count(table: string) {
	return store.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
}

it("recovers unavailable-source peer content as new local copies while retaining originals", () => {
	const id = memory("shared", "peer-actor");
	const original = store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id);
	const input = confirmed([id]);
	expect(verifyMemoryOwnership(store, input).records[0]?.verification).toBe("unverified");
	const result = commitMemoryOwnershipRecovery(store, input);
	const copy = result.copies[0];
	expect(copy).toBeDefined();
	if (!copy) throw new Error("missing copy");
	expect(getVerifiedMemorySource(store.db, copy.recoveredIdentity)?.sourceDeviceId).toBe(
		store.deviceId,
	);
	expect(store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id)).toEqual(original);
	expect(count("replication_ops")).toBe(0);
	const boundary = getSyncResetState(store.db, "local-default");
	expect(
		loadMemorySnapshotPageForPeer(store.db, {
			generation: boundary.generation,
			snapshotId: boundary.snapshot_id,
			baselineCursor: boundary.baseline_cursor,
			peerDeviceId: "old-recipient",
			scopeId: "local-default",
		}).items,
	).toEqual([]);
	expect(count("memory_items")).toBe(2);
	expect(getVerifiedMemorySource(store.db, `legacy-1`)).toBeNull();
	expect(commitMemoryOwnershipRecovery(store, input)).toEqual({ ...result, idempotent: true });
	expect(count("memory_items")).toBe(2);
});

it("rejects private peer records and preserves local private visibility", () => {
	expect(() => confirmed([memory("private", "peer")])).toThrow(
		"ownership_private_record_not_owned",
	);
	const result = commitMemoryOwnershipRecovery(store, confirmed([memory("private")]));
	expect(
		store.db
			.prepare("SELECT visibility FROM memory_items WHERE id = ?")
			.pluck()
			.get(result.copies[0]?.recoveredMemoryId),
	).toBe("private");
});

it("never verifies legacy ownership from a forged reported source", () => {
	const id = memory();
	store.db
		.prepare("UPDATE memory_items SET origin_device_id = ? WHERE id = ?")
		.run(store.deviceId, id);
	expect(
		verifyMemoryOwnership(store, { version: 1, memoryIds: [id], sourceDeviceId: store.deviceId })
			.records[0]?.verification,
	).toBe("unverified");
	expect(count("memory_source_bindings")).toBe(0);
});

it("keeps personal constraints and historical claims separate from recovered authority", () => {
	const id = memory();
	store.db.prepare("UPDATE memory_items SET metadata_json = ? WHERE id = ?").run(
		JSON.stringify({
			visibility: "private",
			signature: "historical-claim",
			origin_device_id: "claimed-source",
		}),
		id,
	);
	const preview = previewMemoryOwnershipRecovery(store, { version: 1, memoryIds: [id] });
	expect(preview.records[0]?.recoveredVisibility).toBe("private");
	const result = commitMemoryOwnershipRecovery(store, confirmed([id]));
	const row = store.db
		.prepare("SELECT visibility, metadata_json FROM memory_items WHERE id = ?")
		.get(result.copies[0]?.recoveredMemoryId) as { visibility: string; metadata_json: string };
	expect(row.visibility).toBe("private");
	const metadata = JSON.parse(row.metadata_json);
	expect(metadata.signature).toBeUndefined();
	expect(metadata.recovery.original_metadata.signature).toBe("historical-claim");
	expect(metadata.origin_device_id).toBe(store.deviceId);
});

it("rejects stale reviewed content and identity changes", () => {
	const id = memory();
	const input = confirmed([id]);
	store.db.prepare("UPDATE memory_items SET body_text = 'changed' WHERE id = ?").run(id);
	expect(() => commitMemoryOwnershipRecovery(store, input)).toThrow("ownership_preview_stale");
	vi.stubEnv("CODEMEM_ACTOR_ID", "changed");
	expect(() => commitMemoryOwnershipRecovery(store, input)).toThrow("ownership_identity_changed");
	expect(count("memory_source_bindings")).toBe(0);
});

it("rolls back copies, identities, sessions and receipts together after a write failure", () => {
	const ids = [memory(), memory()];
	const input = confirmed(ids);
	store.db.exec(
		"CREATE TRIGGER fail_receipt BEFORE INSERT ON memory_ownership_recoveries BEGIN SELECT RAISE(ABORT, 'fixture_crash'); END;",
	);
	expect(() => commitMemoryOwnershipRecovery(store, input)).toThrow("fixture_crash");
	expect(count("memory_items")).toBe(2);
	expect(count("sessions")).toBe(2);
	expect(count("memory_source_bindings")).toBe(0);
	expect(count("memory_ownership_recoveries")).toBe(0);
	store.db.exec("DROP TRIGGER fail_receipt");
	expect(commitMemoryOwnershipRecovery(store, input).copies).toHaveLength(2);
});

it("rechecks permission on retry and rejects operation id reuse with another request", () => {
	const id = memory();
	const input = confirmed([id]);
	commitMemoryOwnershipRecovery(store, input);
	expect(() => commitMemoryOwnershipRecovery(store, confirmed([memory()]))).toThrow(
		"ownership_recovery_operation_conflict",
	);
	store.db.prepare("UPDATE memory_items SET scope_id = 'inaccessible' WHERE id = ?").run(id);
	expect(() => commitMemoryOwnershipRecovery(store, input)).toThrow(
		"ownership_records_unavailable",
	);
});

it("rejects a concurrent capture edit observed through a second database connection", () => {
	const id = memory();
	const input = confirmed([id]);
	const other = connect(join(directory, "test.sqlite"));
	try {
		other
			.prepare(
				"UPDATE memory_items SET rev = rev + 1, body_text = 'concurrent capture' WHERE id = ?",
			)
			.run(id);
	} finally {
		other.close();
	}
	expect(() => commitMemoryOwnershipRecovery(store, input)).toThrow("ownership_preview_stale");
});

it("replays a durable receipt after reopening without duplicating copies", () => {
	const input = confirmed([memory()]);
	const result = commitMemoryOwnershipRecovery(store, input);
	store.close();
	store = new MemoryStore(join(directory, "test.sqlite"));
	expect(commitMemoryOwnershipRecovery(store, input)).toEqual({ ...result, idempotent: true });
	expect(count("memory_items")).toBe(2);
});

it("executes the HTTP preview and commit contract through a mounted route factory", async () => {
	const app = memoryOwnershipRoutes(() => store);
	const send = (action: string, value: unknown) =>
		app.request(`/api/memories/ownership/${action}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(value),
		});
	const input = { version: 1, memoryIds: [memory()] };
	const checked = await send("verify", input);
	expect(checked.status).toBe(200);
	const response = await send("preview", input);
	expect(response.status).toBe(200);
	const preview = await response.json();
	expect(preview.records[0].recipientDeviceIds).toEqual([]);
	const committed = await send("commit", {
		...input,
		reviewedDigest: preview.reviewedDigest,
		operationId: "http_fixture_operation",
		acknowledgeOriginalsRetained: true,
	});
	expect(committed.status).toBe(200);
	expect((await committed.json()).copies).toHaveLength(1);
	const invalid = await send("preview", { version: 2, memoryIds: [] });
	expect(invalid.status).toBe(400);
});
