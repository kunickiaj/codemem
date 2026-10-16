import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import {
	legacyLinkAuthorityRowsSql,
	linkAuthorityDefinitionsSql,
	linkAuthorityTables,
	withoutNewAuthorityColumns,
} from "../../cloudflare-coordinator-worker/test/link-authority-upgrade-fixture.js";
import { AUTH_CONTROLLER_SCHEMA_SQL } from "./coordinator-auth-controller.js";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_STATEMENTS as proof } from "./coordinator-auth-device-claim-schema.js";
import {
	AUTH_LINK_AUTHORITY_UPGRADE_SQL,
	upgradeAuthLinkAuthoritySchema,
} from "./coordinator-auth-link-authority-upgrade.js";
import { LEGACY_INLINE_AUTH_LINK_SCHEMA_SQL } from "./coordinator-auth-link-legacy-inline-test-fixture.js";
import { AUTH_SCHEMA_READINESS_SQL, AUTH_SCHEMA_READY_COUNT } from "./coordinator-auth-schema.js";

const LEGACY_LINK_SCHEMA_SQL = [
	"0017_add_auth_account_links.sql",
	"0019_add_auth_link_attempt_limit_indexes.sql",
	"0025_add_auth_link_browser_start_hash.sql",
]
	.map((name) =>
		readFileSync(
			new URL(`../../cloudflare-coordinator-worker/migrations/${name}`, import.meta.url),
			"utf8",
		),
	)
	.join("\n");

function legacyDatabase(schemaSql = LEGACY_LINK_SCHEMA_SQL) {
	const db = new Database(":memory:");
	db.exec(AUTH_CONTROLLER_SCHEMA_SQL);
	db.exec(schemaSql);
	db.exec(legacyLinkAuthorityRowsSql);
	return db;
}
function snapshot(db: Database.Database) {
	return linkAuthorityTables.map(
		(table) =>
			db.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[],
	);
}

it.each([
	"CREATE TABLE coordinator_auth_device_claims (claim_id TEXT)",
	// SQLite resolves these names to the expected objects despite their case.
	"CREATE TABLE COORDINATOR_AUTH_DEVICE_CLAIMS (claim_id TEXT)",
	"CREATE TABLE Coordinator_Auth_Device_Claims (claim_id TEXT)",
	`${proof[0]} CREATE TRIGGER COORDINATOR_AUTH_DEVICE_CLAIMS_IMMUTABLE_UPDATE BEFORE UPDATE ON coordinator_auth_device_claims BEGIN SELECT 1; END;`,
	`${proof[0]} CREATE TRIGGER Coordinator_Auth_Device_Claims_Insert_Collision BEFORE INSERT ON coordinator_auth_device_claims BEGIN SELECT 1; END;`,
	proof[0].replace("UNIQUE (coordinator_id, identity_id),", ""),
	...proof
		.slice(1)
		.map((sql) => `${proof[0]} ${sql.replace(/SELECT RAISE\([^;]+;/u, "SELECT 1;")}`),
])("aborts the whole cutover for unknown proof DDL (case %#)", (damage) => {
	// Arrange: retain the complete legacy rows and schema, including incompatible proof objects.
	const db = legacyDatabase();
	try {
		db.exec(damage);
		const before = snapshot(db);
		const schema = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
		// Act / Assert: reject before any link swap commits, not just at readiness checking.
		expect(() => upgradeAuthLinkAuthoritySchema(db)).toThrow(/CHECK/);
		expect(snapshot(db)).toEqual(before);
		expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
	} finally {
		db.close();
	}
});

it.each([
	["actual migrations", LEGACY_LINK_SCHEMA_SQL],
	["frozen inline DDL", LEGACY_INLINE_AUTH_LINK_SCHEMA_SQL],
])(
	"copies every historical column and rowid from %s without live enrollment/controller pins",
	(_label, schemaSql) => {
		// Arrange: both supported legacy shapes retain historical rows without live controller pins.
		const db = legacyDatabase(schemaSql);
		try {
			db.exec(
				readFileSync(
					new URL(
						"../../cloudflare-coordinator-worker/migrations/0032_device_claim_proofs.sql",
						import.meta.url,
					),
					"utf8",
				),
			);
			const before = snapshot(db);
			// Act
			upgradeAuthLinkAuthoritySchema(db);
			expect(db.prepare(AUTH_SCHEMA_READINESS_SQL).get()).toEqual({
				ready: AUTH_SCHEMA_READY_COUNT,
			});
			// Assert: the full copy survives, while a repeated upgrade is rejected.
			expect(snapshot(db).map(withoutNewAuthorityColumns)).toEqual(before);
			for (const rows of snapshot(db)) {
				expect(rows.every((row) => row.authority_kind === "controller_attestation")).toBe(true);
			}
			expect(db.prepare("SELECT revoked_at_ms FROM coordinator_auth_account_links").get()).toEqual({
				revoked_at_ms: 1005,
			});
			expect(
				db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%authority_upgrade%'").all(),
			).toEqual([]);
			expect(() => upgradeAuthLinkAuthoritySchema(db)).toThrow(/CHECK/);
		} finally {
			db.close();
		}
	},
);

it.each([
	[
		"active attempt",
		"UPDATE coordinator_auth_link_attempts SET state = 'pending', failure_reason = NULL, failed_at_ms = NULL WHERE attempt_id = 'retired'",
	],
	["unknown column", "ALTER TABLE coordinator_auth_account_links ADD COLUMN surprise TEXT"],
	["unknown index", "CREATE INDEX unexpected ON coordinator_auth_account_links(issuer)"],
	[
		"unknown trigger",
		"CREATE TRIGGER unexpected AFTER UPDATE ON coordinator_auth_account_links BEGIN SELECT 1; END",
	],
	[
		"inbound foreign key",
		"CREATE TABLE dependent (link TEXT REFERENCES coordinator_auth_account_links(link_id))",
	],
	["dependent view", "CREATE VIEW dependent AS SELECT * FROM coordinator_auth_account_links"],
	[
		"external trigger",
		"CREATE TABLE dependent (id TEXT); CREATE TRIGGER dependent_update AFTER INSERT ON dependent BEGIN SELECT * FROM coordinator_auth_account_links; END",
	],
	[
		"reserved check table",
		"CREATE TABLE coordinator_auth_link_authority_upgrade_checks (valuable TEXT); INSERT INTO coordinator_auth_link_authority_upgrade_checks VALUES ('keep')",
	],
	[
		"reserved copy table",
		"CREATE TABLE coordinator_auth_account_links_authority_upgrade (valuable TEXT)",
	],
	[
		"missing create audit",
		"DELETE FROM coordinator_auth_link_audit_log WHERE action = 'link_created'",
	],
	[
		"missing revoked audit",
		"DELETE FROM coordinator_auth_link_audit_log WHERE action = 'link_revoked'",
	],
	["mismatched audit", "UPDATE coordinator_auth_link_audit_log SET device_id = 'other'"],
	["mismatched link", "UPDATE coordinator_auth_account_links SET subject = 'other'"],
	["missing completed link", "DELETE FROM coordinator_auth_account_links"],
	[
		"blank controller",
		"UPDATE coordinator_auth_link_attempts SET controller_attestation_id = '' WHERE attempt_id = 'retired'",
	],
])("rejects %s and rolls back every schema/data change", (_label, damage) => {
	const db = legacyDatabase();
	try {
		db.exec(damage);
		const before = snapshot(db);
		const definitions = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
		expect(() => upgradeAuthLinkAuthoritySchema(db)).toThrow();
		expect(snapshot(db)).toEqual(before);
		expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(definitions);
		expect(db.inTransaction).toBe(false);
	} finally {
		db.close();
	}
});

it.each(["00", "0c"])(
	"rejects JSONB-shaped BLOB group ID x'%s' without changing schema or rows",
	(hex) => {
		const db = legacyDatabase();
		try {
			// Arrange: these BLOBs can be interpreted as JSONB, but IDs must remain text.
			db.exec(
				`UPDATE coordinator_auth_link_attempts SET group_id = x'${hex}' WHERE attempt_id = 'retired'`,
			);
			const before = snapshot(db);
			const schema = db.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
			// Act / Assert: require the type assertion, not an unrelated JSON parsing error.
			expect(() => upgradeAuthLinkAuthoritySchema(db)).toThrow(/CHECK/);
			expect(snapshot(db)).toEqual(before);
			expect(db.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
		} finally {
			db.close();
		}
	},
);

it.each([
	["copy omission", "SELECT rowid, coordinator_id", "SELECT rowid + 10, coordinator_id"],
	["copy corruption", "SELECT rowid, coordinator_id", "SELECT rowid, 'changed-coordinator'"],
	[
		"copy deletion",
		"FROM coordinator_auth_link_attempts;",
		"FROM coordinator_auth_link_attempts WHERE 0;",
	],
	[
		"late swap failure",
		"ALTER TABLE coordinator_auth_link_audit_log_authority_upgrade RENAME",
		"ALTER TABLE missing_copy RENAME",
	],
])("rolls back %s in the actual immediate transaction", (_label, target, replacement) => {
	const db = legacyDatabase();
	try {
		const before = snapshot(db);
		const definitions = db.prepare(linkAuthorityDefinitionsSql).all();
		const exec = db.exec.bind(db);
		const fault = vi
			.spyOn(db, "exec")
			.mockImplementation((sql) => exec(sql.replace(target, replacement)));
		expect(() => upgradeAuthLinkAuthoritySchema(db)).toThrow();
		fault.mockRestore();
		expect(snapshot(db)).toEqual(before);
		expect(db.prepare(linkAuthorityDefinitionsSql).all()).toEqual(definitions);
	} finally {
		vi.restoreAllMocks();
		db.close();
	}
});

it("requires explicit kinds and coherent source-specific references on all three tables", () => {
	const db = legacyDatabase();
	try {
		upgradeAuthLinkAuthoritySchema(db);
		for (const table of linkAuthorityTables) {
			expect(() => db.exec(`UPDATE ${table} SET authority_kind = NULL`)).toThrow(/NOT NULL/);
			expect(() => db.exec(`UPDATE ${table} SET authority_kind = 'unknown'`)).toThrow(/CHECK/);
			expect(() => db.exec(`UPDATE ${table} SET authority_kind = 'device_claim'`)).toThrow(/CHECK/);
			expect(() => db.exec(`UPDATE ${table} SET controller_attestation_id = NULL`)).toThrow(
				/CHECK/,
			);
			expect(() => db.exec(`UPDATE ${table} SET controller_attestation_id = ' '`)).toThrow(/CHECK/);
		}
		for (const column of ["controller_review_receipt_id", "controller_revision"]) {
			expect(() => db.exec(`UPDATE coordinator_auth_link_attempts SET ${column} = NULL`)).toThrow(
				/CHECK/,
			);
		}
		db.exec(
			"UPDATE coordinator_auth_link_attempts SET authority_kind = 'device_claim', controller_attestation_id = NULL, controller_review_receipt_id = NULL, controller_revision = NULL",
		);
		for (const table of linkAuthorityTables.slice(1)) {
			db.exec(
				`UPDATE ${table} SET authority_kind = 'device_claim', controller_attestation_id = NULL, device_claim_id = 'claim-a'`,
			);
			expect(() => db.exec(`UPDATE ${table} SET device_claim_id = NULL`)).toThrow(/CHECK/);
			expect(() => db.exec(`UPDATE ${table} SET controller_attestation_id = 'operator'`)).toThrow(
				/CHECK/,
			);
		}
		expect(() =>
			db.exec("UPDATE coordinator_auth_link_attempts SET controller_revision = 1"),
		).toThrow(/CHECK/);
		// There is no default authority: an old writer cannot silently claim operator approval.
		expect(() =>
			db.exec(
				`INSERT INTO coordinator_auth_link_audit_log (coordinator_id, link_id, action, attempt_id, identity_id, group_id, device_id, fingerprint, controller_attestation_id, auth_config_revision, created_at_ms) VALUES ('c','l','link_created','a','i','g','d','${"a".repeat(64)}','operator','${"b".repeat(64)}',0)`,
			),
		).toThrow(/NOT NULL/);
	} finally {
		db.close();
	}
});

it("preserves all legacy unique indexes including revoked subject and Identity tombstones", () => {
	const db = legacyDatabase();
	try {
		const unique = () =>
			linkAuthorityTables.map((table) =>
				db
					.prepare(
						`SELECT name, [unique], origin, partial FROM pragma_index_list('${table}') ORDER BY name`,
					)
					.all(),
			);
		const before = unique();
		upgradeAuthLinkAuthoritySchema(db);
		const after = unique();
		for (const [index, oldIndexes] of before.entries())
			expect(after[index]).toEqual(expect.arrayContaining(oldIndexes));
		expect(after[1]).toHaveLength(before[1].length + 1);
		expect(() =>
			db.exec(
				"INSERT INTO coordinator_auth_account_links SELECT coordinator_id, 'other-link', issuer, subject, identity_id, 'other-attempt', controller_attestation_id, auth_config_revision, created_at_ms, NULL, authority_kind, device_claim_id FROM coordinator_auth_account_links",
			),
		).toThrow(/UNIQUE/);
	} finally {
		db.close();
	}
});

it("checks retained controller provenance but does not require that controller to remain active", () => {
	const db = legacyDatabase();
	try {
		db.exec(`INSERT INTO coordinator_auth_controller_attestations
 (attestation_id, coordinator_id, identity_id, group_id, device_id, public_key, fingerprint,
 review_receipt_id, evidence_digest, revision, created_at, revoked_at)
 SELECT controller_attestation_id, coordinator_id, identity_id, group_id, device_id, public_key,
 fingerprint, controller_review_receipt_id, '${"a".repeat(64)}', controller_revision, 'old', 'revoked'
 FROM coordinator_auth_link_attempts WHERE attempt_id = 'attempt-a'`);
		const before = snapshot(db);
		db.exec(
			"UPDATE coordinator_auth_controller_attestations SET review_receipt_id = 'wrong-receipt'",
		);
		expect(() => upgradeAuthLinkAuthoritySchema(db)).toThrow(/CHECK/);
		expect(snapshot(db)).toEqual(before);
		db.exec(
			"UPDATE coordinator_auth_controller_attestations SET review_receipt_id = 'old-receipt'",
		);
		upgradeAuthLinkAuthoritySchema(db);
		expect(snapshot(db).map(withoutNewAuthorityColumns)).toEqual(before);
	} finally {
		db.close();
	}
});

it("reserves a committed claim reference even across coordinator boundaries", () => {
	const db = legacyDatabase();
	try {
		upgradeAuthLinkAuthoritySchema(db);
		db.exec(
			"UPDATE coordinator_auth_account_links SET authority_kind = 'device_claim', controller_attestation_id = NULL, device_claim_id = 'claim-a'",
		);
		expect(() =>
			db.exec(
				"INSERT INTO coordinator_auth_account_links SELECT 'other-coordinator', link_id, issuer, subject, identity_id, attempt_id, controller_attestation_id, auth_config_revision, created_at_ms, revoked_at_ms, authority_kind, device_claim_id FROM coordinator_auth_account_links",
			),
		).toThrow(/UNIQUE/);
	} finally {
		db.close();
	}
});

it("keeps D1 upgrade source free of transaction and foreign-key toggles", () => {
	expect(AUTH_LINK_AUTHORITY_UPGRADE_SQL).not.toMatch(/\b(BEGIN|COMMIT|PRAGMA)\b/iu);
});

it("rejects a changed CHECK literal rather than normalizing away its whitespace", () => {
	const db = new Database(":memory:");
	try {
		db.exec(AUTH_CONTROLLER_SCHEMA_SQL);
		db.exec(LEGACY_LINK_SCHEMA_SQL.replace("'pending'", "'pending '"));
		db.exec(legacyLinkAuthorityRowsSql);
		const before = snapshot(db);
		expect(() => upgradeAuthLinkAuthoritySchema(db)).toThrow(/CHECK/);
		expect(snapshot(db)).toEqual(before);
	} finally {
		db.close();
	}
});

it.each([
	"has\ncontrol",
	"has\u200bformat",
	"\u00a0edge-space",
	"edge-space\u3000",
	"😀".repeat(129),
])("rejects malformed legacy controller reference %j without changing its bytes", (reference) => {
	const db = legacyDatabase();
	try {
		db.prepare(
			"UPDATE coordinator_auth_link_attempts SET controller_review_receipt_id = ? WHERE attempt_id = 'retired'",
		).run(reference);
		const before = snapshot(db);
		expect(() => upgradeAuthLinkAuthoritySchema(db)).toThrow(/CHECK/);
		expect(snapshot(db)).toEqual(before);
	} finally {
		db.close();
	}
});

it("retains valid non-ASCII reference bytes at the 256 UTF-16-unit boundary", () => {
	const db = legacyDatabase();
	try {
		db.prepare(
			"UPDATE coordinator_auth_link_attempts SET controller_review_receipt_id = ? WHERE attempt_id = 'retired'",
		).run("😀".repeat(128));
		const before = snapshot(db);
		upgradeAuthLinkAuthoritySchema(db);
		expect(snapshot(db).map(withoutNewAuthorityColumns)).toEqual(before);
	} finally {
		db.close();
	}
});

it.each([
	["device_id", ""],
	["group_id", "has\u200bformat"],
	["identity_id", "has\ncontrol"],
	["coordinator_id", " padded"],
	["attempt_id", "x".repeat(257)],
	["controller_attestation_id", "has\0nul"],
	["controller_review_receipt_id", ""],
	["device_id", "has\u200bformat"],
	["group_id", ""],
	["identity_id", "padded "],
	["coordinator_id", "has\0nul"],
	["attempt_id", "has\u200bformat"],
])("rejects failed-attempt %s reference %j independently of relationships", (column, value) => {
	const db = legacyDatabase();
	try {
		// Arrange: the failed attempt has no link or audit relationship to contradict.
		db.prepare(
			`UPDATE coordinator_auth_link_attempts SET ${column} = ? WHERE attempt_id = 'retired'`,
		).run(value);
		const before = snapshot(db);
		const schema = db.prepare(linkAuthorityDefinitionsSql).all();
		// Act / Assert: validation rejects the bytes and leaves schema and rows intact.
		expect(() => upgradeAuthLinkAuthoritySchema(db)).toThrow(/CHECK/);
		expect(snapshot(db)).toEqual(before);
		expect(db.prepare(linkAuthorityDefinitionsSql).all()).toEqual(schema);
	} finally {
		db.close();
	}
});

it.each(["", "has\u200bformat", " padded", "😀".repeat(129)])(
	"rejects malformed link ID %j even when every retained relationship agrees",
	(value) => {
		const db = legacyDatabase();
		try {
			// Arrange: change all matching references, not the join consistency.
			for (const table of linkAuthorityTables)
				db.prepare(`UPDATE ${table} SET link_id = ? WHERE link_id = 'link-a'`).run(value);
			const before = snapshot(db);
			const schema = db.prepare(linkAuthorityDefinitionsSql).all();
			// Act / Assert.
			expect(() => upgradeAuthLinkAuthoritySchema(db)).toThrow(/CHECK/);
			expect(snapshot(db)).toEqual(before);
			expect(db.prepare(linkAuthorityDefinitionsSql).all()).toEqual(schema);
		} finally {
			db.close();
		}
	},
);

it("preserves boundary-sized failed-attempt IDs and an optional NULL link", () => {
	const db = legacyDatabase();
	try {
		// Arrange: all required IDs reach 256 UTF-16 units; link_id stays NULL.
		for (const column of [
			"coordinator_id",
			"identity_id",
			"group_id",
			"device_id",
			"controller_attestation_id",
			"controller_review_receipt_id",
			"attempt_id",
		])
			db.prepare(
				`UPDATE coordinator_auth_link_attempts SET ${column} = ? WHERE state = 'failed'`,
			).run("😀".repeat(128));
		const before = snapshot(db);
		// Act.
		upgradeAuthLinkAuthoritySchema(db);
		// Assert.
		expect(snapshot(db).map(withoutNewAuthorityColumns)).toEqual(before);
		expect(
			db.prepare("SELECT link_id FROM coordinator_auth_link_attempts WHERE state = 'failed'").get(),
		).toEqual({ link_id: null });
	} finally {
		db.close();
	}
});
