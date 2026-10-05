import { createHash, randomBytes } from "node:crypto";
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
		store: { startAuthBrowserTransaction: start },
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
	expect(await response.text()).not.toMatch(
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
			expect(outcome).toBe("form_invalid");
			await rejected(response, f.startCode, 400);
			expect(snapshot(f)).toEqual(before);
			expect(f.start).not.toHaveBeenCalled();
			expect(f.check).not.toHaveBeenCalled();
			expect(f.oidc.fetch).not.toHaveBeenCalled();
		} finally {
			globalThis.URL = NativeURL;
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

describe("browser page and transport boundaries", () => {
	it("reuses START and preserves SESSION without account redirect; refuses existing TXN", async () => {
		// Arrange
		const f = await setup();
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
