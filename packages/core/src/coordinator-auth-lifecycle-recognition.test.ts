import { readdirSync, readFileSync } from "node:fs";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import { AUTH_LIFECYCLE_PREDECESSOR_PREDICATE_SQL } from "./coordinator-auth-lifecycle-recognition.js";
import { AUTH_LINK_AUTHORITY_CUTOVER_SQL } from "./coordinator-auth-link-authority-upgrade.js";

const browser = "coordinator_auth_browser_transactions";
const links = "coordinator_auth_account_links";
const audit = "coordinator_auth_link_audit_log";
const hash = "a".repeat(64);
const databases: SqliteDatabase[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function setup(source: "inline" | "migrations" = "inline") {
	if (source === "inline") {
		const db = connectCoordinator(":memory:");
		databases.push(db);
		return db;
	}
	const db = new Database(":memory:");
	databases.push(db);
	const directory = new URL("../../cloudflare-coordinator-worker/migrations/", import.meta.url);
	for (const name of readdirSync(directory)
		.filter((name) => /^00(?:[0-2]\d|3[0-3])_.*\.sql$/u.test(name))
		.sort())
		db.exec(readFileSync(new URL(name, directory), "utf8"));
	db.exec(AUTH_LINK_AUTHORITY_CUTOVER_SQL);
	return db;
}
function recognize(db: SqliteDatabase) {
	return db.prepare(`SELECT (${AUTH_LIFECYCLE_PREDECESSOR_PREDICATE_SQL}) AS recognized`).get();
}
function insert(db: SqliteDatabase, table: string, row: Record<string, unknown>) {
	const columns = Object.keys(row);
	db.prepare(
		`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
	).run(...columns.map((key) => row[key]));
}
function rebuild(db: SqliteDatabase, table: string, change: (sql: string) => string) {
	const definitions = db
		.prepare(
			"SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type DESC",
		)
		.all(table) as { type: string; sql: string }[];
	const definition = definitions.find(({ type }) => type === "table");
	if (!definition) throw new Error("Missing table fixture");
	db.exec(`DROP TABLE ${table}`);
	db.exec(change(definition.sql));
	for (const entry of definitions.filter(({ type }) => type !== "table")) db.exec(entry.sql);
}
const pending = {
	coordinator_id: "coordinator",
	browser_transaction_hash: hash,
	purpose: "link",
	attempt_id: "attempt",
	state_hash: hash,
	binder_hash: hash,
	issuer: "https://accounts.google.com",
	auth_config_revision: hash,
	redirect_uri: "http://127.0.0.1:1234/callback",
	state: "pending",
	nonce: "n".repeat(43),
	pkce_verifier: "p".repeat(43),
	created_at_ms: 0,
	expires_at_ms: 600000,
};
const linked = {
	coordinator_id: "coordinator",
	link_id: "link",
	issuer: pending.issuer,
	subject: "google-a",
	identity_id: "actor",
	attempt_id: "attempt",
	controller_attestation_id: "attestation",
	auth_config_revision: hash,
	created_at_ms: 0,
	revoked_at_ms: null,
	authority_kind: "controller_attestation",
	device_claim_id: null,
};
const receipt = {
	coordinator_id: linked.coordinator_id,
	link_id: linked.link_id,
	action: "link_created",
	attempt_id: linked.attempt_id,
	identity_id: linked.identity_id,
	group_id: "group",
	device_id: "device",
	fingerprint: hash,
	controller_attestation_id: "attestation",
	auth_config_revision: hash,
	created_at_ms: 0,
	authority_kind: "controller_attestation",
	device_claim_id: null,
};

describe("exact lifecycle predecessor recognition", () => {
	it.each(["inline", "migrations"] as const)(
		"accepts actual %s schema-10 definitions without changing schema or rows",
		(source) => {
			// Arrange
			const db = setup(source);
			insert(db, browser, pending);
			insert(db, links, linked);
			insert(db, audit, receipt);
			const before = db.serialize();
			// Act
			const recognized = recognize(db);
			// Assert
			expect(recognized).toEqual({ recognized: 1 });
			expect(db.serialize()).toEqual(before);
		},
	);
	it("accepts pending attempt proof material instead of reusing the old cutover's pending-row prohibition", () => {
		// Arrange
		const db = setup();
		insert(db, browser, pending);
		insert(db, "coordinator_auth_link_attempts", {
			coordinator_id: "coordinator",
			attempt_id: "attempt",
			identity_id: "actor",
			group_id: "group",
			device_id: "device",
			public_key: "exact-key\r\n",
			fingerprint: hash,
			controller_attestation_id: null,
			controller_review_receipt_id: null,
			controller_revision: null,
			issuer: pending.issuer,
			auth_config_revision: hash,
			runtime_verifier_hash: hash,
			loopback_redirect: pending.redirect_uri,
			state: "pending",
			created_at_ms: 0,
			expires_at_ms: 600000,
			browser_start_hash: hash,
			authority_kind: "device_claim",
		});
		// Act
		const recognized = recognize(db);
		// Assert
		expect(recognized).toEqual({ recognized: 1 });
		expect(db.prepare(`SELECT nonce, pkce_verifier FROM ${browser}`).get()).toEqual({
			nonce: pending.nonce,
			pkce_verifier: pending.pkce_verifier,
		});
	});
	it("permits unrelated tables and data without treating them as migration-owned objects", () => {
		// Arrange
		const db = setup();
		db.exec(
			"CREATE TABLE unrelated_notes (body TEXT); INSERT INTO unrelated_notes VALUES ('retained')",
		);
		// Act
		const recognized = recognize(db);
		// Assert
		expect(recognized).toEqual({ recognized: 1 });
		expect(db.prepare("SELECT * FROM unrelated_notes").all()).toEqual([{ body: "retained" }]);
	});
	it.each(["layout", "quoted identifier"])(
		"accepts known %s without changing CHECK literal bytes",
		(variant) => {
			// Arrange
			const db = setup();
			rebuild(db, browser, (sql) =>
				variant === "layout"
					? sql.replaceAll("\n", "\n\t")
					: sql.replace(
							/CREATE TABLE(?: IF NOT EXISTS)? "?coordinator_auth_browser_transactions"?/u,
							`CREATE TABLE "${browser}"`,
						),
			);
			// Act
			const recognized = recognize(db);
			// Assert
			expect(recognized).toEqual({ recognized: 1 });
		},
	);
	it.each(["pen ding", "pending ", "PENDING", "pending/*comment*/"])(
		"rejects changed CHECK literal %j rather than stripping its bytes",
		(literal) => {
			// Arrange
			const db = setup();
			rebuild(db, browser, (sql) => sql.replaceAll("'pending'", `'${literal}'`));
			// Act
			const recognized = recognize(db);
			// Assert
			expect(recognized).toEqual({ recognized: 0 });
		},
	);
	it.each([
		`CREATE INDEX unexpected_index ON ${links}(subject)`,
		`CREATE TRIGGER unexpected_trigger BEFORE INSERT ON ${links} BEGIN SELECT 1; END;`,
		`CREATE VIEW external_reader AS SELECT * FROM ${links}`,
		`CREATE TABLE external_ref (link TEXT REFERENCES ${links}(link_id))`,
		`CREATE TABLE external_writer (x TEXT); CREATE TRIGGER external_write AFTER INSERT ON external_writer BEGIN DELETE FROM ${links}; END;`,
		`ALTER TABLE ${links} ADD COLUMN unknown_column TEXT`,
		`DROP INDEX idx_auth_link_attempts_browser_start`,
		`DROP TRIGGER coordinator_auth_device_claims_immutable_delete`,
		`CREATE TABLE coordinator_auth_account_associations (unexpected TEXT)`,
		`CREATE TABLE coordinator_auth_link_profile_refreshes (unexpected TEXT)`,
		`CREATE TABLE coordinator_auth_link_change_attempts (unexpected TEXT)`,
		`CREATE TABLE coordinator_auth_account_links_v3 (unexpected TEXT)`,
	])("rejects unknown shape or attached dependency: %s", (damage) => {
		// Arrange
		const db = setup();
		db.exec(damage);
		const before = db.serialize();
		// Act
		const recognized = recognize(db);
		// Assert
		expect(recognized).toEqual({ recognized: 0 });
		expect(db.serialize()).toEqual(before);
	});
});

describe("object-type namespace boundaries", () => {
	it.each([
		{ name: links, expectedType: "table", external: false },
		{ name: "idx_auth_sessions_expiry", expectedType: "index", external: false },
		{ name: "idx_auth_sessions_expiry", expectedType: "index", external: true },
	])(
		"rejects a trigger reusing known $expectedType name $name (external=$external)",
		({ name, expectedType, external }) => {
			// Arrange: SQLite permits a trigger name that already identifies a table or index.
			const db = setup();
			if (external) db.exec("CREATE TABLE unrelated_events (value TEXT)");
			const target = external ? "unrelated_events" : links;
			db.exec(
				`CREATE TRIGGER ${name} AFTER INSERT ON ${target} BEGIN SELECT count(*) FROM ${links}; END;`,
			);
			expect(
				db.prepare("SELECT type FROM sqlite_master WHERE name = ? ORDER BY type").all(name),
			).toEqual([{ type: expectedType }, { type: "trigger" }]);
			// Act
			const recognized = recognize(db);
			// Assert
			expect(recognized).toEqual({ recognized: 0 });
		},
	);
});

describe("declared-type token boundaries", () => {
	it.each([
		{ column: "coordinator_id", type: "TEXT" },
		{ column: "identity_id", type: "TEXT" },
		{ column: "created_at_ms", type: "INTEGER" },
	])("rejects $column $type followed by a merged NOTNULL type token", ({ column, type }) => {
		// Arrange: SQLite accepts the custom type but no longer enforces NOT NULL.
		const db = setup();
		rebuild(db, links, (sql) =>
			sql.replace(`${column} ${type} NOT NULL`, `${column} ${type}NOTNULL`),
		);
		expect(
			db
				.prepare("SELECT type, [notnull] FROM pragma_table_info(?) WHERE name = ?")
				.get(links, column),
		).toEqual({ type: `${type}NOTNULL`, notnull: 0 });
		// Act
		const recognized = recognize(db);
		// Assert
		expect(recognized).toEqual({ recognized: 0 });
	});
});

describe("preservable predecessor row IDs", () => {
	it.each([
		{ issuer: Buffer.from("blob-issuer") },
		{ created_at_ms: "not-a-time" },
		{ created_at_ms: 1.5 },
	])("rejects unsupported stored value types %j", (changes) => {
		// Arrange: old link storage permits these values, but a preserving V3 copy cannot.
		const db = setup();
		insert(db, links, { ...linked, ...changes });
		// Act
		const recognized = recognize(db);
		// Assert
		expect(recognized).toEqual({ recognized: 0 });
	});
	it("rejects link DDL with a removed UNIQUE constraint", () => {
		// Arrange: reject the unsupported DDL, independently of the rows it permits.
		const db = setup();
		rebuild(db, links, (sql) => sql.replace("UNIQUE (coordinator_id, issuer, subject),", ""));
		insert(db, links, linked);
		insert(db, links, {
			...linked,
			link_id: "other-link",
			identity_id: "other-actor",
			attempt_id: "other-attempt",
		});
		// Act
		const recognized = recognize(db);
		// Assert
		expect(recognized).toEqual({ recognized: 0 });
		expect(db.prepare(`SELECT * FROM ${links}`).all()).toHaveLength(2);
	});
	it.each([
		"DROP TABLE coordinator_auth_account_profiles",
		"ALTER TABLE coordinator_auth_link_profiles DROP COLUMN picture_url",
	])("fails closed during SQL preparation for missing shape: %s", (damage) => {
		// Arrange
		const db = setup();
		db.exec(damage);
		// Act
		const recognizeMissingShape = () => recognize(db);
		// Assert
		expect(recognizeMissingShape).toThrow(/no such (table|column)/);
	});
	it("accepts the maximum browser row ID that still leaves a safe source order", () => {
		// Arrange
		const db = setup();
		insert(db, browser, { ...pending, rowid: Number.MAX_SAFE_INTEGER - 1 });
		// Act
		const recognized = recognize(db);
		// Assert
		expect(recognized).toEqual({ recognized: 1 });
	});
	it.each([links, audit, browser])("accepts positive row IDs in %s", (table) => {
		// Arrange
		const db = setup();
		const record = { [links]: linked, [audit]: receipt, [browser]: pending }[table];
		insert(db, table, { ...record, rowid: 7 });
		// Act
		const recognized = recognize(db);
		// Assert
		expect(recognized).toEqual({ recognized: 1 });
	});
	it.each([links, audit, browser].flatMap((table) => [0, -1].map((rowid) => ({ table, rowid }))))(
		"rejects nonpositive row ID $rowid in $table",
		({ table, rowid }) => {
			// Arrange
			const db = setup();
			const record = { [links]: linked, [audit]: receipt, [browser]: pending }[table];
			insert(db, table, { ...record, rowid });
			// Act
			const recognized = recognize(db);
			// Assert
			expect(recognized).toEqual({ recognized: 0 });
		},
	);
	it("rejects a browser row ID that cannot leave room for safe sequence-plus-one ordering", () => {
		// Arrange
		const db = setup();
		insert(db, browser, { ...pending, rowid: Number.MAX_SAFE_INTEGER });
		// Act
		const recognized = recognize(db);
		// Assert
		expect(recognized).toEqual({ recognized: 0 });
	});
});
