import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

interface CaptureBirth {
	capture_id: string;
}

interface DeviceTuple {
	device_id: string;
	public_key: string;
	fingerprint: string;
}

export interface LocalCreationContext {
	expectedPublicKey?: string;
	loadExpectedPublicKey?: () => string | undefined;
}

export interface LocalCaptureAdoptionContext extends LocalCreationContext {
	actorId?: string;
	runtimeDeviceId?: string;
}

export function assertLocalCaptureAdoptionActors(
	db: Database,
	deviceId: string,
	actorId?: string,
): void {
	if (!hasTable(db, "actors")) return;
	const conflict = db
		.prepare(`SELECT 1 FROM actors WHERE actor_id IN (?, ?, ?)
		AND (is_local <> 1 OR status <> 'active' OR merged_into_actor_id IS NOT NULL) LIMIT 1`)
		.get("local:local", `local:${deviceId}`, actorId ?? `local:${deviceId}`);
	if (conflict) throw new Error("device_adoption_actor_conflict");
}

function hasTable(db: Database, name: string): boolean {
	return (
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
		undefined
	);
}

/** Schema only: the unsigned identity is born in the first genuine creation transaction. */
export function ensureMemoryLocalCaptureSchema(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS memory_local_capture (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		capture_id TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS memory_local_capture_adoption (
		capture_id TEXT PRIMARY KEY NOT NULL REFERENCES memory_local_capture(capture_id),
		device_id TEXT NOT NULL,
		public_key TEXT NOT NULL,
		fingerprint TEXT NOT NULL,
		created_at TEXT NOT NULL
	);`);
	for (const table of ["memory_local_capture", "memory_local_capture_adoption"]) {
		db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update
			BEFORE UPDATE ON ${table}
			BEGIN SELECT RAISE(ABORT, 'memory_local_capture_immutable'); END;
			CREATE TRIGGER IF NOT EXISTS ${table}_no_delete
			BEFORE DELETE ON ${table}
			BEGIN SELECT RAISE(ABORT, 'memory_local_capture_immutable'); END;
			CREATE TRIGGER IF NOT EXISTS ${table}_no_replace
			BEFORE INSERT ON ${table}
			WHEN EXISTS (SELECT 1 FROM ${table})
			BEGIN SELECT RAISE(ABORT, 'memory_local_capture_immutable'); END;`);
	}
}

function captureBirth(db: Database): CaptureBirth | null {
	if (!hasTable(db, "memory_local_capture")) return null;
	return (
		(db.prepare("SELECT capture_id FROM memory_local_capture WHERE id = 1").get() as
			| CaptureBirth
			| undefined) ?? null
	);
}

/** An explicit ensure may finish a pending birth, but never reassociate an adopted one. */
export function hasPendingLocalCapture(db: Database): boolean {
	const birth = captureBirth(db);
	if (!birth || !hasTable(db, "memory_local_capture_adoption")) return false;
	return !db
		.prepare("SELECT 1 FROM memory_local_capture_adoption WHERE capture_id = ?")
		.get(birth.capture_id);
}

function deviceTuple(db: Database): DeviceTuple | null {
	if (!hasTable(db, "sync_device")) return null;
	const rows = db
		.prepare("SELECT device_id, public_key, fingerprint FROM sync_device LIMIT 2")
		.all() as DeviceTuple[];
	return rows.length === 1 ? (rows[0] ?? null) : null;
}

function publicKeyBytes(value: string): string | null {
	const [type, bytes] = value.trim().split(/\s+/u);
	return type === "ssh-ed25519" && bytes ? `${type} ${bytes}` : null;
}

function matchesRuntime(
	tuple: DeviceTuple,
	deviceId: string,
	publicKey: string | undefined,
): boolean {
	const stored = publicKeyBytes(tuple.public_key);
	return (
		tuple.device_id === deviceId &&
		stored !== null &&
		publicKey !== undefined &&
		publicKeyBytes(publicKey) === stored &&
		fingerprintPublicKey(tuple.public_key) === tuple.fingerprint
	);
}

/** Never called by reads, imports, bootstrap, or replication. */
export function getOrCreateLocalCaptureId(db: Database): string {
	if (!db.inTransaction) throw new Error("memory_source_transaction_required");
	const birth = captureBirth(db);
	if (birth) return birth.capture_id;
	ensureMemoryLocalCaptureSchema(db);
	const captureId = `local-capture-v1:${randomUUID()}`;
	db.prepare("INSERT INTO memory_local_capture(id, capture_id, created_at) VALUES (1, ?, ?)").run(
		captureId,
		new Date().toISOString(),
	);
	return captureId;
}

/** Retain a one-time association, without renaming any immutable source binding. */
export function adoptLocalCapture(
	db: Database,
	deviceId: string,
	context: LocalCaptureAdoptionContext,
): void {
	if (!db.inTransaction) throw new Error("memory_source_transaction_required");
	const birth = captureBirth(db);
	if (!birth) return;
	if (
		context.runtimeDeviceId &&
		context.runtimeDeviceId !== "local" &&
		context.runtimeDeviceId !== deviceId
	)
		return;
	const tuple = deviceTuple(db);
	const publicKey = context.expectedPublicKey ?? context.loadExpectedPublicKey?.();
	if (!tuple || !matchesRuntime(tuple, deviceId, publicKey)) return;
	const existing = db
		.prepare(
			"SELECT device_id, public_key, fingerprint FROM memory_local_capture_adoption WHERE capture_id = ?",
		)
		.get(birth.capture_id) as DeviceTuple | undefined;
	if (existing) {
		if (
			existing.device_id !== tuple.device_id ||
			existing.public_key !== tuple.public_key ||
			existing.fingerprint !== tuple.fingerprint
		)
			throw new Error("memory_local_capture_adoption_conflict");
		return;
	}
	assertLocalCaptureAdoptionActors(db, deviceId, context.actorId);
	db.prepare(`INSERT INTO memory_local_capture_adoption(capture_id, device_id, public_key, fingerprint, created_at)
		VALUES (?, ?, ?, ?, ?)`).run(
		birth.capture_id,
		tuple.device_id,
		tuple.public_key,
		tuple.fingerprint,
		new Date().toISOString(),
	);
}

/** Read-only: no DDL, key generation, identity repair, actor union, or origin inference. */
export function localCreationSourceIds(
	db: Database,
	deviceId: string,
	context: LocalCreationContext = {},
): string[] {
	if (
		!hasTable(db, "memory_source_bindings") ||
		!db
			.prepare("SELECT 1 FROM memory_source_bindings WHERE evidence = 'local_creation' LIMIT 1")
			.get()
	)
		return [];
	const birth = captureBirth(db);
	const tuple = deviceTuple(db);
	if (!tuple) {
		const noDevice =
			!hasTable(db, "sync_device") || !db.prepare("SELECT 1 FROM sync_device LIMIT 1").get();
		const adopted =
			hasTable(db, "memory_local_capture_adoption") &&
			db.prepare("SELECT 1 FROM memory_local_capture_adoption LIMIT 1").get();
		return noDevice && !adopted && deviceId === "local" && birth ? [birth.capture_id] : [];
	}
	if (tuple.device_id !== deviceId) return [];
	const publicKey = context.expectedPublicKey ?? context.loadExpectedPublicKey?.();
	if (!matchesRuntime(tuple, deviceId, publicKey)) return [];
	const sources = [deviceId];
	if (!birth || !hasTable(db, "memory_local_capture_adoption")) return sources;
	const adoption = db
		.prepare(
			"SELECT device_id, public_key, fingerprint FROM memory_local_capture_adoption WHERE capture_id = ?",
		)
		.get(birth.capture_id) as DeviceTuple | undefined;
	if (
		adoption &&
		adoption.device_id === tuple.device_id &&
		adoption.public_key === tuple.public_key &&
		adoption.fingerprint === tuple.fingerprint
	)
		sources.push(birth.capture_id);
	return sources;
}

export function hasLocalCreationBinding(
	db: Database,
	entityId: string,
	sourceIds: readonly string[],
): boolean {
	if (!sourceIds.length || !hasTable(db, "memory_source_bindings")) return false;
	const binding = db
		.prepare("SELECT source_device_id, evidence FROM memory_source_bindings WHERE entity_id = ?")
		.get(entityId) as { source_device_id: string; evidence: string } | undefined;
	return binding?.evidence === "local_creation" && sourceIds.includes(binding.source_device_id);
}
