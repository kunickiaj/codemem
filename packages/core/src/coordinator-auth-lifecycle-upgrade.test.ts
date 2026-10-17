import type { Database as SqliteDatabase } from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_ACCOUNT_PROFILE_SCHEMA_SQL } from "./coordinator-auth-account-profile-contract.js";
import { AUTH_BROWSER_TXN_SCHEMA_SQL } from "./coordinator-auth-browser-transaction-contract.js";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL } from "./coordinator-auth-device-claim-schema.js";
import { AUTH_SCHEMA_V2_READINESS_SQL } from "./coordinator-auth-lifecycle-predecessor.js";
import {
	AUTH_LIFECYCLE_UPGRADE_SQL,
	AUTH_LIFECYCLE_UPGRADE_STATEMENTS,
} from "./coordinator-auth-lifecycle-upgrade.js";
import {
	CoordinatorAuthLifecycleUpgradeRejectedError,
	upgradeAuthLifecycleSchema,
} from "./coordinator-auth-lifecycle-upgrade-sqlite.js";
import {
	databaseState,
	hash,
	insert,
	populatedPredecessor,
	rawAuthSnapshot,
} from "./coordinator-auth-lifecycle-upgrade-test-fixture.js";
import { AUTH_LINK_SCHEMA_SQL } from "./coordinator-auth-link-contract.js";
import { AUTH_LINK_PROFILE_SCHEMA_SQL } from "./coordinator-auth-link-profile.js";
import { AUTH_SESSION_SCHEMA_SQL } from "./coordinator-auth-session-contract.js";

const links = "coordinator_auth_account_links";
const browser = "coordinator_auth_browser_transactions";
const claims = "coordinator_auth_device_claims";
const databases: SqliteDatabase[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const db of databases.splice(0)) db.close();
});
function setup(source: "inline" | "migrations" = "inline") {
	const db = populatedPredecessor(source);
	databases.push(db);
	return db;
}
function ready(db: SqliteDatabase) {
	return db.prepare(AUTH_SCHEMA_V2_READINESS_SQL).get();
}
function unrelated(db: SqliteDatabase) {
	return ["groups", "coordinator_identity_group_grants", "unrelated_notes", "unrelated_sequence"]
		.map((table) => ({ table, rows: db.prepare(`SELECT * FROM main."${table}"`).all() }))
		.concat([
			{
				table: "unrelated sqlite_sequence",
				rows: db
					.prepare("SELECT * FROM main.sqlite_sequence WHERE name = ?")
					.all("unrelated_sequence"),
			},
		]);
}

describe.each(["inline", "migrations"] as const)("explicit lifecycle upgrade from %s", (source) => {
	it("preserves every old raw column, storage class and row identity before installing new guards", () => {
		// Arrange
		const db = setup(source);
		const before = rawAuthSnapshot(db);
		const independent = unrelated(db);
		expect(ready(db)).toEqual({ ready: 10 });
		// Act
		upgradeAuthLifecycleSchema(db);
		// Assert: the oracle reads actual old columns and does not use production copy/check builders.
		expect(rawAuthSnapshot(db, before)).toEqual(before);
		expect(unrelated(db)).toEqual(independent);
		expect(ready(db)).toEqual({ ready: 9 });
		expect(db.inTransaction).toBe(false);
		expect(
			db
				.prepare(
					"SELECT coordinator_id,issuer,subject,identity_id,first_link_id,created_at_ms FROM coordinator_auth_account_associations ORDER BY first_link_id",
				)
				.all(),
		).toEqual(
			db
				.prepare(
					`SELECT coordinator_id,issuer,subject,identity_id,link_id AS first_link_id,created_at_ms FROM ${links} ORDER BY link_id`,
				)
				.all(),
		);
		expect(
			db
				.prepare(
					`SELECT generation,signin_sequence_floor,ended_at_ms,end_reason,end_attempt_id FROM ${links}`,
				)
				.all(),
		).toEqual(
			Array(3).fill({
				generation: 1,
				signin_sequence_floor: 0,
				ended_at_ms: null,
				end_reason: null,
				end_attempt_id: null,
			}),
		);
		expect(
			db.prepare("SELECT prior_link_id,prior_generation FROM coordinator_auth_link_attempts").all(),
		).toEqual(Array(5).fill({ prior_link_id: null, prior_generation: null }));
		expect(db.prepare("SELECT source_order FROM coordinator_auth_account_profiles").all()).toEqual(
			Array(3).fill({ source_order: 1 }),
		);
		expect(
			db.prepare("SELECT source_order,source_purpose FROM coordinator_auth_link_profiles").all(),
		).toEqual(Array(4).fill({ source_order: 0, source_purpose: "link" }));
		for (const table of [
			"coordinator_auth_link_change_attempts",
			"coordinator_auth_link_profile_refreshes",
		])
			expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE name LIKE '%lifecycle_snapshot%' OR name LIKE '%lifecycle_upgrade%' OR name LIKE '%lifecycle_predecessor%'",
				)
				.all(),
		).toEqual([]);
	});
	it("keeps schema-10 authentication fenced after old initialization statements replay", () => {
		// Arrange
		const db = setup(source);
		upgradeAuthLifecycleSchema(db);
		const before = rawAuthSnapshot(db);
		// Act
		for (const sql of [
			AUTH_LINK_SCHEMA_SQL,
			AUTH_BROWSER_TXN_SCHEMA_SQL,
			AUTH_SESSION_SCHEMA_SQL,
			AUTH_ACCOUNT_PROFILE_SCHEMA_SQL,
			AUTH_LINK_PROFILE_SCHEMA_SQL,
			COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL,
		])
			db.exec(sql);
		// Assert
		expect(ready(db)).toEqual({ ready: 9 });
		expect(rawAuthSnapshot(db)).toEqual(before);
		expect(
			db
				.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
				.get(claims),
		).toEqual({ n: 4 });
		expect(
			db.prepare("SELECT group_id FROM groups WHERE group_id = ?").get("preserved-group"),
		).toEqual({ group_id: "preserved-group" });
	});
});

describe("upgrade postconditions", () => {
	it("exports intact portable statements and an equivalent complete SQL file", () => {
		// Arrange
		const statements = AUTH_LIFECYCLE_UPGRADE_STATEMENTS;
		// Act
		const file = AUTH_LIFECYCLE_UPGRADE_SQL;
		// Assert
		expect(Object.isFrozen(statements)).toBe(true);
		expect(file).toBe(`${statements.join(";\n")};\n`);
		for (const sql of statements) {
			expect(Buffer.byteLength(sql)).toBeLessThan(100000);
			expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK|PRAGMA|CREATE TEMP)\b/iu);
			expect(sql).not.toContain("sqlite_temp_master");
		}
		expect(statements.filter((sql) => /^CREATE TRIGGER/u.test(sql)).length).toBeGreaterThan(0);
	});
	it("executes the complete exported SQL atomically without splitting trigger bodies", () => {
		// Arrange
		const db = setup();
		const before = rawAuthSnapshot(db);
		// Act
		db.transaction(() => db.exec(AUTH_LIFECYCLE_UPGRADE_SQL)).immediate();
		// Assert
		expect(rawAuthSnapshot(db, before)).toEqual(before);
		expect(ready(db)).toEqual({ ready: 9 });
	});
	it("preserves browser sequence allocation and an unrelated sequence high-water mark", () => {
		// Arrange
		const db = setup();
		upgradeAuthLifecycleSchema(db);
		// Act
		db.prepare(`DELETE FROM ${browser} WHERE browser_sequence = ?`).run(7001);
		insert(db, browser, {
			coordinator_id: "synthetic-coordinator",
			browser_transaction_hash: hash(8),
			purpose: "signin",
			state_hash: hash(8),
			binder_hash: hash(8),
			issuer: "https://issuer.example.test",
			auth_config_revision: hash(0),
			redirect_uri: "http://127.0.0.1:1234/callback",
			state: "pending",
			nonce: "n".repeat(43),
			pkce_verifier: "p".repeat(43),
			created_at_ms: 0,
			expires_at_ms: 600000,
		});
		// Assert
		expect(
			db
				.prepare(`SELECT browser_sequence FROM ${browser} WHERE browser_transaction_hash = ?`)
				.get(hash(8)),
		).toEqual({ browser_sequence: 7002 });
		expect(
			db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get("unrelated_sequence"),
		).toEqual({ seq: 500 });
	});
	it("retains revoked genesis proofs but rejects new genesis, birth rewrites and security-barrier bypass", () => {
		// Arrange
		const db = setup();
		upgradeAuthLifecycleSchema(db);
		const proof = db.prepare(`SELECT * FROM ${claims} WHERE claim_id = ?`).get("link-1") as Record<
			string,
			unknown
		>;
		// Act
		const claim = () =>
			insert(db, claims, {
				...proof,
				claim_id: "new-claim",
				identity_id: "new-identity",
				device_id: "new-device",
				attempt_id: "new-attempt",
				key_id: hash(8),
			});
		const clearRevocation = () =>
			db.prepare(`UPDATE ${links} SET revoked_at_ms = NULL WHERE link_id = ?`).run("link-1");
		const rewriteBirth = () =>
			db.prepare(`UPDATE ${links} SET generation = 2 WHERE link_id = ?`).run("link-0");
		db.prepare(`UPDATE ${links} SET revoked_at_ms = ? WHERE link_id = ?`).run(3000, "link-0");
		const current = db.prepare(`SELECT * FROM ${links} WHERE link_id = ?`).get("link-0") as Record<
			string,
			unknown
		>;
		const bypass = () =>
			insert(db, links, {
				...current,
				link_id: "new-link",
				attempt_id: "new-attempt",
				generation: 2,
				revoked_at_ms: null,
			});
		// Assert
		expect(
			db
				.prepare(`SELECT revoked_at_ms FROM ${links} WHERE device_claim_id = ?`)
				.get(proof.claim_id),
		).toEqual({ revoked_at_ms: 2000 });
		expect(proof.public_key).toContain("\r\nexact-Ω-bytes\r\n");
		expect(claim).toThrow(/auth_device_claim_genesis_unavailable/);
		expect(clearRevocation).toThrow(/auth_account_link_immutable/);
		expect(rewriteBirth).toThrow(/auth_account_link_immutable/);
		expect(bypass).toThrow(/auth_account_link_unavailable/);
	});
});

describe("rejected upgrades retain their inputs", () => {
	it.each([
		"ALTER TABLE coordinator_auth_account_links ADD COLUMN unexpected TEXT",
		"CREATE INDEX unexpected_link_index ON coordinator_auth_account_links(subject)",
		"CREATE VIEW external_link_reader AS SELECT * FROM coordinator_auth_account_links",
		"CREATE TABLE coordinator_auth_account_links_lifecycle_upgrade (foreign_value TEXT)",
		"UPDATE coordinator_auth_account_links SET issuer = X'0000FF' WHERE link_id = 'link-0'",
		"UPDATE coordinator_auth_account_links SET rowid = 0 WHERE link_id = 'link-0'",
		"DROP TABLE coordinator_auth_account_profiles",
	])("rejects unrecognized input without changing schema or stored bytes: %s", (damage) => {
		// Arrange
		const db = setup();
		db.exec(damage);
		const before = databaseState(db);
		// Act
		const upgrade = () => upgradeAuthLifecycleSchema(db);
		// Assert
		expect(upgrade).toThrow(CoordinatorAuthLifecycleUpgradeRejectedError);
		expect(databaseState(db)).toEqual(before);
		expect(db.inTransaction).toBe(false);
	});
	it.each([
		"coordinator_auth_account_links",
		"coordinator_lifecycle_upgrade_checks",
		"unrelated_temp",
	])("rejects TEMP %s before preparing migration statements", (table) => {
		// Arrange
		const db = setup();
		db.exec(`CREATE TEMP TABLE ${table} (unexpected BLOB)`);
		const before = databaseState(db);
		const execute = vi.spyOn(db, "exec");
		const prepare = vi.spyOn(db, "prepare");
		// Act
		const upgrade = () => upgradeAuthLifecycleSchema(db);
		// Assert
		expect(upgrade).toThrow(CoordinatorAuthLifecycleUpgradeRejectedError);
		expect(execute).not.toHaveBeenCalled();
		expect(prepare.mock.calls[0]?.[0]).toBe("PRAGMA ignore_check_constraints");
		expect(prepare.mock.calls[1]?.[0]).toContain("sqlite_temp_master");
		expect(
			prepare.mock.calls.every(([sql]) =>
				/sqlite_temp_master|^PRAGMA (?:database_list|ignore_check_constraints)$/u.test(sql),
			),
		).toBe(true);
		expect(databaseState(db)).toEqual(before);
		expect(db.prepare("SELECT name FROM sqlite_temp_master WHERE name = ?").get(table)).toEqual({
			name: table,
		});
	});
	it("rejects attached databases without changing main or attached rows", () => {
		// Arrange
		const db = setup();
		db.exec(
			"ATTACH DATABASE ':memory:' AS external; CREATE TABLE external.retained (value TEXT); INSERT INTO external.retained VALUES ('unchanged')",
		);
		const before = databaseState(db);
		const execute = vi.spyOn(db, "exec");
		// Act
		const upgrade = () => upgradeAuthLifecycleSchema(db);
		// Assert
		expect(upgrade).toThrow(CoordinatorAuthLifecycleUpgradeRejectedError);
		expect(execute).not.toHaveBeenCalled();
		expect(databaseState(db)).toEqual(before);
		expect(db.prepare("SELECT * FROM external.retained").all()).toEqual([{ value: "unchanged" }]);
	});
	it("rejects a second V3 upgrade without rebuilding or exposing account values", () => {
		// Arrange
		const db = setup();
		upgradeAuthLifecycleSchema(db);
		const before = databaseState(db);
		// Act
		let error: unknown;
		try {
			upgradeAuthLifecycleSchema(db);
		} catch (caught) {
			error = caught;
		}
		// Assert
		expect(error).toBeInstanceOf(CoordinatorAuthLifecycleUpgradeRejectedError);
		expect(String(error)).not.toMatch(/subject-0|fixture@example|Display Ω|nnnnnn/);
		expect(databaseState(db)).toEqual(before);
	});
});

it.each([
	{ begin: "BEGIN", rollback: "ROLLBACK" },
	{ begin: "BEGIN IMMEDIATE", rollback: "ROLLBACK" },
	{ begin: "SAVEPOINT outer", rollback: "ROLLBACK TO outer; RELEASE outer" },
])("rejects caller-owned $begin before any database operation", ({ begin, rollback }) => {
	// Arrange: the caller's unrelated write and transaction must remain theirs to finish.
	const db = setup();
	const before = databaseState(db);
	db.exec(begin);
	insert(db, "unrelated_notes", { body: Buffer.from("caller-owned write") });
	const inside = databaseState(db);
	const execute = vi.spyOn(db, "exec");
	const prepare = vi.spyOn(db, "prepare");
	const transaction = vi.spyOn(db, "transaction");
	try {
		// Act
		const upgrade = () => upgradeAuthLifecycleSchema(db);
		// Assert
		expect(upgrade).toThrow(CoordinatorAuthLifecycleUpgradeRejectedError);
		expect(execute).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
		execute.mockRestore();
		prepare.mockRestore();
		transaction.mockRestore();
		expect(db.inTransaction).toBe(true);
		expect(databaseState(db)).toEqual(inside);
	} finally {
		execute.mockRestore();
		prepare.mockRestore();
		transaction.mockRestore();
		if (db.inTransaction) db.exec(rollback);
	}
	expect(db.inTransaction).toBe(false);
	expect(databaseState(db)).toEqual(before);
});

it.each(
	["wrapper", "portable"].flatMap((mode) =>
		[
			"CREATE INDEX unexpected_link_index ON coordinator_auth_account_links(subject)",
			"CREATE VIEW external_link_reader AS SELECT * FROM coordinator_auth_account_links",
		].map((damage) => ({ mode, damage })),
	),
)(
	"$mode rejects unsupported schema with CHECK enforcement disabled: $damage",
	({ mode, damage }) => {
		// Arrange: this connection setting must neither bypass assertions nor be silently reset.
		const db = setup();
		db.exec(damage);
		db.pragma("ignore_check_constraints = ON");
		const before = databaseState(db);
		const execute = vi.spyOn(db, "exec");
		// Act
		const upgrade = () => {
			if (mode === "wrapper") {
				upgradeAuthLifecycleSchema(db);
				return;
			}
			db.transaction(() => {
				for (const sql of AUTH_LIFECYCLE_UPGRADE_STATEMENTS) db.exec(sql);
			}).immediate();
		};
		// Assert: portable SQL's false assertion becomes NULL, so NOT NULL still aborts it.
		if (mode === "wrapper") {
			expect(upgrade).toThrow(CoordinatorAuthLifecycleUpgradeRejectedError);
			expect(execute).not.toHaveBeenCalled();
		} else expect(upgrade).toThrow(/NOT NULL constraint failed/);
		expect(db.pragma("ignore_check_constraints", { simple: true })).toBe(1);
		expect(databaseState(db)).toEqual(before);
		expect(db.inTransaction).toBe(false);
	},
);

it.each(["late failure", "copy corruption", "missing guard"])(
	"rolls back all schema, row and sequence changes after %s",
	(failure) => {
		// Arrange
		const db = setup();
		const before = databaseState(db);
		// Act: test-only failures, never a production callback or a weakened upgrade API.
		const upgrade = db.transaction(() => {
			for (const sql of AUTH_LIFECYCLE_UPGRADE_STATEMENTS) {
				if (
					failure === "missing guard" &&
					/^CREATE TRIGGER IF NOT EXISTS auth_sessions_insert_admission\b/u.test(sql)
				)
					continue;
				db.exec(sql);
				if (
					failure === "copy corruption" &&
					/^INSERT INTO "coordinator_auth_browser_transactions_lifecycle_upgrade"/u.test(sql)
				)
					db.prepare(
						"UPDATE coordinator_auth_browser_transactions_lifecycle_upgrade SET nonce = ? WHERE state = 'pending'",
					).run("x".repeat(43));
			}
			if (failure === "late failure")
				db.exec(
					"CREATE TABLE injected_assertion (passed INTEGER CHECK(passed = 1)); INSERT INTO injected_assertion VALUES (0)",
				);
		});
		// Assert
		expect(() => upgrade.immediate()).toThrow(/CHECK|NOT NULL/);
		expect(databaseState(db)).toEqual(before);
		expect(ready(db)).toEqual({ ready: 10 });
		expect(db.inTransaction).toBe(false);
	},
);
