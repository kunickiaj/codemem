import { env } from "cloudflare:workers";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { expect, it } from "vitest";

const NOW = 1790899200000;
const HOUR = 3600000;
const browserTable = "coordinator_auth_browser_transactions";
const floorTable = "coordinator_auth_signin_purge_floors";
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
const purged = (processedCount: number, more = false) => ({ kind: "purged", processedCount, more });
const rejected = (error: string) => ({ kind: "rejected", error });
const floorRow = (f: Fixture, createdAtMs: number) => [
	{ coordinator_id: f.cfg.coordinatorId, purged_through_created_at_ms: createdAtMs },
];
type Row = Record<string, unknown>;
type Fixture = ReturnType<typeof fixture>;

// Trusted store metadata only; no provider, signatures, cookies or live databases.
function fixture() {
	const time = { now: NOW };
	const cfg = {
		coordinatorId: crypto.randomUUID(),
		issuer: "https://accounts.example.test",
		revision: hash(),
		enabled: true,
		redirectUri: "https://app.example.test/callback",
	};
	const fresh = () => new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => time.now });
	const material = () => ({
		purpose: "signin" as const,
		stateHash: hash(),
		binderHash: hash(),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	});
	return { time, cfg, fresh, store: fresh(), material };
}
async function rows(f: Fixture, table = browserTable) {
	return (
		await env.COORDINATOR_DB.prepare(
			`SELECT * FROM ${table} WHERE coordinator_id = ? ORDER BY rowid`,
		)
			.bind(f.cfg.coordinatorId)
			.all<Row>()
	).results;
}
const snapshot = (f: Fixture) => Promise.all(protectedTables.map((table) => rows(f, table)));
async function seed(f: Fixture, count: number, overrides: (i: number) => Row = () => ({})) {
	const original = (await rows(f))[0];
	const columns = Object.keys(original);
	const copies = Array.from({ length: count }, (_, i) => ({
		...original,
		browser_transaction_hash: hash(),
		state_hash: hash(),
		binder_hash: hash(),
		...overrides(i),
	}));
	// One row per statement stays below D1's 100-bind limit; batches stay small.
	for (let offset = 0; offset < copies.length; offset += 64) {
		await env.COORDINATOR_DB.batch(
			copies
				.slice(offset, offset + 64)
				.map((row) =>
					env.COORDINATOR_DB.prepare(
						`INSERT INTO ${browserTable} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
					).bind(...columns.map((column) => row[column as keyof typeof row])),
				),
		);
	}
}
async function linkedAccount(f: Fixture) {
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
	const start = {
		attemptId: crypto.randomUUID(),
		signer: review,
		runtimeVerifierHash: hash(),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const browser = { attemptId: start.attemptId, browserTransactionHash: hash() };
	const confirm = { ...browser, completionSecretHash: hash() };
	const account = { issuer: f.cfg.issuer, subject: crypto.randomUUID() };
	await f.store.createGroup(review.groupId, "Fixture group");
	await f.store.enrollDevice(review.groupId, { ...review, identityId: null });
	expect(await f.store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	expect(await f.store.createAuthLinkAttempt(start, f.cfg)).toMatchObject({ kind: "created" });
	expect(await f.store.claimAuthLinkAttempt(browser, f.cfg)).toMatchObject({ kind: "applied" });
	expect(await f.store.recordAuthLinkOidcVerified({ ...browser, account }, f.cfg)).toMatchObject({
		kind: "applied",
	});
	expect(await f.store.confirmAuthLinkAttempt(confirm, f.cfg)).toMatchObject({ kind: "applied" });
	expect(
		await f.store.finalizeAuthLinkAttempt(
			{
				...review,
				...start,
				completionSecretHash: confirm.completionSecretHash,
				purpose: "coordinator-account-link-v1",
			},
			f.cfg,
		),
	).toMatchObject({ kind: "applied" });
	return { review, browser, account };
}

it("purges only aged signins in bounded order, leaving links, authority and foreign rows intact", async () => {
	// Arrange: an empty coordinator must not receive a speculative cutoff floor.
	const f = fixture();
	const other = fixture();
	expect(await f.store.purgeAuthSigninBrowserTransactions(f.cfg, { limit: 257 })).toEqual(
		rejected("invalid_input"),
	);
	expect(await f.store.purgeAuthSigninBrowserTransactions(f.cfg)).toEqual(purged(0));
	expect(await rows(f, floorTable)).toEqual([]);
	const linked = await linkedAccount(f);
	await f.store.startAuthBrowserTransaction(f.material(), f.cfg);
	await seed(f, 5, (i) => {
		const created = NOW + [10, 20, 100, 101, 0][i];
		const row: Row = { created_at_ms: created, expires_at_ms: created + 600000 };
		if (i === 0)
			Object.assign(row, {
				state: "consumed",
				nonce: null,
				pkce_verifier: null,
				claim_token: hash(),
				consumed_at_ms: created,
			});
		if (i === 1) Object.assign(row, { state: "expired", nonce: null, pkce_verifier: null });
		if (i === 4) Object.assign(row, { purpose: "link", attempt_id: linked.browser.attemptId });
		return row;
	});
	await other.store.startAuthBrowserTransaction(other.material(), other.cfg);
	const before = await rows(f);
	const protectedBefore = await snapshot(f);
	const enrollment = await f.store.getEnrollment(linked.review.groupId, linked.review.deviceId);
	const foreign = await rows(other);
	f.time.now = NOW + 2 * HOUR + 100;
	// Act: floor uses the greatest actual eligible birth, not each page's last deletion.
	const first = await f.store.purgeAuthSigninBrowserTransactions(f.cfg, { limit: 3 });
	const partial = await rows(f);
	const second = await f.store.purgeAuthSigninBrowserTransactions(f.cfg, { limit: 2 });
	f.time.now = NOW + 2 * HOUR + 20;
	const repeat = await f.store.purgeAuthSigninBrowserTransactions(f.cfg);
	// Assert: exact two hours qualifies; one millisecond younger and every link survive.
	expect(first).toEqual(purged(3, true));
	expect(partial).toEqual(before.slice(3));
	expect(second).toEqual(purged(1));
	expect(repeat).toEqual(purged(0));
	expect(await rows(f)).toEqual(before.slice(4));
	expect(await rows(f, floorTable)).toEqual(floorRow(f, NOW + 100));
	expect(await snapshot(f)).toEqual(protectedBefore);
	expect(await f.store.getEnrollment(linked.review.groupId, linked.review.deviceId)).toEqual(
		enrollment,
	);
	expect(await rows(other)).toEqual(foreign);
	expect(await rows(other, floorTable)).toEqual([]);
});

it("reclaims 1024 rows and blocks rollback starts across config rotation until the exact one-hour boundary", async () => {
	// Arrange: keep one consumed, unissued transaction so missing-row denial is independent of receipts.
	const f = fixture();
	const proof = f.material();
	await f.store.startAuthBrowserTransaction(proof, f.cfg);
	const consumed = await f.store.consumeAuthBrowserTransaction(proof, f.cfg);
	if (consumed.kind !== "consumed") throw new Error("expected consumed transaction");
	await seed(f, 1023, () => ({
		state: "pending",
		nonce: "n".repeat(43),
		pkce_verifier: "p".repeat(43),
		claim_token: null,
		consumed_at_ms: null,
	}));
	f.time.now = NOW + 2 * HOUR;
	// Act: default pages have a strict 256-row operational ceiling.
	const pages = [];
	for (let i = 0; i < 4; i++) pages.push(await f.store.purgeAuthSigninBrowserTransactions(f.cfg));
	const completed = await f.store.purgeAuthSigninBrowserTransactions(f.cfg);
	const rotated = { ...f.cfg, revision: hash(), redirectUri: "https://app.example.test/rotated" };
	for (const clock of [NOW + HOUR / 2, NOW + HOUR - 1]) {
		f.time.now = clock;
		for (const cfg of [f.cfg, rotated])
			expect(await f.fresh().startAuthBrowserTransaction(f.material(), cfg)).toEqual(
				rejected("clock_retention_blocked"),
			);
	}
	f.time.now = NOW + 1;
	const callback = await f.store.consumeAuthBrowserTransaction(proof, f.cfg);
	const signin = await f.store.signInWithConsumedBrowserTransaction(
		{
			account: { issuer: f.cfg.issuer, subject: "unissued" },
			browserTransactionHash: consumed.browserTransactionHash,
			credentialHash: hash(),
		},
		f.cfg,
	);
	const cancel = await f.store.cancelAuthSigninBrowserTransaction(proof, f.cfg);
	const other = fixture();
	const independent = await other.store.startAuthBrowserTransaction(other.material(), other.cfg);
	expect(await rows(f)).toEqual([]);
	f.time.now = NOW + HOUR;
	const boundary = await f.store.startAuthBrowserTransaction(f.material(), rotated);
	// Assert: missing ceremonies cannot mint, consume or cancel, but the safe boundary admits.
	// A full page is a conservative "more" hint; an empty follow-up confirms completion.
	expect(pages).toEqual(Array.from({ length: 4 }, () => purged(256, true)));
	expect(completed).toEqual(purged(0));
	for (const result of [callback, signin])
		expect(result).toEqual(rejected("transaction_unavailable"));
	expect(cancel).toEqual({ kind: "unavailable" });
	expect(independent).toMatchObject({ kind: "started" });
	expect(boundary).toMatchObject({ kind: "started" });
	expect(await rows(f)).toHaveLength(1);
	expect(await rows(f, "coordinator_auth_session_receipts")).toEqual([]);
	expect(await rows(f, "coordinator_auth_sessions")).toEqual([]);
	expect(await rows(f, floorTable)).toEqual(floorRow(f, NOW));
});

it("keeps an issued session and profile live after purging its transaction without unburning its receipt", async () => {
	// Arrange: issue through the guarded real consumed-transaction path.
	const f = fixture();
	const linked = await linkedAccount(f);
	const proof = f.material();
	await f.store.startAuthBrowserTransaction(proof, f.cfg);
	const consumed = await f.store.consumeAuthBrowserTransaction(proof, f.cfg);
	if (consumed.kind !== "consumed") throw new Error("expected consumed transaction");
	const input = {
		account: linked.account,
		browserTransactionHash: consumed.browserTransactionHash,
		credentialHash: hash(),
	};
	const issued = await f.store.signInWithConsumedBrowserTransaction(input, f.cfg);
	if (issued.kind !== "issued") throw new Error("expected issued session");
	const profile = { displayName: "Fixture Person" };
	const profileInput = { credentialHash: input.credentialHash, profile };
	expect(await f.store.recordAuthAccountProfile(profileInput, f.cfg)).toEqual({ kind: "recorded" });
	const before = await snapshot(f);
	f.time.now = NOW + 2 * HOUR;
	// Act
	const purged = await f.store.purgeAuthSigninBrowserTransactions(f.cfg);
	const read = await f.store.readAuthSessionAccount(input.credentialHash, f.cfg);
	const replay = await f.store.signInWithConsumedBrowserTransaction(
		{ ...input, credentialHash: hash() },
		f.cfg,
	);
	// Assert: purge removes ceremony storage only, never session or replay protection.
	expect(purged).toEqual({ kind: "purged", processedCount: 1, more: false });
	expect(await rows(f)).toEqual([]);
	expect(read).toEqual({ session: issued.session, profile });
	expect(replay).toEqual(rejected("browser_transaction_used"));
	expect(await snapshot(f)).toEqual(before);
});

it("keeps the maximum floor under concurrent purges and starts without deleting younger rows", async () => {
	// Arrange: independent store clocks share the same actual D1 database.
	const f = fixture();
	await f.store.startAuthBrowserTransaction(f.material(), f.cfg);
	await seed(f, 257, () => ({ created_at_ms: NOW + 100, expires_at_ms: NOW + 600100 }));
	const before = await rows(f);
	const older = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW + 2 * HOUR });
	f.time.now = NOW + 2 * HOUR + 200;
	const safeStart = f.material();
	// Act: no assertions depend on which D1 request wins scheduling.
	const results = await Promise.all([
		older.purgeAuthSigninBrowserTransactions(f.cfg, { limit: 1 }),
		f.store.purgeAuthSigninBrowserTransactions(f.cfg),
		f.fresh().startAuthBrowserTransaction(safeStart, f.cfg),
	]);
	const floor = (await rows(f, floorTable))[0];
	const after = await rows(f);
	// Assert: the younger start survives; deleted births never exceed the durable floor.
	expect(results[2]).toMatchObject({ kind: "started" });
	const olderResult = results[0];
	if (olderResult.kind !== "purged") throw new Error("expected purged result");
	expect(olderResult.processedCount).toBeGreaterThanOrEqual(0);
	expect(olderResult.processedCount).toBeLessThanOrEqual(1);
	expect(results[1]).toMatchObject({ kind: "purged", processedCount: 256 });
	expect(floor.purged_through_created_at_ms).toBe(NOW + 100);
	expect(after.find((row) => row.state_hash === safeStart.stateHash)).toMatchObject({
		created_at_ms: f.time.now,
	});
	const survivors = new Set(after.map((row) => row.browser_transaction_hash));
	for (const row of before.filter((row) => !survivors.has(row.browser_transaction_hash)))
		expect(Number(row.created_at_ms)).toBeLessThanOrEqual(
			Number(floor.purged_through_created_at_ms),
		);
	f.time.now = NOW + 2 * HOUR;
	await older.purgeAuthSigninBrowserTransactions(f.cfg);
	expect(await rows(f, floorTable)).toEqual([floor]);
});
