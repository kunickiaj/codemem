import { describe, expect, vi } from "vitest";
import { expectRejected, snapshot } from "./coordinator-auth-link-test-fixtures.js";
import {
	backendTest,
	credentialHash,
	expectIssued,
	linked,
	otherCredentialHash,
	redeemInput,
	type SessionTest,
	sessionRows,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

function registerPersistence(test: SessionTest) {
	test.for(["redeem", "signin"] as const)(
		"%s committed write followed by failed read never reports issued or recovers a credential on replay",
		async (operation, { fixture: f }) => {
			// Arrange
			await linked(f);
			const prepare = f.db.prepare.bind(f.db);
			let failedReads = 0;
			const spy = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
				if (sql.startsWith("SELECT session_id FROM coordinator_auth_session_receipts")) {
					failedReads += 1;
					throw new Error("fixture-private-read-secret");
				}
				return prepare(sql);
			});
			try {
				// Act
				const result =
					operation === "redeem"
						? f.store.redeemAuthLinkSession(redeemInput(), f.cfg)
						: f.store.signInWithAuthAccount(signInInput(f), f.cfg);
				// Assert
				await expect(result).rejects.toThrow(/^auth_session_persistence_error$/);
				expect(failedReads).toBe(1);
				expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
			} finally {
				spy.mockRestore();
			}
			// Act: a lost response cannot turn into credential recovery.
			const retry =
				operation === "redeem"
					? await f.store.redeemAuthLinkSession(
							{ ...redeemInput(), credentialHash: otherCredentialHash },
							f.cfg,
						)
					: await f.store.signInWithAuthAccount(
							{ ...signInInput(f), credentialHash: otherCredentialHash },
							f.cfg,
						);
			// Assert
			expectRejected(retry, "browser_transaction_used");
			expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
		},
	);
	test("read backend failure is generic, not a logged-out result, and does not mutate data", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		const before = sessionRows(f);
		const spy = vi.spyOn(f.db, "prepare").mockImplementation(() => {
			throw new Error("fixture-private-read-secret");
		});
		try {
			// Act
			const result = f.store.readAuthSession(credentialHash, f.cfg);
			// Assert
			await expect(result).rejects.toThrow(/^auth_session_persistence_error$/);
		} finally {
			spy.mockRestore();
		}
		expect(sessionRows(f)).toEqual(before);
	});
	test("a swallowed session insert cannot return an issued DTO from an incomplete receipt", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		f.db.exec(
			"CREATE TRIGGER fixture_incomplete BEFORE INSERT ON coordinator_auth_sessions BEGIN SELECT RAISE(IGNORE); END",
		);
		// Act
		const result = f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		// Assert
		await expect(result).rejects.toThrow(/^auth_session_persistence_incomplete$/);
		expect(sessionRows(f)[1]).toEqual([]);
	});
	test("normal sign-in succeeds even when changes scalar always reports zero", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		f.db.function("changes", () => 0);
		// Act
		const result = await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		// Assert
		expectIssued(result, f);
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
	});
	test("credential collision on a fresh browser fails atomically instead of claiming the old session", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		const before = sessionRows(f);
		const links = snapshot(f);
		// Act
		const result = f.store.signInWithAuthAccount(
			{ ...signInInput(f), browserTransactionHash: "2".repeat(64) },
			f.cfg,
		);
		// Assert
		await expect(result).rejects.toThrow(/^auth_session_persistence_error$/);
		expect(sessionRows(f)).toEqual(before);
		expect(snapshot(f)).toEqual(links);
	});
}
function registerBackend(backend: Backend) {
	registerPersistence(backendTest(backend));
}
describe.each(["SQLite", "D1"] as const)(
	"%s auth-session persistence faults (D1 is SQLite-backed)",
	registerBackend,
);
