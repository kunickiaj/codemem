import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSqliteVec } from "./db.js";
import { chunkText, hashText } from "./embeddings.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";
import { prepareVectorCutoverValidation } from "./vector-cutover-validation.js";
import { upgradeVectorIndex } from "./vector-index-upgrade.js";
import { createVectorMetadataSnapshot } from "./vector-metadata-snapshot.js";
import {
	countIncompleteActiveMemoryVectorCoverage,
	findIncompleteActiveMemoryIds,
	pruneObsoleteTargetVectorsFromCatalog,
} from "./vectors.js";

type PruneScope = "all" | "active-only";
type Entry = "catalog" | "prepare";
let directory: string;
let db: Database;
let writer: Database;
let session: number;
const model = "synthetic-target";
const scopes = [undefined, "all", "active-only"] as const;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-active-coverage-"));
	db = new Database(join(directory, "synthetic.sqlite"));
	db.pragma("journal_mode = WAL");
	initTestSchema(db);
	session = insertTestSession(db);
	writer = new Database(join(directory, "synthetic.sqlite"));
	loadSqliteVec(writer);
	writer.pragma("busy_timeout = 0");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("test forbids network"));
});

afterEach(() => {
	vi.restoreAllMocks();
	writer.close();
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

function memory(id: number, options: { title?: string; body?: string; active?: number } = {}) {
	db.prepare(`INSERT INTO memory_items
		(id, session_id, kind, title, body_text, active, created_at, updated_at)
		VALUES (?, ?, 'feature', ?, ?, ?, '2026-09-01', '2026-09-01')`).run(
		id,
		session,
		options.title ?? `Memory ${id}`,
		options.body ?? "Body",
		options.active ?? 1,
	);
}

function hashes(id: number): string[] {
	const row = db.prepare("SELECT title, body_text FROM memory_items WHERE id = ?").get(id) as {
		title: string;
		body_text: string;
	};
	return chunkText(`${row.title}\n${row.body_text}`.trim()).map(hashText);
}

function vector(id: number, hash: string, label = model, chunkIndex = 0): number {
	return Number(
		db
			.prepare(`INSERT INTO memory_vectors
			(embedding, memory_id, chunk_index, content_hash, model) VALUES (?, ?, ?, ?, ?)`)
			.run(Buffer.alloc(384 * 4), BigInt(id), BigInt(chunkIndex), hash, label).lastInsertRowid,
	);
}

function rowids(): number[] {
	return db.prepare("SELECT rowid FROM memory_vectors ORDER BY rowid").pluck().all() as number[];
}

function prune(entry: Entry, pruneScope?: PruneScope): number {
	const options = pruneScope === undefined ? {} : { pruneScope };
	if (entry === "prepare") {
		const validation = prepareVectorCutoverValidation(db, model, options);
		try {
			return validation.deleted;
		} finally {
			validation.close();
		}
	}
	const metadata = createVectorMetadataSnapshot(db, { model });
	try {
		return pruneObsoleteTargetVectorsFromCatalog(db, model, metadata, options);
	} finally {
		metadata.close();
	}
}

function useLayout(layout: "legacy" | "v1") {
	if (layout === "v1") upgradeVectorIndex(db, { configuredModel: model });
}

// Mutate after the unlocked candidate body read, before BEGIN IMMEDIATE.
function beforeDeleteLock(mutate: () => void) {
	const prepare = db.prepare.bind(db);
	let mutations = 0;
	vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
		const statement = prepare(sql);
		if (sql === "SELECT title, body_text, active FROM memory_items WHERE id = ?") {
			const get = statement.get.bind(statement);
			statement.get = (...params: unknown[]) => {
				const result = get(...params);
				if (mutations === 0) {
					expect(db.inTransaction).toBe(false);
					mutations++;
					mutate();
				}
				return result;
			};
		}
		return statement;
	});
	return () => mutations;
}

describe.each(["legacy", "v1"] as const)("active coverage repair on %s", (layout) => {
	describe.each(["catalog", "prepare"] as const)("%s prune entry", (entry) => {
		it.each(scopes)("scope %s preserves inactive rows only for active-only", (scope) => {
			// Arrange: inactive fallback has no current target coverage requirement.
			memory(1, { active: 0 });
			const retained = vector(1, "old-inactive");
			useLayout(layout);
			// Act
			const deleted = prune(entry, scope);
			// Assert: omission must retain the migration's historical all-scope behavior.
			expect(deleted).toBe(scope === "active-only" ? 0 : 1);
			expect(rowids()).toEqual(scope === "active-only" ? [retained] : []);
		});

		it.each(scopes)(
			"scope %s removes only stale hashes from a fully covered active memory",
			(scope) => {
				// Arrange
				memory(1);
				const current = vector(1, hashes(1)[0]);
				vector(1, "stale");
				const other = vector(1, "other-model-fallback", "other-model");
				useLayout(layout);
				// Act
				const deleted = prune(entry, scope);
				// Assert
				expect(deleted).toBe(1);
				expect(rowids()).toEqual([current, other]);
			},
		);

		it.each(scopes)("scope %s retains fallback when active current hashes are missing", (scope) => {
			// Arrange
			memory(1);
			const fallback = vector(1, "old-fallback");
			useLayout(layout);
			// Act
			const deleted = prune(entry, scope);
			// Assert
			expect(deleted).toBe(0);
			expect(rowids()).toEqual([fallback]);
		});

		it.each(scopes)("scope %s preserves missing-memory vectors only for active-only", (scope) => {
			// Arrange: native vec0 permits a numeric reference without a matching memory.
			const orphan = vector(999, "missing-memory");
			useLayout(layout);
			// Act
			const deleted = prune(entry, scope);
			// Assert
			expect(deleted).toBe(scope === "active-only" ? 0 : 1);
			expect(rowids()).toEqual(scope === "active-only" ? [orphan] : []);
		});

		it("active-only removes old target rows for an active blank memory", () => {
			// Arrange: active-only includes blank memories, which require no chunk hashes.
			memory(1, { title: "", body: "", active: 1 });
			vector(1, "old-target");
			useLayout(layout);
			// Act
			const deleted = prune(entry, "active-only");
			const incomplete = findIncompleteActiveMemoryIds(db, model);
			// Assert: empty coverage requirements permit removal without adding repair work.
			expect(deleted).toBe(1);
			expect(rowids()).toEqual([]);
			expect(incomplete).toEqual([]);
		});
	});

	it.each(["all", "active-only"] as const)(
		"scope %s requires every multi-chunk hash, regardless of duplicate rows or positions",
		(scope) => {
			// Arrange: duplicates of one current hash cannot cover a different missing chunk.
			const body = Array.from({ length: 800 }, (_, index) => `unique-word-${index}`).join(" ");
			memory(1, { body });
			memory(2, { body });
			const expected = hashes(1);
			expect(expected.length).toBeGreaterThan(1);
			const kept = expected.map((hash) => vector(1, hash, model, 99));
			kept.push(vector(1, expected[0], model, 99));
			vector(1, "complete-stale");
			kept.push(vector(2, hashes(2)[0]), vector(2, hashes(2)[0]));
			kept.push(vector(2, "incomplete-fallback"));
			useLayout(layout);
			// Act
			const deleted = prune("catalog", scope);
			const incomplete = findIncompleteActiveMemoryIds(db, model);
			// Assert
			expect(deleted).toBe(1);
			expect(rowids()).toEqual(kept.sort((a, b) => a - b));
			expect([...incomplete]).toEqual([2]);
		},
	);

	it("enumerates exactly the incomplete active embeddable IDs with live and supplied metadata", () => {
		// Arrange: count parity alone cannot detect returning the wrong IDs.
		memory(1);
		memory(2);
		memory(3, { active: 0 });
		memory(4, { title: " ", body: " " });
		memory(5);
		vector(1, hashes(1)[0]);
		vector(2, "obsolete");
		vector(5, hashes(5)[0], "wrong-model");
		useLayout(layout);
		const metadata = createVectorMetadataSnapshot(db, { model });
		try {
			// Act
			const live = findIncompleteActiveMemoryIds(db, model);
			const saved = findIncompleteActiveMemoryIds(db, model, { metadata });
			const count = countIncompleteActiveMemoryVectorCoverage(db, model, { metadata });
			// Assert: caller-owned snapshots remain usable.
			expect([...live]).toEqual([2, 5]);
			expect([...saved]).toEqual([2, 5]);
			expect([...saved]).toHaveLength(count);
			expect(metadata.open).toBe(true);
		} finally {
			metadata.close();
		}
	});

	it("returns no incomplete IDs when only inactive and blank memories exist", () => {
		// Arrange
		memory(1, { active: 0 });
		memory(2, { title: "", body: "" });
		useLayout(layout);
		// Act
		const ids = findIncompleteActiveMemoryIds(db, model);
		const count = countIncompleteActiveMemoryVectorCoverage(db, model);
		// Assert
		expect([...ids]).toEqual([]);
		expect(count).toBe(0);
	});
});

describe.each(["legacy", "v1"] as const)("%s prune race protection", (layout) => {
	describe.each(["all", "active-only"] as const)("%s locked recheck", (scope) => {
		it.each(["inactive", "edit", "coverage-drop"] as const)(
			"rechecks %s after candidate selection under the delete lock",
			(mutation) => {
				// Arrange: the WAL writer changes real persisted data after the catalog/body snapshot.
				memory(1);
				const current = vector(1, hashes(1)[0]);
				const fallback = vector(1, hashText("Edited\nBody"));
				useLayout(layout);
				const mutations = beforeDeleteLock(() => {
					if (mutation === "inactive")
						writer.exec("UPDATE memory_items SET active = 0 WHERE id = 1");
					if (mutation === "edit")
						writer.exec("UPDATE memory_items SET title = 'Edited' WHERE id = 1");
					if (mutation === "coverage-drop")
						writer.prepare("DELETE FROM memory_vectors WHERE rowid = ?").run(current);
				});
				// Act
				const deleted = prune("catalog", scope);
				// Assert: all-scope still prunes inactive rows, but both scopes recheck hash coverage.
				expect(mutations()).toBe(1);
				if (scope === "all" && mutation === "inactive") {
					expect(deleted).toBe(1);
					expect(rowids()).toEqual([current]);
					return;
				}
				expect(deleted).toBe(0);
				expect(rowids()).toContain(fallback);
			},
		);
	});
});

describe("incomplete active ID snapshot semantics", () => {
	it("uses supplied metadata even when live target coverage arrives later", () => {
		// Arrange: the saved catalog contains only fallback, then a live writer fills the gap.
		memory(1);
		vector(1, "fallback");
		const metadata = createVectorMetadataSnapshot(db, { model });
		vector(1, hashes(1)[0]);
		try {
			// Act
			const live = findIncompleteActiveMemoryIds(db, model);
			const saved = findIncompleteActiveMemoryIds(db, model, { metadata });
			const savedCount = countIncompleteActiveMemoryVectorCoverage(db, model, { metadata });
			// Assert: live hashes cannot repair an incomplete saved proof.
			expect([...live]).toEqual([]);
			expect([...saved]).toEqual([1]);
			expect([...saved]).toHaveLength(savedCount);
		} finally {
			metadata.close();
		}
	});

	it("enumerates incomplete IDs across multiple coverage pages without including skipped rows", () => {
		// Arrange: more than 250 embeddable active rows force a second cursor page.
		db.transaction(() => {
			for (let id = 1; id <= 252; id++) memory(id);
			vector(1, hashes(1)[0]);
			vector(252, hashes(252)[0]);
			memory(253, { active: 0 });
			memory(254, { title: "", body: " " });
		})();
		// Act
		const ids = findIncompleteActiveMemoryIds(db, model);
		const count = countIncompleteActiveMemoryVectorCoverage(db, model);
		// Assert: both page boundaries and exclusion rules agree with the existing count.
		expect([...ids]).toEqual(Array.from({ length: 250 }, (_, index) => index + 2));
		expect([...ids]).toHaveLength(count);
	});
});

describe("nullable legacy metadata fixture", () => {
	it.each(["catalog", "prepare"] as const)(
		"%s respects active-only for NULL and missing memory references",
		(entry) => {
			// Arrange: vec0 cannot insert NULL memory IDs. Match the existing TEMP-table fixture.
			db.exec(`CREATE TEMP TABLE memory_vectors(
			rowid INTEGER PRIMARY KEY, memory_id INTEGER, model TEXT, content_hash TEXT)`);
			db.prepare(
				"INSERT INTO memory_vectors VALUES (1, NULL, ?, 'null-ref'), (2, 999, ?, 'missing-ref')",
			).run(model, model);
			// Act
			const activeDeleted = prune(entry, "active-only");
			const afterActive = rowids();
			const defaultDeleted = prune(entry);
			// Assert: the all-scope migration still removes both orphan forms.
			expect(activeDeleted).toBe(0);
			expect(afterActive).toEqual([1, 2]);
			expect(defaultDeleted).toBe(2);
			expect(rowids()).toEqual([]);
		},
	);
});
