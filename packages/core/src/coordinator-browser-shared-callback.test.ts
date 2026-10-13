import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { CoordinatorAuthBrowserTransactions } from "./coordinator-auth-browser-transaction.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
	maintainCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { createCoordinatorBrowserAuthCallback } from "./coordinator-browser-auth-callback.js";
import { issueBrowserCookie } from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { createD1AuthLinkBackend, D1CoordinatorStore } from "./d1-coordinator-store.js";

const databases: ReturnType<typeof setupStore>["db"][] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	vi.restoreAllMocks();
});
const config = {
	enabled: true,
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.google.com",
	redirectUri: PROVIDER.redirectUri,
	revision: "a".repeat(64),
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
};
const state = "s".repeat(43);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(purpose: "signin" | "owner_enroll" = "owner_enroll") {
	const f = setupStore("D1", { authClock: () => NOW });
	databases.push(f.db);
	if (!(f.store instanceof D1CoordinatorStore)) throw new Error("Expected D1 fixture");
	const cookie = await issueBrowserCookie("transaction");
	f.db
		.prepare(`INSERT INTO coordinator_auth_browser_transactions
 (coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms)
 VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`)
		.run(
			config.coordinatorId,
			"9".repeat(64),
			purpose,
			purpose === "signin" ? null : "owner-a",
			digest(state),
			cookie.cookieHash,
			config.issuer,
			config.revision,
			config.redirectUri,
			"n".repeat(43),
			"p".repeat(43),
			NOW,
			NOW + 600000,
		);
	const ownerCallback = vi.fn(async () => new Response("owner", { status: 202 }));
	const consume = vi.spyOn(f.store, "consumeAuthBrowserTransaction");
	const read = vi.spyOn(f.store, "readAuthBrowserTransactionPurpose");
	const oidc = oidcFixture({ issuer: config.issuer });
	const callback = await createCoordinatorBrowserAuthCallback({
		config,
		store: f.store,
		purposeStore: f.store,
		ownerCallback,
		completeLink: async () => new Response("link"),
		oidcOptions: { fetch: oidc.fetch },
	});
	if (!callback.ok) throw new Error("Expected callback");
	return {
		...f,
		store: f.store,
		cookie,
		ownerCallback,
		consume,
		read,
		callback: callback.handlers.callback,
	};
}
function request(cookie: string | undefined, query = `state=${state}&code=code`) {
	return new Request(`${config.redirectUri}?${query}`, { headers: cookie ? { cookie } : {} });
}
it("routes stored owner purpose without ordinary consumption or query nomination", async () => {
	const f = await fixture();
	const req = request(f.cookie.setCookie.split(";")[0], `state=${state}&code=code&purpose=signin`);
	expect((await f.callback(req, "trusted-client")).outcome).toBe("owner_dispatched");
	expect(f.ownerCallback).toHaveBeenCalledWith(req, "trusted-client");
	expect(f.consume).not.toHaveBeenCalled();
	expect(f.read).toHaveBeenCalledWith(
		{ stateHash: digest(state), binderHash: f.cookie.cookieHash },
		expect.objectContaining({ revision: config.revision }),
	);
});
it.each(["missing", "wrong", "duplicate", "state", "expired", "config", "consumed"])(
	"does not route owner for %s binding",
	async (fault) => {
		const f = await fixture();
		let cookie = f.cookie.setCookie.split(";")[0];
		let query = `state=${state}&code=code`;
		if (fault === "missing") cookie = undefined;
		if (fault === "wrong")
			cookie = (await issueBrowserCookie("transaction")).setCookie.split(";")[0];
		if (fault === "duplicate") cookie = `${cookie}; ${cookie}`;
		if (fault === "state") query = `state=${"x".repeat(43)}&code=code`;
		if (fault === "expired")
			f.db
				.prepare(
					"UPDATE coordinator_auth_browser_transactions SET created_at_ms = ?, expires_at_ms = ?",
				)
				.run(NOW - 600000, NOW);
		if (fault === "config")
			f.db
				.prepare("UPDATE coordinator_auth_browser_transactions SET auth_config_revision = ?")
				.run("b".repeat(64));
		if (fault === "consumed")
			f.db
				.prepare(
					"UPDATE coordinator_auth_browser_transactions SET state = 'expired', nonce = NULL, pkce_verifier = NULL",
				)
				.run();
		expect((await f.callback(request(cookie, query))).response.status).toBeGreaterThanOrEqual(400);
		expect(f.ownerCallback).not.toHaveBeenCalled();
		expect(f.consume).not.toHaveBeenCalled();
	},
);
it("ordinary selection never falls back to owner after a rejected consume", async () => {
	const f = await fixture("signin");
	f.consume.mockResolvedValue({ kind: "rejected", error: "transaction_unavailable" });
	expect(
		(
			await f.callback(
				request(f.cookie.setCookie.split(";")[0], `state=${state}&purpose=owner_enroll`),
			)
		).outcome,
	).toBe("transaction_unavailable");
	expect(f.consume).toHaveBeenCalledOnce();
	expect(f.ownerCallback).not.toHaveBeenCalled();
});

it("a failed purpose read cannot trigger either consumer", async () => {
	const f = await fixture();
	f.read.mockRejectedValueOnce(new Error("synthetic persistence failure"));
	expect((await f.callback(request(f.cookie.setCookie.split(";")[0]))).response.status).toBe(503);
	expect(f.consume).not.toHaveBeenCalled();
	expect(f.ownerCallback).not.toHaveBeenCalled();
});
it("purpose reads disclose no material and cannot substitute for atomic consumption", async () => {
	const f = await fixture("signin");
	const input = { stateHash: digest(state), binderHash: f.cookie.cookieHash };
	expect(await f.store.readAuthBrowserTransactionPurpose(input, config)).toBe("signin");
	const outcomes = await Promise.all([
		f.store.consumeAuthBrowserTransaction(input, config),
		f.store.consumeAuthBrowserTransaction(input, config),
	]);
	expect(outcomes.filter((outcome) => outcome.kind === "consumed")).toHaveLength(1);
	expect(await f.store.readAuthBrowserTransactionPurpose(input, config)).toBeNull();
});
it("pins normal purpose at the consume write if purpose changes after the read", async () => {
	const f = await fixture("signin");
	const backend = createD1AuthLinkBackend(f.store.db);
	const run = backend.run;
	backend.run = async (statement) => {
		f.db
			.prepare(
				"UPDATE coordinator_auth_browser_transactions SET purpose = 'owner_enroll', attempt_id = 'owner-a'",
			)
			.run();
		return run(statement);
	};
	const capability = new CoordinatorAuthBrowserTransactions(backend, () => NOW);
	expect(
		await capability.consumeAuthBrowserTransaction(
			{ stateHash: digest(state), binderHash: f.cookie.cookieHash },
			config,
		),
	).toEqual({ kind: "rejected", error: "transaction_unavailable" });
	expect(
		f.db.prepare("SELECT state, nonce FROM coordinator_auth_browser_transactions").get(),
	).toEqual({ state: "pending", nonce: "n".repeat(43) });
});

it("composes owner routes with captured CSRF, config and the same limiter", async () => {
	const f = await fixture();
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(7));
	const limiter = { check: () => ({ allowed: true, retryAfterS: 0 }) };
	const oidc = oidcFixture({ issuer: config.issuer });
	const handle = vi.fn(async (_request: Request, _key: string) => new Response("owner config"));
	const ownerEnrollment = vi.fn(async () => ({ handle, handleCallback: f.ownerCallback }));
	const snapshot = captureCoordinatorBrowserAuthOptions({
		config,
		csrfKey,
		oidcOptions: { fetch: oidc.fetch },
		ownerEnrollment,
	});
	const result = await createCoordinatorBrowserAuth(snapshot, f.store, limiter);
	if (!result.ok) throw new Error("Expected composed browser auth");
	const app = new Hono();
	result.auth.register(app, () => "trusted-client");
	const response = await app.request("https://app.example.test/v1/auth/owner-config");
	expect(await response.text()).toBe("owner config");
	expect(ownerEnrollment).toHaveBeenCalledWith({
		config: expect.objectContaining(config),
		csrfKey,
		limiter,
		oidcOptions: { fetch: oidc.fetch, timeoutSeconds: undefined },
	});
	expect(handle.mock.calls[0]?.[1]).toBe("trusted-client");
});

it.each(["/auth/owner/start", "/auth/owner/confirm"])(
	"rejects reserved callback path %s",
	async (path) => {
		const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(7));
		expect(
			captureCoordinatorBrowserAuthOptions({
				config: { ...config, redirectUri: `https://app.example.test${path}` },
				csrfKey,
			}),
		).toMatchObject({ kind: "invalid", field: "redirectUri" });
	},
);

it("owner routes remain unmounted without the explicit owner factory", async () => {
	// Arrange: normal browser authentication stays enabled without owner enrollment.
	const f = await fixture();
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(7));
	const oidc = oidcFixture({ issuer: config.issuer });
	const snapshot = captureCoordinatorBrowserAuthOptions({
		config,
		csrfKey,
		oidcOptions: { fetch: oidc.fetch },
	});
	const result = await createCoordinatorBrowserAuth(snapshot, f.store, {
		check: () => ({ allowed: true, retryAfterS: 0 }),
	});
	if (!result.ok) throw new Error("Expected composed browser auth");
	const app = new Hono();
	result.auth.register(app, () => "trusted-client");
	// Act
	const signin = await app.request("https://app.example.test/auth/sign-in");
	const link = await app.request("https://app.example.test/auth/link/start");
	// Assert: removing owner routes neither disables sign-in nor admits an unbound link.
	expect(signin.status).toBe(200);
	expect(link.status).toBe(400);
	for (const path of [
		"/auth/owner/start",
		"/auth/owner/confirm",
		"/v1/auth/owner-config",
		"/v1/auth/owner-attempts",
		"/v1/auth/owner-attempts/finalize",
	])
		expect((await app.request(`https://app.example.test${path}`)).status).toBe(404);
});

it.each(["enabled", "removed"] as const)(
	"maintenance erases expired owner secrets with factory %s but retains replay facts",
	async (factory) => {
		// Arrange: pending owner material survives a deployment that removes the owner factory.
		const f = await fixture();
		const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(7));
		const options = {
			config,
			csrfKey,
			ownerEnrollment: async () => ({ handle: f.ownerCallback, handleCallback: f.ownerCallback }),
		};
		const enabled = captureCoordinatorBrowserAuthOptions(options);
		const snapshot =
			factory === "enabled" ? enabled : captureCoordinatorBrowserAuthOptions({ config, csrfKey });
		const beforeExpiry = await maintainCoordinatorBrowserAuth(enabled, f.store, { maxBatches: 1 });
		const pending = f.db
			.prepare("SELECT state, nonce, pkce_verifier FROM coordinator_auth_browser_transactions")
			.get();
		f.db
			.prepare(
				"UPDATE coordinator_auth_browser_transactions SET created_at_ms = ?, expires_at_ms = ?",
			)
			.run(NOW - 600000, NOW);
		// Act: the scheduled maintenance entry point must expire old transactions regardless of route opt-in.
		const result = await maintainCoordinatorBrowserAuth(snapshot, f.store, { maxBatches: 1 });
		const repeated = await maintainCoordinatorBrowserAuth(snapshot, f.store, { maxBatches: 1 });
		// Assert: live secrets remain before expiry; expired secrets clear without deleting replay bindings.
		expect(beforeExpiry).toEqual({ kind: "maintained", processedCount: 0, more: false });
		expect(pending).toEqual({
			state: "pending",
			nonce: "n".repeat(43),
			pkce_verifier: "p".repeat(43),
		});
		expect(result).toEqual({ kind: "maintained", processedCount: 1, more: false });
		expect(repeated).toEqual({ kind: "maintained", processedCount: 0, more: false });
		expect(
			f.db
				.prepare(
					"SELECT purpose, attempt_id, state_hash, binder_hash, state, nonce, pkce_verifier FROM coordinator_auth_browser_transactions",
				)
				.get(),
		).toEqual({
			purpose: "owner_enroll",
			attempt_id: "owner-a",
			state_hash: digest(state),
			binder_hash: f.cookie.cookieHash,
			state: "expired",
			nonce: null,
			pkce_verifier: null,
		});
	},
);
