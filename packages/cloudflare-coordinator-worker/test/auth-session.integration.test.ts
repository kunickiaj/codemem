import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";

type Config = Parameters<D1CoordinatorStore["createAuthLinkAttempt"]>[1];
type Fixture = Awaited<ReturnType<typeof createFixture>>;
type IssueResult = Awaited<ReturnType<D1CoordinatorStore["redeemAuthLinkSession"]>>;
const NOW = 1790899200000;
const SESSION_TTL = 28800000;
const ATTEMPT_TTL = 600000;
const REDEEM_WINDOW = 120000;
const attempts = "coordinator_auth_link_attempts";
const links = "coordinator_auth_account_links";
const audit = "coordinator_auth_link_audit_log";
const receipts = "coordinator_auth_session_receipts";
const sessions = "coordinator_auth_sessions";
const controllers = "coordinator_auth_controller_attestations";
const owned: { coordinatorId: string; groupId: string }[] = [];
let hashSequence = 0;

// Trusted store inputs only: these fixtures do not verify cookies, signatures or OIDC.
function hash() {
	return (++hashSequence).toString(16).padStart(64, "0");
}

afterEach(async () => {
	for (const f of owned.splice(0)) {
		await env.COORDINATOR_DB.batch([
			...[sessions, receipts, audit, links, attempts, controllers].map((table) =>
				env.COORDINATOR_DB.prepare(`DELETE FROM ${table} WHERE coordinator_id = ?`).bind(
					f.coordinatorId,
				),
			),
			env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(f.groupId),
			env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = ?").bind(f.groupId),
		]);
	}
});

async function createFixture() {
	const time = { now: NOW };
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => time.now });
	const review = {
		coordinatorId: randomUUID(), groupId: randomUUID(), deviceId: randomUUID(),
		identityId: randomUUID(), attestationId: randomUUID(), reviewReceiptId: randomUUID(),
		publicKey: "fixture-public-key", fingerprint: hash(), evidenceDigest: hash(),
	};
	owned.push(review);
	const cfg: Config = {
		coordinatorId: review.coordinatorId, issuer: "https://accounts.example.test",
		revision: "a".repeat(64), enabled: true,
	};
	const signer = {
		groupId: review.groupId, deviceId: review.deviceId,
		publicKey: review.publicKey, fingerprint: review.fingerprint,
	};
	const start = {
		attemptId: randomUUID(), signer, runtimeVerifierHash: hash(),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const browser = { attemptId: start.attemptId, browserTransactionHash: hash() };
	const confirm = { ...browser, completionSecretHash: hash() };
	const account = { issuer: cfg.issuer, subject: randomUUID() };
	const finalize = {
		purpose: "coordinator-account-link-v1" as const, coordinatorId: cfg.coordinatorId,
		attemptId: start.attemptId, identityId: review.identityId,
		groupId: signer.groupId, deviceId: signer.deviceId, fingerprint: signer.fingerprint,
		signer, runtimeVerifierHash: start.runtimeVerifierHash,
		completionSecretHash: confirm.completionSecretHash,
	};
	await store.createGroup(review.groupId, "Fixture group");
	await store.enrollDevice(review.groupId, { ...signer, identityId: null });
	// Explicit configured-admin review input; this is not an HTTP admin-auth test.
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	return { time, store, review, cfg, signer, start, browser, confirm, account, finalize };
}

async function confirmLink(f: Fixture) {
	expect(await f.store.createAuthLinkAttempt(f.start, f.cfg)).toMatchObject({ kind: "created" });
	expect(await f.store.claimAuthLinkAttempt(f.browser, f.cfg)).toMatchObject({ kind: "applied" });
	expect(await f.store.recordAuthLinkOidcVerified({ ...f.browser, account: f.account }, f.cfg))
		.toMatchObject({ kind: "applied" });
	expect(await f.store.confirmAuthLinkAttempt(f.confirm, f.cfg)).toMatchObject({ kind: "applied" });
}

async function linkAccount(f: Fixture) {
	await confirmLink(f);
	expect(await f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg)).toMatchObject({ kind: "applied" });
}

async function rows(f: Fixture, table: string) {
	return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${table} WHERE coordinator_id = ?`)
		.bind(f.cfg.coordinatorId).all<Record<string, unknown>>()).results;
}

async function grants(f: Fixture) {
	return {
		enrollment: await f.store.getEnrollment(f.signer.groupId, f.signer.deviceId),
		controllers: await rows(f, controllers), links: await rows(f, links), audit: await rows(f, audit),
	};
}

function redeem(f: Fixture, credentialHash = hash()) {
	return { ...f.browser, credentialHash };
}

function signIn(f: Fixture) {
	return { account: f.account, browserTransactionHash: hash(), credentialHash: hash() };
}

async function expectIssued(result: IssueResult, f: Fixture, createdAtMs = f.time.now) {
	const link = (await rows(f, links))[0];
	expect(result).toEqual({ kind: "issued", session: {
		sessionId: expect.any(String), identityId: f.review.identityId,
		linkId: link?.link_id, account: f.account, expiresAtMs: createdAtMs + SESSION_TTL,
	} });
	if (result.kind !== "issued") throw new Error("expected issued session");
	expect(result.session.sessionId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
	return result.session;
}

async function expectSessionCounts(f: Fixture, count: number) {
	expect(await rows(f, receipts)).toHaveLength(count);
	expect(await rows(f, sessions)).toHaveLength(count);
}

it("redeems only the original browser once and keeps finalize replay public", async () => {
	// Arrange: reviewed key and independently verified account already finalized.
	const f = await createFixture();
	await linkAccount(f);
	const before = await grants(f);
	const first = redeem(f);
	const second = redeem(f);
	// Act: a wrong browser and an unknown account must not consume anything.
	const wrongBrowser = await f.store.redeemAuthLinkSession({
		...first, browserTransactionHash: hash(),
	}, f.cfg);
	const unknown = await f.store.signInWithAuthAccount({
		...signIn(f), account: { ...f.account, subject: randomUUID() },
	}, f.cfg);
	const forbiddenSignIn = await f.store.signInWithAuthAccount({
		...signIn(f), browserTransactionHash: f.browser.browserTransactionHash,
	}, f.cfg);
	const results = await Promise.all([
		f.store.redeemAuthLinkSession(first, f.cfg),
		f.store.redeemAuthLinkSession(second, f.cfg),
	]);
	const replay = await f.store.redeemAuthLinkSession(redeem(f), f.cfg);
	const publicReplay = await f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg);
	// Assert: one durable receipt/session; replay never returns the old credential.
	expect(wrongBrowser).toEqual({ kind: "rejected", error: "attempt_unavailable" });
	expect(unknown).toEqual({ kind: "rejected", error: "account_not_linked" });
	expect(forbiddenSignIn).toEqual({ kind: "rejected", error: "browser_transaction_used" });
	const winners = results.filter((result) => result.kind === "issued");
	expect(winners).toHaveLength(1);
	await expectIssued(winners[0] as IssueResult, f);
	expect(results).toContainEqual({ kind: "rejected", error: "browser_transaction_used" });
	expect(replay).toEqual({ kind: "rejected", error: "browser_transaction_used" });
	expect(publicReplay).toEqual({ kind: "existing", status: {
		attemptId: f.start.attemptId, state: "session_redeemed", expiresAtMs: NOW + ATTEMPT_TTL,
	} });
	expect((await rows(f, attempts))[0]?.state).toBe("session_redeemed");
	await expectSessionCounts(f, 1);
	expect(await grants(f)).toEqual(before);
	for (const forbidden of [first.credentialHash, second.credentialHash,
		f.browser.browserTransactionHash, "credentialHash", "browserTransactionHash", "rawCredential"])
		expect(JSON.stringify([results, publicReplay])).not.toContain(forbidden);
	// A lost response needs a fresh trusted OIDC transaction, not another device proof.
	const fresh = await f.store.signInWithAuthAccount(signIn(f), f.cfg);
	await expectIssued(fresh, f);
	await expectSessionCounts(f, 2);
	expect(await grants(f)).toEqual(before);
});

it("expires absolutely and rotates sessions without reenrolling a known account", async () => {
	// Arrange
	const f = await createFixture();
	await linkAccount(f);
	const input = redeem(f);
	const issued = await expectIssued(await f.store.redeemAuthLinkSession(input, f.cfg), f);
	const before = await grants(f);
	// Act: reads never extend the eight-hour expiry; current revision is independent of genesis.
	f.time.now = issued.expiresAtMs - 1;
	const live = await f.store.readAuthSession(input.credentialHash, f.cfg);
	f.time.now = issued.expiresAtMs;
	const expired = await f.store.readAuthSession(input.credentialHash, f.cfg);
	const freshInput = signIn(f);
	const current = { ...f.cfg, revision: "b".repeat(64) };
	const rotatedOld = await f.store.readAuthSession(input.credentialHash, current);
	const fresh = await f.store.signInWithAuthAccount(freshInput, current);
	const freshSession = await expectIssued(fresh, f);
	const rotatedFresh = await f.store.readAuthSession(freshInput.credentialHash, {
		...current, revision: "c".repeat(64),
	});
	const disabled = await f.store.readAuthSession(freshInput.credentialHash, { ...current, enabled: false });
	const disabledSignIn = await f.store.signInWithAuthAccount(signIn(f), { ...current, enabled: false });
	// Assert: no device proof or new actor/grant is needed for the active known account.
	expect(live).toEqual(issued);
	expect(expired).toBeNull();
	expect(rotatedOld).toBeNull();
	expect(rotatedFresh).toBeNull();
	expect(disabled).toBeNull();
	expect(disabledSignIn).toEqual({ kind: "rejected", error: "auth_config_changed" });
	expect(await f.store.readAuthSession(freshInput.credentialHash, current)).toEqual(freshSession);
	expect(await grants(f)).toEqual(before);
	await expectSessionCounts(f, 2);
});

it("enforces both redemption deadlines and the maximum safe session clock", async () => {
	for (const scenario of ["redeem-window", "original-deadline", "maximum-clock"] as const) {
		// Arrange: each boundary owns a separate coordinator and original attempt.
		const f = await createFixture();
		if (scenario === "maximum-clock") f.time.now = Number.MAX_SAFE_INTEGER - SESSION_TTL;
		await confirmLink(f);
		if (scenario === "original-deadline") f.time.now += ATTEMPT_TTL - 30000;
		expect(await f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg)).toMatchObject({ kind: "applied" });
		const finalizedAt = f.time.now;
		// Act: exactly at either deadline is rejected; at the safe clock maximum succeeds.
		if (scenario === "redeem-window") f.time.now += REDEEM_WINDOW;
		if (scenario === "original-deadline") f.time.now += 30000;
		const denied = await f.store.redeemAuthLinkSession(redeem(f), f.cfg);
		// Assert: deadline rejection writes nothing and an immediately earlier retry succeeds.
		if (scenario !== "maximum-clock") {
			expect(denied).toEqual({ kind: "rejected", error: "redeem_window_expired" });
			await expectSessionCounts(f, 0);
			expect((await rows(f, attempts))[0]?.state).toBe("finalized");
			f.time.now -= 1;
			await expectIssued(await f.store.redeemAuthLinkSession(redeem(f), f.cfg), f);
		} else {
			const session = await expectIssued(denied, f, finalizedAt);
			expect(session.expiresAtMs).toBe(Number.MAX_SAFE_INTEGER);
			f.time.now += 1;
			await expect(f.store.signInWithAuthAccount(signIn(f), f.cfg))
				.rejects.toThrow(/^auth_session_invalid_clock$/);
		}
		await expectSessionCounts(f, 1);
	}
});

it("logs out only one session and admin revocation preserves link tombstones", async () => {
	// Arrange: two independently issued sessions share one existing account link.
	const f = await createFixture();
	await linkAccount(f);
	const first = redeem(f);
	const second = signIn(f);
	const issued = await expectIssued(await f.store.redeemAuthLinkSession(first, f.cfg), f);
	const other = await expectIssued(await f.store.signInWithAuthAccount(second, f.cfg), f);
	const before = await grants(f);
	const scope = { coordinatorId: f.cfg.coordinatorId };
	// Act: unknown logout is indistinguishable; configured-admin store capability is separate.
	const logout = await f.store.signOutAuthSession(first.credentialHash, scope);
	const logoutAgain = await f.store.signOutAuthSession(first.credentialHash, scope);
	const unknownLogout = await f.store.signOutAuthSession(hash(), scope);
	const loggedOutRead = await f.store.readAuthSession(first.credentialHash, f.cfg);
	const otherRead = await f.store.readAuthSession(second.credentialHash, f.cfg);
	expect(await grants(f)).toEqual(before);
	expect(await rows(f, sessions)).toEqual(expect.arrayContaining([
		expect.objectContaining({ session_id: issued.sessionId, revoked_at_ms: NOW }),
		expect.objectContaining({ session_id: other.sessionId, revoked_at_ms: null }),
	]));
	f.time.now += 1;
	const revokedAt = f.time.now;
	const revoke = await f.store.revokeAuthAccountLink({ linkId: issued.linkId }, scope);
	const again = await f.store.revokeAuthAccountLink({ linkId: issued.linkId }, scope);
	const unavailable = await f.store.revokeAuthAccountLink({ linkId: randomUUID() }, scope);
	const denied = await f.store.signInWithAuthAccount(signIn(f), f.cfg);
	// Assert: logout leaves the other session and enrollment alone; revoke denies all sessions.
	for (const result of [logout, logoutAgain, unknownLogout]) expect(result).toEqual({ kind: "signed_out" });
	expect(loggedOutRead).toBeNull();
	expect(otherRead).toEqual(other);
	expect(revoke).toEqual({ kind: "revoked" });
	expect(again).toEqual({ kind: "revoked" });
	expect(unavailable).toEqual({ kind: "rejected", error: "link_unavailable" });
	expect(denied).toEqual({ kind: "rejected", error: "account_not_linked" });
	expect(await f.store.readAuthSession(second.credentialHash, f.cfg)).toBeNull();
	expect(await f.store.readAuthSession(first.credentialHash, f.cfg)).toBeNull();
	expect(await rows(f, links)).toEqual([expect.objectContaining({
		link_id: issued.linkId, revoked_at_ms: revokedAt,
	})]);
	expect(await rows(f, audit)).toHaveLength(before.audit.length + 1);
	expect((await rows(f, audit)).filter((row) => row.action === "link_revoked")).toEqual([
		expect.objectContaining({ link_id: issued.linkId, created_at_ms: revokedAt }),
	]);
	expect(await f.store.getEnrollment(f.signer.groupId, f.signer.deviceId)).toEqual(before.enrollment);
	expect(await rows(f, controllers)).toEqual(before.controllers);
	await expectSessionCounts(f, 2);
	await expectTombstoneConflict(f);
});

async function expectTombstoneConflict(f: Fixture) {
	const start = { ...f.start, attemptId: randomUUID(), runtimeVerifierHash: hash() };
	const browser = { attemptId: start.attemptId, browserTransactionHash: hash() };
	const confirm = { ...browser, completionSecretHash: hash() };
	expect(await f.store.createAuthLinkAttempt(start, f.cfg)).toMatchObject({ kind: "created" });
	expect(await f.store.claimAuthLinkAttempt(browser, f.cfg)).toMatchObject({ kind: "applied" });
	expect(await f.store.recordAuthLinkOidcVerified({ ...browser, account: f.account }, f.cfg))
		.toMatchObject({ kind: "applied" });
	expect(await f.store.confirmAuthLinkAttempt(confirm, f.cfg)).toMatchObject({ kind: "applied" });
	const priorLinks = await rows(f, links);
	const priorAudit = await rows(f, audit);
	expect(await f.store.finalizeAuthLinkAttempt({
		...f.finalize, attemptId: start.attemptId, runtimeVerifierHash: start.runtimeVerifierHash,
		completionSecretHash: confirm.completionSecretHash,
	}, f.cfg)).toEqual({ kind: "rejected", error: "link_conflict" });
	expect(await rows(f, links)).toEqual(priorLinks);
	expect(await rows(f, audit)).toEqual(priorAudit);
}

async function installFault(f: Fixture, target: "session-insert" | "attempt-update") {
	const name = `fixture_auth_session_${randomUUID().replaceAll("-", "")}`;
	let event = `BEFORE INSERT ON ${sessions}`;
	let condition = `NEW.coordinator_id = '${f.cfg.coordinatorId}'`;
	if (target === "attempt-update") {
		event = `BEFORE UPDATE OF state ON ${attempts}`;
		condition += " AND NEW.state = 'session_redeemed'";
	}
	// Generated UUID scope prevents this local fault from touching another fixture.
	await env.COORDINATOR_DB.prepare(`CREATE TRIGGER ${name} ${event} WHEN ${condition}
		BEGIN SELECT RAISE(ABORT, 'fixture_session_failure'); END`).run();
	return name;
}

it("rolls back receipt, session and attempt on real D1 statement failures", async () => {
	for (const target of ["session-insert", "attempt-update"] as const) {
		// Arrange: fail only the current coordinator after its first guarded receipt insert.
		const f = await createFixture();
		await linkAccount(f);
		const before = await rows(f, attempts);
		const beforeGrants = await grants(f);
		const input = redeem(f);
		const trigger = await installFault(f, target);
		try {
			// Act
			await expect(f.store.redeemAuthLinkSession(input, f.cfg))
				.rejects.toThrow(/^auth_session_persistence_error$/);
			// Assert: the complete original finalized row and every proof commitment survive.
			expect(await rows(f, attempts)).toEqual(before);
			await expectSessionCounts(f, 0);
			expect(await grants(f)).toEqual(beforeGrants);
		} finally {
			await env.COORDINATOR_DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
		}
		// Act / Assert: removing only our trigger allows an unchanged successful retry.
		await expectIssued(await f.store.redeemAuthLinkSession(input, f.cfg), f);
		await expectSessionCounts(f, 1);
		expect((await rows(f, attempts))[0]?.state).toBe("session_redeemed");
		expect(await grants(f)).toEqual(beforeGrants);
	}
});
