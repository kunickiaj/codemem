import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { env } from "cloudflare:workers";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";

type Config = Parameters<D1CoordinatorStore["createAuthLinkAttempt"]>[1];
type FinalizeInput = Parameters<D1CoordinatorStore["finalizeAuthLinkAttempt"]>[0];
type Review = Parameters<D1CoordinatorStore["createAuthControllerAttestation"]>[0];
type Browser = Parameters<D1CoordinatorStore["claimAuthLinkAttempt"]>[0];
type Fixture = Awaited<ReturnType<typeof createFixture>>;
const fixtures: Review[] = [];
const attemptTable = "coordinator_auth_link_attempts";
const linkTable = "coordinator_auth_account_links";
const auditTable = "coordinator_auth_link_audit_log";
const ttlMs = 600000;

// These are trusted store-input fixtures, not verified HTTP/OIDC or crypto proofs.
function fixtureHash() {
	return `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
}

afterEach(async () => {
	for (const review of fixtures.splice(0)) {
		const statements = [auditTable, linkTable, attemptTable,
			"coordinator_auth_controller_attestations"].map((table) =>
			env.COORDINATOR_DB.prepare(`DELETE FROM ${table} WHERE coordinator_id = ?`).bind(
				review.coordinatorId,
			),
		);
		statements.push(
			env.COORDINATOR_DB.prepare("DELETE FROM enrolled_devices WHERE group_id = ?").bind(
				review.groupId,
			),
			env.COORDINATOR_DB.prepare("DELETE FROM groups WHERE group_id = ?").bind(review.groupId),
		);
		await env.COORDINATOR_DB.batch(statements);
	}
});

function createReview(): Review {
	return {
		coordinatorId: randomUUID(),
		groupId: randomUUID(),
		deviceId: randomUUID(),
		identityId: randomUUID(),
		attestationId: randomUUID(),
		reviewReceiptId: randomUUID(),
		publicKey: "fixture-public-key",
		fingerprint: fixtureHash(),
		evidenceDigest: fixtureHash(),
	};
}

function createInputs(review: Review, cfg: Config) {
	const signer = {
		groupId: review.groupId,
		deviceId: review.deviceId,
		publicKey: review.publicKey,
		fingerprint: review.fingerprint,
	};
	const start = {
		attemptId: randomUUID(),
		runtimeVerifierHash: fixtureHash(),
		signer,
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	const browser = { attemptId: start.attemptId, browserTransactionHash: fixtureHash() };
	const confirm = { ...browser, completionSecretHash: fixtureHash() };
	const account = { issuer: cfg.issuer, subject: "subject-a" };
	const finalize: FinalizeInput = {
		purpose: "coordinator-account-link-v1",
		coordinatorId: cfg.coordinatorId,
		attemptId: start.attemptId,
		identityId: review.identityId,
		groupId: signer.groupId,
		deviceId: signer.deviceId,
		fingerprint: signer.fingerprint,
		signer,
		runtimeVerifierHash: start.runtimeVerifierHash,
		completionSecretHash: confirm.completionSecretHash,
	};
	return { signer, start, browser, confirm, account, finalize };
}

async function createFixture(identityMode: "null" | "matching" = "null") {
	const time = { now: 1790899200000 };
	const store = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => time.now });
	const review = createReview();
	fixtures.push(review);
	const cfg: Config = {
		coordinatorId: review.coordinatorId,
		issuer: "https://accounts.example.test",
		revision: "a".repeat(64),
		enabled: true,
	};
	const inputs = createInputs(review, cfg);
	await store.createGroup(review.groupId, "Fixture group");
	await store.enrollDevice(review.groupId, {
		...inputs.signer,
		identityId: identityMode === "matching" ? review.identityId : null,
	});
	const attestation = await store.createAuthControllerAttestation(review);
	expect(attestation.kind).toBe("created");
	return { store, time, review, cfg, ...inputs };
}

function publicStatus(f: Fixture, state: string) {
	return { attemptId: f.start.attemptId, state, expiresAtMs: 1790899200000 + ttlMs };
}

async function readRows(table: string, f: Fixture) {
	const result = await env.COORDINATOR_DB.prepare(
		`SELECT * FROM ${table} WHERE coordinator_id = ?`,
	).bind(f.cfg.coordinatorId).all<Record<string, unknown>>();
	return result.results;
}

async function expectEffects(f: Fixture, count: number) {
	expect(await readRows(linkTable, f)).toHaveLength(count);
	expect(await readRows(auditTable, f)).toHaveLength(count);
}

async function createAttempt(f: Fixture) {
	const result = await f.store.createAuthLinkAttempt(f.start, f.cfg);
	expect(result).toEqual({
		kind: "created", status: publicStatus(f, "pending"), identityId: f.review.identityId,
	});
}

async function prepareConfirmed(f: Fixture) {
	await createAttempt(f);
	expect(await f.store.claimAuthLinkAttempt(f.browser, f.cfg)).toEqual({
		kind: "applied", status: publicStatus(f, "browser_claimed"),
	});
	expect(await f.store.recordAuthLinkOidcVerified({ ...f.browser, account: f.account }, f.cfg))
		.toEqual({ kind: "applied", status: publicStatus(f, "oidc_verified"), target: {
			identityId: f.review.identityId, groupId: f.signer.groupId, deviceId: f.signer.deviceId,
		} });
	expect(await f.store.confirmAuthLinkAttempt(f.confirm, f.cfg)).toEqual({
		kind: "applied", status: publicStatus(f, "confirmed"),
	});
}

async function recordBrowserAccount(f: Fixture, winner: Browser, loser: Browser) {
	const wrongOidc = await f.store.recordAuthLinkOidcVerified({ ...loser, account: f.account }, f.cfg);
	const oidc = await f.store.recordAuthLinkOidcVerified({ ...winner, account: f.account }, f.cfg);
	const changedAccount = await f.store.recordAuthLinkOidcVerified(
		{ ...winner, account: { ...f.account, subject: "replacement-subject" } },
		f.cfg,
	);
	return { wrongOidc, oidc, changedAccount };
}

async function confirmBrowser(f: Fixture, winner: Browser, loser: Browser) {
	const wrongConfirm = await f.store.confirmAuthLinkAttempt(
		{ ...loser, completionSecretHash: f.confirm.completionSecretHash },
		f.cfg,
	);
	const confirmed = await f.store.confirmAuthLinkAttempt(
		{ ...winner, completionSecretHash: f.confirm.completionSecretHash },
		f.cfg,
	);
	const changedSecret = await f.store.confirmAuthLinkAttempt(
		{ ...winner, completionSecretHash: fixtureHash() },
		f.cfg,
	);
	return { wrongConfirm, confirmed, changedSecret };
}

function browserStatus(f: Fixture, browser: Browser) {
	return f.store.getAuthLinkAttemptStatus(
		f.start.attemptId,
		{ kind: "browser", browserTransactionHash: browser.browserTransactionHash },
		f.cfg,
	);
}

it("lets only the winning browser advance and freezes provider and completion commitments", async () => {
	// Arrange: trusted account metadata does not itself authenticate an OIDC callback.
	const f = await createFixture();
	await createAttempt(f);
	const contender = { ...f.browser, browserTransactionHash: fixtureHash() };

	// Act: scheduling may pick either browser, but only one can own this attempt.
	const claims = await Promise.all([
		f.store.claimAuthLinkAttempt(f.browser, f.cfg),
		f.store.claimAuthLinkAttempt(contender, f.cfg),
	]);
	const winner = claims[0]?.kind === "applied" ? f.browser : contender;
	const loser = winner === f.browser ? contender : f.browser;
	const claimedRetry = await f.store.claimAuthLinkAttempt(winner, f.cfg);
	const { wrongOidc, oidc, changedAccount } = await recordBrowserAccount(f, winner, loser);
	const { wrongConfirm, confirmed, changedSecret } = await confirmBrowser(f, winner, loser);
	const status = await browserStatus(f, winner);
	const outsiderStatus = await browserStatus(f, loser);
	const rows = await readRows(attemptTable, f);

	// Assert: exact public shapes exclude provider data, hashes, redirect and secrets.
	expect(claims.filter((result) => result.kind === "applied")).toEqual([
		{ kind: "applied", status: publicStatus(f, "browser_claimed") },
	]);
	expect(claims.filter((result) => result.kind !== "applied")).toEqual([
		{ kind: "rejected", error: "attempt_unavailable" },
	]);
	expect(claimedRetry).toEqual({ kind: "existing", status: publicStatus(f, "browser_claimed") });
	for (const result of [wrongOidc, changedAccount, wrongConfirm, changedSecret]) {
		expect(result).toEqual({ kind: "rejected", error: "attempt_unavailable" });
	}
	expect(oidc).toEqual({ kind: "applied", status: publicStatus(f, "oidc_verified"), target: {
		identityId: f.review.identityId, groupId: f.signer.groupId, deviceId: f.signer.deviceId,
	} });
	expect(confirmed).toEqual({ kind: "applied", status: publicStatus(f, "confirmed") });
	expect(status).toEqual(publicStatus(f, "confirmed"));
	expect(outsiderStatus).toBeNull();
	expect(rows).toEqual([expect.objectContaining({
		browser_transaction_hash: winner.browserTransactionHash, account_subject: f.account.subject,
		completion_secret_hash: f.confirm.completionSecretHash, state: "confirmed",
	})]);
	await expectEffects(f, 0);
});

it("finalizes concurrently with exactly one durable link and audit and only public replay", async () => {
	// Arrange: both proofs and the explicit controller review must already exist.
	const f = await createFixture();
	await prepareConfirmed(f);
	const before = await readRows(attemptTable, f);

	// Act: a wrong proof must not consume; exact concurrent requests may safely retry.
	const wrongProof = await f.store.finalizeAuthLinkAttempt({
		...f.finalize, completionSecretHash: fixtureHash(),
	}, f.cfg);
	const afterWrongProof = await readRows(attemptTable, f);
	const results = await Promise.all([
		f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg),
		f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg),
	]);
	const links = await readRows(linkTable, f);
	const audit = await readRows(auditTable, f);
	const reopenedStore = new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => f.time.now });
	const replay = await reopenedStore.finalizeAuthLinkAttempt(f.finalize, f.cfg);
	const status = await f.store.getAuthLinkAttemptStatus(f.start.attemptId, {
		kind: "device", signer: f.signer,
	}, f.cfg);

	// Assert: the effect is atomic, durable, and contains no second issued secret.
	expect(wrongProof).toEqual({ kind: "rejected", error: "attempt_unavailable" });
	expect(afterWrongProof).toEqual(before);
	expect(results.filter((result) => result.kind === "applied")).toEqual([
		{ kind: "applied", status: publicStatus(f, "finalized") },
	]);
	expect(results.filter((result) => result.kind === "existing")).toEqual([
		{ kind: "existing", status: publicStatus(f, "finalized") },
	]);
	expect(links).toEqual([expect.objectContaining({
		identity_id: f.review.identityId, attempt_id: f.start.attemptId,
		issuer: f.cfg.issuer, subject: f.account.subject,
	})]);
	expect(audit).toEqual([expect.objectContaining({
		link_id: links[0]?.link_id, attempt_id: f.start.attemptId, identity_id: f.review.identityId,
	})]);
	expect(replay).toEqual({ kind: "existing", status: publicStatus(f, "finalized") });
	expect(status).toEqual(publicStatus(f, "finalized"));
	expect(await readRows(linkTable, f)).toEqual(links);
	expect(await readRows(auditTable, f)).toEqual(audit);
});

async function seedConflictingLink(f: Fixture, dimension: "account" | "actor", revoked: boolean) {
	await env.COORDINATOR_DB.prepare(`INSERT INTO ${linkTable} (
		coordinator_id, link_id, issuer, subject, identity_id, attempt_id,
		controller_attestation_id, auth_config_revision, created_at_ms, revoked_at_ms
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.bind(f.cfg.coordinatorId, randomUUID(), f.cfg.issuer,
			dimension === "account" ? f.account.subject : "other-subject",
			dimension === "actor" ? f.review.identityId : randomUUID(), randomUUID(),
			randomUUID(), f.cfg.revision, f.time.now, revoked ? f.time.now : null)
		.run();
}

it("keeps full account and actor uniqueness across active links and revoked tombstones", async () => {
	for (const dimension of ["account", "actor"] as const) {
		for (const revoked of [false, true]) {
			// Arrange: only this coordinator's prior link is seeded, never a revocation route.
			const f = await createFixture();
			await prepareConfirmed(f);
			await seedConflictingLink(f, dimension, revoked);
			const before = await readRows(attemptTable, f);
			const priorLinks = await readRows(linkTable, f);

			// Act: the unique conflict must roll back the guarded attempt transition.
			const result = await f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg);

			// Assert: no audit or consumption; removing the test seed permits a fresh retry.
			expect(result).toEqual({ kind: "rejected", error: "link_conflict" });
			expect(await readRows(attemptTable, f)).toEqual(before);
			expect(await readRows(linkTable, f)).toEqual(priorLinks);
			expect(await readRows(auditTable, f)).toEqual([]);
			await env.COORDINATOR_DB.prepare(`DELETE FROM ${linkTable} WHERE coordinator_id = ?`)
				.bind(f.cfg.coordinatorId).run();
			expect(await f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg)).toEqual({
				kind: "applied", status: publicStatus(f, "finalized"),
			});
			await expectEffects(f, 1);
		}
	}
});

async function changeEnrollmentIdentity(f: Fixture, identityId: string | null) {
	await env.COORDINATOR_DB.prepare(
		"UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ? AND device_id = ?",
	).bind(identityId, f.signer.groupId, f.signer.deviceId).run();
}

interface GuardCase {
	name: string;
	error: string;
	change: (f: Fixture) => void | Promise<unknown>;
	configChanged?: boolean;
}
const guardCases: GuardCase[] = [
	{ name: "config revision", error: "auth_config_changed", configChanged: true,
		change: (f) => { f.cfg.revision = "b".repeat(64); } },
	{ name: "disabled provider", error: "auth_config_changed", configChanged: true,
		change: (f) => { f.cfg.enabled = false; } },
	{ name: "changed issuer", error: "auth_config_changed", configChanged: true,
		change: (f) => { f.cfg.issuer = "https://replacement.example.test"; } },
	{ name: "replaced key", error: "controller_not_active",
		change: (f) => f.store.enrollDevice(f.signer.groupId, {
			...f.signer, publicKey: "replacement-fixture-key", fingerprint: fixtureHash(),
		}) },
	{ name: "revoked controller", error: "controller_not_active",
		change: (f) => f.store.revokeAuthControllerAttestation(f.cfg.coordinatorId, f.review.attestationId) },
	{ name: "disabled device", error: "controller_not_active",
		change: (f) => f.store.setDeviceEnabled(f.signer.groupId, f.signer.deviceId, false) },
	{ name: "archived group", error: "controller_not_active",
		change: (f) => f.store.archiveGroup(f.signer.groupId, "2026-10-02T00:00:00Z") },
	{ name: "other actor", error: "controller_not_active",
		change: (f) => changeEnrollmentIdentity(f, randomUUID()) },
	{ name: "exact expiry", error: "attempt_expired",
		change: (f) => { f.time.now += ttlMs; } },
];

it("rechecks live config and controller gates without effects and permits null or matching actors", async () => {
	for (const scenario of guardCases) {
		// Arrange: every case starts with its own confirmed attempt and reviewed controller.
		const f = await createFixture();
		await prepareConfirmed(f);
		const before = await readRows(attemptTable, f);

		// Act: mutate one live authority gate after confirmation.
		await scenario.change(f);
		const result = await f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg);
		const status = await f.store.getAuthLinkAttemptStatus(f.start.attemptId, {
			kind: "device", signer: f.signer,
		}, f.cfg);

		// Assert: even a conditional SQL no-op must not create a link or consume proofs.
		expect(result, scenario.name).toEqual({ kind: "rejected", error: scenario.error });
		expect(await readRows(attemptTable, f), scenario.name).toEqual(before);
		await expectEffects(f, 0);
		if (scenario.configChanged) expect(status, scenario.name).toBeNull();
		if (scenario.name === "exact expiry") expect(status).toEqual(publicStatus(f, "expired"));
	}
	for (const identityMode of ["null", "matching", "matching-to-null"] as const) {
		// Arrange: enrollment labels are never rewritten by account linking.
		const f = await createFixture(identityMode === "null" ? "null" : "matching");
		await prepareConfirmed(f);
		if (identityMode === "matching-to-null") await changeEnrollmentIdentity(f, null);
		const before = await f.store.getEnrollment(f.signer.groupId, f.signer.deviceId);

		// Act: the live controller permits null or exactly matching enrollment identity.
		const result = await f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg);

		// Assert: all three allowed identity states succeed without changing enrollment.
		expect(result).toEqual({ kind: "applied", status: publicStatus(f, "finalized") });
		expect(await f.store.getEnrollment(f.signer.groupId, f.signer.deviceId)).toEqual(before);
		await expectEffects(f, 1);
	}
});

async function installFailureTrigger(f: Fixture, table: string) {
	const name = `fixture_auth_link_${randomUUID().replaceAll("-", "")}`;
	// Only generated UUIDs enter this local test DDL; no production trigger is installed.
	await env.COORDINATOR_DB.prepare(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table}
		WHEN NEW.coordinator_id = '${f.cfg.coordinatorId}'
		BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END`).run();
	return name;
}

it("rolls back the entire D1 batch when either link or audit insertion aborts", async () => {
	for (const table of [linkTable, auditTable]) {
		// Arrange: an actual local SQL trigger fails only this fixture's insert after the guard.
		const f = await createFixture();
		await prepareConfirmed(f);
		const before = await readRows(attemptTable, f);
		const trigger = await installFailureTrigger(f, table);
		try {
			// Act: a backend error is not success and must roll back every statement.
			await expect(f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg))
				.rejects.toThrow("auth_link_persistence_error");

			// Assert: confirmed state and both original proof hashes survive unchanged.
			expect(await readRows(attemptTable, f)).toEqual(before);
			await expectEffects(f, 0);
		} finally {
			await env.COORDINATOR_DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
		}
		// Act and Assert: removing the test-only fault permits the exact unchanged retry.
		expect(await f.store.finalizeAuthLinkAttempt(f.finalize, f.cfg)).toEqual({
			kind: "applied", status: publicStatus(f, "finalized"),
		});
		await expectEffects(f, 1);
	}
});
