import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdditiveSchemaCompatibility } from "./db.js";
import { initTestSchema } from "./test-utils.js";
import { ensureVectorCorpusEpoch, readVectorCorpusFence } from "./vector-corpus-epoch.js";

let directory: string;
let db: Database;
let writer: Database;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-epoch-"));
	db = new Database(join(directory, "synthetic.sqlite"));
	db.pragma("journal_mode = WAL");
	db.exec(`CREATE TABLE memory_items (
			id INTEGER PRIMARY KEY, title TEXT, body_text TEXT, active INTEGER,
			updated_at TEXT, access_count INTEGER DEFAULT 0);
			INSERT INTO memory_items VALUES (1, 'Title', 'Body', 1, 'fixed', 0)`);
	// An old raw-SQL writer never runs the new installer.
	writer = new Database(join(directory, "synthetic.sqlite"));
	ensureVectorCorpusEpoch(db);
});

afterEach(() => {
	vi.restoreAllMocks();
	writer.close();
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("cross-version vector corpus mutations", () => {
	it.each(["rowid", "_rowid_", "oid"])(
		"invalidates coverage when a legacy writer changes id through %s",
		(alias) => {
			// Arrange: INTEGER PRIMARY KEY aliases change the same persisted memory ID.
			const before = readVectorCorpusFence(db);
			// Act: an older writer uses SQLite's alias instead of the declared column.
			writer.exec(`UPDATE memory_items SET ${alias} = 2 WHERE id = 1`);
			// Assert: the schema stays fixed, but coverage for the old ID is invalidated.
			expect(db.prepare("SELECT id FROM memory_items").pluck().all()).toEqual([2]);
			expect(readVectorCorpusFence(db)).toEqual({
				...before,
				epoch: String(Number(before.epoch) + 1),
			});
		},
	);

	it.each(["rowid", "_rowid_", "oid"])("keeps the fence stable for a no-op %s rewrite", (alias) => {
		// Arrange
		const before = readVectorCorpusFence(db);
		// Act: the trigger runs, but its OLD/NEW predicate must reject this no-op.
		writer.exec(`UPDATE memory_items SET ${alias} = ${alias} WHERE id = 1`);
		// Assert: aliases must not reintroduce invalidation on unrelated activity.
		expect(db.prepare("SELECT id FROM memory_items").pluck().all()).toEqual([1]);
		expect(readVectorCorpusFence(db)).toEqual(before);
	});

	it.each([
		"UPDATE memory_items SET id = 2 WHERE id = 1",
		"UPDATE memory_items SET title = 'Edited' WHERE id = 1",
		"UPDATE memory_items SET body_text = 'Edited' WHERE id = 1",
		"UPDATE memory_items SET active = 0 WHERE id = 1",
		"UPDATE memory_items SET title = NULL WHERE id = 1",
		"INSERT INTO memory_items(id, title, body_text, active) VALUES (2, '', '', 0)",
		"DELETE FROM memory_items WHERE id = 1",
	])("observes legacy SQL mutation: %s", (sql) => {
		// Arrange: observe the counter from a connection other than the writer.
		const before = readVectorCorpusFence(db);
		// Act: triggers, not application hooks, record the committed change.
		writer.exec(sql);
		// Assert: every relevant mutation invalidates saved corpus coverage.
		expect(Number(readVectorCorpusFence(db).epoch)).toBe(Number(before.epoch) + 1);
		expect(readVectorCorpusFence(db).schemaVersion).toBe(before.schemaVersion);
	});

	it.each([
		"UPDATE memory_items SET id = id, title = title, body_text = body_text, active = active",
		"UPDATE memory_items SET updated_at = 'later', access_count = access_count + 1",
		"UPDATE memory_items SET body_text = 'ignored' WHERE id = 999",
	])("does not invalidate coverage for no-op or unrelated SQL: %s", (sql) => {
		// Arrange
		const before = readVectorCorpusFence(db);
		// Act
		writer.exec(sql);
		// Assert
		expect(readVectorCorpusFence(db)).toEqual(before);
	});

	it("detects a corpus ABA edit even when the final body is identical", () => {
		// Arrange
		const before = Number(readVectorCorpusFence(db).epoch);
		// Act
		writer.exec(
			"UPDATE memory_items SET body_text = 'temporary'; UPDATE memory_items SET body_text = 'Body'",
		);
		// Assert
		expect(Number(readVectorCorpusFence(db).epoch)).toBe(before + 2);
	});
});

describe("repairing the legacy UPDATE OF alias gap", () => {
	it.each(["rowid", "_rowid_", "oid"])(
		"reproduces and repairs the old trigger's missed %s write",
		(alias) => {
			// Arrange: use the old trigger as a fixture without rewriting shared source.
			writer.exec(`DROP TRIGGER vector_corpus_epoch_update;
			CREATE TRIGGER vector_corpus_epoch_update AFTER UPDATE OF id, title, body_text, active ON memory_items
			WHEN OLD.id IS NOT NEW.id OR OLD.title IS NOT NEW.title OR OLD.body_text IS NOT NEW.body_text OR OLD.active IS NOT NEW.active
			BEGIN UPDATE vector_corpus_epoch SET epoch = epoch + 1 WHERE id = 1; END`);
			const before = db.prepare("SELECT epoch FROM vector_corpus_epoch").pluck().get();
			const schemaVersion = db.pragma("schema_version", { simple: true });
			// Act: prove the old trigger misses a real ID change, then install the repair.
			writer.exec(`UPDATE memory_items SET ${alias} = 2 WHERE id = 1`);
			const missedEpoch = db.prepare("SELECT epoch FROM vector_corpus_epoch").pluck().get();
			const missedSchemaVersion = db.pragma("schema_version", { simple: true });
			const legacyFence = readVectorCorpusFence(db);
			ensureVectorCorpusEpoch(db);
			const repaired = readVectorCorpusFence(db);
			writer.exec(`UPDATE memory_items SET ${alias} = 3 WHERE id = 2`);
			// Assert: stale guards force fallback; the repaired trigger observes alias writes.
			expect(missedEpoch).toBe(before);
			expect(missedSchemaVersion).toBe(schemaVersion);
			expect(legacyFence.epoch).toBeNull();
			expect(repaired.epoch).not.toBeNull();
			expect(repaired.schemaVersion).not.toBe(schemaVersion);
			expect(db.prepare("SELECT id FROM memory_items").pluck().all()).toEqual([3]);
			expect(readVectorCorpusFence(db)).toEqual({
				...repaired,
				epoch: String(Number(repaired.epoch) + 1),
			});
		},
	);
});

describe("vector corpus epoch installation and repair", () => {
	it("publishes trigger repairs in one commit, not partially to another WAL reader", () => {
		// Arrange: readers see the damaged schema throughout the repair transaction.
		writer.exec("DROP TRIGGER vector_corpus_epoch_update");
		const damaged = readVectorCorpusFence(writer);
		const observations: ReturnType<typeof readVectorCorpusFence>[] = [];
		const exec = db.exec.bind(db);
		vi.spyOn(db, "exec").mockImplementation((sql) => {
			const result = exec(sql);
			observations.push(readVectorCorpusFence(writer));
			return result;
		});
		// Act
		ensureVectorCorpusEpoch(db);
		// Assert: each intermediate DDL is invisible outside the immediate transaction.
		expect(observations.length).toBeGreaterThan(3);
		expect(observations.every((fence) => JSON.stringify(fence) === JSON.stringify(damaged))).toBe(
			true,
		);
		expect(readVectorCorpusFence(writer).epoch).not.toBeNull();
	});

	it.each(["missing", "outdated", "missing-row"])(
		"repairs %s guards atomically and remains idempotent",
		(damage) => {
			// Arrange: stale triggers must never be accepted as current.
			const before = Number(readVectorCorpusFence(db).epoch);
			if (damage === "missing-row") writer.exec("DELETE FROM vector_corpus_epoch");
			else {
				writer.exec("DROP TRIGGER vector_corpus_epoch_update");
				if (damage === "outdated")
					writer.exec(
						"CREATE TRIGGER vector_corpus_epoch_update AFTER UPDATE ON memory_items BEGIN SELECT 1; END",
					);
			}
			expect(readVectorCorpusFence(db).epoch).toBeNull();
			// Act
			ensureVectorCorpusEpoch(db);
			const repaired = readVectorCorpusFence(db);
			ensureVectorCorpusEpoch(db);
			writer.exec("UPDATE memory_items SET body_text = 'after repair'");
			// Assert: a repaired fence is valid, and a second install performs no DDL/write.
			expect(repaired.epoch).not.toBeNull();
			if (damage !== "missing-row") expect(Number(repaired.epoch)).toBeGreaterThan(before);
			expect(readVectorCorpusFence(db)).toEqual({
				...repaired,
				epoch: String(Number(repaired.epoch) + 1),
			});
			expect(
				db
					.prepare(
						"SELECT DISTINCT tbl_name FROM sqlite_schema WHERE name LIKE 'vector_corpus_epoch_%'",
					)
					.pluck()
					.all(),
			).toEqual(["memory_items"]);
		},
	);
});

describe("vector corpus epoch fallback and bootstrap", () => {
	it.each(["readonly", "query-only", "locked"])(
		"leaves a missing fence conservative on a %s handle",
		(mode) => {
			// Arrange: installation must not leave a partial table or triggers behind.
			writer.exec(
				"DROP TRIGGER vector_corpus_epoch_insert; DROP TRIGGER vector_corpus_epoch_delete; DROP TRIGGER vector_corpus_epoch_update; DROP TABLE vector_corpus_epoch",
			);
			const reader =
				mode === "readonly"
					? new Database(join(directory, "synthetic.sqlite"), { readonly: true })
					: db;
			if (mode === "query-only") db.pragma("query_only = ON");
			if (mode === "locked") {
				db.pragma("busy_timeout = 0");
				writer.exec("BEGIN IMMEDIATE");
			}
			const before = readVectorCorpusFence(reader);
			try {
				// Act
				ensureVectorCorpusEpoch(reader);
				// Assert
				expect(readVectorCorpusFence(reader)).toEqual({ ...before, epoch: null });
				expect(
					reader
						.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'vector_corpus_epoch%'")
						.all(),
				).toEqual([]);
			} finally {
				if (mode === "locked") writer.exec("ROLLBACK");
				if (reader !== db) reader.close();
			}
		},
	);

	it("keeps minimal schemas usable without claiming a corpus fence", () => {
		// Arrange
		const minimal = new Database(":memory:");
		minimal.exec("CREATE TABLE memory_items(id INTEGER PRIMARY KEY)");
		try {
			// Act
			ensureVectorCorpusEpoch(minimal);
			// Assert
			expect(readVectorCorpusFence(minimal).epoch).toBeNull();
			expect(
				minimal
					.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'vector_corpus_epoch%'")
					.all(),
			).toEqual([]);
		} finally {
			minimal.close();
		}
	});

	it("installs at bootstrap and repairs after the current compatibility marker", () => {
		// Arrange: a fresh schema and an already-current additive compatibility marker.
		const fresh = new Database(":memory:");
		try {
			initTestSchema(fresh);
			expect(readVectorCorpusFence(fresh).epoch).not.toBeNull();
			ensureAdditiveSchemaCompatibility(fresh);
			fresh.exec("DROP TRIGGER vector_corpus_epoch_delete");
			// Act
			ensureAdditiveSchemaCompatibility(fresh);
			const repaired = readVectorCorpusFence(fresh);
			ensureAdditiveSchemaCompatibility(fresh);
			// Assert
			expect(repaired.epoch).not.toBeNull();
			expect(readVectorCorpusFence(fresh)).toEqual(repaired);
		} finally {
			fresh.close();
		}
	});
});
