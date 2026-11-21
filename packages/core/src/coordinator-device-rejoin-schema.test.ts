import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { initializeBaseSchema } from "./better-sqlite-coordinator-store.js";
import {
	DEVICE_REJOIN_MIGRATION_NAME,
	DEVICE_REJOIN_SCHEMA_SQL,
	DEVICE_REJOIN_STORAGE_PRESENT_SQL,
} from "./coordinator-device-rejoin-schema.js";
import {
	checkFinalizedRejoinStorage,
	checkRejoinAttemptStorage,
	storeFinalizedRejoinFixture,
} from "./coordinator-device-rejoin-schema-test-harness.js";

const worker = new URL("../../cloudflare-coordinator-worker/", import.meta.url);
const migration = () =>
	readFileSync(new URL(`migrations/${DEVICE_REJOIN_MIGRATION_NAME}`, worker), "utf8");
let db: Database.Database;
beforeEach(() => {
	db = new Database(":memory:");
});
afterEach(() => db.close());

const fixture = () => ({
	run: async (sql: string, ...values: (string | number)[]) => db.prepare(sql).run(...values),
	rows: async (sql: string) => db.prepare(sql).all(),
});

it("ships the same SQL in SQLite, migration 0051, and the Worker schema", () => {
	expect(migration().trim()).toBe(DEVICE_REJOIN_SCHEMA_SQL.trim());
	expect(readFileSync(new URL("schema.sql", worker), "utf8")).toContain(
		DEVICE_REJOIN_SCHEMA_SQL.trim(),
	);
});

it("installs rejoin storage on fresh SQLite and refuses duplicate attempts without replacing them", async () => {
	initializeBaseSchema(db);
	await checkRejoinAttemptStorage(fixture());
});

it("keeps receipts and the append-only audit when initializing SQLite again", async () => {
	initializeBaseSchema(db);
	await storeFinalizedRejoinFixture(fixture());
	initializeBaseSchema(db);
	await checkFinalizedRejoinStorage(fixture());
});

it("adds storage to an existing SQLite coordinator without changing earlier schema objects or rows", () => {
	initializeBaseSchema(db);
	db.exec(`DROP TABLE coordinator_device_rejoin_audit_log;
		DROP TABLE coordinator_device_rejoin_attempts;
		INSERT INTO groups(group_id, created_at) VALUES ('prior-group', 'fixture-time');
		INSERT INTO coordinator_device_removals(removal_id, group_id, device_id, public_key, fingerprint, removed_at)
		VALUES ('prior-removal', 'prior-group', 'prior-device', 'prior-key', 'prior-fingerprint', 'fixture-time');`);
	const snapshot = () => ({
		schema: db
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE name NOT LIKE '%device_rejoin%' ORDER BY name",
			)
			.all(),
		groups: db.prepare("SELECT * FROM groups").all(),
		removals: db.prepare("SELECT * FROM coordinator_device_removals").all(),
	});
	const before = snapshot();
	expect(db.prepare(DEVICE_REJOIN_STORAGE_PRESENT_SQL).pluck().get()).toBe(0);
	expect(snapshot()).toEqual(before);
	initializeBaseSchema(db);
	expect(db.prepare(DEVICE_REJOIN_STORAGE_PRESENT_SQL).pluck().get()).toBe(1);
	expect(snapshot()).toEqual(before);
});
