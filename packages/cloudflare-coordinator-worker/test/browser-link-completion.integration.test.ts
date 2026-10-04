import { env, exports } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCoordinatorBrowserAccount } from "../../core/src/coordinator-browser-account.js";
import { createCoordinatorBrowserAuthCallback } from "../../core/src/coordinator-browser-auth-callback.js";
import {
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
} from "../../core/src/coordinator-browser-credential.js";
import {
	importBrowserCsrfKey,
	verifyBrowserCsrfToken,
} from "../../core/src/coordinator-browser-csrf.js";
import { createCoordinatorBrowserLinkHandlers } from "../../core/src/coordinator-browser-link.js";
import { createCoordinatorBrowserLinkCompletionHandlers } from "../../core/src/coordinator-browser-link-completion.js";
import { createCoordinatorOidcClient } from "../../core/src/coordinator-oidc.js";
import { oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

const ORIGIN = "https://app.example.test";
const NOW = 1791028800000;
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
	}
});

async function setup() {
	const config = Object.freeze({
		enabled: true,
		coordinatorId: crypto.randomUUID(),
		issuer: "https://accounts.google.com",
		redirectUri: PROVIDER.redirectUri,
		revision: "a".repeat(64),
	});
	// Two wrappers over the same native pool binding, not separate production isolates.
	const stores = [
		new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW }),
		new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW }),
	];
	const store = stores[0];
	const review = {
		coordinatorId: config.coordinatorId,
		groupId: crypto.randomUUID(),
		deviceId: crypto.randomUUID(),
		identityId: crypto.randomUUID(),
		attestationId: crypto.randomUUID(),
		reviewReceiptId: crypto.randomUUID(),
		publicKey: "fixture-public-key",
		fingerprint: "b".repeat(64),
		evidenceDigest: "c".repeat(64),
	};
	await store.createGroup(review.groupId, "Fixture group");
	await store.enrollDevice(review.groupId, { ...review, identityId: null });
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	const attempt = {
		attemptId: crypto.randomUUID(),
		signer: review,
		runtimeVerifierHash: "d".repeat(64),
		loopbackRedirect: "http://127.0.0.1:80/codemem/auth/complete",
	};
	expect(await store.createAuthLinkAttempt(attempt, config)).toMatchObject({ kind: "created" });
	const oidc = oidcFixture({ issuer: config.issuer });
	oidc.claims.roles = ["administrator"];
	const rawConfig = { ...config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret };
	const client = await createCoordinatorOidcClient(rawConfig, { fetch: oidc.fetch });
	if (!client.ok) throw new Error("SDK setup failed");
	const authorization = await client.client.createAuthorizationRequest();
	const issued = await issueBrowserCookie("transaction");
	const cookie = issued.setCookie.split(";")[0];
	const parsed = await readBrowserCookie(cookie, "transaction");
	if (parsed.kind !== "present") throw new Error("Cookie setup failed");
	expect(
		await store.startAuthBrowserTransaction(
			{
				purpose: "link",
				attemptId: attempt.attemptId,
				stateHash: createHash("sha256").update(authorization.material.state).digest("hex"),
				binderHash: parsed.cookieHash,
				nonce: authorization.material.nonce,
				pkceVerifier: authorization.material.pkceVerifier,
			},
			config,
		),
	).toMatchObject({ kind: "started" });
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const limiter = { check: vi.fn(() => ({ allowed: true, retryAfterS: 0 })) };
	const operations = {
		resolveAuthLinkBrowserTransaction: vi.fn(store.resolveAuthLinkBrowserTransaction.bind(store)),
		getAuthLinkAttemptStatus: vi.fn(store.getAuthLinkAttemptStatus.bind(store)),
		readAuthSession: vi.fn(store.readAuthSession.bind(store)),
		redeemAuthLinkSessionWithBrowserTransaction: vi.fn(
			store.redeemAuthLinkSessionWithBrowserTransaction.bind(store),
		),
	};
	const completion = createCoordinatorBrowserLinkCompletionHandlers({
		config,
		csrfKey,
		limiter,
		store: operations,
	});
	if (!completion.ok) throw new Error("Completion setup failed");
	const link = createCoordinatorBrowserLinkHandlers({ config, csrfKey, limiter, store });
	if (!link.ok) throw new Error("Link setup failed");
	const callback = await createCoordinatorBrowserAuthCallback({
		config: rawConfig,
		store,
		completeLink: link.handlers.completeLink,
		oidcOptions: { fetch: oidc.fetch },
	});
	if (!callback.ok) throw new Error("Callback setup failed");
	const result = await callback.handlers.callback(
		new Request(oidc.authorize(new URL(authorization.authorizationUrl)), { headers: { cookie } }),
	);
	expect(result.outcome).toBe("link_dispatched");
	const page = await result.response.text();
	const csrf = page.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
	if (!csrf) throw new Error("Confirmation form missing");
	return {
		config,
		rawConfig,
		stores,
		store,
		review,
		attempt,
		cookie,
		parsed,
		csrf,
		csrfKey,
		limiter,
		operations,
		handlers: completion.handlers,
		link: link.handlers,
	};
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function rows(f: Fixture, table = "coordinator_auth_link_attempts") {
	return (
		await env.COORDINATOR_DB.prepare(
			`SELECT * FROM ${table} WHERE coordinator_id = ? ORDER BY rowid`,
		)
			.bind(f.config.coordinatorId)
			.all<Record<string, unknown>>()
	).results;
}
async function authority(f: Fixture) {
	return {
		links: await rows(f, "coordinator_auth_account_links"),
		sessions: await rows(f, "coordinator_auth_sessions"),
		receipts: await rows(f, "coordinator_auth_session_receipts"),
		profiles: await rows(f, "coordinator_auth_account_profiles"),
		device: await f.store.getEnrollment(f.review.groupId, f.review.deviceId),
	};
}
function post(
	f: Fixture,
	options: { action?: string; csrf?: string; cookie?: string; origin?: string } = {},
) {
	return new Request(`${ORIGIN}/auth/link/${options.action ?? "complete"}`, {
		method: "POST",
		headers: {
			cookie: options.cookie ?? f.cookie,
			origin: options.origin ?? ORIGIN,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ csrf: options.csrf ?? f.csrf, attempt_id: f.attempt.attemptId }),
	});
}
function get(f: Fixture) {
	return new Request(`${ORIGIN}/auth/link/complete?attempt_id=${f.attempt.attemptId}`, {
		headers: { cookie: f.cookie },
	});
}
async function confirm(f: Fixture) {
	const result = await f.link.confirm(post(f, { action: "confirm" }), "trusted-client");
	expect(result.response.status).toBe(200);
	const body = await result.response.text();
	const href = body.match(/<a\b[^>]*href="([^"]+)"/)?.[1].replaceAll("&amp;", "&");
	if (!href) throw new Error("Private hop missing");
	const decoded = Buffer.from(new URL(href).searchParams.get("completion") ?? "", "base64url");
	expect(decoded).toHaveLength(32);
	return {
		...f.review,
		...f.attempt,
		purpose: "coordinator-account-link-v1" as const,
		completionSecretHash: createHash("sha256").update(decoded).digest("hex"),
	};
}
async function ready(f: Fixture) {
	const proof = await confirm(f);
	// Authenticated-signer metadata simulation only; there is no signed device HTTP route here.
	expect(await f.stores[1].finalizeAuthLinkAttempt(proof, f.config)).toMatchObject({
		kind: "applied",
	});
}

it("native D1 fake-Google flow waits for device proofs, finishes and reads the live account", async () => {
	// Arrange
	const f = await setup();
	const before = await authority(f);
	const proof = await confirm(f);
	// Act
	const waiting = await f.handlers.page(get(f));
	const early = await f.handlers.complete(post(f), "trusted-client");
	// Assert
	expect(waiting.response.status).toBe(200);
	expect(await waiting.response.text()).not.toMatch(/<form|<script|http-equiv="refresh"/);
	expect(waiting.response.headers.getSetCookie()).toEqual([]);
	expect(early.response.status).toBe(403);
	expect(early.response.headers.getSetCookie()).toEqual([]);
	expect(await authority(f)).toEqual(before);
	for (const overrides of [
		{ runtimeVerifierHash: "e".repeat(64) },
		{ completionSecretHash: "e".repeat(64) },
	])
		expect(
			await f.stores[1].finalizeAuthLinkAttempt({ ...proof, ...overrides }, f.config),
		).toMatchObject({ kind: "rejected" });
	expect(await authority(f)).toEqual(before);
	expect(await f.stores[1].finalizeAuthLinkAttempt(proof, f.config)).toMatchObject({
		kind: "applied",
	});
	const finalized = await authority(f);
	const groupBefore = await f.store.getGroup(f.review.groupId);
	const grantsBefore = (
		await env.COORDINATOR_DB.prepare(
			"SELECT * FROM coordinator_bootstrap_grants ORDER BY rowid",
		).all()
	).results;
	// Act
	const page = await f.handlers.page(get(f));
	const body = await page.response.text();
	const csrf = body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
	// Assert
	expect(csrf).toHaveLength(86);
	expect(
		await verifyBrowserCsrfToken(
			f.csrfKey,
			f.parsed.secret,
			"transaction",
			{ publicOrigin: ORIGIN, store: f.config },
			csrf,
		),
	).toBe(true);
	expect(body).not.toMatch(/Fixture User|user@example.test|completion=/);
	expect(await authority(f)).toEqual(finalized);
	// Arrange: canonical stale browser SESSION, with no row in the real native D1 store.
	const stale = await issueBrowserCookie("session");
	const staleCookie = stale.setCookie.split(";")[0];
	expect(await rows(f, "coordinator_auth_sessions")).toEqual([]);
	// Act
	const complete = await f.handlers.complete(
		post(f, { csrf, cookie: `${f.cookie}; ${staleCookie}` }),
		"trusted-client",
	);
	// Assert
	expect(f.operations.readAuthSession).toHaveBeenCalledExactlyOnceWith(stale.cookieHash, f.config);
	expect(await f.operations.readAuthSession.mock.results[0].value).toBeNull();
	expect(f.operations.redeemAuthLinkSessionWithBrowserTransaction).toHaveBeenCalledTimes(1);
	expect(complete.response.status).toBe(303);
	expect(complete.response.headers.get("location")).toBe(`${ORIGIN}/auth/account`);
	const cookies = complete.response.headers.getSetCookie();
	expect(cookies).toHaveLength(2);
	expect(cookies).toContain(clearBrowserCookie("transaction"));
	const sessionCookie =
		cookies.find((cookie) => cookie !== clearBrowserCookie("transaction"))?.split(";")[0] ?? "";
	expect(sessionCookie).not.toBe(staleCookie);
	const parsed = await readBrowserCookie(sessionCookie, "session");
	if (parsed.kind !== "present") throw new Error("Returned SESSION missing");
	expect(parsed.cookieHash).not.toBe(stale.cookieHash);
	expect(await rows(f, "coordinator_auth_sessions")).toHaveLength(1);
	expect(await rows(f, "coordinator_auth_session_receipts")).toHaveLength(1);
	expect((await rows(f, "coordinator_auth_sessions"))[0]).toMatchObject({
		credential_hash: parsed.cookieHash,
		expires_at_ms: NOW + 28_800_000,
	});
	expect((await rows(f, "coordinator_auth_session_receipts"))[0]).toMatchObject({
		attempt_id: f.attempt.attemptId,
		source: "link_redeem",
		purge_eligible: 0,
	});
	expect((await rows(f))[0].state).toBe("session_redeemed");
	expect(await rows(f, "coordinator_auth_account_profiles")).toEqual([]);
	expect(await f.store.getEnrollment(f.review.groupId, f.review.deviceId)).toEqual(before.device);
	expect(await rows(f, "coordinator_auth_account_links")).toEqual(finalized.links);
	expect(await f.store.getGroup(f.review.groupId)).toEqual(groupBefore);
	expect(
		(
			await env.COORDINATOR_DB.prepare(
				"SELECT * FROM coordinator_bootstrap_grants ORDER BY rowid",
			).all()
		).results,
	).toEqual(grantsBefore);
	const account = await createCoordinatorBrowserAccount({
		config: f.rawConfig,
		csrfKey: f.csrfKey,
		store: f.stores[1],
		limiter: f.limiter,
	});
	if (!account.ok) throw new Error("Account setup failed");
	const live = await account.handlers.account(
		new Request(`${ORIGIN}/auth/account`, { headers: { cookie: sessionCookie } }),
	);
	expect(live.response.status).toBe(200);
	expect(await live.response.text()).toContain(f.review.identityId);
	const replay = await f.handlers.complete(post(f), "trusted-client");
	expect(replay.response.status).toBe(403);
	expect(replay.response.headers.getSetCookie()).toEqual([]);
});

it("native D1 rejects wrong origin/proof and defers pending completion despite a real live session", async () => {
	// Arrange
	const f = await setup();
	await ready(f);
	const session = await issueBrowserCookie("session");
	expect(
		await f.store.signInWithAuthAccount(
			{
				credentialHash: session.cookieHash,
				browserTransactionHash: "f".repeat(64),
				account: { issuer: f.config.issuer, subject: "fixture-subject" },
			},
			f.config,
		),
	).toMatchObject({ kind: "issued" });
	const before = await authority(f);
	f.limiter.check.mockClear();
	// Act
	const origin = await f.handlers.complete(
		post(f, { origin: "https://evil.example.test" }),
		"trusted-client",
	);
	// Assert
	expect(origin.response.status).toBe(403);
	expect(f.limiter.check).not.toHaveBeenCalled();
	for (const spy of Object.values(f.operations)) expect(spy).not.toHaveBeenCalled();
	const wrong = await f.handlers.complete(post(f, { csrf: "bad" }), "trusted-client");
	expect(wrong.response.status).toBe(403);
	expect(wrong.response.headers.getSetCookie()).toEqual([]);
	expect(await authority(f)).toEqual(before);
	// Act: a finalized ceremony preserves the actual live session without rotating it.
	const preserved = await f.handlers.complete(
		post(f, { cookie: `${f.cookie}; ${session.setCookie.split(";")[0]}` }),
		"trusted-client",
	);
	// Assert
	expect(preserved.response.status).toBe(303);
	expect(preserved.response.headers.getSetCookie()).toEqual([clearBrowserCookie("transaction")]);
	expect(f.operations.redeemAuthLinkSessionWithBrowserTransaction).not.toHaveBeenCalled();
	f.operations.readAuthSession.mockClear();
	// Arrange: same enrolled device starts a second LINK while its prior session remains live.
	const attemptId = crypto.randomUUID();
	expect(
		await f.store.createAuthLinkAttempt(
			{ ...f.attempt, attemptId, runtimeVerifierHash: "9".repeat(64) },
			f.config,
		),
	).toMatchObject({ kind: "created" });
	const txn = await issueBrowserCookie("transaction");
	const material = {
		stateHash: "1".repeat(64),
		binderHash: txn.cookieHash,
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
		purpose: "link" as const,
		attemptId,
	};
	expect(await f.store.startAuthBrowserTransaction(material, f.config)).toMatchObject({
		kind: "started",
	});
	const consumed = await f.store.consumeAuthBrowserTransaction(material, f.config);
	if (consumed.kind !== "consumed") throw new Error("Pending transaction not consumed");
	const browser = { attemptId, browserTransactionHash: consumed.browserTransactionHash };
	expect(
		await f.store.recordAuthLinkOidcVerified(
			{ ...browser, account: { issuer: f.config.issuer, subject: "fixture-subject" } },
			f.config,
		),
	).toMatchObject({ kind: "applied" });
	expect(
		await f.store.confirmAuthLinkAttempt(
			{ ...browser, completionSecretHash: "e".repeat(64) },
			f.config,
		),
	).toMatchObject({ kind: "applied" });
	const { issueBrowserCsrfToken } = await import("../../core/src/coordinator-browser-csrf.js");
	const csrf = await issueBrowserCsrfToken(f.csrfKey, txn.secret, "transaction", {
		publicOrigin: ORIGIN,
		store: f.config,
	});
	const request = new Request(`${ORIGIN}/auth/link/complete`, {
		method: "POST",
		headers: {
			cookie: `${txn.setCookie.split(";")[0]}; ${session.setCookie.split(";")[0]}`,
			origin: ORIGIN,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ csrf, attempt_id: attemptId }),
	});
	// Act
	const pending = await f.handlers.complete(request, "trusted-client");
	// Assert
	expect(pending.response.status).toBe(403);
	expect(pending.response.headers.getSetCookie()).toEqual([]);
	expect(f.operations.readAuthSession).not.toHaveBeenCalled();
	expect(f.operations.redeemAuthLinkSessionWithBrowserTransaction).not.toHaveBeenCalled();
	expect(await authority(f)).toEqual(before);
});

it("native D1 competing wrappers issue one session; failed store delivery releases no cookie", async () => {
	// Arrange
	const f = await setup();
	await ready(f);
	const other = createCoordinatorBrowserLinkCompletionHandlers({
		config: f.config,
		csrfKey: f.csrfKey,
		limiter: f.limiter,
		store: f.stores[1],
	});
	if (!other.ok) throw new Error("Peer setup failed");
	// Act
	const results = await Promise.all([
		f.handlers.complete(post(f), "client-a"),
		other.handlers.complete(post(f), "client-b"),
	]);
	// Assert
	expect(results.map((result) => result.response.status).sort()).toEqual([303, 403]);
	expect(
		results.find((result) => result.response.status === 403)?.response.headers.getSetCookie(),
	).toEqual([]);
	expect(await rows(f, "coordinator_auth_sessions")).toHaveLength(1);
	expect(await rows(f, "coordinator_auth_session_receipts")).toHaveLength(1);
	// Arrange
	const failed = await setup();
	await ready(failed);
	failed.operations.redeemAuthLinkSessionWithBrowserTransaction.mockRejectedValue(
		new Error("privateCause"),
	);
	// Act
	const fault = await failed.handlers.complete(post(failed), "trusted-client");
	// Assert
	expect(fault.response.status).toBe(503);
	expect(fault.response.headers.getSetCookie()).toEqual([]);
	expect(await fault.response.text()).not.toMatch(/privateCause|Fixture User|user@example.test/);
	expect(await rows(failed, "coordinator_auth_sessions")).toEqual([]);
});

it("keeps completion GET and POST unmounted in the default Worker", async () => {
	// Arrange: no Chrome, live Google, enrollment CLI or loopback listener is implied.
	const methods = ["GET", "POST"];
	// Act
	const responses = await Promise.all(
		methods.map((method) =>
			exports.default.fetch(new Request(`${ORIGIN}/auth/link/complete`, { method })),
		),
	);
	// Assert
	for (const response of responses) {
		expect(response.status).toBe(404);
		expect(response.headers.getSetCookie()).toEqual([]);
	}
});
