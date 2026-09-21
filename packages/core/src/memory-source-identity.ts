import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";

const PREFIX = "memory-source-v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface VerifiedMemorySource {
	entityId: string;
	sourceDeviceId: string;
	evidence: "local_creation" | "authenticated_namespace";
}

/** Additive prerequisite only; no existing capture or wire protocol is switched on here. */
export function ensureMemorySourceIdentitySchema(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS memory_source_bindings (
		entity_id TEXT PRIMARY KEY,
		source_device_id TEXT NOT NULL,
		evidence TEXT NOT NULL CHECK(evidence IN ('local_creation', 'authenticated_namespace')),
		created_at TEXT NOT NULL
	);
	CREATE TRIGGER IF NOT EXISTS memory_source_bindings_no_update
	BEFORE UPDATE ON memory_source_bindings
	BEGIN SELECT RAISE(ABORT, 'memory_source_binding_immutable'); END;
	CREATE TRIGGER IF NOT EXISTS memory_source_bindings_no_delete
	BEFORE DELETE ON memory_source_bindings
	BEGIN SELECT RAISE(ABORT, 'memory_source_binding_immutable'); END;
	CREATE TRIGGER IF NOT EXISTS memory_source_bindings_no_replace
	BEFORE INSERT ON memory_source_bindings
	WHEN EXISTS (SELECT 1 FROM memory_source_bindings WHERE entity_id = NEW.entity_id)
	BEGIN SELECT RAISE(ABORT, 'memory_source_binding_immutable'); END;`);
}

function validDeviceId(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value.trim() === value &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	);
}

/** Parsing is not authentication. It identifies the namespace a verified sender must own. */
export function memorySourceNamespace(entityId: string): string | null {
	if (typeof entityId !== "string" || entityId.length > 1500 || !entityId.startsWith(PREFIX))
		return null;
	const [encoded, nonce, extra] = entityId.slice(PREFIX.length).split(":");
	if (!encoded || !nonce || extra !== undefined || !UUID.test(nonce)) return null;
	const source = Buffer.from(encoded, "base64url").toString("utf8");
	if (!validDeviceId(source) || Buffer.from(source).toString("base64url") !== encoded) return null;
	return source;
}

export function getVerifiedMemorySource(
	db: Database,
	entityId: string,
): VerifiedMemorySource | null {
	const row = db
		.prepare("SELECT source_device_id, evidence FROM memory_source_bindings WHERE entity_id = ?")
		.get(entityId) as
		| { source_device_id: string; evidence: VerifiedMemorySource["evidence"] }
		| undefined;
	if (!row) return null;
	return { entityId, sourceDeviceId: row.source_device_id, evidence: row.evidence };
}

function persistBinding(db: Database, binding: VerifiedMemorySource): VerifiedMemorySource {
	if (!db.inTransaction) throw new Error("memory_source_transaction_required");
	const existing = getVerifiedMemorySource(db, binding.entityId);
	if (existing) {
		if (existing.sourceDeviceId !== binding.sourceDeviceId)
			throw new Error("memory_source_binding_conflict");
		return existing;
	}
	db.prepare(`INSERT INTO memory_source_bindings(entity_id, source_device_id, evidence, created_at)
		VALUES (?, ?, ?, ?)`).run(
		binding.entityId,
		binding.sourceDeviceId,
		binding.evidence,
		new Date().toISOString(),
	);
	return binding;
}

/** Allocate inside the transaction creating a new memory/copy; never rename a historical UUID. */
export function allocateLocalMemorySource(db: Database): VerifiedMemorySource {
	const rows = db.prepare("SELECT device_id FROM sync_device").all() as Array<{
		device_id: string;
	}>;
	const source = rows[0]?.device_id;
	if (rows.length !== 1 || !source || !validDeviceId(source))
		throw new Error("memory_source_local_device_required");
	const entityId = `${PREFIX}${Buffer.from(source).toString("base64url")}:${randomUUID()}`;
	return persistBinding(db, { entityId, sourceDeviceId: source, evidence: "local_creation" });
}

/**
 * Internal auth boundary: verifiedPeerDeviceId MUST come from successful transport
 * authentication, never op.device_id, payload origin, a form field, or a signature claim.
 * The namespace authenticates NEW identities, including absent rows. It cannot prove
 * ownership of a historical unqualified UUID. Forwarded claims are not accepted.
 */
export function verifyAuthenticatedMemorySource(
	db: Database,
	input: { entityId: string; verifiedPeerDeviceId: string },
): VerifiedMemorySource {
	const namespace = memorySourceNamespace(input.entityId);
	if (!namespace) throw new Error("memory_source_verification_required");
	if (namespace !== input.verifiedPeerDeviceId) throw new Error("memory_source_sender_mismatch");
	return persistBinding(db, {
		entityId: input.entityId,
		sourceDeviceId: namespace,
		evidence: "authenticated_namespace",
	});
}

/** Retirement consumers consult immutable proof, never mutable memory origin metadata. */
export function assertVerifiedMemorySource(
	db: Database,
	entityId: string,
	sourceDeviceId: string,
): void {
	const binding = getVerifiedMemorySource(db, entityId);
	if (!binding) throw new Error("memory_source_verification_required");
	if (binding.sourceDeviceId !== sourceDeviceId) throw new Error("memory_source_sender_mismatch");
}
