import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { COORDINATOR_DEVICE_OWNERSHIP_SCHEMA_SQL } from "./coordinator-device-ownership-schema.js";

const dirs: string[] = [];
const stores: BetterSqliteCoordinatorStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The first release's collision trigger, which ignored rowid. */
const OLD_SCHEMA_SQL = COORDINATOR_DEVICE_OWNERSHIP_SCHEMA_SQL.replace(
	"WHERE rowid = NEW.rowid OR device_id = NEW.device_id",
	"WHERE device_id = NEW.device_id",
).replace(/-- An automatic rowid[\s\S]*?END;\n/, "");

const binding = (suffix: string) => [
	`device-${suffix}`,
	suffix.repeat(64).slice(0, 64),
	`identity-${suffix}`,
	"coordinator-a",
	`binding-${suffix}`,
	"owner_enrollment",
	`rebind:${suffix}`,
	"2026-10-26T00:00:00Z",
];
const INSERT = `INTO coordinator_device_ownership_bindings (device_id, key_id, identity_id, coordinator_id,
 binding_id, provenance, source_ref, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

function open(setup?: (db: Database.Database) => void) {
	const dir = mkdtempSync(join(tmpdir(), "ownership-rowid-"));
	dirs.push(dir);
	const path = join(dir, "coordinator.sqlite");
	if (setup) {
		const db = new Database(path);
		setup(db);
		db.close();
	}
	const store = new BetterSqliteCoordinatorStore(path);
	stores.push(store);
	return store.db;
}

const bindings = (db: Database.Database) =>
	db.prepare("SELECT rowid, device_id FROM coordinator_device_ownership_bindings").all();

describe("device ownership bindings stay durable", () => {
	it("rejects a REPLACE that reuses a binding's rowid with fresh keys", () => {
		// Arrange
		const db = open();
		db.prepare(`INSERT ${INSERT}`).run(...binding("a"));
		const rowid = db
			.prepare("SELECT rowid FROM coordinator_device_ownership_bindings")
			.pluck()
			.get();
		// Act / Assert
		expect(() =>
			db
				.prepare(`INSERT OR REPLACE INTO coordinator_device_ownership_bindings (rowid, device_id, key_id,
				 identity_id, coordinator_id, binding_id, provenance, source_ref, bound_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(rowid, ...binding("b")),
		).toThrow("device_ownership_collision");
		expect(bindings(db)).toEqual([{ rowid, device_id: "device-a" }]);
	});

	it("rejects a non-positive rowid", () => {
		const db = open();
		expect(() =>
			db
				.prepare(`INSERT INTO coordinator_device_ownership_bindings (rowid, device_id, key_id,
				 identity_id, coordinator_id, binding_id, provenance, source_ref, bound_at)
				 VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(...binding("c")),
		).toThrow("device_ownership_rowid");
	});

	it("upgrades an earlier install's trigger on open and keeps its bindings", () => {
		// The fixture must really be the old trigger, or this test proves nothing.
		expect(OLD_SCHEMA_SQL).not.toContain("rowid = NEW.rowid");
		// Arrange: an install from before the fix, with one binding.
		const db = open((old) => {
			old.exec(OLD_SCHEMA_SQL);
			old.prepare(`INSERT ${INSERT}`).run(...binding("a"));
		});
		// Act / Assert
		expect(bindings(db)).toEqual([{ rowid: 1, device_id: "device-a" }]);
		expect(() =>
			db
				.prepare(`INSERT OR REPLACE INTO coordinator_device_ownership_bindings (rowid, device_id, key_id,
				 identity_id, coordinator_id, binding_id, provenance, source_ref, bound_at)
				 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.run(...binding("b")),
		).toThrow("device_ownership_collision");
	});
});
