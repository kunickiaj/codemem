import { env } from "cloudflare:workers";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it } from "vitest";

const NOW = 1790899200000;
const HOUR = 3600000;
const sessions = "coordinator_auth_sessions";
const receipts = "coordinator_auth_session_receipts";
const floors = "coordinator_auth_signin_purge_floors";
let sequence = 0;
const hash = () => (++sequence).toString(16).padStart(64, "0");
const purged = (processedCount: number, more = false) => ({ kind: "purged", processedCount, more });
const rejected = (error: string) => ({ kind: "rejected", error });
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Row = Record<string, unknown>;

// Trusted internal metadata only: no JWT, cookie, provider, or live database.
async function fixture() {
	const time = { now: NOW };
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => time.now });
	const review = {
		coordinatorId: crypto.randomUUID(),
		groupId: crypto.randomUUID(),
		deviceId: crypto.randomUUID(),
		identityId: crypto.randomUUID(),
		attestationId: crypto.randomUUID(),
		reviewReceiptId: crypto.randomUUID(),
		publicKey: "fixture-public-key",
		fingerprint: hash(),
		evidenceDigest: hash(),
	};
	const cfg = {
		coordinatorId: review.coordinatorId,
		issuer: "https://accounts.example.test",
		revision: hash(),
		enabled: true,
		redirectUri: "https://app.example.test/callback",
	};
	const start = {
		attemptId: crypto.randomUUID(),
		signer: review,
		runtimeVerifierHash: hash(),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const browser = { attemptId: start.attemptId, browserTransactionHash: hash() };
	const confirm = { ...browser, completionSecretHash: hash() };
	const account = { issuer: cfg.issuer, subject: crypto.randomUUID() };
	await store.createGroup(review.groupId, "Fixture group");
	await store.enrollDevice(review.groupId, { ...review, identityId: null });
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	expect(await store.createAuthLinkAttempt(start, cfg)).toMatchObject({ kind: "created" });
	expect(await store.claimAuthLinkAttempt(browser, cfg)).toMatchObject({ kind: "applied" });
	expect(await store.recordAuthLinkOidcVerified({ ...browser, account }, cfg)).toMatchObject({
		kind: "applied",
	});
	expect(await store.confirmAuthLinkAttempt(confirm, cfg)).toMatchObject({ kind: "applied" });
	const finalize = {
		...review,
		...start,
		completionSecretHash: confirm.completionSecretHash,
		purpose: "coordinator-account-link-v1" as const,
	};
	expect(await store.finalizeAuthLinkAttempt(finalize, cfg)).toMatchObject({ kind: "applied" });
	return { time, store, cfg, review, account, browser };
}
async function rows(f: Fixture, table: string) {
	return (
		await env.COORDINATOR_DB.prepare(
			`SELECT * FROM ${table} WHERE coordinator_id = ? ORDER BY rowid`,
		)
			.bind(f.cfg.coordinatorId)
			.all<Row>()
	).results;
}
async function authority(f: Fixture) {
	return Promise.all([
		f.store.getEnrollment(f.review.groupId, f.review.deviceId),
		env.COORDINATOR_DB.prepare("SELECT * FROM coordinator_bootstrap_grants WHERE group_id = ?")
			.bind(f.review.groupId)
			.all<Row>()
			.then((result) => result.results),
		...[
			"coordinator_auth_controller_attestations",
			"coordinator_auth_account_links",
			"coordinator_auth_link_attempts",
			"coordinator_auth_link_audit_log",
			"coordinator_auth_account_profiles",
			"coordinator_scope_memberships",
		].map((table) => rows(f, table)),
	]);
}
function legacyInput(f: Fixture) {
	return { account: f.account, browserTransactionHash: hash(), credentialHash: hash() };
}
async function guarded(f: Fixture) {
	const proof = {
		purpose: "signin" as const,
		stateHash: hash(),
		binderHash: hash(),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	expect(await f.store.startAuthBrowserTransaction(proof, f.cfg)).toMatchObject({
		kind: "started",
	});
	const consumed = await f.store.consumeAuthBrowserTransaction(proof, f.cfg);
	if (consumed.kind !== "consumed") throw new Error("expected consumed transaction");
	const input = { ...legacyInput(f), browserTransactionHash: consumed.browserTransactionHash };
	const issued = await f.store.signInWithConsumedBrowserTransaction(input, f.cfg);
	if (issued.kind !== "issued") throw new Error("expected guarded session");
	return { input, session: issued.session };
}
async function updateSession(f: Fixture, sessionId: string, column: string, value: string) {
	await env.COORDINATOR_DB.prepare(
		`UPDATE ${sessions} SET ${column} = ? WHERE coordinator_id = ? AND session_id = ?`,
	)
		.bind(value, f.cfg.coordinatorId, sessionId)
		.run();
}

it("deletes guarded metadata at exactly 32 hours without reviving credentials or clearing a live profile", async () => {
	// Arrange: one old guarded source and a separate current credential share a profile.
	const f = await fixture();
	const old = await guarded(f);
	const profile = { displayName: "Fixture Person" };
	expect(
		await f.store.recordAuthAccountProfile(
			{ credentialHash: old.input.credentialHash, profile },
			f.cfg,
		),
	).toEqual({ kind: "recorded" });
	expect((await rows(f, receipts))[0]).toMatchObject({
		purge_eligible: 1,
		source: "signin",
		attempt_id: null,
	});
	f.time.now = NOW + 31 * HOUR;
	const current = await guarded(f);
	const before = await authority(f);
	f.time.now = NOW + 32 * HOUR - 1;
	// Act: the grace boundary excludes even an expired session one millisecond early.
	expect(await f.store.purgeAuthSigninBrowserTransactions(f.cfg)).toEqual(purged(1));
	const floor = await rows(f, floors);
	expect(await f.store.purgeAuthGuardedSigninSessions(f.cfg)).toEqual(purged(0));
	expect(await f.store.purgeAuthGuardedSigninReceipts(f.cfg)).toEqual(purged(0));
	f.time.now += 1;
	const removedSessions = await f.store.purgeAuthGuardedSigninSessions(f.cfg);
	const removedReceipts = await f.store.purgeAuthGuardedSigninReceipts(f.cfg);
	const live = await f.store.readAuthSessionAccount(current.input.credentialHash, f.cfg);
	f.time.now = NOW - 30 * HOUR;
	const oldRead = await f.store.readAuthSession(old.input.credentialHash, f.cfg);
	const replay = await f.store.signInWithConsumedBrowserTransaction(old.input, f.cfg);
	// Assert: deletion cannot restore old bearer authority even under a large rollback.
	expect(removedSessions).toEqual(purged(1));
	expect(removedReceipts).toEqual(purged(1));
	expect(oldRead).toBeNull();
	expect(replay).toEqual(rejected("transaction_unavailable"));
	expect(live).toEqual({ session: current.session, profile });
	expect(await rows(f, sessions)).toEqual([
		expect.objectContaining({ session_id: current.session.sessionId }),
	]);
	expect(await rows(f, receipts)).toEqual([
		expect.objectContaining({ session_id: current.session.sessionId }),
	]);
	expect(await authority(f)).toEqual(before);
	expect(await rows(f, floors)).toEqual(floor);
	expect(floor).toEqual([
		{ coordinator_id: f.cfg.coordinatorId, purged_through_created_at_ms: NOW },
	]);
});

it("waits for browser cleanup and protects receipts against either partial session match", async () => {
	// Arrange: S3 has not yet removed the old consumed browser transaction.
	const f = await fixture();
	const old = await guarded(f);
	const originalSessions = await rows(f, sessions);
	const originalReceipts = await rows(f, receipts);
	f.time.now = NOW + 32 * HOUR;
	// Act: receipt-first cleanup and lagging browser cleanup must be harmless.
	expect(await f.store.purgeAuthGuardedSigninSessions(f.cfg)).toEqual(purged(0));
	expect(await f.store.purgeAuthGuardedSigninReceipts(f.cfg)).toEqual(purged(0));
	expect(await rows(f, sessions)).toEqual(originalSessions);
	expect(await rows(f, receipts)).toEqual(originalReceipts);
	expect(await f.store.purgeAuthSigninBrowserTransactions(f.cfg)).toEqual(purged(1));
	expect(await f.store.purgeAuthGuardedSigninReceipts(f.cfg)).toEqual(purged(0));
	const alternateId = crypto.randomUUID();
	await updateSession(f, old.session.sessionId, "session_id", alternateId);
	// Hash-only and ID-only remnants each prevent receipt deletion; neither is coherent.
	expect(await f.store.purgeAuthGuardedSigninSessions(f.cfg)).toEqual(purged(0));
	expect(await f.store.purgeAuthGuardedSigninReceipts(f.cfg)).toEqual(purged(0));
	await updateSession(f, alternateId, "session_id", old.session.sessionId);
	await updateSession(f, old.session.sessionId, "browser_transaction_hash", hash());
	expect(await f.store.purgeAuthGuardedSigninSessions(f.cfg)).toEqual(purged(0));
	expect(await f.store.purgeAuthGuardedSigninReceipts(f.cfg)).toEqual(purged(0));
	expect(await rows(f, receipts)).toEqual(originalReceipts);
	await updateSession(
		f,
		old.session.sessionId,
		"browser_transaction_hash",
		old.input.browserTransactionHash,
	);
	const removedSessions = await f.store.purgeAuthGuardedSigninSessions(f.cfg);
	const removedReceipts = await f.store.purgeAuthGuardedSigninReceipts(f.cfg);
	// Assert: repairing the complete match permits ordered, repeat-safe cleanup.
	expect(removedSessions).toEqual(purged(1));
	expect(removedReceipts).toEqual(purged(1));
	expect(await rows(f, sessions)).toEqual([]);
	expect(await rows(f, receipts)).toEqual([]);
	expect(await f.store.purgeAuthGuardedSigninSessions(f.cfg)).toEqual(purged(0));
	expect(await f.store.purgeAuthGuardedSigninReceipts(f.cfg)).toEqual(purged(0));
});

it("retains legacy, redeemed and historical records forever while permitting approved trusted reuse", async () => {
	// Arrange: historical guarded metadata models the migration's default-zero policy.
	const f = await fixture();
	const legacy = legacyInput(f);
	const linkedAuthority = await authority(f);
	expect(await f.store.signInWithAuthAccount(legacy, f.cfg)).toMatchObject({ kind: "issued" });
	expect(await authority(f)).toEqual(linkedAuthority);
	expect(
		await f.store.redeemAuthLinkSession({ ...f.browser, credentialHash: hash() }, f.cfg),
	).toMatchObject({ kind: "issued" });
	const historical = await guarded(f);
	await env.COORDINATOR_DB.prepare(
		`UPDATE ${receipts} SET purge_eligible = 0 WHERE coordinator_id = ? AND browser_transaction_hash = ?`,
	)
		.bind(f.cfg.coordinatorId, historical.input.browserTransactionHash)
		.run();
	const permanentSessions = await rows(f, sessions);
	const permanentReceipts = await rows(f, receipts);
	expect(permanentReceipts.map((row) => row.purge_eligible)).toEqual([0, 0, 0]);
	const disposable = await guarded(f);
	const before = await authority(f);
	f.time.now = NOW + 64 * HOUR;
	// Act: only the new guarded row is reclaimable; trusted legacy nomination is explicit.
	expect(await f.store.purgeAuthSigninBrowserTransactions(f.cfg)).toEqual(purged(2));
	expect(await f.store.purgeAuthGuardedSigninSessions(f.cfg)).toEqual(purged(1));
	expect(await f.store.purgeAuthGuardedSigninReceipts(f.cfg)).toEqual(purged(1));
	expect(await rows(f, sessions)).toEqual(permanentSessions);
	expect(await rows(f, receipts)).toEqual(permanentReceipts);
	const floor = await rows(f, floors);
	const stillBurned = await f.store.signInWithAuthAccount(
		{ ...legacy, credentialHash: hash() },
		f.cfg,
	);
	const guardedReplay = await f.store.signInWithConsumedBrowserTransaction(disposable.input, f.cfg);
	const trustedReuse = await f.store.signInWithAuthAccount(disposable.input, f.cfg);
	// Assert: no public guarded replay; the accepted internal legacy boundary can reuse both hashes.
	expect(stillBurned).toEqual(rejected("browser_transaction_used"));
	expect(guardedReplay).toEqual(rejected("transaction_unavailable"));
	expect(trustedReuse).toMatchObject({ kind: "issued" });
	if (trustedReuse.kind !== "issued") throw new Error("expected trusted legacy session");
	expect(await f.store.readAuthSession(disposable.input.credentialHash, f.cfg)).toEqual(
		trustedReuse.session,
	);
	expect((await rows(f, receipts)).at(-1)).toMatchObject({ purge_eligible: 0, source: "signin" });
	expect(await authority(f)).toEqual(before);
	expect(await rows(f, floors)).toEqual(floor);
	f.time.now += 64 * HOUR;
	expect(await f.store.purgeAuthGuardedSigninSessions(f.cfg)).toEqual(purged(0));
	expect(await f.store.purgeAuthGuardedSigninReceipts(f.cfg)).toEqual(purged(0));
});

it("pages real D1 deletes in order, rejects invalid limits and isolates coordinators", async () => {
	// Arrange: a small deterministic page exercises the same SQL ceiling as the 256-row default.
	const f = await fixture();
	const other = await fixture();
	for (let i = 0; i < 3; i++) {
		f.time.now = NOW + i;
		await guarded(f);
	}
	await guarded(other);
	const foreign = [await rows(other, sessions), await rows(other, receipts)];
	const originalSessions = await rows(f, sessions);
	const originalReceipts = await rows(f, receipts);
	f.time.now = NOW + 32 * HOUR + 2;
	await f.store.purgeAuthSigninBrowserTransactions(f.cfg);
	// Act: invalid options cannot mutate either metadata table.
	for (const limit of [0, -1, 1.5, 257, Number.NaN]) {
		expect(await f.store.purgeAuthGuardedSigninSessions(f.cfg, { limit })).toEqual(
			rejected("invalid_input"),
		);
		expect(await f.store.purgeAuthGuardedSigninReceipts(f.cfg, { limit })).toEqual(
			rejected("invalid_input"),
		);
	}
	expect(await rows(f, sessions)).toEqual(originalSessions);
	expect(await rows(f, receipts)).toEqual(originalReceipts);
	const firstSessions = await f.store.purgeAuthGuardedSigninSessions(f.cfg, { limit: 2 });
	const firstReceipts = await f.store.purgeAuthGuardedSigninReceipts(f.cfg, { limit: 2 });
	// Assert: oldest two go first, with conservative full-page hints and no foreign effects.
	expect(firstSessions).toEqual(purged(2, true));
	expect(firstReceipts).toEqual(purged(2, true));
	expect(await rows(f, sessions)).toEqual(originalSessions.slice(2));
	expect(await rows(f, receipts)).toEqual(originalReceipts.slice(2));
	expect(await f.store.purgeAuthGuardedSigninSessions(f.cfg, { limit: 256 })).toEqual(purged(1));
	expect(await f.store.purgeAuthGuardedSigninReceipts(f.cfg, { limit: 1 })).toEqual(
		purged(1, true),
	);
	expect(await f.store.purgeAuthGuardedSigninSessions(f.cfg)).toEqual(purged(0));
	expect(await f.store.purgeAuthGuardedSigninReceipts(f.cfg)).toEqual(purged(0));
	expect([await rows(other, sessions), await rows(other, receipts)]).toEqual(foreign);
	expect(await rows(other, floors)).toEqual([]);
});
