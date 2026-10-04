import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TABLE } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { renderAuthBrowserNotice } from "./coordinator-auth-browser-view.js";
import { advance, authorize, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { linked } from "./coordinator-auth-session-test-fixtures.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	type CoordinatorBrowserAuthCallbackInput,
	type CoordinatorBrowserAuthLinkCompletionInput,
	createCoordinatorBrowserAuthCallback,
} from "./coordinator-browser-auth-callback.js";
import {
	BROWSER_COOKIE_NAMES,
	browserCookieValue,
	clearBrowserCookie,
	issueBrowserCookie,
} from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { createCoordinatorBrowserSigninStart } from "./coordinator-browser-signin-start.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";

const ORIGIN = "https://app.example.test";
const PRIVATE = "synthetic-private-failure";
const config = () => ({
	enabled: true,
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.google.com",
	redirectUri: PROVIDER.redirectUri,
	revision: "a".repeat(64),
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
});
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
async function harness() {
	const f = setupStore("SQLite", { authClock: () => NOW });
	databases.push(f.db);
	const oidc = oidcFixture({ issuer: config().issuer });
	oidc.claims.sub = "opaque-subject-a";
	const store = {
		consumeAuthBrowserTransaction: vi.fn(f.store.consumeAuthBrowserTransaction.bind(f.store)),
		readAuthSession: vi.fn(f.store.readAuthSession.bind(f.store)),
		signInWithConsumedBrowserTransaction: vi.fn(
			f.store.signInWithConsumedBrowserTransaction.bind(f.store),
		),
		recordAuthAccountProfile: vi.fn(f.store.recordAuthAccountProfile.bind(f.store)),
	};
	const completeLink = vi.fn(
		async (_input: CoordinatorBrowserAuthLinkCompletionInput) =>
			new Response("continuation", { status: 202 }),
	);
	const input: CoordinatorBrowserAuthCallbackInput = {
		config: config(),
		store,
		completeLink,
		oidcOptions: { fetch: oidc.fetch },
	};
	const callback = await createCoordinatorBrowserAuthCallback(input);
	const start = await createCoordinatorBrowserSigninStart({
		config: config(),
		store: f.store,
		csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(7)),
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		oidcOptions: { fetch: oidc.fetch },
	});
	if (!callback.ok || !start.ok) throw new Error("Expected actual SDK factories");
	oidc.fetch.mockClear();
	return {
		...f,
		now: NOW,
		cfg: config(),
		oidc,
		store,
		persistence: f.store,
		completeLink,
		input,
		callback: callback.handlers.callback,
		start: start.handlers,
	};
}
type Harness = Awaited<ReturnType<typeof harness>>;
function rows(f: Harness, table = TABLE) {
	return f.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}
async function ceremony(f: Harness) {
	const page = await f.start.signInPage(new Request(`${ORIGIN}/auth/sign-in`));
	const cookie = page.response.headers.getSetCookie()[0]?.split(";")[0];
	const token = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await page.response.text())?.[1];
	if (!cookie || !token) throw new Error("Expected real HMAC START form");
	const start = await f.start.signInStart(
		new Request(`${ORIGIN}/auth/sign-in`, {
			method: "POST",
			headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
			body: `csrf=${token}`,
		}),
		"trusted-client",
	);
	const href = /href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/.exec(
		await start.response.text(),
	)?.[1];
	const txn = start.response.headers.getSetCookie()[0]?.split(";")[0];
	if (!href || !txn) throw new Error("Expected admitted TXN");
	return { cookie: txn, url: f.oidc.authorize(href.replaceAll("&amp;", "&")) };
}
function request(c: { url: URL; cookie: string }) {
	return new Request(c.url, { headers: { cookie: c.cookie } });
}
async function unavailable(response: Response, clear: boolean) {
	expect(response.status).toBe(503);
	expect(response.headers.getSetCookie()).toEqual(clear ? [clearBrowserCookie("transaction")] : []);
	expect(response.headers.get("location")).toBeNull();
	const body = await response.clone().text();
	for (const secret of [PRIVATE, PROVIDER.clientSecret, "fixture-access-token"])
		expect(body).not.toContain(secret);
}

describe("callback factory capabilities are inert, narrow and captured before discovery", () => {
	it.each([undefined, { enabled: false }, { ...config(), clientSecret: null }])(
		"rejects disabled/invalid config without reading capabilities or fetching",
		async (value) => {
			// Arrange
			const f = await harness();
			const trap = vi.fn(() => {
				throw new Error(PRIVATE);
			});
			const input = { config: value };
			for (const key of ["store", "completeLink", "oidcOptions"])
				Object.defineProperty(input, key, { get: trap });
			// Act
			const result = await createCoordinatorBrowserAuthCallback(
				input as CoordinatorBrowserAuthCallbackInput,
			);
			// Assert
			expect(result.ok).toBe(false);
			expect(Object.isFrozen(result)).toBe(true);
			expect(trap).not.toHaveBeenCalled();
			expect(f.oidc.fetch).not.toHaveBeenCalled();
			expect(JSON.stringify(result)).not.toContain(PROVIDER.clientSecret);
		},
	);
	it.each(["missing", "not-function", "getter", "inherited"])(
		"requires own data-function completeLink: %s",
		async (fault) => {
			// Arrange
			const f = await harness();
			const input = { ...f.input };
			const getter = vi.fn(() => f.completeLink);
			if (fault === "missing" || fault === "inherited")
				Reflect.deleteProperty(input, "completeLink");
			if (fault === "not-function") Object.defineProperty(input, "completeLink", { value: {} });
			if (fault === "getter") Object.defineProperty(input, "completeLink", { get: getter });
			if (fault === "inherited") Object.setPrototypeOf(input, { completeLink: f.completeLink });
			// Act
			const result = await createCoordinatorBrowserAuthCallback(input);
			// Assert
			expect(result).toEqual({ ok: false, error: "invalid_input" });
			expect(getter).not.toHaveBeenCalled();
			expect(f.oidc.fetch).not.toHaveBeenCalled();
			expect(f.store.consumeAuthBrowserTransaction).not.toHaveBeenCalled();
		},
	);
	it.each([
		"consumeAuthBrowserTransaction",
		"readAuthSession",
		"signInWithConsumedBrowserTransaction",
		"recordAuthAccountProfile",
	])("rejects store accessor %s without evaluating it", async (name) => {
		// Arrange
		const f = await harness();
		const getter = vi.fn(() => {
			throw new Error(PRIVATE);
		});
		Object.defineProperty(f.store, name, { get: getter });
		// Act
		const result = await createCoordinatorBrowserAuthCallback(f.input);
		// Assert
		expect(result).toEqual({ ok: false, error: "invalid_input" });
		expect(getter).not.toHaveBeenCalled();
		expect(f.oidc.fetch).not.toHaveBeenCalled();
	});
	it.each(["own", "prototype"])(
		"captures %s methods, receiver and trusted config despite replacement",
		async (shape) => {
			// Arrange
			const f = await harness();
			await linked({ ...f, store: f.persistence });
			const c = await ceremony(f);
			const unpersistedSession = await issueBrowserCookie("session");
			c.cookie += `; ${unpersistedSession.setCookie.split(";")[0]}`;
			const methods = Object.fromEntries(
				Object.entries(f.store).map(([name, fn]) => [
					name,
					vi.fn(function (this: unknown, ...args: unknown[]) {
						expect(this).toBe(store);
						return Reflect.apply(fn, f.store, args);
					}),
				]),
			);
			const store = shape === "own" ? { ...methods } : Object.create(methods);
			const trap = vi.fn(() => {
				throw new Error(PRIVATE);
			});
			for (const name of [
				"signInWithAuthAccount",
				"cancelAuthSigninBrowserTransaction",
				"purgeAuthSigninBrowserTransactions",
				"retireAuthBrowserTransactions",
				"maintainAuthBrowserTransactions",
				"redeemAuthLinkSession",
				"signOutAuthSession",
			])
				Object.defineProperty(store, name, { get: trap });
			const pending = createCoordinatorBrowserAuthCallback({ ...f.input, store });
			for (const name of Object.keys(methods)) store[name] = trap;
			(f.input.config as ReturnType<typeof config>).clientSecret = "changed-secret";
			(f.input.config as ReturnType<typeof config>).revision = "b".repeat(64);
			// Act
			const result = await pending;
			if (!result.ok) throw new Error("Expected captured factory");
			const reply = await result.handlers.callback(request(c));
			// Assert
			expect(reply.response.status).toBe(303);
			expect(Object.isFrozen(result)).toBe(true);
			expect(Object.isFrozen(result.handlers)).toBe(true);
			expect(Object.isFrozen(reply)).toBe(true);
			expect(methods.consumeAuthBrowserTransaction).toHaveBeenCalledOnce();
			expect(methods.readAuthSession).toHaveBeenCalledOnce();
			expect(methods.signInWithConsumedBrowserTransaction).toHaveBeenCalledOnce();
			expect(methods.recordAuthAccountProfile).toHaveBeenCalledOnce();
			expect(trap).not.toHaveBeenCalled();
		},
	);
});

describe("callback discovery failures do not consume browser state", () => {
	it("maps discovery transport failure to a fixed factory error", async () => {
		// Arrange
		const f = await harness();
		f.oidc.settings.failure = `${f.cfg.issuer}/.well-known/openid-configuration`;
		// Act
		const result = await createCoordinatorBrowserAuthCallback(f.input);
		// Assert
		expect(result).toEqual({ ok: false, error: "oidc_discovery_failed" });
		expect(f.store.consumeAuthBrowserTransaction).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain(PROVIDER.clientSecret);
	});
});

describe("runtime purpose and original cookie boundaries fail closed", () => {
	it("rejects an unknown consumed purpose without treating it as sign-in or LINK", async () => {
		// Arrange: use real consumption and valid SDK verification; only the union discriminant is corrupt.
		const f = await harness();
		await linked({ ...f, store: f.persistence });
		const c = await ceremony(f);
		f.store.consumeAuthBrowserTransaction.mockImplementation(async (...args) => {
			const consumed = await f.persistence.consumeAuthBrowserTransaction(...args);
			if (consumed.kind !== "consumed") throw new Error("Expected native consumption");
			return { ...consumed, purpose: "other" } as unknown as typeof consumed;
		});
		// Act
		const reply = await f.callback(request(c));
		// Assert: an unknown runtime union value grants no authority or cookie cleanup rights.
		expect(reply.outcome).toBe("internal_error");
		await unavailable(reply.response, false);
		expect(rows(f)[0]).toMatchObject({ state: "consumed", nonce: null, pkce_verifier: null });
		expect(rows(f, "coordinator_auth_sessions")).toEqual([]);
		expect(rows(f, "coordinator_auth_session_receipts")).toEqual([]);
		expect(rows(f, "coordinator_auth_account_profiles")).toEqual([]);
		expect(f.store.consumeAuthBrowserTransaction).toHaveBeenCalledOnce();
		expect(f.store.readAuthSession).not.toHaveBeenCalled();
		expect(f.store.signInWithConsumedBrowserTransaction).not.toHaveBeenCalled();
		expect(f.completeLink).not.toHaveBeenCalled();
		expect(f.store.recordAuthAccountProfile).not.toHaveBeenCalled();
	});
	it.each(["malformed", "duplicate"])(
		"rejects original %s SESSION alongside valid TXN before consuming any proof",
		async (fault) => {
			// Arrange: the shared known-cookie parser validates SESSION even when reading TXN.
			const f = await harness();
			const c = await ceremony(f);
			const session = (await issueBrowserCookie("session")).setCookie.split(";")[0];
			const sessionHeader = {
				malformed: `${BROWSER_COOKIE_NAMES.session}=bad`,
				duplicate: `${session}; ${session}`,
			};
			c.cookie += `; ${sessionHeader[fault as keyof typeof sessionHeader]}`;
			const before = rows(f);
			// Act
			const reply = await f.callback(request(c));
			// Assert: malformed original SESSION is not absent and cannot burn a valid TXN.
			expect(reply.response.status).toBe(400);
			expect(reply.outcome).toBe("cookie_invalid");
			expect(reply.response.headers.getSetCookie()).toEqual([]);
			expect(rows(f)).toEqual(before);
			expect(before[0]).toMatchObject({
				state: "pending",
				nonce: expect.any(String),
				pkce_verifier: expect.any(String),
			});
			expect(f.store.consumeAuthBrowserTransaction).not.toHaveBeenCalled();
			expect(f.oidc.fetch).not.toHaveBeenCalled();
			expect(f.store.readAuthSession).not.toHaveBeenCalled();
			expect(f.store.signInWithConsumedBrowserTransaction).not.toHaveBeenCalled();
			expect(f.completeLink).not.toHaveBeenCalled();
			expect(f.store.recordAuthAccountProfile).not.toHaveBeenCalled();
		},
	);
});

describe("errors distinguish confirmed consumption from ambiguous backend throws", () => {
	it.each(["before-commit", "after-commit"])(
		"consume throw %s keeps cookies even if the row was burned",
		async (stage) => {
			// Arrange
			const f = await harness();
			const c = await ceremony(f);
			const before = rows(f);
			f.store.consumeAuthBrowserTransaction.mockImplementation(async (...args) => {
				if (stage === "after-commit") await f.persistence.consumeAuthBrowserTransaction(...args);
				throw new Error(PRIVATE);
			});
			// Act
			const reply = await f.callback(request(c));
			// Assert
			await unavailable(reply.response, false);
			if (stage === "before-commit") expect(rows(f)).toEqual(before);
			else
				expect(rows(f)[0]).toMatchObject({ state: "consumed", nonce: null, pkce_verifier: null });
			expect(f.oidc.fetch).not.toHaveBeenCalled();
			expect(f.store.signInWithConsumedBrowserTransaction).not.toHaveBeenCalled();
		},
	);
	it.each(["read-session", "admission", "entropy"])(
		"confirmed sign-in consumption clears only TXN after %s failure",
		async (fault) => {
			// Arrange
			const f = await harness();
			await linked({ ...f, store: f.persistence });
			const c = await ceremony(f);
			if (fault === "read-session") {
				c.cookie += `; ${(await issueBrowserCookie("session")).setCookie.split(";")[0]}`;
				f.store.readAuthSession.mockRejectedValue(new Error(PRIVATE));
			}
			if (fault === "admission")
				f.store.signInWithConsumedBrowserTransaction.mockRejectedValue(new Error(PRIVATE));
			if (fault === "entropy")
				vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
					throw new Error(PRIVATE);
				});
			// Act
			const reply = await f.callback(request(c));
			// Assert
			await unavailable(reply.response, true);
			expect(rows(f)[0]).toMatchObject({ state: "consumed", nonce: null, pkce_verifier: null });
			expect(rows(f, "coordinator_auth_sessions")).toEqual([]);
			expect(f.store.recordAuthAccountProfile).not.toHaveBeenCalled();
		},
	);
	it.each(["pre-consume", "post-consume"])(
		"style-digest fallback %s preserves conditional cookie grammar",
		async (stage) => {
			// Arrange
			const f = await harness();
			const c = await ceremony(f);
			if (stage === "post-consume") {
				c.url.searchParams.delete("code");
				c.url.searchParams.set("error", "access_denied");
			} else c.url.searchParams.delete("state");
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => {
				const value =
					bytes instanceof ArrayBuffer
						? new Uint8Array(bytes)
						: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
				if (new TextDecoder().decode(value).includes(":root{")) throw new Error(PRIVATE);
				return digest(algorithm, bytes);
			});
			// Act
			const reply = await f.callback(request(c));
			// Assert
			await unavailable(reply.response, stage === "post-consume");
			expect(await reply.response.text()).toBe(
				"Sign-in or linking unavailable. Return to the flow you started and try again.",
			);
			expect(rows(f)[0]?.state).toBe(stage === "post-consume" ? "consumed" : "pending");
		},
	);
	it("hash failure before consume preserves the original cookie and pending row", async () => {
		// Arrange
		const f = await harness();
		const c = await ceremony(f);
		vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error(PRIVATE));
		// Act
		const reply = await f.callback(request(c));
		// Assert
		await unavailable(reply.response, false);
		expect(f.store.consumeAuthBrowserTransaction).not.toHaveBeenCalled();
		expect(rows(f)[0]?.state).toBe("pending");
		expect(f.oidc.fetch).not.toHaveBeenCalled();
	});
});

async function linkCeremony(f: Harness) {
	await authorize({ ...f, store: f.persistence });
	await advance({ ...f, store: f.persistence }, "pending");
	const txn = await issueBrowserCookie("transaction");
	const begun = await f.oidc.begin();
	const hash = async (value: string) =>
		Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString(
			"hex",
		);
	expect(
		await f.persistence.startAuthBrowserTransaction(
			{
				purpose: "link",
				attemptId: "attempt-a",
				binderHash: txn.cookieHash,
				stateHash: await hash(begun.request.material.state),
				nonce: begun.request.material.nonce,
				pkceVerifier: begun.request.material.pkceVerifier,
			},
			f.cfg,
		),
	).toMatchObject({ kind: "started" });
	f.oidc.fetch.mockClear();
	return {
		cookie: txn.setCookie.split(";")[0] ?? "",
		url: f.oidc.authorize(begun.request.authorizationUrl),
		hash: txn.cookieHash,
		original: { ...rows(f)[0] },
	};
}

describe("LINK dispatch is a mandatory captured continuation, not implicit linking", () => {
	it.each(["success", "provider-denied"])(
		"dispatches %s verification once with exact frozen opaque context and unchanged Response",
		async (verification) => {
			// Arrange
			const f = await harness();
			const c = await linkCeremony(f);
			if (verification === "provider-denied") {
				c.url.searchParams.delete("code");
				c.url.searchParams.set("error", "access_denied");
			}
			const response = new Response("caller owns this response", {
				status: 202,
				headers: { "x-continuation": "preserved", "set-cookie": "caller-owned=value" },
			});
			const completeLink = vi.fn(
				async (_input: CoordinatorBrowserAuthLinkCompletionInput) => response,
			);
			const input = { ...f.input, completeLink };
			const pending = createCoordinatorBrowserAuthCallback(input);
			const replacement = vi.fn(async () => {
				throw new Error(PRIVATE);
			});
			input.completeLink = replacement;
			const result = await pending;
			if (!result.ok) throw new Error("Expected LINK callback");
			const before = rows(f, "coordinator_auth_link_attempts");
			// Act
			const reply = await result.handlers.callback(request(c));
			const context = completeLink.mock.calls[0]?.[0];
			// Assert
			expect(reply.response).toBe(response);
			expect(reply.outcome).toBe("link_dispatched");
			expect(reply.response.headers.getSetCookie()).toEqual(["caller-owned=value"]);
			expect(completeLink).toHaveBeenCalledOnce();
			expect(replacement).not.toHaveBeenCalled();
			if (!context) throw new Error("Expected captured link context");
			expect(Object.keys(context).sort()).toEqual(
				[
					"attemptId",
					"browserTransactionHash",
					"transactionCookie",
					"transactionCookieHash",
					"verification",
				].sort(),
			);
			expect(context).toMatchObject({
				attemptId: "attempt-a",
				browserTransactionHash: c.original.browser_transaction_hash,
				transactionCookieHash: c.hash,
				verification: { ok: verification === "success" },
			});
			expect(Object.isFrozen(context)).toBe(true);
			expect(Object.isFrozen(context.verification)).toBe(true);
			expect(Object.isFrozen(context.transactionCookie)).toBe(true);
			expect(JSON.stringify(context.transactionCookie)).toBe("{}");
			expect(browserCookieValue(context.transactionCookie, "transaction")).toBe(
				c.cookie.split("=")[1],
			);
			expect(() => browserCookieValue(context.transactionCookie, "session")).toThrow();
			const encoded = JSON.stringify(context);
			for (const secret of [
				c.cookie.split("=")[1],
				c.url.href,
				c.url.searchParams.get("code"),
				c.url.searchParams.get("state"),
				c.original.nonce,
				c.original.pkce_verifier,
			])
				if (typeof secret === "string") expect(encoded).not.toContain(secret);
			expect(rows(f)[0]).toMatchObject({ state: "consumed", nonce: null, pkce_verifier: null });
			expect(rows(f, "coordinator_auth_link_attempts")).toEqual(before);
			expect(before[0]?.state).toBe("browser_claimed");
			expect(rows(f, "coordinator_auth_account_links")).toEqual([]);
			expect(rows(f, "coordinator_auth_sessions")).toEqual([]);
			expect(f.store.readAuthSession).not.toHaveBeenCalled();
			expect(f.store.signInWithConsumedBrowserTransaction).not.toHaveBeenCalled();
			expect(f.store.recordAuthAccountProfile).not.toHaveBeenCalled();
		},
	);
	it.each(["throws", "not-response"])(
		"continuation %s leaves cleanup to the caller with no factory cookies",
		async (fault) => {
			// Arrange
			const f = await harness();
			const c = await linkCeremony(f);
			if (fault === "throws") f.completeLink.mockRejectedValue(new Error(PRIVATE));
			else f.completeLink.mockResolvedValue({ status: 303 } as Response);
			// Act
			const reply = await f.callback(request(c));
			// Assert
			await unavailable(reply.response, false);
			expect(f.completeLink).toHaveBeenCalledOnce();
			expect(rows(f)[0]).toMatchObject({ state: "consumed", nonce: null, pkce_verifier: null });
			expect(rows(f, "coordinator_auth_link_attempts")[0]?.state).toBe("browser_claimed");
			expect(rows(f, "coordinator_auth_sessions")).toEqual([]);
			expect(rows(f, "coordinator_auth_account_profiles")).toEqual([]);
		},
	);
	it("renders the fixed notice independent of caller-controlled data", async () => {
		// Arrange
		const f = await harness();
		const page = await renderAuthBrowserNotice("auth_unavailable");
		// Act
		const reply = await f.callback(new Request(`${PROVIDER.redirectUri}?state=${PRIVATE}`));
		// Assert
		expect(reply.response.status).toBe(400);
		expect(await reply.response.text()).toBe(page.body);
		expect(page.body).not.toContain(PRIVATE);
		expect(reply.response.headers.getSetCookie()).toEqual([]);
	});
});
