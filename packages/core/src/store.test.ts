import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { buildFilterClauses } from "./filters.js";
import { MemoryStore } from "./store.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Helper: create a MemoryStore backed by a temp DB with test schema.
// We can't use the MemoryStore constructor directly because it calls
// assertSchemaReady which requires the schema to already exist. Instead,
// we pre-initialize the schema, then construct the store.
// ---------------------------------------------------------------------------

describe("MemoryStore", () => {
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-store-test-"));
		dbPath = join(tmpDir, "test.sqlite");
		// Pre-create the schema so MemoryStore constructor's assertSchemaReady passes
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		// Now open via MemoryStore
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store?.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// -- get ----------------------------------------------------------------

	describe("get", () => {
		it("returns null for non-existent memory", () => {
			expect(store.get(9999)).toBeNull();
		});

		it("returns a memory item with parsed metadata", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Test title", "Test body");

			const result = store.get(memId);
			expect(result).not.toBeNull();
			expect(result?.id).toBe(memId);
			expect(result?.kind).toBe("discovery");
			expect(result?.title).toBe("Test title");
			expect(result?.body_text).toBe("Test body");
			// metadata_json should be parsed into an object
			expect(typeof result?.metadata_json).toBe("object");
		});
	});

	// -- remember -----------------------------------------------------------

	describe("remember", () => {
		it("inserts a memory item and returns the ID", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "feature", "My Feature", "Feature body", 0.8);

			expect(memId).toBeGreaterThan(0);

			const row = store.get(memId);
			expect(row).not.toBeNull();
			expect(row?.kind).toBe("feature");
			expect(row?.title).toBe("My Feature");
			expect(row?.body_text).toBe("Feature body");
			expect(row?.confidence).toBe(0.8);
			expect(row?.active).toBe(1);
			expect(row?.rev).toBe(1);
			expect(row?.deleted_at).toBeNull();
		});

		it("generates an import_key when not provided", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			const row = store.get(memId);
			expect(row?.import_key).toBeTruthy();
			expect(typeof row?.import_key).toBe("string");
		});

		it("preserves provided import_key in metadata", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body", 0.5, undefined, {
				import_key: "custom-key-123",
			});

			const row = store.get(memId);
			expect(row?.import_key).toBe("custom-key-123");
		});

		it("validates and normalizes memory kind", () => {
			const sessionId = insertTestSession(store.db);
			// Accepts valid kind
			const memId = store.remember(sessionId, "  Discovery  ", "Title", "Body");
			const row = store.get(memId);
			expect(row?.kind).toBe("discovery");
		});

		it("rejects invalid memory kind", () => {
			const sessionId = insertTestSession(store.db);
			expect(() => store.remember(sessionId, "yolo", "Title", "Body")).toThrow(
				/Invalid memory kind/,
			);
		});

		it("succeeds with empty title", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "", "Body with empty title");
			expect(memId).toBeGreaterThan(0);

			const row = store.get(memId);
			expect(row).not.toBeNull();
			expect(row?.title).toBe("");
			expect(row?.body_text).toBe("Body with empty title");
		});

		it("rejects invalid kind with descriptive error including valid kinds", () => {
			const sessionId = insertTestSession(store.db);
			try {
				store.remember(sessionId, "made_up_kind", "Title", "Body");
				expect.unreachable("should have thrown");
			} catch (e) {
				const msg = (e as Error).message;
				expect(msg).toMatch(/Invalid memory kind/);
				expect(msg).toContain("made_up_kind");
			}
		});

		it("sets clock_device_id in metadata", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");
			const row = store.get(memId);
			expect(row?.metadata_json.clock_device_id).toBe(store.deviceId);
		});

		it("sets origin_device_id", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");
			const row = store.get(memId);
			expect(row?.origin_device_id).toBe(store.deviceId);
		});

		it("sorts and deduplicates tags", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "T", "B", 0.5, [
				"beta",
				"alpha",
				"beta",
			]);

			const row = store.get(memId);
			expect(row?.tags_text).toBe("alpha beta");
		});
	});

	// -- forget --------------------------------------------------------------

	describe("forget", () => {
		it("soft-deletes an existing memory", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "To Delete", "Body");

			store.forget(memId);

			const row = store.get(memId);
			expect(row).not.toBeNull();
			expect(row?.active).toBe(0);
			expect(row?.deleted_at).toBeTruthy();
			expect(row?.rev).toBe(2); // was 1, bumped to 2
		});

		it("updates metadata_json with clock_device_id", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "To Delete", "Body");
			store.forget(memId);

			const row = store.get(memId);
			expect(row?.metadata_json.clock_device_id).toBe(store.deviceId);
		});

		it("is a no-op for non-existent memory", () => {
			// Should not throw
			store.forget(99999);
		});
	});

	// -- recent --------------------------------------------------------------

	describe("recent", () => {
		it("returns active memories ordered by created_at DESC", () => {
			const sessionId = insertTestSession(store.db);
			// Insert with explicit timestamps to guarantee ordering
			const base = "2026-01-01T00:00:0";
			for (const [i, kind] of (["discovery", "feature", "bugfix"] as const).entries()) {
				store.db
					.prepare(
						`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
					tags_text, active, created_at, updated_at, metadata_json, rev)
					VALUES (?, ?, ?, ?, 0.5, '', 1, ?, ?, '{}', 1)`,
					)
					.run(sessionId, kind, `Item ${i}`, `Body ${i}`, `${base}${i}Z`, `${base}${i}Z`);
			}

			const results = store.recent(10);
			expect(results).toHaveLength(3);
			// Newest first (bugfix at :02, feature at :01, discovery at :00)
			expect(results[0]?.kind).toBe("bugfix");
			expect(results[2]?.kind).toBe("discovery");
		});

		it("excludes soft-deleted memories", () => {
			const sessionId = insertTestSession(store.db);
			const id1 = store.remember(sessionId, "discovery", "Keep", "Body");
			const id2 = store.remember(sessionId, "discovery", "Delete", "Body");
			store.forget(id2);

			const results = store.recent(10);
			expect(results).toHaveLength(1);
			expect(results[0].id).toBe(id1);
		});

		it("respects limit and offset", () => {
			const sessionId = insertTestSession(store.db);
			for (let i = 0; i < 5; i++) {
				store.remember(sessionId, "discovery", `Item ${i}`, `Body ${i}`);
			}

			const page1 = store.recent(2, null, 0);
			const page2 = store.recent(2, null, 2);
			expect(page1).toHaveLength(2);
			expect(page2).toHaveLength(2);
			expect(page1[0].id).not.toBe(page2[0].id);
		});

		it("filters by kind", () => {
			const sessionId = insertTestSession(store.db);
			store.remember(sessionId, "discovery", "D1", "Body");
			store.remember(sessionId, "feature", "F1", "Body");
			store.remember(sessionId, "discovery", "D2", "Body");

			const results = store.recent(10, { kind: "discovery" });
			expect(results).toHaveLength(2);
			for (const r of results) {
				expect(r.kind).toBe("discovery");
			}
		});
	});

	// -- recentByKinds -------------------------------------------------------

	describe("recentByKinds", () => {
		it("filters by multiple kinds", () => {
			const sessionId = insertTestSession(store.db);
			store.remember(sessionId, "discovery", "D1", "Body");
			store.remember(sessionId, "feature", "F1", "Body");
			store.remember(sessionId, "bugfix", "B1", "Body");
			store.remember(sessionId, "refactor", "R1", "Body");

			const results = store.recentByKinds(["discovery", "bugfix"]);
			expect(results).toHaveLength(2);
			const kinds = results.map((r) => r.kind);
			expect(kinds).toContain("discovery");
			expect(kinds).toContain("bugfix");
		});

		it("returns empty array for empty kinds list", () => {
			const results = store.recentByKinds([]);
			expect(results).toEqual([]);
		});
	});

	// -- stats ---------------------------------------------------------------

	describe("stats", () => {
		it("returns a structured stats object", () => {
			const sessionId = insertTestSession(store.db);
			store.remember(sessionId, "discovery", "Title", "Body");

			const result = store.stats();
			expect(result.database).toBeDefined();
			expect(result.database.path).toBe(dbPath);
			expect(result.database.size_bytes).toBeGreaterThan(0);
			expect(result.database.sessions).toBe(1);
			expect(result.database.memory_items).toBe(1);
			expect(result.database.active_memory_items).toBe(1);
			expect(result.database.artifacts).toBe(0);
			expect(result.database.raw_events).toBe(0);
		});

		it("counts inactive memories in total but not active", () => {
			const sessionId = insertTestSession(store.db);
			const _id1 = store.remember(sessionId, "discovery", "Active", "Body");
			const id2 = store.remember(sessionId, "discovery", "Deleted", "Body");
			store.forget(id2);

			const result = store.stats();
			expect(result.database.memory_items).toBe(2);
			expect(result.database.active_memory_items).toBe(1);
		});
	});

	// -- updateMemoryVisibility ----------------------------------------------

	describe("updateMemoryVisibility", () => {
		it("updates visibility to private with device-scoped workspace_id", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			const updated = store.updateMemoryVisibility(memId, "private");
			expect(updated.visibility).toBe("private");
			expect(updated.workspace_kind).toBe("personal");
			expect(updated.workspace_id).toBe(`personal:${store.deviceId}`);
		});

		it("updates metadata_json with clock_device_id on visibility change", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			const updated = store.updateMemoryVisibility(memId, "shared");
			expect(updated.metadata_json.clock_device_id).toBe(store.deviceId);
			expect(updated.metadata_json.visibility).toBe("shared");
		});

		it("updates visibility to shared", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			const updated = store.updateMemoryVisibility(memId, "shared");
			expect(updated.visibility).toBe("shared");
			expect(updated.workspace_kind).toBe("shared");
		});

		it("bumps rev on visibility change", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			const original = store.get(memId);
			const updated = store.updateMemoryVisibility(memId, "private");
			expect(updated.rev).toBe((original?.rev as number) + 1);
		});

		it("throws for invalid visibility", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");

			expect(() => store.updateMemoryVisibility(memId, "invalid")).toThrow(
				/visibility must be private or shared/,
			);
		});

		it("throws for non-existent memory", () => {
			expect(() => store.updateMemoryVisibility(99999, "shared")).toThrow(/memory not found/);
		});

		it("throws for inactive memory", () => {
			const sessionId = insertTestSession(store.db);
			const memId = store.remember(sessionId, "discovery", "Title", "Body");
			store.forget(memId);

			expect(() => store.updateMemoryVisibility(memId, "shared")).toThrow(/memory not found/);
		});

		it("throws for memory owned by another device", () => {
			const sessionId = insertTestSession(store.db);
			// Insert a memory with a different origin_device_id
			store.db
				.prepare(
					`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
					tags_text, active, created_at, updated_at, metadata_json,
					origin_device_id, rev)
					VALUES (?, 'discovery', 'Foreign', 'Body', 0.5, '', 1, ?, ?, '{}', 'other-device', 1)`,
				)
				.run(sessionId, new Date().toISOString(), new Date().toISOString());
			const foreignId = Number(
				(store.db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id,
			);

			expect(() => store.updateMemoryVisibility(foreignId, "private")).toThrow(
				/not owned by this device/,
			);
		});
	});

	// -- close ---------------------------------------------------------------

	describe("close", () => {
		it("closes the database connection", () => {
			const sessionId = insertTestSession(store.db);
			store.remember(sessionId, "discovery", "Title", "Body");
			store.close();

			// After close, operations should throw
			expect(() => store.get(1)).toThrow();
			// Prevent afterEach from double-closing
			store = undefined as unknown as MemoryStore;
		});
	});
});

// ---------------------------------------------------------------------------
// buildFilterClauses (unit tests)
// ---------------------------------------------------------------------------

describe("buildFilterClauses", () => {
	it("returns empty for null/undefined filters", () => {
		const result = buildFilterClauses(null);
		expect(result.clauses).toEqual([]);
		expect(result.params).toEqual([]);
		expect(result.joinSessions).toBe(false);
	});

	it("builds kind filter", () => {
		const result = buildFilterClauses({ kind: "discovery" });
		expect(result.clauses).toEqual(["memory_items.kind = ?"]);
		expect(result.params).toEqual(["discovery"]);
	});

	it("builds include_visibility filter", () => {
		const result = buildFilterClauses({ include_visibility: ["private", "shared"] });
		expect(result.clauses).toHaveLength(1);
		expect(result.clauses[0]).toContain("IN");
		expect(result.params).toEqual(["private", "shared"]);
	});

	it("builds exclude_actor_ids filter", () => {
		const result = buildFilterClauses({ exclude_actor_ids: ["actor:123"] });
		expect(result.clauses).toHaveLength(1);
		expect(result.clauses[0]).toContain("NOT IN");
		expect(result.params).toEqual(["actor:123"]);
	});

	it("combines multiple filters", () => {
		const result = buildFilterClauses({
			kind: "feature",
			include_visibility: ["shared"],
			exclude_workspace_kinds: ["personal"],
		});
		expect(result.clauses).toHaveLength(3);
		expect(result.params).toEqual(["feature", "shared", "personal"]);
	});
});
