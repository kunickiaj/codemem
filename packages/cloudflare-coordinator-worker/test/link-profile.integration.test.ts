import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { afterEach, expect, it } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";

const NOW = 1_791_028_800_000;
const profile = {
	displayName: "Synthetic Person",
	email: "synthetic@example.test",
	emailVerified: true,
	pictureUrl: "https://images.example.test/avatar.png",
};
let sequence = 0;
const hash = () => (++sequence).toString(16).padStart(64, "0");
const owned: { coordinatorId: string; groupId: string }[] = [];
const tables = "link_profiles account_profiles sessions session_receipts link_audit_log account_links link_attempts controller_attestations".split(" ");

afterEach(async () => {
	for (const f of owned.splice(0)) {
		await env.COORDINATOR_DB.batch([
			...tables.map((name) => env.COORDINATOR_DB.prepare(
				`DELETE FROM coordinator_auth_${name} WHERE coordinator_id = ?`,
			).bind(f.coordinatorId)),
			env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(f.groupId),
			env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = ?").bind(f.groupId),
		]);
	}
});

// Trusted verified-callback boundary, actual D1 SQL, no provider or image requests.
async function fixture() {
	const time = { now: NOW };
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => time.now });
	const review = {
		coordinatorId: randomUUID(), groupId: randomUUID(), deviceId: randomUUID(),
		identityId: randomUUID(), attestationId: randomUUID(), reviewReceiptId: randomUUID(),
		publicKey: CANONICAL_PUBLIC_KEY, fingerprint: hash(), evidenceDigest: hash(),
	};
	owned.push(review);
	const cfg = { coordinatorId: review.coordinatorId, issuer: "https://accounts.example.test", revision: "a".repeat(64), enabled: true };
	const start = {
		authority: { kind: "controller_attestation" as const }, attemptId: randomUUID(),
		signer: review, runtimeVerifierHash: hash(),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const browser = { attemptId: start.attemptId, browserTransactionHash: hash() };
	const account = { issuer: cfg.issuer, subject: "synthetic-subject" };
	const confirm = { ...browser, completionSecretHash: hash() };
	const proof = { ...review, ...start, completionSecretHash: confirm.completionSecretHash, purpose: "coordinator-account-link-v1" as const };
	await store.createGroup(review.groupId, "Synthetic group");
	await store.enrollDevice(review.groupId, { ...review, identityId: null });
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	expect(await store.createAuthLinkAttempt(start, cfg)).toMatchObject({ kind: "created" });
	expect(await store.claimAuthLinkAttempt(browser, cfg)).toMatchObject({ kind: "applied" });
	return { store, time, cfg, review, browser, account, confirm, proof };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function rows(f: Fixture, table = "link_profiles") {
	return (await env.COORDINATOR_DB.prepare(
		`SELECT * FROM coordinator_auth_${table} WHERE coordinator_id = ? ORDER BY rowid`,
	).bind(f.cfg.coordinatorId).all()).results;
}
async function verify(f: Fixture) {
	expect(await f.store.recordAuthLinkOidcVerified({
		...f.browser, account: f.account,
		profile: { ...profile, access_token: "synthetic-access-token", id_token: "synthetic-id-token" },
	}, f.cfg)).toMatchObject({ kind: "applied" });
}
async function finish(f: Fixture) {
	expect(await f.store.confirmAuthLinkAttempt(f.confirm, f.cfg)).toMatchObject({ kind: "applied" });
	expect(await f.store.finalizeAuthLinkAttempt(f.proof, f.cfg)).toMatchObject({ kind: "applied" });
}
const status = (f: Fixture) => f.store.readAccountLinkStatus(f.review, f.cfg, { identityId: f.review.identityId });

it("stages only display claims and publishes after finalize without a browser session", async () => {
	// Arrange: a verified callback has not yet authorized publication.
	const f = await fixture();
	await verify(f);
	const staged = await rows(f);
	expect(staged).toEqual([expect.objectContaining({ link_id: null, display_name: profile.displayName, email: profile.email, email_verified: 1, picture_url: profile.pictureUrl, verified_at_ms: NOW })]);
	expect(await status(f)).not.toMatchObject({ account: expect.objectContaining({ displayName: profile.displayName }) });
	expect(await rows(f, "sessions")).toEqual([]);
	// Act: confirmation alone cannot publish; only the winning finalize can.
	expect(await f.store.confirmAuthLinkAttempt(f.confirm, f.cfg)).toMatchObject({ kind: "applied" });
	expect(await rows(f)).toEqual(staged);
	expect(await rows(f, "account_links")).toEqual([]);
	expect(await f.store.finalizeAuthLinkAttempt(f.proof, f.cfg)).toMatchObject({ kind: "applied" });
	// Assert: publication is independent of session issuance and keeps distinct provenance.
	expect(await status(f)).toMatchObject({ state: "linked", account: { displayName: profile.displayName, email: profile.email } });
	expect(await rows(f)).toEqual([expect.objectContaining({ link_id: expect.any(String) })]);
	expect(await rows(f, "sessions")).toEqual([]);
	expect(await rows(f, "account_profiles")).toEqual([]);
	const persisted = JSON.stringify(await rows(f));
	for (const secret of ["synthetic-access-token", "synthetic-id-token", f.proof.runtimeVerifierHash, f.confirm.completionSecretHash]) expect(persisted).not.toContain(secret);
});

it.each(["cancelled", "provider_failure", "expiry", "config"] as const)("never publishes and cleans staging after %s", async (scenario) => {
	// Arrange: cleanup must not discard a live verified snapshot.
	const f = await fixture();
	await verify(f);
	await f.store.maintainAuthLinkAttempts(f.cfg);
	expect(await rows(f)).toHaveLength(1);
	expect(await f.store.confirmAuthLinkAttempt(f.confirm, f.cfg)).toMatchObject({ kind: "applied" });
	const cfg = { ...f.cfg };
	// Act: terminate the attempt or invalidate its trusted configuration.
	if (scenario === "cancelled" || scenario === "provider_failure") {
		expect(await f.store.failAuthLinkAttempt({ ...f.browser, requester: { kind: "browser", browserTransactionHash: f.browser.browserTransactionHash }, reason: scenario }, cfg)).toMatchObject({ kind: "applied" });
		expect(await rows(f)).toEqual([]);
	}
	if (scenario === "expiry") f.time.now += 600000;
	if (scenario === "config") cfg.revision = "b".repeat(64);
	const result = await f.store.finalizeAuthLinkAttempt(f.proof, cfg);
	await f.store.maintainAuthLinkAttempts(cfg);
	// Assert: neither failed finalization nor maintenance creates a link or a session.
	expect(result).toMatchObject({ kind: "rejected" });
	expect(await rows(f)).toEqual([]);
	expect(await rows(f, "account_links")).toEqual([]);
	expect(await rows(f, "sessions")).toEqual([]);
});

it.each(["subject", "config", "browser"] as const)("refuses promotion of staging with mismatched %s", async (field) => {
	// Arrange: pin independently verified metadata, then simulate inconsistent stored staging.
	const f = await fixture();
	await verify(f);
	const column = { subject: "subject", config: "auth_config_revision", browser: "browser_transaction_hash" }[field];
	await env.COORDINATOR_DB.prepare(`UPDATE coordinator_auth_link_profiles SET ${column} = ? WHERE coordinator_id = ?`).bind(field === "subject" ? "other-subject" : "f".repeat(64), f.cfg.coordinatorId).run();
	// Act: valid authority may finalize, but mismatched display claims cannot follow it.
	await finish(f);
	const account = await status(f);
	// Assert: the link remains usable without publishing inconsistent metadata.
	expect(account).toMatchObject({ state: "linked" });
	expect(account).not.toMatchObject({ account: expect.objectContaining({ displayName: profile.displayName }) });
	expect(await rows(f)).toEqual([expect.objectContaining({ link_id: null })]);
	await f.store.maintainAuthLinkAttempts(f.cfg);
	expect(await rows(f)).toEqual([]);
});

it("prefers newer sign-in metadata and hides revoked profiles before cleanup", async () => {
	// Arrange: the first link has display metadata but no sign-in provenance.
	const f = await fixture();
	await verify(f);
	await finish(f);
	expect(await status(f)).toMatchObject({ account: { displayName: profile.displayName, email: profile.email } });
	f.time.now += 1;
	const credentialHash = hash();
	const issued = await f.store.signInWithAuthAccount({ account: f.account, browserTransactionHash: hash(), credentialHash }, f.cfg);
	if (issued.kind !== "issued") throw new Error("synthetic_signin_failed");
	expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toMatchObject({ profile });
	const newer = { displayName: "Newer Person", email: "newer@example.test", emailVerified: false };
	// Act: newer sign-in wins; an old link replay must not overwrite it.
	expect(await f.store.recordAuthAccountProfile({ credentialHash, profile: newer }, f.cfg)).toEqual({ kind: "recorded" });
	expect(await f.store.finalizeAuthLinkAttempt(f.proof, f.cfg)).toMatchObject({ kind: "existing" });
	// Assert: both session and device reads prefer the sign-in, with actual session provenance.
	expect(await status(f)).toMatchObject({ account: { displayName: newer.displayName } });
	expect((await status(f)).account).not.toHaveProperty("email");
	expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toMatchObject({ profile: newer });
	expect(await rows(f, "account_profiles")).toEqual([expect.objectContaining({ source_session_id: issued.session.sessionId, source_signed_in_at_ms: NOW + 1 })]);
	expect(await f.store.revokeAuthAccountLink({ linkId: issued.session.linkId }, f.cfg)).toEqual({ kind: "revoked" });
	expect(await status(f)).toMatchObject({ state: "revoked", account: null });
	expect(await f.store.readAuthSessionAccount(credentialHash, f.cfg)).toBeNull();
	expect(await rows(f)).toHaveLength(1);
	expect(await f.store.clearRevokedAuthAccountProfile({ linkId: issued.session.linkId }, f.cfg)).toEqual({ kind: "cleared", deletedCount: 2 });
	expect(await rows(f)).toEqual([]);
	expect(await rows(f, "account_profiles")).toEqual([]);
});
