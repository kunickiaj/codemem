import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "../../core/src/db.js";
import { initTestSchema } from "../../core/src/test-utils.js";
import {
	forgetMemoryForMcp,
	getManyForMcp,
	getMemoryForMcp,
	rememberMemoryForMcp,
} from "./memory-access.js";

describe("MCP memory access scope guards", () => {
	const originalDeviceId = process.env.CODEMEM_DEVICE_ID;
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;
	let sessionId: number;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-mcp-scope-"));
		dbPath = join(tmpDir, "mem.sqlite");
		process.env.CODEMEM_DEVICE_ID = "mcp-scope-device";
		const db = connect(dbPath);
		initTestSchema(db);
		sessionId = insertSession(db, { cwd: join(tmpDir, "greenroom"), project: "greenroom" });
		grantScopeToDevice(db, "scope-a", "mcp-scope-device");
		insertCoordinatorScope(db, "scope-b");
		db.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store?.close();
		rmSync(tmpDir, { recursive: true, force: true });
		if (originalDeviceId === undefined) {
			delete process.env.CODEMEM_DEVICE_ID;
		} else {
			process.env.CODEMEM_DEVICE_ID = originalDeviceId;
		}
	});

	it("hides unauthorized scoped IDs and intersects explicit scope filters", () => {
		const authorizedId = insertScopedMemory(store, {
			sessionId,
			scopeId: "scope-a",
			title: "Authorized MCP note",
		});
		const hiddenId = insertScopedMemory(store, {
			sessionId,
			scopeId: "scope-b",
			title: "Hidden MCP note",
		});

		expect(getMemoryForMcp(store, authorizedId)?.title).toBe("Authorized MCP note");
		expect(getMemoryForMcp(store, hiddenId)).toBe(null);
		expect(getManyForMcp(store, [hiddenId, authorizedId]).map((item) => item.id)).toEqual([
			authorizedId,
		]);
		expect(getMemoryForMcp(store, authorizedId, { scope_id: "scope-b" })).toBe(null);
	});

	it("refuses to forget unauthorized or explicitly filtered-out memories", () => {
		const authorizedId = insertScopedMemory(store, {
			sessionId,
			scopeId: "scope-a",
			title: "Forgettable MCP note",
		});
		const hiddenId = insertScopedMemory(store, {
			sessionId,
			scopeId: "scope-b",
			title: "Hidden forget target",
		});

		expect(forgetMemoryForMcp(store, hiddenId)).toBe(false);
		expect(readActive(store, hiddenId)).toBe(1);
		expect(forgetMemoryForMcp(store, authorizedId, { scope_id: "scope-b" })).toBe(false);
		expect(readActive(store, authorizedId)).toBe(1);

		expect(forgetMemoryForMcp(store, authorizedId)).toBe(true);
		expect(readActive(store, authorizedId)).toBe(0);
	});

	it("stamps remembered MCP memories with the resolved project scope", () => {
		insertProjectScopeMapping(store, {
			projectPattern: join(tmpDir, "greenroom"),
			scopeId: "scope-a",
		});

		const result = rememberMemoryForMcp(
			store,
			{
				kind: "decision",
				title: "MCP scoped remember",
				body: "Remembered through MCP with a mapped project scope.",
				confidence: 0.8,
				project: "greenroom",
			},
			{
				cwd: join(tmpDir, "greenroom"),
				user: "mcp-test",
				now: () => "2026-01-01T00:00:00.000Z",
			},
		);

		const row = store.db
			.prepare("SELECT scope_id FROM memory_items WHERE id = ?")
			.get(result.memId) as { scope_id: string };
		expect(row.scope_id).toBe("scope-a");
		expect(getMemoryForMcp(store, result.memId)?.title).toBe("MCP scoped remember");
	});

	it("rolls back remembered MCP memories that resolve to unauthorized scopes", () => {
		insertProjectScopeMapping(store, {
			projectPattern: join(tmpDir, "greenroom"),
			scopeId: "scope-b",
		});

		expect(() =>
			rememberMemoryForMcp(
				store,
				{
					kind: "decision",
					title: "Unauthorized MCP scoped remember",
					body: "This should not be persisted into an unauthorized scope.",
					confidence: 0.8,
					project: "greenroom",
				},
				{
					cwd: join(tmpDir, "greenroom"),
					user: "mcp-test",
					now: () => "2026-01-01T00:00:00.000Z",
				},
			),
		).toThrow("unauthorized_scope");
		expect(countMemoriesByTitle(store, "Unauthorized MCP scoped remember")).toBe(0);
	});
});

function insertSession(
	db: ReturnType<typeof connect>,
	input: { cwd: string; project: string },
): number {
	const now = new Date().toISOString();
	const info = db
		.prepare(
			"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, ?, ?, ?, ?)",
		)
		.run(now, input.cwd, input.project, "mcp-test", "test");
	return Number(info.lastInsertRowid);
}

function insertCoordinatorScope(db: ReturnType<typeof connect>, scopeId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT OR REPLACE INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id,
			membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, 'team', 'coordinator', 'coord-test', 'group-test', 0, 'active', ?, ?)`,
	).run(scopeId, scopeId, now, now);
}

function grantScopeToDevice(
	db: ReturnType<typeof connect>,
	scopeId: string,
	deviceId: string,
): void {
	insertCoordinatorScope(db, scopeId);
	db.prepare(
		`INSERT OR REPLACE INTO scope_memberships(
			scope_id, device_id, role, status, membership_epoch,
			coordinator_id, group_id, updated_at
		 ) VALUES (?, ?, 'member', 'active', 0, 'coord-test', 'group-test', ?)`,
	).run(scopeId, deviceId, new Date().toISOString());
}

function insertScopedMemory(
	store: MemoryStore,
	input: { sessionId: number; scopeId: string; title: string },
): number {
	const now = new Date().toISOString();
	const info = store.db
		.prepare(
			`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
				tags_text, active, created_at, updated_at, metadata_json, rev, visibility, scope_id)
			 VALUES (?, 'discovery', ?, ?, 0.9, '', 1, ?, ?, '{}', 1, 'shared', ?)`,
		)
		.run(input.sessionId, input.title, `${input.title} body`, now, now, input.scopeId);
	return Number(info.lastInsertRowid);
}

function insertProjectScopeMapping(
	store: MemoryStore,
	input: { projectPattern: string; scopeId: string },
): void {
	const now = new Date().toISOString();
	store.db
		.prepare(
			`INSERT INTO project_scope_mappings(
				project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, 10, 'user', ?, ?)`,
		)
		.run(input.projectPattern, input.scopeId, now, now);
}

function readActive(store: MemoryStore, memoryId: number): number | null {
	const row = store.db.prepare("SELECT active FROM memory_items WHERE id = ?").get(memoryId) as
		| { active: number }
		| undefined;
	return row?.active ?? null;
}

function countMemoriesByTitle(store: MemoryStore, title: string): number {
	const row = store.db
		.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE title = ?")
		.get(title) as { count: number };
	return row.count;
}
