import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import { attempt, authorize, finalize, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { SESSION_TTL } from "./coordinator-auth-session-test-fixtures.js";
import { type Backend, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { createCoordinatorBrowserAuthCallback } from "./coordinator-browser-auth-callback.js";
import {
	BROWSER_COOKIE_NAMES,
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
} from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey, verifyBrowserCsrfToken } from "./coordinator-browser-csrf.js";
import { createCoordinatorBrowserLinkHandlers } from "./coordinator-browser-link.js";
import { createCoordinatorBrowserLinkCompletionHandlers } from "./coordinator-browser-link-completion.js";
import { createCoordinatorOidcClient } from "./coordinator-oidc.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

const ORIGIN = "https://app.example.test";
const databases: ReturnType<typeof setupStore>["db"][] = [];
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

async function existingSessionFixture(
	f: ReturnType<typeof setupStore>,
	config: CoordinatorAuthBrowserConfig,
) {
	// Independent reviewed store link; never fabricate the live session returned by persistence.
	const browser = { attemptId: "independent-attempt", browserTransactionHash: "c".repeat(64) };
	const account = { issuer: config.issuer, subject: "opaque-subject-a" };
	const created = attempt({ attemptId: browser.attemptId, runtimeVerifierHash: "9".repeat(64) });
	expect(await f.store.createAuthLinkAttempt(created, config)).toMatchObject({ kind: "created" });
	expect(await f.store.claimAuthLinkAttempt(browser, config)).toMatchObject({ kind: "applied" });
	expect(await f.store.recordAuthLinkOidcVerified({ ...browser, account }, config)).toMatchObject({
		kind: "applied",
	});
	expect(
		await f.store.confirmAuthLinkAttempt(
			{ ...browser, completionSecretHash: "d".repeat(64) },
			config,
		),
	).toMatchObject({ kind: "applied" });
	const proof = finalize({
		attemptId: browser.attemptId,
		runtimeVerifierHash: created.runtimeVerifierHash,
	});
	expect(await f.store.finalizeAuthLinkAttempt(proof, config)).toMatchObject({ kind: "applied" });
	const issued = await issueBrowserCookie("session");
	const signin = {
		credentialHash: issued.cookieHash,
		browserTransactionHash: "f".repeat(64),
		account,
	};
	expect(await f.store.signInWithAuthAccount(signin, config)).toMatchObject({ kind: "issued" });
	return issued.setCookie.split(";")[0];
}

async function setup(backend: Backend = "SQLite", options: { existingSession?: boolean } = {}) {
	const clock = { now: NOW };
	const f = setupStore(backend, { authClock: () => clock.now });
	databases.push(f.db);
	const config = Object.freeze({
		enabled: true,
		coordinatorId: "coordinator-a",
		issuer: "https://accounts.google.com",
		revision: "a".repeat(64),
		redirectUri: PROVIDER.redirectUri,
	});
	await authorize({ ...f, now: NOW, cfg: config });
	let existingSession = "";
	if (options.existingSession) {
		existingSession = await existingSessionFixture(f, config);
	}
	expect(
		await f.store.createAuthLinkAttempt(
			attempt({ loopbackRedirect: "http://127.0.0.1:80/codemem/auth/complete" }),
			config,
		),
	).toMatchObject({ kind: "created" });
	const oidc = oidcFixture({ issuer: config.issuer });
	oidc.claims.sub = "opaque-subject-a";
	oidc.claims.roles = ["administrator"];
	const rawConfig = { ...config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret };
	const client = await createCoordinatorOidcClient(rawConfig, { fetch: oidc.fetch });
	if (!client.ok) throw new Error("SDK setup failed");
	const authorization = await client.client.createAuthorizationRequest();
	const cookie = await issueBrowserCookie("transaction");
	const header = cookie.setCookie.split(";")[0];
	const parsed = await readBrowserCookie(header, "transaction");
	if (parsed.kind !== "present") throw new Error("Cookie setup failed");
	expect(
		await f.store.startAuthBrowserTransaction(
			{
				purpose: "link",
				attemptId: "attempt-a",
				stateHash: createHash("sha256").update(authorization.material.state).digest("hex"),
				binderHash: parsed.cookieHash,
				nonce: authorization.material.nonce,
				pkceVerifier: authorization.material.pkceVerifier,
			},
			config,
		),
	).toMatchObject({ kind: "started" });
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const limiter = createInMemoryRequestRateLimiter({ now: () => clock.now });
	const check = vi.spyOn(limiter, "check");
	const operations = {
		resolveAuthLinkBrowserTransaction: vi.fn(
			f.store.resolveAuthLinkBrowserTransaction.bind(f.store),
		),
		getAuthLinkAttemptStatus: vi.fn(f.store.getAuthLinkAttemptStatus.bind(f.store)),
		readAuthSession: vi.fn(f.store.readAuthSession.bind(f.store)),
		redeemAuthLinkSessionWithBrowserTransaction: vi.fn(
			f.store.redeemAuthLinkSessionWithBrowserTransaction.bind(f.store),
		),
	};
	const forbidden = vi.fn(() => {
		throw new Error("legacy/profile forbidden");
	});
	const store = Object.defineProperties(
		{ ...operations },
		{
			redeemAuthLinkSession: { get: forbidden },
			recordAuthAccountProfile: { get: forbidden },
		},
	);
	const input = { config, csrfKey, limiter, store };
	const discoveryCalls = oidc.fetch.mock.calls.length;
	const completion = createCoordinatorBrowserLinkCompletionHandlers(input);
	if (!completion.ok) throw new Error("Completion setup failed");
	expect(oidc.fetch.mock.calls).toHaveLength(discoveryCalls);
	const link = createCoordinatorBrowserLinkHandlers({ config, csrfKey, limiter, store: f.store });
	if (!link.ok) throw new Error("Link setup failed");
	const callback = await createCoordinatorBrowserAuthCallback({
		config: rawConfig,
		store: f.store,
		completeLink: link.handlers.completeLink,
		oidcOptions: { fetch: oidc.fetch },
	});
	if (!callback.ok) throw new Error("Callback setup failed");
	const result = await callback.handlers.callback(
		new Request(oidc.authorize(new URL(authorization.authorizationUrl)), {
			headers: { cookie: header },
		}),
	);
	expect(result.outcome).toBe("link_dispatched");
	const confirmation = await result.response.text();
	const csrf = confirmation.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
	if (!csrf) throw new Error("Original confirmation form missing");
	return {
		...f,
		existingSession,
		clock,
		config,
		rawConfig,
		header,
		parsed,
		csrfKey,
		csrf,
		oidc,
		limiter,
		check,
		operations,
		forbidden,
		input,
		completion,
		handlers: completion.handlers,
		link: link.handlers,
	};
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function rows(f: Fixture, table = "coordinator_auth_link_attempts") {
	return f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
}
function authority(f: Fixture) {
	return [
		"coordinator_auth_account_links",
		"coordinator_auth_link_audit_log",
		"coordinator_auth_sessions",
		"coordinator_auth_session_receipts",
		"coordinator_auth_account_profiles",
		"groups",
		"enrolled_devices",
		"coordinator_bootstrap_grants",
	].map((table) => [table, rows(f, table)]);
}
function get(f: Fixture, suffix = "?attempt_id=attempt-a", cookie = f.header) {
	return new Request(`${ORIGIN}/auth/link/complete${suffix}`, { headers: { cookie } });
}
function post(
	f: Fixture,
	changes: Record<string, string> = {},
	cookie = f.header,
	action = "complete",
) {
	return new Request(`${ORIGIN}/auth/link/${action}`, {
		method: "POST",
		headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ csrf: f.csrf, attempt_id: "attempt-a", ...changes }),
	});
}
async function confirm(f: Fixture) {
	const confirmed = await f.link.confirm(post(f, {}, f.header, "confirm"), "trusted-client");
	expect(confirmed.response.status).toBe(200);
	const hop = await confirmed.response.text();
	const href = hop.match(/<a\b[^>]*href="([^"]+)"/)?.[1].replaceAll("&amp;", "&");
	if (!href) throw new Error("Private hop missing");
	const secret = new URL(href).searchParams.get("completion") ?? "";
	expect(Buffer.from(secret, "base64url")).toHaveLength(32);
	return createHash("sha256").update(Buffer.from(secret, "base64url")).digest("hex");
}
async function ready(f: Fixture) {
	const hash = await confirm(f);
	// Reviewed authenticated-signer metadata simulation; not HTTP signature validation.
	expect(
		await f.store.finalizeAuthLinkAttempt(finalize({ completionSecretHash: hash }), f.config),
	).toMatchObject({ kind: "applied" });
}
async function safe(response: Response, status: number) {
	expect(response.status).toBe(status);
	expect(response.headers.getSetCookie()).toEqual([]);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.clone().text()).not.toMatch(
		/privateCause|Fixture User|user@example.test|fixture-secret/,
	);
}

describe.each(["SQLite", "D1"] as const)("%s browser completion", (backend) => {
	it("dogfoods Google callback, explicit confirmation, device proofs and bound eight-hour SESSION", async () => {
		// Arrange
		const f = await setup(backend);
		const before = authority(f);
		expect(rows(f, "coordinator_auth_account_links")).toEqual([]);
		const hash = await confirm(f);
		expect(rows(f)[0]).toMatchObject({ state: "confirmed", completion_secret_hash: hash });
		// Act: before finalization the browser gets a passive waiting page, not authority.
		const waiting = await f.handlers.page(get(f));
		const early = await f.handlers.complete(post(f), "trusted-client");
		// Assert
		expect(waiting.response.status).toBe(200);
		expect(await waiting.response.text()).not.toMatch(/<form|<script|http-equiv="refresh"/);
		expect(waiting.response.headers.getSetCookie()).toEqual([]);
		await safe(early.response, 403);
		expect(authority(f)).toEqual(before);
		for (const overrides of [
			{ completionSecretHash: "e".repeat(64) },
			{ runtimeVerifierHash: "e".repeat(64) },
		])
			expect(
				await f.store.finalizeAuthLinkAttempt(
					finalize({ completionSecretHash: hash, ...overrides }),
					f.config,
				),
			).toMatchObject({ kind: "rejected" });
		expect(authority(f)).toEqual(before);
		expect(
			await f.store.finalizeAuthLinkAttempt(finalize({ completionSecretHash: hash }), f.config),
		).toMatchObject({ kind: "applied" });
		const finalized = authority(f);
		// Act: the original browser receives a genuine MAC, but GET still writes nothing.
		const page = await f.handlers.page(get(f));
		const body = await page.response.text();
		const csrf = body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
		// Assert
		expect(Object.isFrozen(f.completion)).toBe(true);
		expect(Object.isFrozen(f.handlers)).toBe(true);
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
		expect(body).toContain('action="/auth/link/complete"');
		expect(body).not.toMatch(/Fixture User|user@example.test|opaque-subject-a|completion=/);
		expect(authority(f)).toEqual(finalized);
		expect(page.response.headers.getSetCookie()).toEqual([]);
		// Act: only a returned issued result permits cookie delivery.
		const completed = await f.handlers.complete(post(f, { csrf: csrf ?? "" }), "trusted-client");
		// Assert
		expect(completed.response.status).toBe(303);
		expect(completed.response.headers.get("location")).toBe(`${ORIGIN}/auth/account`);
		const cookies = completed.response.headers.getSetCookie();
		expect(cookies).toHaveLength(2);
		expect(cookies).toContain(clearBrowserCookie("transaction"));
		const session = await readBrowserCookie(
			cookies.find((value) => value !== clearBrowserCookie("transaction"))?.split(";")[0] ?? "",
			"session",
		);
		if (session.kind !== "present") throw new Error("Issued SESSION missing");
		expect(rows(f, "coordinator_auth_sessions")[0]).toMatchObject({
			credential_hash: session.cookieHash,
			created_at_ms: NOW,
			expires_at_ms: NOW + SESSION_TTL,
		});
		expect(rows(f, "coordinator_auth_session_receipts")[0]).toMatchObject({
			source: "link_redeem",
			purge_eligible: 0,
		});
		expect(rows(f)[0].state).toBe("session_redeemed");
		expect(rows(f, "coordinator_auth_account_profiles")).toEqual([]);
		expect(authority(f).slice(5)).toEqual(before.slice(5));
		expect(f.forbidden).not.toHaveBeenCalled();
		const replay = await f.handlers.complete(post(f), "trusted-client");
		await safe(replay.response, 403);
	});
});

describe.each(["SQLite", "D1"] as const)("%s returning browser SESSION", (backend) => {
	it("replaces a canonical stale SESSION only after real live-read and bound redemption", async () => {
		// Arrange: a returning browser holds a valid bearer with no persisted session row.
		const f = await setup(backend);
		await ready(f);
		const stale = await issueBrowserCookie("session");
		const staleHeader = stale.setCookie.split(";")[0];
		const before = authority(f);
		expect(rows(f, "coordinator_auth_sessions")).toEqual([]);
		// Act
		const result = await f.handlers.complete(
			post(f, {}, `${f.header}; ${staleHeader}`),
			"trusted-client",
		);
		// Assert: the actual store read returns null; only a new issued result delivers cookies.
		expect(f.operations.readAuthSession).toHaveBeenCalledExactlyOnceWith(
			stale.cookieHash,
			f.config,
		);
		expect(await f.operations.readAuthSession.mock.results[0].value).toBeNull();
		expect(f.operations.redeemAuthLinkSessionWithBrowserTransaction).toHaveBeenCalledTimes(1);
		expect(result.response.status).toBe(303);
		expect(result.response.headers.get("location")).toBe(`${ORIGIN}/auth/account`);
		const cookies = result.response.headers.getSetCookie();
		expect(cookies).toHaveLength(2);
		expect(cookies).toContain(clearBrowserCookie("transaction"));
		const freshHeader =
			cookies.find((cookie) => cookie !== clearBrowserCookie("transaction"))?.split(";")[0] ?? "";
		expect(freshHeader).not.toBe(staleHeader);
		const fresh = await readBrowserCookie(freshHeader, "session");
		if (fresh.kind !== "present") throw new Error("New SESSION missing");
		expect(fresh.cookieHash).not.toBe(stale.cookieHash);
		expect(rows(f, "coordinator_auth_sessions")).toEqual([
			expect.objectContaining({
				credential_hash: fresh.cookieHash,
				expires_at_ms: NOW + SESSION_TTL,
			}),
		]);
		expect(rows(f, "coordinator_auth_session_receipts")).toEqual([
			expect.objectContaining({
				attempt_id: "attempt-a",
				source: "link_redeem",
				purge_eligible: 0,
			}),
		]);
		expect(rows(f)[0].state).toBe("session_redeemed");
		expect(rows(f, "coordinator_auth_account_profiles")).toEqual([]);
		expect(authority(f).slice(0, 2)).toEqual(before.slice(0, 2));
		expect(authority(f).slice(5)).toEqual(before.slice(5));
		expect(f.forbidden).not.toHaveBeenCalled();
	});

	it.each(["malformed", "duplicate"])(
		"rejects %s SESSION before bound status despite valid TXN and MAC",
		async (scenario) => {
			// Arrange: parsing the original TXN validates every recognized cookie name.
			const f = await setup(backend);
			await ready(f);
			const sessionHeader = (await issueBrowserCookie("session")).setCookie.split(";")[0];
			let cookie = `${f.header}; ${sessionHeader}; ${sessionHeader}`;
			if (scenario === "malformed") cookie = `${f.header}; ${BROWSER_COOKIE_NAMES.session}=bad`;
			expect(
				await verifyBrowserCsrfToken(
					f.csrfKey,
					f.parsed.secret,
					"transaction",
					{ publicOrigin: ORIGIN, store: f.config },
					f.csrf,
				),
			).toBe(true);
			const before = authority(f);
			const attemptBefore = rows(f);
			const proofBefore = rows(f, "coordinator_auth_browser_transactions");
			// Act
			const result = await f.handlers.complete(post(f, {}, cookie), "trusted-client");
			// Assert: no session-stage fallback or cookie clearing can mask a corrupted header.
			await safe(result.response, 403);
			expect(result.outcome).toBe("cookie_invalid");
			for (const spy of Object.values(f.operations)) expect(spy).not.toHaveBeenCalled();
			expect(authority(f)).toEqual(before);
			expect(rows(f)).toEqual(attemptBefore);
			expect(rows(f, "coordinator_auth_browser_transactions")).toEqual(proofBefore);
		},
	);
});

it.each([
	"",
	"?attempt_id=attempt-a&attempt_id=attempt-a",
	"?attempt_id=attempt-a&completion=secret",
])("rejects malformed GET query %s", async (suffix) => {
	// Arrange
	const f = await setup();
	// Act
	const result = await f.handlers.page(get(f, suffix));
	// Assert
	await safe(result.response, 400);
	for (const spy of Object.values(f.operations)) expect(spy).not.toHaveBeenCalled();
});

it("accepts a percent-equivalent attempt id and rejects foreign route/hash/method", async () => {
	// Arrange
	const f = await setup();
	await ready(f);
	// Act
	const valid = await f.handlers.page(get(f, "?attempt_id=%61ttempt-a"));
	const foreign = await f.handlers.page(
		new Request("https://evil.example.test/auth/link/complete?attempt_id=attempt-a"),
	);
	const hash = await f.handlers.page(get(f, "?attempt_id=attempt-a#fragment"));
	const method = await f.handlers.page(
		new Request(`${ORIGIN}/auth/link/complete`, { method: "POST" }),
	);
	// Assert
	expect(valid.response.status).toBe(200);
	await safe(foreign.response, 404);
	await safe(hash.response, 404);
	await safe(method.response, 405);
	expect(method.response.headers.get("allow")).toBe("GET");
});

it.each([
	"missing",
	"invalid",
	"other-browser",
	"unknown-attempt",
	"config-revision",
	"config-redirect",
	"deadline",
])("GET denies %s without target status or cookie clearing", async (scenario) => {
	// Arrange
	const f = await setup();
	await ready(f);
	let cookie = f.header;
	let suffix = "?attempt_id=attempt-a";
	let handlers = f.handlers;
	if (scenario === "missing") cookie = "";
	if (scenario === "invalid") cookie = "__Host-codemem-auth-txn=not-a-cookie";
	if (scenario === "other-browser")
		cookie = (await issueBrowserCookie("transaction")).setCookie.split(";")[0];
	if (scenario === "unknown-attempt") suffix = "?attempt_id=unknown-attempt";
	if (scenario.startsWith("config-")) {
		const config = { ...f.config };
		if (scenario === "config-revision") config.revision = "b".repeat(64);
		else config.redirectUri = `${ORIGIN}/other-callback`;
		const result = createCoordinatorBrowserLinkCompletionHandlers({ ...f.input, config });
		if (!result.ok) throw new Error("Trusted config expected");
		handlers = result.handlers;
	}
	if (scenario === "deadline") f.clock.now += 600_000;
	const before = authority(f);
	// Act
	const result = await handlers.page(get(f, suffix, cookie));
	// Assert
	await safe(result.response, 403);
	expect(f.operations.getAuthLinkAttemptStatus).not.toHaveBeenCalled();
	if (["missing", "invalid"].includes(scenario))
		expect(f.operations.resolveAuthLinkBrowserTransaction).not.toHaveBeenCalled();
	expect(authority(f)).toEqual(before);
});

it.each(["https://evil.example.test", "null", null])(
	"rejects Origin %s before quota, store or body pull",
	async (origin) => {
		// Arrange
		const f = await setup();
		const pull = vi.fn();
		const headers = new Headers({
			cookie: f.header,
			"content-type": "application/x-www-form-urlencoded",
		});
		if (origin !== null) headers.set("origin", origin);
		const request = new Request(`${ORIGIN}/auth/link/complete`, {
			method: "POST",
			headers,
			body: new ReadableStream({ pull }, { highWaterMark: 0 }),
			duplex: "half",
		} as RequestInit);
		// Act
		const result = await f.handlers.complete(request, "trusted-client");
		// Assert
		await safe(result.response, 403);
		expect(pull).not.toHaveBeenCalled();
		expect(f.check).not.toHaveBeenCalled();
		for (const spy of Object.values(f.operations)) expect(spy).not.toHaveBeenCalled();
	},
);

it.each(["bad-mac", "wrong-cookie", "unknown-field", "other-attempt", "wrong-scope"])(
	"POST rejects %s without redemption",
	async (scenario) => {
		// Arrange
		const f = await setup();
		await ready(f);
		const changes: Record<string, string> = {};
		let cookie = f.header;
		if (scenario === "bad-mac") changes.csrf = "bad";
		if (scenario === "wrong-cookie")
			cookie = (await issueBrowserCookie("transaction")).setCookie.split(";")[0];
		if (scenario === "unknown-field") changes.role = "administrator";
		if (scenario === "other-attempt") changes.attempt_id = "other-attempt";
		if (scenario === "wrong-scope") {
			const { issueBrowserCsrfToken } = await import("./coordinator-browser-csrf.js");
			changes.csrf = await issueBrowserCsrfToken(f.csrfKey, f.parsed.secret, "transaction", {
				publicOrigin: ORIGIN,
				store: { ...f.config, revision: "b".repeat(64) },
			});
		}
		const before = authority(f);
		// Act
		const result = await f.handlers.complete(post(f, changes, cookie), "trusted-client");
		// Assert
		await safe(result.response, scenario === "unknown-field" ? 400 : 403);
		expect(f.operations.redeemAuthLinkSessionWithBrowserTransaction).not.toHaveBeenCalled();
		expect(authority(f)).toEqual(before);
	},
);

it("shares the default twenty-request budget across confirmation, cancellation and completion", async () => {
	// Arrange
	const f = await setup();
	// Act
	for (let index = 0; index < 20; index++) {
		const request = post(f, { csrf: "bad" });
		const action = index % 3;
		if (action === 0) await f.handlers.complete(request, "shared-client");
		if (action === 1)
			await f.link.confirm(post(f, { csrf: "bad" }, f.header, "confirm"), "shared-client");
		if (action === 2)
			await f.link.cancel(post(f, { csrf: "bad" }, f.header, "cancel"), "shared-client");
	}
	const denied = await f.handlers.complete(post(f), "shared-client");
	// Assert
	await safe(denied.response, 429);
	for (const [key, limit] of f.check.mock.calls) {
		expect(key).toBe(JSON.stringify(["browser-form", f.config.coordinatorId, "shared-client"]));
		expect(limit).toBe(20);
	}
	expect(f.operations.resolveAuthLinkBrowserTransaction).not.toHaveBeenCalled();
});

it("pins the original browser snapshot while HMAC verification awaits", async () => {
	// Arrange
	const f = await setup();
	await ready(f);
	const other = (await issueBrowserCookie("transaction")).setCookie.split(";")[0];
	const request = post(f);
	const verify = crypto.subtle.verify.bind(crypto.subtle);
	vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
		request.headers.set("cookie", other);
		return verify(...args);
	});
	// Act
	const result = await f.handlers.complete(request, "trusted-client");
	// Assert
	expect(result.response.status).toBe(303);
	expect(f.operations.resolveAuthLinkBrowserTransaction).toHaveBeenCalledWith(
		{ attemptId: "attempt-a", binderHash: f.parsed.cookieHash },
		f.config,
	);
	expect(f.operations.redeemAuthLinkSessionWithBrowserTransaction.mock.calls[0][0]).toMatchObject({
		binderHash: f.parsed.cookieHash,
		attemptId: "attempt-a",
	});
});

it("does not clear a pending ceremony even with a genuinely live SESSION", async () => {
	// Arrange
	const f = await setup("SQLite", { existingSession: true });
	await confirm(f);
	const cookie = `${f.header}; ${f.existingSession}`;
	const before = authority(f);
	// Act
	const result = await f.handlers.complete(post(f, {}, cookie), "trusted-client");
	// Assert
	await safe(result.response, 403);
	expect(f.operations.readAuthSession).not.toHaveBeenCalled();
	expect(f.operations.redeemAuthLinkSessionWithBrowserTransaction).not.toHaveBeenCalled();
	expect(authority(f)).toEqual(before);
});

it("preserves an existing live session after finalization without rotation or redemption", async () => {
	// Arrange
	const f = await setup();
	await ready(f);
	const issued = await issueBrowserCookie("session");
	expect(
		await f.store.signInWithAuthAccount(
			{
				credentialHash: issued.cookieHash,
				browserTransactionHash: "f".repeat(64),
				account: { issuer: f.config.issuer, subject: "opaque-subject-a" },
			},
			f.config,
		),
	).toMatchObject({ kind: "issued" });
	const cookie = `${f.header}; ${issued.setCookie.split(";")[0]}`;
	const before = authority(f);
	// Act
	const result = await f.handlers.complete(post(f, {}, cookie), "trusted-client");
	// Assert
	expect(result.response.status).toBe(303);
	expect(result.response.headers.get("location")).toBe(`${ORIGIN}/auth/account`);
	expect(result.response.headers.getSetCookie()).toEqual([clearBrowserCookie("transaction")]);
	expect(f.operations.redeemAuthLinkSessionWithBrowserTransaction).not.toHaveBeenCalled();
	expect(authority(f)).toEqual(before);
});

it("double submits through two store wrappers issue one SESSION and never clobber the winner", async () => {
	// Arrange
	const f = await setup();
	await ready(f);
	const peer = new D1CoordinatorStore(sqliteD1(f.db), { authClock: () => f.clock.now });
	const other = createCoordinatorBrowserLinkCompletionHandlers({ ...f.input, store: peer });
	if (!other.ok) throw new Error("Peer setup failed");
	// Act
	const results = await Promise.all([
		f.handlers.complete(post(f), "first-client"),
		other.handlers.complete(post(f), "second-client"),
	]);
	// Assert
	expect(results.map((result) => result.response.status).sort()).toEqual([303, 403]);
	expect(
		results.find((result) => result.response.status === 403)?.response.headers.getSetCookie(),
	).toEqual([]);
	expect(
		results.find((result) => result.response.status === 303)?.response.headers.getSetCookie(),
	).toHaveLength(2);
	expect(rows(f, "coordinator_auth_sessions")).toHaveLength(1);
	expect(rows(f, "coordinator_auth_session_receipts")).toHaveLength(1);
});

it.each([120_000, 600_000])(
	"a ready page does not authorize POST at exact expiry %s",
	async (elapsed) => {
		// Arrange
		const f = await setup();
		await ready(f);
		const page = await f.handlers.page(get(f));
		expect(page.response.status).toBe(200);
		f.clock.now += elapsed;
		const before = authority(f);
		// Act
		const result = await f.handlers.complete(post(f), "trusted-client");
		// Assert
		await safe(result.response, 403);
		expect(authority(f)).toEqual(before);
	},
);

it.each([
	"resolver",
	"status",
	"redeem-before",
	"redeem-after",
	"live-read",
	"entropy",
	"session-hash",
	"store-rejected",
])("%s failures return no cookies or private diagnostics", async (fault) => {
	// Arrange
	const f = await setup();
	await ready(f);
	let cookie = f.header;
	if (fault === "resolver")
		f.operations.resolveAuthLinkBrowserTransaction.mockRejectedValue(new Error("privateCause"));
	if (fault === "status")
		f.operations.getAuthLinkAttemptStatus.mockRejectedValue(new Error("privateCause"));
	if (fault === "entropy")
		vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
			throw new Error("privateCause");
		});
	if (fault === "session-hash") {
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
			const bytes = args[1];
			if (
				f.operations.getAuthLinkAttemptStatus.mock.calls.length &&
				ArrayBuffer.isView(bytes) &&
				bytes.byteLength === 32
			)
				throw new Error("privateCause");
			return digest(...args);
		});
	}
	if (fault === "store-rejected")
		f.operations.redeemAuthLinkSessionWithBrowserTransaction.mockResolvedValue({
			kind: "rejected",
			error: "attempt_unavailable",
		});
	if (fault === "redeem-before")
		f.operations.redeemAuthLinkSessionWithBrowserTransaction.mockRejectedValue(
			new Error("privateCause"),
		);
	if (fault === "redeem-after")
		f.operations.redeemAuthLinkSessionWithBrowserTransaction.mockImplementation(async (...args) => {
			await f.store.redeemAuthLinkSessionWithBrowserTransaction(...args);
			throw new Error("privateCause");
		});
	if (fault === "live-read") {
		cookie = `${f.header}; ${(await issueBrowserCookie("session")).setCookie.split(";")[0]}`;
		f.operations.readAuthSession.mockRejectedValue(new Error("privateCause"));
	}
	// Act
	const result = await f.handlers.complete(post(f, {}, cookie), "trusted-client");
	// Assert: postcommit failure is not a rollback claim.
	await safe(result.response, fault === "store-rejected" ? 403 : 503);
	expect(rows(f, "coordinator_auth_sessions")).toHaveLength(fault === "redeem-after" ? 1 : 0);
	expect(rows(f, "coordinator_auth_account_profiles")).toEqual([]);
	expect(f.forbidden).not.toHaveBeenCalled();
});

it.each(["render", "csrf-key"])("GET %s failure releases no form or cookie", async (fault) => {
	// Arrange
	const f = await setup();
	await ready(f);
	const before = authority(f);
	if (fault === "csrf-key")
		vi.spyOn(crypto.subtle, "sign").mockRejectedValue(new Error("privateCause"));
	else {
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
			const data = args[1];
			if (ArrayBuffer.isView(data) && data.byteLength > 32) throw new Error("privateCause");
			return digest(...args);
		});
	}
	// Act
	const result = await f.handlers.page(get(f));
	// Assert
	await safe(result.response, 503);
	expect(await result.response.text()).not.toContain("<form");
	expect(authority(f)).toEqual(before);
});
