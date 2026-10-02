import { describe, expect } from "vitest";
import { expectRejected, snapshot } from "./coordinator-auth-link-test-fixtures.js";
import {
	backendTest,
	browserHash,
	credentialHash,
	expectIssued,
	grants,
	linked,
	otherCredentialHash,
	revokeLinkRow,
	type SessionTest,
	sessionRows,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

function registerSuccess(test: SessionTest) {
	test("known verified issuer and subject sign in directly without device approval", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const before = grants(f);
		const attempts = snapshot(f)[0];
		// Act
		const result = await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		// Assert
		expectIssued(result, f);
		expect(grants(f)).toEqual(before);
		expect(snapshot(f)[0]).toEqual(attempts);
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
		for (const forbidden of [
			credentialHash,
			"f".repeat(64),
			"credentialHash",
			"browserTransactionHash",
		])
			expect(JSON.stringify(result)).not.toContain(forbidden);
	});
	test("revision rotation accepts the old account link but binds the newly issued session to current config", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		const current = { ...f.cfg, revision: "2".repeat(64) };
		const before = grants(f);
		// Act
		const result = await f.store.signInWithAuthAccount(
			{
				...signInInput(f),
				browserTransactionHash: "3".repeat(64),
				credentialHash: otherCredentialHash,
			},
			current,
		);
		const oldSession = await f.store.readAuthSession(credentialHash, current);
		const newSession = await f.store.readAuthSession(otherCredentialHash, current);
		// Assert
		expectIssued(result, f);
		expect(oldSession).toBeNull();
		expect(newSession).toMatchObject({ identityId: "identity-a" });
		expect(grants(f)).toEqual(before);
		expect(
			f.db
				.prepare("SELECT auth_config_revision FROM coordinator_auth_sessions ORDER BY rowid")
				.all(),
		).toEqual([
			{ auth_config_revision: f.cfg.revision },
			{ auth_config_revision: current.revision },
		]);
	});
	test("literal opaque subjects and coordinator identifiers remain bound parameters", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const coordinatorId = "coord' OR 1=1 --";
		const subject = "sub' UNION SELECT secret --";
		f.db
			.prepare("UPDATE coordinator_auth_account_links SET coordinator_id = ?, subject = ?")
			.run(coordinatorId, subject);
		const cfg = { ...f.cfg, coordinatorId };
		const input = { ...signInInput(f), account: { issuer: cfg.issuer, subject } };
		// Act
		const issued = await f.store.signInWithAuthAccount(input, cfg);
		const wrongScope = await f.store.readAuthSession(credentialHash, f.cfg);
		const ownScope = await f.store.readAuthSession(credentialHash, cfg);
		// Assert
		expect(issued.kind).toBe("issued");
		expect(wrongScope).toBeNull();
		expect(ownScope?.account.subject).toBe(subject);
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
	});
	test("sign-in ignores profile roles, email, default actor and device claims", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const before = grants(f);
		const input = {
			...signInInput(f),
			identityId: "attacker",
			defaultActor: "attacker",
			email: "admin@example.test",
			roles: ["admin"],
			signer: { deviceId: "attacker" },
			profile: { sub: "attacker" },
			rawCredential: "fixture-only-secret",
		};
		// Act
		const result = await f.store.signInWithAuthAccount(input, f.cfg);
		// Assert
		expectIssued(result, f);
		expect(grants(f)).toEqual(before);
		expect(JSON.stringify(sessionRows(f))).not.toContain("fixture-only-secret");
		expect(JSON.stringify(sessionRows(f))).not.toContain("attacker");
	});
}

function registerDenials(test: SessionTest) {
	test.for(["unknown", "revoked", "wrong-issuer", "disabled"] as const)(
		"rejects %s sign-in with no writes",
		async (change, { fixture: f }) => {
			// Arrange
			await linked(f);
			const input = signInInput(f);
			if (change === "unknown") input.account.subject = "unknown-subject";
			if (change === "wrong-issuer") input.account.issuer = "https://other.example.test";
			if (change === "revoked") revokeLinkRow(f);
			const before = grants(f);
			// Act
			const result = await f.store.signInWithAuthAccount(input, {
				...f.cfg,
				enabled: change !== "disabled",
			});
			// Assert
			const errors = {
				"wrong-issuer": "invalid_input",
				disabled: "auth_config_changed",
				unknown: "account_not_linked",
				revoked: "account_not_linked",
			};
			const error = errors[change];
			expectRejected(result, error);
			expect(grants(f)).toEqual(before);
			expect(sessionRows(f)).toEqual([[], []]);
		},
	);
	test("the browser transaction reserved by linking cannot be used for normal sign-in", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		// Act
		const result = await f.store.signInWithAuthAccount(
			{ ...signInInput(f), browserTransactionHash: browserHash },
			f.cfg,
		);
		// Assert
		expectRejected(result, "browser_transaction_used");
		expect(sessionRows(f)).toEqual([[], []]);
	});
	test.for([credentialHash, otherCredentialHash])(
		"normal browser replay with %s is always consumed",
		async (hash, { fixture: f }) => {
			// Arrange
			await linked(f);
			await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
			const before = sessionRows(f);
			// Act
			const result = await f.store.signInWithAuthAccount(
				{ ...signInInput(f), credentialHash: hash },
				f.cfg,
			);
			// Assert
			expectRejected(result, "browser_transaction_used");
			expect(sessionRows(f)).toEqual(before);
		},
	);
	test("concurrent sign-in commits exactly one receipt and one session", async ({ fixture: f }) => {
		// Arrange
		await linked(f);
		// Act
		const results = await Promise.all([
			f.store.signInWithAuthAccount(signInInput(f), f.cfg),
			f.store.signInWithAuthAccount(
				{ ...signInInput(f), credentialHash: otherCredentialHash },
				f.cfg,
			),
		]);
		// Assert
		expect(results.filter((result) => result.kind === "issued")).toHaveLength(1);
		expect(results).toContainEqual({ kind: "rejected", error: "browser_transaction_used" });
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
	});
	test("sign-in session insert failure rolls back its receipt and does not reveal backend details", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const before = snapshot(f);
		f.db.exec(
			"CREATE TRIGGER fixture_signin_fault BEFORE INSERT ON coordinator_auth_sessions BEGIN SELECT RAISE(ABORT, 'fixture-private-backend-detail'); END",
		);
		// Act
		const result = f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		// Assert
		await expect(result).rejects.toThrow(/^auth_session_persistence_error$/);
		expect(snapshot(f)).toEqual(before);
		expect(sessionRows(f)).toEqual([[], []]);
	});
}

function registerBackend(backend: Backend) {
	const test = backendTest(backend);
	registerSuccess(test);
	registerDenials(test);
}
describe.each(["SQLite", "D1"] as const)(
	"%s auth-session verified account sign-in (D1 is SQLite-backed)",
	registerBackend,
);
