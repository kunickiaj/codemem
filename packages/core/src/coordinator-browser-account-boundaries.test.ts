import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { linked } from "./coordinator-auth-session-test-fixtures.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { createCoordinatorBrowserAccount } from "./coordinator-browser-account.js";
import { BROWSER_COOKIE_NAMES, issueBrowserCookie } from "./coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	importBrowserCsrfKey,
	issueBrowserCsrfToken,
	verifyBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import { guardBrowserForm } from "./coordinator-browser-form-guard.js";

const PRIVATE = "synthetic-private-failure";
const ORIGIN = "https://app.example.test";
const config = () => ({
	enabled: true,
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.google.com",
	clientId: "fixture-client",
	clientSecret: "fixture-private-secret",
	redirectUri: `${ORIGIN}/auth/callback`,
	revision: "a".repeat(64),
});
const scope = () => ({
	publicOrigin: ORIGIN,
	store: { coordinatorId: "coordinator-a", revision: config().revision },
});
type Input = Parameters<typeof createCoordinatorBrowserAccount>[0];
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
async function harness() {
	const f = setupStore("SQLite", { authClock: () => NOW });
	databases.push(f.db);
	const key = await importBrowserCsrfKey(new Uint8Array(32).fill(7));
	const store = {
		readAuthSessionAccount: vi.fn(f.store.readAuthSessionAccount.bind(f.store)),
		readAuthSession: vi.fn(f.store.readAuthSession.bind(f.store)),
		signOutAuthSession: vi.fn(f.store.signOutAuthSession.bind(f.store)),
	};
	const limiter = {
		check: vi.fn((_key: string, _limit: number) => ({ allowed: true, retryAfterS: 0 })),
	};
	const input: Input = { config: config(), csrfKey: key, store, limiter };
	const result = await createCoordinatorBrowserAccount(input);
	if (!result.ok) throw new Error("fixture_factory_failed");
	await linked({ ...f, now: NOW, cfg: config() });
	const s = await issueBrowserCookie("session");
	const issued = await f.store.signInWithAuthAccount(
		{
			credentialHash: s.cookieHash,
			browserTransactionHash: "f".repeat(64),
			account: { issuer: config().issuer, subject: "opaque-subject-a" },
		},
		config(),
	);
	if (issued.kind !== "issued") throw new Error("fixture_session_failed");
	const cookie = s.setCookie.split(";")[0] ?? "";
	const token = await issueBrowserCsrfToken(key, s.secret, "session", scope());
	return {
		...f,
		persistence: f.store,
		store,
		limiter,
		input,
		result,
		handlers: result.handlers,
		key,
		cookie,
		token,
		s,
		session: issued.session,
	};
}
type Harness = Awaited<ReturnType<typeof harness>>;
function get(cookie: string, url = `${ORIGIN}/auth/account`, method = "GET") {
	return new Request(url, { method, headers: { cookie } });
}
function post(
	f: Pick<Harness, "cookie" | "token">,
	options: {
		origin?: string | null;
		body?: string;
		media?: string;
		url?: string;
		method?: string;
	} = {},
) {
	const headers = new Headers({
		cookie: f.cookie,
		"content-type": options.media ?? "application/x-www-form-urlencoded",
	});
	if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
	const method = options.method ?? "POST";
	return new Request(options.url ?? `${ORIGIN}/auth/logout`, {
		method,
		headers,
		body: method === "GET" ? undefined : (options.body ?? `csrf=${f.token}`),
	});
}
function noStore(f: Harness) {
	expect(f.store.readAuthSessionAccount).not.toHaveBeenCalled();
	expect(f.store.readAuthSession).not.toHaveBeenCalled();
	expect(f.store.signOutAuthSession).not.toHaveBeenCalled();
}
async function rejected(response: Response, status: number) {
	expect(response.status).toBe(status);
	expect(response.headers.getSetCookie()).toEqual([]);
	expect(response.headers.get("cache-control")).toBe("no-store");
	const body = await response.text();
	for (const value of [PRIVATE, config().clientSecret, "opaque-subject-a"])
		expect(body).not.toContain(value);
}

describe("account factory captures only explicit trusted capabilities", () => {
	it.each(["config", "csrfKey", "store", "limiter"])(
		"missing own %s is invalid_input",
		async (name) => {
			// Arrange
			const f = await harness();
			const input = { ...f.input };
			Reflect.deleteProperty(input, name);
			// Act
			const result = await createCoordinatorBrowserAccount(input);
			// Assert
			expect(result).toEqual({ ok: false, error: "invalid_input" });
			expect(Object.isFrozen(result)).toBe(true);
			noStore(f);
		},
	);
	it.each([
		[undefined, { ok: false, error: "browser_auth_disabled" }],
		[{ enabled: false }, { ok: false, error: "browser_auth_disabled" }],
		[
			{ ...config(), issuer: "https://other.example.test" },
			{ ok: false, error: "browser_auth_config_invalid", field: "issuer" },
		],
		[
			{ ...config(), clientSecret: null },
			{ ok: false, error: "browser_auth_config_invalid", field: "clientSecret" },
		],
	])("returns fixed config failure %j", async (value, expected) => {
		// Arrange
		const f = await harness();
		// Act
		const result = await createCoordinatorBrowserAccount({ ...f.input, config: value });
		// Assert
		expect(result).toEqual(expected);
		expect(Object.isFrozen(result)).toBe(true);
		expect(JSON.stringify(result)).not.toContain(config().clientSecret);
		noStore(f);
	});
	it.each(["input", "config", "store", "limiter"])(
		"rejects %s accessors without invoking getters",
		async (target) => {
			// Arrange
			const f = await harness();
			const getter = vi.fn(() => {
				throw new Error(PRIVATE);
			});
			const input = { ...f.input };
			if (target === "input") Object.defineProperty(input, "csrfKey", { get: getter });
			const originalRead = f.store.readAuthSession;
			if (target === "config")
				input.config = Object.defineProperty(config(), "issuer", { get: getter });
			if (target === "store") Object.defineProperty(f.store, "readAuthSession", { get: getter });
			if (target === "limiter") Object.defineProperty(f.limiter, "check", { get: getter });
			// Act
			const result = await createCoordinatorBrowserAccount(input);
			// Assert
			expect(result).toEqual(
				target === "config"
					? { ok: false, error: "browser_auth_config_invalid", field: "issuer" }
					: { ok: false, error: "invalid_input" },
			);
			expect(getter).not.toHaveBeenCalled();
			expect(originalRead).not.toHaveBeenCalled();
			expect(f.store.readAuthSessionAccount).not.toHaveBeenCalled();
			expect(f.store.signOutAuthSession).not.toHaveBeenCalled();
		},
	);
});
describe("captured capabilities and opaque keys", () => {
	it.each(["input", "config", "store"])("contains thrown %s proxy traps", async (target) => {
		// Arrange
		const f = await harness();
		const trap = () => {
			throw new Error(PRIVATE);
		};
		let input = { ...f.input };
		if (target === "input") input = new Proxy(input, { getOwnPropertyDescriptor: trap });
		if (target === "config") input.config = new Proxy(config(), { getPrototypeOf: trap });
		if (target === "store") input.store = new Proxy(f.store, { getOwnPropertyDescriptor: trap });
		// Act
		const result = await createCoordinatorBrowserAccount(input);
		// Assert
		expect(result).toEqual(
			target === "config"
				? { ok: false, error: "browser_auth_config_invalid", field: "config" }
				: { ok: false, error: "invalid_input" },
		);
		expect(JSON.stringify(result)).not.toContain(PRIVATE);
		noStore(f);
	});
	it.each(["own", "prototype"])(
		"captures %s function and receiver before later replacement",
		async (shape) => {
			// Arrange
			const f = await harness();
			const methods = {
				readAuthSessionAccount: vi.fn(function (
					this: unknown,
					...args: Parameters<typeof f.store.readAuthSessionAccount>
				) {
					expect(this).toBe(receiver);
					return f.store.readAuthSessionAccount(...args);
				}),
				readAuthSession: vi.fn(function (
					this: unknown,
					...args: Parameters<typeof f.store.readAuthSession>
				) {
					expect(this).toBe(receiver);
					return f.store.readAuthSession(...args);
				}),
				signOutAuthSession: vi.fn(function (
					this: unknown,
					...args: Parameters<typeof f.store.signOutAuthSession>
				) {
					expect(this).toBe(receiver);
					return f.store.signOutAuthSession(...args);
				}),
			};
			const receiver =
				shape === "own" ? { ...methods } : (Object.create(methods) as typeof methods);
			const forbidden = vi.fn(() => {
				throw new Error(PRIVATE);
			});
			for (const name of [
				"signInWithAuthAccount",
				"revokeAuthAccountLink",
				"recordAuthAccountProfile",
				"createAuthLinkAttempt",
				"finalizeAuthLinkAttempt",
				"purgeAuthGuardedSigninSessions",
				"maintainAuthBrowserTransactions",
			])
				Object.defineProperty(receiver, name, { get: forbidden });
			const cfg = config();
			const result = await createCoordinatorBrowserAccount({
				...f.input,
				config: cfg,
				store: receiver,
			});
			if (!result.ok) throw new Error("capture_fixture_failed");
			for (const name of [
				"readAuthSessionAccount",
				"readAuthSession",
				"signOutAuthSession",
			] as const)
				receiver[name] = forbidden;
			cfg.revision = "b".repeat(64);
			cfg.issuer = "https://other.example.test";
			// Act
			const page = await result.handlers.account(get(f.cookie));
			const logout = await result.handlers.logout(post(f), "trusted-client");
			// Assert
			expect(page.outcome).toBe("account_page");
			expect(logout.outcome).toBe("signed_out");
			expect(methods.readAuthSessionAccount).toHaveBeenCalledOnce();
			expect(methods.readAuthSession).toHaveBeenCalledTimes(2);
			expect(methods.signOutAuthSession).toHaveBeenCalledOnce();
			expect(forbidden).not.toHaveBeenCalled();
			expect(Object.isFrozen(result)).toBe(true);
			expect(Object.isFrozen(result.handlers)).toBe(true);
			expect(Object.isFrozen(page)).toBe(true);
		},
	);
	it("opaque forged key is accepted at construction but fails at real MAC use", async () => {
		// Arrange: real SESSION and MAC minted before substituting the opaque handle.
		const f = await harness();
		const result = await createCoordinatorBrowserAccount({
			...f.input,
			csrfKey: {} as BrowserCsrfKey,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("opaque_key_rejected_early");
		// Act
		const page = await result.handlers.account(get(f.cookie));
		const logout = await result.handlers.logout(post(f), "trusted-client");
		// Assert
		expect(page.outcome).toBe("internal_error");
		expect(logout.outcome).toBe("csrf_invalid");
		await rejected(page.response, 503);
		await rejected(logout.response, 403);
		expect(f.store.readAuthSession).not.toHaveBeenCalled();
		expect(f.store.signOutAuthSession).not.toHaveBeenCalled();
	});
});

describe("shared limiter and denied credentials", () => {
	it("all three purposes share the original limiter bucket and pinned policy", async () => {
		// Arrange: no limiter wrapper creates a separate guard registry.
		const f = await harness();
		const counts = new Map<string, number>();
		f.limiter.check.mockImplementation((key, limit) => {
			const count = (counts.get(key) ?? 0) + 1;
			counts.set(key, count);
			return { allowed: count <= limit, retryAfterS: count <= limit ? 0 : 3 };
		});
		const start = await issueBrowserCookie("start");
		const txn = await issueBrowserCookie("transaction");
		const startToken = await issueBrowserCsrfToken(f.key, start.secret, "start", scope());
		const txnToken = await issueBrowserCsrfToken(f.key, txn.secret, "transaction", scope());
		// Act
		for (let i = 0; i < 20; i++) {
			const transaction = i % 2 === 1;
			const guard = await guardBrowserForm({
				request: post(
					{
						cookie: (transaction ? txn : start).setCookie.split(";")[0] ?? "",
						token: transaction ? txnToken : startToken,
					},
					{ body: transaction ? `csrf=${txnToken}&attempt_id=attempt-a` : `csrf=${startToken}` },
				),
				scope: scope(),
				csrfKey: f.key,
				action: transaction ? "transaction_attempt" : "signin_start",
				limiter: f.limiter,
				clientKey: "trusted-client",
			});
			expect(guard.ok).toBe(true);
		}
		const reply = await f.handlers.logout(post(f), "trusted-client");
		const conflicting = await guardBrowserForm({
			request: post(f),
			scope: scope(),
			csrfKey: f.key,
			action: "session_logout",
			limiter: f.limiter,
			clientKey: "trusted-client",
			limit: 21,
		});
		// Assert
		await rejected(reply.response, 429);
		expect(conflicting).toEqual({ ok: false, error: "invalid_input" });
		expect(counts.size).toBe(1);
		expect(f.limiter.check).toHaveBeenCalledTimes(21);
		noStore(f);
	});
	it.each([
		["bad", "application/x-www-form-urlencoded", 403],
		["A".repeat(86), "application/x-www-form-urlencoded", 403],
		["TOKEN", "application/json", 415],
		["TOKEN&role=admin", "application/x-www-form-urlencoded", 400],
		["x".repeat(9000), "application/x-www-form-urlencoded", 413],
	] as const)(
		"invalid body/media %s yields %i without live lookup",
		async (token, media, status) => {
			// Arrange
			const f = await harness();
			const request = post(f, { media, body: `csrf=${token.replace("TOKEN", f.token)}` });
			// Act
			const reply = await f.handlers.logout(request, "trusted-client");
			// Assert
			await rejected(reply.response, status);
			noStore(f);
		},
	);
	it.each(["malformed", "duplicate", "other-known"])(
		"invalid %s cookie never reads LIVE",
		async (state) => {
			// Arrange
			const f = await harness();
			const cookies = {
				malformed: `${BROWSER_COOKIE_NAMES.session}=bad`,
				duplicate: `${f.cookie}; ${f.cookie}`,
				"other-known": `${f.cookie}; ${BROWSER_COOKIE_NAMES.transaction}=bad`,
			};
			// Act
			const reply = await f.handlers.logout(
				post({ ...f, cookie: cookies[state as keyof typeof cookies] }),
				"trusted-client",
			);
			// Assert
			await rejected(reply.response, 403);
			noStore(f);
		},
	);
	it.each(["start", "transaction", "other-session"])(
		"real %s MAC cannot authorize logout",
		async (purpose) => {
			// Arrange
			const f = await harness();
			const kind = purpose === "other-session" ? "session" : (purpose as "start" | "transaction");
			const other = await issueBrowserCookie(kind);
			const token =
				purpose === "other-session"
					? await issueBrowserCsrfToken(f.key, other.secret, "session", scope())
					: await issueBrowserCsrfToken(f.key, other.secret, kind, scope());
			// Act
			const reply = await f.handlers.logout(post({ ...f, token }), "trusted-client");
			// Assert
			await rejected(reply.response, 403);
			noStore(f);
		},
	);
	it("missing SESSION never authenticates a shaped token or clears cookies", async () => {
		// Arrange
		const f = await harness();
		const verify = vi.spyOn(crypto.subtle, "verify");
		// Act
		const reply = await f.handlers.logout(
			post({ cookie: "", token: "A".repeat(86) }),
			"trusted-client",
		);
		// Assert
		expect(reply.response.status).toBe(200);
		expect(reply.response.headers.getSetCookie()).toEqual([]);
		expect(verify).not.toHaveBeenCalled();
		noStore(f);
	});
});

describe("projection, crypto and snapshot boundaries", () => {
	it.each([
		"wrong-issuer",
		"identity",
		"array",
		"session-getter",
		"account-getter",
		"profile-getter",
		"throw",
	])("malformed GET projection %s fails closed", async (fault) => {
		// Arrange
		const f = await harness();
		const getter = vi.fn(() => {
			throw new Error(PRIVATE);
		});
		let projection: unknown = { session: f.session, profile: {} };
		if (fault === "wrong-issuer")
			projection = {
				session: {
					...f.session,
					account: { ...f.session.account, issuer: "https://other.example.test" },
				},
				profile: {},
			};
		if (fault === "identity")
			projection = { session: { ...f.session, identityId: "" }, profile: {} };
		if (fault === "array") projection = [];
		if (fault === "session-getter")
			projection = Object.defineProperty({ profile: {} }, "session", { get: getter });
		if (fault === "account-getter")
			projection = {
				session: Object.defineProperty({ ...f.session }, "account", { get: getter }),
				profile: {},
			};
		if (fault === "profile-getter")
			projection = Object.defineProperty({ session: f.session }, "profile", { get: getter });
		if (fault === "throw") f.store.readAuthSessionAccount.mockRejectedValue(new Error(PRIVATE));
		else f.store.readAuthSessionAccount.mockResolvedValue(projection as never);
		// Act
		const reply = await f.handlers.account(get(f.cookie));
		// Assert
		await rejected(reply.response, 503);
		expect(getter).not.toHaveBeenCalled();
		expect(f.store.signOutAuthSession).not.toHaveBeenCalled();
	});
});
describe("crypto and request snapshot failures", () => {
	it.each(["GET", "POST"])(
		"style failure on %s keeps cookies and POST touches no persistence",
		async (method) => {
			// Arrange: real token precedes mocking only style digest, not HMAC sign/verify.
			const f = await harness();
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => {
				const data =
					bytes instanceof ArrayBuffer
						? new Uint8Array(bytes)
						: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
				if (new TextDecoder().decode(data).includes(":root{")) throw new Error(PRIVATE);
				return digest(algorithm, bytes);
			});
			// Act
			const reply =
				method === "GET"
					? await f.handlers.account(get(f.cookie))
					: await f.handlers.logout(post(f), "trusted-client");
			// Assert
			await rejected(reply.response.clone(), 503);
			expect(await reply.response.text()).toBe("Account unavailable. Try again.");
			expect(f.store.signOutAuthSession).not.toHaveBeenCalled();
			expect(f.store.readAuthSession).not.toHaveBeenCalled();
		},
	);
	it.each(["sign", "digest"])(
		"GET %s failure hides private cause and retains cookie",
		async (operation) => {
			// Arrange
			const f = await harness();
			vi.spyOn(crypto.subtle, operation).mockRejectedValue(new Error(PRIVATE));
			// Act
			const reply = await f.handlers.account(get(f.cookie));
			// Assert
			await rejected(reply.response, 503);
			expect(f.store.signOutAuthSession).not.toHaveBeenCalled();
		},
	);
	it("GET MAC await holds the original cookie and profile snapshot", async () => {
		// Arrange
		const f = await harness();
		const other = await issueBrowserCookie("session");
		const request = get(f.cookie);
		const sign = crypto.subtle.sign.bind(crypto.subtle);
		vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
			request.headers.set("cookie", other.setCookie.split(";")[0] ?? "");
			await Promise.resolve();
			return sign(...args);
		});
		// Act
		const reply = await f.handlers.account(request);
		const token = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await reply.response.text())?.[1];
		// Assert
		expect(reply.outcome).toBe("account_page");
		expect(f.store.readAuthSessionAccount).toHaveBeenCalledExactlyOnceWith(
			f.s.cookieHash,
			expect.objectContaining({ revision: config().revision }),
		);
		expect(await verifyBrowserCsrfToken(f.key, f.s.secret, "session", scope(), token)).toBe(true);
		expect(await verifyBrowserCsrfToken(f.key, other.secret, "session", scope(), token)).toBe(
			false,
		);
	});
	it("POST digest await cannot switch the original session targeted for logout", async () => {
		// Arrange
		const f = await harness();
		const other = await issueBrowserCookie("session");
		expect(
			(
				await f.persistence.signInWithAuthAccount(
					{
						credentialHash: other.cookieHash,
						browserTransactionHash: "e".repeat(64),
						account: f.session.account,
					},
					config(),
				)
			).kind,
		).toBe("issued");
		const request = post(f);
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
			request.headers.set("cookie", other.setCookie.split(";")[0] ?? "");
			await Promise.resolve();
			return digest(...args);
		});
		// Act
		const reply = await f.handlers.logout(request, "trusted-client");
		// Assert
		expect(reply.outcome).toBe("signed_out");
		expect(f.store.signOutAuthSession).toHaveBeenCalledExactlyOnceWith(f.s.cookieHash, {
			coordinatorId: "coordinator-a",
		});
		expect(await f.persistence.readAuthSession(other.cookieHash, config())).not.toBeNull();
	});
	it("native Request access ignores caller-owned route and cookie getters", async () => {
		// Arrange
		const f = await harness();
		const request = post(f);
		const getter = vi.fn(() => {
			throw new Error(PRIVATE);
		});
		for (const name of ["method", "url", "headers"])
			Object.defineProperty(request, name, { get: getter });
		// Act
		const reply = await f.handlers.logout(request, "trusted-client");
		// Assert
		expect(reply.outcome).toBe("signed_out");
		expect(getter).not.toHaveBeenCalled();
	});
});
