import { expect } from "vitest";
import type { SchemaFixture } from "./coordinator-auth-browser-migration-test-harness.js";
import type { CoordinatorAuthBrowserTransactionStartInput } from "./coordinator-auth-browser-transaction-contract.js";
import { browserConfig, materials } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { attempt, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { enroll, review, type Store } from "./coordinator-auth-store-test-fixtures.js";

export async function assertReservedOwnerPurposeIsolation(f: SchemaFixture & { store: Store }) {
	// Arrange: a genuine live link with the same attempt/hash must not confer link purpose.
	const input = materials();
	await enroll(f.store);
	expect((await f.store.createAuthControllerAttestation(review())).kind).toBe("created");
	expect(
		(await f.store.createAuthLinkAttempt(attempt({ attemptId: "owner-attempt-a" }), browserConfig))
			.kind,
	).toBe("created");
	expect(
		(
			await f.store.claimAuthLinkAttempt(
				{ attemptId: "owner-attempt-a", browserTransactionHash: "9".repeat(64) },
				browserConfig,
			)
		).kind,
	).toBe("applied");
	await f.exec(
		`INSERT INTO coordinator_auth_browser_transactions
 (coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms)
 VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
		browserConfig.coordinatorId,
		"9".repeat(64),
		"owner_enroll",
		"owner-attempt-a",
		input.stateHash,
		input.binderHash,
		browserConfig.issuer,
		browserConfig.revision,
		browserConfig.redirectUri,
		input.nonce,
		input.pkceVerifier,
		NOW,
		NOW + 600000,
	);
	const before = await f.query("SELECT * FROM coordinator_auth_browser_transactions");
	const links = await f.query("SELECT * FROM coordinator_auth_link_attempts");
	// Act
	const start = await f.store.startAuthBrowserTransaction(
		{ ...input, purpose: "owner_enroll" } as unknown as CoordinatorAuthBrowserTransactionStartInput,
		browserConfig,
	);
	const consume = await f.store.consumeAuthBrowserTransaction(input, browserConfig);
	const resolve = await f.store.resolveAuthLinkBrowserTransaction(
		{ attemptId: "owner-attempt-a", binderHash: input.binderHash },
		browserConfig,
	);
	// Assert: neither link matching nor consumption may use the reserved purpose.
	expect(start).toEqual({ kind: "rejected", error: "invalid_input" });
	expect(consume).toEqual({ kind: "rejected", error: "transaction_unavailable" });
	expect(resolve).toBeNull();
	expect(await f.query("SELECT * FROM coordinator_auth_browser_transactions")).toEqual(before);
	expect(await f.query("SELECT * FROM coordinator_auth_link_attempts")).toEqual(links);
	await assertLegacyRetirementIsolation(f, before);
	await assertOwnerGlobalExpiry(f);
	await assertNoAuthority(f);
}

async function assertNoAuthority(f: SchemaFixture) {
	for (const table of [
		"coordinator_auth_sessions",
		"coordinator_auth_account_links",
		"coordinator_device_ownership_bindings",
	])
		expect(await f.query(`SELECT * FROM ${table}`)).toEqual([]);
}

async function assertOwnerGlobalExpiry(f: SchemaFixture & { store: Store }) {
	// Arrange: preserve a live owner control beside one expired, still-pending owner row.
	const live = await f.query(
		"SELECT * FROM coordinator_auth_browser_transactions WHERE attempt_id = 'owner-attempt-a'",
	);
	await f.exec(
		`INSERT INTO coordinator_auth_browser_transactions
	(coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms)
	SELECT coordinator_id,?,purpose,'expired-owner-attempt',?,?,issuer,auth_config_revision,redirect_uri,'pending',nonce,pkce_verifier,?,?
	FROM coordinator_auth_browser_transactions WHERE attempt_id = 'owner-attempt-a'`,
		"a".repeat(64),
		"b".repeat(64),
		"c".repeat(64),
		NOW - 600000,
		NOW,
	);
	const expired = await f.query(
		"SELECT * FROM coordinator_auth_browser_transactions WHERE attempt_id = 'expired-owner-attempt'",
	);
	// Act: global expiry clears only already-expired secrets, with a one-row batch.
	const result = await f.store.maintainAuthBrowserTransactions(
		{ coordinatorId: browserConfig.coordinatorId },
		{ limit: 1 },
	);
	// Assert: the row and all birth facts survive; live owner material is unchanged.
	expect(result).toEqual({ kind: "maintained", processedCount: 1, more: true });
	expect(
		await f.query(
			"SELECT * FROM coordinator_auth_browser_transactions WHERE attempt_id = 'expired-owner-attempt'",
		),
	).toEqual(expired.map((row) => ({ ...row, state: "expired", nonce: null, pkce_verifier: null })));
	expect(
		await f.query(
			"SELECT * FROM coordinator_auth_browser_transactions WHERE attempt_id = 'owner-attempt-a'",
		),
	).toEqual(live);
}

async function assertLegacyRetirementIsolation(
	f: SchemaFixture & { store: Store },
	before: Record<string, unknown>[],
) {
	// Arrange: ordinary signin is a positive retirement control; disabled config retires it.
	await f.exec(
		`INSERT INTO coordinator_auth_browser_transactions
	(coordinator_id,browser_transaction_hash,purpose,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms)
	SELECT coordinator_id,?,'signin',?,?,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms
	FROM coordinator_auth_browser_transactions WHERE purpose='owner_enroll' AND attempt_id='owner-attempt-a'`,
		"8".repeat(64),
		"7".repeat(64),
		"6".repeat(64),
	);
	// Act: both targeted and global legacy maintenance must preserve owner material.
	const targeted = await f.store.retireAuthBrowserTransactions(
		{ ...browserConfig, enabled: false },
		{ attemptId: "owner-attempt-a" },
	);
	const global = await f.store.retireAuthBrowserTransactions({ ...browserConfig, enabled: false });
	// Assert
	expect(targeted).toMatchObject({ kind: "retired", processedCount: 0 });
	expect(global).toMatchObject({ kind: "retired", processedCount: 1 });
	expect(
		await f.query(
			"SELECT * FROM coordinator_auth_browser_transactions WHERE purpose = 'owner_enroll'",
		),
	).toEqual(before.filter((row) => row.purpose === "owner_enroll"));
	expect(
		await f.query(
			"SELECT state,nonce,pkce_verifier FROM coordinator_auth_browser_transactions WHERE purpose = 'signin' AND state_hash = '7777777777777777777777777777777777777777777777777777777777777777'",
		),
	).toEqual([{ state: "expired", nonce: null, pkce_verifier: null }]);
}
