import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
	capabilitiesPath,
	cleanupAccountChangeHttpFixtures,
	createBody,
	fixture,
	h,
	hash,
	headers,
	NOW,
	ROOT,
	statusPins,
} from "./coordinator-account-change-http-test-fixtures.js";
import { type CreateCoordinatorAppOptions, createCoordinatorApp } from "./coordinator-api.js";
import {
	captureCoordinatorBrowserAuthOptions,
	coordinatorBrowserAuthDeviceRoutes,
	createCoordinatorBrowserAuth,
	maintainCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { BROWSER_COOKIE_NAMES, issueBrowserCookie } from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

afterEach(cleanupAccountChangeHttpFixtures);

async function mountedFixture(install = true) {
	const f = await fixture(
		"device_claim",
		{ issuer: "https://accounts.google.com", redirectUri: PROVIDER.redirectUri },
		{ install },
	);
	const oidc = oidcFixture({ issuer: f.config.issuer });
	oidc.claims.sub = "account-A";
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(19));
	const snapshot = captureCoordinatorBrowserAuthOptions({
		config: { ...f.config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret },
		csrfKey,
		oidcOptions: { fetch: oidc.fetch },
	});
	const mount = (
		auth: NonNullable<
			Extract<CreateCoordinatorAppOptions["browserAuth"], { kind: "ready" }>["auth"]
		>,
	) =>
		createCoordinatorApp({
			...f.options,
			accountChanges: undefined,
			browserAuth: {
				kind: "ready",
				auth,
				storeFactory: () => f.store,
				clientKey: () => "trusted-client",
			},
		});
	const origin = new URL(f.config.redirectUri).origin;
	const signed = (
		app: ReturnType<typeof createCoordinatorApp>,
		method: string,
		path: string,
		data?: unknown,
	) => {
		const body = data === undefined ? "" : JSON.stringify(data);
		return app.request(`${origin}${path}`, {
			method,
			headers: headers(f.key, method, path, body),
			...(body ? { body } : {}),
		});
	};
	return { ...f, oidc, snapshot, mount, signed, origin };
}
const formFields = (html: string) =>
	new URLSearchParams(
		[...html.matchAll(/name="([^"]+)" value="([^"]+)"/g)].map((match) => [
			match[1] ?? "",
			match[2] ?? "",
		]),
	);
async function mountedAppFixture() {
	const f = await mountedFixture();
	const auth = await createCoordinatorBrowserAuth(
		f.snapshot,
		f.store,
		createInMemoryRequestRateLimiter(),
	);
	if (!auth.ok) throw new Error(auth.error);
	return { ...f, app: f.mount(auth.auth) };
}
async function managementMaterial(f: Awaited<ReturnType<typeof mountedAppFixture>>) {
	const cookie = await issueBrowserCookie("transaction");
	const state = "s".repeat(43);
	const pins = {
		attemptId: "change-a",
		browserStartHash: h(51),
		stateHash: createHash("sha256").update(state).digest("hex"),
		binderHash: cookie.cookieHash,
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	expect((await f.signed(f.app, "POST", ROOT, createBody({ intent: "disconnect" }))).status).toBe(
		200,
	);
	return {
		cookie: cookie.setCookie.split(";")[0] ?? "",
		state,
		pins,
		operations: await f.store.getAccountChanges(),
	};
}
it("mounted management start blocks an ordinary transaction and accepts its cancelled cookie", async () => {
	const f = await mountedAppFixture();
	const cookie = await issueBrowserCookie("transaction");
	expect(
		(
			await f.store.startAuthBrowserTransaction(
				{
					purpose: "signin",
					stateHash: h(73),
					binderHash: cookie.cookieHash,
					nonce: "n".repeat(43),
					pkceVerifier: "p".repeat(43),
				},
				f.config,
			)
		).kind,
	).toBe("started");
	const code = Buffer.alloc(32, 7).toString("base64url");
	expect(
		(await f.signed(f.app, "POST", ROOT, createBody({ browser_start_hash: hash(code) }))).status,
	).toBe(200);
	const url = `${f.origin}/auth/account/change/start?attempt_id=change-a&start_code=${code}`;
	const headers = { cookie: cookie.setCookie.split(";")[0] ?? "" };
	const denied = await f.app.request(url, { headers });
	expect(denied.status).toBe(409);
	expect(denied.headers.get("set-cookie")).toBeNull();
	expect(
		(await f.store.cancelAuthSigninBrowserTransaction({ binderHash: cookie.cookieHash }, f.config))
			.kind,
	).toBe("cancelled");
	expect((await f.app.request(url, { headers })).status).toBe(200);
});
it.each(["regular-first", "management-first"] as const)(
	"mounted callback denies %s cross-table collision without consuming either proof",
	async (order) => {
		const f = await mountedAppFixture();
		const m = await managementMaterial(f);
		const ordinary = () =>
			f.store.startAuthBrowserTransaction(
				{
					stateHash: m.pins.stateHash,
					binderHash: m.pins.binderHash,
					purpose: "signin",
					nonce: "o".repeat(43),
					pkceVerifier: "q".repeat(43),
				},
				f.config,
			);
		if (order === "regular-first") expect((await ordinary()).kind).toBe("started");
		expect(await m.operations.claimBrowser(m.pins, f.config)).toBe(true);
		if (order === "management-first") expect((await ordinary()).kind).toBe("started");
		const rows = () =>
			["coordinator_auth_browser_transactions", "coordinator_account_change_attempts"].map(
				(table) => f.db.prepare(`SELECT * FROM ${table}`).all(),
			);
		const before = rows();
		const response = await f.app.request(`${f.config.redirectUri}?state=${m.state}&code=unused`, {
			headers: { cookie: m.cookie },
		});
		expect(response.status).toBe(403);
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(rows()).toEqual(before);
		expect(f.oidc.requests.some((r) => r.url.endsWith("/token"))).toBe(false);
	},
);
it.each(["browser_pending", "verified", "confirmed", "failed", "cancelled", "expired"] as const)(
	"mounted ordinary starts respect %s management-cookie activity",
	async (state) => {
		const f = await mountedAppFixture();
		const startUrls = [
			`${f.origin}/auth/sign-in`,
			`${f.origin}/auth/link/start?attempt_id=unused&start_code=${Buffer.alloc(32, 7).toString("base64url")}`,
		];
		const forms = await Promise.all(
			startUrls.map(async (url) => {
				const page = await f.app.request(url);
				return {
					url,
					body: formFields(await page.text()),
					cookie: page.headers.getSetCookie()[0]?.split(";")[0] ?? "",
				};
			}),
		);
		const m = await managementMaterial(f);
		expect(await m.operations.claimBrowser(m.pins, f.config)).toBe(true);
		if (["verified", "confirmed", "failed"].includes(state)) {
			expect(await m.operations.consumeCallback(m.pins, f.config)).not.toBeNull();
			if (state === "failed") await m.operations.failConsumed(m.pins, f.config);
			else
				expect(
					await m.operations.recordVerifiedCallback(
						{
							...m.pins,
							issuer: f.config.issuer,
							subject: "account-A",
							profile: {},
							completionSecretHash: h(88),
						},
						f.config,
					),
				).toBe(true);
		}
		if (state === "confirmed")
			expect(
				await m.operations.confirmDisconnect({ ...m.pins, completionSecretHash: h(88) }, f.config),
			).toBe(true);
		if (state === "cancelled")
			expect((await f.signed(f.app, "POST", `${ROOT}/change-a/cancel`, statusPins())).status).toBe(
				200,
			);
		if (state === "expired") f.clock.now += 600001;
		const active = ["browser_pending", "verified", "confirmed"].includes(state);
		for (const form of forms) {
			const get = await f.app.request(form.url, { headers: { cookie: m.cookie } });
			expect(get.status).toBe(active ? 409 : 200);
			if (!active) continue;
			expect(get.headers.get("set-cookie")).toBeNull();
			const post = await f.app.request(form.url.split("?")[0] ?? form.url, {
				method: "POST",
				headers: {
					cookie: `${m.cookie}; ${form.cookie}`,
					origin: f.origin,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: form.body,
			});
			expect(post.status).toBe(409);
			expect(post.headers.get("set-cookie")).toBeNull();
		}
	},
);
function pageLink(html: string) {
	const href = html.match(/href="([^"]+)"/)?.[1];
	if (!href) throw new Error("missing mounted link");
	return href.replaceAll("&amp;", "&");
}
for (const intent of ["refresh", "disconnect"] as const) {
	it(`mounted ${intent} uses shared Google callback and proof-bearing signed finalize`, async () => {
		const f = await mountedFixture();
		const auth = await createCoordinatorBrowserAuth(
			f.snapshot,
			f.store,
			createInMemoryRequestRateLimiter(),
		);
		if (!auth.ok) throw new Error(auth.error);
		const app = f.mount(auth.auth),
			startCode = Buffer.alloc(32, 7).toString("base64url");
		expect(
			(
				await f.signed(
					app,
					"POST",
					ROOT,
					createBody({ intent, browser_start_hash: hash(startCode) }),
				)
			).status,
		).toBe(200);
		const session = await issueBrowserCookie("session");
		f.db.prepare("UPDATE coordinator_auth_sessions SET credential_hash=?").run(session.cookieHash);
		const sessionHeader = session.setCookie.split(";")[0] ?? "";
		const start = `${f.origin}/auth/account/change/start`;
		const page = await app.request(`${start}?attempt_id=change-a&start_code=${startCode}`, {
			headers: { cookie: sessionHeader },
		});
		expect(page.status).toBe(200);
		const startCookie = page.headers.getSetCookie()[0]?.split(";")[0] ?? "";
		const post = (path: string, cookie: string, body: URLSearchParams) =>
			app.request(path, {
				method: "POST",
				headers: { cookie, origin: f.origin, "content-type": "application/x-www-form-urlencoded" },
				body,
			});
		const promoted = await post(
			start,
			`${startCookie}; ${sessionHeader}`,
			formFields(await page.text()),
		);
		expect(promoted.status).toBe(200);
		const transaction = promoted.headers
			.getSetCookie()
			.find((value) => value.startsWith(`${BROWSER_COOKIE_NAMES.transaction}=`))
			?.split(";")[0];
		if (!transaction) throw new Error("missing mounted transaction");
		const callback = f.oidc.authorize(pageLink(await promoted.text()));
		const sessions = f.db.prepare("SELECT * FROM coordinator_auth_sessions").all();
		const ordinaryConsume = vi.spyOn(f.store, "consumeAuthBrowserTransaction");
		const wrongState = new URL(callback);
		wrongState.searchParams.set("state", "x".repeat(43));
		const rejected = await app.request(wrongState.href, {
			headers: { cookie: `${transaction}; ${sessionHeader}` },
		});
		expect(rejected.status).toBe(403);
		expect(rejected.headers.get("set-cookie")).toBeNull();
		expect(ordinaryConsume).not.toHaveBeenCalled();
		expect(f.oidc.requests.some(({ url }) => url.endsWith("/token"))).toBe(false);
		const response = await app.request(callback.href, {
			headers: { cookie: `${transaction}; ${sessionHeader}` },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(ordinaryConsume).not.toHaveBeenCalled();
		expect(f.db.prepare("SELECT * FROM coordinator_auth_sessions").all()).toEqual(sessions);
		let html = await response.text();
		if (intent === "disconnect") {
			const confirmed = await post(
				`${f.origin}/auth/account/change/confirm`,
				`${transaction}; ${sessionHeader}`,
				formFields(html),
			);
			expect(confirmed.status).toBe(200);
			expect(confirmed.headers.get("set-cookie")).toBeNull();
			html = await confirmed.text();
		}
		const proof = new URL(pageLink(html)).searchParams.get("completion");
		if (!proof) throw new Error("missing mounted completion proof");
		const finalized = await f.signed(
			app,
			"POST",
			`${ROOT}/change-a/finalize`,
			f.finalBody({ completion: proof }),
		);
		expect(finalized.status).toBe(200);
		expect((await finalized.json()).status.state).toBe("completed");
		expect(f.oidc.requests.some(({ url }) => url.endsWith("/jwks"))).toBe(true);
	});
}
it("cold device composition exposes signed management without Google discovery; legacy remains unsupported", async () => {
	for (const install of [true, false]) {
		const f = await mountedFixture(install),
			auth = coordinatorBrowserAuthDeviceRoutes(f.snapshot);
		if (!auth) throw new Error("missing cold config");
		const app = f.mount(auth);
		expect((await f.signed(app, "GET", capabilitiesPath)).status).toBe(install ? 200 : 404);
		expect(f.oidc.requests).toHaveLength(0);
		if (!install) {
			const legacy = await createCoordinatorBrowserAuth(
				f.snapshot,
				f.store,
				createInMemoryRequestRateLimiter(),
			);
			if (!legacy.ok) throw new Error(legacy.error);
			expect(
				(await f.mount(legacy.auth).request(`${f.origin}/auth/account/change/start`)).status,
			).toBe(404);
		}
	}
});
it("partial mounted storage fails before discovery and cold signed management returns generic unavailable", async () => {
	const f = await mountedFixture();
	f.db.exec("DROP TRIGGER account_change_birth");
	const auth = await createCoordinatorBrowserAuth(
		f.snapshot,
		f.store,
		createInMemoryRequestRateLimiter(),
	);
	expect(auth).toEqual({ ok: false, error: "coordinator_auth_schema_upgrade_required" });
	expect(f.oidc.requests).toHaveLength(0);
	const cold = coordinatorBrowserAuthDeviceRoutes(f.snapshot);
	if (!cold) throw new Error("missing cold config");
	const response = await f.signed(f.mount(cold), "GET", capabilitiesPath);
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: "authentication_unavailable" });
});
it("scheduled maintenance expires management staging using the existing coordinator-local batch", async () => {
	const f = await mountedFixture(),
		auth = coordinatorBrowserAuthDeviceRoutes(f.snapshot);
	if (!auth) throw new Error("missing cold config");
	expect((await f.signed(f.mount(auth), "POST", ROOT, createBody())).status).toBe(200);
	const operations = await f.store.getAccountChanges();
	expect(
		await operations.claimBrowser(
			{
				attemptId: "change-a",
				browserStartHash: h(51),
				stateHash: h(52),
				binderHash: h(53),
				nonce: "n".repeat(43),
				pkceVerifier: "p".repeat(43),
			},
			f.config,
		),
	).toBe(true);
	f.clock.now = NOW + 600001;
	const rotated = captureCoordinatorBrowserAuthOptions({
		config: {
			...f.config,
			revision: "b".repeat(64),
			clientId: PROVIDER.clientId,
			clientSecret: PROVIDER.clientSecret,
		},
		csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(20)),
		oidcOptions: { fetch: f.oidc.fetch },
	});
	const maintained = await maintainCoordinatorBrowserAuth(rotated, f.store);
	expect(maintained.kind).toBe("maintained");
	expect(
		f.db.prepare("SELECT state,nonce,pkce_verifier FROM coordinator_account_change_attempts").get(),
	).toEqual({ state: "expired", nonce: null, pkce_verifier: null });
});
it("rejects mismatched manual/composed configuration before opening request storage", async () => {
	const f = await mountedFixture(),
		auth = coordinatorBrowserAuthDeviceRoutes(f.snapshot);
	if (!auth || !f.options.accountChanges) throw new Error("missing config fixture");
	const storeFactory = vi.fn(() => f.store);
	for (const mismatch of [
		{ coordinatorId: "other" },
		{ issuer: "https://other.example.test" },
		{ revision: "b".repeat(64) },
		{ redirectUri: "https://other.example.test/auth/callback" },
		{ enabled: false },
	]) {
		expect(() =>
			createCoordinatorApp({
				...f.options,
				accountChanges: { ...f.options.accountChanges, config: { ...f.config, ...mismatch } },
				browserAuth: { kind: "ready", auth, storeFactory, clientKey: () => "trusted-client" },
			}),
		).toThrow("coordinator_auth_configuration_conflict");
	}
	expect(storeFactory).not.toHaveBeenCalled();
});
