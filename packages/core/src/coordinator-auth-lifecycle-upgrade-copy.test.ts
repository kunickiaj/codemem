import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { connectCoordinator } from "./better-sqlite-coordinator-store.js";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS } from "./coordinator-auth-device-claim-schema.js";
import { AUTH_LIFECYCLE_PREDECESSOR_TABLES } from "./coordinator-auth-lifecycle-predecessor-shapes.js";
import { AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL } from "./coordinator-auth-lifecycle-schema.js";
import {
	AUTH_LIFECYCLE_COPY_TABLE_NAMES,
	type AuthLifecycleCopyTable,
	authLifecycleCopyStatement,
	authLifecyclePreservationCheck,
	authLifecycleSnapshotStatements,
} from "./coordinator-auth-lifecycle-upgrade-copy.js";
import { AUTH_LINK_AUTHORITY_CUTOVER_SQL } from "./coordinator-auth-link-authority-upgrade.js";

const links = "coordinator_auth_account_links";
const browser = "coordinator_auth_browser_transactions";
const claims = "coordinator_auth_device_claims";
const databases: Database.Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function memory() {
	const db = new Database(":memory:");
	databases.push(db);
	return db;
}
function insert(db: Database.Database, table: string, row: Record<string, unknown>) {
	const names = Object.keys(row);
	db.prepare(
		`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
	).run(...Object.values(row));
}
function columns(db: Database.Database, table: string) {
	return (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
		({ name }) => name,
	);
}
function snapshot(db: Database.Database, table: AuthLifecycleCopyTable) {
	for (const sql of authLifecycleSnapshotStatements({ table })) db.exec(sql);
}
function preserved(db: Database.Database, table: AuthLifecycleCopyTable) {
	return db.prepare(`SELECT ${authLifecyclePreservationCheck({ table })} AS ok`).get();
}
function createTarget(db: Database.Database, table: string, extra = "") {
	const names = columns(db, table);
	// No affinity: primitive tests must observe INTEGER and REAL independently.
	db.exec(
		`CREATE TABLE "${table}_lifecycle_upgrade" (${names.map((name) => `"${name}"`).join(",")}${extra})`,
	);
}
function linked(index: number) {
	return {
		rowid: [7, 103, 1009][index],
		coordinator_id: "synthetic-coordinator",
		link_id: `link-${index}`,
		issuer: "https://issuer.example.test",
		subject: `subject-${index}`,
		identity_id: `identity-${index}`,
		attempt_id: `attempt-${index}`,
		controller_attestation_id: "synthetic-attestation",
		auth_config_revision: "a".repeat(64),
		created_at_ms: 1000,
		revoked_at_ms: index === 1 ? 2000 : null,
		authority_kind: "controller_attestation",
		device_claim_id: null,
	};
}
function legacyRow(db: Database.Database, table: AuthLifecycleCopyTable, index: number) {
	const hash = String(index + 1).repeat(64);
	const defaults: Record<string, unknown> = {
		...linked(index),
		claim_id: `claim-${index}`,
		group_id: `group-${index}`,
		device_id: `device-${index}`,
		public_key: "synthetic-public-key",
		fingerprint: hash,
		key_id: hash,
		controller_review_receipt_id: "synthetic-review",
		controller_revision: 1,
		runtime_verifier_hash: hash,
		loopback_redirect: "http://127.0.0.1:1234/callback",
		state: "pending",
		browser_transaction_hash: hash,
		account_subject: null,
		completion_secret_hash: null,
		failure_reason: null,
		expires_at_ms: table === "coordinator_auth_sessions" ? 28801000 : 601000,
		claimed_at_ms: null,
		oidc_verified_at_ms: null,
		confirmed_at_ms: null,
		finalized_at_ms: null,
		failed_at_ms: null,
		browser_start_hash: hash,
		action: "link_created",
		purpose: "link",
		state_hash: hash,
		binder_hash: hash,
		redirect_uri: "http://127.0.0.1:1234/callback",
		nonce: "n".repeat(43),
		pkce_verifier: "p".repeat(43),
		claim_token: null,
		consumed_at_ms: null,
		session_id: `session-${index}`,
		credential_hash: hash,
		source: "link_redeem",
		purge_eligible: 0,
		display_name: index === 0 ? "Synthetic Ω 'profile'" : null,
		email: index === 0 ? "synthetic@example.test" : null,
		email_verified: index === 0 ? 0 : null,
		picture_url: null,
		source_session_id: `session-${index}`,
		source_signed_in_at_ms: 1000,
		verified_at_ms: 1000,
	};
	if (table === "coordinator_auth_link_attempts") {
		defaults.link_id = null;
		defaults.browser_transaction_hash = null;
	}
	const row = Object.fromEntries(columns(db, table).map((name) => [name, defaults[name]]));
	if (table !== claims) row.rowid = defaults.rowid;
	return row;
}
function frozenFixture() {
	const db = memory();
	for (const definition of AUTH_LIFECYCLE_PREDECESSOR_TABLES) db.exec(definition.variants[0]);
	db.exec(COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS[0]);
	for (const table of AUTH_LIFECYCLE_COPY_TABLE_NAMES) {
		for (let index = 0; index < 3; index++) insert(db, table, legacyRow(db, table, index));
	}
	db.exec(
		"CREATE TABLE unrelated_data (value BLOB); INSERT INTO unrelated_data VALUES (X'0000FF')",
	);
	return db;
}
function primitiveFixture(value: string) {
	const db = memory();
	const definition = AUTH_LIFECYCLE_PREDECESSOR_TABLES.find(({ name }) => name === links);
	if (!definition) throw new Error("Missing frozen links inventory");
	// A known-table primitive fixture, not an admitted schema-10 predecessor.
	db.exec(`CREATE TABLE ${links} (${definition.columns.map(({ name }) => `"${name}"`).join(",")})`);
	insert(db, links, linked(0));
	db.exec(`UPDATE ${links} SET controller_attestation_id = ${value}`);
	snapshot(db, links);
	createTarget(db, links);
	db.exec(authLifecycleCopyStatement({ table: links }));
	return db;
}

it.each(AUTH_LIFECYCLE_COPY_TABLE_NAMES)("copies every frozen %s column and identity", (table) => {
	// Arrange: populated schema-10 tables with sparse rowids and a WITHOUT ROWID proof.
	const db = frozenFixture();
	const before = db.prepare(`SELECT * FROM "${table}"`).all();
	const unrelated = db.prepare("SELECT hex(value) AS bytes FROM unrelated_data").all();
	snapshot(db, table);
	createTarget(db, table);
	// Act
	db.exec(authLifecycleCopyStatement({ table }));
	// Assert: every old column survives, rather than a selected account projection.
	expect(db.prepare(`SELECT * FROM "${table}_lifecycle_upgrade"`).all()).toEqual(before);
	expect(preserved(db, table)).toEqual({ ok: 1 });
	expect(db.prepare("SELECT hex(value) AS bytes FROM unrelated_data").all()).toEqual(unrelated);
	if (table !== claims) {
		expect(
			db.prepare(`SELECT rowid FROM "${table}_lifecycle_upgrade" ORDER BY rowid`).all(),
		).toEqual([{ rowid: 7 }, { rowid: 103 }, { rowid: 1009 }]);
	}
});

it.each(AUTH_LIFECYCLE_COPY_TABLE_NAMES)("rejects a missing or additional %s row", (table) => {
	// Arrange
	const db = frozenFixture();
	snapshot(db, table);
	createTarget(db, table);
	db.exec(authLifecycleCopyStatement({ table }));
	// Act: remove one row, then restore it and append a duplicate tuple.
	const identity = table === claims ? "claim_id = 'claim-0'" : "rowid = 7";
	db.exec(`DELETE FROM "${table}_lifecycle_upgrade" WHERE ${identity}`);
	const missing = preserved(db, table);
	db.exec(`DELETE FROM "${table}_lifecycle_upgrade"`);
	db.exec(authLifecycleCopyStatement({ table }));
	db.exec(
		`INSERT INTO "${table}_lifecycle_upgrade" SELECT * FROM "${table}_lifecycle_upgrade" LIMIT 1`,
	);
	// Assert: count comparison also rejects duplicate logical proof rows.
	expect(missing).toEqual({ ok: 0 });
	expect(preserved(db, table)).toEqual({ ok: 0 });
});

it("copies browser rowids into browser_sequence and fills only explicit new literals", () => {
	// Arrange
	const db = frozenFixture();
	snapshot(db, browser);
	createTarget(
		db,
		browser,
		", browser_sequence INTEGER PRIMARY KEY, generation INTEGER, signin_sequence_floor INTEGER, note TEXT, ended_at_ms INTEGER",
	);
	// Act
	db.exec(
		authLifecycleCopyStatement({
			table: browser,
			targetRowId: "browser_sequence",
			extraColumns: {
				generation: 1,
				signin_sequence_floor: 0,
				note: "Ω 'quoted'; SELECT 1; --",
				ended_at_ms: null,
			},
		}),
	);
	const check = db
		.prepare(
			`SELECT ${authLifecyclePreservationCheck({ table: browser, targetRowId: "browser_sequence" })} AS ok`,
		)
		.get();
	// Assert
	expect(check).toEqual({ ok: 1 });
	expect(
		db
			.prepare(
				`SELECT browser_sequence, generation, signin_sequence_floor, note, ended_at_ms FROM ${browser}_lifecycle_upgrade ORDER BY browser_sequence`,
			)
			.all(),
	).toEqual(
		[7, 103, 1009].map((browser_sequence) => ({
			browser_sequence,
			generation: 1,
			signin_sequence_floor: 0,
			note: "Ω 'quoted'; SELECT 1; --",
			ended_at_ms: null,
		})),
	);
});

it("uses the proof logical primary key without referencing a nonexistent rowid", () => {
	// Arrange
	const db = frozenFixture();
	snapshot(db, claims);
	db.exec(
		COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS[0].replace(
			"coordinator_auth_device_claims (",
			"coordinator_auth_device_claims_lifecycle_upgrade (",
		),
	);
	// Act
	db.exec(authLifecycleCopyStatement({ table: claims }));
	db.exec(`UPDATE ${claims}_lifecycle_upgrade SET claim_id = 'changed' WHERE claim_id = 'claim-0'`);
	// Assert
	expect(preserved(db, claims)).toEqual({ ok: 0 });
	expect(authLifecycleCopyStatement({ table: claims })).not.toMatch(/"rowid"/u);
});

it("copies active and revoked links into the constrained lifecycle target", () => {
	// Arrange
	const db = frozenFixture();
	snapshot(db, links);
	db.exec(
		AUTH_ACCOUNT_LINK_GENERATION_TABLE_SQL.replace(
			"coordinator_auth_account_links (",
			"coordinator_auth_account_links_lifecycle_upgrade (",
		),
	);
	// Act
	db.exec(
		authLifecycleCopyStatement({
			table: links,
			extraColumns: {
				generation: 1,
				signin_sequence_floor: 0,
				ended_at_ms: null,
				end_reason: null,
				end_attempt_id: null,
			},
		}),
	);
	const copied = preserved(db, links);
	db.exec(`UPDATE ${links}_lifecycle_upgrade SET revoked_at_ms = NULL WHERE rowid = 103`);
	// Assert: birth values and the old revocation timestamp are both part of preservation.
	expect(copied).toEqual({ ok: 1 });
	expect(preserved(db, links)).toEqual({ ok: 0 });
});

it.each([
	"NULL",
	"''",
	"X'00'",
	"X'0000FF00'",
	"'Ω''quote' || char(0) || 'tail'",
	"1",
	"1.0",
	"1.0000000000000002",
	"9007199254740993",
])("retains the exact type and bytes of %s without CTAS affinity changes", (value) => {
	// Arrange
	const db = primitiveFixture(value);
	// Act
	const result = preserved(db, links);
	const tuple = (table: string) =>
		db
			.prepare(
				`SELECT typeof(controller_attestation_id) AS type, hex(CAST(controller_attestation_id AS BLOB)) AS bytes FROM ${table}`,
			)
			.get();
	// Assert
	expect(result).toEqual({ ok: 1 });
	expect(tuple(`${links}_lifecycle_upgrade`)).toEqual(tuple(links));
});

it.each([
	["NULL", "''"],
	["''", "X''"],
	["X'00'", "char(0)"],
	["X'0000FF00'", "X'0000FF01'"],
	["'Ω' || char(0) || 'a'", "'Ω' || char(0) || 'b'"],
	["1", "1.0"],
	["1.0", "1"],
	["1.0000000000000002", "1.0000000000000004"],
	["9007199254740993", "9007199254740992"],
])("rejects a same-count raw mutation from %s to %s", (before, after) => {
	// Arrange
	const db = primitiveFixture(before);
	// Act
	db.exec(`UPDATE ${links}_lifecycle_upgrade SET controller_attestation_id = ${after}`);
	// Assert: REAL neighbors can share SQLite's default text representation.
	expect(preserved(db, links)).toEqual({ ok: 0 });
});

it("rejects changed sparse rowids even when every old column remains equal", () => {
	// Arrange
	const db = primitiveFixture("NULL");
	// Act
	db.exec(`UPDATE ${links}_lifecycle_upgrade SET rowid = 8`);
	// Assert
	expect(preserved(db, links)).toEqual({ ok: 0 });
});

it("accepts empty inventories but fails closed when the target lacks an old column", () => {
	// Arrange
	const db = primitiveFixture("NULL");
	db.exec(
		`DELETE FROM ${links}; DROP TABLE coordinator_auth_lifecycle_snapshot_account_links; DELETE FROM ${links}_lifecycle_upgrade`,
	);
	snapshot(db, links);
	// Act
	const empty = preserved(db, links);
	db.exec(`ALTER TABLE ${links}_lifecycle_upgrade DROP COLUMN subject`);
	// Assert
	expect(empty).toEqual({ ok: 1 });
	expect(() => preserved(db, links)).toThrow();
});

it("refuses a preexisting scratch table without overwriting its contents", () => {
	// Arrange
	const db = primitiveFixture("NULL");
	const before = db.serialize();
	// Act
	const repeat = () => snapshot(db, links);
	// Assert
	expect(repeat).toThrow(/already exists/u);
	expect(db.serialize()).toEqual(before);
});

it("qualifies source and snapshot reads so missing identifiers cannot become DQS string literals", () => {
	// Arrange: qualification must remain even on builds that disable double-quoted string literals.
	const snapshotSql = authLifecycleSnapshotStatements({ table: links }).join("\n");
	const copySql = authLifecycleCopyStatement({ table: links });
	// Act
	const preservationSql = authLifecyclePreservationCheck({ table: links });
	// Assert: both the row identity and every encoded value use a table-qualified reference.
	for (const sql of [snapshotSql, copySql, preservationSql]) {
		expect(sql).toContain('"s"."subject"');
		expect(sql).toContain('"s"."rowid"');
	}
	for (const suffix of ["storage_type", "bytes", "numeric"]) {
		expect(preservationSql).toContain(`"before_snapshot"."subject_${suffix}"`);
	}
	expect(preservationSql).toContain('"before_snapshot"."source_rowid"');
});

it.each(["source", "destination", "snapshot"] as const)(
	"fails closed for an empty %s missing a required column",
	(location) => {
		// Arrange: zero rows must not conceal a missing column on DQS-enabled SQLite builds.
		const db = primitiveFixture("NULL");
		const scratch = "coordinator_auth_lifecycle_snapshot_account_links";
		for (const table of [links, `${links}_lifecycle_upgrade`, scratch])
			db.exec(`DELETE FROM ${table}`);
		const tables = { source: links, destination: `${links}_lifecycle_upgrade`, snapshot: scratch };
		const column = location === "snapshot" ? "subject_bytes" : "subject";
		db.exec(`ALTER TABLE ${tables[location]} DROP COLUMN ${column}`);
		if (location === "source") db.exec(`DROP TABLE ${scratch}`);
		// Act
		const read = () => (location === "source" ? snapshot(db, links) : preserved(db, links));
		// Assert: a prepare error rejects the malformed shape instead of returning preservation=true.
		expect(read).toThrow(/no such column/u);
		if (location === "source") {
			expect(() => db.exec(authLifecycleCopyStatement({ table: links }))).toThrow(
				/no such column/u,
			);
		}
	},
);

it("copies a retained predecessor into the original table without reading the upgrade table", () => {
	// Arrange
	const db = frozenFixture();
	db.exec(`ALTER TABLE ${links} RENAME TO ${links}_lifecycle_predecessor`);
	for (const sql of authLifecycleSnapshotStatements({ table: links, source: "retained" }))
		db.exec(sql);
	db.exec(AUTH_LIFECYCLE_PREDECESSOR_TABLES.find(({ name }) => name === links)?.variants[0] ?? "");
	// Act
	db.exec(
		authLifecycleCopyStatement({ table: links, source: "retained", destination: "original" }),
	);
	// Assert
	expect(
		db
			.prepare(
				`SELECT ${authLifecyclePreservationCheck({ table: links, destination: "original" })} AS ok`,
			)
			.get(),
	).toEqual({ ok: 1 });
});

it.each(["inline", "migrations"] as const)(
	"copies actual %s predecessor browser and link values",
	(family) => {
		// Arrange: actual old families, not future lifecycle DDL or a generated recognizer schema.
		let db: Database.Database;
		if (family === "inline") {
			db = connectCoordinator(":memory:");
			databases.push(db);
		} else {
			db = memory();
			const directory = new URL("../../cloudflare-coordinator-worker/migrations/", import.meta.url);
			for (const name of readdirSync(directory)
				.filter((name) => /^00(?:[0-2]\d|3[0-3])_.*\.sql$/u.test(name))
				.sort())
				db.exec(readFileSync(new URL(name, directory), "utf8"));
			db.exec(AUTH_LINK_AUTHORITY_CUTOVER_SQL);
		}
		insert(db, links, linked(0));
		insert(db, links, linked(1));
		insert(db, browser, legacyRow(db, browser, 0));
		// Act
		for (const table of [links, browser] as const) {
			snapshot(db, table);
			createTarget(db, table);
			db.exec(authLifecycleCopyStatement({ table }));
		}
		// Assert: revoked rows and pending OAuth nonce/PKCE remain unchanged.
		expect(preserved(db, links)).toEqual({ ok: 1 });
		expect(preserved(db, browser)).toEqual({ ok: 1 });
	},
);

it("emits only explicit quoted projections with no destructive or automatic cleanup SQL", () => {
	// Arrange
	const statements = AUTH_LIFECYCLE_COPY_TABLE_NAMES.flatMap((table) => [
		...authLifecycleSnapshotStatements({ table }),
		authLifecycleCopyStatement({ table }),
		authLifecyclePreservationCheck({ table }),
	]);
	// Act
	const sql = statements.join("\n");
	// Assert
	expect(sql).not.toMatch(/SELECT\s+\*|\b(?:DROP|DELETE|ALTER|REPLACE)\b|IF NOT EXISTS/iu);
	expect(sql).toContain('"coordinator_auth_account_links_lifecycle_upgrade"');
	expect(Object.isFrozen(authLifecycleSnapshotStatements({ table: links }))).toBe(true);
});

it.each(AUTH_LIFECYCLE_COPY_TABLE_NAMES)(
	"checks every historical %s column, not just keys",
	(table) => {
		// Arrange: a loose target permits deliberate invalid raw values without bypassing source constraints.
		const db = frozenFixture();
		snapshot(db, table);
		createTarget(db, table);
		for (const column of columns(db, table)) {
			db.exec(`DELETE FROM "${table}_lifecycle_upgrade"`);
			db.exec(authLifecycleCopyStatement({ table }));
			// Act
			db.exec(`UPDATE "${table}_lifecycle_upgrade" SET "${column}" = X'FF00'`);
			// Assert
			expect(preserved(db, table), column).toEqual({ ok: 0 });
		}
	},
);

it.each(["arbitrary_table", 'coordinator_auth_account_links"; DROP TABLE unrelated_data; --'])(
	"rejects an unknown table name %s in all builders",
	(table) => {
		// Arrange: model an untyped caller crossing the TypeScript boundary.
		const options = { table: table as AuthLifecycleCopyTable };
		// Act / Assert
		expect(() => authLifecycleSnapshotStatements(options)).toThrow(/auth_lifecycle_/u);
		expect(() => authLifecycleCopyStatement(options)).toThrow(/auth_lifecycle_/u);
		expect(() => authLifecyclePreservationCheck(options)).toThrow(/auth_lifecycle_/u);
	},
);

it.each([
	{ extraColumns: { subject: "overwrite" } },
	{ extraColumns: { rowid: 99 } },
	{ extraColumns: { browser_sequence: 99 } },
	{ extraColumns: { 'bad"name': 1 } },
	{ extraColumns: { generation: 1.5 } },
	{ extraColumns: { generation: Number.NaN } },
	{ extraColumns: { generation: Number.POSITIVE_INFINITY } },
	{ extraColumns: { generation: Number.MAX_SAFE_INTEGER + 1 } },
	{ extraColumns: { note: "NUL\0text" } },
	{ targetRowId: "browser_sequence" as const },
	{ destination: "original" as const },
])("rejects unsafe copy options %# before executing SQL", (options) => {
	// Arrange
	const build = () => authLifecycleCopyStatement({ table: links, ...options });
	// Act / Assert
	expect(build).toThrow(/auth_lifecycle_/u);
});
