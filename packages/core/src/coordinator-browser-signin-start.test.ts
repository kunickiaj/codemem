import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserCapability, TABLE } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { linked } from "./coordinator-auth-session-test-fixtures.js";
import { type Backend, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	BROWSER_COOKIE_NAMES,
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
} from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey, verifyBrowserCsrfToken } from "./coordinator-browser-csrf.js";
import { createCoordinatorBrowserSigninStart } from "./coordinator-browser-signin-start.js";
import { challenge, oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

const GOOGLE = "https://accounts.google.com";
const ORIGIN = "https://app.example.test";
const URL_SIGNIN = `${ORIGIN}/auth/sign-in`;
const PRIVATE = "synthetic-private-failure";
const config = () => ({
	enabled: true,
	coordinatorId: "coordinator-a",
	issuer: GOOGLE,
	redirectUri: PROVIDER.redirectUri,
	revision: "a".repeat(64),
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
});
const scope = () => ({
	publicOrigin: ORIGIN,
	store: { coordinatorId: "coordinator-a", revision: "a".repeat(64) },
});
type FactoryInput = Parameters<typeof createCoordinatorBrowserSigninStart>[0];
type FactorySuccess = Extract<
	Awaited<ReturnType<typeof createCoordinatorBrowserSigninStart>>,
	{ ok: true }
>;
function responses(result: FactorySuccess) {
	return {
		async signInPageGET(request: Request) {
			return (await result.handlers.signInPage(request)).response;
		},
		async signInStartPOST(request: Request, clientKey: string) {
			return (await result.handlers.signInStart(request, clientKey)).response;
		},
	};
}
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

async function harness(backend: Backend = "SQLite") {
	const f = setupStore(backend, { authClock: () => NOW });
	databases.push(f.db);
	const oidc = oidcFixture({ issuer: GOOGLE });
	const key = await importBrowserCsrfKey(new Uint8Array(32).fill(7));
	const store = {
		startAuthBrowserTransaction: vi.fn(f.store.startAuthBrowserTransaction.bind(f.store)),
		readAuthSession: vi.fn(f.store.readAuthSession.bind(f.store)),
	};
	const limiter = {
		check: vi.fn((_key: string, _limit: number) => ({ allowed: true, retryAfterS: 0 })),
	};
	const input: FactoryInput = {
		config: config(),
		csrfKey: key,
		store,
		limiter,
		oidcOptions: { fetch: oidc.fetch },
	};
	const result = await createCoordinatorBrowserSigninStart(input);
	if (!result.ok) throw new Error(`Unexpected fixture setup failure: ${JSON.stringify(result)}`);
	oidc.fetch.mockClear();
	return {
		...f,
		persistence: f.store,
		oidc,
		key,
		store,
		limiter,
		input,
		handlers: responses(result),
	};
}
type Harness = Awaited<ReturnType<typeof harness>>;
function get(cookie?: string, url = URL_SIGNIN, method = "GET") {
	return new Request(url, { method, headers: cookie ? { cookie } : {} });
}
function post(
	cookie: string,
	token: string,
	options: { origin?: string | null; body?: string; url?: string } = {},
) {
	const headers = new Headers({ cookie, "content-type": "application/x-www-form-urlencoded" });
	if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
	return new Request(options.url ?? URL_SIGNIN, {
		method: "POST",
		headers,
		body: options.body ?? `csrf=${token}`,
	});
}
function rows(f: Harness) {
	return f.db.prepare(`SELECT * FROM ${TABLE}`).all() as Record<string, unknown>[];
}
function snapshot(f: Harness) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables.map(({ name }) => f.db.prepare(`SELECT * FROM "${name}"`).all());
}
async function ceremony(f: Harness) {
	const response = await f.handlers.signInPageGET(get());
	const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
	const token = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await response.text())?.[1];
	if (!cookie || !token) throw new Error("Expected real start cookie and hidden CSRF token");
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
function authorization(body: string) {
	const href = /href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/.exec(body)?.[1];
	if (!href) throw new Error("Expected provider continue link");
	return new URL(href.replaceAll("&amp;", "&"));
}

describe("GET sign-in is read-only and does not restart ceremonies", () => {
	it("issues a real bound CSRF form without requiring any authenticated row", async () => {
		// Arrange
		const f = await harness();
		const before = snapshot(f);
		// Act
		const response = await f.handlers.signInPageGET(get());
		const body = await response.text();
		const cookies = response.headers.getSetCookie();
		const token = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(body)?.[1];
		const start = await readBrowserCookie(cookies[0]?.split(";")[0], "start");
		// Assert
		expect(response.status).toBe(200);
		expect(cookies).toHaveLength(1);
		expect(cookies[0]).toContain("Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax");
		expect(token).toHaveLength(86);
		expect(start.kind).toBe("present");
		if (start.kind !== "present") throw new Error("Expected start cookie");
		expect(await verifyBrowserCsrfToken(f.key, start.secret, "start", scope(), token)).toBe(true);
		expect(await verifyBrowserCsrfToken(f.key, start.secret, "session", scope(), token)).toBe(
			false,
		);
		expect(
			await verifyBrowserCsrfToken(
				f.key,
				start.secret,
				"start",
				{ ...scope(), publicOrigin: "https://other.example.test" },
				token,
			),
		).toBe(false);
		expect(snapshot(f)).toEqual(before);
		expect(f.store.readAuthSession).not.toHaveBeenCalled();
		expect(f.oidc.fetch).not.toHaveBeenCalled();
	});
	it("reuses an existing START without resetting its browser lifetime", async () => {
		// Arrange
		const f = await harness();
		const c = await ceremony(f);
		// Act
		const response = await f.handlers.signInPageGET(get(c.cookie));
		const token = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await response.text())?.[1];
		const start = await readBrowserCookie(c.cookie, "start");
		// Assert
		expect(response.status).toBe(200);
		expect(response.headers.getSetCookie()).toEqual([]);
		if (start.kind !== "present") throw new Error("Expected cookie");
		expect(await verifyBrowserCsrfToken(f.key, start.secret, "start", scope(), token)).toBe(true);
		expect(rows(f)).toEqual([]);
		expect(f.oidc.fetch).not.toHaveBeenCalled();
	});
	it.each([
		["POST", URL_SIGNIN, 405],
		["GET", `${URL_SIGNIN}?x=1`, 404],
		["GET", `${URL_SIGNIN}#x`, 404],
		["GET", `${ORIGIN}/auth/other`, 404],
		["GET", "https://other.example.test/auth/sign-in", 404],
	] as const)("rejects %s %s before store or provider", async (method, url, status) => {
		// Arrange
		const f = await harness();
		// Act
		const response = await f.handlers.signInPageGET(get(undefined, url, method));
		// Assert
		await rejected(response, status);
		if (status === 405) expect(response.headers.get("allow")).toBe("GET");
		expect(f.store.readAuthSession).not.toHaveBeenCalled();
		expect(f.store.startAuthBrowserTransaction).not.toHaveBeenCalled();
		expect(f.oidc.fetch).not.toHaveBeenCalled();
	});
	it.each(Object.values(BROWSER_COOKIE_NAMES))(
		"rejects malformed known cookie %s without clearing it",
		async (name) => {
			// Arrange
			const f = await harness();
			const before = snapshot(f);
			// Act
			const response = await f.handlers.signInPageGET(get(`${name}=bad`));
			// Assert
			await rejected(response, 400);
			expect(snapshot(f)).toEqual(before);
			expect(f.store.readAuthSession).not.toHaveBeenCalled();
		},
	);
	it("refuses Back/reload with only TXN rather than replacing a pending ceremony", async () => {
		// Arrange
		const f = await harness();
		const txn = await issueBrowserCookie("transaction");
		// Act
		const response = await f.handlers.signInPageGET(get(txn.setCookie.split(";")[0]));
		// Assert
		await rejected(response, 409);
		expect(rows(f)).toEqual([]);
		expect(f.oidc.fetch).not.toHaveBeenCalled();
	});
});

describe("POST guard priority and no implicit authority", () => {
	it.each([
		["GET", URL_SIGNIN, 405],
		["POST", `${URL_SIGNIN}?x=1`, 404],
		["POST", `${URL_SIGNIN}#x`, 404],
		["POST", `${ORIGIN}/auth/account`, 404],
	] as const)(
		"rejects POST-handler routing %s %s without quota or writes",
		async (method, url, status) => {
			// Arrange
			const f = await harness();
			const request = new Request(url, { method });
			// Act
			const response = await f.handlers.signInStartPOST(request, "trusted-client");
			// Assert
			await rejected(response, status);
			if (status === 405) expect(response.headers.get("allow")).toBe("POST");
			expect(f.limiter.check).not.toHaveBeenCalled();
			expect(f.store.startAuthBrowserTransaction).not.toHaveBeenCalled();
			expect(f.oidc.fetch).not.toHaveBeenCalled();
		},
	);
	it.each(["absent-start", "bad-txn", "duplicate-start"])(
		"rejects %s cookies without admission",
		async (fault) => {
			// Arrange
			const f = await harness();
			const c = await ceremony(f);
			const cookies = {
				"absent-start": "other=value",
				"bad-txn": `${c.cookie}; ${BROWSER_COOKIE_NAMES.transaction}=bad`,
				"duplicate-start": `${c.cookie}; ${c.cookie}`,
			};
			// Act
			const response = await f.handlers.signInStartPOST(
				post(cookies[fault as keyof typeof cookies], c.token),
				"trusted-client",
			);
			// Assert
			await rejected(response, fault === "absent-start" ? 403 : 400);
			expect(rows(f)).toEqual([]);
			expect(f.store.startAuthBrowserTransaction).not.toHaveBeenCalled();
		},
	);
	it.each([null, "null", "https://other.example.test", `${ORIGIN}/`])(
		"rejects Origin %j before quota, body, database or provider",
		async (origin) => {
			// Arrange
			const f = await harness();
			const c = await ceremony(f);
			const request = post(c.cookie, c.token, { origin });
			// Act
			const response = await f.handlers.signInStartPOST(request, "trusted-client");
			// Assert
			await rejected(response, 403);
			expect(request.bodyUsed).toBe(false);
			expect(f.limiter.check).not.toHaveBeenCalled();
			expect(f.store.readAuthSession).not.toHaveBeenCalled();
			expect(rows(f)).toEqual([]);
			expect(f.oidc.fetch).not.toHaveBeenCalled();
		},
	);
	it("preserves the original limiter and default twenty-request policy", async () => {
		// Arrange
		const f = await harness();
		const c = await ceremony(f);
		f.limiter.check.mockReturnValue({ allowed: false, retryAfterS: 9 });
		// Act
		const response = await f.handlers.signInStartPOST(post(c.cookie, c.token), "trusted-client");
		// Assert
		await rejected(response, 429);
		expect(f.limiter.check).toHaveBeenCalledWith(
			JSON.stringify(["browser-form", "coordinator-a", "trusted-client"]),
			20,
		);
		expect(response.headers.get("retry-after")).toBe("9");
		expect(rows(f)).toEqual([]);
	});
	it.each([
		["csrf=bad", 403],
		[`csrf=${"A".repeat(86)}`, 403],
		["csrf=TOKEN&role=admin", 400],
		["csrf=TOKEN&issuer=https%3A%2F%2Fevil.example.test", 400],
	] as const)("rejects untrusted form %s", async (body, status) => {
		// Arrange
		const f = await harness();
		const c = await ceremony(f);
		// Act
		const response = await f.handlers.signInStartPOST(
			post(c.cookie, c.token, { body: body.replace("TOKEN", c.token) }),
			"trusted-client",
		);
		// Assert
		await rejected(response, status);
		expect(rows(f)).toEqual([]);
		expect(f.store.readAuthSession).not.toHaveBeenCalled();
		expect(f.oidc.fetch).not.toHaveBeenCalled();
	});
});

describe("existing transaction takes priority after transport gates", () => {
	it.each(["valid", "missing-start", "invalid-form", "bad-mac"])(
		"existing TXN wins over %s without admission",
		async (caseName) => {
			// Arrange
			const f = await harness();
			const c = await ceremony(f);
			const txn = await issueBrowserCookie("transaction");
			const cookie = [caseName === "missing-start" ? "" : c.cookie, txn.setCookie.split(";")[0]]
				.filter(Boolean)
				.join("; ");
			const body =
				caseName === "invalid-form"
					? "unknown=value"
					: `csrf=${caseName === "bad-mac" ? "A".repeat(86) : c.token}`;
			// Act
			const response = await f.handlers.signInStartPOST(
				post(cookie, c.token, { body }),
				"trusted-client",
			);
			// Assert
			await rejected(response, 409);
			expect(rows(f)).toEqual([]);
			expect(f.store.startAuthBrowserTransaction).not.toHaveBeenCalled();
		},
	);
	it.each(["origin", "rate", "client"])(
		"%s transport failure still precedes an existing TXN",
		async (fault) => {
			// Arrange
			const f = await harness();
			const txn = await issueBrowserCookie("transaction");
			if (fault === "rate") f.limiter.check.mockReturnValue({ allowed: false, retryAfterS: 1 });
			// Act
			const response = await f.handlers.signInStartPOST(
				post(txn.setCookie.split(";")[0] ?? "", "bad", {
					origin: fault === "origin" ? null : ORIGIN,
				}),
				fault === "client" ? "" : "trusted-client",
			);
			// Assert
			const status = { origin: 403, rate: 429, client: 503 }[fault];
			await rejected(response, status ?? 503);
			expect(f.store.startAuthBrowserTransaction).not.toHaveBeenCalled();
		},
	);
});

describe.each(["SQLite", "D1"] as const)("%s durable sign-in admission", (backend) => {
	it("persists only SDK-generated materials then promotes identical START bytes", async () => {
		// Arrange
		const f = await harness(backend);
		const c = await ceremony(f);
		const start = await readBrowserCookie(c.cookie, "start");
		// Act
		const response = await f.handlers.signInStartPOST(post(c.cookie, c.token), "trusted-client");
		const body = await response.text();
		const url = authorization(body);
		const row = rows(f)[0];
		// Assert
		expect(response.status).toBe(200);
		expect(rows(f)).toHaveLength(1);
		if (start.kind !== "present") throw new Error("Expected cookie");
		expect(row).toMatchObject({
			purpose: "signin",
			state: "pending",
			binder_hash: start.cookieHash,
			state_hash: createHash("sha256")
				.update(url.searchParams.get("state") ?? "", "utf8")
				.digest("hex"),
			nonce: url.searchParams.get("nonce"),
			issuer: GOOGLE,
			auth_config_revision: config().revision,
			redirect_uri: PROVIDER.redirectUri,
		});
		expect(await challenge(String(row?.pkce_verifier))).toBe(
			url.searchParams.get("code_challenge"),
		);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("client_id")).toBe(PROVIDER.clientId);
		expect(url.searchParams.get("redirect_uri")).toBe(PROVIDER.redirectUri);
		expect(url.searchParams.get("state")).toBeTruthy();
		expect(url.searchParams.get("nonce")).toBeTruthy();
		for (const secret of [String(row?.pkce_verifier), start.cookieHash, PROVIDER.clientSecret])
			expect(body).not.toContain(secret);
		expect(response.headers.getSetCookie()).toEqual([
			`${BROWSER_COOKIE_NAMES.transaction}=${c.cookie.split("=")[1]}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`,
			clearBrowserCookie("start"),
		]);
		expect(f.oidc.fetch).not.toHaveBeenCalled();
		expect(f.db.prepare("SELECT * FROM coordinator_auth_sessions").all()).toEqual([]);
		expect(f.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual([]);
	});
	it("lost-response replay retains the first row without cookies or a lifetime reset", async () => {
		// Arrange
		const f = await harness(backend);
		const c = await ceremony(f);
		await f.handlers.signInStartPOST(post(c.cookie, c.token), "trusted-client");
		const first = rows(f);
		// Act
		const replay = await f.handlers.signInStartPOST(post(c.cookie, c.token), "trusted-client");
		// Assert
		await rejected(replay, 409);
		expect(rows(f)).toEqual(first);
	});
	it("eight independently gated calls through two store instances share one unique binder", async () => {
		// Arrange: distinct store instances share the fixture's SQLite connection; not separate connections.
		const f = await harness(backend);
		const c = await ceremony(f);
		const second =
			backend === "D1"
				? new D1CoordinatorStore(sqliteD1(f.db), { authClock: () => NOW })
				: browserCapability({ ...f, store: f.persistence, now: NOW, cfg: config() });
		const gate = Promise.withResolvers<void>();
		let arrived = 0;
		const allArrived = Promise.withResolvers<void>();
		const makeStore = (start: typeof f.store.startAuthBrowserTransaction) => ({
			readAuthSession: f.store.readAuthSession,
			async startAuthBrowserTransaction(...args: Parameters<typeof start>) {
				arrived++;
				if (arrived === 8) allArrived.resolve();
				await gate.promise;
				return start(...args);
			},
		});
		const left = await createCoordinatorBrowserSigninStart({
			...f.input,
			store: makeStore(f.store.startAuthBrowserTransaction),
		});
		const right = await createCoordinatorBrowserSigninStart({
			...f.input,
			store: makeStore(vi.fn(second.startAuthBrowserTransaction.bind(second))),
		});
		if (!left.ok || !right.ok) throw new Error("Expected two handlers");
		// Act
		const pending = Array.from({ length: 8 }, (_, index) =>
			responses(index % 2 === 0 ? left : right).signInStartPOST(
				post(c.cookie, c.token),
				`client-${index}`,
			),
		);
		await allArrived.promise;
		gate.resolve();
		const completed = await Promise.all(pending);
		// Assert
		expect(completed.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
		expect(rows(f)).toHaveLength(1);
		for (const response of completed)
			expect(response.headers.getSetCookie()).toHaveLength(response.status === 200 ? 2 : 0);
	});
	it("binder uniqueness lasts for retained rows, not forever or for a MAC expiry claim", async () => {
		// Arrange: simulate fixture-owned retirement/purge; handlers have no maintenance capability.
		const f = await harness(backend);
		const c = await ceremony(f);
		await f.handlers.signInStartPOST(post(c.cookie, c.token), "trusted-client");
		f.db.prepare(`UPDATE ${TABLE} SET state='expired', nonce=NULL, pkce_verifier=NULL`).run();
		// Act
		const retained = await f.handlers.signInStartPOST(post(c.cookie, c.token), "trusted-client");
		f.db.prepare(`DELETE FROM ${TABLE}`).run();
		const purged = await f.handlers.signInStartPOST(post(c.cookie, c.token), "trusted-client");
		// Assert
		await rejected(retained, 409);
		expect(purged.status).toBe(200);
		expect(purged.headers.getSetCookie()).toHaveLength(2);
		expect(rows(f)).toHaveLength(1);
	});
});

describe.each(["SQLite", "D1"] as const)("%s current-session behavior", (backend) => {
	it.each(["live", "expired", "revoked", "config-changed"])(
		"looks up %s SESSION using current trusted config without clearing it",
		async (state) => {
			// Arrange
			const f = await harness(backend);
			const lf = { ...f, store: f.persistence, now: NOW, cfg: config() };
			await linked(lf);
			const session = await issueBrowserCookie("session");
			expect(
				await f.persistence.signInWithAuthAccount(
					{
						browserTransactionHash: "f".repeat(64),
						credentialHash: session.cookieHash,
						account: { issuer: GOOGLE, subject: "opaque-subject-a" },
					},
					config(),
				),
			).toMatchObject({ kind: "issued" });
			if (state === "expired")
				f.db
					.prepare("UPDATE coordinator_auth_sessions SET created_at_ms = ?, expires_at_ms = ?")
					.run(NOW - 28800000, NOW);
			if (state === "revoked")
				f.db.prepare("UPDATE coordinator_auth_sessions SET revoked_at_ms = ?").run(NOW);
			if (state === "config-changed")
				f.db
					.prepare("UPDATE coordinator_auth_sessions SET auth_config_revision = ?")
					.run("b".repeat(64));
			const before = snapshot(f);
			// Act
			const response = await f.handlers.signInPageGET(get(session.setCookie.split(";")[0]));
			// Assert
			expect(response.status).toBe(state === "live" ? 303 : 200);
			if (state === "live") expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/account`);
			expect(f.store.readAuthSession).toHaveBeenCalledWith(
				session.cookieHash,
				expect.objectContaining({
					coordinatorId: "coordinator-a",
					revision: config().revision,
					issuer: GOOGLE,
				}),
			);
			expect(
				response.headers
					.getSetCookie()
					.some((value) => value.startsWith(`${BROWSER_COOKIE_NAMES.session}=`)),
			).toBe(false);
			expect(snapshot(f)).toEqual(before);
			expect(f.oidc.fetch).not.toHaveBeenCalled();
		},
	);
});

describe("request snapshots survive asynchronous cookie mutations", () => {
	it("ignores caller-owned Request getters rather than reading shadowed route or cookies", async () => {
		// Arrange
		const f = await harness();
		const c = await ceremony(f);
		const request = post(c.cookie, c.token);
		const getter = vi.fn(() => {
			throw new Error(PRIVATE);
		});
		for (const name of ["method", "url", "headers"])
			Object.defineProperty(request, name, { get: getter });
		// Act
		const response = await f.handlers.signInStartPOST(request, "trusted-client");
		// Assert
		expect(response.status).toBe(200);
		expect(getter).not.toHaveBeenCalled();
		expect(rows(f)).toHaveLength(1);
	});
	it.each(["live", "missing", "bad-mac"])(
		"checks SESSION only after a valid START MAC: %s",
		async (state) => {
			// Arrange
			const f = await harness();
			const c = await ceremony(f);
			const session = await issueBrowserCookie("session");
			if (state !== "missing") {
				await linked({ ...f, store: f.persistence, now: NOW, cfg: config() });
				expect(
					await f.persistence.signInWithAuthAccount(
						{
							browserTransactionHash: "f".repeat(64),
							credentialHash: session.cookieHash,
							account: { issuer: GOOGLE, subject: "opaque-subject-a" },
						},
						config(),
					),
				).toMatchObject({ kind: "issued" });
			}
			const request = post(
				`${c.cookie}; ${session.setCookie.split(";")[0]}`,
				state === "bad-mac" ? "A".repeat(86) : c.token,
			);
			f.store.readAuthSession.mockImplementation(async (...args) => {
				request.headers.delete("cookie");
				await Promise.resolve();
				return f.persistence.readAuthSession(...args);
			});
			// Act
			const response = await f.handlers.signInStartPOST(request, "trusted-client");
			// Assert
			if (state === "bad-mac") {
				await rejected(response, 403);
				expect(f.store.readAuthSession).not.toHaveBeenCalled();
			} else {
				expect(response.status).toBe(state === "live" ? 303 : 200);
				expect(f.store.readAuthSession).toHaveBeenCalledWith(
					session.cookieHash,
					expect.objectContaining({ revision: config().revision }),
				);
				if (state === "live") {
					expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/account`);
					expect(response.headers.getSetCookie()).toEqual([]);
				} else expect(response.headers.getSetCookie()[0]).toContain(c.cookie.split("=")[1]);
			}
			expect(rows(f)).toHaveLength(state === "missing" ? 1 : 0);
		},
	);
	it.each(["replace-start", "add-txn", "remove-txn"])(
		"uses original cookies when callbacks %s",
		async (mutation) => {
			// Arrange
			const f = await harness();
			const c = await ceremony(f);
			const alternate = await issueBrowserCookie("start");
			const txn = await issueBrowserCookie("transaction");
			const cookie =
				mutation === "remove-txn" ? `${c.cookie}; ${txn.setCookie.split(";")[0]}` : c.cookie;
			const request = post(cookie, c.token);
			f.limiter.check.mockImplementation(() => {
				request.headers.set(
					"cookie",
					mutation === "add-txn"
						? `${c.cookie}; ${txn.setCookie.split(";")[0]}`
						: (alternate.setCookie.split(";")[0] ?? ""),
				);
				return { allowed: true, retryAfterS: 0 };
			});
			// Act
			const response = await f.handlers.signInStartPOST(request, "trusted-client");
			// Assert
			if (mutation === "remove-txn") {
				await rejected(response, 409);
				expect(rows(f)).toEqual([]);
			} else {
				expect(response.status).toBe(200);
				const original = await readBrowserCookie(c.cookie, "start");
				if (original.kind !== "present") throw new Error("Expected cookie");
				expect(rows(f)[0]?.binder_hash).toBe(original.cookieHash);
				expect(response.headers.getSetCookie()[0]).toContain(c.cookie.split("=")[1]);
			}
		},
	);
});
