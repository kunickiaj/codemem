import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it } from "vitest";

const NOW = 1790899200000;
const tables = [
	"coordinator_auth_browser_transactions",
	"coordinator_auth_link_attempts",
	"coordinator_auth_session_receipts",
	"coordinator_auth_sessions",
	"coordinator_auth_account_links",
	"coordinator_auth_controller_attestations",
	"coordinator_auth_link_audit_log",
];
let sequence = 0;
const hash = () => (++sequence).toString(16).padStart(64, "0");
type Fixture = Awaited<ReturnType<typeof fixture>>;

// Real migrated D1, trusted proof metadata only; no network or public cookie handling.
async function fixture() {
	const time = { now: NOW };
	const fresh = () => new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => time.now });
	const store = fresh();
	const cfg = {
		coordinatorId: randomUUID(),
		issuer: "https://accounts.example.test",
		revision: "a".repeat(64),
		enabled: true,
		redirectUri: "https://app.example.test/callback",
	};
	const review = {
		coordinatorId: cfg.coordinatorId,
		groupId: randomUUID(),
		deviceId: randomUUID(),
		identityId: randomUUID(),
		attestationId: randomUUID(),
		reviewReceiptId: randomUUID(),
		publicKey: "fixture-public-key",
		fingerprint: hash(),
		evidenceDigest: hash(),
	};
	const start = {
		attemptId: randomUUID(),
		signer: review,
		runtimeVerifierHash: hash(),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	await store.createGroup(review.groupId, "Fixture group");
	await store.enrollDevice(review.groupId, { ...review, identityId: null });
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	expect(await store.createAuthLinkAttempt(start, cfg)).toMatchObject({ kind: "created" });
	const proofs = {
		purpose: "link" as const,
		attemptId: start.attemptId,
		stateHash: hash(),
		binderHash: hash(),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	expect(await store.startAuthBrowserTransaction(proofs, cfg)).toMatchObject({ kind: "started" });
	const consumed = await store.consumeAuthBrowserTransaction(proofs, cfg);
	expect(consumed.kind).toBe("consumed");
	if (consumed.kind !== "consumed") throw new Error("fixture_not_consumed");
	const browser = {
		attemptId: start.attemptId,
		browserTransactionHash: consumed.browserTransactionHash,
	};
	const account = { issuer: cfg.issuer, subject: randomUUID() };
	expect(await store.recordAuthLinkOidcVerified({ ...browser, account }, cfg)).toMatchObject({
		kind: "applied",
	});
	const completionSecretHash = hash();
	expect(
		await store.confirmAuthLinkAttempt({ ...browser, completionSecretHash }, cfg),
	).toMatchObject({ kind: "applied" });
	expect(
		await store.finalizeAuthLinkAttempt(
			{ ...review, ...start, completionSecretHash, purpose: "coordinator-account-link-v1" },
			cfg,
		),
	).toMatchObject({ kind: "applied" });
	return {
		time,
		fresh,
		store,
		cfg,
		review,
		account,
		input: { ...browser, binderHash: proofs.binderHash, credentialHash: hash() },
	};
}

async function rows(f: Fixture, table: string) {
	return (
		await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} WHERE coordinator_id=? ORDER BY rowid`)
			.bind(f.cfg.coordinatorId)
			.all<Record<string, unknown>>()
	).results;
}
async function snapshot(f: Fixture) {
	return Promise.all(tables.map((table) => rows(f, table)));
}
function issue(f: Fixture) {
	return f.store.redeemAuthLinkSessionWithBrowserTransaction(f.input, f.cfg);
}

it("native D1 atomically issues one retained initial-link receipt and an eight-hour session", async () => {
	// Arrange
	const f = await fixture();
	const before = await snapshot(f);
	// Act
	const result = await issue(f);
	const live = await f.store.readAuthSession(f.input.credentialHash, f.cfg);
	// Assert
	expect(result.kind).toBe("issued");
	if (result.kind !== "issued") throw new Error("fixture_not_issued");
	expect(result.session).toEqual({
		sessionId: expect.any(String),
		identityId: f.review.identityId,
		linkId: expect.any(String),
		account: f.account,
		expiresAtMs: NOW + 28_800_000,
	});
	expect(live).toEqual(result.session);
	expect(await rows(f, tables[2])).toEqual([
		expect.objectContaining({
			source: "link_redeem",
			purge_eligible: 0,
			attempt_id: f.input.attemptId,
			session_id: result.session.sessionId,
		}),
	]);
	expect(await rows(f, tables[3])).toEqual([
		expect.objectContaining({
			credential_hash: f.input.credentialHash,
			session_id: result.session.sessionId,
			created_at_ms: NOW,
			expires_at_ms: NOW + 28_800_000,
		}),
	]);
	expect((await rows(f, tables[1]))[0].state).toBe("session_redeemed");
	expect(await rows(f, tables[0])).toEqual(before[0]);
	expect((await rows(f, tables[0]))[0]).toMatchObject({
		nonce: null,
		pkce_verifier: null,
		claim_token: expect.any(String),
	});
	for (const index of [4, 5, 6]) expect(await rows(f, tables[index])).toEqual(before[index]);
	for (const value of [
		f.input.binderHash,
		f.input.credentialHash,
		f.input.browserTransactionHash,
		"nonce",
		"pkceVerifier",
		"credentialHash",
	])
		expect(JSON.stringify(result)).not.toContain(value);
});

it("native D1 denies a wrong original binder, pending proof and exact browser expiry without writes", async () => {
	// Arrange
	const f = await fixture();
	const before = await snapshot(f);
	// Act
	const wrongBinder = await f.store.redeemAuthLinkSessionWithBrowserTransaction(
		{ ...f.input, binderHash: hash() },
		f.cfg,
	);
	// Assert
	expect(wrongBinder).toEqual({ kind: "rejected", error: "attempt_unavailable" });
	expect(await snapshot(f)).toEqual(before);
	// Arrange: schema-valid pending row, not an impossible consumed row with raw secrets.
	await env.COORDINATOR_DB.prepare(
		`UPDATE ${tables[0]} SET state='pending', nonce=?, pkce_verifier=?, claim_token=NULL, consumed_at_ms=NULL WHERE coordinator_id=?`,
	)
		.bind("n".repeat(43), "p".repeat(43), f.cfg.coordinatorId)
		.run();
	const pendingBefore = await snapshot(f);
	// Act
	const pending = await issue(f);
	// Assert
	expect(pending).toEqual({ kind: "rejected", error: "attempt_unavailable" });
	expect(await snapshot(f)).toEqual(pendingBefore);
	// Arrange: shorten browser expiry independently of the original attempt deadline.
	const expired = await fixture();
	await env.COORDINATOR_DB.prepare(`UPDATE ${tables[0]} SET expires_at_ms=? WHERE coordinator_id=?`)
		.bind(NOW + 1, expired.cfg.coordinatorId)
		.run();
	expired.time.now += 1;
	const expiredBefore = await snapshot(expired);
	// Act
	const denied = await issue(expired);
	// Assert
	expect(denied).toEqual({ kind: "rejected", error: "attempt_unavailable" });
	expect(await snapshot(expired)).toEqual(expiredBefore);
});

it("native D1 serializes eight calls across two instances and restart cannot replay or use legacy redemption", async () => {
	// Arrange
	const f = await fixture();
	const stores = [f.store, f.fresh()];
	// Act
	const results = await Promise.all(
		Array.from({ length: 8 }, (_, i) =>
			stores[i % 2].redeemAuthLinkSessionWithBrowserTransaction(
				{ ...f.input, credentialHash: hash() },
				f.cfg,
			),
		),
	);
	const before = await snapshot(f);
	const replay = await f.fresh().redeemAuthLinkSessionWithBrowserTransaction(f.input, f.cfg);
	const legacy = await f.store.redeemAuthLinkSession(
		{
			attemptId: f.input.attemptId,
			browserTransactionHash: f.input.browserTransactionHash,
			credentialHash: hash(),
		},
		f.cfg,
	);
	// Assert
	expect(results.filter((result) => result.kind === "issued")).toHaveLength(1);
	expect(results.filter((result) => result.kind === "rejected")).toEqual(
		Array(7).fill({ kind: "rejected", error: "browser_transaction_used" }),
	);
	expect(replay).toEqual({ kind: "rejected", error: "browser_transaction_used" });
	expect(legacy).toEqual({ kind: "rejected", error: "browser_transaction_used" });
	expect(await rows(f, tables[2])).toHaveLength(1);
	expect(await rows(f, tables[3])).toHaveLength(1);
	expect(await snapshot(f)).toEqual(before);
});

it("native D1 legacy-first issuance and finalization deadline each prevent guarded reissuance", async () => {
	// Arrange
	const f = await fixture();
	expect(
		(
			await f.store.redeemAuthLinkSession(
				{
					attemptId: f.input.attemptId,
					browserTransactionHash: f.input.browserTransactionHash,
					credentialHash: f.input.credentialHash,
				},
				f.cfg,
			)
		).kind,
	).toBe("issued");
	const before = await snapshot(f);
	const expired = await fixture();
	expired.time.now += 120_000;
	const expiredBefore = await snapshot(expired);
	// Act
	const burned = await issue(f);
	const deadline = await issue(expired);
	// Assert
	expect(burned).toEqual({ kind: "rejected", error: "browser_transaction_used" });
	expect(deadline).toEqual({ kind: "rejected", error: "redeem_window_expired" });
	expect(await snapshot(f)).toEqual(before);
	expect(await snapshot(expired)).toEqual(expiredBefore);
});
