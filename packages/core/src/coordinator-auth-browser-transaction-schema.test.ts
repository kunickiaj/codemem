import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AUTH_BROWSER_TXN_SCHEMA_SQL } from "./coordinator-auth-browser-transaction-contract.js";
import {
	seed,
	TABLE,
	transactionRows,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { backendTest, NOW } from "./coordinator-auth-link-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

function schema(db: Database.Database) {
	const indexes = db.prepare(`PRAGMA index_list(${TABLE})`).all() as { name: string }[];
	return {
		columns: db.prepare(`PRAGMA table_info(${TABLE})`).all(),
		indexes: indexes.map((index) => ({
			...index,
			columns: db.prepare("SELECT * FROM pragma_index_xinfo(?)").all(index.name),
			definition: db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(index.name),
		})),
		definition: db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(TABLE),
	};
}

for (const backend of ["SQLite", "D1"] as const satisfies readonly Backend[]) {
	describe(`${backend} browser transaction constraints`, () => {
		const test = backendTest(backend);
		test("fresh schema matches the shared SQL contract and excludes provider profile columns", async ({
			fixture: f,
		}) => {
			// Arrange
			const reference = new Database(":memory:");
			try {
				reference.exec(AUTH_BROWSER_TXN_SCHEMA_SQL);
				// Act
				const actual = schema(f.db);
				const expected = schema(reference);
				// Assert
				expect(actual.columns).toEqual(expected.columns);
				expect(actual.indexes).toEqual(expected.indexes);
				expect(actual.definition).toEqual(expected.definition);
				const names = (actual.columns as { name: string }[]).map((column) => column.name);
				for (const forbidden of [
					"raw_state",
					"account_subject",
					"profile",
					"access_token",
					"refresh_token",
					"id_token",
				])
					expect(names).not.toContain(forbidden);
			} finally {
				reference.close();
			}
		});
		test.for([
			"nonce = NULL",
			"pkce_verifier = NULL",
			"nonce = 'short'",
			"pkce_verifier = 'bad!'",
			"state = 'consumed', nonce = NULL, pkce_verifier = NULL",
			"state = 'consumed', nonce = NULL, pkce_verifier = NULL, claim_token = 'claim'",
			`state = 'consumed', nonce = NULL, pkce_verifier = NULL, consumed_at_ms = ${NOW}`,
			"state = 'expired', claim_token = 'claim', nonce = NULL, pkce_verifier = NULL",
			`expires_at_ms = ${NOW}`,
			`expires_at_ms = ${NOW + 600001}`,
			"created_at_ms = -1",
			"created_at_ms = 1.5",
			"created_at_ms = 9007199254740991",
			"purpose = 'link'",
			"attempt_id = 'attempt-a'",
			"state_hash = 'BAD'",
			"binder_hash = 'BAD'",
		])("SQL rejects invalid partial or timestamp update %s", async (assignment, { fixture: f }) => {
			// Arrange
			seed(f, 1);
			const before = transactionRows(f);
			// Act
			const update = () => f.db.exec(`UPDATE ${TABLE} SET ${assignment}`);
			// Assert
			expect(update).toThrow();
			expect(transactionRows(f)).toEqual(before);
		});
		test("SQL accepts a complete consume marker and enforces logical consume time", async ({
			fixture: f,
		}) => {
			// Arrange
			seed(f, 1);
			// Act
			f.db
				.prepare(
					`UPDATE ${TABLE} SET state = 'consumed', nonce = NULL, pkce_verifier = NULL, claim_token = 'claim', consumed_at_ms = ?`,
				)
				.run(NOW);
			const row = transactionRows(f)[0];
			// Assert
			expect(row).toMatchObject({
				state: "consumed",
				consumed_at_ms: NOW,
				nonce: null,
				pkce_verifier: null,
			});
			expect(() => f.db.prepare(`UPDATE ${TABLE} SET consumed_at_ms = ?`).run(NOW - 1)).toThrow();
			expect(() =>
				f.db.prepare(`UPDATE ${TABLE} SET consumed_at_ms = ?`).run(NOW + 600000),
			).toThrow();
		});
	});
}

it("migration 0020 matches the contract and applies twice without changing proof history", () => {
	// Arrange
	const directory = join(import.meta.dirname, "../../cloudflare-coordinator-worker/migrations");
	const migration = readFileSync(join(directory, "0020_add_auth_browser_transactions.sql"), "utf8");
	const purgeMigration = readFileSync(
		join(directory, "0023_add_auth_signin_purge_floors.sql"),
		"utf8",
	);
	const db = new Database(":memory:");
	const reference = new Database(":memory:");
	try {
		reference.exec(AUTH_BROWSER_TXN_SCHEMA_SQL);
		db.exec(migration);
		db.exec(purgeMigration);
		expect(schema(db)).toEqual(schema(reference));
		db.prepare(
			`INSERT INTO ${TABLE} (coordinator_id,browser_transaction_hash,purpose,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms) VALUES ('coordinator-a',?,'signin',?,?,'https://accounts.example.test',?,'https://coordinator.example.test/auth/callback','pending',?,?,?,?)`,
		).run(
			"1".repeat(64),
			"2".repeat(64),
			"3".repeat(64),
			"a".repeat(64),
			"n".repeat(43),
			"p".repeat(43),
			NOW,
			NOW + 600000,
		);
		const before = schema(db);
		const rowsBefore = db.prepare(`SELECT * FROM ${TABLE}`).all();
		// Act
		db.exec(migration);
		const after = schema(db);
		// Assert
		expect(after).toEqual(before);
		expect(db.prepare(`SELECT * FROM ${TABLE}`).all()).toEqual(rowsBefore);
		expect(
			(after.indexes as { name: string }[]).filter((index) =>
				index.name.startsWith("idx_auth_browser_txn_"),
			),
		).toHaveLength(2);
	} finally {
		db.close();
		reference.close();
	}
});

it.each([
	["CHECK-only", "expires_at_ms > created_at_ms", "expires_at_ms >= created_at_ms"],
	[
		"index-column order",
		"(coordinator_id, purpose, created_at_ms)",
		"(coordinator_id, created_at_ms, purpose)",
	],
])(
	"schema comparison detects %s drift without column or index-name changes",
	(_, before, after) => {
		const reference = new Database(":memory:");
		const mutant = new Database(":memory:");
		try {
			const changed = AUTH_BROWSER_TXN_SCHEMA_SQL.replace(before, after);
			expect(changed).not.toBe(AUTH_BROWSER_TXN_SCHEMA_SQL);
			reference.exec(AUTH_BROWSER_TXN_SCHEMA_SQL);
			mutant.exec(changed);
			expect(mutant.prepare(`PRAGMA table_info(${TABLE})`).all()).toEqual(
				reference.prepare(`PRAGMA table_info(${TABLE})`).all(),
			);
			expect(mutant.prepare(`PRAGMA index_list(${TABLE})`).all()).toEqual(
				reference.prepare(`PRAGMA index_list(${TABLE})`).all(),
			);
			expect(schema(mutant)).not.toEqual(schema(reference));
		} finally {
			reference.close();
			mutant.close();
		}
	},
);
