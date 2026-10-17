import { describe, expect } from "vitest";
import {
	materials,
	transactionRows,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	advance,
	attempt,
	authorize,
	backendTest,
	browserHash,
	browserProofConfig,
	consumeSigninProof,
	expectRejected,
	NOW,
	rows,
	snapshot,
	startBrowserProof,
	TABLES,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";
import {
	credentialHash,
	expectIssued,
	freshBrowserHash,
	grants,
	linked,
	redeemInput,
	sessionRows,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";

function pendingAttempt() {
	return attempt({ browserStartHash: "2".repeat(64) });
}

type Test = ReturnType<typeof backendTest>;
function registerAdvance(test: Test) {
	test.for(["browser_claimed", "oidc_verified", "confirmed", "finalized"])(
		"advance to %s retains consumed matching V2 browser evidence",
		async (state, { fixture: f }) => {
			// Arrange: the provider claims below are trusted synthetic store inputs, not JWTs.
			await authorize(f);
			const input = attempt();
			const original = structuredClone(input);
			// Act
			await advance(f, state, input);
			const source = rows(f, TABLES[0])[0];
			const browser = transactionRows(f)[0];
			// Assert: the helper does not change caller authority or nominate another hash.
			expect(input).toEqual(original);
			expect(source).toMatchObject({
				state,
				attempt_id: input.attemptId,
				authority_kind: input.authority.kind,
				browser_start_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
				browser_transaction_hash: browserHash,
				created_at_ms: NOW,
				claimed_at_ms: NOW,
				oidc_verified_at_ms: state === "browser_claimed" ? null : NOW,
				confirmed_at_ms: ["confirmed", "finalized"].includes(state) ? NOW : null,
				finalized_at_ms: state === "finalized" ? NOW : null,
			});
			expect(browser).toMatchObject({
				coordinator_id: source.coordinator_id,
				attempt_id: source.attempt_id,
				browser_transaction_hash: source.browser_transaction_hash,
				issuer: source.issuer,
				auth_config_revision: source.auth_config_revision,
				purpose: "link",
				state: "consumed",
				nonce: null,
				pkce_verifier: null,
				claim_token: expect.any(String),
				created_at_ms: NOW,
				consumed_at_ms: NOW,
				expires_at_ms: source.expires_at_ms,
			});
			expect(Number(browser.consumed_at_ms)).toBeLessThan(Number(browser.expires_at_ms));
			expect(browser).not.toHaveProperty("browser_sequence");
			expect(sessionRows(f)).toEqual([[], []]);
		},
	);
}

function registerBirth(test: Test) {
	test("birth and claim persist pending material before consumption erases the secrets", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		const input = pendingAttempt();
		await f.store.createAuthLinkAttempt(input, f.cfg);
		const config = browserProofConfig(f);
		// Act
		const proof = await startBrowserProof(f, {
			attemptId: input.attemptId,
			browserStartHash: input.browserStartHash,
			browserTransactionHash: browserHash,
		});
		const pending = transactionRows(f)[0];
		f.now += 1;
		const result = await f.store.consumeAuthBrowserTransaction(proof, config);
		// Assert
		expect(pending).toMatchObject({
			state: "pending",
			purpose: "link",
			attempt_id: input.attemptId,
			state_hash: proof.stateHash,
			binder_hash: proof.binderHash,
			nonce: proof.nonce,
			pkce_verifier: proof.pkceVerifier,
			claim_token: null,
			consumed_at_ms: null,
		});
		expect(result).toEqual({
			kind: "consumed",
			purpose: "link",
			attemptId: input.attemptId,
			browserTransactionHash: browserHash,
			nonce: proof.nonce,
			pkceVerifier: proof.pkceVerifier,
		});
		expect(transactionRows(f)[0]).toMatchObject({
			state: "consumed",
			nonce: null,
			pkce_verifier: null,
			claim_token: expect.any(String),
			consumed_at_ms: NOW + 1,
			created_at_ms: NOW,
			expires_at_ms: NOW + TTL,
		});
	});

	test("wrong start commitment cannot claim the prepared attempt", async ({ fixture: f }) => {
		// Arrange
		await authorize(f);
		const input = pendingAttempt();
		await f.store.createAuthLinkAttempt(input, f.cfg);
		const before = snapshot(f);
		// Act
		const result = await f.store.startAuthBrowserTransaction(
			{
				...materials(),
				purpose: "link",
				attemptId: input.attemptId,
				browserStartHash: "3".repeat(64),
			},
			browserProofConfig(f),
		);
		// Assert
		expectRejected(result, "attempt_unavailable");
		expect(snapshot(f)).toEqual(before);
		expect(transactionRows(f)).toEqual([]);
	});
}

function registerIsolation(test: Test) {
	test("wrong binder and replay cannot consume a prepared browser proof", async ({
		fixture: f,
	}) => {
		// Arrange
		const config = browserProofConfig(f);
		const proof = await startBrowserProof(f, { browserTransactionHash: freshBrowserHash });
		const pending = transactionRows(f);
		// Act
		const wrong = await f.store.consumeAuthBrowserTransaction(
			{
				stateHash: proof.stateHash,
				binderHash: "0".repeat(64),
			},
			config,
		);
		const afterWrong = transactionRows(f);
		const first = await f.store.consumeAuthBrowserTransaction(proof, config);
		const consumed = transactionRows(f);
		const replay = await f.store.consumeAuthBrowserTransaction(proof, config);
		// Assert
		expectRejected(wrong, "transaction_unavailable");
		expect(afterWrong).toEqual(pending);
		expect(first).toMatchObject({ kind: "consumed", browserTransactionHash: freshBrowserHash });
		expectRejected(replay, "transaction_unavailable");
		expect(transactionRows(f)).toEqual(consumed);
	});

	test("distinct attempts keep unique proof keys and explicit browser hash overrides", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		const otherHash = "9".repeat(64);
		// Act
		await advance(f, "oidc_verified");
		await advance(
			f,
			"oidc_verified",
			attempt({
				attemptId: "attempt-b",
				runtimeVerifierHash: "8".repeat(64),
			}),
			otherHash,
		);
		const browsers = transactionRows(f);
		const attempts = rows(f, TABLES[0]);
		// Assert
		expect(browsers).toHaveLength(2);
		for (const key of ["state_hash", "binder_hash", "claim_token"]) {
			expect(new Set(browsers.map((row) => row[key])).size).toBe(2);
		}
		expect(new Set(attempts.map((row) => row.browser_start_hash)).size).toBe(2);
		expect(browsers.find((row) => row.attempt_id === "attempt-a")?.browser_transaction_hash).toBe(
			browserHash,
		);
		expect(browsers.find((row) => row.attempt_id === "attempt-b")?.browser_transaction_hash).toBe(
			otherHash,
		);
		expect(attempts.find((row) => row.attempt_id === "attempt-b")?.runtime_verifier_hash).toBe(
			"8".repeat(64),
		);
	});
}

function registerSessions(test: Test) {
	test("linked redemption inserts its receipt before its session without new grants", async ({
		fixture: f,
	}) => {
		// Arrange: assert the existing receipt-first insertion order at the session boundary.
		await linked(f);
		const authority = grants(f);
		f.db.exec(`CREATE TRIGGER fixture_receipt_first BEFORE INSERT ON coordinator_auth_sessions
			WHEN NOT EXISTS (SELECT 1 FROM coordinator_auth_session_receipts r
			 WHERE r.coordinator_id = NEW.coordinator_id AND r.browser_transaction_hash = NEW.browser_transaction_hash)
			BEGIN SELECT RAISE(ABORT, 'fixture_missing_receipt'); END`);
		// Act
		const result = await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
		// Assert
		expectIssued(result, f);
		expect(sessionRows(f).map((values) => values.length)).toEqual([1, 1]);
		expect(sessionRows(f)[0][0]).toMatchObject({
			browser_transaction_hash: browserHash,
			source: "link_redeem",
		});
		expect(grants(f)).toEqual(authority);
	});

	test("a caller-selected wrong redemption hash stays wrong despite valid fixture proof", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const before = transactionRows(f);
		const input = { ...redeemInput(), browserTransactionHash: "0".repeat(64) };
		// Act
		const result = await f.store.redeemAuthLinkSession(input, f.cfg);
		// Assert
		expectRejected(result, "attempt_unavailable");
		expect(input.browserTransactionHash).toBe("0".repeat(64));
		expect(transactionRows(f)).toEqual(before);
		expect(sessionRows(f)).toEqual([[], []]);
	});

	test("fresh signin proof carries current config without changing the existing link", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const authority = grants(f);
		const config = { ...browserProofConfig(f), revision: "4".repeat(64) };
		const hash = "5".repeat(64);
		// Act
		await consumeSigninProof(f, hash, config);
		const result = await f.store.signInWithConsumedBrowserTransaction(
			{
				...signInInput(f),
				browserTransactionHash: hash,
			},
			config,
		);
		// Assert
		expectIssued(result, f);
		expect(transactionRows(f).find((row) => row.browser_transaction_hash === hash)).toMatchObject({
			purpose: "signin",
			attempt_id: null,
			state: "consumed",
			auth_config_revision: config.revision,
			nonce: null,
			pkce_verifier: null,
		});
		expect(await f.store.readAuthSession(credentialHash, config)).not.toBeNull();
		expect(await f.store.readAuthSession(credentialHash, f.cfg)).toBeNull();
		expect(grants(f)).toEqual(authority);
	});
}

describe.each(["SQLite", "D1"] as const)("%s synthetic browser evidence fixtures", (backend) => {
	const test = backendTest(backend);
	registerAdvance(test);
	registerBirth(test);
	registerIsolation(test);
	registerSessions(test);
});
