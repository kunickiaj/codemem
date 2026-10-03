import { env } from "cloudflare:workers";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it } from "vitest";

const NOW = 1790899200000;
const TTL = 600000;
const table = "coordinator_auth_browser_transactions";
const protectedTables = [
	"coordinator_auth_link_attempts",
	"coordinator_auth_controller_attestations",
	"coordinator_auth_account_links",
	"coordinator_auth_sessions",
	"coordinator_auth_session_receipts",
	"coordinator_auth_link_audit_log",
	"coordinator_auth_account_profiles",
];
let sequence = 0;
const hash = () => (++sequence).toString(16).padStart(64, "0");
// Trusted store fixtures only; no HTTP cookie/CSRF/Origin or signed-device verification.
function fixture() {
	const time = { now: NOW };
	const cfg = {
		coordinatorId: crypto.randomUUID(),
		issuer: "https://accounts.example.test",
		revision: hash(),
		enabled: true,
		redirectUri: "https://app.example.test/callback",
	};
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => time.now });
	const material = () => ({
		purpose: "signin" as const,
		stateHash: hash(),
		binderHash: hash(),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	});
	return { time, cfg, store, material };
}
type Fixture = ReturnType<typeof fixture>;
async function rows(f: Fixture, name = table) {
	return (
		await env.COORDINATOR_DB.prepare(
			`SELECT * FROM ${name} WHERE coordinator_id = ? ORDER BY rowid`,
		)
			.bind(f.cfg.coordinatorId)
			.all<Record<string, unknown>>()
	).results;
}
const snapshot = (f: Fixture) => Promise.all(protectedTables.map((name) => rows(f, name)));
const expired = (row: Record<string, unknown>) => ({
	...row,
	state: "expired",
	nonce: null,
	pkce_verifier: null,
});
async function startLink(f: Fixture) {
	const review = {
		coordinatorId: f.cfg.coordinatorId,
		groupId: crypto.randomUUID(),
		deviceId: crypto.randomUUID(),
		identityId: crypto.randomUUID(),
		attestationId: crypto.randomUUID(),
		reviewReceiptId: crypto.randomUUID(),
		publicKey: "fixture-public-key",
		fingerprint: hash(),
		evidenceDigest: hash(),
	};
	const attemptId = crypto.randomUUID();
	await f.store.createGroup(review.groupId, "Fixture group");
	await f.store.enrollDevice(review.groupId, { ...review, identityId: null });
	expect(await f.store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	const created = await f.store.createAuthLinkAttempt(
		{
			attemptId,
			signer: review,
			runtimeVerifierHash: hash(),
			loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
		},
		f.cfg,
	);
	expect(created).toMatchObject({ kind: "created" });
	const input = { ...f.material(), purpose: "link" as const, attemptId };
	expect(await f.store.startAuthBrowserTransaction(input, f.cfg)).toMatchObject({
		kind: "started",
	});
	return input;
}

it("cancels only the owning signin cookie, preserves commitments and denies replay", async () => {
	// Arrange: consumed and link ceremonies are not cancellable signins.
	const f = fixture();
	const input = f.material();
	const consumed = f.material();
	await f.store.startAuthBrowserTransaction(input, f.cfg);
	await f.store.startAuthBrowserTransaction(consumed, f.cfg);
	await f.store.consumeAuthBrowserTransaction(consumed, f.cfg);
	const link = await startLink(f);
	const before = await rows(f);
	const protectedBefore = await snapshot(f);
	// Act: neither a wrong cookie nor a different coordinator owns the pending row.
	for (const [binderHash, coordinatorId] of [
		[hash(), f.cfg.coordinatorId],
		[input.binderHash, crypto.randomUUID()],
		[consumed.binderHash, f.cfg.coordinatorId],
		[link.binderHash, f.cfg.coordinatorId],
	])
		expect(
			await f.store.cancelAuthSigninBrowserTransaction({ binderHash }, { coordinatorId }),
		).toEqual({ kind: "unavailable" });
	expect(await rows(f)).toEqual(before);
	f.time.now = NOW - 1;
	const cancelled = await f.store.cancelAuthSigninBrowserTransaction(input, f.cfg);
	const retry = await f.store.cancelAuthSigninBrowserTransaction(input, f.cfg);
	f.time.now = NOW;
	const replay = await f.store.consumeAuthBrowserTransaction(input, f.cfg);
	// Assert: explicit owner cancellation works even for future-born rows, without renewal.
	expect(cancelled).toEqual({ kind: "cancelled" });
	expect(retry).toEqual(cancelled);
	expect(replay).toEqual({ kind: "rejected", error: "transaction_unavailable" });
	expect(await rows(f)).toEqual([expired(before[0]), ...before.slice(1)]);
	expect(await snapshot(f)).toEqual(protectedBefore);
});

it("retires failed link material without restoring authority, then sweeps changed config", async () => {
	// Arrange: both links start with exact, live browser claims under the original metadata.
	const f = fixture();
	const failed = await startLink(f);
	const live = await startLink(f);
	const proof = await f.store.resolveAuthLinkBrowserTransaction(failed, f.cfg);
	if (!proof) throw new Error("expected browser claim");
	const failure = await f.store.failAuthLinkAttempt(
		{
			attemptId: failed.attemptId,
			requester: { kind: "browser", browserTransactionHash: proof.browserTransactionHash },
			reason: "provider_failure",
		},
		f.cfg,
	);
	expect(failure).toMatchObject({ kind: "applied" });
	const before = await rows(f);
	const protectedBefore = await snapshot(f);
	// Act: attempt-local retirement must not touch the other still-live claim.
	const result = await f.store.retireAuthBrowserTransactions(f.cfg, {
		attemptId: failed.attemptId,
	});
	const partial = await rows(f);
	const noOp = await f.store.retireAuthBrowserTransactions(f.cfg);
	const denied = await f.store.resolveAuthLinkBrowserTransaction(failed, f.cfg);
	const stillLive = await f.store.resolveAuthLinkBrowserTransaction(live, f.cfg);
	const rotated = await f.store.retireAuthBrowserTransactions({ ...f.cfg, revision: hash() });
	const signin = f.material();
	await f.store.startAuthBrowserTransaction(signin, f.cfg);
	const disabled = await f.store.retireAuthBrowserTransactions({ ...f.cfg, enabled: false });
	// Assert: sweeps change only transaction state/secrets; attempts and grants stay fixed.
	expect(result).toEqual({ kind: "retired", processedCount: 1, more: false });
	expect(partial).toEqual([expired(before[0]), before[1]]);
	expect(noOp).toEqual({ kind: "retired", processedCount: 0, more: false });
	expect(denied).toBeNull();
	expect(stillLive).toEqual({ browserTransactionHash: before[1].browser_transaction_hash });
	for (const result of [rotated, disabled])
		expect(result).toEqual({ kind: "retired", processedCount: 1, more: false });
	expect((await rows(f)).slice(0, 2)).toEqual(before.map(expired));
	expect((await rows(f))[2]).toMatchObject({ state: "expired", nonce: null, pkce_verifier: null });
	expect(await snapshot(f)).toEqual(protectedBefore);
});

it("scoped retirement clears a dead future-born link but protects a future-born live claim", async () => {
	// Arrange: resolve trusted browser metadata before rolling back below both births.
	const f = fixture();
	const failed = await startLink(f);
	const live = await startLink(f);
	const proof = await f.store.resolveAuthLinkBrowserTransaction(failed, f.cfg);
	if (!proof) throw new Error("expected browser claim");
	const before = await rows(f);
	f.time.now = NOW - 1;
	const changed = { ...f.cfg, enabled: false, revision: hash() };
	// Act: a general sweep cannot retire future-born rows even under changed config.
	expect(await f.store.retireAuthBrowserTransactions(changed)).toEqual({
		kind: "retired",
		processedCount: 0,
		more: false,
	});
	expect(await rows(f)).toEqual(before);
	expect(
		await f.store.failAuthLinkAttempt(
			{
				attemptId: failed.attemptId,
				requester: { kind: "browser", browserTransactionHash: proof.browserTransactionHash },
				reason: "cancelled",
			},
			f.cfg,
		),
	).toMatchObject({ kind: "applied" });
	const protectedBefore = await snapshot(f);
	expect(await f.store.retireAuthBrowserTransactions(changed)).toEqual({
		kind: "retired",
		processedCount: 0,
		more: false,
	});
	expect(await rows(f)).toEqual(before);
	const retired = await f.store.retireAuthBrowserTransactions(changed, {
		attemptId: failed.attemptId,
	});
	const protectedLive = await f.store.retireAuthBrowserTransactions(changed, {
		attemptId: live.attemptId,
	});
	// Assert: explicit dead-attempt cleanup changes only its transaction state/secrets.
	expect(retired).toEqual({ kind: "retired", processedCount: 1, more: false });
	expect(protectedLive).toEqual({ kind: "retired", processedCount: 0, more: false });
	expect(await rows(f)).toEqual([expired(before[0]), before[1]]);
	expect(await snapshot(f)).toEqual(protectedBefore);
	f.time.now = NOW;
	expect(await f.store.consumeAuthBrowserTransaction(failed, f.cfg)).toEqual({
		kind: "rejected",
		error: "transaction_unavailable",
	});
	expect(await f.store.resolveAuthLinkBrowserTransaction(failed, f.cfg)).toBeNull();
	expect(await rows(f)).toEqual([expired(before[0]), before[1]]);
	expect(await snapshot(f)).toEqual(protectedBefore);
});

it("retires forty rows in real D1 batches, rejecting invalid options and preserving future/foreign rows", async () => {
	// Arrange: clone migrated columns and isolate every query to this test's coordinator.
	const f = fixture();
	const other = fixture();
	const input = f.material();
	await f.store.startAuthBrowserTransaction(input, f.cfg);
	await other.store.startAuthBrowserTransaction(other.material(), other.cfg);
	const seed = (await rows(f))[0];
	const columns = Object.keys(seed);
	const copies = Array.from({ length: 40 }, (_, index) => ({
		...seed,
		browser_transaction_hash: hash(),
		state_hash: hash(),
		binder_hash: hash(),
		created_at_ms: index === 39 ? NOW + TTL + 1 : NOW,
		expires_at_ms: index === 39 ? NOW + TTL * 2 + 1 : NOW + TTL,
	}));
	await env.COORDINATOR_DB.batch(
		copies.map((row) =>
			env.COORDINATOR_DB.prepare(
				`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
			).bind(...columns.map((column) => row[column as keyof typeof row])),
		),
	);
	const before = await rows(f);
	const foreign = [await rows(other), await snapshot(other)];
	const protectedBefore = await snapshot(f);
	f.time.now += TTL;
	// Act: invalid values/accessors cannot run user code or change D1.
	let getterCalls = 0;
	const accessor = Object.defineProperty({}, "limit", {
		get: () => {
			getterCalls++;
			return 1;
		},
	});
	for (const options of [{ limit: 0 }, { limit: 33 }, { limit: 1.5 }, accessor])
		expect(await f.store.retireAuthBrowserTransactions(f.cfg, options)).toEqual({
			kind: "rejected",
			error: "invalid_input",
		});
	expect(getterCalls).toBe(0);
	expect(await rows(f)).toEqual(before);
	const first = await f.store.retireAuthBrowserTransactions({ ...f.cfg, enabled: false });
	const partial = await rows(f);
	const second = await f.store.retireAuthBrowserTransactions(f.cfg);
	const done = await f.store.retireAuthBrowserTransactions(f.cfg);
	f.time.now = NOW;
	const replay = await f.store.consumeAuthBrowserTransaction(input, f.cfg);
	// Assert: 32 + 8 retirements preserve deadlines/hashes, future rows and other tables.
	expect(first).toEqual({ kind: "retired", processedCount: 32, more: true });
	expect(partial.filter((row) => row.state === "expired")).toHaveLength(32);
	expect(second).toEqual({ kind: "retired", processedCount: 8, more: false });
	expect(done).toEqual({ kind: "retired", processedCount: 0, more: false });
	expect(await rows(f)).toEqual(
		before.map((row) => {
			if (Number(row.created_at_ms) > NOW + TTL) return row;
			return expired(row);
		}),
	);
	expect(replay).toEqual({ kind: "rejected", error: "transaction_unavailable" });
	expect(await snapshot(f)).toEqual(protectedBefore);
	expect([await rows(other), await snapshot(other)]).toEqual(foreign);
});
