import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCoordinatorBrowserAccount } from "../../core/src/coordinator-browser-account.js";
import { createCoordinatorBrowserAuthCallback } from "../../core/src/coordinator-browser-auth-callback.js";
import {
	BROWSER_COOKIE_NAMES,
	clearBrowserCookie,
	readBrowserCookie,
} from "../../core/src/coordinator-browser-credential.js";
import {
	importBrowserCsrfKey,
	issueBrowserCsrfToken,
	verifyBrowserCsrfToken,
} from "../../core/src/coordinator-browser-csrf.js";
import { createCoordinatorBrowserSigninStart } from "../../core/src/coordinator-browser-signin-start.js";
import { oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { createInMemoryRequestRateLimiter } from "../../core/src/request-rate-limit.js";

const ORIGIN = "https://app.example.test";
const ACCOUNT = `${ORIGIN}/auth/account`;
const LOGOUT = `${ORIGIN}/auth/logout`;
const NOW = 1790899200000;
type Fixture = Awaited<ReturnType<typeof setup>>;
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
	}
});

async function rows(f: Fixture, table = "coordinator_auth_sessions") {
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
		device: await f.stores[1].getEnrollment(f.review.groupId, f.review.deviceId),
		grants: (
			await env.COORDINATOR_DB.prepare(
				"SELECT * FROM coordinator_bootstrap_grants ORDER BY rowid",
			).all()
		).results,
	};
}
async function setup() {
	const config = Object.freeze({
		enabled: true,
		coordinatorId: crypto.randomUUID(),
		issuer: "https://accounts.google.com",
		redirectUri: PROVIDER.redirectUri,
		revision: "a".repeat(64),
		clientId: PROVIDER.clientId,
		clientSecret: PROVIDER.clientSecret,
	});
	// Two adapters share the pool's binding, not separate production isolates/connections.
	const clock = { now: NOW };
	const stores = [
		new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => clock.now }),
		new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => clock.now }),
	];
	const store = stores[0];
	// Trusted reviewed linking setup follows auth-account-profile and callback fixtures.
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
	const start = {
		attemptId: crypto.randomUUID(),
		signer: review,
		runtimeVerifierHash: "d".repeat(64),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	await store.createGroup(review.groupId, "Fixture group");
	await store.enrollDevice(review.groupId, { ...review, identityId: null });
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	expect(await store.createAuthLinkAttempt(start, config)).toMatchObject({ kind: "created" });
	const browser = { attemptId: start.attemptId, browserTransactionHash: "e".repeat(64) };
	const confirm = { ...browser, completionSecretHash: "f".repeat(64) };
	expect(await store.claimAuthLinkAttempt(browser, config)).toMatchObject({ kind: "applied" });
	expect(
		await store.recordAuthLinkOidcVerified(
			{ ...browser, account: { issuer: config.issuer, subject: "fixture-subject" } },
			config,
		),
	).toMatchObject({ kind: "applied" });
	expect(await store.confirmAuthLinkAttempt(confirm, config)).toMatchObject({ kind: "applied" });
	expect(
		await store.finalizeAuthLinkAttempt(
			{
				...review,
				...start,
				completionSecretHash: confirm.completionSecretHash,
				purpose: "coordinator-account-link-v1",
			},
			config,
		),
	).toMatchObject({ kind: "applied" });
	const fixture = oidcFixture({ issuer: config.issuer });
	fixture.claims.roles = ["administrator"];
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const limiter = createInMemoryRequestRateLimiter();
	const check = vi.spyOn(limiter, "check");
	const input = { config, store, csrfKey, limiter };
	const started = await createCoordinatorBrowserSigninStart({
		...input,
		oidcOptions: { fetch: fixture.fetch },
	});
	const completeLink = vi.fn(async () => {
		throw new Error("Unexpected link dispatch");
	});
	const callback = await createCoordinatorBrowserAuthCallback({
		config,
		store,
		completeLink,
		oidcOptions: { fetch: fixture.fetch },
	});
	const operations = {
		account: vi.spyOn(store, "readAuthSessionAccount"),
		read: vi.spyOn(store, "readAuthSession"),
		write: vi.spyOn(store, "signOutAuthSession"),
	};
	const account = await createCoordinatorBrowserAccount(input);
	if (!started.ok || !callback.ok || !account.ok) throw new Error("Factory setup failed");
	return {
		config,
		clock,
		stores,
		review,
		fixture,
		csrfKey,
		limiter,
		check,
		input,
		operations,
		started: started.handlers,
		callback: callback.handlers,
		handlers: account.handlers,
		completeLink,
	};
}
function get(cookie?: string, url = ACCOUNT) {
	return new Request(url, { headers: cookie ? { cookie } : {} });
}
function post(cookie: string, csrf: string, url = LOGOUT) {
	return new Request(url, {
		method: "POST",
		headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ csrf }),
	});
}
async function token(response: Response) {
	const body = await response.clone().text();
	const csrf = body.match(/name="csrf" value="([^"]+)"/)?.[1];
	if (!csrf || !/^[A-Za-z0-9_-]{86}$/.test(csrf)) throw new Error("Missing native HTTP form token");
	return { csrf, body };
}
async function signin(f: Fixture, client = "ceremony-client") {
	// Profile snapshots replace only strictly older sign-ins; deterministic logical time.
	f.clock.now += 1;
	const page = await f.started.signInPage(get(undefined, `${ORIGIN}/auth/sign-in`));
	const form = await token(page.response);
	const startCookie = page.response.headers.getSetCookie()[0].split(";")[0];
	const begun = await f.started.signInStart(
		post(startCookie, form.csrf, `${ORIGIN}/auth/sign-in`),
		client,
	);
	const href = (await begun.response.text()).match(/href="(https:[^"]+)"/)?.[1];
	if (!href) throw new Error("Missing provider anchor");
	const authorization = new URL(href.replaceAll("&amp;", "&"));
	const result = await f.callback.callback(
		get(
			begun.response.headers.getSetCookie()[0].split(";")[0],
			f.fixture.authorize(authorization).href,
		),
	);
	expect(result.outcome).toBe("signed_in");
	expect(result.response.status).toBe(303);
	expect(result.response.headers.get("location")).toBe(ACCOUNT);
	const cookies = result.response.headers.getSetCookie();
	expect(cookies).toEqual([
		expect.stringMatching(
			new RegExp(
				`^${BROWSER_COOKIE_NAMES.session}=[A-Za-z0-9_-]{43}; Max-Age=28800; Path=/; Secure; HttpOnly; SameSite=Lax$`,
			),
		),
		clearBrowserCookie("transaction"),
	]);
	const cookie = cookies[0].split(";")[0];
	const credential = await readBrowserCookie(cookie, "session");
	if (credential.kind !== "present") throw new Error("Missing session credential");
	expect(f.completeLink).not.toHaveBeenCalled();
	return { cookie, credential };
}
function reset(f: Fixture) {
	f.check.mockClear();
	for (const spy of Object.values(f.operations)) spy.mockClear();
	f.fixture.fetch.mockClear();
}
async function privateResponse(response: Response, status: number) {
	expect(response.status).toBe(status);
	expect(response.headers.getSetCookie()).toEqual([]);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(await response.text()).not.toMatch(
		/privateCause|Unexpected link dispatch|fixture-secret|auth_browser_csrf/,
	);
}

it("renders only public account metadata, verifies session MAC, and revokes only this browser session", async () => {
	// Arrange: two full Google ceremonies, native D1/crypto, injected provider transport only.
	const f = await setup();
	const before = await authority(f);
	const first = await signin(f);
	const second = await signin(f, "second-browser");
	const original = await rows(f);
	const profiles = await rows(f, "coordinator_auth_account_profiles");
	reset(f);
	// Act: GET must not write, change cookies, or contact the provider.
	const page = await f.handlers.account(get(first.cookie));
	const { csrf, body } = await token(page.response);
	// Assert: this checks HTTP markup, not browser execution.
	expect(page.outcome).toBe("account_page");
	expect(page.response.status).toBe(200);
	expect(page.response.headers.getSetCookie()).toEqual([]);
	expect(page.response.headers.get("cache-control")).toBe("no-store");
	expect(page.response.headers.get("referrer-policy")).toBe("same-origin");
	expect(body).toContain(f.review.identityId);
	expect(body).toContain("Fixture User");
	expect(body).toContain("user@example.test");
	expect(body).toMatch(/<form method="post" action="\/auth\/logout">/);
	const style = body.match(/<style>([\s\S]*?)<\/style>/)?.[1];
	if (!style) throw new Error("Missing style");
	const styleHash = btoa(
		String.fromCharCode(
			...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(style))),
		),
	);
	expect(page.response.headers.get("content-security-policy")).toContain(
		`style-src 'sha256-${styleHash}'`,
	);
	expect(page.response.headers.get("content-security-policy")).toContain("form-action 'self'");
	for (const secret of [
		first.cookie,
		first.cookie.split("=")[1],
		first.credential.cookieHash,
		f.config.clientSecret,
		"fixture-subject",
		...original.map((row) => String(row.session_id)),
		...before.links.map((row) => String(row.link_id)),
	])
		expect(body).not.toContain(secret);
	expect(body).not.toMatch(/roles|administrator|credential_hash|client_secret|session_id|link_id/);
	const scope = { publicOrigin: ORIGIN, store: f.config };
	expect(
		await verifyBrowserCsrfToken(f.csrfKey, first.credential.secret, "session", scope, csrf),
	).toBe(true);
	expect(
		await verifyBrowserCsrfToken(f.csrfKey, second.credential.secret, "session", scope, csrf),
	).toBe(false);
	expect(
		await verifyBrowserCsrfToken(f.csrfKey, first.credential.secret, "start", scope, csrf),
	).toBe(false);
	expect(
		await verifyBrowserCsrfToken(
			f.csrfKey,
			first.credential.secret,
			"session",
			{ ...scope, store: { ...f.config, revision: "b".repeat(64) } },
			csrf,
		),
	).toBe(false);
	expect(await rows(f)).toEqual(original);
	expect(await rows(f, "coordinator_auth_account_profiles")).toEqual(profiles);
	expect(f.operations.write).not.toHaveBeenCalled();
	expect(f.fixture.fetch).not.toHaveBeenCalled();
	// Act: the real read/write/read sequence confirms revocation before cookie release.
	reset(f);
	const logged = await f.handlers.logout(post(first.cookie, csrf), "logout-client");
	const follow = await f.handlers.account(get(first.cookie));
	// Assert: the other SID and account/device/project authority survive.
	expect(logged.outcome).toBe("signed_out");
	expect(logged.response.status).toBe(200);
	expect(logged.response.headers.getSetCookie()).toEqual([clearBrowserCookie("session")]);
	expect(f.operations.read).toHaveBeenCalledTimes(2);
	expect(f.operations.write).toHaveBeenCalledExactlyOnceWith(first.credential.cookieHash, {
		coordinatorId: f.config.coordinatorId,
	});
	expect(f.operations.read.mock.invocationCallOrder[0]).toBeLessThan(
		f.operations.write.mock.invocationCallOrder[0],
	);
	expect(f.operations.write.mock.invocationCallOrder[0]).toBeLessThan(
		f.operations.read.mock.invocationCallOrder[1],
	);
	expect(await f.stores[1].readAuthSession(first.credential.cookieHash, f.config)).toBeNull();
	expect(await f.stores[1].readAuthSession(second.credential.cookieHash, f.config)).not.toBeNull();
	expect((await rows(f)).filter((row) => row.revoked_at_ms !== null)).toHaveLength(1);
	expect(follow.outcome).toBe("signed_out");
	await privateResponse(follow.response, 200);
	expect(await authority(f)).toEqual(before);
});

it("rejects origins before native body/limiter/store work and shares the default start/logout budget", async () => {
	// Arrange
	const f = await setup();
	const s = await signin(f);
	const { csrf } = await token((await f.handlers.account(get(s.cookie))).response);
	const before = await rows(f);
	reset(f);
	for (const origin of ["https://wrong.example.test", "null", undefined]) {
		const pull = vi.fn();
		const headers = new Headers({
			cookie: s.cookie,
			"content-type": "application/x-www-form-urlencoded",
		});
		if (origin !== undefined) headers.set("origin", origin);
		const request = new Request(LOGOUT, {
			method: "POST",
			headers,
			body: new ReadableStream({ pull }, { highWaterMark: 0 }),
		});
		// Act
		const result = await f.handlers.logout(request, "budget-client");
		// Assert
		expect(result.outcome).toBe("origin_rejected");
		await privateResponse(result.response, 403);
		expect(request.bodyUsed).toBe(false);
		expect(pull).not.toHaveBeenCalled();
		expect(f.check).not.toHaveBeenCalled();
		for (const spy of Object.values(f.operations)) expect(spy).not.toHaveBeenCalled();
	}
	// Act: ten rejected start proofs plus ten rejected logout proofs consume one bucket.
	let replacement = "A";
	if (csrf[0] === "A") replacement = "B";
	const invalidCsrf = `${replacement}${csrf.slice(1)}`;
	for (let i = 0; i < 20; i++) {
		let response: Response;
		if (i < 10) {
			response = (
				await f.started.signInStart(post(s.cookie, csrf, `${ORIGIN}/auth/sign-in`), "budget-client")
			).response;
		} else {
			response = (await f.handlers.logout(post(s.cookie, invalidCsrf), "budget-client")).response;
		}
		expect(response.status).toBe(403);
		expect(response.headers.getSetCookie()).toEqual([]);
	}
	const denied = await f.handlers.logout(post(s.cookie, csrf), "budget-client");
	// Assert: using the original limiter object prevents separate per-action budgets.
	expect(denied.outcome).toBe("rate_limited");
	await privateResponse(denied.response, 429);
	expect(denied.response.headers.get("retry-after")).toBe("3");
	expect(f.check).toHaveBeenCalledTimes(21);
	for (const [key, limit] of f.check.mock.calls) {
		expect(key).toBe(JSON.stringify(["browser-form", f.config.coordinatorId, "budget-client"]));
		expect(limit).toBe(20);
	}
	for (const spy of Object.values(f.operations)) expect(spy).not.toHaveBeenCalled();
	expect(await rows(f)).toEqual(before);
	expect(f.fixture.fetch).not.toHaveBeenCalled();
});

it("keeps cookies on writer/confirmation faults and treats missing, malformed, dead and changed-scope sessions conservatively", async () => {
	// Arrange: every fault owns a live SID and the actual methods are spied before factory capture.
	const f = await setup();
	for (const fault of ["writer", "confirmation"] as const) {
		const s = await signin(f, `fault-${fault}`);
		const { csrf } = await token((await f.handlers.account(get(s.cookie))).response);
		reset(f);
		if (fault === "writer") f.operations.write.mockRejectedValueOnce(new Error("privateCause"));
		else
			f.operations.read
				.mockImplementationOnce(f.stores[1].readAuthSession.bind(f.stores[1]))
				.mockRejectedValueOnce(new Error("privateCause"));
		// Act
		const result = await f.handlers.logout(post(s.cookie, csrf), `logout-${fault}`);
		// Assert: confirmation can fail after a successful write; no rollback claim.
		expect(result.outcome).toBe("internal_error");
		await privateResponse(result.response, 503);
		expect((await f.stores[1].readAuthSession(s.credential.cookieHash, f.config)) === null).toBe(
			fault === "confirmation",
		);
	}
	const live = await signin(f, "revision-client");
	const before = await rows(f);
	const current = { ...f.config, revision: "b".repeat(64) };
	const revised = await createCoordinatorBrowserAccount({ ...f.input, config: current });
	if (!revised.ok) throw new Error("Changed-scope factory failed");
	const csrf = await issueBrowserCsrfToken(f.csrfKey, live.credential.secret, "session", {
		publicOrigin: ORIGIN,
		store: current,
	});
	reset(f);
	// Act
	const changedGet = await revised.handlers.account(get(live.cookie));
	const changedPost = await revised.handlers.logout(post(live.cookie, csrf), "revision-logout");
	const missingPost = await f.handlers.logout(post("", csrf), "missing-client");
	const invalidGets = await Promise.all(
		[
			undefined,
			`${BROWSER_COOKIE_NAMES.session}=bad`,
			`${BROWSER_COOKIE_NAMES.session}=${"A".repeat(43)}`,
		].map((cookie) => f.handlers.account(get(cookie))),
	);
	// Assert: current-config absence clears the browser only, not old-config rows.
	expect(changedGet.outcome).toBe("signed_out");
	await privateResponse(changedGet.response, 200);
	expect(changedPost.outcome).toBe("already_signed_out");
	expect(changedPost.response.status).toBe(200);
	expect(changedPost.response.headers.getSetCookie()).toEqual([clearBrowserCookie("session")]);
	expect(missingPost.outcome).toBe("signed_out");
	await privateResponse(missingPost.response, 200);
	for (const result of invalidGets) await privateResponse(result.response, 200);
	expect(f.operations.write).not.toHaveBeenCalled();
	expect(await rows(f)).toEqual(before);
	// An operator rollback to the old config can still see this LIVE row: not forced revocation.
	expect(await f.stores[1].readAuthSession(live.credential.cookieHash, f.config)).not.toBeNull();
	expect(f.fixture.fetch).not.toHaveBeenCalled();
});

it("fails closed for missing/forged keys and exact routes while default Worker account/logout remain unmounted", async () => {
	// Arrange
	const f = await setup();
	const s = await signin(f);
	const before = await rows(f);
	const { csrf } = await token((await f.handlers.account(get(s.cookie))).response);
	const { csrfKey: _key, ...missingKey } = f.input;
	reset(f);
	// Act
	const missing = await createCoordinatorBrowserAccount(missingKey as typeof f.input);
	const forged = await createCoordinatorBrowserAccount({
		...f.input,
		csrfKey: {} as typeof f.csrfKey,
	});
	// Assert: an opaque object never becomes a working imported MAC key.
	expect(missing).toEqual({ ok: false, error: "invalid_input" });
	if (!forged.ok) throw new Error("Expected deferred opaque key check");
	await privateResponse((await forged.handlers.account(get(s.cookie))).response, 503);
	const failed = await forged.handlers.logout(post(s.cookie, csrf), "forged-client");
	expect(failed.outcome).toBe("csrf_invalid");
	await privateResponse(failed.response, 403);
	for (const [url, method, expected, allow] of [
		[ACCOUNT, "POST", 405, "GET"],
		[LOGOUT, "GET", 405, "POST"],
		[`${ACCOUNT}?code=gibberish`, "GET", 404, null],
		[`${ACCOUNT}#state=gibberish`, "GET", 404, null],
		[ACCOUNT.replace(ORIGIN, "https://wrong.example.test"), "GET", 404, null],
		[`${LOGOUT}/`, "POST", 404, null],
	] as const) {
		// Act: HTTP-native fields, no caller-owned getter substitutions.
		const request = new Request(url, { method });
		let result: Awaited<ReturnType<typeof f.handlers.account>>;
		if (url === ACCOUNT || (method === "GET" && url !== LOGOUT))
			result = await f.handlers.account(request);
		else result = await f.handlers.logout(request, "route-client");
		// Assert
		await privateResponse(result.response, expected);
		expect(result.response.headers.get("allow")).toBe(allow);
	}
	for (const url of [ACCOUNT, LOGOUT])
		for (const method of ["GET", "POST"]) {
			const response = await exports.default.fetch(url, { method });
			expect(response.status).toBe(404);
			expect(response.headers.getSetCookie()).toEqual([]);
		}
	expect(f.operations.write).not.toHaveBeenCalled();
	expect(await rows(f)).toEqual(before);
	expect(f.fixture.fetch).not.toHaveBeenCalled();
});
