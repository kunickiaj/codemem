import { describe, expect, vi } from "vitest";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import {
	browserConfig,
	hash,
	materials,
	TABLE,
	transactionRows,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	expectRejected,
	type LinkFixture,
	snapshot,
} from "./coordinator-auth-link-test-fixtures.js";
import { AuthSessionOperations } from "./coordinator-auth-session.js";
import type { CoordinatorAuthAccountSignInInput } from "./coordinator-auth-session-contract.js";
import {
	backendTest,
	browserHash,
	expectIssued,
	grants,
	linked,
	linkId,
	redeemInput,
	SESSION_TTL,
	type SessionTest,
	sessionRows,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";
import { type Backend, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

// These are trusted metadata fixtures, not JWT/cookie/CSRF verification tests.
async function ready(f: LinkFixture, id = 1, cfg = browserConfig) {
	const material = materials(id);
	expect(await f.store.startAuthBrowserTransaction(material, cfg)).toMatchObject({
		kind: "started",
	});
	const consumed = await f.store.consumeAuthBrowserTransaction(material, cfg);
	if (consumed.kind !== "consumed") throw new Error("fixture_transaction_not_consumed");
	return {
		browserTransactionHash: consumed.browserTransactionHash,
		credentialHash: hash(1000 + id),
		account: { issuer: cfg.issuer, subject: "opaque-subject-a" },
	};
}

function capability(
	f: LinkFixture,
	hooks: {
		beforeBatch?: (sql: string[]) => void | Promise<void>;
		beforeRead?: (sql: string) => void;
		clock?: () => number;
	} = {},
) {
	return new AuthSessionOperations(
		{
			async first<T>({ sql, values }) {
				hooks.beforeRead?.(sql);
				return (f.db.prepare(sql).get(...values) as T | undefined) ?? null;
			},
			async run({ sql, values }) {
				f.db.prepare(sql).run(...values);
				return 0;
			},
			async batch(statements) {
				await hooks.beforeBatch?.(statements.map(({ sql }) => sql));
				f.db.transaction(() => {
					for (const { sql, values } of statements) f.db.prepare(sql).run(...values);
				})();
			},
		},
		hooks.clock ?? (() => f.now),
	);
}

async function fill(f: LinkFixture, count = 10, cfg = f.cfg) {
	for (let i = 0; i < count; i++) {
		const result = await f.store.signInWithAuthAccount(
			{
				...signInInput(f),
				browserTransactionHash: hash(2000 + i),
				credentialHash: hash(3000 + i),
			},
			cfg,
		);
		expect(result.kind).toBe("issued");
	}
}

function blockedPeer(f: LinkFixture) {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const reads: string[] = [];
	const beforeRead = (sql: string) => reads.push(sql);
	const beforeBatch = async () => {
		entered.resolve();
		await released.promise;
	};
	let store: D1CoordinatorStore | AuthSessionOperations;
	if (f.store instanceof D1CoordinatorStore) {
		const backend = sqliteD1(f.db, { beforeRead });
		store = new D1CoordinatorStore(
			{
				...backend,
				async batch(statements) {
					await beforeBatch();
					return backend.batch(statements);
				},
			},
			{ authClock: () => f.now },
		);
	} else {
		store = capability(f, { beforeBatch, beforeRead });
	}
	return { store, entered: entered.promise, release: released.resolve, reads };
}

function registerIssuance(test: SessionTest) {
	test("consumed server-owned signin proof issues a live session and coherent receipt without granting authority", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = await ready(f);
		const before = { grants: grants(f), links: snapshot(f), transactions: transactionRows(f) };
		// Act
		const result = await f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
		const live = await f.store.readAuthSession(input.credentialHash, f.cfg);
		// Assert
		expectIssued(result, f);
		if (result.kind !== "issued") throw new Error("fixture_session_not_issued");
		expect(live).toEqual(result.session);
		expect(sessionRows(f)).toEqual([
			[
				{
					coordinator_id: f.cfg.coordinatorId,
					browser_transaction_hash: input.browserTransactionHash,
					source: "signin",
					attempt_id: null,
					link_id: linkId(f),
					session_id: result.session.sessionId,
					auth_config_revision: f.cfg.revision,
					created_at_ms: f.now,
					purge_eligible: 1,
				},
			],
			[
				{
					coordinator_id: f.cfg.coordinatorId,
					session_id: result.session.sessionId,
					credential_hash: input.credentialHash,
					browser_transaction_hash: input.browserTransactionHash,
					link_id: linkId(f),
					identity_id: "identity-a",
					issuer: f.cfg.issuer,
					subject: input.account.subject,
					auth_config_revision: f.cfg.revision,
					created_at_ms: f.now,
					expires_at_ms: f.now + SESSION_TTL,
					revoked_at_ms: null,
				},
			],
		]);
		expect({ grants: grants(f), links: snapshot(f), transactions: transactionRows(f) }).toEqual(
			before,
		);
		expect(JSON.stringify(result)).not.toMatch(
			/credentialHash|browserTransactionHash|nonce|pkce|claim_token/,
		);
		expect(JSON.stringify(result)).not.toContain(input.credentialHash);
	});
	test("new current-revision signin accepts a previously reviewed older-revision link", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const cfg = { ...browserConfig, revision: hash(900) };
		const input = await ready(f, 1, cfg);
		const before = grants(f);
		// Act
		const result = await f.store.signInWithConsumedBrowserTransaction(input, cfg);
		// Assert
		expectIssued(result, f);
		expect(await f.store.readAuthSession(input.credentialHash, cfg)).not.toBeNull();
		expect(await f.store.readAuthSession(input.credentialHash, f.cfg)).toBeNull();
		expect(grants(f)).toEqual(before);
	});
	test("issued receipt supports profile writes without changing session or authority", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = await ready(f);
		const issued = await f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
		const before = { sessions: sessionRows(f), grants: grants(f) };
		// Act
		const result = await f.store.recordAuthAccountProfile(
			{ credentialHash: input.credentialHash, profile: { displayName: "Example Person" } },
			f.cfg,
		);
		const account = await f.store.readAuthSessionAccount(input.credentialHash, f.cfg);
		// Assert
		expect(result).toEqual({ kind: "recorded" });
		expect(account).toMatchObject({ profile: { displayName: "Example Person" } });
		if (issued.kind !== "issued") throw new Error("fixture_session_not_issued");
		expect(account?.session).toEqual(issued.session);
		expect({ sessions: sessionRows(f), grants: grants(f) }).toEqual(before);
	});
}

function registerTransactionGuards(test: SessionTest) {
	test.for([
		"missing",
		"pending",
		"expired",
		"link",
		"cancelled",
		"issuer",
		"revision",
		"redirect",
		"future-created",
		"future-consumed",
	] as const)("%s transaction cannot mint a session or receipt", async (change, { fixture: f }) => {
		// Arrange
		await linked(f);
		const input = await ready(f);
		const sql: Record<typeof change, string> = {
			missing: `DELETE FROM ${TABLE}`,
			pending: `UPDATE ${TABLE} SET state = 'pending', nonce = '${"n".repeat(43)}', pkce_verifier = '${"p".repeat(43)}', consumed_at_ms = NULL, claim_token = NULL`,
			expired: `UPDATE ${TABLE} SET created_at_ms = ${f.now - 600000}, consumed_at_ms = ${f.now - 1}, expires_at_ms = ${f.now}`,
			link: `UPDATE ${TABLE} SET purpose = 'link', attempt_id = 'attempt-a'`,
			cancelled: "SELECT 1",
			issuer: `UPDATE ${TABLE} SET issuer = 'https://other.example.test'`,
			revision: `UPDATE ${TABLE} SET auth_config_revision = '${hash(900)}'`,
			redirect: `UPDATE ${TABLE} SET redirect_uri = 'https://coordinator.example.test/other'`,
			"future-created": `UPDATE ${TABLE} SET created_at_ms = ${f.now + 1}, consumed_at_ms = ${f.now + 1}, expires_at_ms = ${f.now + 600001}`,
			"future-consumed": `UPDATE ${TABLE} SET consumed_at_ms = ${f.now + 1}`,
		};
		f.db.exec(sql[change]);
		if (change === "cancelled") {
			const material = materials(2);
			await f.store.startAuthBrowserTransaction(material, browserConfig);
			input.browserTransactionHash = transactionRows(f).find(
				(row) => row.state_hash === material.stateHash,
			)?.browser_transaction_hash as string;
			expect(
				await f.store.cancelAuthSigninBrowserTransaction(
					{ binderHash: material.binderHash },
					f.cfg,
				),
			).toEqual({ kind: "cancelled" });
		}
		const before = { grants: grants(f), transactions: transactionRows(f) };
		// Act
		const result = await f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
		// Assert
		expectRejected(result, "transaction_unavailable");
		expect(sessionRows(f)).toEqual([[], []]);
		expect({ grants: grants(f), transactions: transactionRows(f) }).toEqual(before);
	});
	test.for(["unknown", "revoked", "wrong-issuer", "malformed", "disabled"] as const)(
		"%s verified account/config denies without writes",
		async (change, { fixture: f }) => {
			// Arrange
			await linked(f);
			const input = await ready(f);
			if (change === "unknown") input.account.subject = "unknown";
			if (change === "revoked")
				f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms = ?").run(f.now);
			if (change === "wrong-issuer") input.account.issuer = "https://other.example.test";
			if (change === "malformed") input.account.subject = "";
			const before = grants(f);
			// Act
			const result = await f.store.signInWithConsumedBrowserTransaction(input, {
				...browserConfig,
				enabled: change !== "disabled",
			});
			// Assert
			const error = {
				unknown: "account_not_linked",
				revoked: "account_not_linked",
				"wrong-issuer": "invalid_input",
				malformed: "invalid_input",
				disabled: "auth_config_changed",
			}[change];
			expectRejected(result, error);
			expect(sessionRows(f)).toEqual([[], []]);
			expect(grants(f)).toEqual(before);
		},
	);
	test.for(["same-config", "new-revision", "new-redirect", "disabled"] as const)(
		"used receipt replay under %s never recovers or creates a session",
		async (change, { fixture: f }) => {
			// Arrange
			await linked(f);
			const input = await ready(f);
			await f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
			const cfg = { ...browserConfig };
			if (change === "new-revision") cfg.revision = hash(900);
			if (change === "new-redirect") cfg.redirectUri = "https://coordinator.example.test/other";
			if (change === "disabled") cfg.enabled = false;
			const before = sessionRows(f);
			// Act
			const result = await f.store.signInWithConsumedBrowserTransaction(
				{ ...input, credentialHash: hash(800) },
				cfg,
			);
			// Assert: disabled configuration has priority; an existing receipt otherwise stays burned.
			expectRejected(
				result,
				change === "disabled" ? "auth_config_changed" : "browser_transaction_used",
			);
			expect(sessionRows(f)).toEqual(before);
		},
	);
	test("a linking attempt burns its original hash even without a receipt", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = { ...(await ready(f)), browserTransactionHash: browserHash };
		// Act
		const result = await f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
		// Assert
		expectRejected(result, "browser_transaction_used");
		expect(sessionRows(f)).toEqual([[], []]);
	});
}

function registerSharedReceiptCompatibility(test: SessionTest) {
	test("legacy trusted signin owns the shared receipt and consumed signin cannot replace it", async ({
		fixture: f,
	}) => {
		// Arrange: the legacy method wins the shared receipt key for a consumed internal hash.
		await linked(f);
		const input = await ready(f);
		const first = await f.store.signInWithAuthAccount(input, f.cfg);
		expectIssued(first, f);
		expect(
			await f.store.recordAuthAccountProfile(
				{ credentialHash: input.credentialHash, profile: { displayName: "Example Person" } },
				f.cfg,
			),
		).toEqual({ kind: "recorded" });
		const profiles = () => f.db.prepare("SELECT * FROM coordinator_auth_account_profiles").all();
		const before = {
			sessions: sessionRows(f),
			grants: grants(f),
			links: snapshot(f),
			profiles: profiles(),
			transactions: transactionRows(f),
		};
		const freshCredentialHash = hash(800);
		// Act
		const result = await f.store.signInWithConsumedBrowserTransaction(
			{ ...input, credentialHash: freshCredentialHash },
			browserConfig,
		);
		const original = await f.store.readAuthSession(input.credentialHash, f.cfg);
		const replacement = await f.store.readAuthSession(freshCredentialHash, f.cfg);
		// Assert: no new row, credential recovery, authority change, or profile mutation.
		expectRejected(result, "browser_transaction_used");
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
		expect({
			sessions: sessionRows(f),
			grants: grants(f),
			links: snapshot(f),
			profiles: profiles(),
			transactions: transactionRows(f),
		}).toEqual(before);
		if (first.kind !== "issued") throw new Error("fixture_session_not_issued");
		expect(original).toEqual(first.session);
		expect(replacement).toBeNull();
	});
}

function registerBudget(test: SessionTest) {
	test.for(["forward", "reverse"] as const)(
		"14 independently blocked batches admit exactly 10 proofs in %s commit order",
		async (order, { fixture: f }) => {
			// Arrange
			await linked(f);
			const inputs = [];
			for (let i = 1; i <= 14; i++) inputs.push(await ready(f, i));
			const before = grants(f);
			const peers = inputs.map(() => blockedPeer(f));
			const commitOrder = inputs.map((_, i) => i);
			if (order === "reverse") commitOrder.reverse();
			// Act: overlap operation lifetimes, not synchronous SQLite transactions.
			const pending = inputs.map((input, i) =>
				peers[i].store.signInWithConsumedBrowserTransaction(input, browserConfig),
			);
			await Promise.all(peers.map((peer) => peer.entered));
			// Assert: no pre-read may make an admission decision against the empty budget.
			expect(peers.map((peer) => peer.reads)).toEqual(inputs.map(() => []));
			expect(sessionRows(f)).toEqual([[], []]);
			// Act: each held batch sees commits made while its own batch was blocked.
			const results = [];
			for (const i of commitOrder) {
				peers[i].release();
				results.push(await pending[i]);
			}
			// Assert
			expect(results.filter((r) => r.kind === "issued")).toHaveLength(10);
			expect(results.filter((r) => r.kind === "rejected")).toEqual(
				Array(4).fill({ kind: "rejected", error: "session_limited" }),
			);
			expect(sessionRows(f).map((rows) => rows.length)).toEqual([10, 10]);
			expect(grants(f)).toEqual(before);
			for (const [position, i] of commitOrder.entries()) {
				const input = inputs[i];
				const result = await f.store.readAuthSession(input.credentialHash, f.cfg);
				if (position < 10) expect(result).toMatchObject({ expiresAtMs: f.now + SESSION_TTL });
				else expect(result).toBeNull();
			}
		},
	);
	test("current normal signin and first-link redemption together fill the cap without refresh or signout", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
		await fill(f, 9);
		const input = await ready(f);
		const before = { sessions: sessionRows(f), grants: grants(f) };
		// Act
		const result = await f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
		// Assert
		expectRejected(result, "session_limited");
		expect({ sessions: sessionRows(f), grants: grants(f) }).toEqual(before);
	});
	test.for(["expired", "revoked"] as const)(
		"%s session frees one slot without modifying the other nine",
		async (change, { fixture: f }) => {
			// Arrange
			await linked(f);
			await fill(f);
			if (change === "expired")
				f.db
					.prepare(
						"UPDATE coordinator_auth_sessions SET created_at_ms = ?, expires_at_ms = ? WHERE credential_hash = ?",
					)
					.run(f.now - SESSION_TTL, f.now, hash(3000));
			else await f.store.signOutAuthSession(hash(3000), f.cfg);
			const before = sessionRows(f)[1];
			const input = await ready(f);
			// Act
			const result = await f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
			// Assert
			expectIssued(result, f);
			expect(sessionRows(f)[1].slice(0, 10)).toEqual(before);
			expect(sessionRows(f).map((rows) => rows.length)).toEqual([11, 11]);
		},
	);
}

function registerBudgetIsolation(test: SessionTest) {
	test("future-born current sessions reserve all 10 slots although live lookup rejects them", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await fill(f);
		f.db
			.prepare("UPDATE coordinator_auth_sessions SET created_at_ms = ?, expires_at_ms = ?")
			.run(f.now + 1, f.now + 1 + SESSION_TTL);
		const input = await ready(f);
		const before = sessionRows(f);
		// Act
		const result = await f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
		const live = await f.store.readAuthSession(hash(3000), f.cfg);
		// Assert
		expectRejected(result, "session_limited");
		expect(live).toBeNull();
		expect(sessionRows(f)).toEqual(before);
	});
	test.for([
		"old-revision",
		"other-issuer",
		"other-subject",
		"other-identity",
		"other-coordinator",
		"other-link",
	] as const)(
		"10 %s sessions do not consume this link's current-config budget",
		async (change, { fixture: f }) => {
			// Arrange
			await linked(f);
			await fill(f);
			const field = {
				"old-revision": "auth_config_revision",
				"other-issuer": "issuer",
				"other-subject": "subject",
				"other-identity": "identity_id",
				"other-coordinator": "coordinator_id",
				"other-link": "link_id",
			}[change];
			let value = "other";
			if (change === "old-revision") value = hash(900);
			if (change === "other-issuer") value = "https://other.example.test";
			f.db.prepare(`UPDATE coordinator_auth_sessions SET ${field} = ?`).run(value);
			const input = await ready(f);
			const before = sessionRows(f)[1];
			// Act
			const result = await f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
			// Assert
			expectIssued(result, f);
			expect(sessionRows(f)[1].slice(0, 10)).toEqual(before);
			expect(sessionRows(f)[1]).toHaveLength(11);
		},
	);
	test("legacy trusted signin remains uncapped beyond 10 sessions", async ({ fixture: f }) => {
		// Arrange
		await linked(f);
		await fill(f);
		// Act
		const result = await f.store.signInWithAuthAccount(
			{ ...signInInput(f), browserTransactionHash: hash(800), credentialHash: hash(801) },
			f.cfg,
		);
		// Assert
		expectIssued(result, f);
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([11, 11]);
	});
}

function registerAtomicity(test: SessionTest) {
	test.for(["forward", "reverse"] as const)(
		"two independently blocked batches own one proof in %s commit order even with changes() zero",
		async (order, { fixture: f }) => {
			// Arrange
			await linked(f);
			const input = await ready(f);
			f.db.function("changes", () => 0);
			const inputs = [input, { ...input, credentialHash: hash(800) }];
			const peers = inputs.map(() => blockedPeer(f));
			const commitOrder = order === "forward" ? [0, 1] : [1, 0];
			// Act: both operations reach independently held batches before either commits.
			const pending = inputs.map((candidate, i) =>
				peers[i].store.signInWithConsumedBrowserTransaction(candidate, browserConfig),
			);
			await Promise.all(peers.map((peer) => peer.entered));
			// Assert: receipt ownership cannot come from a stale pre-read.
			expect(peers.map((peer) => peer.reads)).toEqual([[], []]);
			expect(sessionRows(f)).toEqual([[], []]);
			// Act: synchronous transactions still serialize on this single connection.
			const results = [];
			for (const i of commitOrder) {
				peers[i].release();
				results.push(await pending[i]);
			}
			// Assert
			expect(results.filter((r) => r.kind === "issued")).toHaveLength(1);
			expect(results).toContainEqual({ kind: "rejected", error: "browser_transaction_used" });
			expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
			expectIssued(results[0], f);
			expectRejected(results[1], "browser_transaction_used");
			if (results[0].kind !== "issued") throw new Error("fixture_session_not_issued");
			expect(await f.store.readAuthSession(inputs[commitOrder[0]].credentialHash, f.cfg)).toEqual(
				results[0].session,
			);
			expect(
				await f.store.readAuthSession(inputs[commitOrder[1]].credentialHash, f.cfg),
			).toBeNull();
			expect(sessionRows(f)[0]).toEqual([
				expect.objectContaining({
					browser_transaction_hash: input.browserTransactionHash,
					session_id: results[0].session.sessionId,
				}),
			]);
		},
	);
	test.for(["revoke-link", "retire-transaction", "fill-cap"] as const)(
		"%s immediately before atomic batch prevents a stale pre-read grant",
		async (change, { fixture: f }) => {
			// Arrange
			await linked(f);
			if (change === "fill-cap") await fill(f, 9);
			const input = await ready(f);
			const ops = capability(f, {
				beforeBatch(sql) {
					expect(sql).toHaveLength(2);
					expect(sql[0]).toMatch(
						/INSERT INTO coordinator_auth_session_receipts[\s\S]*SELECT[\s\S]*coordinator_auth_browser_transactions[\s\S]*COUNT\(\*\)/,
					);
					expect(sql[1]).toMatch(/INSERT INTO coordinator_auth_sessions/);
					if (change === "revoke-link")
						f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms = ?").run(f.now);
					if (change === "retire-transaction")
						f.db.exec(
							`UPDATE ${TABLE} SET state = 'expired', claim_token = NULL, consumed_at_ms = NULL`,
						);
					if (change === "fill-cap")
						f.db.exec(
							`INSERT INTO coordinator_auth_sessions SELECT coordinator_id, 'last-slot', '${hash(800)}', '${hash(801)}', link_id, identity_id, issuer, subject, auth_config_revision, created_at_ms, expires_at_ms, revoked_at_ms FROM coordinator_auth_sessions LIMIT 1`,
						);
				},
			});
			// Act
			const result = await ops.signInWithConsumedBrowserTransaction(input, browserConfig);
			// Assert
			const error = {
				"revoke-link": "account_not_linked",
				"retire-transaction": "transaction_unavailable",
				"fill-cap": "session_limited",
			}[change];
			expectRejected(result, error);
			expect(
				f.db
					.prepare(
						"SELECT * FROM coordinator_auth_session_receipts WHERE browser_transaction_hash = ?",
					)
					.all(input.browserTransactionHash),
			).toEqual([]);
			expect(await f.store.readAuthSession(input.credentialHash, f.cfg)).toBeNull();
		},
	);
	test("state change between rejection diagnostic reads cannot turn a full-cap denial into a grant", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await fill(f);
		const input = await ready(f);
		const before = sessionRows(f);
		const ops = capability(f, {
			beforeRead(sql) {
				if (sql.startsWith("SELECT 1 FROM coordinator_auth_account_links"))
					f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms = ?").run(f.now);
			},
		});
		// Act
		const result = await ops.signInWithConsumedBrowserTransaction(input, browserConfig);
		// Assert
		expectRejected(result, "account_not_linked");
		expect(sessionRows(f)).toEqual(before);
		expect(await f.store.readAuthSession(input.credentialHash, f.cfg)).toBeNull();
	});
}

function registerPersistenceFaults(test: SessionTest) {
	test.for(["duplicate-credential", "insert-trigger"] as const)(
		"%s rolls back the fresh receipt and redacts backend secrets",
		async (change, { fixture: f }) => {
			// Arrange
			await linked(f);
			const input = await ready(f);
			if (change === "duplicate-credential")
				await f.store.signInWithAuthAccount(
					{ ...signInInput(f), credentialHash: input.credentialHash },
					f.cfg,
				);
			else
				f.db.exec(
					"CREATE TRIGGER fixture_consumed_fault BEFORE INSERT ON coordinator_auth_sessions BEGIN SELECT RAISE(ABORT, 'fixture-private-token-callback-claims'); END",
				);
			const before = {
				sessions: sessionRows(f),
				grants: grants(f),
				transactions: transactionRows(f),
			};
			// Act
			const result = f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
			// Assert
			await expect(result).rejects.toThrow(/^auth_session_persistence_error$/);
			expect({
				sessions: sessionRows(f),
				grants: grants(f),
				transactions: transactionRows(f),
			}).toEqual(before);
		},
	);
	test("receipt read failure after commit is redacted and replay never recovers credentials", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const input = await ready(f);
		const prepare = f.db.prepare.bind(f.db);
		const spy = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
			if (sql.startsWith("SELECT session_id FROM coordinator_auth_session_receipts"))
				throw new Error("fixture-private-token-callback-claims");
			return prepare(sql);
		});
		try {
			// Act
			const result = f.store.signInWithConsumedBrowserTransaction(input, browserConfig);
			// Assert
			await expect(result).rejects.toThrow(/^auth_session_persistence_error$/);
		} finally {
			spy.mockRestore();
		}
		// Act: a lost response is not a credential recovery endpoint.
		const retry = await f.store.signInWithConsumedBrowserTransaction(
			{ ...input, credentialHash: hash(800) },
			browserConfig,
		);
		// Assert
		expectRejected(retry, "browser_transaction_used");
		expect(sessionRows(f).map((rows) => rows.length)).toEqual([1, 1]);
	});
}

function registerInputSafety(test: SessionTest) {
	test.for([
		"input-getter",
		"account-getter",
		"config-getter",
		"inherited",
		"coercion",
		"proxy",
	] as const)(
		"%s rejects before DB access without invoking getters or coercion",
		async (change, { fixture: f }) => {
			// Arrange
			await linked(f);
			let input: unknown = await ready(f);
			const cfg: unknown = { ...browserConfig };
			const dangerous = vi.fn(() => {
				throw new Error("fixture-private-secret");
			});
			if (change === "input-getter")
				Object.defineProperty(input, "credentialHash", { get: dangerous });
			if (change === "account-getter")
				Object.defineProperty((input as CoordinatorAuthAccountSignInInput).account, "subject", {
					get: dangerous,
				});
			if (change === "config-getter") Object.defineProperty(cfg, "redirectUri", { get: dangerous });
			if (change === "inherited") input = Object.create(input);
			if (change === "coercion")
				input = {
					...(input as object),
					credentialHash: { toString: dangerous, [Symbol.toPrimitive]: dangerous },
				};
			if (change === "proxy")
				input = new Proxy(input as object, { getOwnPropertyDescriptor: dangerous });
			const before = sessionRows(f);
			const dbAccess = vi.spyOn(f.db, "prepare");
			// Act
			const result = await f.store.signInWithConsumedBrowserTransaction(
				input as CoordinatorAuthAccountSignInInput,
				cfg as CoordinatorAuthBrowserConfig,
			);
			// Assert
			expectRejected(result, "invalid_input");
			expect(dbAccess).not.toHaveBeenCalled();
			if (change === "proxy") expect(dangerous).toHaveBeenCalled();
			else expect(dangerous).not.toHaveBeenCalled();
			dbAccess.mockRestore();
			expect(sessionRows(f)).toEqual(before);
		},
	);
	test.for([
		"http://coordinator.example.test/auth/callback",
		"https://user:pass@coordinator.example.test/auth/callback",
		"https://coordinator.example.test/auth/callback?",
		"https://coordinator.example.test/auth/callback#",
		"https://coordinator.example.test/auth/callback?q=1",
		"https://coordinator.example.test/auth/callback#fragment",
		"https://COORDINATOR.example.test/auth/callback",
		" https://coordinator.example.test/auth/callback",
		"https://coordinator.example.test/auth/\ncallback",
	])(
		"noncanonical redirect %s is invalid input, not an endpoint change",
		async (redirectUri, { fixture: f }) => {
			// Arrange
			await linked(f);
			const input = await ready(f);
			const before = sessionRows(f);
			// Act
			const result = await f.store.signInWithConsumedBrowserTransaction(input, {
				...browserConfig,
				redirectUri,
			});
			// Assert
			expectRejected(result, "invalid_input");
			expect(sessionRows(f)).toEqual(before);
		},
	);
	test.for([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER, "throw"] as const)(
		"invalid clock %s fails before any writes",
		async (value, { fixture: f }) => {
			// Arrange
			await linked(f);
			const input = await ready(f);
			const before = sessionRows(f);
			const ops = capability(f, {
				clock: () => {
					if (value === "throw") throw new Error("fixture-clock-secret");
					return value;
				},
				beforeBatch: () => {
					throw new Error("fixture_unexpected_batch");
				},
			});
			// Act
			const result = ops.signInWithConsumedBrowserTransaction(input, browserConfig);
			// Assert
			await expect(result).rejects.toThrow(/^auth_session_invalid_clock$/);
			expect(sessionRows(f)).toEqual(before);
		},
	);
	test("legacy standalone session operations do not require a browser-transaction table", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		f.db.exec(`DROP TABLE ${TABLE}`);
		const ops = capability(f);
		// Act
		const issued = await ops.signInWithAuthAccount(signInInput(f), f.cfg);
		const live = await ops.readAuthSession(signInInput(f).credentialHash, f.cfg);
		const revoked = await ops.revokeAuthAccountLink({ linkId: linkId(f) }, f.cfg);
		const after = await ops.readAuthSession(signInInput(f).credentialHash, f.cfg);
		// Assert
		expectIssued(issued, f);
		expect(live).not.toBeNull();
		expect(revoked).toEqual({ kind: "revoked" });
		expect(after).toBeNull();
	});
}

describe.each(["SQLite", "D1"] as const)(
	"%s consumed browser signin (D1 is SQLite-backed)",
	(backend: Backend) => {
		const test = backendTest(backend);
		registerIssuance(test);
		registerTransactionGuards(test);
		registerSharedReceiptCompatibility(test);
		registerBudget(test);
		registerBudgetIsolation(test);
		registerAtomicity(test);
		registerPersistenceFaults(test);
		registerInputSafety(test);
	},
);
