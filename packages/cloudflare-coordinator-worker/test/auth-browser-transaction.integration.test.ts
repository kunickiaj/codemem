import { env } from "cloudflare:workers";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it } from "vitest";
import { ISSUER, oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";

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
];
const hash = () =>
	crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
function fixture() {
	const time = { now: NOW };
	const cfg = {
		coordinatorId: crypto.randomUUID(),
		issuer: ISSUER,
		revision: hash(),
		enabled: true,
		redirectUri: PROVIDER.redirectUri,
	};
	const freshStore = () =>
		new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => time.now });
	const input = {
		purpose: "signin" as const,
		stateHash: hash(),
		binderHash: hash(),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	return { time, cfg, freshStore, store: freshStore(), input };
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
async function linkFixture(f: Fixture) {
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
	const signer = {
		groupId: review.groupId,
		deviceId: review.deviceId,
		publicKey: review.publicKey,
		fingerprint: review.fingerprint,
	};
	const start = {
		attemptId: crypto.randomUUID(),
		signer,
		runtimeVerifierHash: hash(),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	await f.store.createGroup(review.groupId, "Fixture group");
	await f.store.enrollDevice(review.groupId, { ...signer, identityId: null });
	expect(await f.store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	expect(await f.store.createAuthLinkAttempt(start, f.cfg)).toMatchObject({ kind: "created" });
	return start;
}

it("consumes once across D1 store instances, clears SDK secrets and preserves proof commitments", async () => {
	// Arrange: independent instances share real D1, never a fake atomicity primitive.
	const f = fixture();
	expect(await f.store.startAuthBrowserTransaction(f.input, { ...f.cfg, enabled: false })).toEqual({
		kind: "rejected",
		error: "auth_config_changed",
	});
	expect(await rows(f)).toEqual([]);
	expect(await f.store.startAuthBrowserTransaction(f.input, f.cfg)).toEqual({
		kind: "started",
		expiresAtMs: NOW + TTL,
	});
	const before = await rows(f);
	const proofs = { stateHash: f.input.stateHash, binderHash: f.input.binderHash };
	// Act: wrong cookie and rotated config cannot spend the pending transaction.
	const wrongCookie = await f.store.consumeAuthBrowserTransaction(
		{ ...proofs, binderHash: hash() },
		f.cfg,
	);
	for (const cfg of [
		{ ...f.cfg, revision: hash() },
		{ ...f.cfg, issuer: "https://other.example.test" },
		{ ...f.cfg, redirectUri: "https://app.example.test/other" },
		{ ...f.cfg, enabled: false },
	]) {
		expect((await f.store.consumeAuthBrowserTransaction(proofs, cfg)).kind).toBe("rejected");
	}
	expect(await rows(f)).toEqual(before);
	const stores = [f.store, f.freshStore()];
	const results = await Promise.all(
		Array.from({ length: 8 }, (_, i) => stores[i % 2].consumeAuthBrowserTransaction(proofs, f.cfg)),
	);
	const winners = results.filter((result) => result.kind === "consumed");
	const after = await rows(f);
	const replay = await f.freshStore().consumeAuthBrowserTransaction(proofs, f.cfg);
	// Assert: only the durable UUID winner receives cached, unexpired SDK material.
	expect(wrongCookie).toEqual({ kind: "rejected", error: "transaction_unavailable" });
	expect(winners).toEqual([
		{
			kind: "consumed",
			purpose: "signin",
			browserTransactionHash: before[0].browser_transaction_hash,
			nonce: f.input.nonce,
			pkceVerifier: f.input.pkceVerifier,
		},
	]);
	expect(results.filter((result) => result.kind === "rejected")).toHaveLength(7);
	expect(replay).toEqual({ kind: "rejected", error: "transaction_unavailable" });
	expect(after).toEqual([
		{
			...before[0],
			state: "consumed",
			nonce: null,
			pkce_verifier: null,
			consumed_at_ms: NOW,
			claim_token: expect.stringMatching(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
		},
	]);
	expect(before[0].browser_transaction_hash).toMatch(/^[0-9a-f]{64}$/);
	expect(before[0].browser_transaction_hash).not.toBe(f.input.binderHash);
	expect(before[0].browser_transaction_hash).not.toBe(f.input.stateHash);
	// Arrange / Act / Assert: ten independent ceremonies use distinct server-generated hashes.
	const starts = await Promise.all(
		Array.from({ length: 9 }, () =>
			f
				.freshStore()
				.startAuthBrowserTransaction({ ...f.input, stateHash: hash(), binderHash: hash() }, f.cfg),
		),
	);
	expect(starts.every((result) => result.kind === "started")).toBe(true);
	const ceremonies = await rows(f);
	expect(ceremonies).toHaveLength(10);
	expect(new Set(ceremonies.map((row) => row.browser_transaction_hash)).size).toBe(10);
});

it("binds link resolution to its existing claim and deadline without granting account authority", async () => {
	// Arrange: explicit reviewed enrollment grants linking eligibility, not OIDC proof.
	const f = fixture();
	const start = await linkFixture(f);
	f.time.now += 60000;
	const input = { ...f.input, purpose: "link" as const, attemptId: start.attemptId };
	// Act: starting later must preserve the original attempt deadline.
	const started = await f.store.startAuthBrowserTransaction(input, f.cfg);
	const stored = await rows(f);
	const proof = { attemptId: start.attemptId, binderHash: input.binderHash };
	const bound = {
		attemptId: start.attemptId,
		browserTransactionHash: stored[0].browser_transaction_hash as string,
	};
	const wrong = await f.store.resolveAuthLinkBrowserTransaction(
		{ ...proof, binderHash: hash() },
		f.cfg,
	);
	const rotated = await f.store.resolveAuthLinkBrowserTransaction(proof, {
		...f.cfg,
		revision: hash(),
	});
	const other = await linkFixture(f);
	const attemptsBefore = await rows(f, protectedTables[0]);
	const collision = await f.store.startAuthBrowserTransaction(
		{ ...input, attemptId: other.attemptId },
		f.cfg,
	);
	const consumed = await f.store.consumeAuthBrowserTransaction(input, f.cfg);
	const resolved = await f.freshStore().resolveAuthLinkBrowserTransaction(proof, f.cfg);
	const verified = await f.store.recordAuthLinkOidcVerified(
		{ ...bound, account: { issuer: ISSUER, subject: "fixture-subject" } },
		f.cfg,
	);
	const confirmed = await f.store.confirmAuthLinkAttempt(
		{ ...bound, completionSecretHash: hash() },
		f.cfg,
	);
	// Assert: duplicate commitments never partially claim the other pending attempt.
	expect(started).toEqual({ kind: "started", expiresAtMs: NOW + TTL });
	expect(stored).toHaveLength(1);
	expect(stored[0]).toMatchObject({ expires_at_ms: NOW + TTL, attempt_id: start.attemptId });
	expect(attemptsBefore.find((row) => row.attempt_id === start.attemptId)).toMatchObject({
		state: "browser_claimed",
		browser_transaction_hash: bound.browserTransactionHash,
	});
	expect([wrong, rotated]).toEqual([null, null]);
	expect(collision).toEqual({ kind: "rejected", error: "transaction_conflict" });
	expect(consumed).toMatchObject({ kind: "consumed", purpose: "link", ...bound });
	expect(resolved).toEqual({ browserTransactionHash: bound.browserTransactionHash });
	expect(verified).toMatchObject({ kind: "applied" });
	expect(confirmed).toMatchObject({ kind: "applied" });
	expect(
		(await rows(f, protectedTables[0])).find((row) => row.attempt_id === other.attemptId),
	).toEqual(attemptsBefore.find((row) => row.attempt_id === other.attemptId));
	for (const name of protectedTables.slice(2, 5)) expect(await rows(f, name)).toEqual([]);
	expect(await rows(f)).toHaveLength(1);
	f.time.now = NOW + TTL;
	expect(await f.store.resolveAuthLinkBrowserTransaction(proof, f.cfg)).toBeNull();
});

it("expires forty rows in capped batches, retains burnt hashes and leaves other auth records untouched", async () => {
	// Arrange: clone actual migrated D1 columns, not an invented schema or Node fake.
	const f = fixture();
	await linkFixture(f);
	expect(await f.store.startAuthBrowserTransaction(f.input, f.cfg)).toMatchObject({
		kind: "started",
	});
	const seed = (await rows(f))[0];
	const columns = Object.keys(seed);
	const copies = Array.from({ length: 39 }, () => ({
		...seed,
		browser_transaction_hash: hash(),
		state_hash: hash(),
		binder_hash: hash(),
	}));
	await env.COORDINATOR_DB.batch(
		copies.map((row) =>
			env.COORDINATOR_DB.prepare(
				`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
			).bind(...columns.map((column) => row[column as keyof typeof row])),
		),
	);
	const before = await rows(f);
	const protectedBefore = await snapshot(f);
	f.time.now += TTL;
	// Act: malformed own options must not write, and default batches never exceed 32.
	for (const limit of [0, 33, 1.5, Number.NaN])
		expect(await f.store.maintainAuthBrowserTransactions(f.cfg, { limit })).toEqual({
			kind: "rejected",
			error: "invalid_input",
		});
	const trapped = Object.defineProperty({}, "limit", {
		get: () => {
			throw new Error("must not invoke accessor");
		},
	});
	expect(await f.store.maintainAuthBrowserTransactions(f.cfg, trapped)).toEqual({
		kind: "rejected",
		error: "invalid_input",
	});
	expect(await rows(f)).toEqual(before);
	const first = await f.store.maintainAuthBrowserTransactions(f.cfg, { limit: 32 });
	const partial = await rows(f);
	const second = await f.store.maintainAuthBrowserTransactions(f.cfg);
	const done = await f.store.maintainAuthBrowserTransactions(f.cfg);
	const after = await rows(f);
	f.time.now = NOW;
	const replay = await f.store.consumeAuthBrowserTransaction(f.input, f.cfg);
	const reused = await f.store.startAuthBrowserTransaction(f.input, f.cfg);
	// Assert: expiry clears raw material but keeps every identity and proof forever.
	expect(first).toEqual({ kind: "maintained", processedCount: 32, more: true });
	expect(partial.filter((row) => row.state === "expired")).toHaveLength(32);
	expect(second).toEqual({ kind: "maintained", processedCount: 8, more: false });
	expect(done).toEqual({ kind: "maintained", processedCount: 0, more: false });
	expect(after).toEqual(
		before.map((row) => ({ ...row, state: "expired", nonce: null, pkce_verifier: null })),
	);
	expect(new Set(after.map((row) => row.browser_transaction_hash)).size).toBe(40);
	expect(replay).toEqual({ kind: "rejected", error: "transaction_unavailable" });
	expect(reused).toEqual({ kind: "rejected", error: "transaction_conflict" });
	expect(await rows(f)).toEqual(after);
	expect(await snapshot(f)).toEqual(protectedBefore);
});

it("uses consumed SDK material in workerd while verified provider identity alone grants no session", async () => {
	// Arrange: the HTTPS provider transport is fake; SDK signatures and D1 are real.
	const f = fixture();
	const provider = oidcFixture();
	const { client, input } = await provider.begin();
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input.material.state),
	);
	const stateHash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const start = {
		...f.input,
		stateHash,
		nonce: input.material.nonce,
		pkceVerifier: input.material.pkceVerifier,
	};
	const before = await snapshot(f);
	expect(await f.store.startAuthBrowserTransaction(start, f.cfg)).toMatchObject({
		kind: "started",
	});
	// Act: consume before SDK exchange; raw state stays only in this trusted caller.
	const consumed = await f.store.consumeAuthBrowserTransaction(start, f.cfg);
	if (consumed.kind !== "consumed") throw new Error(consumed.error);
	expect((await rows(f))[0]).toMatchObject({ state: "consumed", nonce: null, pkce_verifier: null });
	const material = {
		state: input.material.state,
		nonce: consumed.nonce,
		pkceVerifier: consumed.pkceVerifier,
	};
	const verified = await client.verifyCallback({ callbackUrl: input.callbackUrl, material });
	const replay = await client.verifyCallback({ callbackUrl: input.callbackUrl, material });
	if (!verified.ok) throw new Error(verified.error);
	const denied = await f.store.signInWithAuthAccount(
		{
			account: verified.account,
			browserTransactionHash: consumed.browserTransactionHash,
			credentialHash: hash(),
		},
		f.cfg,
	);
	// Assert: provider display metadata is not coordinator linking authority.
	expect(verified).toEqual({
		ok: true,
		account: { issuer: ISSUER, subject: "fixture-subject" },
		profile: {
			displayName: "Fixture User",
			email: "user@example.test",
			emailVerified: true,
			pictureUrl: "https://images.example.test/avatar.png",
		},
	});
	expect(replay).toEqual({ ok: false, error: "oidc_verification_failed" });
	expect(denied.kind).toBe("rejected");
	expect(await snapshot(f)).toEqual(before);
	expect(JSON.stringify(await rows(f))).not.toMatch(
		/fixture-access-token|fixture-refresh-token|fixture-subject|user@example.test/,
	);
});
