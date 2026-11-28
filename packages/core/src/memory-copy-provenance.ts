/**
 * Which stored copy of a memory something came from, and whether this device
 * wrote that memory.
 *
 * A memory's import key names the memory, and copies can share it: a received
 * copy in another scope, an imported one, a legacy duplicate. Each stored copy
 * gets its own copy identity, a random id that never changes and never moves to
 * another row, and every op this device records names the copy it was built
 * from. Sync can then tell an op's own copy from a sibling that only shares its
 * key, scope and revision.
 *
 * Authorship belongs to a stored copy, by creation evidence no update can
 * change: the copy was recorded as created here in the transaction that created
 * it, and its import key has a local creation binding for this device or for the
 * capture identity this device adopted. Nothing else counts. A blank or `local`
 * origin, a row imported or received under a key this device once created, and a
 * copy from before copies had identities are all copies this device cannot show
 * it wrote.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { getVerifiedMemorySource } from "./memory-source-identity.js";
import { tableExists } from "./schema-lookups.js";

/** Creates the copy identity tables. Rows and ops gain an identity when first recorded. */
export function ensureMemoryCopyProvenanceSchema(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS memory_copy_identities (
		memory_id INTEGER PRIMARY KEY,
		copy_id TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS replication_op_copies (
		op_id TEXT PRIMARY KEY,
		copy_id TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS memory_copy_creations (
		copy_id TEXT PRIMARY KEY,
		created_at TEXT NOT NULL
	);
	CREATE TRIGGER IF NOT EXISTS memory_copy_creations_no_update
	BEFORE UPDATE ON memory_copy_creations
	BEGIN SELECT RAISE(ABORT, 'memory_copy_identity_immutable'); END;
	CREATE TRIGGER IF NOT EXISTS memory_copy_identities_no_update
	BEFORE UPDATE ON memory_copy_identities
	BEGIN SELECT RAISE(ABORT, 'memory_copy_identity_immutable'); END;
	CREATE TRIGGER IF NOT EXISTS replication_op_copies_no_update
	BEFORE UPDATE ON replication_op_copies
	BEGIN SELECT RAISE(ABORT, 'memory_copy_identity_immutable'); END;`);
	// A deleted row's identity goes with it, so a row that later reuses its id is a new copy.
	if (tableExists(db, "memory_items"))
		db.exec(`CREATE TRIGGER IF NOT EXISTS memory_copy_identities_forget
			AFTER DELETE ON memory_items
			BEGIN DELETE FROM memory_copy_identities WHERE memory_id = OLD.id; END;`);
	if (tableExists(db, "replication_ops"))
		db.exec(`CREATE TRIGGER IF NOT EXISTS replication_op_copies_forget
			AFTER DELETE ON replication_ops
			BEGIN DELETE FROM replication_op_copies WHERE op_id = OLD.op_id; END;`);
}

/** The stored copy's identity, given to it now if it has none yet. */
export function memoryCopyId(db: Database, memoryId: number): string {
	ensureMemoryCopyProvenanceSchema(db);
	const existing = db
		.prepare("SELECT copy_id FROM memory_copy_identities WHERE memory_id = ?")
		.pluck()
		.get(memoryId) as string | undefined;
	if (existing) return existing;
	const copyId = randomUUID();
	db.prepare(
		"INSERT INTO memory_copy_identities(memory_id, copy_id, created_at) VALUES (?, ?, ?)",
	).run(memoryId, copyId, new Date().toISOString());
	return copyId;
}

/** Records that the op was built from this stored copy. An op for no stored row names none. */
export function recordOpCopy(db: Database, opId: string, memoryId: number): void {
	if (!db.prepare("SELECT 1 FROM memory_items WHERE id = ?").get(memoryId)) return;
	const copyId = memoryCopyId(db, memoryId);
	db.prepare("INSERT OR IGNORE INTO replication_op_copies(op_id, copy_id) VALUES (?, ?)").run(
		opId,
		copyId,
	);
}

/** The copy an op was built from, or null for an op recorded before copies had identities. */
export function opCopyId(db: Database, opId: string): string | null {
	if (!tableExists(db, "replication_op_copies")) return null;
	return (
		(db.prepare("SELECT copy_id FROM replication_op_copies WHERE op_id = ?").pluck().get(opId) as
			| string
			| undefined) ?? null
	);
}

/**
 * The creation sources that count as this device: its device id, and the
 * capture identity it adopted. Before this store has a device identity, its own
 * unadopted capture identity.
 */
export function localAuthorSourceIds(db: Database, localDeviceId: string): string[] {
	const sources = localDeviceId ? [localDeviceId] : [];
	if (!tableExists(db, "memory_local_capture")) return sources;
	const captureId = db
		.prepare("SELECT capture_id FROM memory_local_capture WHERE id = 1")
		.pluck()
		.get() as string | undefined;
	if (!captureId) return sources;
	const adoptedBy = tableExists(db, "memory_local_capture_adoption")
		? (db
				.prepare("SELECT device_id FROM memory_local_capture_adoption WHERE capture_id = ?")
				.pluck()
				.get(captureId) as string | undefined)
		: undefined;
	if (adoptedBy ? adoptedBy === localDeviceId : !localDeviceId) sources.push(captureId);
	return sources;
}

/**
 * Records that this stored copy was created here. Only the transaction that
 * creates a memory calls this, through recordLocalCreationSnapshot.
 */
export function recordCopyCreatedHere(db: Database, memoryId: number): void {
	if (!db.inTransaction) throw new Error("memory_source_transaction_required");
	const copyId = memoryCopyId(db, memoryId);
	db.prepare("INSERT OR IGNORE INTO memory_copy_creations(copy_id, created_at) VALUES (?, ?)").run(
		copyId,
		new Date().toISOString(),
	);
}

/** Whether this device created this stored copy: see the module comment. */
export function memoryWrittenHere(db: Database, memoryId: number, localDeviceId: string): boolean {
	if (!tableExists(db, "memory_copy_creations") || !tableExists(db, "memory_source_bindings"))
		return false;
	const row = db
		.prepare(
			`SELECT memory.import_key FROM memory_items AS memory
			 JOIN memory_copy_identities AS copy ON copy.memory_id = memory.id
			 JOIN memory_copy_creations AS creation ON creation.copy_id = copy.copy_id
			 WHERE memory.id = ?`,
		)
		.get(memoryId) as { import_key: string | null } | undefined;
	if (!row?.import_key) return false;
	const binding = getVerifiedMemorySource(db, row.import_key);
	return (
		binding?.evidence === "local_creation" &&
		localAuthorSourceIds(db, localDeviceId).includes(binding.sourceDeviceId)
	);
}
