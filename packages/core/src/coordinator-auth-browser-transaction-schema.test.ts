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
	return {
		columns: db.prepare(`PRAGMA table_info(${TABLE})`).all(),
		indexes: db.prepare(`PRAGMA index_list(${TABLE})`).all(),
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

it("migration 0020 applies twice without changing existing proof history", () => {
	// Arrange
	const directory = join(import.meta.dirname, "../../cloudflare-coordinator-worker/migrations");
	const migration = readFileSync(join(directory, "0020_add_auth_browser_transactions.sql"), "utf8");
	const db = new Database(":memory:");
	try {
		db.exec(migration);
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
	}
});
