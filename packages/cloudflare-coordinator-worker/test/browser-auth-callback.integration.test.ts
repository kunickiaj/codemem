import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type CoordinatorBrowserAuthLinkCompletionInput,
	createCoordinatorBrowserAuthCallback,
} from "../../core/src/coordinator-browser-auth-callback.js";
import {
	BROWSER_COOKIE_NAMES,
	browserCookieValue,
	readBrowserCookie,
} from "../../core/src/coordinator-browser-credential.js";
import { importBrowserCsrfKey } from "../../core/src/coordinator-browser-csrf.js";
import { createCoordinatorBrowserSigninStart } from "../../core/src/coordinator-browser-signin-start.js";
import { challenge, oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { createInMemoryRequestRateLimiter } from "../../core/src/request-rate-limit.js";

const ORIGIN = "https://app.example.test";
const TX = "coordinator_auth_browser_transactions";
const SESSION = "coordinator_auth_sessions";
const RECEIPT = "coordinator_auth_session_receipts";
const PROFILE = "coordinator_auth_account_profiles";
const CLEAR = `${BROWSER_COOKIE_NAMES.transaction}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
const protectedTables = [
	"account_links",
	"link_attempts",
	"link_audit_log",
	"controller_attestations",
].map((s) => `coordinator_auth_${s}`);
type Fixture = Awaited<ReturnType<typeof setup>>;
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
	vi.spyOn(Date, "now").mockReturnValue(1790899200000);
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

async function rows(f: Fixture, table = TX) {
	return (
		await env.COORDINATOR_DB.prepare(
			`SELECT * FROM ${table} WHERE coordinator_id = ? ORDER BY rowid`,
		)
			.bind(f.config.coordinatorId)
			.all<Record<string, unknown>>()
	).results;
}
async function authority(f: Fixture) {
	return {
		rows: await Promise.all(protectedTables.map((table) => rows(f, table))),
		device: await f.stores[0].getEnrollment(f.review.groupId, f.review.deviceId),
		projects: (
			await env.COORDINATOR_DB.prepare(
				"SELECT * FROM coordinator_bootstrap_grants ORDER BY rowid",
			).all()
		).results,
	};
}
async function reviewedAccount(
	store: D1CoordinatorStore,
	config: {
		coordinatorId: string;
		issuer: string;
		enabled: boolean;
		revision: string;
		redirectUri: string;
	},
	options: { linked?: boolean },
) {
	// Reviewed D1 fixture pattern from auth-account-profile.integration.test.ts.
	const review = {
		coordinatorId: config.coordinatorId,
		groupId: crypto.randomUUID(),
		deviceId: crypto.randomUUID(),
		identityId: crypto.randomUUID(),
		attestationId: crypto.randomUUID(),
		reviewReceiptId: crypto.randomUUID(),
		publicKey: "fixture-public-key",
		fingerprint: "b".repeat(64),
		evidenceDigest: "c".repeat(64),
	};
	const start = {
		attemptId: crypto.randomUUID(),
		signer: review,
		runtimeVerifierHash: "d".repeat(64),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	await store.createGroup(review.groupId, "Fixture group");
	await store.enrollDevice(review.groupId, { ...review, identityId: null });
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	expect(await store.createAuthLinkAttempt(start, config)).toMatchObject({ kind: "created" });
	if (options.linked !== false) {
		const browser = { attemptId: start.attemptId, browserTransactionHash: "e".repeat(64) };
		const confirm = { ...browser, completionSecretHash: "f".repeat(64) };
		expect(await store.claimAuthLinkAttempt(browser, config)).toMatchObject({ kind: "applied" });
		expect(
			await store.recordAuthLinkOidcVerified(
				{ ...browser, account: { issuer: config.issuer, subject: "fixture-subject" } },
				config,
			),
		).toMatchObject({ kind: "applied" });
		expect(await store.confirmAuthLinkAttempt(confirm, config)).toMatchObject({ kind: "applied" });
		expect(
			await store.finalizeAuthLinkAttempt(
				{
					...review,
					...start,
					completionSecretHash: confirm.completionSecretHash,
					purpose: "coordinator-account-link-v1",
				},
				config,
			),
		).toMatchObject({ kind: "applied" });
	}
	return { review, start };
}
async function setup(options: { linked?: boolean } = {}) {
	const config = Object.freeze({
		enabled: true,
		coordinatorId: crypto.randomUUID(),
		issuer: "https://accounts.google.com",
		redirectUri: PROVIDER.redirectUri,
		revision: "a".repeat(64),
		clientId: PROVIDER.clientId,
		clientSecret: PROVIDER.clientSecret,
	});
	const fixture = oidcFixture({ issuer: config.issuer });
	fixture.claims.roles = ["administrator"];
	const stores = [
		new D1CoordinatorStore(env.COORDINATOR_DB),
		new D1CoordinatorStore(env.COORDINATOR_DB),
	];
	const store = stores[0];
	const { review, start } = await reviewedAccount(store, config, options);
	const transport = vi.fn<typeof fixture.fetch>(async (url, input) => {
		if (url === `${config.issuer}/token`) {
			const persisted = (
				await env.COORDINATOR_DB.prepare(`SELECT * FROM ${TX} WHERE coordinator_id = ?`)
					.bind(config.coordinatorId)
					.all<Record<string, unknown>>()
			).results;
			expect(persisted).toHaveLength(1);
			expect(persisted[0]).toMatchObject({ state: "consumed", nonce: null, pkce_verifier: null });
		}
		return fixture.fetch(url, input);
	});
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const limiter = createInMemoryRequestRateLimiter();
	const started = await createCoordinatorBrowserSigninStart({
		config,
		store,
		csrfKey,
		limiter,
		oidcOptions: { fetch: transport },
	});
	if (!started.ok) throw new Error("Start fixture failed");
	const linkResponse = new Response("Link continuation fixture", { status: 202 });
	const completeLink = vi.fn(
		async (_input: CoordinatorBrowserAuthLinkCompletionInput) => linkResponse,
	);
	const callbacks = [];
	for (const store of stores) {
		const created = await createCoordinatorBrowserAuthCallback({
			config,
			store,
			completeLink,
			oidcOptions: { fetch: transport },
		});
		if (!created.ok) throw new Error("Callback fixture failed");
		callbacks.push(created.handlers);
	}
	const traps = stores.flatMap((store) => [
		vi.spyOn(store, "signInWithAuthAccount").mockRejectedValue(new Error("legacy trap")),
		vi
			.spyOn(store, "cancelAuthSigninBrowserTransaction")
			.mockRejectedValue(new Error("cancel trap")),
	]);
	transport.mockClear();
	fixture.fetch.mockClear();
	return {
		config,
		fixture,
		transport,
		stores,
		review,
		start,
		started: started.handlers,
		callbacks,
		completeLink,
		linkResponse,
		traps,
	};
}
async function ceremony(f: Fixture) {
	const { response: page } = await f.started.signInPage(new Request(`${ORIGIN}/auth/sign-in`));
	const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
	if (!csrf) throw new Error("Missing CSRF form");
	const cookie = page.headers.getSetCookie()[0].split(";")[0];
	const { response } = await f.started.signInStart(
		new Request(`${ORIGIN}/auth/sign-in`, {
			method: "POST",
			headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ csrf }),
		}),
		"fixture-client",
	);
	const href = (await response.text()).match(/href="(https:[^"]+)"/)?.[1];
	if (!href) throw new Error("Missing provider anchor");
	const authorization = new URL(href.replaceAll("&amp;", "&"));
	const txn = response.headers.getSetCookie()[0].split(";")[0];
	return {
		authorization,
		callback: f.fixture.authorize(authorization),
		cookie: txn,
		row: (await rows(f))[0],
	};
}
function request(url: URL | string, cookie?: string) {
	return new Request(url, { headers: cookie ? { cookie } : {} });
}
async function redacted(
	result: { response: Response; outcome: string },
	row: Record<string, unknown>,
	code: string | null,
) {
	const output = `${result.outcome} ${await result.response.clone().text()}`;
	for (const secret of [
		row.nonce,
		row.pkce_verifier,
		row.state_hash,
		row.binder_hash,
		row.browser_transaction_hash,
		code,
		PROVIDER.clientSecret,
		"fixture-access-token",
		"fixture-refresh-token",
	])
		if (typeof secret === "string") expect(output).not.toContain(secret);
	expect(output).not.toMatch(/id_token|privateCause|roles|administrator|legacy trap|cancel trap/);
	expect(result.response.headers.get("cache-control")).toBe("no-store");
	expect(result.response.headers.get("referrer-policy")).toBe("no-referrer");
}
async function untouched(f: Fixture) {
	for (const trap of f.traps) expect(trap).not.toHaveBeenCalled();
	expect(f.fixture.requests.some(({ url }) => url.endsWith("/userinfo"))).toBe(false);
}

it("runs the real Google sign-in ceremony, persists coherent session/profile, and denies replay", async () => {
	// Arrange: actual D1 stores and native crypto, with only provider transport replaced.
	const f = await setup();
	const before = await authority(f);
	const c = await ceremony(f);
	expect(c.row.nonce).toBe(c.authorization.searchParams.get("nonce"));
	expect(await challenge(String(c.row.pkce_verifier))).toBe(
		c.authorization.searchParams.get("code_challenge"),
	);
	// Act: equivalent percent-encoded state is decoded to the same canonical material.
	const state = c.callback.searchParams.get("state");
	if (!state) throw new Error("Missing state");
	const encoded = c.callback.href.replace(
		`state=${state}`,
		`state=%${state.charCodeAt(0).toString(16)}${state.slice(1)}`,
	);
	const result = await f.callbacks[0].callback(request(encoded, c.cookie));
	const replay = await f.callbacks[1].callback(request(c.callback, c.cookie));
	// Assert: native getSetCookie preserves both fields; bearer header intentionally remains public.
	expect(result.outcome).toBe("signed_in");
	expect(result.response.status).toBe(303);
	expect(result.response.headers.get("location")).toBe(`${ORIGIN}/auth/account`);
	const cookies = result.response.headers.getSetCookie();
	expect(cookies).toHaveLength(2);
	expect(cookies[0]).toMatch(
		new RegExp(
			`^${BROWSER_COOKIE_NAMES.session}=[A-Za-z0-9_-]{43}; Max-Age=28800; Path=/; Secure; HttpOnly; SameSite=Lax$`,
		),
	);
	expect(cookies[1]).toBe(CLEAR);
	const credential = await readBrowserCookie(cookies[0].split(";")[0], "session");
	if (credential.kind !== "present") throw new Error("Missing session credential");
	const stored = (await rows(f, SESSION))[0];
	const account = await f.stores[1].readAuthSessionAccount(credential.cookieHash, f.config);
	expect(account?.session).toMatchObject({
		sessionId: stored.session_id,
		identityId: f.review.identityId,
		account: { issuer: f.config.issuer, subject: "fixture-subject" },
		expiresAtMs: stored.expires_at_ms,
	});
	expect(stored.credential_hash).toBe(credential.cookieHash);
	const raw = Uint8Array.from(
		atob(`${cookies[0].split(";")[0].split("=")[1].replaceAll("-", "+").replaceAll("_", "/")}=`),
		(char) => char.charCodeAt(0),
	);
	const digest = await crypto.subtle.digest("SHA-256", raw);
	expect(stored.credential_hash).toBe(
		Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
	);
	expect(await rows(f, RECEIPT)).toEqual([
		expect.objectContaining({ session_id: stored.session_id, source: "signin" }),
	]);
	expect(await rows(f, PROFILE)).toHaveLength(1);
	expect(account?.profile).toMatchObject({
		displayName: "Fixture User",
		email: "user@example.test",
	});
	expect(JSON.stringify(account?.profile)).not.toMatch(/roles|administrator/);
	expect(await authority(f)).toEqual(before);
	expect(replay.response.status).toBe(403);
	expect(replay.response.headers.getSetCookie()).toEqual([]);
	expect(await rows(f, SESSION)).toHaveLength(1);
	await redacted(result, c.row, c.callback.searchParams.get("code"));
	await redacted(replay, c.row, c.callback.searchParams.get("code"));
	await untouched(f);
});

it("admits one of eight callbacks across two actual D1 store objects", async () => {
	// Arrange: one binding, not separate isolates or separate SQL connections.
	const f = await setup();
	const c = await ceremony(f);
	expect(f.stores[0]).not.toBe(f.stores[1]);
	// Act
	const results = await Promise.all(
		Array.from({ length: 8 }, (_, i) => f.callbacks[i % 2].callback(request(c.callback, c.cookie))),
	);
	// Assert
	expect(results.filter(({ response }) => response.status === 303)).toHaveLength(1);
	expect(results.filter(({ response }) => response.status === 403)).toHaveLength(7);
	for (const result of results) {
		expect(result.response.headers.getSetCookie()).toHaveLength(
			result.response.status === 303 ? 2 : 0,
		);
		await redacted(result, c.row, c.callback.searchParams.get("code"));
	}
	expect(await rows(f, SESSION)).toHaveLength(1);
	expect(await rows(f, RECEIPT)).toHaveLength(1);
	expect(f.fixture.requests.filter(({ url }) => url.endsWith("/token"))).toHaveLength(1);
	await untouched(f);
});

it("preserves victim pending material for wrong/missing cookies or wrong/missing/duplicate state", async () => {
	// Arrange
	const f = await setup();
	const c = await ceremony(f);
	const absent = new URL(c.callback);
	absent.searchParams.delete("state");
	const wrong = new URL(c.callback);
	wrong.searchParams.set("state", "x".repeat(43));
	const duplicate = new URL(c.callback);
	duplicate.searchParams.append("state", duplicate.searchParams.get("state") ?? "");
	const requests = [
		request(c.callback),
		request(c.callback, `${BROWSER_COOKIE_NAMES.transaction}=${"A".repeat(43)}`),
		request(absent, c.cookie),
		request(wrong, c.cookie),
		request(duplicate, c.cookie),
	];
	// Act
	const results = await Promise.all(requests.map((r) => f.callbacks[0].callback(r)));
	// Assert: only a matching consume may burn the private proofs or clear TXN.
	for (const result of results) {
		expect([400, 403]).toContain(result.response.status);
		expect(result.response.headers.getSetCookie()).toEqual([]);
		await redacted(result, c.row, c.callback.searchParams.get("code"));
	}
	expect(await rows(f)).toEqual([c.row]);
	expect(f.transport).not.toHaveBeenCalled();
	expect(await rows(f, SESSION)).toEqual([]);
	await untouched(f);
});

it.each(["signature", "unlinked", "consume", "admission", "profile"] as const)(
	"handles %s faults without releasing an unpersisted session",
	async (mode) => {
		// Arrange: each fault owns a fresh ceremony; no rollback assumptions.
		const f = await setup({ linked: mode !== "unlinked" });
		const c = await ceremony(f);
		if (mode === "signature") f.fixture.settings.signature = "wrong-key";
		if (mode === "consume")
			vi.spyOn(f.stores[0], "consumeAuthBrowserTransaction").mockRejectedValue(
				new Error("privateCause"),
			);
		if (mode === "admission")
			vi.spyOn(f.stores[0], "signInWithConsumedBrowserTransaction").mockRejectedValue(
				new Error("privateCause"),
			);
		if (mode === "profile")
			vi.spyOn(f.stores[0], "recordAuthAccountProfile").mockRejectedValue(
				new Error("privateCause"),
			);
		// Act: recapture methods after fault injection, as production factory freezes them.
		const factory = await createCoordinatorBrowserAuthCallback({
			config: f.config,
			store: f.stores[0],
			completeLink: f.completeLink,
			oidcOptions: { fetch: f.transport },
		});
		if (!factory.ok) throw new Error("Fault factory failed");
		const result = await factory.handlers.callback(request(c.callback, c.cookie));
		// Assert
		const success = mode === "profile";
		const status = { signature: 403, unlinked: 403, consume: 503, admission: 503, profile: 303 }[
			mode
		];
		expect(result.response.status).toBe(status);
		let cookies: unknown[] = [CLEAR];
		if (mode === "consume") cookies = [];
		if (success) cookies = [expect.stringContaining(BROWSER_COOKIE_NAMES.session), CLEAR];
		expect(result.response.headers.getSetCookie()).toEqual(cookies);
		expect((await rows(f))[0]).toMatchObject(
			mode === "consume"
				? { state: "pending", nonce: c.row.nonce, pkce_verifier: c.row.pkce_verifier }
				: { state: "consumed", nonce: null, pkce_verifier: null },
		);
		expect(await rows(f, SESSION)).toHaveLength(success ? 1 : 0);
		expect(await rows(f, PROFILE)).toEqual([]);
		if (success) expect(result.outcome).toBe("signed_in_profile_not_recorded");
		await redacted(result, c.row, c.callback.searchParams.get("code"));
		await untouched(f);
	},
);

it("dispatches consumed link success and provider denial to the required frozen continuation without finalizing", async () => {
	// Arrange: real pending reviewed link attempts; stub deliberately grants nothing.
	for (const denied of [false, true]) {
		const f = await setup({ linked: false });
		const c = await ceremony(f);
		await env.COORDINATOR_DB.prepare(`DELETE FROM ${TX} WHERE coordinator_id = ?`)
			.bind(f.config.coordinatorId)
			.run();
		expect(
			await f.stores[0].startAuthBrowserTransaction(
				{
					purpose: "link",
					attemptId: f.start.attemptId,
					stateHash: String(c.row.state_hash),
					binderHash: String(c.row.binder_hash),
					nonce: String(c.row.nonce),
					pkceVerifier: String(c.row.pkce_verifier),
				},
				f.config,
			),
		).toMatchObject({ kind: "started" });
		if (denied) {
			c.callback.searchParams.delete("code");
			c.callback.searchParams.set("error", "access_denied");
			c.callback.searchParams.set("error_description", "privateCause");
		}
		const before = await authority(f);
		// Act
		const result = await f.callbacks[0].callback(request(c.callback, c.cookie));
		// Assert: the continuation owns its response and any later link lifecycle.
		expect(result.response).toBe(f.linkResponse);
		expect(result.outcome).toBe("link_dispatched");
		expect(result.response.headers.getSetCookie()).toEqual([]);
		expect(f.completeLink).toHaveBeenCalledTimes(1);
		const input = f.completeLink.mock.calls[0][0];
		expect(Object.isFrozen(input)).toBe(true);
		expect(Object.isFrozen(input.verification)).toBe(true);
		expect(input).toMatchObject({
			attemptId: f.start.attemptId,
			browserTransactionHash: (await rows(f))[0].browser_transaction_hash,
			transactionCookieHash: c.row.binder_hash,
			verification: { ok: !denied },
		});
		const cookie = await readBrowserCookie(c.cookie, "transaction");
		if (cookie.kind !== "present") throw new Error("Missing TXN");
		expect(input.transactionCookieHash).toBe(cookie.cookieHash);
		expect(browserCookieValue(input.transactionCookie, "transaction")).toBe(c.cookie.split("=")[1]);
		expect(Object.keys(input).sort()).toEqual(
			[
				"attemptId",
				"browserTransactionHash",
				"transactionCookie",
				"transactionCookieHash",
				"verification",
			].sort(),
		);
		expect(JSON.stringify(input.verification)).not.toMatch(
			/nonce|pkce|privateCause|access_token|id_token/,
		);
		expect((await rows(f, "coordinator_auth_link_attempts"))[0].state).toBe("browser_claimed");
		expect(await authority(f)).toEqual(before);
		for (const table of [SESSION, RECEIPT, PROFILE]) expect(await rows(f, table)).toEqual([]);
		await untouched(f);
	}
});

it("fails missing link continuation before discovery and keeps callback routing unmounted", async () => {
	// Arrange
	const f = await setup();
	const missing = { config: f.config, store: f.stores[0], oidcOptions: { fetch: f.transport } };
	// Act
	const invalid = await createCoordinatorBrowserAuthCallback(
		missing as Parameters<typeof createCoordinatorBrowserAuthCallback>[0],
	);
	const wrong = await f.callbacks[0].callback(request(`${ORIGIN}/wrong?state=${"a".repeat(43)}`));
	const method = await f.callbacks[0].callback(
		new Request(PROVIDER.redirectUri, { method: "POST" }),
	);
	const unmounted = await exports.default.fetch(PROVIDER.redirectUri);
	// Assert
	expect(invalid).toEqual({ ok: false, error: "invalid_input" });
	expect(wrong.response.status).toBe(404);
	expect(method.response.status).toBe(405);
	expect(method.response.headers.get("allow")).toBe("GET");
	expect(unmounted.status).toBe(404);
	for (const response of [wrong.response, method.response, unmounted])
		expect(response.headers.getSetCookie()).toEqual([]);
	expect(f.transport).not.toHaveBeenCalled();
	expect(await rows(f)).toEqual([]);
	await untouched(f);
});
