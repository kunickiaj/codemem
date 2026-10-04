import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BROWSER_COOKIE_NAMES,
	readBrowserCookie,
} from "../../core/src/coordinator-browser-credential.js";
import {
	importBrowserCsrfKey,
	verifyBrowserCsrfToken,
} from "../../core/src/coordinator-browser-csrf.js";
import { createCoordinatorBrowserSigninStart } from "../../core/src/coordinator-browser-signin-start.js";
import { challenge, oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { createInMemoryRequestRateLimiter } from "../../core/src/request-rate-limit.js";

const ORIGIN = "https://app.example.test";
const URL_START = `${ORIGIN}/auth/sign-in`;
const TABLE = "coordinator_auth_browser_transactions";
const config = Object.freeze({
	enabled: true,
	coordinatorId: "coordinator-test",
	issuer: "https://accounts.google.com",
	redirectUri: PROVIDER.redirectUri,
	revision: "a".repeat(64),
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
});
const scope = { publicOrigin: ORIGIN, store: config };

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
});
afterEach(async () => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
		await env.COORDINATOR_DB.prepare(`DELETE FROM ${TABLE}`).run();
	} finally {
		vi.restoreAllMocks();
	}
});

async function setup() {
	const fixture = oidcFixture({ issuer: config.issuer });
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const limiter = createInMemoryRequestRateLimiter();
	const check = vi.spyOn(limiter, "check");
	const stores = [
		new D1CoordinatorStore(env.COORDINATOR_DB),
		new D1CoordinatorStore(env.COORDINATOR_DB),
	];
	const options = { config, csrfKey, limiter, oidcOptions: { fetch: fixture.fetch } };
	const first = await createCoordinatorBrowserSigninStart({ ...options, store: stores[0] });
	const second = await createCoordinatorBrowserSigninStart({ ...options, store: stores[1] });
	if (!first.ok || !second.ok) throw new Error("Signin factory failed");
	fixture.fetch.mockClear();
	const handlers = [first.handlers, second.handlers];
	return { fixture, csrfKey, check, stores, options, handlers };
}

async function rows() {
	return (await env.COORDINATOR_DB.prepare(`SELECT * FROM ${TABLE}`).all<Record<string, unknown>>())
		.results;
}

// Same attribute regex convention as auth-browser-view.integration.test.ts; no browser navigation.
async function form(handler: Awaited<ReturnType<typeof setup>>["handlers"][number]) {
	const request = new Request(URL_START);
	const { response } = await handler.signInPage(request);
	const body = await response.text();
	const csrf = body.match(/name="csrf" value="([^"]+)"/)?.[1];
	const cookies = response.headers.getSetCookie();
	if (!csrf || cookies.length !== 1) throw new Error("Missing start form");
	return { request, response, body, csrf, cookie: cookies[0].split(";")[0] };
}

function post(cookie: string, csrf: string) {
	return new Request(URL_START, {
		method: "POST",
		headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", cookie },
		body: new URLSearchParams({ csrf }),
	});
}

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

describe("unmounted browser signin handlers in workerd with native D1", () => {
	it("issues a scoped START form without writes, then persists private material and preserves both cookies", async () => {
		// Arrange: real WebCrypto key and native requests; only issuer HTTP transport is mocked.
		const f = await setup();
		const page = await form(f.handlers[0]);
		const start = await readBrowserCookie(page.cookie, "start");
		if (start.kind !== "present") throw new Error("Invalid START cookie");
		expect(Object.isFrozen(f.handlers[0])).toBe(true);
		expect(page.response.status).toBe(200);
		expect(page.request.bodyUsed).toBe(false);
		expect(page.cookie).toMatch(new RegExp(`^${BROWSER_COOKIE_NAMES.start}=`));
		expect(await rows()).toEqual([]);
		expect(f.fixture.fetch).not.toHaveBeenCalled();
		const verify = (boundScope: typeof scope) =>
			verifyBrowserCsrfToken(f.csrfKey, start.secret, "start", boundScope, page.csrf);
		expect(await verify(scope)).toBe(true);
		expect(await verify({ ...scope, store: { ...config, revision: "b".repeat(64) } })).toBe(false);
		expect(await verify({ ...scope, publicOrigin: "https://wrong.example.test" })).toBe(false);
		expect(
			await verifyBrowserCsrfToken(f.csrfKey, start.secret, "transaction", scope, page.csrf),
		).toBe(false);
		// Act: the authenticated form MAC is not an authorization grant; it only admits a pending row.
		const { response: bad } = await f.handlers[0].signInStart(
			post(page.cookie, `${page.csrf.slice(0, 1) === "A" ? "B" : "A"}${page.csrf.slice(1)}`),
			"client-1",
		);
		expect(bad.status).toBe(403);
		expect(bad.headers.getSetCookie()).toEqual([]);
		expect(await rows()).toEqual([]);
		const { response } = await f.handlers[0].signInStart(post(page.cookie, page.csrf), "client-1");
		const body = await response.text();
		const href = body.match(/href="(https:[^"]+)"/)?.[1];
		if (!href) throw new Error("Missing explicit provider anchor");
		const authorization = new URL(href.replaceAll("&amp;", "&"));
		const stored = await rows();
		// Assert: no callback/token exchange, HTTP redirect, session, or private verifier disclosure.
		expect(response.status).toBe(200);
		expect(body).toContain(">Continue to Google</a>");
		expect(response.headers.get("location")).toBeNull();
		expect(response.headers.getSetCookie()).toEqual([
			`${BROWSER_COOKIE_NAMES.transaction}=${page.cookie.split("=")[1]}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`,
			`${BROWSER_COOKIE_NAMES.start}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
		]);
		expect(stored).toHaveLength(1);
		const row = stored[0];
		const raw = Uint8Array.from(
			atob(`${page.cookie.split("=")[1].replaceAll("-", "+").replaceAll("_", "/")}=`),
			(c) => c.charCodeAt(0),
		);
		expect(row).toMatchObject({
			purpose: "signin",
			state: "pending",
			binder_hash: await sha256(raw),
			state_hash: await sha256(
				new TextEncoder().encode(authorization.searchParams.get("state") ?? ""),
			),
		});
		expect(row.nonce).toBe(authorization.searchParams.get("nonce"));
		expect(row.pkce_verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
		expect(authorization.searchParams.get("code_challenge")).toBe(
			await challenge(String(row.pkce_verifier)),
		);
		expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
		const outsideAnchor = body.replace(/<a\b[^>]*href="https:[^"]+"[^>]*>[\s\S]*?<\/a>/g, "");
		for (const value of [
			row.nonce,
			authorization.searchParams.get("state"),
			row.pkce_verifier,
			config.clientSecret,
		]) {
			expect(outsideAnchor).not.toContain(String(value));
		}
		expect(body).not.toContain(String(row.pkce_verifier));
		expect(JSON.stringify([...response.headers])).not.toContain(String(row.pkce_verifier));
		expect(body).not.toMatch(
			/outcome|privateCause|clientSecret|pkceVerifier|access_token|id_token/,
		);
		expect(f.fixture.fetch).not.toHaveBeenCalled();
	});

	it("admits exactly one of eight same-START requests across two real store objects", async () => {
		// Arrange: two D1 adapters share this pool's actual binding and one original limiter (limit 20).
		const f = await setup();
		expect(f.stores[0]).not.toBe(f.stores[1]);
		const page = await form(f.handlers[0]);
		const requests = Array.from({ length: 8 }, () => post(page.cookie, page.csrf));
		// Act: simultaneous logical starts reach native D1 statements and its unique-binder constraint.
		const results = await Promise.all(
			requests.map((request, i) => f.handlers[i % 2].signInStart(request, "race-client")),
		);
		const responses = results.map(({ response }) => response);
		// Assert: this is not evidence of separate production isolates or separate SQL connections.
		expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
		expect(responses.filter((response) => response.status === 409)).toHaveLength(7);
		for (const [i, response] of responses.entries()) {
			if (response.status === 200) expect(response.headers.getSetCookie()).toHaveLength(2);
			else {
				expect(results[i].outcome).toBe("start_conflict");
				expect(response.headers.getSetCookie()).toEqual([]);
			}
		}
		expect(await rows()).toHaveLength(1);
		expect(f.fixture.fetch).not.toHaveBeenCalled();
	});

	it("rejects early origins without pulling native bodies or checking the limiter, and refuses transaction overwrite", async () => {
		// Arrange: HWM zero prevents a stream pull merely because Request stores the body.
		const f = await setup();
		const check = f.check;
		const page = await form(f.handlers[0]);
		for (const origin of ["https://wrong.example.test", "null", undefined]) {
			const pull = vi.fn();
			const headers = new Headers({
				"content-type": "application/x-www-form-urlencoded",
				cookie: page.cookie,
			});
			if (origin !== undefined) headers.set("origin", origin);
			const request = new Request(URL_START, {
				method: "POST",
				headers,
				body: new ReadableStream({ pull }, { highWaterMark: 0 }),
			});
			// Act
			const { response } = await f.handlers[0].signInStart(request, "origin-client");
			// Assert
			expect(response.status).toBe(403);
			expect(request.bodyUsed).toBe(false);
			expect(pull).not.toHaveBeenCalled();
			expect(check).not.toHaveBeenCalled();
			expect(response.headers.getSetCookie()).toEqual([]);
		}
		const txn = `${BROWSER_COOKIE_NAMES.transaction}=${page.cookie.split("=")[1]}`;
		for (const [cookie, status] of [
			[txn, 409],
			[`${BROWSER_COOKIE_NAMES.transaction}=bad`, 400],
		] as const) {
			const { response: get } = await f.handlers[0].signInPage(
				new Request(URL_START, { headers: { cookie } }),
			);
			const { response } = await f.handlers[0].signInStart(post(cookie, page.csrf), "txn-client");
			expect(get.status).toBe(status);
			expect(response.status).toBe(status);
			expect(get.headers.getSetCookie()).toEqual([]);
			expect(response.headers.getSetCookie()).toEqual([]);
		}
		expect(await rows()).toEqual([]);
		expect(f.fixture.fetch).not.toHaveBeenCalled();
	});

	it("keeps unsupported requests and the default Worker unmounted, and classifies invalid preflight", async () => {
		// Arrange: these raw trusted inputs are fixture data, not an environment or HTTP config loader.
		const f = await setup();
		// Act
		const invalidConfig = await createCoordinatorBrowserSigninStart({
			...f.options,
			store: f.stores[0],
			config: { ...config, issuer: "https://wrong.example.test" },
		});
		const requests = [new Request(`${URL_START}?next=bad`), new Request(`${ORIGIN}/wrong`)];
		// Assert: bad preflight returns a closed result instead of throwing or discovering an issuer.
		expect(invalidConfig).toEqual({
			ok: false,
			error: "browser_auth_config_invalid",
			field: "issuer",
		});
		for (const request of requests) {
			const { response } = await f.handlers[0].signInPage(request);
			expect(response.status).toBe(404);
			expect(response.headers.getSetCookie()).toEqual([]);
			const { response: posted } = await f.handlers[0].signInStart(
				new Request(request.url, { method: "POST" }),
				"route-client",
			);
			expect(posted.status).toBe(404);
			expect(posted.headers.getSetCookie()).toEqual([]);
		}
		for (const method of ["GET", "POST"]) {
			const response = await exports.default.fetch(URL_START, { method });
			expect(response.status).toBe(404);
			expect(response.headers.getSetCookie()).toEqual([]);
		}
		const unsupported = await f.handlers[0].signInStart(
			new Request(URL_START, { method: "PUT" }),
			"route-client",
		);
		expect(unsupported.response.status).toBe(405);
		expect(unsupported.response.headers.get("allow")).toBe("POST");
		expect(unsupported.response.headers.getSetCookie()).toEqual([]);
		const wrongGet = await f.handlers[0].signInPage(new Request(URL_START, { method: "POST" }));
		expect(wrongGet.response.status).toBe(405);
		expect(wrongGet.response.headers.get("allow")).toBe("GET");
		expect(wrongGet.response.headers.getSetCookie()).toEqual([]);
		expect(await rows()).toEqual([]);
		expect(f.fixture.fetch).not.toHaveBeenCalled();
		const invalidKey = await createCoordinatorBrowserSigninStart({
			...f.options,
			store: f.stores[0],
			csrfKey: {} as typeof f.csrfKey,
		});
		// Opaque keys cannot be prevalidated by the factory; handlers must fail closed.
		expect(invalidKey.ok).toBe(true);
		if (!invalidKey.ok) throw new Error("Expected opaque-key factory success");
		expect(f.fixture.fetch).toHaveBeenCalledTimes(1);
		f.fixture.fetch.mockClear();
		const validPage = await form(f.handlers[0]);
		const failedGet = await invalidKey.handlers.signInPage(new Request(URL_START));
		const failedPost = await invalidKey.handlers.signInStart(
			post(validPage.cookie, validPage.csrf),
			"bad-key-client",
		);
		expect(failedGet.outcome).toBe("internal_error");
		expect(failedGet.response.status).toBe(503);
		expect(failedPost.outcome).toBe("csrf_invalid");
		expect(failedPost.response.status).toBe(403);
		for (const { response } of [failedGet, failedPost]) {
			expect(response.headers.getSetCookie()).toEqual([]);
			expect(response.headers.get("location")).toBeNull();
			expect(await response.text()).not.toMatch(
				/privateCause|auth_browser_csrf|fixture-secret|nonce=|pkce|<form|accounts\.google\.com/,
			);
		}
		expect(await rows()).toEqual([]);
		expect(f.fixture.fetch).not.toHaveBeenCalled();
	});
});
