import type { Database } from "./db.js";
import {
	assertVerifiedMemorySource,
	verifyAuthenticatedMemorySource,
} from "./memory-source-identity.js";

/** Internal prerequisite; no wire capability or production retirement caller is enabled. */
export function ensureMemoryScopeRetirementSchema(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS memory_scope_retirements (
		entity_id TEXT NOT NULL,
		source_device_id TEXT NOT NULL,
		retired_scope_id TEXT NOT NULL,
		retired_at TEXT NOT NULL,
		PRIMARY KEY (entity_id, retired_scope_id)
	);
	CREATE TRIGGER IF NOT EXISTS memory_scope_retirements_no_update
	BEFORE UPDATE ON memory_scope_retirements
	BEGIN SELECT RAISE(ABORT, 'memory_retirement_immutable'); END;
	CREATE TRIGGER IF NOT EXISTS memory_scope_retirements_no_delete
	BEFORE DELETE ON memory_scope_retirements
	BEGIN SELECT RAISE(ABORT, 'memory_retirement_immutable'); END;
	CREATE TRIGGER IF NOT EXISTS memory_scope_retirements_no_replace
	BEFORE INSERT ON memory_scope_retirements
	WHEN EXISTS (SELECT 1 FROM memory_scope_retirements WHERE entity_id = NEW.entity_id AND retired_scope_id = NEW.retired_scope_id)
	BEGIN SELECT RAISE(ABORT, 'memory_retirement_immutable'); END;`);
}

/** Payload-free control: no destination, recipients, memory content, or clock. */
export interface MemoryScopeRetirement {
	entityId: string;
	sourceDeviceId: string;
	retiredScopeId: string;
}

function validateRetirement(input: MemoryScopeRetirement): void {
	for (const value of [input.entityId, input.sourceDeviceId, input.retiredScopeId]) {
		if (
			typeof value !== "string" ||
			!value ||
			value.length > 1500 ||
			value !== value.trim() ||
			/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
		)
			throw new Error("memory_retirement_invalid");
	}
}

/** No foreign keys: row erasure, scope cleanup and log compaction must retain this fence. */
export function isMemoryScopeRetired(
	db: Database,
	entityId: string,
	scopeId: string | null,
): boolean {
	if (!scopeId) return false;
	return Boolean(
		db
			.prepare(
				"SELECT 1 FROM memory_scope_retirements WHERE entity_id = ? AND retired_scope_id = ?",
			)
			.get(entityId, scopeId),
	);
}

export function assertMemoryScopeNotRetired(db: Database, entityId: string, scopeId: string): void {
	if (isMemoryScopeRetired(db, entityId, scopeId)) throw new Error("memory_scope_retired");
}

export function hasMemoryScopeRetirement(db: Database, entityId: string): boolean {
	return Boolean(
		db.prepare("SELECT 1 FROM memory_scope_retirements WHERE entity_id = ? LIMIT 1").get(entityId),
	);
}

/**
 * Caller MUST supply a successfully authenticated transport device identity (or the
 * actual local device for a local move), never an op sender, payload origin or form field.
 * The caller transaction must also perform the move/cleanup; this primitive only fences.
 * An absent qualified identity is verifiable by its namespace owner. A legacy UUID is not.
 */
export function recordMemoryScopeRetirement(
	db: Database,
	input: MemoryScopeRetirement,
	options: { authenticatedSourceDeviceId: string; now: string },
): void {
	validateRetirement(input);
	if (options.authenticatedSourceDeviceId !== input.sourceDeviceId)
		throw new Error("memory_retirement_sender_mismatch");
	if (!db.inTransaction) throw new Error("memory_retirement_transaction_required");
	verifyAuthenticatedMemorySource(db, {
		entityId: input.entityId,
		verifiedPeerDeviceId: options.authenticatedSourceDeviceId,
	});
	assertVerifiedMemorySource(db, input.entityId, input.sourceDeviceId);
	if (isMemoryScopeRetired(db, input.entityId, input.retiredScopeId)) return;
	db.prepare(`INSERT INTO memory_scope_retirements(entity_id, source_device_id, retired_scope_id, retired_at)
		VALUES (?, ?, ?, ?)`).run(
		input.entityId,
		input.sourceDeviceId,
		input.retiredScopeId,
		options.now,
	);
}
