import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
	BetterSqliteCoordinatorStore,
	connectCoordinator,
} from "./better-sqlite-coordinator-store.js";
import { COORDINATOR_DEVICE_OWNERSHIP_SCHEMA_SQL } from "./coordinator-device-ownership-schema.js";
import {
	insertOwnership,
	OWNERSHIP_TABLE,
	ownedRow,
	ownershipColumns,
	ownershipHarness,
	registerOwnershipContract,
} from "./coordinator-device-ownership-test-harness.js";

const workerPath = join(import.meta.dirname, "../../cloudflare-coordinator-worker");
const freshSql = readFileSync(join(workerPath, "schema.sql"), "utf8");
const migration = readFileSync(
	join(workerPath, "migrations/0028_add_device_ownership_bindings.sql"),
	"utf8",
);
function schema(db: SqliteDatabase) {
	return {
		columns: db.pragma(`table_info(${OWNERSHIP_TABLE})`),
		foreignKeys: db.pragma(`foreign_key_list(${OWNERSHIP_TABLE})`),
		ddl: db
			.prepare(
				"SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type, name",
			)
			.all(OWNERSHIP_TABLE)
			.map((row) => {
				const entry = row as { type: string; sql: string };
				return { type: entry.type, sql: entry.sql.replace(/\s+/gu, " ").trim() };
			}),
		unique: (
			db.pragma(`index_list(${OWNERSHIP_TABLE})`) as {
				name: string;
				unique: number;
				partial: number;
			}[]
		)
			.filter((index) => index.unique === 1)
			.map((index) => ({
				columns: db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name),
				partial: index.partial,
			}))
			.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
	};
}
describe("SQLite device ownership schema foundation", () => {
	const test = ownershipHarness(async (use) => {
		const store = new BetterSqliteCoordinatorStore(":memory:");
		const db = store.db;
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store,
				exec: async (sql, ...values) => {
					db.prepare(sql).run(...values);
				},
				query: async (sql, ...values) => db.prepare(sql).all(...values),
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			db.close();
		}
	});
	registerOwnershipContract(test);
	it("shared initialization, Worker fresh schema and source-only migration match columns, CHECKs, unique indexes and triggers", () => {
		// Arrange
		const db = connectCoordinator(":memory:");
		const fresh = new Database(":memory:");
		const migrated = new Database(":memory:");
		try {
			// Act
			fresh.exec(freshSql);
			migrated.exec(migration);
			migrated.exec(migration);
			const actual = schema(db);
			// Assert
			expect(actual).toEqual(schema(fresh));
			expect(actual).toEqual(schema(migrated));
			expect(actual.columns).toEqual(
				ownershipColumns.map((name, cid) => ({
					cid,
					name,
					type: "TEXT",
					notnull: 1,
					dflt_value: null,
					pk: name === "device_id" ? 1 : 0,
				})),
			);
			expect(actual.foreignKeys).toEqual([]);
			expect(actual.unique).toEqual(
				["binding_id", "device_id", "key_id"].map((name) => ({ columns: [{ name }], partial: 0 })),
			);
			expect(actual.ddl.filter((entry) => entry.type === "trigger")).toHaveLength(3);
		} finally {
			db.close();
			fresh.close();
			migrated.close();
		}
	});
	it("local migration preserves legacy rows and leaves the ledger empty without backfill", () => {
		// Arrange: remove only this new DDL from a local fixture to model the old schema.
		const db = new Database(":memory:");
		try {
			db.exec(freshSql);
			db.exec(`DROP TABLE ${OWNERSHIP_TABLE}`);
			db.prepare("INSERT INTO groups (group_id, created_at) VALUES (?, ?)").run(
				"legacy-group",
				"2026-10-07",
			);
			db.prepare(
				"INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)",
			).run("legacy-group", "legacy-device", "legacy-key-hint", "legacy-fingerprint", "2026-10-07");
			const before = db.prepare("SELECT * FROM enrolled_devices").all();
			// Act
			db.exec(migration);
			db.exec(migration);
			db.exec(COORDINATOR_DEVICE_OWNERSHIP_SCHEMA_SQL);
			// Assert
			expect(db.prepare(`SELECT * FROM ${OWNERSHIP_TABLE}`).all()).toEqual([]);
			expect(db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
			expect(db.prepare("SELECT group_id FROM groups").all()).toEqual([
				{ group_id: "legacy-group" },
			]);
		} finally {
			db.close();
		}
	});
	it("reopening SQLite retains bindings and initialization cannot overwrite them", async () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "ownership-fixture-"));
		const path = join(directory, "coordinator.sqlite");
		const store = new BetterSqliteCoordinatorStore(path);
		let db = store.db;
		try {
			await insertOwnership({
				store,
				exec: async (sql, ...values) => {
					db.prepare(sql).run(...values);
				},
				query: async (sql) => db.prepare(sql).all(),
			});
			db.close();
			// Act
			db = connectCoordinator(path);
			// Assert
			expect(db.prepare(`SELECT * FROM ${OWNERSHIP_TABLE}`).all()).toEqual([ownedRow]);
			expect(() => db.prepare(`DELETE FROM ${OWNERSHIP_TABLE}`).run()).toThrow(
				/device_ownership_immutable/,
			);
		} finally {
			db.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
