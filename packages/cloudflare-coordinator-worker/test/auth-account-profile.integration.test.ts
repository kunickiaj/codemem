import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { afterEach, expect, it } from "vitest";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Issued = Awaited<ReturnType<typeof signIn>>;
const NOW = 1790899200000;
const profiles = "coordinator_auth_account_profiles";
const authorityTables =
	"sessions session_receipts link_audit_log account_links link_attempts controller_attestations"
		.split(" ")
		.map((name) => `coordinator_auth_${name}`);
const owned: { coordinatorId: string; groupId: string }[] = [];
let sequence = 0;
const hash = () => (++sequence).toString(16).padStart(64, "0");
const full = {
	displayName: "Example Person",
	email: "person@example.test",
	emailVerified: true,
	pictureUrl: "https://images.example.test/avatar.png",
};

afterEach(async () => {
	for (const f of owned.splice(0)) {
		await env.COORDINATOR_DB.batch([
			...[profiles, ...authorityTables].map((table) =>
				env.COORDINATOR_DB.prepare(`DELETE FROM ${table} WHERE coordinator_id = ?`).bind(
					f.coordinatorId,
				),
			),
			env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(f.groupId),
			env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = ?").bind(f.groupId),
		]);
	}
});

// Trusted store metadata only: no JWT, cookie, provider, image or signature requests.
async function fixture() {
	const time = { now: NOW };
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => time.now });
	const review = {
		coordinatorId: randomUUID(),
		groupId: randomUUID(),
		deviceId: randomUUID(),
		identityId: randomUUID(),
		attestationId: randomUUID(),
		reviewReceiptId: randomUUID(),
		publicKey: "fixture-public-key",
		fingerprint: hash(),
		evidenceDigest: hash(),
	};
	owned.push(review);
	const cfg = {
		coordinatorId: review.coordinatorId,
		issuer: "https://accounts.example.test",
		revision: "a".repeat(64),
		enabled: true,
	};
	const signer = review;
	const start = {
		attemptId: randomUUID(),
		signer,
		runtimeVerifierHash: hash(),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const browser = { attemptId: start.attemptId, browserTransactionHash: hash() };
	const confirm = { ...browser, completionSecretHash: hash() };
	const account = { issuer: cfg.issuer, subject: "fixture-subject" };
	await store.createGroup(review.groupId, "Fixture group");
	await store.enrollDevice(review.groupId, { ...signer, identityId: null });
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
	return { store, time, cfg, signer, account, browser };
}

async function signIn(f: Fixture) {
	const credentialHash = hash();
	const input = { account: f.account, browserTransactionHash: hash(), credentialHash };
	const result = await f.store.signInWithAuthAccount(input, f.cfg);
	if (result.kind !== "issued") throw new Error("fixture_session_not_issued");
	return { credentialHash, session: result.session };
}

async function rows(f: Fixture, table = profiles) {
	const sql = `SELECT * FROM ${table} WHERE coordinator_id = ? ORDER BY rowid`;
	return (
		await env.COORDINATOR_DB.prepare(sql).bind(f.cfg.coordinatorId).all<Record<string, unknown>>()
	).results;
}

async function authority(f: Fixture) {
	return {
		rows: await Promise.all(authorityTables.map((table) => rows(f, table))),
		enrollment: await f.store.getEnrollment(f.signer.groupId, f.signer.deviceId),
	};
}

function record(f: Fixture, credentialHash: string, profile: unknown = full) {
	return f.store.recordAuthAccountProfile({ credentialHash, profile }, f.cfg);
}

async function expectAccount(f: Fixture, issued: Issued, profile: unknown) {
	expect(await f.store.readAuthSessionAccount(issued.credentialHash, f.cfg)).toEqual({
		session: issued.session,
		profile,
	});
}

async function expectClear(f: Fixture, linkId: string, deletedCount: number, cfg = f.cfg) {
	expect(await f.store.clearRevokedAuthAccountProfile({ linkId }, cfg)).toEqual({
		kind: "cleared",
		deletedCount,
	});
}

it("persists only display snapshots and refuses delayed or equal-time clobbering", async () => {
	// Arrange: the first-link receipt is live but cannot supply profile provenance.
	const f = await fixture();
	const firstLinkHash = hash();
	expect(
		await f.store.redeemAuthLinkSession({ ...f.browser, credentialHash: firstLinkHash }, f.cfg),
	).toMatchObject({ kind: "issued" });
	const old = await signIn(f);
	const before = await authority(f);
	// Act / Assert: minimal display data never modifies authority or accepts raw claims.
	expect(await record(f, firstLinkHash)).toEqual({ kind: "not_recorded" });
	expect(await f.store.readAuthSession(firstLinkHash, f.cfg)).not.toBeNull();
	const minimal = {
		displayName: "Minimal",
		subject: f.account.subject,
		access_token: "fixture-raw-token",
	};
	expect(await record(f, old.credentialHash, minimal)).toEqual({ kind: "recorded" });
	await expectAccount(f, old, { displayName: "Minimal" });
	expect(await authority(f)).toEqual(before);
	f.time.now += 1;
	const rich = await signIn(f);
	expect(await record(f, rich.credentialHash)).toEqual({ kind: "recorded" });
	f.time.now += 1;
	const newest = await signIn(f);
	const equal = await signIn(f);
	const stable = await authority(f);
	const newestProfile = { displayName: "Newest" };
	expect(await record(f, newest.credentialHash, newestProfile)).toEqual({ kind: "recorded" });
	const persisted = await rows(f);
	expect(await record(f, old.credentialHash)).toEqual({ kind: "not_recorded" });
	expect(await record(f, equal.credentialHash)).toEqual({ kind: "not_recorded" });
	expect(await record(f, newest.credentialHash)).toEqual({ kind: "recorded" });
	expect(await rows(f)).toEqual(persisted);
	expect(persisted).toEqual([
		{
			coordinator_id: f.cfg.coordinatorId,
			link_id: newest.session.linkId,
			display_name: "Newest",
			email: null,
			email_verified: null,
			picture_url: null,
			source_session_id: newest.session.sessionId,
			source_signed_in_at_ms: NOW + 2,
		},
	]);
	for (const secret of ["fixture-raw-token", f.account.subject, old.credentialHash])
		expect(JSON.stringify(persisted)).not.toContain(secret);
	await expectAccount(f, old, newestProfile);
	expect(await authority(f)).toEqual(stable);
});

it("mirrors live-session denials and rejects new snapshots exactly at 120 seconds", async () => {
	for (const scenario of ["logout", "revoke", "rotation", "boundary"] as const) {
		// Arrange: each denial owns an independent coordinator and normal sign-in.
		const f = await fixture();
		const issued = await signIn(f);
		f.time.now += 119999;
		expect(await record(f, issued.credentialHash)).toEqual({ kind: "recorded" });
		await expectAccount(f, issued, full);
		const fresh = await signIn(f);
		const cfg = { ...f.cfg };
		// Act: only explicit logout/revoke may change authority rows.
		if (scenario === "logout") await f.store.signOutAuthSession(fresh.credentialHash, cfg);
		if (scenario === "revoke")
			await f.store.revokeAuthAccountLink({ linkId: fresh.session.linkId }, cfg);
		if (scenario === "rotation") cfg.revision = "b".repeat(64);
		if (scenario === "boundary") f.time.now += 120000;
		const before = await authority(f);
		const profileBefore = await rows(f);
		const input = { credentialHash: fresh.credentialHash, profile: { displayName: "Denied" } };
		const result = await f.store.recordAuthAccountProfile(input, cfg);
		const account = await f.store.readAuthSessionAccount(fresh.credentialHash, cfg);
		const session = await f.store.readAuthSession(fresh.credentialHash, cfg);
		// Assert: freshness limits writes, not the existing eight-hour session read.
		expect(result).toEqual({ kind: "not_recorded" });
		if (scenario === "boundary") expect(account).toEqual({ session: fresh.session, profile: full });
		else expect(account).toBeNull();
		expect(account?.session ?? null).toEqual(session);
		expect(await rows(f)).toEqual(profileBefore);
		expect(await authority(f)).toEqual(before);
	}
});

it("guards cleanup by revoked link and coordinator without deleting authority tombstones", async () => {
	// Arrange: matching account subjects in separate coordinators cannot share metadata.
	const f = await fixture();
	const other = await fixture();
	const issued = await signIn(f);
	const foreign = await signIn(other);
	await record(f, issued.credentialHash);
	await record(other, foreign.credentialHash, { displayName: "Other" });
	const foreignBefore = { profile: await rows(other), authority: await authority(other) };
	const input = { linkId: issued.session.linkId };
	const scope = { coordinatorId: f.cfg.coordinatorId };
	const activeBefore = await authority(f);
	// Act / Assert: active and foreign clears are harmless; old revoke kills authorization.
	expect(await record(other, issued.credentialHash)).toEqual({ kind: "not_recorded" });
	expect(await other.store.readAuthSessionAccount(issued.credentialHash, other.cfg)).toBeNull();
	await expectClear(f, input.linkId, 0);
	expect(await authority(f)).toEqual(activeBefore);
	expect(await rows(f)).toHaveLength(1);
	expect(await f.store.revokeAuthAccountLink(input, scope)).toEqual({ kind: "revoked" });
	const revokedBefore = await authority(f);
	expect(await f.store.readAuthSession(issued.credentialHash, f.cfg)).toBeNull();
	expect(await f.store.readAuthSessionAccount(issued.credentialHash, f.cfg)).toBeNull();
	await expectClear(f, input.linkId, 0, other.cfg);
	await expectClear(f, input.linkId, 1);
	await expectClear(f, input.linkId, 0);
	expect(await rows(f)).toEqual([]);
	expect(await authority(f)).toEqual(revokedBefore);
	expect({ profile: await rows(other), authority: await authority(other) }).toEqual(foreignBefore);
	await expectAccount(other, foreign, { displayName: "Other" });
});
