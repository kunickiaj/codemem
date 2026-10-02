import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { afterEach, expect, it } from "vitest";

type Config = Parameters<D1CoordinatorStore["createAuthLinkAttempt"]>[1];
type Review = Parameters<D1CoordinatorStore["createAuthControllerAttestation"]>[0];
type Fixture = Awaited<ReturnType<typeof fixture>>;
const NOW = 1790899200000;
const TTL = 600000;
const attempts = "coordinator_auth_link_attempts";
const otherTables = [
	"coordinator_auth_account_links",
	"coordinator_auth_link_audit_log",
	"coordinator_auth_sessions",
	"coordinator_auth_session_receipts",
	"coordinator_auth_controller_attestations",
];
const owned: Review[] = [];
let sequence = 0;

// Trusted persistence inputs only: no HTTP, OIDC, signature or CSRF verification.
function hash() {
	return (++sequence).toString(16).padStart(64, "0");
}

afterEach(async () => {
	for (const review of owned.splice(0)) {
		await env.COORDINATOR_DB.batch([
			...[...otherTables, attempts].map((table) =>
				env.COORDINATOR_DB.prepare(`DELETE FROM ${table} WHERE coordinator_id = ?`).bind(
					review.coordinatorId,
				),
			),
			env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(
				review.groupId,
			),
			env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = ?").bind(review.groupId),
		]);
	}
});

async function fixture(overrides: Partial<Review> = {}) {
	const time = { now: NOW };
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => time.now });
	const review: Review = {
		coordinatorId: randomUUID(),
		groupId: randomUUID(),
		deviceId: randomUUID(),
		identityId: randomUUID(),
		attestationId: randomUUID(),
		reviewReceiptId: randomUUID(),
		publicKey: "fixture-public-key",
		fingerprint: hash(),
		evidenceDigest: hash(),
		...overrides,
	};
	owned.push(review);
	const cfg: Config = {
		coordinatorId: review.coordinatorId,
		issuer: "https://accounts.example.test",
		revision: "a".repeat(64),
		enabled: true,
	};
	const signer = {
		groupId: review.groupId,
		deviceId: review.deviceId,
		publicKey: review.publicKey,
		fingerprint: review.fingerprint,
	};
	const start = {
		attemptId: randomUUID(),
		signer,
		runtimeVerifierHash: hash(),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const browser = { attemptId: start.attemptId, browserTransactionHash: hash() };
	const confirm = { ...browser, completionSecretHash: hash() };
	const account = { issuer: cfg.issuer, subject: "fixture-subject" };
	const finalize = {
		purpose: "coordinator-account-link-v1" as const,
		coordinatorId: cfg.coordinatorId,
		attemptId: start.attemptId,
		identityId: review.identityId,
		...signer,
		signer,
		runtimeVerifierHash: start.runtimeVerifierHash,
		completionSecretHash: confirm.completionSecretHash,
	};
	await store.createGroup(review.groupId, "Fixture group");
	await store.enrollDevice(review.groupId, { ...signer, identityId: null });
	// Explicit configured-admin review; enrollment alone supplies no linking authority.
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	return { store, time, review, cfg, signer, start, browser, confirm, account, finalize };
}

async function rows(f: Fixture, table = attempts) {
	return (
		await env.COORDINATOR_DB.prepare(
			`SELECT * FROM ${table} WHERE coordinator_id = ? ORDER BY rowid`,
		)
			.bind(f.cfg.coordinatorId)
			.all<Record<string, unknown>>()
	).results;
}

async function snapshot(f: Fixture, options: { includeAttempts?: boolean } = {}) {
	return {
		auth: await Promise.all(
			(options.includeAttempts ? [attempts, ...otherTables] : otherTables).map((table) =>
				rows(f, table),
			),
		),
		enrollment: await f.store.getEnrollment(f.signer.groupId, f.signer.deviceId),
		group: await env.COORDINATOR_DB.prepare("SELECT * FROM groups WHERE group_id = ?")
			.bind(f.signer.groupId)
			.first(),
	};
}

async function advance(f: Fixture, stage: "verified" | "confirmed" | "finalized" | "redeemed") {
	expect(await f.store.createAuthLinkAttempt(f.start, f.cfg)).toMatchObject({ kind: "created" });
	expect(await f.store.claimAuthLinkAttempt(f.browser, f.cfg)).toMatchObject({ kind: "applied" });
	expect(
		await f.store.recordAuthLinkOidcVerified({ ...f.browser, account: f.account }, f.cfg),
	).toMatchObject({ kind: "applied" });
	if (stage === "verified") return;
	expect(await f.store.confirmAuthLinkAttempt(f.confirm, f.cfg)).toMatchObject({ kind: "applied" });
	if (stage === "confirmed") return;
	expect(await f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg)).toMatchObject({
		kind: "applied",
	});
	if (stage === "redeemed") {
		expect(
			await f.store.redeemAuthLinkSession({ ...f.browser, credentialHash: hash() }, f.cfg),
		).toMatchObject({ kind: "issued" });
	}
}

async function seedLegacyExpired(cfg: Config) {
	const f = await fixture({ coordinatorId: cfg.coordinatorId });
	f.account.subject = "fixture-expired-subject";
	await advance(f, "verified");
	// Represent an older store's terminal row whose subject has not yet been scrubbed.
	await env.COORDINATOR_DB.prepare(
		`UPDATE ${attempts} SET state = 'expired' WHERE coordinator_id = ? AND attempt_id = ?`,
	)
		.bind(cfg.coordinatorId, f.start.attemptId)
		.run();
	return f;
}

it("atomically caps concurrent device creates, preserves retry TTL and prioritizes revocation", async () => {
	// Arrange: all eight requests have the same enrolled, explicitly reviewed key.
	const f = await fixture();
	const starts = Array.from({ length: 8 }, () => ({
		...f.start,
		attemptId: randomUUID(),
		runtimeVerifierHash: hash(),
	}));
	// Act: real D1 serializes guarded INSERT SELECTs, not a mock quota counter.
	const results = await Promise.all(
		starts.map((start) => f.store.createAuthLinkAttempt(start, f.cfg)),
	);
	const before = await rows(f);
	const winner = starts.find((_, index) => results[index]?.kind === "created");
	if (!winner) throw new Error("expected one created attempt");
	f.time.now += 1234;
	const retry = await f.store.createAuthLinkAttempt(winner, f.cfg);
	const afterRetry = await rows(f);
	await f.store.revokeAuthControllerAttestation(f.cfg.coordinatorId, f.review.attestationId);
	const deniedRetry = await f.store.createAuthLinkAttempt(winner, f.cfg);
	const deniedNew = await f.store.createAuthLinkAttempt(
		{ ...f.start, attemptId: randomUUID(), runtimeVerifierHash: hash() },
		f.cfg,
	);
	// Assert: rejected creates leave no rows; exact replay never renews the deadline.
	expect(results.filter((result) => result.kind === "created")).toHaveLength(2);
	expect(results.filter((result) => result.kind === "rejected")).toEqual(
		Array(6).fill({ kind: "rejected", error: "attempt_limited" }),
	);
	expect(before).toHaveLength(2);
	expect(retry).toEqual({
		kind: "existing",
		identityId: f.review.identityId,
		status: { attemptId: winner.attemptId, state: "pending", expiresAtMs: NOW + TTL },
	});
	expect(afterRetry).toEqual(before);
	for (const result of [deniedRetry, deniedNew]) {
		expect(result).toEqual({ kind: "rejected", error: "controller_not_active" });
	}
	expect(await rows(f)).toEqual(before);
	// Arrange / Act / Assert: the same actor may use two devices, but only three active attempts.
	const a = await fixture();
	const b = await fixture({ coordinatorId: a.cfg.coordinatorId, identityId: a.review.identityId });
	const actorResults = await Promise.all(
		[a, a, b, b].map((device) =>
			device.store.createAuthLinkAttempt(
				{ ...device.start, attemptId: randomUUID(), runtimeVerifierHash: hash() },
				device.cfg,
			),
		),
	);
	expect(actorResults.filter((result) => result.kind === "created")).toHaveLength(3);
	expect(actorResults).toContainEqual({ kind: "rejected", error: "attempt_limited" });
	expect(await rows(a)).toHaveLength(3);
});

it("expires old-config claims, scrubs subjects and keeps terminal proof tombstones under clock rollback", async () => {
	// Arrange: unfinished unlinked subject plus real finalized/redeemed records to protect.
	const f = await fixture();
	await advance(f, "confirmed");
	const failed = await fixture({ coordinatorId: f.cfg.coordinatorId });
	failed.account.subject = "fixture-failed-subject";
	await advance(failed, "verified");
	expect(
		await failed.store.failAuthLinkAttempt(
			{
				attemptId: failed.start.attemptId,
				requester: {
					kind: "browser",
					browserTransactionHash: failed.browser.browserTransactionHash,
				},
				reason: "provider_failure",
			},
			failed.cfg,
		),
	).toMatchObject({ kind: "applied" });
	const expired = await seedLegacyExpired(f.cfg);
	const protectedLink = await fixture({ coordinatorId: f.cfg.coordinatorId });
	protectedLink.account.subject = "fixture-linked-subject";
	await advance(protectedLink, "finalized");
	const protectedRedeemed = await fixture({ coordinatorId: f.cfg.coordinatorId });
	protectedRedeemed.account.subject = "fixture-redeemed-subject";
	await advance(protectedRedeemed, "redeemed");
	const other = await fixture();
	await advance(other, "verified");
	const before = await rows(f);
	const grants = await snapshot(f);
	const foreign = await snapshot(other, { includeAttempts: true });
	f.time.now += TTL;
	// Act: current enabled scope may maintain records written under an older issuer/revision.
	const maintained = await f.store.maintainAuthLinkAttempts(
		{ ...f.cfg, issuer: "https://replacement.example.test", revision: "b".repeat(64) },
		{ limit: 32 },
	);
	const after = await rows(f);
	f.time.now = NOW;
	const denied = await Promise.all([
		f.store.claimAuthLinkAttempt(f.browser, f.cfg),
		f.store.confirmAuthLinkAttempt(f.confirm, f.cfg),
		f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg),
		f.store.failAuthLinkAttempt(
			{
				attemptId: f.start.attemptId,
				requester: { kind: "device", signer: f.signer },
				reason: "cancelled",
			},
			f.cfg,
		),
	]);
	const staleRetry = await f.store.createAuthLinkAttempt(f.start, f.cfg);
	const changedProofRetry = await f.store.createAuthLinkAttempt(
		{
			...f.start,
			runtimeVerifierHash: hash(),
			loopbackRedirect: "http://127.0.0.1:4568/codemem/auth/complete",
		},
		f.cfg,
	);
	const reusedProof = await f.store.createAuthLinkAttempt(
		{ ...f.start, attemptId: randomUUID() },
		f.cfg,
	);
	// Assert: only state and subject change; retained PK/hashes permanently prevent reuse.
	expect(maintained).toEqual({ kind: "maintained", processedCount: 3, more: false });
	expect(after).toEqual(
		before.map((row) => {
			if (row.attempt_id === f.start.attemptId)
				return { ...row, state: "expired", account_subject: null };
			if (row.attempt_id === failed.start.attemptId) return { ...row, account_subject: null };
			if (row.attempt_id === expired.start.attemptId) return { ...row, account_subject: null };
			return row;
		}),
	);
	for (const result of denied)
		expect(result).toEqual({ kind: "rejected", error: "attempt_expired" });
	for (const result of [staleRetry, changedProofRetry, reusedProof]) {
		expect(result).toEqual({ kind: "rejected", error: "attempt_conflict" });
	}
	expect(await rows(f)).toEqual(after);
	expect(await snapshot(f)).toEqual(grants);
	expect(await snapshot(other, { includeAttempts: true })).toEqual(foreign);
	// This verifies stored terminal expiry, not a clock floor before unswept expiry.
});

it("burns browser transaction hashes in both sign-in and expired link directions", async () => {
	// Arrange: a known account exists through the complete reviewed linking flow.
	const linked = await fixture();
	await advance(linked, "finalized");
	const input = { account: linked.account, browserTransactionHash: hash(), credentialHash: hash() };
	const pending = await fixture({ coordinatorId: linked.cfg.coordinatorId });
	expect(await pending.store.createAuthLinkAttempt(pending.start, pending.cfg)).toMatchObject({
		kind: "created",
	});
	const expiring = await fixture({ coordinatorId: linked.cfg.coordinatorId });
	expiring.account.subject = "fixture-unlinked-subject";
	await advance(expiring, "verified");
	// Act: an issued sign-in consumes its receipt; an expired claim keeps its hash.
	const issued = await linked.store.signInWithAuthAccount(input, linked.cfg);
	const beforeClaim = await rows(linked);
	const claim = await pending.store.claimAuthLinkAttempt(
		{ ...pending.browser, browserTransactionHash: input.browserTransactionHash },
		pending.cfg,
	);
	linked.time.now += TTL;
	const maintenance = await linked.store.maintainAuthLinkAttempts(linked.cfg);
	const sessions = await rows(linked, "coordinator_auth_sessions");
	const receipts = await rows(linked, "coordinator_auth_session_receipts");
	const deniedSignIn = await linked.store.signInWithAuthAccount(
		{
			...input,
			browserTransactionHash: expiring.browser.browserTransactionHash,
			credentialHash: hash(),
		},
		linked.cfg,
	);
	// Assert: neither collision advances an attempt or creates another session/receipt.
	expect(issued).toMatchObject({ kind: "issued" });
	expect(claim).toEqual({ kind: "rejected", error: "attempt_unavailable" });
	expect(beforeClaim.find((row) => row.attempt_id === pending.start.attemptId)).toMatchObject({
		state: "pending",
		browser_transaction_hash: null,
	});
	expect(maintenance).toEqual({ kind: "maintained", processedCount: 2, more: false });
	expect(deniedSignIn).toEqual({ kind: "rejected", error: "browser_transaction_used" });
	expect(receipts).toEqual([
		expect.objectContaining({ browser_transaction_hash: input.browserTransactionHash }),
	]);
	expect(sessions).toHaveLength(1);
	expect(await rows(linked, "coordinator_auth_sessions")).toEqual(sessions);
	expect(await rows(linked, "coordinator_auth_session_receipts")).toEqual(receipts);
	expect(await rows(linked)).toEqual(
		beforeClaim.map((row) => {
			if (row.attempt_id === linked.start.attemptId) return row;
			return { ...row, state: "expired", account_subject: null };
		}),
	);
});

it("maintains forty legacy rows in capped D1 batches without deleting or writing for rejected inputs", async () => {
	// Arrange: seed pre-cap legacy rows in one actual local D1 transaction.
	const f = await fixture();
	expect(await f.store.createAuthLinkAttempt(f.start, f.cfg)).toMatchObject({ kind: "created" });
	const seed = (await rows(f))[0];
	if (!seed) throw new Error("expected template attempt");
	const columns = Object.keys(seed);
	const seeded = Array.from({ length: 39 }, () => ({
		...seed,
		attempt_id: randomUUID(),
		runtime_verifier_hash: hash(),
	}));
	await env.COORDINATOR_DB.batch(
		seeded.map((row) =>
			env.COORDINATOR_DB.prepare(
				`INSERT INTO ${attempts} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
			).bind(...columns.map((column) => row[column as keyof typeof row])),
		),
	);
	f.time.now += TTL;
	const before = await rows(f);
	const grants = await snapshot(f);
	// Act: validation and unknown scopes must not change this coordinator's records.
	const disabled = await f.store.maintainAuthLinkAttempts({ ...f.cfg, enabled: false });
	const unknown = await f.store.maintainAuthLinkAttempts({ ...f.cfg, coordinatorId: randomUUID() });
	const invalid = await Promise.all(
		[0, 33, 1.5, Number.NaN].map((limit) => f.store.maintainAuthLinkAttempts(f.cfg, { limit })),
	);
	const untouched = await rows(f);
	const first = await f.store.maintainAuthLinkAttempts(f.cfg, { limit: 32 });
	const partial = await rows(f);
	const second = await f.store.maintainAuthLinkAttempts(f.cfg);
	const done = await f.store.maintainAuthLinkAttempts(f.cfg);
	// Assert: real D1 change metadata counts only rows processed in the capped UPDATE.
	expect(disabled).toEqual({ kind: "rejected", error: "auth_config_changed" });
	expect(unknown).toEqual({ kind: "maintained", processedCount: 0, more: false });
	for (const result of invalid)
		expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
	expect(untouched).toEqual(before);
	expect(first).toEqual({ kind: "maintained", processedCount: 32, more: true });
	expect(partial).toHaveLength(40);
	expect(partial.filter((row) => row.state === "expired")).toHaveLength(32);
	expect(second).toEqual({ kind: "maintained", processedCount: 8, more: false });
	expect(done).toEqual({ kind: "maintained", processedCount: 0, more: false });
	expect(await rows(f)).toEqual(before.map((row) => ({ ...row, state: "expired" })));
	expect(await snapshot(f)).toEqual(grants);
});
