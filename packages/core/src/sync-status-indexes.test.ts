import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureAdditiveSchemaCompatibility, SCHEMA_VERSION } from "./db.js";
import { ensureSyncStatusIndexes } from "./sync-status-indexes.js";
import { initTestSchema } from "./test-utils.js";

const MEMORY_INDEX = "idx_memory_items_embeddable_active";
const OPS_INDEX = "idx_replication_ops_type_device_created";
const EMBEDDABLE_COUNT_SQL = `SELECT COUNT(*) AS c FROM memory_items
	WHERE active = 1 AND TRIM(COALESCE(title, '') || COALESCE(body_text, '')) != ''`;
const CLEANUP_COUNTS_SQL = `SELECT
	SUM(CASE WHEN device_id = ? THEN 1 ELSE 0 END) AS source_authored,
	SUM(CASE WHEN device_id != ? THEN 1 ELSE 0 END) AS applied,
	MAX(created_at) AS latest_at
	FROM replication_ops WHERE op_type = ?`;

let db: Database.Database;
beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});
afterEach(() => {
	vi.restoreAllMocks();
	db.close();
});

function schemaState() {
	return {
		version: db.pragma("user_version", { simple: true }),
		schema: db.pragma("schema_version", { simple: true }),
		changes: db.prepare("SELECT total_changes() AS n").get(),
		marker: db.prepare("SELECT * FROM schema_compat_state").all(),
	};
}

function hasIndex(target: Database.Database, name: string) {
	return !!target
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
		.get(name);
}

function dropStatusIndexes() {
	db.exec(`DROP INDEX IF EXISTS ${MEMORY_INDEX}; DROP INDEX IF EXISTS ${OPS_INDEX}`);
}

// Nullable legacy columns exercise COALESCE and SQL NULL semantics without
// weakening the required columns in the production schema.
function createCountFixture() {
	const fixture = new Database(":memory:");
	fixture.exec(`CREATE TABLE memory_items (
		id INTEGER PRIMARY KEY, active INTEGER, title TEXT, body_text TEXT
	);
	CREATE TABLE replication_ops (
		op_id TEXT PRIMARY KEY, op_type TEXT, device_id TEXT, created_at TEXT
	)`);
	return fixture;
}

function cleanupCounts(target: Database.Database) {
	return target.prepare(CLEANUP_COUNTS_SQL).get("local", "local", "access_cleanup");
}

it("installs both status indexes during bootstrap", () => {
	// Arrange: beforeEach bootstraps an empty database through the public test helper.
	const exec = vi.spyOn(db, "exec");
	// Act
	const indexes = [hasIndex(db, MEMORY_INDEX), hasIndex(db, OPS_INDEX)];
	ensureSyncStatusIndexes(db);
	ensureSyncStatusIndexes(db);
	// Assert: later opens must not issue even CREATE INDEX IF NOT EXISTS.
	expect(indexes).toEqual([true, true]);
	expect(exec).not.toHaveBeenCalled();
});

it("upgrades a current-marker database without changing compatibility rows or user_version", () => {
	// Arrange: emulate compatibility completed before either derived index existed.
	ensureAdditiveSchemaCompatibility(db);
	dropStatusIndexes();
	const before = schemaState();
	// Act
	ensureAdditiveSchemaCompatibility(db);
	const installed = schemaState();
	ensureSyncStatusIndexes(db);
	ensureSyncStatusIndexes(db);
	// Assert
	expect([hasIndex(db, MEMORY_INDEX), hasIndex(db, OPS_INDEX)]).toEqual([true, true]);
	expect(installed).toMatchObject({
		version: SCHEMA_VERSION,
		marker: before.marker,
	});
	expect(installed.schema).not.toBe(before.schema);
	expect(schemaState()).toEqual(installed);
});

it("does not attempt DDL on a read-only connection even when both indexes are missing", () => {
	// Arrange
	dropStatusIndexes();
	const exec = vi.spyOn(db, "exec");
	const readonly = new Proxy(db, {
		get(original, key) {
			if (key === "readonly") return true;
			const value = Reflect.get(original, key, original);
			return typeof value === "function" ? value.bind(original) : value;
		},
	});
	// Act
	ensureSyncStatusIndexes(readonly);
	// Assert
	expect(exec).not.toHaveBeenCalled();
	expect([hasIndex(db, MEMORY_INDEX), hasIndex(db, OPS_INDEX)]).toEqual([false, false]);
});

it.each([
	"",
	"CREATE TABLE memory_items(id INTEGER)",
	"CREATE TABLE memory_items(id INTEGER, active INTEGER, title TEXT)",
	"CREATE TABLE replication_ops(op_type TEXT)",
	"CREATE TABLE replication_ops(op_type TEXT, device_id TEXT)",
])("leaves missing tables or partial legacy columns unchanged: %s", (ddl) => {
	// Arrange
	const partial = new Database(":memory:");
	try {
		if (ddl) partial.exec(ddl);
		const before = partial.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
		// Act
		expect(() => ensureSyncStatusIndexes(partial)).not.toThrow();
		// Assert
		expect(
			partial.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
		).toEqual(before);
	} finally {
		partial.close();
	}
});

it.each([MEMORY_INDEX, OPS_INDEX])("ensures %s when the other table is absent", (name) => {
	// Arrange
	const partial = new Database(":memory:");
	try {
		if (name === MEMORY_INDEX) {
			partial.exec(
				"CREATE TABLE memory_items(id INTEGER, active INTEGER, title TEXT, body_text TEXT)",
			);
		} else {
			partial.exec("CREATE TABLE replication_ops(op_type TEXT, device_id TEXT, created_at TEXT)");
		}
		// Act
		ensureSyncStatusIndexes(partial);
		// Assert
		expect(hasIndex(partial, name)).toBe(true);
	} finally {
		partial.close();
	}
});

it("preserves reads under query_only and retries index creation after writes resume", () => {
	// Arrange: use SQLite's real write rejection without locks or timing races.
	ensureAdditiveSchemaCompatibility(db);
	dropStatusIndexes();
	db.pragma("query_only = ON");
	const before = schemaState();
	// Act
	expect(() => ensureSyncStatusIndexes(db)).not.toThrow();
	const failed = schemaState();
	const absent = [hasIndex(db, MEMORY_INDEX), hasIndex(db, OPS_INDEX)];
	const readable = db.prepare(EMBEDDABLE_COUNT_SQL).get();
	db.pragma("query_only = OFF");
	ensureSyncStatusIndexes(db);
	// Assert
	expect(failed).toEqual(before);
	expect(absent).toEqual([false, false]);
	expect(readable).toEqual({ c: 0 });
	expect(cleanupCounts(db)).toEqual({ source_authored: null, applied: null, latest_at: null });
	expect([hasIndex(db, MEMORY_INDEX), hasIndex(db, OPS_INDEX)]).toEqual([true, true]);
});

it.each([MEMORY_INDEX, OPS_INDEX])(
	"retries a locked %s creation without preventing the other index",
	(failedIndex) => {
		// Arrange: inject only the named DDL failure so order cannot hide the other ensure.
		dropStatusIndexes();
		const originalExec = db.exec.bind(db);
		const exec = vi.spyOn(db, "exec").mockImplementation((sql) => {
			if (sql.includes(failedIndex)) throw new Error("database is locked");
			return originalExec(sql);
		});
		const otherIndex = failedIndex === MEMORY_INDEX ? OPS_INDEX : MEMORY_INDEX;
		// Act
		expect(() => ensureSyncStatusIndexes(db)).not.toThrow();
		const failed = hasIndex(db, failedIndex);
		const other = hasIndex(db, otherIndex);
		const readable = db.prepare(EMBEDDABLE_COUNT_SQL).get();
		exec.mockRestore();
		ensureSyncStatusIndexes(db);
		// Assert
		expect(failed).toBe(false);
		expect(other).toBe(true);
		expect(readable).toEqual({ c: 0 });
		expect(hasIndex(db, failedIndex)).toBe(true);
	},
);

it("preserves exact active, blank, title, body, and NULL count semantics", () => {
	// Arrange
	const fixture = createCountFixture();
	try {
		fixture.exec(`INSERT INTO memory_items(active, title, body_text) VALUES
			(1, 'title', ''), (1, '', 'body'), (1, NULL, 'body'),
			(1, 'title', NULL), (1, '', ''), (1, '  ', ' '),
			(1, NULL, NULL), (0, 'inactive', 'body'), (2, 'non-one', 'body'),
			(-1, 'negative', ''), (NULL, 'null-active', ''), (1, '', char(9))`);
		const before = fixture.prepare(EMBEDDABLE_COUNT_SQL).get();
		// Act
		ensureSyncStatusIndexes(fixture);
		const after = fixture.prepare(EMBEDDABLE_COUNT_SQL).get();
		const plan = fixture.prepare(`EXPLAIN QUERY PLAN ${EMBEDDABLE_COUNT_SQL}`).all();
		// Assert: SQLite TRIM removes spaces by default, but does not remove tabs.
		expect(before).toEqual({ c: 5 });
		expect(after).toEqual(before);
		expect(plan).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ detail: expect.stringContaining(MEMORY_INDEX) }),
			]),
		);
	} finally {
		fixture.close();
	}
});

it("prefers the searchable partial index over an active/created index without ANALYZE", () => {
	// Arrange: a row-id-only partial index loses to the existing active lookup.
	const fixture = createCountFixture();
	try {
		fixture.exec(`ALTER TABLE memory_items ADD COLUMN created_at TEXT;
			CREATE INDEX idx_memory_items_active_created ON memory_items(active, created_at);
			WITH RECURSIVE rows(id) AS (
				SELECT 1 UNION ALL SELECT id + 1 FROM rows WHERE id < 1000
			)
			INSERT INTO memory_items(id, active, title, body_text, created_at)
			SELECT id, id % 2, CASE WHEN id % 3 = 0 THEN '' ELSE 'title' END,
				'', '2026-01-01' FROM rows;
			CREATE INDEX ${MEMORY_INDEX} ON memory_items(id)
			WHERE active = 1 AND TRIM(COALESCE(title, '') || COALESCE(body_text, '')) != ''`);
		const oldPlan = fixture.prepare(`EXPLAIN QUERY PLAN ${EMBEDDABLE_COUNT_SQL}`).all();
		fixture.exec(`DROP INDEX ${MEMORY_INDEX}`);
		// Act
		ensureSyncStatusIndexes(fixture);
		const plan = fixture.prepare(`EXPLAIN QUERY PLAN ${EMBEDDABLE_COUNT_SQL}`).all();
		const index = fixture
			.prepare("SELECT sql FROM sqlite_master WHERE name = ?")
			.get(MEMORY_INDEX) as {
			sql: string;
		};
		// Assert: both plans use default planner estimates, with no hints or statistics.
		expect(oldPlan).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					detail: "SEARCH memory_items USING INDEX idx_memory_items_active_created (active=?)",
				}),
			]),
		);
		expect(plan).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					detail: `SEARCH memory_items USING INDEX ${MEMORY_INDEX} (active=?)`,
				}),
			]),
		);
		expect(index.sql).toMatch(/ON memory_items\(active\)/);
	} finally {
		fixture.close();
	}
});

it("reflects memory insertion, edits, deactivation, reactivation, and deletion without re-ensuring", () => {
	// Arrange
	const fixture = createCountFixture();
	try {
		ensureSyncStatusIndexes(fixture);
		const count = () => fixture.prepare(EMBEDDABLE_COUNT_SQL).get();
		const counts = [count()];
		// Act
		fixture.exec("INSERT INTO memory_items VALUES (1, 1, 'title', '')");
		counts.push(count());
		fixture.exec("UPDATE memory_items SET title = ' ', body_text = NULL WHERE id = 1");
		counts.push(count());
		fixture.exec("UPDATE memory_items SET body_text = 'body' WHERE id = 1");
		counts.push(count());
		fixture.exec("UPDATE memory_items SET active = 0 WHERE id = 1");
		counts.push(count());
		fixture.exec("UPDATE memory_items SET active = 1 WHERE id = 1");
		counts.push(count());
		fixture.exec("DELETE FROM memory_items WHERE id = 1");
		counts.push(count());
		// Assert
		expect(counts).toEqual([0, 1, 0, 1, 0, 1, 0].map((c) => ({ c })));
	} finally {
		fixture.close();
	}
});

it("counts only cleanup operations and uses a covering index for authored/applied diagnostics", () => {
	// Arrange
	const fixture = createCountFixture();
	try {
		fixture.exec(`INSERT INTO replication_ops VALUES
			('a', 'access_cleanup', 'local', '2026-01-01'),
			('b', 'access_cleanup', 'peer', '2026-01-02'),
			('c', 'access_cleanup', 'peer', '2026-01-03'),
			('d', 'upsert', 'local', '2026-12-31'),
			('e', 'access_cleanup', NULL, '2026-01-04')`);
		const before = cleanupCounts(fixture);
		// Act
		ensureSyncStatusIndexes(fixture);
		const after = cleanupCounts(fixture);
		const plan = fixture
			.prepare(`EXPLAIN QUERY PLAN ${CLEANUP_COUNTS_SQL}`)
			.all("local", "local", "access_cleanup");
		// Assert: a NULL device contributes to latest_at but neither SUM branch.
		expect(before).toEqual({ source_authored: 1, applied: 2, latest_at: "2026-01-04" });
		expect(after).toEqual(before);
		expect(plan).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					detail: expect.stringContaining(`COVERING INDEX ${OPS_INDEX}`),
				}),
			]),
		);
	} finally {
		fixture.close();
	}
});

it("preserves NULL empty sums and reflects cleanup updates and deletes without re-ensuring", () => {
	// Arrange
	const fixture = createCountFixture();
	try {
		ensureSyncStatusIndexes(fixture);
		fixture.exec("INSERT INTO replication_ops VALUES ('other', 'upsert', 'local', '2026-12-31')");
		const results = [cleanupCounts(fixture)];
		// Act
		fixture.exec(
			"INSERT INTO replication_ops VALUES ('a', 'access_cleanup', 'local', '2026-01-01')",
		);
		results.push(cleanupCounts(fixture));
		fixture.exec(
			"UPDATE replication_ops SET device_id = 'peer', created_at = '2026-01-02' WHERE op_id = 'a'",
		);
		results.push(cleanupCounts(fixture));
		fixture.exec("UPDATE replication_ops SET op_type = 'upsert' WHERE op_id = 'a'");
		results.push(cleanupCounts(fixture));
		fixture.exec("UPDATE replication_ops SET op_type = 'access_cleanup' WHERE op_id = 'a'");
		fixture.exec("DELETE FROM replication_ops WHERE op_id = 'a'");
		results.push(cleanupCounts(fixture));
		// Assert: unrelated rows must not turn an empty cleanup SUM into zero.
		const empty = { source_authored: null, applied: null, latest_at: null };
		expect(results).toEqual([
			empty,
			{ source_authored: 1, applied: 0, latest_at: "2026-01-01" },
			{ source_authored: 0, applied: 1, latest_at: "2026-01-02" },
			empty,
			empty,
		]);
	} finally {
		fixture.close();
	}
});
