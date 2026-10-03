import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it } from "vitest";

const NOW = 1790899200000;
const TTL = 28800000;
const browserTable = "coordinator_auth_browser_transactions";
const sessionTable = "coordinator_auth_sessions";
const receiptTable = "coordinator_auth_session_receipts";
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Config = Parameters<D1CoordinatorStore["signInWithConsumedBrowserTransaction"]>[1];
let sequence = 0;
const hash = () => (++sequence).toString(16).padStart(64, "0");

// Trusted metadata only: no JWT/signature, provider, public cookie or CSRF verification.
async function fixture(config?: Config) {
	const time = { now: NOW };
	const fresh = () => new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => time.now });
	const store = fresh();
	const cfg = config ?? {
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
	const browser = { attemptId: start.attemptId, browserTransactionHash: hash() };
	const confirm = { ...browser, completionSecretHash: hash() };
	const account = { issuer: cfg.issuer, subject: randomUUID() };
	await store.createGroup(review.groupId, "Fixture group");
	await store.enrollDevice(review.groupId, { ...review, identityId: null });
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	expect(await store.createAuthLinkAttempt(start, cfg)).toMatchObject({ kind: "created" });
	expect(await store.claimAuthLinkAttempt(browser, cfg)).toMatchObject({ kind: "applied" });
	expect(await store.recordAuthLinkOidcVerified({ ...browser, account }, cfg)).toMatchObject({
		kind: "applied",
	});
	expect(await store.confirmAuthLinkAttempt(confirm, cfg)).toMatchObject({ kind: "applied" });
	expect(
		await store.finalizeAuthLinkAttempt(
			{
				...review,
				...start,
				completionSecretHash: confirm.completionSecretHash,
				purpose: "coordinator-account-link-v1",
			},
			cfg,
		),
	).toMatchObject({ kind: "applied" });
	// Finalize without redeeming: the ten-slot budget starts empty.
	return { time, fresh, store, cfg, account, review };
}

async function rows(f: Fixture, table = sessionTable) {
	return (
		await env.COORDINATOR_DB.prepare(
			`SELECT * FROM ${table} WHERE coordinator_id = ? ORDER BY rowid`,
		)
			.bind(f.cfg.coordinatorId)
			.all<Record<string, unknown>>()
	).results;
}

async function transaction(f: Fixture, options: { pending?: boolean; cfg?: Config } = {}) {
	const cfg = options.cfg ?? f.cfg;
	const proofs = {
		stateHash: hash(),
		binderHash: hash(),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	expect(
		await f.store.startAuthBrowserTransaction({ ...proofs, purpose: "signin" }, cfg),
	).toMatchObject({ kind: "started" });
	let browserTransactionHash: string;
	if (options.pending) {
		const row = (await rows(f, browserTable)).find((row) => row.state_hash === proofs.stateHash);
		browserTransactionHash = String(row?.browser_transaction_hash);
	} else {
		const consumed = await f.store.consumeAuthBrowserTransaction(proofs, cfg);
		if (consumed.kind !== "consumed") throw new Error(consumed.error);
		browserTransactionHash = consumed.browserTransactionHash;
	}
	return { account: f.account, browserTransactionHash, credentialHash: hash() };
}

function issue(f: Fixture, input: Awaited<ReturnType<typeof transaction>>, cfg = f.cfg) {
	return f.store.signInWithConsumedBrowserTransaction(input, cfg);
}

async function change(f: Fixture, table: string, assignments: string, hashValue: string) {
	await env.COORDINATOR_DB.prepare(
		`UPDATE ${table} SET ${assignments} WHERE coordinator_id = ? AND browser_transaction_hash = ?`,
	)
		.bind(f.cfg.coordinatorId, hashValue)
		.run();
}

it("admits only consumed sign-in rows once and preserves session/profile compatibility", async () => {
	// Arrange: rejected rows are real migrated D1 rows, not nominated public metadata.
	const f = await fixture();
	const pending = await transaction(f, { pending: true });
	const link = await transaction(f);
	await change(
		f,
		browserTable,
		`purpose = 'link', attempt_id = '${randomUUID()}'`,
		link.browserTransactionHash,
	);
	const retired = await transaction(f);
	await change(
		f,
		browserTable,
		"state = 'expired', claim_token = NULL, consumed_at_ms = NULL",
		retired.browserTransactionHash,
	);
	const input = await transaction(f);
	// Act: failures cannot mint; concurrent replays compete on one receipt.
	for (const denied of [pending, link, retired, { ...input, browserTransactionHash: hash() }])
		expect(await issue(f, denied)).toEqual({ kind: "rejected", error: "transaction_unavailable" });
	for (const cfg of [
		{ ...f.cfg, revision: hash() },
		{ ...f.cfg, redirectUri: "https://app.example.test/other" },
	])
		expect(await issue(f, input, cfg)).toEqual({
			kind: "rejected",
			error: "transaction_unavailable",
		});
	expect(await issue(f, { ...input, account: { ...f.account, subject: randomUUID() } })).toEqual({
		kind: "rejected",
		error: "account_not_linked",
	});
	expect(
		await issue(f, { ...input, account: { ...f.account, issuer: "https://other.example.test" } }),
	).toEqual({ kind: "rejected", error: "invalid_input" });
	expect(await rows(f)).toHaveLength(0);
	expect(await rows(f, receiptTable)).toHaveLength(0);
	const results = await Promise.all([
		issue(f, input),
		f.fresh().signInWithConsumedBrowserTransaction({ ...input, credentialHash: hash() }, f.cfg),
	]);
	const winner = results.find((result) => result.kind === "issued");
	if (winner?.kind !== "issued") throw new Error("expected_one_winner");
	const persisted = (await rows(f))[0];
	const credential = String(persisted.credential_hash);
	const profile = { displayName: "Fixture Person" };
	const recorded = await f.store.recordAuthAccountProfile(
		{ credentialHash: credential, profile },
		f.cfg,
	);
	const read = await f.store.readAuthSessionAccount(credential, f.cfg);
	const replay = await issue(f, { ...input, credentialHash: hash() });
	// Assert: normal sign-in provenance, an old-compatible DTO and absolute eight hours.
	expect(results.filter((result) => result.kind === "issued")).toHaveLength(1);
	expect(results).toContainEqual({ kind: "rejected", error: "browser_transaction_used" });
	expect(replay).toEqual({ kind: "rejected", error: "browser_transaction_used" });
	expect(winner.session).toEqual({
		sessionId: expect.any(String),
		identityId: f.review.identityId,
		linkId: expect.any(String),
		account: f.account,
		expiresAtMs: NOW + TTL,
	});
	expect(recorded).toEqual({ kind: "recorded" });
	expect(read).toEqual({ session: winner.session, profile });
	expect(await rows(f, receiptTable)).toEqual([expect.objectContaining({ source: "signin" })]);
	f.time.now = NOW + TTL - 1;
	expect(await f.store.readAuthSession(credential, f.cfg)).toEqual(winner.session);
	f.time.now += 1;
	expect(await f.store.readAuthSession(credential, f.cfg)).toBeNull();
	expect(await rows(f)).toEqual([persisted]);
});

it("serializes fourteen admissions at ten slots without eviction and frees revoked/expired slots", async () => {
	// Arrange: two store instances share D1 and fourteen distinct consumed ceremonies.
	const f = await fixture();
	const inputs = await Promise.all(Array.from({ length: 14 }, () => transaction(f)));
	const browsers = await rows(f, browserTable);
	const stores = [f.store, f.fresh()];
	// Act
	const results = await Promise.all(
		inputs.map((input, i) => stores[i % 2].signInWithConsumedBrowserTransaction(input, f.cfg)),
	);
	const before = await rows(f);
	const limited = inputs.filter((_, i) => results[i].kind === "rejected");
	expect(await rows(f, receiptTable)).toHaveLength(10);
	expect(await rows(f, browserTable)).toEqual(browsers);
	const sameCoordinator = await fixture(f.cfg);
	const otherCoordinator = await fixture();
	const independent = await Promise.all([
		issue(sameCoordinator, await transaction(sameCoordinator)),
		issue(otherCoordinator, await transaction(otherCoordinator)),
	]);
	// Assert: limits are per link/config/coordinator and rejected requests write nothing.
	expect(results.filter((result) => result.kind === "issued")).toHaveLength(10);
	expect(results.filter((result) => result.kind === "rejected")).toEqual(
		Array(4).fill({ kind: "rejected", error: "session_limited" }),
	);
	expect(before).toHaveLength(10);
	expect(await rows(f, receiptTable)).toHaveLength(11);
	expect(independent.map((result) => result.kind)).toEqual(["issued", "issued"]);
	// Arrange / Act: logout frees one slot without evicting or refreshing other sessions.
	await f.store.signOutAuthSession(String(before[0].credential_hash), f.cfg);
	f.time.now += 1;
	expect((await issue(f, limited[0])).kind).toBe("issued");
	expect(await issue(f, limited[1])).toEqual({ kind: "rejected", error: "session_limited" });
	expect(
		(await rows(f)).filter((row) =>
			before.slice(1).some((old) => old.session_id === row.session_id),
		),
	).toEqual(before.slice(1));
	// Arrange / Act / Assert: absolute expiry also frees capacity, not a sliding read.
	f.time.now = NOW + TTL;
	const fresh = await transaction(f);
	expect((await issue(f, fresh)).kind).toBe("issued");
	expect(await f.store.readAuthSession(String(before[1].credential_hash), f.cfg)).toBeNull();
	expect((await rows(f)).find((row) => row.session_id === before[1].session_id)).toEqual(before[1]);
});

it("ignores old revisions while future-born current-config sessions reserve all ten slots", async () => {
	// Arrange: genesis link revision stays old while ten old sessions remain unexpired.
	const f = await fixture();
	for (let i = 0; i < 10; i++) expect((await issue(f, await transaction(f))).kind).toBe("issued");
	const old = await rows(f);
	const cfg = { ...f.cfg, revision: "b".repeat(64) };
	// Act: new revision has its own budget despite the old link creation revision.
	for (let i = 0; i < 10; i++)
		expect((await issue(f, await transaction(f, { cfg }), cfg)).kind).toBe("issued");
	const current = (await rows(f)).filter((row) => row.auth_config_revision === cfg.revision);
	await env.COORDINATOR_DB.prepare(
		`UPDATE ${sessionTable} SET created_at_ms = ?, expires_at_ms = ? WHERE coordinator_id = ? AND auth_config_revision = ?`,
	)
		.bind(NOW + 1, NOW + 1 + TTL, f.cfg.coordinatorId, cfg.revision)
		.run();
	const limited = await issue(f, await transaction(f, { cfg }), cfg);
	// Assert: unreadable future-born sessions still reserve capacity, failing closed.
	expect(limited).toEqual({ kind: "rejected", error: "session_limited" });
	expect(await rows(f)).toHaveLength(20);
	expect(await rows(f, receiptTable)).toHaveLength(20);
	expect((await rows(f, "coordinator_auth_account_links"))[0].auth_config_revision).toBe(
		f.cfg.revision,
	);
	expect((await rows(f)).filter((row) => row.auth_config_revision === f.cfg.revision)).toEqual(old);
	for (const row of [...old, ...current])
		expect(await f.store.readAuthSession(String(row.credential_hash), cfg)).toBeNull();
});

it("denies consumed rows at expiry and future consumption without burning a valid retry", async () => {
	// Arrange: all timestamps use the injected clock, never wall time or timers.
	const f = await fixture();
	const expired = await transaction(f);
	const future = await transaction(f);
	await change(f, browserTable, `consumed_at_ms = ${NOW + 1}`, future.browserTransactionHash);
	// Act
	const futureDenied = await issue(f, future);
	f.time.now = NOW + 600000;
	const expiredDenied = await issue(f, expired);
	// Assert: boundary failures leave both receipts and sessions empty.
	expect(futureDenied).toEqual({ kind: "rejected", error: "transaction_unavailable" });
	expect(expiredDenied).toEqual({ kind: "rejected", error: "transaction_unavailable" });
	expect(await rows(f)).toHaveLength(0);
	expect(await rows(f, receiptTable)).toHaveLength(0);
	// Arrange / Act / Assert: a still-live valid retry can win after a clock-bound denial.
	f.time.now = NOW + 1;
	expect((await issue(f, future)).kind).toBe("issued");
	await f.store.revokeAuthAccountLink({ linkId: String((await rows(f))[0].link_id) }, f.cfg);
	expect(await issue(f, await transaction(f))).toEqual({
		kind: "rejected",
		error: "account_not_linked",
	});
	expect(await rows(f)).toHaveLength(1);
	expect(await rows(f, receiptTable)).toHaveLength(1);
});
