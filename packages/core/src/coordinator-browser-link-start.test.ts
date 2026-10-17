import { createHash, randomBytes } from "node:crypto";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TABLE } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { attempt, authorize, finalize, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { createCoordinatorBrowserAuthCallback } from "./coordinator-browser-auth-callback.js";
import {
	BROWSER_COOKIE_NAMES,
	clearBrowserCookie,
	issueBrowserCookie,
} from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { createCoordinatorBrowserLinkHandlers } from "./coordinator-browser-link.js";
import { createCoordinatorBrowserLinkStart } from "./coordinator-browser-link-start.js";
import * as browserRequest from "./coordinator-browser-request.js";
import { createCoordinatorBrowserSigninStart } from "./coordinator-browser-signin-start.js";
import { challenge, oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

const ORIGIN = "https://app.example.test";
const URL_START = `${ORIGIN}/auth/link/start`;
const ATTEMPTS = "coordinator_auth_link_attempts";
const databases: ReturnType<typeof setupStore>["db"][] = [];
const hash = (raw: Uint8Array | string) => createHash("sha256").update(raw).digest("hex");
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		for (const db of databases.splice(0)) db.close();
	}
});

async function setup(backend: Backend = "SQLite", options: { legacy?: boolean } = {}) {
	const f = setupStore(backend, { authClock: () => NOW });
	databases.push(f.db);
	const config = {
		enabled: true,
		coordinatorId: "coordinator-a",
		issuer: "https://accounts.google.com",
		redirectUri: PROVIDER.redirectUri,
		revision: "a".repeat(64),
		clientId: PROVIDER.clientId,
		clientSecret: PROVIDER.clientSecret,
	};
	await authorize({ ...f, now: NOW, cfg: config });
	const startRaw = randomBytes(32);
	const startCode = startRaw.toString("base64url");
	const deviceRaw = randomBytes(32);
	const input = attempt({
		runtimeVerifierHash: hash(deviceRaw),
		...(options.legacy ? {} : { browserStartHash: hash(startRaw) }),
	});
	expect(await f.store.createAuthLinkAttempt(input, config)).toMatchObject({ kind: "created" });
	const oidc = oidcFixture({ issuer: config.issuer });
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const limiter = createInMemoryRequestRateLimiter();
	const check = vi.spyOn(limiter, "check");
	const start = vi.fn(f.store.startAuthBrowserTransaction.bind(f.store));
	const factoryOptions = {
		config,
		csrfKey,
		limiter,
		store: {
			startAuthBrowserTransaction: start,
			readAuthBrowserTransactionActivity: vi.fn(
				f.store.readAuthBrowserTransactionActivity.bind(f.store),
			),
		},
		oidcOptions: { fetch: oidc.fetch },
	};
	const factory = await createCoordinatorBrowserLinkStart(factoryOptions);
	if (!factory.ok) throw new Error("Link start fixture failed");
	oidc.fetch.mockClear();
	return {
		...f,
		config,
		oidc,
		csrfKey,
		limiter,
		check,
		start,
		options: factoryOptions,
		handlers: factory.handlers,
		startCode,
		input,
		deviceRaw,
	};
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function rows(f: Fixture, table = TABLE) {
	return f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
}
function snapshot(f: Fixture) {
	return [TABLE, ATTEMPTS, "coordinator_auth_account_links", "coordinator_auth_sessions"].map(
		(table) => rows(f, table),
	);
}
function pageUrl(f: Fixture, code = f.startCode) {
	return `${URL_START}?attempt_id=${f.input.attemptId}&start_code=${code}`;
}
async function form(f: Fixture, cookie?: string, code = f.startCode) {
	const { response } = await f.handlers.linkStartPage(
		new Request(pageUrl(f, code), { headers: cookie ? { cookie } : {} }),
	);
	const body = await response.clone().text();
	const fields = Object.fromEntries(
		[...body.matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map((m) => [m[1], m[2]]),
	);
	return {
		response,
		body,
		fields,
		cookie: cookie ?? response.headers.getSetCookie()[0]?.split(";")[0] ?? "",
	};
}
type Form = Awaited<ReturnType<typeof form>>;
function post(c: Form, changes: { cookie?: string; body?: string; origin?: string } = {}) {
	return new Request(URL_START, {
		method: "POST",
		headers: {
			origin: changes.origin ?? ORIGIN,
			"content-type": "application/x-www-form-urlencoded",
			cookie: changes.cookie ?? c.cookie,
		},
		body: changes.body ?? new URLSearchParams(c.fields).toString(),
	});
}
async function rejected(response: Response, code: string, status?: number) {
	if (status !== undefined) expect(response.status).toBe(status);
	else expect(response.status).toBeGreaterThanOrEqual(400);
	expect(response.headers.getSetCookie()).toEqual([]);
	const body = await response.text();
	expect(body).not.toContain("<script");
	expect(body).not.toMatch(
		new RegExp(`${code}|fixture-secret|synthetic-private-failure|fixture-access-token`),
	);
}
function authorization(body: string) {
	const href = /href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/.exec(body)?.[1];
	if (!href) throw new Error("Missing provider continuation");
	return new URL(href.replaceAll("&amp;", "&"));
}

async function callbackAndConfirmationHandlers(f: Fixture) {
	const link = createCoordinatorBrowserLinkHandlers({
		config: f.config,
		csrfKey: f.csrfKey,
		limiter: f.limiter,
		store: f.store,
	});
	if (!link.ok) throw new Error("Link fixture failed");
	const callback = await createCoordinatorBrowserAuthCallback({
		config: f.config,
		store: f.store,
		completeLink: link.handlers.completeLink,
		oidcOptions: { fetch: f.oidc.fetch },
	});
	if (!callback.ok) throw new Error("Callback fixture failed");
	f.oidc.fetch.mockClear();
	return { link: link.handlers, callback: callback.handlers };
}
type ContinuationHandlers = Awaited<ReturnType<typeof callbackAndConfirmationHandlers>>;

async function showStartPage(f: Fixture) {
	const before = snapshot(f);
	const c = await form(f);
	expect(c.response.status).toBe(200);
	expect(c.fields).toEqual({
		csrf: expect.any(String),
		attempt_id: f.input.attemptId,
		start_code: f.startCode,
	});
	expect(c.body).toContain('action="/auth/link/start"');
	expect(c.response.headers.get("cache-control")).toBe("no-store");
	expect(c.response.headers.get("referrer-policy")).toBe("same-origin");
	expect(c.response.headers.get("content-security-policy")).toContain("default-src 'none'");
	expect(c.response.headers.get("content-security-policy")).toContain("form-action 'self'");
	expect(snapshot(f)).toEqual(before);
	expect(f.start).not.toHaveBeenCalled();
	expect(f.oidc.fetch).not.toHaveBeenCalled();
	return c;
}

async function checkAdmission(f: Fixture, c: Form) {
	const { response } = await f.handlers.linkStart(post(c), "client-a");
	const body = await response.text();
	const url = authorization(body);
	const original = rows(f)[0];
	const rawBinder = Buffer.from(c.cookie.split("=")[1], "base64url");
	const transactionCookie = response.headers.getSetCookie()[0].split(";")[0];
	expect(response.status).toBe(200);
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("location")).toBeNull();
	expect(rows(f)).toHaveLength(1);
	expect(original).toMatchObject({
		purpose: "link",
		attempt_id: f.input.attemptId,
		state: "pending",
		binder_hash: hash(rawBinder),
		state_hash: hash(url.searchParams.get("state") ?? ""),
		nonce: url.searchParams.get("nonce"),
	});
	expect(original.binder_hash).not.toBe(hash(c.cookie.split("=")[1]));
	expect(await challenge(String(original.pkce_verifier))).toBe(
		url.searchParams.get("code_challenge"),
	);
	expect(response.headers.getSetCookie()).toEqual([
		`${BROWSER_COOKIE_NAMES.transaction}=${c.cookie.split("=")[1]}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`,
		clearBrowserCookie("start"),
	]);
	expect(rows(f, ATTEMPTS)[0].state).toBe("browser_claimed");
	expect(body).not.toContain(f.startCode);
	expect(body).not.toContain(String(original.pkce_verifier));
	expect(url.searchParams.has("start_code")).toBe(false);
	expect(f.oidc.fetch).not.toHaveBeenCalled();
	return { url, transactionCookie };
}
type Admission = Awaited<ReturnType<typeof checkAdmission>>;

async function callbackAndConfirmation(
	f: Fixture,
	handlers: ContinuationHandlers,
	{ url, transactionCookie }: Admission,
) {
	const completed = await handlers.callback.callback(
		new Request(f.oidc.authorize(url), { headers: { cookie: transactionCookie } }),
	);
	const confirmation = await completed.response.text();
	expect(confirmation).not.toMatch(/<script\b|http-equiv=["']refresh/i);
	const csrf = /name="csrf" value="([^"]+)"/.exec(confirmation)?.[1] ?? "";
	const confirmed = await handlers.link.confirm(
		new Request(`${ORIGIN}/auth/link/confirm`, {
			method: "POST",
			headers: {
				origin: ORIGIN,
				cookie: transactionCookie,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ csrf, attempt_id: f.input.attemptId }),
		}),
		"client-a",
	);
	const hop = await confirmed.response.text();
	const href = /href="(http:[^"]+)"/.exec(hop)?.[1]?.replaceAll("&amp;", "&") ?? "";
	const completion = new URL(href).searchParams.get("completion") ?? "";
	expect(completed.outcome).toBe("link_dispatched");
	expect(confirmed.response.status).toBe(200);
	expect(rows(f)[0]).toMatchObject({ state: "consumed", nonce: null, pkce_verifier: null });
	expect(rows(f, ATTEMPTS)[0].state).toBe("confirmed");
	expect(rows(f, "coordinator_auth_account_links")).toEqual([]);
	return completion;
}

async function deviceFinalization(f: Fixture, completion: string) {
	const finalInput = finalize({
		runtimeVerifierHash: hash(f.deviceRaw),
		completionSecretHash: hash(Buffer.from(completion, "base64url")),
	});
	expect(
		await f.store.finalizeAuthLinkAttempt(
			{ ...finalInput, runtimeVerifierHash: hash(randomBytes(32)) },
			f.config,
		),
	).toMatchObject({ kind: "rejected" });
	expect(await f.store.finalizeAuthLinkAttempt(finalInput, f.config)).toMatchObject({
		kind: "applied",
	});
}

describe.each(["SQLite", "D1"] as const)("%s link-start URL length admission", (backend) => {
	it.each(["GET", "POST"])("rejects oversized %s URLs before parsing", async (method) => {
		// Arrange: construct the native Request before observing handler-owned URL parsing.
		const f = await setup(backend);
		const c = await form(f);
		const prefix = `${pageUrl(f)}&extra=`;
		const oversized = prefix + "x".repeat(8193 - prefix.length);
		const request = new Request(oversized, {
			method,
			headers: {
				origin: ORIGIN,
				cookie: c.cookie,
				"content-type": "application/x-www-form-urlencoded",
			},
			...(method === "POST" ? { body: new URLSearchParams(c.fields) } : {}),
		});
		const before = snapshot(f);
		const fullSnapshot = vi.spyOn(browserRequest, "snapshotBrowserRequest");
		const NativeURL = globalThis.URL;
		let oversizedParses = 0;
		globalThis.URL = class extends NativeURL {
			constructor(input: string | URL, base?: string | URL) {
				if (input === oversized) oversizedParses++;
				super(input, base);
			}
		};
		try {
			// Act
			const { response, outcome } =
				method === "GET"
					? await f.handlers.linkStartPage(request)
					: await f.handlers.linkStart(request, "client-a");
			// Assert: a 400 alone would not prove the parser never received the oversized input.
			expect(oversizedParses).toBe(0);
			expect(fullSnapshot).not.toHaveBeenCalled();
			expect(outcome).toBe("form_invalid");
			await rejected(response, f.startCode, 400);
			expect(snapshot(f)).toEqual(before);
			expect(f.start).not.toHaveBeenCalled();
			expect(f.check).not.toHaveBeenCalled();
			expect(f.oidc.fetch).not.toHaveBeenCalled();
		} finally {
			globalThis.URL = NativeURL;
			fullSnapshot.mockRestore();
		}
	});
});

describe.each(["SQLite", "D1"] as const)("%s protected unmounted link start", (backend) => {
	it("GET renders three fields without claiming; POST promotes the same raw binder and feeds the existing SDK callback/confirmation", async () => {
		const f = await setup(backend);
		const handlers = await callbackAndConfirmationHandlers(f);
		const c = await showStartPage(f);
		const admitted = await checkAdmission(f, c);
		const completion = await callbackAndConfirmation(f, handlers, admitted);
		await deviceFinalization(f, completion);
	});
});

describe.each(["SQLite", "D1"] as const)("%s protected admission failures", (backend) => {
	it.each(["wrong", "missing-attempt", "legacy"])(
		"rejects %s proof without orphan OIDC rows or unrelated changes",
		async (fault) => {
			// Arrange
			const f = await setup(backend, { legacy: fault === "legacy" });
			expect(
				await f.store.createAuthLinkAttempt(
					attempt({
						attemptId: "unrelated",
						runtimeVerifierHash: hash(randomBytes(32)),
						browserStartHash: hash(randomBytes(32)),
					}),
					f.config,
				),
			).toMatchObject({ kind: "created" });
			const c = await form(
				f,
				undefined,
				fault === "wrong" ? randomBytes(32).toString("base64url") : f.startCode,
			);
			if (fault === "missing-attempt") c.fields.attempt_id = "missing-attempt";
			const before = snapshot(f);
			// Act
			const { response } = await f.handlers.linkStart(post(c), "client-a");
			// Assert
			await rejected(response, c.fields.start_code);
			expect(snapshot(f)).toEqual(before);
			expect(rows(f, ATTEMPTS).every((row) => row.state === "pending")).toBe(true);
			expect(f.oidc.fetch).not.toHaveBeenCalled();
		},
	);
	it.each(["same", "different"])(
		"two %s-browser POSTs have one winner; lost response never rotates the claim",
		async (binder) => {
			// Arrange
			const f = await setup(backend);
			const c = await form(f);
			const other = binder === "same" ? c : await form(f);
			// Act
			const responses = await Promise.all([
				f.handlers.linkStart(post(c), "client-a"),
				f.handlers.linkStart(post(other), "client-b"),
			]);
			const saved = snapshot(f);
			const replay = await f.handlers.linkStart(post(c), "client-a");
			// Assert
			expect(responses.map((r) => r.response.status).sort()).toEqual([200, 409]);
			expect(rows(f)).toHaveLength(1);
			expect(rows(f)[0].nonce).toBeTruthy();
			expect(rows(f)[0].pkce_verifier).toBeTruthy();
			await rejected(replay.response, f.startCode, 409);
			expect(snapshot(f)).toEqual(saved);
			for (const r of responses)
				expect(r.response.headers.getSetCookie()).toHaveLength(r.response.status === 200 ? 2 : 0);
		},
	);
});

describe("automatic protected browser start", () => {
	it("auto-submits only the existing protected start form with an exact CSP hash and manual fallback", async () => {
		// Arrange: JSDOM never loads provider URLs; submission is intercepted locally.
		const f = await setup();
		const c = await form(f);
		const dom = new JSDOM(c.body, { url: pageUrl(f), runScripts: "outside-only" });
		const document = dom.window.document;
		const submit = vi
			.spyOn(dom.window.HTMLFormElement.prototype, "requestSubmit")
			.mockImplementation(() => {});
		const directSubmit = vi
			.spyOn(dom.window.HTMLFormElement.prototype, "submit")
			.mockImplementation(() => {});
		const scripts = [...document.querySelectorAll("script")];
		// Act
		for (const script of scripts) dom.window.eval(script.textContent ?? "");
		// Assert: private fields remain form values, not script data or GET redirects.
		expect(scripts).toHaveLength(1);
		const script = scripts[0].textContent ?? "";
		const digest = createHash("sha256").update(script).digest("base64");
		const csp = c.response.headers.get("content-security-policy") ?? "";
		expect(
			csp
				.split(";")
				.find((part) => part.trim().startsWith("script-src "))
				?.trim(),
		).toBe(`script-src 'sha256-${digest}'`);
		expect(csp).not.toContain("unsafe-inline");
		expect(submit.mock.calls.length + directSubmit.mock.calls.length).toBe(1);
		const submitted = submit.mock.contexts[0] ?? directSubmit.mock.contexts[0];
		expect(submitted).toBe(document.querySelector("form"));
		expect(document.querySelector("form")?.getAttribute("action")).toBe("/auth/link/start");
		expect(document.querySelector("button[type='submit']")?.textContent).toMatch(
			/link|continue|Google/i,
		);
		expect(document.querySelector("meta[http-equiv='refresh']")).toBeNull();
		expect(script).not.toContain(f.startCode);
		expect(script).not.toContain(c.fields.csrf);
		expect(c.response.headers.get("referrer-policy")).toBe("same-origin");
		expect(f.start).not.toHaveBeenCalled();
		dom.window.close();
	});
});

describe("browser page and transport boundaries", () => {
	it("reuses START and preserves SESSION without account redirect; refuses existing TXN", async () => {
		// Arrange
		const f = await setup();
		f.options.store.readAuthBrowserTransactionActivity.mockResolvedValue({ kind: "active" });
		const c = await form(f);
		const session = await issueBrowserCookie("session");
		const cookie = `${c.cookie}; ${session.setCookie.split(";")[0]}`;
		const txn = await issueBrowserCookie("transaction");
		const before = snapshot(f);
		// Act
		const reused = await form(f, cookie);
		const blocked = await form(f, `${cookie}; ${txn.setCookie.split(";")[0]}`);
		const blockedPost = await f.handlers.linkStart(
			post(c, { cookie: `${cookie}; ${txn.setCookie.split(";")[0]}` }),
			"client-a",
		);
		// Assert
		expect(reused.response.status).toBe(200);
		expect(reused.response.headers.get("location")).toBeNull();
		expect(reused.response.headers.getSetCookie()).toEqual([]);
		await rejected(blocked.response, f.startCode, 409);
		await rejected(blockedPost.response, f.startCode, 409);
		expect(snapshot(f)).toEqual(before);
		// Act: a SESSION is not a reason to bypass device linking or replace that session.
		const started = await f.handlers.linkStart(post(c, { cookie }), "client-a");
		// Assert
		expect(started.response.status).toBe(200);
		expect(started.response.headers.get("location")).toBeNull();
		expect(
			started.response.headers
				.getSetCookie()
				.some((value) => value.startsWith(`${BROWSER_COOKIE_NAMES.session}=`)),
		).toBe(false);
	});
	it.each([
		"missing-code",
		"duplicate",
		"encoded-duplicate",
		"extra",
		"short",
		"padded",
		"noncanonical",
	])("GET rejects %s query without claiming or setting cookies", async (fault) => {
		// Arrange
		const f = await setup();
		const queries = {
			"missing-code": `attempt_id=${f.input.attemptId}`,
			duplicate: `attempt_id=${f.input.attemptId}&start_code=${f.startCode}&start_code=${f.startCode}`,
			"encoded-duplicate": `attempt_id=${f.input.attemptId}&start_code=${f.startCode}&%73tart_code=${f.startCode}`,
			extra: `attempt_id=${f.input.attemptId}&start_code=${f.startCode}&x=1`,
			short: `attempt_id=${f.input.attemptId}&start_code=${"A".repeat(42)}`,
			padded: `attempt_id=${f.input.attemptId}&start_code=${f.startCode}=`,
			noncanonical: `attempt_id=${f.input.attemptId}&start_code=${"A".repeat(42)}B`,
		};
		const before = snapshot(f);
		// Act
		const { response } = await f.handlers.linkStartPage(
			new Request(`${URL_START}?${queries[fault as keyof typeof queries]}`),
		);
		// Assert
		await rejected(response, f.startCode);
		expect(snapshot(f)).toEqual(before);
		expect(f.start).not.toHaveBeenCalled();
		expect(f.oidc.fetch).not.toHaveBeenCalled();
	});
	it.each([
		"duplicate",
		"encoded-duplicate",
		"missing-code",
		"short-code",
		"csrf",
		"missing-cookie",
		"origin",
	])("POST rejects %s before mutation", async (fault) => {
		// Arrange
		const f = await setup();
		const c = await form(f);
		const body = new URLSearchParams(c.fields).toString();
		const changes = {
			duplicate: { body: `${body}&start_code=${f.startCode}` },
			"encoded-duplicate": { body: `${body}&%73tart_code=${f.startCode}` },
			"missing-code": { body: `csrf=${c.fields.csrf}&attempt_id=${f.input.attemptId}` },
			"short-code": { body: body.replace(f.startCode, "A".repeat(42)) },
			csrf: { body: body.replace(c.fields.csrf, "A".repeat(86)) },
			"missing-cookie": { cookie: "" },
			origin: { origin: "https://other.example.test" },
		};
		const request = post(c, changes[fault as keyof typeof changes]);
		const before = snapshot(f);
		// Act
		const { response } = await f.handlers.linkStart(request, "client-a");
		// Assert
		await rejected(response, f.startCode);
		expect(snapshot(f)).toEqual(before);
		expect(f.start).not.toHaveBeenCalled();
		expect(f.oidc.fetch).not.toHaveBeenCalled();
		if (fault === "origin") {
			expect(request.bodyUsed).toBe(false);
			expect(f.check).not.toHaveBeenCalled();
		}
	});
});

describe("shared quota and durable failure", () => {
	it("shares the pinned twenty-request browser-form bucket with sign-in", async () => {
		// Arrange
		const f = await setup();
		const c = await form(f);
		const signin = await createCoordinatorBrowserSigninStart({ ...f.options, store: f.store });
		if (!signin.ok) throw new Error("Signin fixture failed");
		const before = snapshot(f);
		// Act: invalid sign-in CSRF still consumes the same client's admission quota.
		for (let i = 0; i < 20; i++)
			await signin.handlers.signInStart(
				new Request(`${ORIGIN}/auth/sign-in`, {
					method: "POST",
					headers: {
						origin: ORIGIN,
						cookie: c.cookie,
						"content-type": "application/x-www-form-urlencoded",
					},
					body: "csrf=bad",
				}),
				"client-a",
			);
		const { response } = await f.handlers.linkStart(post(c), "client-a");
		// Assert
		await rejected(response, f.startCode, 429);
		expect(f.check).toHaveBeenLastCalledWith(
			JSON.stringify(["browser-form", "coordinator-a", "client-a"]),
			20,
		);
		expect(snapshot(f)).toEqual(before);
	});
	it.each(["database", "provider"])(
		"%s failure returns generic 503 without clearing START",
		async (fault) => {
			// Arrange
			const f = await setup();
			const c = await form(f);
			const before = snapshot(f);
			if (fault === "database")
				f.start.mockRejectedValueOnce(new Error(`synthetic-private-failure ${f.startCode}`));
			else
				vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
					throw new Error(`synthetic-private-failure ${f.startCode}`);
				});
			// Act
			const { response } = await f.handlers.linkStart(post(c), "client-a");
			// Assert
			await rejected(response, f.startCode, 503);
			expect(snapshot(f)).toEqual(before);
			expect(f.oidc.fetch).not.toHaveBeenCalled();
			if (fault === "provider") expect(f.start).not.toHaveBeenCalled();
		},
	);
});

async function restartHandlers(f: Fixture) {
	const options = { ...f.options, store: f.store };
	const link = await createCoordinatorBrowserLinkStart(options);
	const signin = await createCoordinatorBrowserSigninStart(options);
	if (!link.ok || !signin.ok) throw new Error("Restart handlers unavailable");
	f.oidc.fetch.mockClear();
	return { link: link.handlers, signin: signin.handlers };
}

async function linkStage(
	f: Fixture,
	stage:
		| "browser_claimed"
		| "oidc_verified"
		| "confirmed"
		| "finalized"
		| "signin"
		| "owner_enroll",
) {
	const handlers = await restartHandlers(f);
	f.handlers = handlers.link;
	if (stage === "signin" || stage === "owner_enroll") {
		const issued = await issueBrowserCookie("transaction");
		expect(
			await f.store.startAuthBrowserTransaction(
				{
					purpose: "signin",
					binderHash: issued.cookieHash,
					stateHash: hash(randomBytes(32)),
					nonce: "n".repeat(43),
					pkceVerifier: "p".repeat(43),
				},
				f.config,
			),
		).toMatchObject({ kind: "started" });
		// Owner enrollment uses the same native transaction schema and must also block restart.
		if (stage === "owner_enroll")
			f.db.prepare(`UPDATE ${TABLE} SET purpose='owner_enroll', attempt_id='owner-attempt'`).run();
		return { ...handlers, cookie: issued.setCookie.split(";")[0] };
	}
	const admitted = await checkAdmission(f, await form(f));
	const row = rows(f)[0];
	const browser = {
		attemptId: f.input.attemptId,
		browserTransactionHash: String(row.browser_transaction_hash),
	};
	if (stage !== "browser_claimed") {
		expect(
			await f.store.consumeAuthBrowserTransaction(
				{ stateHash: String(row.state_hash), binderHash: String(row.binder_hash) },
				f.config,
			),
		).toMatchObject({ kind: "consumed" });
		expect(
			await f.store.recordAuthLinkOidcVerified(
				{ ...browser, account: { issuer: f.config.issuer, subject: "synthetic-restart-subject" } },
				f.config,
			),
		).toMatchObject({ kind: "applied" });
	}
	if (stage === "confirmed" || stage === "finalized") {
		expect(
			await f.store.confirmAuthLinkAttempt(
				{ ...browser, completionSecretHash: "e".repeat(64) },
				f.config,
			),
		).toMatchObject({ kind: "applied" });
	}
	if (stage === "finalized") {
		expect(
			await f.store.finalizeAuthLinkAttempt(
				finalize({ runtimeVerifierHash: hash(f.deviceRaw), completionSecretHash: "e".repeat(64) }),
				f.config,
			),
		).toMatchObject({ kind: "applied" });
	}
	return { ...handlers, cookie: admitted.transactionCookie };
}

describe.each(["SQLite", "D1"] as const)("%s overlapping inactive start pages", (backend) => {
	it.each(["link", "signin"] as const)(
		"a delayed inactive %s GET cannot erase a fresh POST transaction",
		async (kind) => {
			// Arrange: both GETs carry an old, missing transaction; the first supplies START.
			const f = await setup(backend);
			const options = {
				...f.options,
				store: {
					...f.options.store,
					readAuthSession: f.store.readAuthSession.bind(f.store),
				},
			};
			const signin = await createCoordinatorBrowserSigninStart(options);
			if (!signin.ok) throw new Error("Signin fixture failed");
			f.oidc.fetch.mockClear();
			const url = kind === "link" ? pageUrl(f) : `${ORIGIN}/auth/sign-in`;
			const getPage = (cookie: string) => {
				const request = new Request(url, { headers: { cookie } });
				return kind === "link"
					? f.handlers.linkStartPage(request)
					: signin.handlers.signInPage(request);
			};
			const old = await issueBrowserCookie("transaction");
			const oldCookie = old.setCookie.split(";")[0];
			const first = await getPage(oldCookie);
			const fields = Object.fromEntries(
				[...(await first.response.text()).matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map(
					(m) => [m[1], m[2]],
				),
			);
			const start = first.response.headers
				.getSetCookie()
				.find((value) => value.startsWith(`${BROWSER_COOKIE_NAMES.start}=`))
				?.split(";")[0];
			expect(first.response.status).toBe(200);
			expect(start).toBeTruthy();
			const cookie = `${start}; ${oldCookie}`;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			f.options.store.readAuthBrowserTransactionActivity.mockImplementationOnce(async (...args) => {
				const inactive = await f.store.readAuthBrowserTransactionActivity(...args);
				entered.resolve();
				await release.promise;
				return inactive;
			});
			const before = snapshot(f);
			// Act: hold the second GET's inactive snapshot until POST has issued a new TXN.
			const delayed = getPage(cookie);
			await entered.promise;
			let admitted: Awaited<typeof delayed>;
			try {
				const request = new Request(kind === "link" ? URL_START : url, {
					method: "POST",
					headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams(fields),
				});
				admitted =
					kind === "link"
						? await f.handlers.linkStart(request, "overlap")
						: await signin.handlers.signInStart(request, "overlap");
			} finally {
				release.resolve();
			}
			const saved = snapshot(f);
			const late = await delayed;
			const provider = authorization(await admitted.response.text());
			const freshCookie = admitted.response.headers.getSetCookie()[0].split(";")[0];
			const binderHash = hash(Buffer.from(freshCookie.split("=")[1], "base64url"));
			// Assert: arriving last cannot delete or replace the POST cookie or mutate authority.
			expect(admitted.response.status).toBe(200);
			expect(freshCookie).toBe(`${BROWSER_COOKIE_NAMES.transaction}=${start?.split("=")[1]}`);
			expect(late.response.status).toBe(200);
			expect(late.response.headers.getSetCookie()).toEqual([]);
			expect(snapshot(f)).toEqual(saved);
			expect(saved.slice(2)).toEqual(before.slice(2));
			if (kind === "link")
				expect(
					await f.store.resolveAuthLinkBrowserTransaction(
						{ binderHash, attemptId: f.input.attemptId },
						f.config,
					),
				).toEqual({ browserTransactionHash: rows(f)[0].browser_transaction_hash });
			expect(
				await f.store.consumeAuthBrowserTransaction(
					{ binderHash, stateHash: hash(provider.searchParams.get("state") ?? "") },
					f.config,
				),
			).toMatchObject({ kind: "consumed", purpose: kind });
			expect(f.oidc.fetch).not.toHaveBeenCalled();
		},
	);
});

describe.each(["SQLite", "D1"] as const)("%s terminal browser-cookie restart", (backend) => {
	it.each(["link", "signin"] as const)(
		"allows %s GET and protected POST after finalization without session redemption",
		async (kind) => {
			// Arrange: device proof finalized the prior link, but its browser still holds TXN.
			const f = await setup(backend);
			const handlers = await linkStage(f, "finalized");
			expect(rows(f, "coordinator_auth_sessions")).toEqual([]);
			const raw = randomBytes(32);
			f.startCode = raw.toString("base64url");
			f.input = attempt({
				attemptId: "attempt-next",
				runtimeVerifierHash: hash(randomBytes(32)),
				browserStartHash: hash(raw),
			});
			expect(await f.store.createAuthLinkAttempt(f.input, f.config)).toMatchObject({
				kind: "created",
			});
			const before = snapshot(f);
			// Act: GET replaces no authority; POST independently rechecks a lingering old TXN.
			const url = kind === "link" ? pageUrl(f) : `${ORIGIN}/auth/sign-in`;
			const request = new Request(url, { headers: { cookie: handlers.cookie } });
			const page =
				kind === "link"
					? await handlers.link.linkStartPage(request)
					: await handlers.signin.signInPage(request);
			const body = await page.response.text();
			const fields = Object.fromEntries(
				[...body.matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map((m) => [m[1], m[2]]),
			);
			const cookies = page.response.headers.getSetCookie();
			const start = cookies
				.find((value) => value.startsWith(`${BROWSER_COOKIE_NAMES.start}=`))
				?.split(";")[0];
			// Assert: GET ignores the inactive cookie without changing browser transaction state.
			expect(page.response.status).toBe(200);
			expect(
				cookies.some((value) => value.startsWith(`${BROWSER_COOKIE_NAMES.transaction}=`)),
			).toBe(false);
			expect(start).toBeTruthy();
			expect(snapshot(f)).toEqual(before);
			const next = new Request(kind === "link" ? URL_START : `${ORIGIN}/auth/sign-in`, {
				method: "POST",
				headers: {
					origin: ORIGIN,
					cookie: `${start}; ${handlers.cookie}`,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams(fields),
			});
			const badProof = new Request(next.clone(), {
				body: new URLSearchParams({ ...fields, csrf: "A".repeat(86) }),
			});
			const denied =
				kind === "link"
					? await handlers.link.linkStart(badProof, "restart")
					: await handlers.signin.signInStart(badProof, "restart");
			await rejected(denied.response, f.startCode, 403);
			expect(snapshot(f)).toEqual(before);
			const result =
				kind === "link"
					? await handlers.link.linkStart(next, "restart")
					: await handlers.signin.signInStart(next, "restart");
			expect(result.response.status).toBe(200);
			expect(result.response.headers.getSetCookie()[0]).toContain(
				`${BROWSER_COOKIE_NAMES.transaction}=${start?.split("=")[1]};`,
			);
			expect(authorization(await result.response.text()).origin).toBe(f.config.issuer);
			expect(rows(f)).toHaveLength(2);
			expect(rows(f, "coordinator_auth_sessions")).toEqual([]);
			expect(f.oidc.fetch).not.toHaveBeenCalled();
		},
	);

	it.each(["browser_claimed", "oidc_verified", "confirmed", "signin", "owner_enroll"] as const)(
		"keeps %s ceremonies active in all four start handlers",
		async (stage) => {
			// Arrange: even a consumed callback remains active until device finalization.
			const f = await setup(backend);
			const handlers = await linkStage(f, stage);
			const c = await form(f);
			const before = snapshot(f);
			const cookie = `${c.cookie}; ${handlers.cookie}`;
			// Act: both GET and POST must refuse to overwrite an unfinished ceremony.
			const responses = await Promise.all([
				handlers.link.linkStartPage(new Request(pageUrl(f), { headers: { cookie } })),
				handlers.link.linkStart(post(c, { cookie }), "active"),
				handlers.signin.signInPage(new Request(`${ORIGIN}/auth/sign-in`, { headers: { cookie } })),
				handlers.signin.signInStart(
					new Request(`${ORIGIN}/auth/sign-in`, {
						method: "POST",
						headers: {
							origin: ORIGIN,
							cookie,
							"content-type": "application/x-www-form-urlencoded",
						},
						body: new URLSearchParams({ csrf: c.fields.csrf }),
					}),
					"active",
				),
			]);
			// Assert: active cookies and persisted authority survive unchanged.
			for (const { response } of responses) await rejected(response, f.startCode, 409);
			expect(snapshot(f)).toEqual(before);
			expect(f.oidc.fetch).not.toHaveBeenCalled();
		},
	);
});
