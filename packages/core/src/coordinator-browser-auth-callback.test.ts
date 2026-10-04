import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserCapability, TABLE } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { linked } from "./coordinator-auth-session-test-fixtures.js";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { createCoordinatorBrowserAuthCallback } from "./coordinator-browser-auth-callback.js";
import {
	BROWSER_COOKIE_NAMES,
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
} from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { createCoordinatorBrowserSigninStart } from "./coordinator-browser-signin-start.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";

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
function publicConfig() {
	const { clientId: _clientId, clientSecret: _clientSecret, ...publicValue } = config();
	return publicValue;
}
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

async function harness(backend: Backend = "SQLite") {
	const f = setupStore(backend, { authClock: () => NOW });
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
	const completeLink = vi.fn(async () => new Response("link", { status: 202 }));
	const input = { config: config(), store, completeLink, oidcOptions: { fetch: oidc.fetch } };
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
function authority(f: Harness) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	const allowed = new Set([
		TABLE,
		"coordinator_auth_sessions",
		"coordinator_auth_session_receipts",
		"coordinator_auth_account_profiles",
	]);
	return tables.filter(({ name }) => !allowed.has(name)).map(({ name }) => [name, rows(f, name)]);
}
async function ceremony(f: Harness) {
	const page = await f.start.signInPage(new Request(`${ORIGIN}/auth/sign-in`));
	const startCookie = page.response.headers.getSetCookie()[0]?.split(";")[0];
	const csrf = /name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await page.response.text())?.[1];
	if (!startCookie || !csrf) throw new Error("Expected real HMAC ceremony");
	const start = await f.start.signInStart(
		new Request(`${ORIGIN}/auth/sign-in`, {
			method: "POST",
			headers: {
				cookie: startCookie,
				origin: ORIGIN,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: `csrf=${csrf}`,
		}),
		"trusted-client",
	);
	const href = /href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/.exec(
		await start.response.text(),
	)?.[1];
	const cookie = start.response.headers.getSetCookie()[0]?.split(";")[0];
	if (!href || !cookie) throw new Error("Expected admitted provider link and TXN cookie");
	const authorization = new URL(href.replaceAll("&amp;", "&"));
	const stateHash = createHash("sha256")
		.update(authorization.searchParams.get("state") ?? "")
		.digest("hex");
	const original = rows(f).find((row) => row.state_hash === stateHash);
	if (!original) throw new Error("Expected matching transaction row");
	return {
		cookie,
		authorization,
		url: f.oidc.authorize(authorization),
		original: { ...original },
	};
}
type Ceremony = Awaited<ReturnType<typeof ceremony>>;
function request(c: Ceremony, cookie = c.cookie) {
	return new Request(c.url, { headers: { cookie } });
}
function consumed(f: Harness) {
	expect(rows(f)[0]).toMatchObject({
		state: "consumed",
		nonce: null,
		pkce_verifier: null,
		consumed_at_ms: NOW,
	});
}
async function privateSafe(response: Response, c: Ceremony, outcome: unknown) {
	const visible = JSON.stringify({
		body: await response.clone().text(),
		headers: [...response.headers],
		outcome,
	});
	for (const secret of [
		PROVIDER.clientSecret,
		"fixture-access-token",
		"fixture-refresh-token",
		c.url.searchParams.get("code"),
		c.original.nonce,
		c.original.pkce_verifier,
		c.original.binder_hash,
		c.original.state_hash,
		c.original.browser_transaction_hash,
	]) {
		if (typeof secret === "string") expect(visible).not.toContain(secret);
	}
}
function providerAfterConsume(f: Harness) {
	const transport = f.oidc.fetch.getMockImplementation();
	if (!transport) throw new Error("Expected fixture transport");
	const observations: { url: string; rows: Record<string, unknown>[] }[] = [];
	f.oidc.fetch.mockImplementation(async (url, options) => {
		observations.push({ url, rows: rows(f) });
		return transport(url, options);
	});
	return observations;
}
function assertProviderProof(observations: ReturnType<typeof providerAfterConsume>, c: Ceremony) {
	for (const observed of observations) {
		expect(
			observed.rows.find(
				(row) => row.browser_transaction_hash === c.original.browser_transaction_hash,
			),
		).toMatchObject({ state: "consumed", nonce: null, pkce_verifier: null });
	}
}

describe.each(["SQLite", "D1"] as const)(
	"%s callback uses original durable proof before SDK exchange",
	(backend) => {
		it("issues one fresh guarded session and ID-token profile, without granting new authority", async () => {
			// Arrange: D1 here is the existing SQLite-backed adapter, not a remote service.
			const f = await harness(backend);
			await linked({ ...f, store: f.persistence });
			const c = await ceremony(f);
			const before = authority(f);
			const observations = providerAfterConsume(f);
			f.store.recordAuthAccountProfile.mockImplementation(async (...args) => {
				expect(rows(f, "coordinator_auth_sessions")).toHaveLength(1);
				return f.persistence.recordAuthAccountProfile(...args);
			});
			// Act: approved OAuth GET exception has no Origin, limiter or client-key input.
			const reply = await f.callback(request(c));
			const cookies = reply.response.headers.getSetCookie();
			const session = await readBrowserCookie(cookies[0]?.split(";")[0], "session");
			// Assert
			expect(reply.response.status).toBe(303);
			expect(reply.response.headers.get("location")).toBe(`${ORIGIN}/auth/account`);
			expect(cookies).toHaveLength(2);
			expect(cookies[0]).toMatch(
				/^__Host-codemem-session=[A-Za-z0-9_-]{43}; Max-Age=28800; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
			);
			expect(cookies[1]).toBe(clearBrowserCookie("transaction"));
			if (session.kind !== "present") throw new Error("Expected fresh session credential");
			const raw = cookies[0]?.split(";")[0]?.split("=")[1] ?? "";
			expect(session.cookieHash).toBe(
				createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex"),
			);
			expect(raw).not.toBe(c.cookie.split("=")[1]);
			expect(rows(f, "coordinator_auth_sessions")[0]).toMatchObject({
				credential_hash: session.cookieHash,
				browser_transaction_hash: c.original.browser_transaction_hash,
				subject: "opaque-subject-a",
			});
			expect(rows(f, "coordinator_auth_session_receipts")).toEqual([
				expect.objectContaining({ source: "signin", purge_eligible: 1, attempt_id: null }),
			]);
			expect(rows(f, "coordinator_auth_account_profiles")[0]).toMatchObject({
				display_name: "Fixture User",
				email: "user@example.test",
				source_session_id: rows(f, "coordinator_auth_sessions")[0]?.session_id,
			});
			expect(f.store.consumeAuthBrowserTransaction).toHaveBeenCalledWith(
				{ stateHash: c.original.state_hash, binderHash: c.original.binder_hash },
				publicConfig(),
			);
			expect(f.store.signInWithConsumedBrowserTransaction).toHaveBeenCalledOnce();
			expect(f.completeLink).not.toHaveBeenCalled();
			expect(f.oidc.requests.some((r) => r.url.endsWith("/userinfo"))).toBe(false);
			expect(f.oidc.requests.find((r) => r.url.endsWith("/token"))?.options.body).toBeInstanceOf(
				URLSearchParams,
			);
			expect(authority(f)).toEqual(before);
			consumed(f);
			expect(observations.some(({ url }) => url.endsWith("/token"))).toBe(true);
			assertProviderProof(observations, c);
			await privateSafe(reply.response, c, reply.outcome);
		});
		it("replay does not clear cookies belonging to a later browser ceremony", async () => {
			// Arrange
			const f = await harness(backend);
			await linked({ ...f, store: f.persistence });
			const c = await ceremony(f);
			await f.callback(request(c));
			const before = rows(f, "coordinator_auth_sessions");
			f.oidc.fetch.mockClear();
			// Act
			const reply = await f.callback(request(c));
			// Assert
			expect(reply.response.status).toBe(403);
			expect(reply.response.headers.getSetCookie()).toEqual([]);
			expect(rows(f, "coordinator_auth_sessions")).toEqual(before);
			expect(f.oidc.fetch).not.toHaveBeenCalled();
		});
	},
);

describe("pre-consume guards never burn another browser's row", () => {
	it.each([
		["method", 405],
		["origin", 404],
		["path", 404],
		["fragment", 400],
		["long-url", 400],
		["missing-state", 400],
		["duplicate-state", 400],
		["short-state", 400],
		["long-state", 400],
		["bad-state", 400],
		["missing-cookie", 403],
		["bad-cookie", 400],
		["duplicate-cookie", 400],
		["wrong-browser", 403],
		["unknown-state", 403],
		["revision", 403],
	] as const)("rejects %s with %s and no cookie mutation/provider call", async (fault, status) => {
		// Arrange
		const f = await harness();
		const c = await ceremony(f);
		let cookie = c.cookie;
		let method = "GET";
		const mutations: Record<string, () => unknown> = {
			method: () => {
				method = "POST";
			},
			origin: () => {
				c.url.hostname = "other.example.test";
			},
			path: () => {
				c.url.pathname = "/auth/other";
			},
			fragment: () => {
				c.url.hash = "fragment";
			},
			"long-url": () => c.url.searchParams.set("extra", "x".repeat(8192)),
			"missing-state": () => c.url.searchParams.delete("state"),
			"duplicate-state": () =>
				c.url.searchParams.append("state", c.url.searchParams.get("state") ?? ""),
			"short-state": () => c.url.searchParams.set("state", "s".repeat(42)),
			"long-state": () => c.url.searchParams.set("state", "s".repeat(129)),
			"bad-state": () => c.url.searchParams.set("state", `${"s".repeat(43)}+`),
			"unknown-state": () => c.url.searchParams.set("state", "s".repeat(43)),
			"missing-cookie": () => {
				cookie = "other=value";
			},
			"bad-cookie": () => {
				cookie = `${BROWSER_COOKIE_NAMES.transaction}=bad`;
			},
			"duplicate-cookie": () => {
				cookie = `${c.cookie}; ${c.cookie}`;
			},
			"wrong-browser": async () => {
				cookie = (await issueBrowserCookie("transaction")).setCookie.split(";")[0] ?? "";
			},
			revision: () =>
				f.db.prepare(`UPDATE ${TABLE} SET auth_config_revision=?`).run("b".repeat(64)),
		};
		await mutations[fault]?.();
		const before = rows(f);
		// Act
		const reply = await f.callback(new Request(c.url, { method, headers: { cookie } }));
		// Assert
		expect(reply.response.status).toBe(status);
		if (fault === "fragment") {
			expect(reply.outcome).toBe("callback_invalid");
			expect(f.store.consumeAuthBrowserTransaction).not.toHaveBeenCalled();
		}
		if (status === 405) expect(reply.response.headers.get("allow")).toBe("GET");
		expect(reply.response.headers.getSetCookie()).toEqual([]);
		expect(rows(f)).toEqual(before);
		expect(f.oidc.fetch).not.toHaveBeenCalled();
		expect(f.store.signInWithConsumedBrowserTransaction).not.toHaveBeenCalled();
		expect(f.store.recordAuthAccountProfile).not.toHaveBeenCalled();
		await privateSafe(reply.response, c, reply.outcome);
	});
	it("accepts decoded percent-equivalent state and unknown Google query parameters", async () => {
		// Arrange
		const f = await harness();
		await linked({ ...f, store: f.persistence });
		const c = await ceremony(f);
		const state = c.url.searchParams.get("state") ?? "";
		c.url.searchParams.set("authuser", "0");
		c.url.searchParams.set("prompt", "consent");
		const encoded = c.url.href.replace(
			`state=${state}`,
			`state=%${state.charCodeAt(0).toString(16)}${state.slice(1)}`,
		);
		// Act
		const reply = await f.callback(new Request(encoded, { headers: { cookie: c.cookie } }));
		// Assert: the maintained SDK interprets decoded parameters, not a raw-percent oracle.
		expect(reply.response.status).toBe(303);
		consumed(f);
		expect(rows(f, "coordinator_auth_sessions")).toHaveLength(1);
	});
});

describe("actual SDK rejects token and authorization protocol attacks after consuming only the matching row", () => {
	it.each([
		"modified-signature",
		"wrong-key",
		"none",
		"missing-id",
		"nonce",
		"issuer",
		"audience",
		"expired",
		"pkce",
		"invalid-grant",
		"access-denied",
		"missing-code",
		"duplicate-code",
		"code-and-error",
		"response-issuer",
	])("burns proof for %s without issuing any session", async (fault) => {
		// Arrange
		const f = await harness();
		await linked({ ...f, store: f.persistence });
		const c = await ceremony(f);
		const victim = await ceremony(f);
		const before = authority(f);
		const attacks: Record<string, () => unknown> = {
			"modified-signature": () => {
				f.oidc.settings.signature = "modified";
			},
			"wrong-key": () => {
				f.oidc.settings.signature = "wrong-key";
			},
			none: () => {
				f.oidc.settings.alg = "none";
			},
			"missing-id": () => {
				f.oidc.settings.omitIdToken = true;
			},
			nonce: () => {
				f.oidc.claims.nonce = "wrong-nonce";
			},
			issuer: () => {
				f.oidc.claims.iss = "https://wrong.example.test";
			},
			audience: () => {
				f.oidc.claims.aud = "wrong-client";
			},
			expired: () => {
				f.oidc.claims.exp = 1;
			},
			pkce: () => {
				c.url = f.oidc.authorize(c.authorization, { challenge: "wrong-challenge" });
			},
			"invalid-grant": () => c.url.searchParams.set("code", "unknown-code"),
			"access-denied": () => {
				c.url.searchParams.delete("code");
				c.url.searchParams.set("error", "access_denied");
			},
			"missing-code": () => c.url.searchParams.delete("code"),
			"duplicate-code": () => c.url.searchParams.append("code", "second-code"),
			"code-and-error": () => c.url.searchParams.set("error", "access_denied"),
			"response-issuer": () => c.url.searchParams.set("iss", "https://wrong.example.test"),
		};
		attacks[fault]?.();
		const observations = providerAfterConsume(f);
		// Act
		const reply = await f.callback(request(c));
		// Assert
		expect(reply.response.status).toBe(403);
		expect(reply.response.headers.getSetCookie()).toEqual([clearBrowserCookie("transaction")]);
		consumed(f);
		assertProviderProof(observations, c);
		if (
			![
				"access-denied",
				"missing-code",
				"duplicate-code",
				"code-and-error",
				"response-issuer",
			].includes(fault)
		)
			expect(observations.some(({ url }) => url.endsWith("/token"))).toBe(true);
		expect(rows(f)[1]).toEqual(victim.original);
		expect(rows(f, "coordinator_auth_sessions")).toEqual([]);
		expect(f.store.signInWithConsumedBrowserTransaction).not.toHaveBeenCalled();
		expect(f.store.recordAuthAccountProfile).not.toHaveBeenCalled();
		expect(authority(f)).toEqual(before);
		await privateSafe(reply.response, c, reply.outcome);
	});
});

describe("guarded admission and existing session preservation", () => {
	it.each(["unlinked", "revoked", "coordinator", "ten-sessions", "transaction-config"])(
		"returns the same generic denial for %s",
		async (fault) => {
			// Arrange
			const f = await harness();
			if (fault !== "unlinked") await linked({ ...f, store: f.persistence });
			const c = await ceremony(f);
			if (fault === "revoked")
				f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms=?").run(NOW);
			if (fault === "coordinator")
				f.store.signInWithConsumedBrowserTransaction.mockImplementation(async (...args) => {
					f.db.prepare(`UPDATE ${TABLE} SET coordinator_id=?`).run("other-coordinator");
					return f.persistence.signInWithConsumedBrowserTransaction(...args);
				});
			if (fault === "ten-sessions")
				for (let i = 0; i < 10; i++) {
					expect(
						await f.persistence.signInWithAuthAccount(
							{
								browserTransactionHash: createHash("sha256").update(`browser-${i}`).digest("hex"),
								credentialHash: createHash("sha256").update(`credential-${i}`).digest("hex"),
								account: { issuer: f.cfg.issuer, subject: "opaque-subject-a" },
							},
							f.cfg,
						),
					).toMatchObject({ kind: "issued" });
				}
			if (fault === "transaction-config")
				f.store.signInWithConsumedBrowserTransaction.mockImplementation(async (...args) => {
					f.db.prepare(`UPDATE ${TABLE} SET auth_config_revision=?`).run("b".repeat(64));
					return f.persistence.signInWithConsumedBrowserTransaction(...args);
				});
			const before = rows(f, "coordinator_auth_sessions");
			const generic = await f.callback(new Request(PROVIDER.redirectUri));
			// Act
			const reply = await f.callback(request(c));
			// Assert
			expect(reply.response.status).toBe(403);
			expect(await reply.response.clone().text()).toBe(await generic.response.text());
			expect(reply.response.headers.getSetCookie()).toEqual([clearBrowserCookie("transaction")]);
			expect(rows(f, "coordinator_auth_sessions")).toEqual(before);
			expect(f.store.recordAuthAccountProfile).not.toHaveBeenCalled();
			consumed(f);
		},
	);
	it.each(["same-account", "different-account"])(
		"preserves live original SESSION for %s after SDK verification",
		async (account) => {
			// Arrange
			const f = await harness();
			await linked({ ...f, store: f.persistence });
			const c = await ceremony(f);
			const old = await issueBrowserCookie("session");
			expect(
				await f.persistence.signInWithAuthAccount(
					{
						browserTransactionHash: "f".repeat(64),
						credentialHash: old.cookieHash,
						account: { issuer: f.cfg.issuer, subject: "opaque-subject-a" },
					},
					f.cfg,
				),
			).toMatchObject({ kind: "issued" });
			if (account === "different-account") f.oidc.claims.sub = "different-account";
			const before = rows(f, "coordinator_auth_sessions");
			const receipts = rows(f, "coordinator_auth_session_receipts");
			const req = request(c, `${c.cookie}; ${old.setCookie.split(";")[0]}`);
			f.store.consumeAuthBrowserTransaction.mockImplementation(async (...args) => {
				req.headers.delete("cookie");
				return f.persistence.consumeAuthBrowserTransaction(...args);
			});
			// Act
			const reply = await f.callback(req);
			// Assert: no account switch, rotation, false sign-in receipt, or profile write.
			expect(reply.response.status).toBe(303);
			expect(reply.response.headers.get("location")).toBe(`${ORIGIN}/auth/account`);
			expect(reply.response.headers.getSetCookie()).toEqual([clearBrowserCookie("transaction")]);
			expect(f.store.readAuthSession).toHaveBeenCalledWith(old.cookieHash, publicConfig());
			expect(rows(f, "coordinator_auth_sessions")).toEqual(before);
			expect(rows(f, "coordinator_auth_session_receipts")).toEqual(receipts);
			expect(f.store.signInWithConsumedBrowserTransaction).not.toHaveBeenCalled();
			expect(f.store.recordAuthAccountProfile).not.toHaveBeenCalled();
			expect(f.oidc.fetch).toHaveBeenCalled();
		},
	);
	it.each(["throw", "not-recorded", "rejected"])(
		"keeps an issued session despite profile follow-up %s",
		async (fault) => {
			// Arrange
			const f = await harness();
			await linked({ ...f, store: f.persistence });
			const c = await ceremony(f);
			if (fault === "throw")
				f.store.recordAuthAccountProfile.mockRejectedValue(new Error(PROVIDER.clientSecret));
			if (fault === "not-recorded")
				f.store.recordAuthAccountProfile.mockResolvedValue({ kind: "not_recorded" });
			if (fault === "rejected")
				f.store.recordAuthAccountProfile.mockResolvedValue({
					kind: "rejected",
					error: "auth_config_changed",
				});
			// Act
			const reply = await f.callback(request(c));
			// Assert
			expect(reply.response.status).toBe(303);
			expect(reply.outcome).toBe("signed_in_profile_not_recorded");
			expect(reply.response.headers.getSetCookie()).toHaveLength(2);
			expect(rows(f, "coordinator_auth_sessions")).toHaveLength(1);
			await privateSafe(reply.response, c, reply.outcome);
		},
	);
});

describe("callback concurrency and immutable request snapshots", () => {
	it("eight callbacks through two transaction-store instances sharing one Node SQLite connection have one winner", async () => {
		// Arrange: deliberately NOT separate SQLite connections or a cross-process claim.
		const f = await harness();
		await linked({ ...f, store: f.persistence });
		const c = await ceremony(f);
		const second = browserCapability({ ...f, store: f.persistence });
		const gate = Promise.withResolvers<void>();
		const arrived = Promise.withResolvers<void>();
		let count = 0;
		const wrap = (persistence: Pick<typeof f.persistence, "consumeAuthBrowserTransaction">) => ({
			...f.store,
			async consumeAuthBrowserTransaction(
				...args: Parameters<typeof f.store.consumeAuthBrowserTransaction>
			) {
				if (++count === 8) arrived.resolve();
				await gate.promise;
				return persistence.consumeAuthBrowserTransaction(...args);
			},
		});
		const left = await createCoordinatorBrowserAuthCallback({
			...f.input,
			store: wrap(f.persistence),
		});
		const right = await createCoordinatorBrowserAuthCallback({ ...f.input, store: wrap(second) });
		if (!left.ok || !right.ok) throw new Error("Expected callback factories");
		f.oidc.fetch.mockClear();
		const observations = providerAfterConsume(f);
		// Act: barrier is before consume, never inside the one-winner admission path.
		const pending = Array.from({ length: 8 }, (_, i) =>
			(i % 2 ? left : right).handlers.callback(request(c)),
		);
		await arrived.promise;
		gate.resolve();
		const replies = await Promise.all(pending);
		// Assert
		expect(replies.map((r) => r.response.status).sort()).toEqual([
			303, 403, 403, 403, 403, 403, 403, 403,
		]);
		for (const reply of replies)
			expect(reply.response.headers.getSetCookie()).toHaveLength(
				reply.response.status === 303 ? 2 : 0,
			);
		expect(rows(f, "coordinator_auth_sessions")).toHaveLength(1);
		expect(f.oidc.fetch.mock.calls.filter(([url]) => url.endsWith("/token"))).toHaveLength(1);
		assertProviderProof(observations, c);
	});
	it("uses native original URL, method and cookies despite accessors and asynchronous mutation", async () => {
		// Arrange
		const f = await harness();
		await linked({ ...f, store: f.persistence });
		const c = await ceremony(f);
		const req = request(c);
		const headers = req.headers;
		const getter = vi.fn(() => {
			throw new Error(PROVIDER.clientSecret);
		});
		for (const key of ["url", "method", "headers"])
			Object.defineProperty(req, key, { get: getter, configurable: true });
		f.store.consumeAuthBrowserTransaction.mockImplementation(async (...args) => {
			headers.set("cookie", `${BROWSER_COOKIE_NAMES.transaction}=bad`);
			Object.defineProperty(req, "url", {
				value: `${PROVIDER.redirectUri}?code=changed`,
				configurable: true,
			});
			return f.persistence.consumeAuthBrowserTransaction(...args);
		});
		// Act
		const reply = await f.callback(req);
		// Assert
		expect(reply.response.status).toBe(303);
		expect(getter).not.toHaveBeenCalled();
		const tokenBody = f.oidc.fetch.mock.calls.find(([url]) => url.endsWith("/token"))?.[1].body;
		if (!(tokenBody instanceof URLSearchParams)) throw new Error("Expected token POST body");
		expect(tokenBody.get("code")).toBe(c.url.searchParams.get("code"));
		expect(rows(f, "coordinator_auth_sessions")).toHaveLength(1);
	});
});
