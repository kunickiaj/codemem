import type { Database as SqliteDatabase } from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import {
	AUTH_LIFECYCLE_PREDECESSOR_RECOGNITION_SQL,
	AUTH_LIFECYCLE_SQLITE_PREDECESSOR_RECOGNITION_SQL,
	AUTH_LIFECYCLE_SQLITE_TEMP_SCHEMA_CHECK_SQL,
} from "./coordinator-auth-lifecycle-recognition.js";

const links = "coordinator_auth_account_links";
const databases: SqliteDatabase[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function setup() {
	const db = connectCoordinator(":memory:");
	databases.push(db);
	db.exec(`INSERT INTO main.${links}
	 (coordinator_id, link_id, issuer, subject, identity_id, attempt_id,
	 controller_attestation_id, auth_config_revision, created_at_ms, authority_kind)
	 VALUES ('coordinator', 'link', 'https://accounts.google.com', 'subject',
	 'actor', 'attempt', 'attestation', '${"a".repeat(64)}', 10, 'controller_attestation')`);
	return db;
}
function recognize(db: SqliteDatabase) {
	return db.prepare(AUTH_LIFECYCLE_SQLITE_PREDECESSOR_RECOGNITION_SQL).get();
}
function snapshot(db: SqliteDatabase) {
	const objects = db.prepare("SELECT * FROM sqlite_temp_master ORDER BY type, name").all();
	const tables = db
		.prepare("SELECT name FROM sqlite_temp_master WHERE type = 'table' ORDER BY name")
		.all() as { name: string }[];
	return {
		main: db.serialize(),
		objects,
		// Test-only qualified reads inspect retained TEMP data, not migration inputs.
		tempRows: tables.map(({ name }) =>
			db.prepare(`SELECT * FROM temp."${name.replaceAll('"', '""')}"`).all(),
		),
	};
}

it("accepts a fresh SQLite operator connection with an empty TEMP namespace", () => {
	// Arrange
	const db = setup();
	const before = snapshot(db);
	// Act
	const clear = db
		.prepare(`SELECT (${AUTH_LIFECYCLE_SQLITE_TEMP_SCHEMA_CHECK_SQL}) AS clear`)
		.get();
	const recognized = recognize(db);
	// Assert
	expect(clear).toEqual({ clear: 1 });
	expect(recognized).toEqual({ recognized: 1 });
	expect(snapshot(db)).toEqual(before);
	expect(AUTH_LIFECYCLE_SQLITE_PREDECESSOR_RECOGNITION_SQL.length).toBeLessThan(100000);
});

it.each([
	`CREATE TEMP TABLE ${links} AS SELECT * FROM main.${links}`,
	"CREATE TEMP TABLE coordinator_auth_account_links_v3 (value TEXT); INSERT INTO temp.coordinator_auth_account_links_v3 VALUES ('retained')",
	`CREATE TEMP VIEW ${links} AS SELECT rowid, * FROM main.${links}`,
	`CREATE TEMP TRIGGER temp_link_observer AFTER INSERT ON main.${links} BEGIN SELECT count(*) FROM ${links}; END`,
	`CREATE TABLE unrelated_events (value TEXT); CREATE TEMP TRIGGER temp_external_observer AFTER INSERT ON main.unrelated_events BEGIN SELECT count(*) FROM ${links}; END`,
	"CREATE TEMP TABLE unrelated_scratch (value TEXT); INSERT INTO temp.unrelated_scratch VALUES ('retained')",
])("rejects TEMP objects without clearing objects or changing rows: %s", (sql) => {
	// Arrange: identical shadow columns allow preparation; rejection is not a parse error.
	const db = setup();
	db.exec(sql);
	const before = snapshot(db);
	// Act
	const portable = db.prepare(AUTH_LIFECYCLE_PREDECESSOR_RECOGNITION_SQL).get();
	const clear = db
		.prepare(`SELECT (${AUTH_LIFECYCLE_SQLITE_TEMP_SCHEMA_CHECK_SQL}) AS clear`)
		.get();
	const recognized = recognize(db);
	// Assert: the D1 predicate alone cannot enforce a connection-local SQLite policy.
	expect(portable).toEqual({ recognized: 1 });
	expect(clear).toEqual({ clear: 0 });
	expect(recognized).toEqual({ recognized: 0 });
	expect(snapshot(db)).toEqual(before);
});

it("short-circuits shadow-view row evaluation rather than reading TEMP auth rows", () => {
	// Arrange: returning unchanged bytes keeps the shadow shape valid for preparation.
	const db = setup();
	let reads = 0;
	db.function("observe_temp_subject", (value) => {
		reads++;
		return value;
	});
	const columns = db.pragma(`main.table_info(${links})`) as { name: string }[];
	const projection = columns
		.map(({ name }) => (name === "subject" ? "observe_temp_subject(subject) AS subject" : name))
		.join(",");
	db.exec(`CREATE TEMP VIEW ${links} AS SELECT rowid, ${projection} FROM main.${links}`);
	expect(db.prepare(AUTH_LIFECYCLE_PREDECESSOR_RECOGNITION_SQL).get()).toEqual({ recognized: 1 });
	expect(reads).toBeGreaterThan(0);
	reads = 0;
	const before = snapshot(db);
	// Act
	const recognized = recognize(db);
	// Assert
	expect(recognized).toEqual({ recognized: 0 });
	expect(reads).toBe(0);
	expect(snapshot(db)).toEqual(before);
});
