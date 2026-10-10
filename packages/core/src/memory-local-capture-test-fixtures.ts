import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { enrollFixtureSigningKey } from "./managed-scope-test-fixtures.js";
import { getVerifiedMemorySource } from "./memory-source-identity.js";
import { MemoryStore } from "./store.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import { recordReplicationOp } from "./sync-replication.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import type { ReplicationOp, SyncResetRequired } from "./types.js";

export const now = "2026-09-21T12:00:00.000Z";
export const scopeId = "capture-revoked";
export const reset: SyncResetRequired = {
	reset_required: true,
	reason: "generation_mismatch",
	generation: 2,
	snapshot_id: "capture-snapshot",
	baseline_cursor: null,
	retained_floor_cursor: null,
	scope_id: scopeId,
};

// Keep the store mutable: reopen tests replace it and teardown closes the replacement.
const fixture = {} as {
	dir: string;
	keysDir: string;
	store: MemoryStore;
	sessionId: number;
};

export function useLocalCaptureFixture() {
	beforeEach(() => {
		fixture.dir = mkdtempSync(join(tmpdir(), "codemem-local-capture-"));
		fixture.keysDir = join(fixture.dir, "keys");
		vi.stubEnv("CODEMEM_CONFIG", join(fixture.dir, "config.json"));
		vi.stubEnv("CODEMEM_DEVICE_ID", "");
		vi.stubEnv("CODEMEM_ACTOR_ID", "");
		vi.stubEnv("CODEMEM_KEYS_DIR", fixture.keysDir);
		vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
		vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
		vi.spyOn(MemoryStore.prototype, "enqueueVectorWrite").mockImplementation(() => {});
		const path = join(fixture.dir, "memory.sqlite");
		const db = new Database(path);
		initTestSchema(db);
		db.close();
		fixture.store = new MemoryStore(path, { keysDir: fixture.keysDir });
		fixture.sessionId = insertTestSession(fixture.store.db);
		fixture.store.db
			.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type,
				coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
				VALUES (?, 'Capture scope', 'team', 'coordinator', 'capture-coordinator', 'capture-group', 1, 'active', ?, ?)`)
			.run(scopeId, now, now);
	});
	afterEach(() => {
		fixture.store.close();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(fixture.dir, { recursive: true, force: true });
	});
	return {
		fixture,
		remember,
		rememberScoped,
		row,
		restrict,
		binding,
		captureOp,
		enroll,
		persistUnadoptedIdentity,
		factRows,
		ledger,
	};
}
function remember(title = "Genuine capture", metadata?: Record<string, unknown>): number {
	return fixture.store.remember(
		fixture.sessionId,
		"discovery",
		title,
		`${title} body`,
		0.8,
		[],
		metadata,
	);
}
function rememberScoped(title = "Genuine capture", metadata?: Record<string, unknown>): number {
	const mapping = fixture.store.db
		.prepare(`INSERT INTO project_scope_mappings(workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at)
			VALUES ('/tmp/test', '/tmp/test', ?, 100, 'user', ?, ?)`)
		.run(scopeId, now, now);
	try {
		const id = remember(title, metadata);
		expect(row(id).scope_id).toBe(scopeId);
		return id;
	} finally {
		fixture.store.db
			.prepare("DELETE FROM project_scope_mappings WHERE id = ?")
			.run(mapping.lastInsertRowid);
	}
}
function row(id: number): Record<string, unknown> {
	return fixture.store.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as Record<
		string,
		unknown
	>;
}
function restrict(id: number): void {
	fixture.store.db.prepare("UPDATE memory_items SET scope_id = ? WHERE id = ?").run(scopeId, id);
}
function binding(id: number) {
	return getVerifiedMemorySource(fixture.store.db, String(row(id).import_key));
}
function captureOp(id: number): ReplicationOp {
	recordReplicationOp(fixture.store.db, {
		memoryId: id,
		deviceId: fixture.store.deviceId,
		opType: "upsert",
		createdAt: now,
	});
	return fixture.store.db
		.prepare("SELECT * FROM replication_ops WHERE entity_id = ? ORDER BY clock_rev DESC LIMIT 1")
		.get(row(id).import_key) as ReplicationOp;
}
function enroll(deviceId = "capture-device"): string {
	const key = enrollFixtureSigningKey(fixture.store.db, fixture.keysDir, deviceId);
	fixture.store.adoptEnsuredDeviceIdentity(deviceId);
	return key;
}
function persistUnadoptedIdentity(): void {
	// Stage only the ensured device tuple; the real writer remains the proof issuer.
	const identityDb = new Database(":memory:");
	try {
		initTestSchema(identityDb);
		ensureDeviceIdentity(identityDb, { keysDir: fixture.keysDir, deviceId: "capture-device" });
		const tuple = identityDb.prepare("SELECT * FROM sync_device").get() as {
			device_id: string;
			public_key: string;
			fingerprint: string;
			created_at: string;
		};
		fixture.store.db
			.prepare(
				"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
			)
			.run(tuple.device_id, tuple.public_key, tuple.fingerprint, tuple.created_at);
	} finally {
		identityDb.close();
	}
	expect(ledger().adoption).toEqual([]);
}
function factRows(table: string) {
	if (!fixture.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table)) return [];
	return fixture.store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
}
function ledger() {
	return {
		birth: factRows("memory_local_capture"),
		adoption: factRows("memory_local_capture_adoption"),
		bindings: factRows("memory_source_bindings"),
	};
}
