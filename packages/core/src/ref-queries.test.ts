import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { findByConcept, findByFile } from "./ref-queries.js";
import { MemoryStore } from "./store.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

describe("ref-queries", () => {
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;
	let sessionId: number;
	let prevCodememConfig: string | undefined;
	let prevActorId: string | undefined;
	let prevActorDisplayName: string | undefined;

	beforeEach(() => {
		prevCodememConfig = process.env.CODEMEM_CONFIG;
		prevActorId = process.env.CODEMEM_ACTOR_ID;
		prevActorDisplayName = process.env.CODEMEM_ACTOR_DISPLAY_NAME;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-ref-queries-test-"));
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
		delete process.env.CODEMEM_ACTOR_ID;
		delete process.env.CODEMEM_ACTOR_DISPLAY_NAME;
		dbPath = join(tmpDir, "test.sqlite");
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		store = new MemoryStore(dbPath);
		sessionId = insertTestSession(store.db);
	});

	afterEach(() => {
		store?.close();
		if (prevCodememConfig === undefined) delete process.env.CODEMEM_CONFIG;
		else process.env.CODEMEM_CONFIG = prevCodememConfig;
		if (prevActorId === undefined) delete process.env.CODEMEM_ACTOR_ID;
		else process.env.CODEMEM_ACTOR_ID = prevActorId;
		if (prevActorDisplayName === undefined) delete process.env.CODEMEM_ACTOR_DISPLAY_NAME;
		else process.env.CODEMEM_ACTOR_DISPLAY_NAME = prevActorDisplayName;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// -- findByFile -----------------------------------------------------------

	describe("findByFile", () => {
		it("returns memories where the file appears in memory_file_refs", () => {
			store.remember(sessionId, "discovery", "Auth module overview", "Body about auth", 0.8, [], {
				files_read: ["src/auth.ts", "src/config.ts"],
				files_modified: ["src/auth.ts"],
			});
			store.remember(sessionId, "bugfix", "Fixed config bug", "Body about config", 0.7, [], {
				files_read: ["src/config.ts"],
			});

			const results = findByFile(store.db, "src/auth.ts");
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Auth module overview");
		});

		it("filters by relation type", () => {
			store.remember(sessionId, "discovery", "Auth read-only", "Body", 0.5, [], {
				files_read: ["src/auth.ts"],
			});
			store.remember(sessionId, "change", "Auth modified", "Body", 0.5, [], {
				files_modified: ["src/auth.ts"],
			});

			const readOnly = findByFile(store.db, "src/auth.ts", { relation: "read" });
			expect(readOnly).toHaveLength(1);
			expect(readOnly[0].title).toBe("Auth read-only");

			const modifiedOnly = findByFile(store.db, "src/auth.ts", { relation: "modified" });
			expect(modifiedOnly).toHaveLength(1);
			expect(modifiedOnly[0].title).toBe("Auth modified");
		});

		it("filters by memory kind", () => {
			store.remember(sessionId, "decision", "Auth decision", "Body", 0.8, [], {
				files_read: ["src/auth.ts"],
			});
			store.remember(sessionId, "bugfix", "Auth bugfix", "Body", 0.6, [], {
				files_read: ["src/auth.ts"],
			});

			const decisions = findByFile(store.db, "src/auth.ts", { kind: "decision" });
			expect(decisions).toHaveLength(1);
			expect(decisions[0].title).toBe("Auth decision");
		});

		it("matches directory prefix when filePath ends with /", () => {
			store.remember(sessionId, "discovery", "Auth deep file", "Body", 0.5, [], {
				files_read: ["src/auth/provider.ts", "src/auth/adapter.ts"],
			});
			store.remember(sessionId, "discovery", "Config file", "Body", 0.5, [], {
				files_read: ["src/config.ts"],
			});

			const results = findByFile(store.db, "src/auth/");
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Auth deep file");
		});

		it("returns results ordered by created_at DESC", () => {
			// Create memories with different timestamps by inserting directly with offsets
			const id1 = store.remember(sessionId, "discovery", "First created", "Body", 0.5, [], {
				files_read: ["src/auth.ts"],
			});
			const id2 = store.remember(sessionId, "bugfix", "Second created", "Body", 0.5, [], {
				files_read: ["src/auth.ts"],
			});
			// Manually push the second one's created_at later to guarantee ordering
			store.db
				.prepare("UPDATE memory_items SET created_at = '2099-01-01T00:00:00Z' WHERE id = ?")
				.run(id2);
			store.db
				.prepare("UPDATE memory_items SET created_at = '2000-01-01T00:00:00Z' WHERE id = ?")
				.run(id1);

			const results = findByFile(store.db, "src/auth.ts");
			expect(results).toHaveLength(2);
			expect(results[0].title).toBe("Second created");
			expect(results[1].title).toBe("First created");
		});

		it("respects the limit option", () => {
			for (let i = 0; i < 5; i++) {
				store.remember(sessionId, "discovery", `Memory ${i}`, "Body", 0.5, [], {
					files_read: ["src/auth.ts"],
				});
			}

			const results = findByFile(store.db, "src/auth.ts", { limit: 2 });
			expect(results).toHaveLength(2);
		});

		it("excludes soft-deleted memories (active = 0)", () => {
			const memId = store.remember(sessionId, "discovery", "Deleted memory", "Body", 0.5, [], {
				files_read: ["src/auth.ts"],
			});
			store.db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(memId);

			const results = findByFile(store.db, "src/auth.ts");
			expect(results).toHaveLength(0);
		});

		it("filters by since timestamp", () => {
			const id1 = store.remember(sessionId, "discovery", "Old memory", "Body", 0.5, [], {
				files_read: ["src/auth.ts"],
			});
			const id2 = store.remember(sessionId, "bugfix", "New memory", "Body", 0.5, [], {
				files_read: ["src/auth.ts"],
			});
			store.db
				.prepare("UPDATE memory_items SET created_at = '2000-01-01T00:00:00Z' WHERE id = ?")
				.run(id1);
			store.db
				.prepare("UPDATE memory_items SET created_at = '2099-01-01T00:00:00Z' WHERE id = ?")
				.run(id2);

			const results = findByFile(store.db, "src/auth.ts", { since: "2025-01-01T00:00:00Z" });
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("New memory");
		});
	});

	// -- findByConcept --------------------------------------------------------

	describe("findByConcept", () => {
		it("returns memories with the given concept", () => {
			store.remember(sessionId, "discovery", "Auth concepts", "Body about auth", 0.8, [], {
				concepts: ["auth", "security"],
			});
			store.remember(sessionId, "bugfix", "Config concepts", "Body about config", 0.7, [], {
				concepts: ["config"],
			});

			const results = findByConcept(store.db, "auth");
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Auth concepts");
		});

		it("normalizes input to lowercase before querying", () => {
			store.remember(sessionId, "discovery", "Auth uppercase", "Body", 0.5, [], {
				concepts: ["auth"],
			});

			// Query with uppercase — should still match
			const results = findByConcept(store.db, "Auth");
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Auth uppercase");
		});

		it("filters by memory kind", () => {
			store.remember(sessionId, "decision", "Auth decision", "Body", 0.8, [], {
				concepts: ["auth"],
			});
			store.remember(sessionId, "bugfix", "Auth bugfix", "Body", 0.6, [], {
				concepts: ["auth"],
			});

			const decisions = findByConcept(store.db, "auth", { kind: "decision" });
			expect(decisions).toHaveLength(1);
			expect(decisions[0].title).toBe("Auth decision");
		});

		it("returns results ordered by created_at DESC", () => {
			const id1 = store.remember(sessionId, "discovery", "First concept", "Body", 0.5, [], {
				concepts: ["auth"],
			});
			const id2 = store.remember(sessionId, "bugfix", "Second concept", "Body", 0.5, [], {
				concepts: ["auth"],
			});
			store.db
				.prepare("UPDATE memory_items SET created_at = '2099-01-01T00:00:00Z' WHERE id = ?")
				.run(id2);
			store.db
				.prepare("UPDATE memory_items SET created_at = '2000-01-01T00:00:00Z' WHERE id = ?")
				.run(id1);

			const results = findByConcept(store.db, "auth");
			expect(results).toHaveLength(2);
			expect(results[0].title).toBe("Second concept");
			expect(results[1].title).toBe("First concept");
		});

		it("respects the limit option", () => {
			for (let i = 0; i < 5; i++) {
				store.remember(sessionId, "discovery", `Concept memory ${i}`, "Body", 0.5, [], {
					concepts: ["auth"],
				});
			}

			const results = findByConcept(store.db, "auth", { limit: 2 });
			expect(results).toHaveLength(2);
		});

		it("excludes soft-deleted memories (active = 0)", () => {
			const memId = store.remember(sessionId, "discovery", "Deleted concept", "Body", 0.5, [], {
				concepts: ["auth"],
			});
			store.db.prepare("UPDATE memory_items SET active = 0 WHERE id = ?").run(memId);

			const results = findByConcept(store.db, "auth");
			expect(results).toHaveLength(0);
		});

		it("filters by since timestamp", () => {
			const id1 = store.remember(sessionId, "discovery", "Old concept", "Body", 0.5, [], {
				concepts: ["auth"],
			});
			const id2 = store.remember(sessionId, "bugfix", "New concept", "Body", 0.5, [], {
				concepts: ["auth"],
			});
			store.db
				.prepare("UPDATE memory_items SET created_at = '2000-01-01T00:00:00Z' WHERE id = ?")
				.run(id1);
			store.db
				.prepare("UPDATE memory_items SET created_at = '2099-01-01T00:00:00Z' WHERE id = ?")
				.run(id2);

			const results = findByConcept(store.db, "auth", { since: "2025-01-01T00:00:00Z" });
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("New concept");
		});
	});

	// -- MemoryStore integration ----------------------------------------------

	describe("MemoryStore integration", () => {
		it("store.findByFile delegates to the ref-queries function", () => {
			store.remember(sessionId, "discovery", "Store file test", "Body", 0.5, [], {
				files_read: ["src/store.ts"],
			});

			const results = store.findByFile("src/store.ts");
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Store file test");
		});

		it("store.findByConcept delegates to the ref-queries function", () => {
			store.remember(sessionId, "discovery", "Store concept test", "Body", 0.5, [], {
				concepts: ["store"],
			});

			const results = store.findByConcept("store");
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Store concept test");
		});
	});
});
