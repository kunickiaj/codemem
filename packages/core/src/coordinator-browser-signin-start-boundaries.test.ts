import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoordinatorAuthBrowserTransactionStartResult } from "./coordinator-auth-browser-transaction-contract.js";
import { TABLE } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { renderAuthBrowserNotice } from "./coordinator-auth-browser-view.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { issueBrowserCookie } from "./coordinator-browser-credential.js";
import { type BrowserCsrfKey, importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { createCoordinatorBrowserSigninStart } from "./coordinator-browser-signin-start.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";

const PRIVATE = "synthetic-private-failure";
const ORIGIN = "https://app.example.test";
const config = () => ({
	enabled: true,
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.google.com",
	redirectUri: PROVIDER.redirectUri,
	revision: "a".repeat(64),
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
});
type Input = Parameters<typeof createCoordinatorBrowserSigninStart>[0];
type Success = Extract<
	Awaited<ReturnType<typeof createCoordinatorBrowserSigninStart>>,
	{ ok: true }
>;
const databases: ReturnType<typeof setupStore>["db"][] = [];
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		for (const db of databases.splice(0)) db.close();
	}
});
function responses(result: Success) {
	return {
		async signInPageGET(request: Request) {
			return (await result.handlers.signInPage(request)).response;
		},
		async signInStartPOST(request: Request, clientKey: string) {
			return (await result.handlers.signInStart(request, clientKey)).response;
		},
	};
}
async function harness() {
	const f = setupStore("SQLite", { authClock: () => NOW });
	databases.push(f.db);
	const oidc = oidcFixture({ issuer: config().issuer });
	const store = {
		startAuthBrowserTransaction: vi.fn(f.store.startAuthBrowserTransaction.bind(f.store)),
		readAuthSession: vi.fn(f.store.readAuthSession.bind(f.store)),
	};
	const input: Input = {
		config: config(),
		csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(7)),
		store,
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		oidcOptions: { fetch: oidc.fetch },
	};
	const result = await createCoordinatorBrowserSigninStart(input);
	if (!result.ok) throw new Error("Expected real SDK discovery");
	oidc.fetch.mockClear();
	return { db: f.db, store, oidc, input, handlers: responses(result) };
}
type Harness = Awaited<ReturnType<typeof harness>>;
function get(cookie?: string) {
	return new Request(`${ORIGIN}/auth/sign-in`, { headers: cookie ? { cookie } : {} });
}
function post(cookie: string, token: string) {
	return new Request(`${ORIGIN}/auth/sign-in`, {
		method: "POST",
		headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
		body: `csrf=${token}`,
	});
}
function rows(f: Harness) {
	return f.db.prepare(`SELECT * FROM ${TABLE}`).all();
}
async function ceremony(f: Harness) {
	const response = await f.handlers.signInPageGET(get());
	const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
	const token = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await response.text())?.[1];
	if (!cookie || !token) throw new Error("Expected real START cookie and hidden CSRF");
	return { cookie, token };
}
async function rejected(response: Response, status: number) {
	expect(response.status).toBe(status);
	expect(response.headers.getSetCookie()).toEqual([]);
	const body = await response.text();
	for (const value of [
		PRIVATE,
		PROVIDER.clientSecret,
		"fixture-access-token",
		"fixture-code",
		"private-pkce",
	])
		expect(body).not.toContain(value);
}

describe("sign-in factory captures only explicit capabilities", () => {
	it.each([undefined, { enabled: false }, { ...config(), clientSecret: null }])(
		"does not discover disabled or invalid configuration %j",
		async (value) => {
			// Arrange
			const f = await harness();
			f.input.config = value;
			// Act
			const result = await createCoordinatorBrowserSigninStart(f.input);
			// Assert
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).not.toContain(PROVIDER.clientSecret);
			expect(f.oidc.fetch).not.toHaveBeenCalled();
			expect(f.store.startAuthBrowserTransaction).not.toHaveBeenCalled();
		},
	);
	it.each(["own", "prototype"])(
		"captures %s methods and receiver before discovery yields",
		async (shape) => {
			// Arrange
			const f = await harness();
			const original = f.input.store;
			const start = vi.fn(function (
				this: unknown,
				...args: Parameters<typeof original.startAuthBrowserTransaction>
			) {
				expect(this).toBe(store);
				return original.startAuthBrowserTransaction(...args);
			});
			const read = vi.fn(function (
				this: unknown,
				...args: Parameters<typeof original.readAuthSession>
			) {
				expect(this).toBe(store);
				return original.readAuthSession(...args);
			});
			const store = Object.assign(
				shape === "prototype"
					? Object.create({ startAuthBrowserTransaction: start, readAuthSession: read })
					: {},
				shape === "own" ? { startAuthBrowserTransaction: start, readAuthSession: read } : {},
			);
			const forbidden = vi.fn(() => {
				throw new Error(PRIVATE);
			});
			for (const name of [
				"cancelAuthSigninBrowserTransaction",
				"purgeAuthSigninBrowserTransactions",
				"maintainAuthBrowserTransactions",
				"signInWithAuthAccount",
				"signOutAuthSession",
				"retireAuthBrowserTransactions",
			])
				Object.defineProperty(store, name, { get: forbidden });
			const pending = createCoordinatorBrowserSigninStart({ ...f.input, store });
			store.startAuthBrowserTransaction = forbidden;
			store.readAuthSession = forbidden;
			(f.input.config as ReturnType<typeof config>).clientSecret = "changed-secret";
			// Act
			const result = await pending;
			if (!result.ok) throw new Error("Expected capture success");
			const session = await issueBrowserCookie("session");
			await responses(result).signInPageGET(get(session.setCookie.split(";")[0]));
			f.handlers = responses(result);
			const c = await ceremony(f);
			const response = await responses(result).signInStartPOST(
				post(c.cookie, c.token),
				"trusted-client",
			);
			// Assert
			expect(response.status).toBe(200);
			expect(start).toHaveBeenCalledOnce();
			expect(read).toHaveBeenCalledOnce();
			expect(forbidden).not.toHaveBeenCalled();
			expect(Object.isFrozen(result)).toBe(true);
			expect(Object.isFrozen(result.handlers)).toBe(true);
		},
	);
	it.each(["startAuthBrowserTransaction", "readAuthSession"])(
		"rejects getter capability %s without executing it",
		async (name) => {
			// Arrange
			const f = await harness();
			const getter = vi.fn(() => {
				throw new Error(PRIVATE);
			});
			Object.defineProperty(f.store, name, { get: getter });
			// Act
			const result = await createCoordinatorBrowserSigninStart(f.input);
			// Assert
			expect(result.ok).toBe(false);
			expect(getter).not.toHaveBeenCalled();
			expect(f.oidc.fetch).not.toHaveBeenCalled();
			expect(JSON.stringify(result)).not.toContain(PRIVATE);
		},
	);
});

describe("opaque CSRF key use fails closed", () => {
	it("fails closed for a forged CSRF key", async () => {
		// Arrange
		const f = await harness();
		const c = await ceremony(f);
		expect(f.store.startAuthBrowserTransaction).not.toHaveBeenCalled();
		expect(rows(f)).toEqual([]);
		const generic = await renderAuthBrowserNotice("signin_unavailable");
		const result = await createCoordinatorBrowserSigninStart({
			...f.input,
			csrfKey: {} as BrowserCsrfKey,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Unexpected forged-key factory rejection");
		f.oidc.fetch.mockClear();
		// Act: real START cookie and MAC, but an unregistered opaque key handle.
		const page = await result.handlers.signInPage(get(c.cookie));
		const start = await result.handlers.signInStart(post(c.cookie, c.token), "trusted-client");
		// Assert: the factory accepts the handle; handlers fail closed at actual MAC use.
		expect(page.outcome).toBe("internal_error");
		expect(start.outcome).toBe("csrf_invalid");
		await rejected(page.response.clone(), 503);
		await rejected(start.response.clone(), 403);
		for (const { response } of [page, start]) {
			expect(response.headers.get("location")).toBeNull();
			expect(await response.text()).toBe(generic.body);
		}
		expect(f.store.startAuthBrowserTransaction).not.toHaveBeenCalled();
		expect(rows(f)).toEqual([]);
		expect(f.oidc.fetch).not.toHaveBeenCalled();
	});
});

describe("fixed failures never attach promotion cookies", () => {
	it.each(["GET", "POST"])(
		"catches style hashing failure and uses a cookie-free fixed fallback for %s",
		async (method) => {
			// Arrange
			const f = await harness();
			const c = await ceremony(f);
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
			const response =
				method === "GET"
					? await f.handlers.signInPageGET(get(c.cookie))
					: await f.handlers.signInStartPOST(post(c.cookie, c.token), "trusted-client");
			// Assert
			await rejected(response.clone(), 503);
			expect(await response.text()).toBe("Sign-in unavailable. Try again.");
			expect(f.store.startAuthBrowserTransaction).not.toHaveBeenCalled();
		},
	);
	it("catches a CSRF signing failure on GET without setting a START cookie", async () => {
		// Arrange
		const f = await harness();
		vi.spyOn(crypto.subtle, "sign").mockRejectedValue(new Error(PRIVATE));
		// Act
		const response = await f.handlers.signInPageGET(get());
		// Assert
		await rejected(response, 503);
		expect(rows(f)).toEqual([]);
	});
	it("reports SDK authorization generation failure as provider_request_failed without writing", async () => {
		// Arrange
		const f = await harness();
		const c = await ceremony(f);
		const result = await createCoordinatorBrowserSigninStart(f.input);
		if (!result.ok) throw new Error("Expected SDK discovery");
		vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
			throw new Error(PRIVATE);
		});
		// Act
		const reply = await result.handlers.signInStart(post(c.cookie, c.token), "trusted-client");
		// Assert
		expect(reply.outcome).toBe("provider_request_failed");
		expect(Object.isFrozen(reply)).toBe(true);
		await rejected(reply.response, 503);
		expect(f.store.startAuthBrowserTransaction).not.toHaveBeenCalled();
	});
	it.each(["transaction_conflict", "transaction_limited", "clock_retention_blocked"] as const)(
		"maps store rejection %s",
		async (error) => {
			// Arrange
			const f = await harness();
			const c = await ceremony(f);
			f.store.startAuthBrowserTransaction.mockResolvedValue({ kind: "rejected", error });
			// Act
			const response = await f.handlers.signInStartPOST(post(c.cookie, c.token), "trusted-client");
			// Assert
			await rejected(response, error === "transaction_conflict" ? 409 : 503);
			expect(rows(f)).toEqual([]);
		},
	);
	it.each(["throw", "no-commit"])("does not promote when store %s", async (fault) => {
		// Arrange
		const f = await harness();
		const c = await ceremony(f);
		if (fault === "throw")
			f.store.startAuthBrowserTransaction.mockRejectedValue(new Error(PRIVATE));
		else
			f.store.startAuthBrowserTransaction.mockResolvedValue(
				undefined as unknown as CoordinatorAuthBrowserTransactionStartResult,
			);
		// Act
		const response = await f.handlers.signInStartPOST(post(c.cookie, c.token), "trusted-client");
		// Assert
		await rejected(response, 503);
		expect(rows(f)).toEqual([]);
	});
	it("renders and rejects a foreign HTTPS discovery endpoint before any insert", async () => {
		// Arrange: valid SDK discovery, but the browser view rejects a foreign authorization origin.
		const f = await harness();
		f.oidc.metadata.authorization_endpoint = "https://foreign.example.test/authorize";
		const result = await createCoordinatorBrowserSigninStart(f.input);
		if (!result.ok) throw new Error("Expected valid discovery");
		f.handlers = responses(result);
		const c = await ceremony(f);
		// Act
		const response = await f.handlers.signInStartPOST(post(c.cookie, c.token), "trusted-client");
		// Assert
		await rejected(response, 503);
		expect(f.store.startAuthBrowserTransaction).not.toHaveBeenCalled();
		expect(rows(f)).toEqual([]);
	});
	it.each(["digest", "entropy"])(
		"catches %s failure before insertion without leaking its cause",
		async (fault) => {
			// Arrange
			const f = await harness();
			const c = await ceremony(f);
			if (fault === "digest")
				vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error(PRIVATE));
			else
				vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
					throw new Error(PRIVATE);
				});
			// Act
			const response = await f.handlers.signInStartPOST(post(c.cookie, c.token), "trusted-client");
			// Assert
			await rejected(response, 503);
			expect(f.store.startAuthBrowserTransaction).not.toHaveBeenCalled();
			expect(rows(f)).toEqual([]);
		},
	);
});
