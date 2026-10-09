import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	hasMatchingLocalCreation,
	recordLocalCreationSnapshot,
} from "./memory-creation-provenance.js";
import { localCreationSourceIds } from "./memory-local-capture.js";
import {
	allocateLocalCaptureMemorySource,
	ensureMemorySourceIdentitySchema,
} from "./memory-source-identity.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

let db: Database.Database;
beforeEach(() => {
	db = new Database(":memory:");
	// Legacy storage has content and bindings, but has never enrolled a sync identity.
	db.exec(`CREATE TABLE memory_items (
		id INTEGER PRIMARY KEY, import_key TEXT, scope_id TEXT,
		kind TEXT, title TEXT, subtitle TEXT, body_text TEXT, confidence REAL,
		tags_text TEXT, visibility TEXT, workspace_kind TEXT, origin_source TEXT,
		trust_state TEXT, narrative TEXT, facts TEXT, concepts TEXT, files_read TEXT,
		files_modified TEXT, user_prompt_id TEXT, prompt_number INTEGER, project TEXT,
		active INTEGER, deleted_at TEXT, metadata_json TEXT
	)`);
	ensureMemorySourceIdentitySchema(db);
});
afterEach(() => {
	vi.restoreAllMocks();
	db.close();
});

it("allocates an unsigned capture when the legacy sync_device table is absent", () => {
	// Arrange
	const before = db.prepare("SELECT name FROM sqlite_master WHERE name = 'sync_device'").get();
	// Act
	const binding = db.transaction(() => allocateLocalCaptureMemorySource(db, "local"))();
	if (!binding) throw new Error("Missing unsigned binding");
	db.prepare(
		"INSERT INTO memory_items(id, import_key, title, metadata_json) VALUES (1, ?, 'Original', '{}')",
	).run(binding.entityId);
	db.transaction(() => recordLocalCreationSnapshot(db, 1))();
	const sources = localCreationSourceIds(db, "local");
	const matches = hasMatchingLocalCreation(db, binding.entityId, sources);
	// Assert: missing enrollment is not repaired or given an authenticated namespace.
	expect(before).toBeUndefined();
	expect(binding).toMatchObject({ evidence: "local_creation" });
	expect(binding?.entityId).toMatch(/^memory-local-capture-v1:/);
	expect(binding?.sourceDeviceId).toMatch(/^local-capture-v1:/);
	expect(sources).toEqual([binding.sourceDeviceId]);
	expect(matches).toBe(true);
	expect(
		db.prepare("SELECT name FROM sqlite_master WHERE name = 'sync_device'").get(),
	).toBeUndefined();
});

it("records NULL key evidence and reads unsigned legacy proof without DDL", () => {
	// Arrange: isolate snapshot recording from allocation so both missing-table failures reproduce.
	const entityId = "memory-local-capture-v1:legacy";
	db.prepare(
		`INSERT INTO memory_source_bindings VALUES (?, 'local-capture-v1:legacy', 'local_creation', '2026-09-21')`,
	).run(entityId);
	db.prepare(
		"INSERT INTO memory_items(id, import_key, title, metadata_json) VALUES (1, ?, 'Original', '{}')",
	).run(entityId);
	// Act
	db.transaction(() => recordLocalCreationSnapshot(db, 1))();
	const snapshot = db
		.prepare("SELECT source_public_key, source_fingerprint FROM memory_local_creation_snapshots")
		.get();
	const before = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
	const exec = vi.spyOn(db, "exec");
	const matches = hasMatchingLocalCreation(db, entityId, ["local-capture-v1:legacy"]);
	const wrongSourceMatches = hasMatchingLocalCreation(db, entityId, ["impostor"]);
	// Assert
	expect(snapshot).toEqual({ source_public_key: null, source_fingerprint: null });
	expect(matches).toBe(true);
	expect(wrongSourceMatches).toBe(false);
	expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
	expect(exec).not.toHaveBeenCalled();
});

it("retains enrolled snapshot evidence and rejects a wrong runtime key without repair", () => {
	// Arrange: enrolled allocation and read proof require matching runtime key evidence.
	const fingerprint = fingerprintPublicKey(CANONICAL_PUBLIC_KEY);
	db.exec("CREATE TABLE sync_device(device_id TEXT, public_key TEXT, fingerprint TEXT)");
	db.prepare("INSERT INTO sync_device VALUES ('enrolled', ?, ?)").run(
		CANONICAL_PUBLIC_KEY,
		fingerprint,
	);
	const binding = db.transaction(() =>
		allocateLocalCaptureMemorySource(db, "enrolled", { expectedPublicKey: CANONICAL_PUBLIC_KEY }),
	)();
	if (!binding) throw new Error("Missing enrolled binding");
	db.prepare(
		"INSERT INTO memory_items(id, import_key, title, metadata_json) VALUES (1, ?, 'Original', '{}')",
	).run(binding.entityId);
	const before = db.prepare("SELECT * FROM sync_device").all();
	// Act
	db.transaction(() => recordLocalCreationSnapshot(db, 1))();
	const wrongRuntime = db.transaction(() => allocateLocalCaptureMemorySource(db, "local"))();
	const sources = localCreationSourceIds(db, "enrolled", {
		expectedPublicKey: "ssh-ed25519 wrong-key",
	});
	const matches = hasMatchingLocalCreation(db, binding.entityId, ["enrolled"]);
	const afterReads = db.prepare("SELECT * FROM sync_device").all();
	db.prepare("UPDATE sync_device SET public_key = 'ssh-ed25519 replaced-key'").run();
	const replacedKeyMatches = hasMatchingLocalCreation(db, binding.entityId, ["enrolled"]);
	// Assert
	expect(binding.entityId).toMatch(/^memory-source-v1:/);
	expect(
		db
			.prepare("SELECT source_public_key, source_fingerprint FROM memory_local_creation_snapshots")
			.get(),
	).toEqual({
		source_public_key: CANONICAL_PUBLIC_KEY,
		source_fingerprint: fingerprint,
	});
	expect(wrongRuntime).toBeNull();
	expect(sources).toEqual([]);
	expect(matches).toBe(true);
	expect(replacedKeyMatches).toBe(false);
	expect(afterReads).toEqual(before);
	expect(db.prepare("SELECT public_key FROM sync_device").get()).toEqual({
		public_key: "ssh-ed25519 replaced-key",
	});
	expect(
		db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_local_capture'").get(),
	).toBeUndefined();
});

it("does not treat signed snapshots as unsigned when enrollment disappears", () => {
	// Arrange
	db.exec("CREATE TABLE sync_device(device_id TEXT, public_key TEXT, fingerprint TEXT)");
	db.prepare("INSERT INTO sync_device VALUES ('enrolled', ?, ?)").run(
		CANONICAL_PUBLIC_KEY,
		fingerprintPublicKey(CANONICAL_PUBLIC_KEY),
	);
	const binding = db.transaction(() =>
		allocateLocalCaptureMemorySource(db, "enrolled", { expectedPublicKey: CANONICAL_PUBLIC_KEY }),
	)();
	if (!binding) throw new Error("Missing enrolled binding");
	db.prepare("INSERT INTO memory_items(id, import_key, metadata_json) VALUES (1, ?, '{}')").run(
		binding.entityId,
	);
	db.transaction(() => recordLocalCreationSnapshot(db, 1))();
	db.exec("DROP TABLE sync_device");
	const before = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
	const exec = vi.spyOn(db, "exec");
	// Act
	const matches = hasMatchingLocalCreation(db, binding.entityId, ["enrolled"]);
	// Assert: loss of enrollment cannot downgrade persisted key evidence.
	expect(matches).toBe(false);
	expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
	expect(exec).not.toHaveBeenCalled();
});
