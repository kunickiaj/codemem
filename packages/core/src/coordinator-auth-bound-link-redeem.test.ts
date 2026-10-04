import { describe, expect } from "vitest";
import {
	browserConfig,
	hash,
	materials,
	TABLE,
	transactionRows,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	attempt,
	authorize,
	completionHash,
	expectRejected,
	finalize,
	type LinkFixture,
	snapshot,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";
import { AuthSessionOperations } from "./coordinator-auth-session.js";
import {
	backendTest,
	credentialHash,
	expectIssued,
	grants,
	REDEEM_WINDOW,
	SESSION_TTL,
	type SessionTest,
	sessionRows,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";
import { sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

// Trusted persistence metadata only; no provider, cookie, route or signature verification.
async function ready(f: LinkFixture, options: { late?: boolean } = {}) {
	await authorize(f);
	expect(await f.store.createAuthLinkAttempt(attempt(), f.cfg)).toMatchObject({ kind: "created" });
	const proof = { ...materials(), purpose: "link" as const, attemptId: "attempt-a" };
	expect(await f.store.startAuthBrowserTransaction(proof, browserConfig)).toMatchObject({
		kind: "started",
	});
	const consumed = await f.store.consumeAuthBrowserTransaction(proof, browserConfig);
	expect(consumed.kind).toBe("consumed");
	if (consumed.kind !== "consumed") throw new Error("fixture_not_consumed");
	const browser = {
		attemptId: proof.attemptId,
		browserTransactionHash: consumed.browserTransactionHash,
	};
	expect(
		await f.store.recordAuthLinkOidcVerified(
			{ ...browser, account: { issuer: f.cfg.issuer, subject: "opaque-subject-a" } },
			f.cfg,
		),
	).toMatchObject({ kind: "applied" });
	expect(
		await f.store.confirmAuthLinkAttempt(
			{ ...browser, completionSecretHash: completionHash },
			f.cfg,
		),
	).toMatchObject({ kind: "applied" });
	if (options.late) f.now += TTL - 30_000;
	expect(await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg)).toMatchObject({
		kind: "applied",
	});
	return { ...browser, binderHash: proof.binderHash, credentialHash };
}

function authority(f: LinkFixture) {
	return {
		links: snapshot(f),
		grants: grants(f),
		sessions: sessionRows(f),
		browsers: transactionRows(f),
	};
}
function peer(f: LinkFixture) {
	return new D1CoordinatorStore(sqliteD1(f.db), { authClock: () => f.now });
}

function registerSuccess(test: SessionTest) {
	test("consumed LINK proof issues one permanent receipt and a fresh eight-hour session", async ({
		fixture: f,
	}) => {
		// Arrange
		const input = await ready(f);
		const before = { grants: grants(f), browsers: transactionRows(f) };
		// Act
		const result = await f.store.redeemAuthLinkSessionWithBrowserTransaction(input, browserConfig);
		const live = await f.store.readAuthSession(input.credentialHash, f.cfg);
		// Assert
		expectIssued(result, f);
		if (result.kind !== "issued") throw new Error("fixture_not_issued");
		expect(live).toEqual(result.session);
		expect(sessionRows(f)).toEqual([
			[
				expect.objectContaining({
					source: "link_redeem",
					purge_eligible: 0,
					attempt_id: input.attemptId,
					browser_transaction_hash: input.browserTransactionHash,
					session_id: result.session.sessionId,
					created_at_ms: f.now,
				}),
			],
			[
				expect.objectContaining({
					credential_hash: input.credentialHash,
					session_id: result.session.sessionId,
					browser_transaction_hash: input.browserTransactionHash,
					created_at_ms: f.now,
					expires_at_ms: f.now + SESSION_TTL,
				}),
			],
		]);
		expect(f.db.prepare("SELECT state FROM coordinator_auth_link_attempts").get()).toEqual({
			state: "session_redeemed",
		});
		expect({ grants: grants(f), browsers: transactionRows(f) }).toEqual(before);
		expect(transactionRows(f)[0]).toMatchObject({
			state: "consumed",
			nonce: null,
			pkce_verifier: null,
			claim_token: expect.any(String),
		});
		for (const secret of [
			input.credentialHash,
			input.binderHash,
			input.browserTransactionHash,
			"credentialHash",
			"binderHash",
			"browserTransactionHash",
			"rawCredential",
			"nonce",
			"pkceVerifier",
			"claim_token",
		])
			expect(JSON.stringify(result)).not.toContain(secret);
	});
	test.for(["binder", "browser", "attempt"] as const)(
		"wrong %s rejects even with the victim's other trusted metadata",
		async (field, { fixture: f }) => {
			// Arrange
			const input = await ready(f);
			if (field === "binder") input.binderHash = hash(99);
			if (field === "browser") input.browserTransactionHash = hash(99);
			if (field === "attempt") input.attemptId = "another-attempt";
			const before = authority(f);
			// Act
			const result = await f.store.redeemAuthLinkSessionWithBrowserTransaction(
				input,
				browserConfig,
			);
			// Assert
			expectRejected(result, "attempt_unavailable");
			expect(authority(f)).toEqual(before);
		},
	);
}

function registerBrowserGuards(test: SessionTest) {
	test.for([
		"missing",
		"pending",
		"cancelled",
		"signin",
		"another-attempt",
		"future-created",
		"future-consumed",
		"expiry",
		"issuer",
		"revision",
		"redirect",
	] as const)(
		"%s browser proof cannot mint from a finalized legacy-compatible attempt",
		async (change, { fixture: f }) => {
			// Arrange: only schema-permitted mutations; expired is the cancelled LINK terminal state.
			const input = await ready(f);
			const sql = {
				missing: `DELETE FROM ${TABLE}`,
				pending: `UPDATE ${TABLE} SET state='pending', nonce='${"n".repeat(43)}', pkce_verifier='${"p".repeat(43)}', claim_token=NULL, consumed_at_ms=NULL`,
				cancelled: `UPDATE ${TABLE} SET state='expired', claim_token=NULL, consumed_at_ms=NULL`,
				signin: `UPDATE ${TABLE} SET purpose='signin', attempt_id=NULL`,
				"another-attempt": `UPDATE ${TABLE} SET attempt_id='another-attempt'`,
				"future-created": `UPDATE ${TABLE} SET created_at_ms=${f.now + 1}, consumed_at_ms=${f.now + 1}, expires_at_ms=${f.now + TTL}`,
				"future-consumed": `UPDATE ${TABLE} SET consumed_at_ms=${f.now + 1}`,
				expiry: `UPDATE ${TABLE} SET created_at_ms=${f.now - TTL}, consumed_at_ms=${f.now - 1}, expires_at_ms=${f.now}`,
				issuer: `UPDATE ${TABLE} SET issuer='https://other.example.test'`,
				revision: `UPDATE ${TABLE} SET auth_config_revision='${hash(99)}'`,
				redirect: `UPDATE ${TABLE} SET redirect_uri='https://coordinator.example.test/other'`,
			}[change];
			f.db.exec(sql);
			const before = authority(f);
			// Act
			const result = await f.store.redeemAuthLinkSessionWithBrowserTransaction(
				input,
				browserConfig,
			);
			// Assert
			expectRejected(result, "attempt_unavailable");
			expect(authority(f)).toEqual(before);
		},
	);
	test.for(["nonce", "pkce_verifier", "claim_token", "consumed_at_ms"] as const)(
		"schema rejects impossible consumed %s material",
		async (field, { fixture: f }) => {
			// Arrange
			await ready(f);
			const before = authority(f);
			const value = field === "nonce" || field === "pkce_verifier" ? `'${"n".repeat(43)}'` : "NULL";
			// Act
			const mutate = () => f.db.exec(`UPDATE ${TABLE} SET ${field}=${value}`);
			// Assert
			expect(mutate).toThrow(/CHECK constraint failed/);
			expect(authority(f)).toEqual(before);
		},
	);
}

function registerConfig(test: SessionTest) {
	test.for(["revision", "issuer", "redirect", "coordinator", "disabled"] as const)(
		"current %s config drift writes nothing",
		async (change, { fixture: f }) => {
			// Arrange
			const input = await ready(f);
			const cfg = { ...browserConfig };
			if (change === "revision") cfg.revision = hash(99);
			if (change === "issuer") cfg.issuer = "https://other.example.test";
			if (change === "redirect") cfg.redirectUri = "https://coordinator.example.test/other";
			if (change === "coordinator") cfg.coordinatorId = "another-coordinator";
			if (change === "disabled") cfg.enabled = false;
			const before = authority(f);
			// Act
			const result = await f.store.redeemAuthLinkSessionWithBrowserTransaction(input, cfg);
			// Assert
			expectRejected(
				result,
				["issuer", "revision", "disabled"].includes(change)
					? "auth_config_changed"
					: "attempt_unavailable",
			);
			expect(authority(f)).toEqual(before);
		},
	);
	test.for([
		"attemptId",
		"browserTransactionHash",
		"binderHash",
		"credentialHash",
		"config",
	] as const)("invalid %s rejects without writes", async (field, { fixture: f }) => {
		// Arrange
		const input = await ready(f);
		const cfg = { ...browserConfig };
		if (field === "config") cfg.revision = "invalid";
		else input[field] = "";
		const before = authority(f);
		// Act
		const result = await f.store.redeemAuthLinkSessionWithBrowserTransaction(input, cfg);
		// Assert
		expectRejected(result, "invalid_input");
		expect(authority(f)).toEqual(before);
	});
}

function registerDeadlines(test: SessionTest) {
	test("both original and finalization deadlines allow a late finalization just inside the original deadline", async ({
		fixture: f,
	}) => {
		// Arrange
		const input = await ready(f, { late: true });
		f.now += 29_999;
		// Act
		const result = await f.store.redeemAuthLinkSessionWithBrowserTransaction(input, browserConfig);
		// Assert
		expectIssued(result, f);
	});
	test("finalization deadline permits the last millisecond", async ({ fixture: f }) => {
		// Arrange
		const input = await ready(f);
		f.now += REDEEM_WINDOW - 1;
		// Act
		const result = await f.store.redeemAuthLinkSessionWithBrowserTransaction(input, browserConfig);
		// Assert
		expectIssued(result, f);
	});
	test.for(["original", "finalization", "future-finalization"] as const)(
		"%s deadline fails closed at equality or before creation",
		async (deadline, { fixture: f }) => {
			// Arrange
			const input = await ready(f, { late: deadline === "original" });
			if (deadline === "original") f.now += 30_000;
			if (deadline === "finalization") f.now += REDEEM_WINDOW;
			if (deadline === "future-finalization") f.now -= 1;
			const before = authority(f);
			// Act
			const result = await f.store.redeemAuthLinkSessionWithBrowserTransaction(
				input,
				browserConfig,
			);
			// Assert
			expectRejected(
				result,
				deadline === "future-finalization" ? "attempt_unavailable" : "redeem_window_expired",
			);
			expect(authority(f)).toEqual(before);
		},
	);
}

function registerReplay(test: SessionTest) {
	test("eight calls across two store instances sharing ONE SQLite connection have exactly one winner", async ({
		fixture: f,
	}) => {
		// Arrange: not separate production SQLite connections; second store uses the D1 adapter.
		const input = await ready(f);
		const stores = [f.store, peer(f)];
		// Act
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				stores[i % 2].redeemAuthLinkSessionWithBrowserTransaction(
					{ ...input, credentialHash: hash(100 + i) },
					browserConfig,
				),
			),
		);
		const before = authority(f);
		const replay = await peer(f).redeemAuthLinkSessionWithBrowserTransaction(
			{ ...input, credentialHash: hash(200) },
			browserConfig,
		);
		// Assert
		expect(results.filter((result) => result.kind === "issued")).toHaveLength(1);
		expect(results.filter((result) => result.kind === "rejected")).toEqual(
			Array(7).fill({ kind: "rejected", error: "browser_transaction_used" }),
		);
		expectRejected(replay, "browser_transaction_used");
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
		expect(authority(f)).toEqual(before);
	});
	test.for(["legacy-first", "guarded-first"] as const)(
		"%s redemption burns the same proof for both APIs",
		async (order, { fixture: f }) => {
			// Arrange
			const input = await ready(f);
			const legacy = () =>
				f.store.redeemAuthLinkSession(
					{
						attemptId: input.attemptId,
						browserTransactionHash: input.browserTransactionHash,
						credentialHash: input.credentialHash,
					},
					f.cfg,
				);
			const guarded = () =>
				f.store.redeemAuthLinkSessionWithBrowserTransaction(input, browserConfig);
			// Act
			const first = await (order === "legacy-first" ? legacy() : guarded());
			const before = authority(f);
			const second = await (order === "legacy-first" ? guarded() : legacy());
			// Assert
			expectIssued(first, f);
			expectRejected(second, "browser_transaction_used");
			expect(authority(f)).toEqual(before);
		},
	);
}

function registerAtomicity(test: SessionTest) {
	test("credential collision atomically rolls back the receipt and attempt transition", async ({
		fixture: f,
	}) => {
		// Arrange: trusted legacy sign-in creates the conflicting credential, not a fabricated SID.
		const input = await ready(f);
		expectIssued(await f.store.signInWithAuthAccount(signInInput(f), f.cfg), f);
		const before = authority(f);
		// Act
		const result = f.store.redeemAuthLinkSessionWithBrowserTransaction(input, browserConfig);
		// Assert
		await expect(result).rejects.toThrow(/^auth_session_persistence_error$/);
		expect(authority(f)).toEqual(before);
	});
	test.for(["binder", "consumed-state"] as const)(
		"receipt SQL rechecks %s at batch admission, not only before it",
		async (guard, { fixture: f }) => {
			// Arrange: simulate a changed server-owned row between any precheck and receipt INSERT.
			const input = await ready(f);
			const guarded = new D1CoordinatorStore(
				sqliteD1(f.db, {
					beforeBatch: () => {
						if (guard === "binder")
							f.db.prepare(`UPDATE ${TABLE} SET binder_hash=?`).run(hash(500));
						else
							f.db.exec(
								`UPDATE ${TABLE} SET state='expired', claim_token=NULL, consumed_at_ms=NULL`,
							);
					},
				}),
				{ authClock: () => f.now },
			);
			const before = { grants: grants(f), links: snapshot(f), sessions: sessionRows(f) };
			// Act
			const result = await guarded.redeemAuthLinkSessionWithBrowserTransaction(
				input,
				browserConfig,
			);
			// Assert
			expectRejected(result, "attempt_unavailable");
			expect({ grants: grants(f), links: snapshot(f), sessions: sessionRows(f) }).toEqual(before);
		},
	);
	test("normalizes a private backend batch failure", async ({ fixture: f }) => {
		// Arrange: reject before committing; post-commit read failures are not rollback guarantees.
		const input = await ready(f);
		const before = authority(f);
		const operations = new AuthSessionOperations(
			{
				first: async () => null,
				run: async () => 0,
				batch: async () => {
					throw new Error("fixture-private-detail");
				},
			},
			() => f.now,
		);
		// Act
		const result = operations.redeemAuthLinkSessionWithBrowserTransaction(input, browserConfig);
		// Assert
		await expect(result).rejects.toThrow(/^auth_session_persistence_error$/);
		expect(authority(f)).toEqual(before);
	});
}

describe.each(["SQLite", "D1"] as const)(
	"%s browser-bound link redemption (D1 adapter uses SQLite)",
	(backend) => {
		const test = backendTest(backend);
		registerSuccess(test);
		registerBrowserGuards(test);
		registerConfig(test);
		registerDeadlines(test);
		registerReplay(test);
		registerAtomicity(test);
	},
);
