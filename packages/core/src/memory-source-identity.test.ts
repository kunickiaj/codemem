import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	allocateLocalMemorySource,
	assertVerifiedMemorySource,
	getVerifiedMemorySource,
	memorySourceNamespace,
	verifyAuthenticatedMemorySource,
} from "./memory-source-identity.js";
import { applyReplicationOps, recordReplicationOp } from "./sync-replication.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp } from "./types.js";

let db: InstanceType<typeof Database>;
const now = "2026-09-21T12:00:00.000Z";
const qualified = "memory-source-v1:c291cmNl:00000000-0000-4000-8000-000000000001";
const legacy = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES ('source', 'fixture-key', 'fixture-fingerprint', ?)",
	).run(now);
});
afterEach(() => db.close());

function verify(entityId = qualified, verifiedPeerDeviceId = "source") {
	return db.transaction(() =>
		verifyAuthenticatedMemorySource(db, { entityId, verifiedPeerDeviceId }),
	)();
}

function insertMemory(entityId: string): number {
	const session = db
		.prepare("INSERT INTO sessions(started_at, project) VALUES (?, 'fixture')")
		.run(now);
	return Number(
		db
			.prepare(`INSERT INTO memory_items(session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, import_key, origin_device_id, rev, visibility, scope_id)
		VALUES (?, 'discovery', 'Fixture', 'Fixture body', 0.5, '', 1, ?, ?, '{}', ?, 'source', 100, 'shared', 'old')`)
			.run(session.lastInsertRowid, now, now, entityId).lastInsertRowid,
	);
}

function overwriteOrigin(entityId: string): void {
	const memoryId = insertMemory(entityId);
	recordReplicationOp(db, {
		memoryId,
		deviceId: "source",
		opType: "upsert",
		scopeId: "old",
		createdAt: now,
	});
	const original = db
		.prepare("SELECT * FROM replication_ops WHERE entity_id = ? LIMIT 1")
		.get(entityId) as ReplicationOp;
	const payload = JSON.parse(original.payload_json ?? "{}");
	payload.origin_device_id = "attacker";
	const forged = {
		...original,
		op_id: `forged-${entityId}`,
		device_id: "attacker",
		clock_device_id: "attacker",
		clock_rev: 101,
		payload_json: JSON.stringify(payload),
	};
	expect(applyReplicationOps(db, [forged], "receiver").applied).toBe(1);
	expect(
		db.prepare("SELECT origin_device_id FROM memory_items WHERE id = ?").pluck().get(memoryId),
	).toBe("attacker");
}

it("allocates a fresh source-qualified identity from the actual local device inside a transaction", () => {
	expect(() => allocateLocalMemorySource(db)).toThrow("memory_source_transaction_required");
	const first = db.transaction(() => allocateLocalMemorySource(db))();
	const second = db.transaction(() => allocateLocalMemorySource(db))();
	expect(first.entityId).not.toBe(second.entityId);
	expect(memorySourceNamespace(first.entityId)).toBe("source");
	expect(getVerifiedMemorySource(db, first.entityId)).toEqual(first);
	expect(first.evidence).toBe("local_creation");
	db.prepare("DELETE FROM sync_device").run();
	expect(() => db.transaction(() => allocateLocalMemorySource(db))()).toThrow(
		"memory_source_local_device_required",
	);
});

it("authenticates a new absent identity only within the verified sender's namespace", () => {
	expect(() => verify(qualified, "attacker")).toThrow("memory_source_sender_mismatch");
	expect(getVerifiedMemorySource(db, qualified)).toBeNull();
	expect(verify()).toEqual({
		entityId: qualified,
		sourceDeviceId: "source",
		evidence: "authenticated_namespace",
	});
	expect(db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(0);
	expect(verify()).toEqual(getVerifiedMemorySource(db, qualified));
});

it("does not infer historical ownership from a peer-overwritten origin or a signed sender claim", () => {
	overwriteOrigin(legacy);
	expect(() => verify(legacy, "attacker")).toThrow("memory_source_verification_required");
	expect(() => verify(legacy, "source")).toThrow("memory_source_verification_required");
	expect(() => assertVerifiedMemorySource(db, legacy, "attacker")).toThrow(
		"memory_source_verification_required",
	);
});

it("preserves verified authority when legacy replication overwrites a memory origin", () => {
	verify();
	overwriteOrigin(qualified);
	expect(() => assertVerifiedMemorySource(db, qualified, "attacker")).toThrow(
		"memory_source_sender_mismatch",
	);
	expect(() => assertVerifiedMemorySource(db, qualified, "source")).not.toThrow();
	expect(() => verify(qualified, "attacker")).toThrow("memory_source_sender_mismatch");
});

it("retains immutable proof through memory deletion, operation compaction and restart", () => {
	verify();
	overwriteOrigin(qualified);
	db.prepare("DELETE FROM memory_items").run();
	db.prepare("DELETE FROM replication_ops").run();
	const persisted = db.serialize();
	db.close();
	db = new Database(persisted);
	expect(verify().sourceDeviceId).toBe("source");
	expect(() =>
		db.prepare("UPDATE memory_source_bindings SET source_device_id = 'attacker'").run(),
	).toThrow("memory_source_binding_immutable");
	expect(() => db.prepare("DELETE FROM memory_source_bindings").run()).toThrow(
		"memory_source_binding_immutable",
	);
	expect(() =>
		db
			.prepare(`INSERT OR REPLACE INTO memory_source_bindings(entity_id, source_device_id, evidence, created_at)
		VALUES (?, 'attacker', 'authenticated_namespace', ?)`)
			.run(qualified, now),
	).toThrow("memory_source_binding_immutable");
});

it("rolls back binding writes with a failed creation and preserves first-write evidence on retries", () => {
	expect(() =>
		db.transaction(() => {
			verifyAuthenticatedMemorySource(db, { entityId: qualified, verifiedPeerDeviceId: "source" });
			throw new Error("creation_failed");
		})(),
	).toThrow("creation_failed");
	expect(getVerifiedMemorySource(db, qualified)).toBeNull();
	const local = db.transaction(() => allocateLocalMemorySource(db))();
	expect(verify(local.entityId)).toEqual(local);
});

it.each([
	legacy,
	qualified.replace("c291cmNl", "c291cmNl="),
	qualified.replace("c291cmNl", "c291cmNl\n"),
	qualified.replace("4000", "1000"),
	qualified.replace("8000", "0000"),
	`${qualified}:extra`,
	` ${qualified}`,
	qualified.replace("c291cmNl", "_w"),
])("rejects noncanonical or legacy namespace: %s", (entityId) => {
	expect(memorySourceNamespace(entityId)).toBeNull();
	expect(() => verify(entityId)).toThrow("memory_source_verification_required");
});
