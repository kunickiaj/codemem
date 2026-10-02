import { describe, expect } from "vitest";
import {
	advance,
	authorize,
	expectRejected,
	finalize,
	snapshot,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";
import {
	backendTest,
	browserHash,
	credentialHash,
	expectIssued,
	grants,
	linked,
	otherCredentialHash,
	REDEEM_WINDOW,
	redeemInput,
	revokeLinkRow,
	type SessionTest,
	sessionRows,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

function registerSuccess(test: SessionTest) {
	test("redeems the original browser once without credentials or new device grants", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const before = grants(f);
		// Act
		const result = await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
		const retry = await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
		// Assert
		expectIssued(result, f);
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
		expect(grants(f)).toEqual(before);
		expect(f.db.prepare("SELECT state FROM coordinator_auth_link_attempts").get()).toEqual({
			state: "session_redeemed",
		});
		expect(retry.kind).toBe("existing");
		for (const forbidden of [
			credentialHash,
			browserHash,
			"credentialHash",
			"browserTransactionHash",
			"rawCredential",
			"profile",
			"accessToken",
		])
			expect(JSON.stringify(result)).not.toContain(forbidden);
	});
	test.for([credentialHash, otherCredentialHash])(
		"replay with credential %s never returns a prior session",
		async (hash, { fixture: f }) => {
			// Arrange
			await linked(f);
			await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
			const before = sessionRows(f);
			// Act
			const replay = await f.store.redeemAuthLinkSession(
				{ ...redeemInput(), credentialHash: hash },
				f.cfg,
			);
			const fresh = await f.store.signInWithAuthAccount(
				{ ...signInInput(f), credentialHash: otherCredentialHash },
				f.cfg,
			);
			// Assert
			expectRejected(replay, "browser_transaction_used");
			expectIssued(fresh, f);
			expect(sessionRows(f).map((rows) => rows.length)).toEqual([2, 2]);
			expect(sessionRows(f)[0][0]).toEqual(before[0][0]);
		},
	);
	test("concurrent redemption has one winner and one consumed-browser denial", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		// Act
		const results = await Promise.all([
			f.store.redeemAuthLinkSession(redeemInput(), f.cfg),
			f.store.redeemAuthLinkSession(
				{ ...redeemInput(), credentialHash: otherCredentialHash },
				f.cfg,
			),
		]);
		// Assert
		expect(results.filter((result) => result.kind === "issued")).toHaveLength(1);
		expect(results).toContainEqual({ kind: "rejected", error: "browser_transaction_used" });
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
	});
	test("issuance does not use the SQLite changes scalar as authority", async ({ fixture: f }) => {
		// Arrange
		await linked(f);
		f.db.function("changes", () => 0);
		// Act
		const result = await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
		// Assert
		expectIssued(result, f);
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
	});
}

function registerDeadlines(test: SessionTest) {
	test.for([REDEEM_WINDOW - 1, REDEEM_WINDOW, REDEEM_WINDOW + 1])(
		"redemption window at offset %s",
		async (offset, { fixture: f }) => {
			// Arrange
			await linked(f);
			f.now += offset;
			const before = snapshot(f);
			// Act
			const result = await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
			// Assert
			if (offset < REDEEM_WINDOW) {
				expectIssued(result, f);
				return;
			}
			expectRejected(result, "redeem_window_expired");
			expect(snapshot(f)).toEqual(before);
			expect(sessionRows(f)).toEqual([[], []]);
		},
	);
	test.for([29_999, 30_000])(
		"late finalization retains original deadline at offset %s",
		async (offset, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "confirmed");
			f.now += TTL - 30_000;
			await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
			f.now += offset;
			// Act
			const result = await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
			// Assert
			if (offset < 30_000) {
				expectIssued(result, f);
				return;
			}
			expectRejected(result, "redeem_window_expired");
			expect(sessionRows(f)).toEqual([[], []]);
		},
	);
	test("cannot redeem before finalization time", async ({ fixture: f }) => {
		// Arrange
		await linked(f);
		f.now -= 1;
		const before = snapshot(f);
		// Act
		const result = await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
		// Assert
		expectRejected(result, "attempt_unavailable");
		expect(snapshot(f)).toEqual(before);
		expect(sessionRows(f)).toEqual([[], []]);
	});
}

function registerDenials(test: SessionTest) {
	test.for(["wrong-browser", "missing-attempt", "revoked-link", "confirmed"] as const)(
		"rejects %s without consuming the attempt",
		async (change, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, change === "confirmed" ? "confirmed" : "finalized");
			if (change === "revoked-link") revokeLinkRow(f);
			const input = redeemInput();
			if (change === "wrong-browser") input.browserTransactionHash = "2".repeat(64);
			if (change === "missing-attempt") input.attemptId = "missing";
			const before = snapshot(f);
			// Act
			const result = await f.store.redeemAuthLinkSession(input, f.cfg);
			// Assert
			expectRejected(result, "attempt_unavailable");
			expect(snapshot(f)).toEqual(before);
			expect(sessionRows(f)).toEqual([[], []]);
		},
	);
	test.for([
		{ revision: "2".repeat(64) },
		{ issuer: "https://other.example.test" },
		{ enabled: false },
	])("rejects config drift %j without writes", async (change, { fixture: f }) => {
		// Arrange
		await linked(f);
		const before = snapshot(f);
		// Act
		const result = await f.store.redeemAuthLinkSession(redeemInput(), { ...f.cfg, ...change });
		// Assert
		expectRejected(result, "auth_config_changed");
		expect(snapshot(f)).toEqual(before);
		expect(sessionRows(f)).toEqual([[], []]);
	});
	test.for(["session-insert", "attempt-update"] as const)(
		"rolls back receipt, session and attempt after %s fault",
		async (fault, { fixture: f }) => {
			// Arrange
			await linked(f);
			const before = snapshot(f);
			const target =
				fault === "session-insert"
					? "BEFORE INSERT ON coordinator_auth_sessions"
					: "BEFORE UPDATE OF state ON coordinator_auth_link_attempts WHEN NEW.state = 'session_redeemed'";
			f.db.exec(
				`CREATE TRIGGER fixture_session_fault ${target} BEGIN SELECT RAISE(ABORT, 'fixture-private-backend-detail'); END`,
			);
			// Act
			const result = f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
			// Assert
			await expect(result).rejects.toThrow(/^auth_session_persistence_error$/);
			expect(snapshot(f)).toEqual(before);
			expect(sessionRows(f)).toEqual([[], []]);
		},
	);
}

function registerBackend(backend: Backend) {
	const test = backendTest(backend);
	registerSuccess(test);
	registerDeadlines(test);
	registerDenials(test);
}
describe.each(["SQLite", "D1"] as const)(
	"%s auth-session redemption (D1 is SQLite-backed)",
	registerBackend,
);
