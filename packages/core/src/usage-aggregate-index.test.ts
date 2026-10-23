import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, ensureAdditiveSchemaCompatibility, SCHEMA_VERSION } from "./db.js";
import { bootstrapSchema } from "./schema-bootstrap.js";
import { MemoryStore } from "./store.js";
import { ensureUsageEventsAggregateIndex } from "./usage-aggregate-index.js";

vi.mock("./observer-config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./observer-config.js")>()),
	readCodememConfigFile: () => ({}),
}));

const INDEX = "idx_usage_events_public_aggregate_cover";
const NOW = "2026-04-01T00:00:00.000Z";
const INDEX_QUERY = "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?";
const INDEX_COLUMNS =
	"event metadata_json tokens_read tokens_written tokens_saved session_id".split(" ");
let directory: string;
let store: MemoryStore | undefined;
const connections: Database.Database[] = [];

function track(db: Database.Database) {
	connections.push(db);
	return db;
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-usage-index-"));
	vi.stubEnv("CODEMEM_DEVICE_ID", "fixture-device");
	vi.stubEnv("CODEMEM_ACTOR_ID", "fixture-actor");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const db of connections.splice(0).reverse()) db.close();
	store?.close();
	store = undefined;
	rmSync(directory, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

function captureGlobalAggregate() {
	const dbPath = join(directory, "test.sqlite");
	const setup = connect(dbPath);
	bootstrapSchema(setup);
	setup.close();
	store = new MemoryStore(dbPath, {
		keysDir: join(directory, "keys"),
		runtimeSigningKey: { deviceId: "fixture-device", publicKey: "fixture-public-key" },
	});
	const db = store.db;
	for (const [event, metadata] of [
		["observer_call", '{"token_usage":{"source":"provider"}}'],
		["observer_call", "{}"],
		["pack", "{broken"],
		["observer_recovery_scope_denial", "{}"],
		["observer_recovery_call_clock:batch-1", "{}"],
	]) {
		db.prepare(`INSERT INTO usage_events(event, metadata_json, tokens_read, tokens_written, tokens_saved, created_at)
			VALUES (?, ?, 11, 7, 3, ?)`).run(event, metadata, NOW);
	}
	const captured: { sql: string; bindings: unknown[] }[] = [];
	const prepare = db.prepare.bind(db);
	const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);
		if (!sql.includes("AS usage_source")) return statement;
		const call = { sql, bindings: [] as unknown[] };
		captured.push(call);
		const all = statement.all.bind(statement);
		vi.spyOn(statement, "all").mockImplementation((...bindings: unknown[]) => {
			call.bindings = bindings;
			return all(...bindings);
		});
		return statement;
	});
	const rows = store.classifiedUsageAggregate();
	spy.mockRestore();
	expect(captured).toHaveLength(1);
	const query = captured[0];
	if (!query) throw new Error("production aggregate SQL was not captured");
	return { db, rows, ...query };
}

describe("public usage covering index installation", () => {
	it.each(["fresh bootstrap", "current compatibility marker"])(
		"installs the index for %s",
		(mode) => {
			// Arrange: the current marker must not suppress this additive index repair.
			const db = track(connect(join(directory, "test.sqlite")));
			bootstrapSchema(db);
			if (mode === "current compatibility marker") {
				db.exec(`DROP INDEX IF EXISTS ${INDEX};
					CREATE TABLE IF NOT EXISTS schema_compat_state (
					id INTEGER PRIMARY KEY, applied_schema_version INTEGER NOT NULL, applied_at TEXT NOT NULL)`);
				db.prepare("INSERT OR REPLACE INTO schema_compat_state VALUES (1, ?, ?)").run(
					SCHEMA_VERSION,
					NOW,
				);
			}
			// Act
			if (mode === "current compatibility marker") ensureAdditiveSchemaCompatibility(db);
			const index = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
				.get(INDEX);
			// Assert: both new databases and already-upgraded databases gain the index.
			expect(index).toEqual({ name: INDEX });
		},
	);
});

describe("production public usage access path", () => {
	it("uses the covering index for the unmodified global aggregate", () => {
		// Arrange: capture the actual store statement and actual bound parameters.
		const { db, sql, bindings } = captureGlobalAggregate();
		// Act
		const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as { detail: string }[];
		// Assert: do not depend on planner node IDs or opcode offsets.
		expect(bindings).toEqual([]);
		expect(plan.some(({ detail }) => detail.includes(`USING COVERING INDEX ${INDEX}`))).toBe(true);
	});

	it("does not evaluate JSON or read base-table columns/rowids in global bytecode", () => {
		// Arrange
		const { db, sql, bindings } = captureGlobalAggregate();
		const table = db
			.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'")
			.get() as { rootpage: number };
		// Act
		const code = db.prepare(`EXPLAIN ${sql}`).all(...bindings) as {
			opcode: string;
			p1: number;
			p2: number;
			p3: number;
			p4: string | null;
		}[];
		// Assert: opening/defer-opening the table is allowed; reading its values is not.
		const tableCursors = new Set(
			code
				.filter((op) => op.opcode === "OpenRead" && op.p2 === table.rootpage && op.p3 === 0)
				.map((op) => op.p1),
		);
		expect
			.soft(
				code.filter(
					(op) => op.opcode.includes("Function") && /json_(valid|extract)\(/i.test(op.p4 ?? ""),
				),
			)
			.toHaveLength(0);
		expect
			.soft(code.filter((op) => ["Column", "Rowid"].includes(op.opcode) && tableCursors.has(op.p1)))
			.toHaveLength(0);
	});

	it("retains baseline classification, tokens and public-event exclusions", () => {
		// Arrange
		const common = {
			tokens_read: 11,
			tokens_written: 7,
			token_unit: "tokens",
			unavailable_count: 0,
			legacy_unclassified_count: 0,
		};
		const expected = [
			{
				...common,
				event: "observer_call",
				count: 2,
				tokens_saved: 6,
				measured_count: 1,
				estimated_count: 0,
				legacy_text_length_count: 1,
			},
			{
				...common,
				event: "pack",
				count: 1,
				tokens_saved: 3,
				measured_count: 0,
				estimated_count: 1,
				legacy_text_length_count: 0,
			},
		];
		// Act
		const { rows } = captureGlobalAggregate();
		// Assert: the separate 41-case suite also checks the frozen baseline SQL.
		expect(rows.toSorted((a, b) => a.event.localeCompare(b.event))).toEqual(expected);
	});
});

describe("optional usage index lifecycle", () => {
	it("repairs a removed index on the next current-marker open without repeating CREATE", () => {
		// Arrange: MemoryStore already wrote the current compatibility marker.
		const { db } = captureGlobalAggregate();
		db.exec(`DROP INDEX ${INDEX}`);
		const reopened = track(connect(db.name));
		const exec = vi.spyOn(reopened, "exec");
		// Act: repair on reopen, then repeat the helper and compatibility entrypoint.
		ensureAdditiveSchemaCompatibility(reopened);
		ensureUsageEventsAggregateIndex(reopened);
		ensureAdditiveSchemaCompatibility(reopened);
		// Assert
		expect(reopened.prepare(INDEX_QUERY).get(INDEX)).toEqual({ name: INDEX });
		expect(
			exec.mock.calls.filter(([sql]) => sql.includes(`CREATE INDEX IF NOT EXISTS ${INDEX}`)),
		).toHaveLength(1);
	});

	it.each(["readonly", "query_only"])(
		"keeps normal aggregate reads working when %s prevents installation",
		(mode) => {
			// Arrange
			const { db, sql, bindings, rows } = captureGlobalAggregate();
			db.exec(`DROP INDEX ${INDEX}`);
			const fallback = track(new Database(db.name, { readonly: mode === "readonly" }));
			if (mode === "query_only") fallback.pragma("query_only = ON");
			const exec = vi.spyOn(fallback, "exec");
			// Act: failed optional installation must not escape or mutate the schema.
			ensureUsageEventsAggregateIndex(fallback);
			const actual = fallback.prepare(sql).all(...bindings);
			// Assert
			expect(fallback.readonly).toBe(mode === "readonly");
			expect(fallback.prepare(INDEX_QUERY).get(INDEX)).toBeUndefined();
			expect(actual).toEqual(rows.map(({ token_unit: _unit, ...row }) => row));
			if (mode === "readonly") expect(exec).not.toHaveBeenCalled();
		},
	);

	it.each([null, ...INDEX_COLUMNS])("skips missing table/column %s without throwing", (missing) => {
		// Arrange: no application schema or application-defined SQL functions.
		const db = track(new Database(":memory:"));
		if (missing)
			db.exec(
				`CREATE TABLE usage_events (${INDEX_COLUMNS.filter((column) => column !== missing).join(", ")})`,
			);
		// Act
		ensureUsageEventsAggregateIndex(db);
		// Assert
		expect(db.prepare(INDEX_QUERY).get(INDEX)).toBeUndefined();
	});

	it("fails open under a real write lock and retries after the lock is released", () => {
		// Arrange: SQLite returns BUSY immediately rather than relying on timing.
		const { db } = captureGlobalAggregate();
		db.exec(`DROP INDEX ${INDEX}`);
		db.pragma("busy_timeout = 0");
		const locker = track(new Database(db.name));
		locker.exec("BEGIN IMMEDIATE");
		// Act
		ensureUsageEventsAggregateIndex(db);
		const locked = db.prepare(INDEX_QUERY).get(INDEX);
		locker.exec("ROLLBACK");
		ensureUsageEventsAggregateIndex(db);
		// Assert
		expect(locked).toBeUndefined();
		expect(db.prepare(INDEX_QUERY).get(INDEX)).toEqual({ name: INDEX });
	});
});

it("lets an unmodified native SQL writer maintain public/internal and source/token/session transitions", () => {
	// Arrange: the second connection never registers application SQL functions.
	const { db, sql, bindings } = captureGlobalAggregate();
	const writer = track(new Database(db.name));
	const baseline = db.prepare(sql.replace("FROM usage_events", "FROM usage_events NOT INDEXED"));
	const session = writer
		.prepare("INSERT INTO sessions(started_at, project) VALUES (?, ?)")
		.run(NOW, "fixture-project").lastInsertRowid;
	const id = writer
		.prepare(
			"INSERT INTO usage_events(event, metadata_json, created_at) VALUES ('observer_recovery_scope_denial', '{}', ?)",
		)
		.run(NOW).lastInsertRowid;
	for (const [event, metadata, read] of [
		["observer_call", '{"token_usage":{"source":"provider"}}', 101],
		["observer_recovery_call_clock:batch-1", "{broken", 999],
		["observer_call", '{"token_usage":{"source":["provider"]}}', -13],
		["pack", "{}", 2 ** 40],
	]) {
		// Act: both predicate membership and indexed values change in place.
		writer
			.prepare(
				"UPDATE usage_events SET event = ?, metadata_json = ?, tokens_read = ?, tokens_written = ?, tokens_saved = ?, session_id = ? WHERE id = ?",
			)
			.run(event, metadata, read, read, read, session, id);
		// Assert: compare indexed execution to the same aggregate forced off indexes.
		expect(db.prepare(sql).all(...bindings)).toEqual(baseline.all(...bindings));
		expect(store?.usageAggregate("fixture-project").reduce((sum, row) => sum + row.count, 0)).toBe(
			Number(event !== "observer_recovery_call_clock:batch-1"),
		);
	}
});
