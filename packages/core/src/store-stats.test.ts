import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { MemoryStore } from "./store.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

function grantScopeToLocalDevice(store: MemoryStore, scopeId: string): void {
	const now = new Date().toISOString();
	store.db
		.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at
			 ) VALUES (?, ?, 'team', 'coordinator', 'coord-test', 'group-test', 0, 'active', ?, ?)`,
		)
		.run(scopeId, scopeId, now, now);
	store.db
		.prepare(
			`INSERT INTO scope_memberships(
			 scope_id, device_id, role, status, membership_epoch,
			 coordinator_id, group_id, updated_at
			 ) VALUES (?, ?, 'member', 'active', 0, 'coord-test', 'group-test', ?)`,
		)
		.run(scopeId, store.deviceId, now);
}

function insertScopedMemory(store: MemoryStore, scopeId: string): void {
	const sessionId = insertTestSession(store.db);
	const now = new Date().toISOString();
	store.db
		.prepare(
			`INSERT INTO memory_items(
			 session_id, kind, title, body_text, confidence, tags_text, active,
			 created_at, updated_at, metadata_json, rev, scope_id
			 ) VALUES (?, 'discovery', 'Scoped', 'Body', 0.5, '', 1, ?, ?, '{}', 1, ?)`,
		)
		.run(sessionId, now, now, scopeId);
}

describe("MemoryStore stats aggregation", () => {
	let tmpDir: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-store-stats-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("combines visible memory, active session, and tag counts in one statement", () => {
		const firstSessionId = insertTestSession(store.db);
		const taggedId = store.remember(firstSessionId, "discovery", "Tagged", "Body");
		store.db.prepare("UPDATE memory_items SET tags_text = 'one,two' WHERE id = ?").run(taggedId);
		store.remember(firstSessionId, "discovery", "Same session", "Body");
		const secondSessionId = insertTestSession(store.db);
		const inactiveId = store.remember(secondSessionId, "discovery", "Inactive tagged", "Body");
		store.db
			.prepare("UPDATE memory_items SET active = 0, tags_text = 'ignored' WHERE id = ?")
			.run(inactiveId);
		let aggregateStatements = 0;
		const originalPrepare = store.db.prepare.bind(store.db);
		(store.db as unknown as { prepare: typeof store.db.prepare }).prepare = ((
			statement: string,
		) => {
			if (statement.includes("AS total_memories")) aggregateStatements += 1;
			return originalPrepare(statement);
		}) as typeof store.db.prepare;

		const result = store.stats();
		expect(result.database).toMatchObject({
			memory_items: 3,
			active_memory_items: 2,
			sessions: 1,
			tags_filled: 1,
			tags_coverage: 0.5,
		});
		expect(aggregateStatements).toBe(1);
	});

	it("refreshes scope authorization before aggregating memory stats", () => {
		grantScopeToLocalDevice(store, "revoked-team");
		insertScopedMemory(store, "revoked-team");
		expect(store.stats().database.memory_items).toBe(1);

		store.db
			.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = ?")
			.run("revoked-team");

		expect(store.stats().database).toMatchObject({
			memory_items: 0,
			active_memory_items: 0,
			sessions: 0,
			tags_filled: 0,
		});
	});
});
