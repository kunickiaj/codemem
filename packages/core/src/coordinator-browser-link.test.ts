import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TABLE } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	attempt,
	authorize,
	finalize,
	NOW,
	signer,
} from "./coordinator-auth-link-test-fixtures.js";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { createCoordinatorBrowserAuthCallback } from "./coordinator-browser-auth-callback.js";
import {
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
} from "./coordinator-browser-credential.js";
import {
	importBrowserCsrfKey,
	issueBrowserCsrfToken,
	verifyBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import { createCoordinatorBrowserLinkHandlers } from "./coordinator-browser-link.js";
import { createCoordinatorOidcClient } from "./coordinator-oidc.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";

const ORIGIN = "https://app.example.test";
const ATTEMPTS = "coordinator_auth_link_attempts";
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

async function setup(
	backend: Backend = "SQLite",
	destination = "http://127.0.0.1:80/codemem/auth/complete",
) {
	const f = setupStore(backend, { authClock: () => NOW });
	databases.push(f.db);
	const config = Object.freeze({
		enabled: true,
		coordinatorId: "coordinator-a",
		issuer: "https://accounts.google.com",
		revision: "a".repeat(64),
		redirectUri: PROVIDER.redirectUri,
	});
	await authorize({ ...f, now: NOW, cfg: config });
	expect(
		await f.store.createAuthLinkAttempt(attempt({ loopbackRedirect: destination }), config),
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
	const limiter = { check: vi.fn(() => ({ allowed: true, retryAfterS: 0 })) };
	const operations = {
		retireAuthBrowserTransactions: vi.fn(f.store.retireAuthBrowserTransactions.bind(f.store)),
		resolveAuthLinkBrowserTransaction: vi.fn(
			f.store.resolveAuthLinkBrowserTransaction.bind(f.store),
		),
		recordAuthLinkOidcVerified: vi.fn(f.store.recordAuthLinkOidcVerified.bind(f.store)),
		readAuthLinkCompletionDestination: vi.fn(
			f.store.readAuthLinkCompletionDestination.bind(f.store),
		),
		confirmAuthLinkAttempt: vi.fn(f.store.confirmAuthLinkAttempt.bind(f.store)),
		failAuthLinkAttempt: vi.fn(f.store.failAuthLinkAttempt.bind(f.store)),
	};
	const legacy = {
		claimAuthLinkAttempt: vi.fn(() => {
			throw new Error("Legacy claim forbidden");
		}),
		redeemAuthLinkSession: vi.fn(() => {
			throw new Error("Legacy redeem forbidden");
		}),
	};
	const discoveryCalls = oidc.fetch.mock.calls.length;
	const link = createCoordinatorBrowserLinkHandlers({
		config,
		csrfKey,
		store: { ...operations, ...legacy },
		limiter,
	});
	if (!link.ok) throw new Error("Link setup failed");
	expect(oidc.fetch.mock.calls).toHaveLength(discoveryCalls);
	const callbackStore = {
		consumeAuthBrowserTransaction: f.store.consumeAuthBrowserTransaction.bind(f.store),
		readAuthSession: vi.fn(f.store.readAuthSession.bind(f.store)),
		signInWithConsumedBrowserTransaction: vi.fn(
			f.store.signInWithConsumedBrowserTransaction.bind(f.store),
		),
		recordAuthAccountProfile: vi.fn(f.store.recordAuthAccountProfile.bind(f.store)),
	};
	const callback = await createCoordinatorBrowserAuthCallback({
		config: rawConfig,
		store: callbackStore,
		completeLink: link.handlers.completeLink,
		oidcOptions: { fetch: oidc.fetch },
	});
	if (!callback.ok) throw new Error("Callback setup failed");
	const scope = { publicOrigin: ORIGIN, store: config };
	const csrf = await issueBrowserCsrfToken(csrfKey, parsed.secret, "transaction", scope);
	const url = oidc.authorize(new URL(authorization.authorizationUrl));
	return {
		...f,
		config,
		rawConfig,
		oidc,
		authorization,
		header,
		parsed,
		csrf,
		csrfKey,
		scope,
		limiter,
		operations,
		legacy,
		callbackStore,
		handlers: link.handlers,
		link,
		callback: callback.handlers.callback,
		url,
		destination,
	};
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function rows(f: Fixture, table = ATTEMPTS) {
	return f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
}
function authority(f: Fixture) {
	return [
		"coordinator_auth_account_links",
		"coordinator_auth_link_audit_log",
		"coordinator_auth_sessions",
		"coordinator_auth_account_profiles",
		"coordinator_bootstrap_grants",
		"enrolled_devices",
		"groups",
	].map((table) => [table, rows(f, table)]);
}
async function unrelatedPending(f: Fixture) {
	const client = await createCoordinatorOidcClient(f.rawConfig, { fetch: f.oidc.fetch });
	if (!client.ok) throw new Error("SDK setup failed");
	expect(
		await f.store.createAuthLinkAttempt(
			attempt({ attemptId: "other-attempt", runtimeVerifierHash: "e".repeat(64) }),
			f.config,
		),
	).toMatchObject({ kind: "created" });
	for (const purpose of ["link", "signin"] as const) {
		const { material } = await client.client.createAuthorizationRequest();
		const cookie = await issueBrowserCookie("transaction");
		const input = {
			stateHash: createHash("sha256").update(material.state).digest("hex"),
			binderHash: cookie.cookieHash,
			nonce: material.nonce,
			pkceVerifier: material.pkceVerifier,
		};
		const start =
			purpose === "link"
				? { ...input, purpose, attemptId: "other-attempt" }
				: { ...input, purpose };
		expect(await f.store.startAuthBrowserTransaction(start, f.config)).toMatchObject({
			kind: "started",
		});
	}
	return rows(f, TABLE).filter((row) => row.attempt_id !== "attempt-a");
}
function post(
	f: Fixture,
	action: "confirm" | "cancel" = "confirm",
	changes: Record<string, string> = {},
	cookie = f.header,
) {
	return new Request(`${ORIGIN}/auth/link/${action}`, {
		method: "POST",
		headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ csrf: f.csrf, attempt_id: "attempt-a", ...changes }),
	});
}
async function verified(f: Fixture) {
	const result = await f.callback(new Request(f.url, { headers: { cookie: f.header } }));
	expect(result.outcome).toBe("link_dispatched");
	expect(result.response.status).toBe(200);
	return result;
}
async function safe(response: Response, status: number) {
	expect(response.status).toBe(status);
	expect(response.headers.getSetCookie()).toEqual([]);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.clone().text()).not.toMatch(
		/privateCause|fixture-secret|fixture-access-token|fixture-refresh-token/,
	);
}

describe.each(["SQLite", "D1"] as const)("%s bound browser link", (backend) => {
	it.each(["http://127.0.0.1:80/codemem/auth/complete", "http://[::1]:80/codemem/auth/complete"])(
		"requires explicit confirmation and both device proofs for %s",
		async (destination) => {
			// Arrange: actual SDK state/nonce/PKCE and an atomically bound LINK transaction.
			const f = await setup(backend, destination);
			const before = authority(f);
			const original = rows(f, TABLE)[0];
			// Act: the callback dispatches the real private continuation.
			const callback = await verified(f);
			const body = await callback.response.clone().text();
			const csrf = body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
			// Assert: display metadata grants nothing and no browser session/profile is written.
			expect(Object.isFrozen(f.link)).toBe(true);
			expect(Object.isFrozen(f.handlers)).toBe(true);
			expect(body).toContain("Fixture User");
			expect(body).toContain("user@example.test");
			for (const target of ["identity-a", signer.groupId, signer.deviceId])
				expect(body).toContain(target);
			expect(body).toContain('action="/auth/link/confirm"');
			expect(body).toContain('action="/auth/link/cancel"');
			expect(body).toContain('name="attempt_id" value="attempt-a"');
			expect(
				await verifyBrowserCsrfToken(f.csrfKey, f.parsed.secret, "transaction", f.scope, csrf),
			).toBe(true);
			expect(callback.response.headers.getSetCookie()).toEqual([]);
			expect(authority(f)).toEqual(before);
			for (const spy of Object.values(f.legacy)) expect(spy).not.toHaveBeenCalled();
			expect(rows(f)[0]).toMatchObject({
				state: "oidc_verified",
				account_subject: "opaque-subject-a",
			});
			expect(rows(f, TABLE)[0]).toMatchObject({
				state: "consumed",
				nonce: null,
				pkce_verifier: null,
			});
			for (const spy of Object.values(f.callbackStore).slice(1)) expect(spy).not.toHaveBeenCalled();
			for (const secret of [
				original.nonce,
				original.pkce_verifier,
				original.binder_hash,
				f.rawConfig.clientSecret,
				f.url.searchParams.get("code"),
			])
				expect(body).not.toContain(secret);
			// Act: only the admitted explicit form can commit a completion secret.
			const confirmed = await f.handlers.confirm(
				post(f, "confirm", { csrf: csrf ?? "" }),
				"trusted-client",
			);
			const hop = await confirmed.response.clone().text();
			const anchors = [...hop.matchAll(/<a\b[^>]*href="([^"]+)"/g)];
			expect(confirmed.response.status).toBe(200);
			expect(anchors).toHaveLength(1);
			const href = anchors[0][1].replaceAll("&amp;", "&");
			const secret = new URL(href).searchParams.get("completion") ?? "";
			expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(href).toBe(`${destination}?attempt_id=attempt-a&completion=${secret}`);
			const decoded = Buffer.from(secret, "base64url");
			expect(decoded).toHaveLength(32);
			const hash = createHash("sha256").update(decoded).digest("hex");
			expect(rows(f)[0]).toMatchObject({ state: "confirmed", completion_secret_hash: hash });
			expect(hash).not.toBe(createHash("sha256").update(secret).digest("hex"));
			expect(authority(f)).toEqual(before);
			expect(JSON.stringify([...confirmed.response.headers])).not.toContain(secret);
			expect(JSON.stringify(confirmed.outcome)).not.toContain(secret);
			expect(hop.replace(anchors[0][0], "")).not.toContain(secret);
			// Act: replay cannot release a replacement, and either missing runtime proof blocks grants.
			const replay = await f.handlers.confirm(post(f), "trusted-client");
			await safe(replay.response, 403);
			expect(await replay.response.text()).not.toContain(secret);
			expect(rows(f)[0].completion_secret_hash).toBe(hash);
			expect(
				await f.store.finalizeAuthLinkAttempt(
					finalize({ completionSecretHash: "e".repeat(64) }),
					f.config,
				),
			).toMatchObject({ kind: "rejected" });
			expect(
				await f.store.finalizeAuthLinkAttempt(
					finalize({ completionSecretHash: hash, runtimeVerifierHash: "e".repeat(64) }),
					f.config,
				),
			).toMatchObject({ kind: "rejected" });
			expect(authority(f)).toEqual(before);
			expect(rows(f)[0].state).toBe("confirmed");
			expect(
				await f.store.finalizeAuthLinkAttempt(finalize({ completionSecretHash: hash }), f.config),
			).toMatchObject({ kind: "applied" });
			expect(rows(f, "coordinator_auth_account_links")).toHaveLength(1);
		},
	);
});

it.each(["https://evil.example.test", "null", null])(
	"rejects Origin %s before limiter, store or body pull",
	async (origin) => {
		// Arrange
		const f = await setup();
		const before = rows(f);
		const pull = vi.fn();
		const headers = new Headers({
			cookie: f.header,
			"content-type": "application/x-www-form-urlencoded",
		});
		if (origin !== null) headers.set("origin", origin);
		const request = new Request(`${ORIGIN}/auth/link/confirm`, {
			method: "POST",
			headers,
			body: new ReadableStream({ pull }, { highWaterMark: 0 }),
			duplex: "half",
		} as RequestInit);
		// Act
		const result = await f.handlers.confirm(request, "trusted-client");
		// Assert
		await safe(result.response, 403);
		expect(pull).not.toHaveBeenCalled();
		expect(f.limiter.check).not.toHaveBeenCalled();
		for (const spy of Object.values(f.operations)) expect(spy).not.toHaveBeenCalled();
		expect(rows(f)).toEqual(before);
	},
);

it.each(["wrong-cookie", "bad-csrf", "stale", "other-attempt", "destination", "role", "loopback"])(
	"rejects %s without changing the bound row",
	async (scenario) => {
		// Arrange
		const f = await setup();
		await verified(f);
		for (const spy of Object.values(f.operations)) spy.mockClear();
		let cookie = f.header;
		const changes: Record<string, string> = {};
		if (scenario === "wrong-cookie")
			cookie = (await issueBrowserCookie("transaction")).setCookie.split(";")[0];
		if (scenario === "bad-csrf") changes.csrf = "bad";
		if (scenario === "stale") {
			changes.csrf = await issueBrowserCsrfToken(f.csrfKey, f.parsed.secret, "transaction", {
				...f.scope,
				store: { ...f.config, revision: "b".repeat(64) },
			});
		}
		if (scenario === "other-attempt") changes.attempt_id = "other-attempt";
		if (["destination", "role", "loopback"].includes(scenario))
			changes[scenario] = "attacker-choice";
		const before = rows(f);
		// Act
		const result = await f.handlers.confirm(post(f, "confirm", changes, cookie), "trusted-client");
		// Assert
		await safe(result.response, ["destination", "role", "loopback"].includes(scenario) ? 400 : 403);
		expect(f.operations.confirmAuthLinkAttempt).not.toHaveBeenCalled();
		expect(rows(f)).toEqual(before);
		if (scenario !== "other-attempt")
			expect(f.operations.resolveAuthLinkBrowserTransaction).not.toHaveBeenCalled();
	},
);

it("pins the original cookie while native HMAC verification is awaiting", async () => {
	// Arrange
	const f = await setup();
	await verified(f);
	const other = (await issueBrowserCookie("transaction")).setCookie.split(";")[0];
	const request = post(f);
	const verify = crypto.subtle.verify.bind(crypto.subtle);
	vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
		request.headers.set("cookie", other);
		return verify(...args);
	});
	f.operations.resolveAuthLinkBrowserTransaction.mockClear();
	// Act
	const result = await f.handlers.confirm(request, "trusted-client");
	// Assert
	expect(result.response.status).toBe(200);
	expect(f.operations.resolveAuthLinkBrowserTransaction).toHaveBeenCalledWith(
		{ attemptId: "attempt-a", binderHash: f.parsed.cookieHash },
		f.config,
	);
	expect(rows(f)[0].state).toBe("confirmed");
});

it.each(["tampered-destination", "confirm-before-write", "confirm-after-write"])(
	"withholds the private hop on %s",
	async (fault) => {
		// Arrange
		const f = await setup();
		const confirmation = await verified(f);
		const before = authority(f);
		if (fault === "tampered-destination")
			f.db
				.prepare("UPDATE coordinator_auth_link_attempts SET loopback_redirect = ?")
				.run("https://evil.example.test/complete");
		if (fault === "confirm-before-write")
			f.operations.confirmAuthLinkAttempt.mockRejectedValue(new Error("privateCause"));
		if (fault === "confirm-after-write")
			f.operations.confirmAuthLinkAttempt.mockImplementation(async (...args) => {
				await f.store.confirmAuthLinkAttempt(...args);
				throw new Error("privateCause");
			});
		// Act
		const result = await f.handlers.confirm(post(f), "trusted-client");
		// Assert: a postcommit exception is not a rollback guarantee.
		await safe(result.response, fault === "tampered-destination" ? 403 : 503);
		expect(await result.response.text()).not.toContain("completion=");
		expect(authority(f)).toEqual(before);
		expect(rows(f)[0].state).toBe(fault === "confirm-after-write" ? "confirmed" : "oidc_verified");
		if (fault === "tampered-destination")
			expect(f.operations.confirmAuthLinkAttempt).not.toHaveBeenCalled();
		if (fault === "confirm-after-write") {
			// Arrange: the original confirmation form remains usable despite lost hop delivery.
			const body = await confirmation.response.text();
			const csrf = body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];
			if (!csrf) throw new Error("Expected original confirmation form token");
			// Act: explicit cancellation uses the original cookie and form, not a reconstructed page.
			const cancelled = await f.handlers.cancel(post(f, "cancel", { csrf }), "trusted-client");
			// Assert: no grant was delivered, and cancellation fails the real committed attempt.
			expect(cancelled.outcome).toBe("link_cancelled");
			expect(cancelled.response.status).toBe(200);
			expect(cancelled.response.headers.getSetCookie()).toEqual([
				clearBrowserCookie("transaction"),
			]);
			expect(rows(f)[0]).toMatchObject({ state: "failed", failure_reason: "browser_cancelled" });
			expect(rows(f, TABLE)[0]).toMatchObject({ nonce: null, pkce_verifier: null });
			expect(authority(f)).toEqual(before);
		}
	},
);

it.each(["cancel", "provider-failure"])(
	"%s fails only the bound attempt and clears only TXN",
	async (action) => {
		// Arrange
		const f = await setup();
		const unrelated = await unrelatedPending(f);
		const otherAttempt = rows(f).find((row) => row.attempt_id === "other-attempt");
		const before = authority(f);
		expect(rows(f, TABLE).find((row) => row.attempt_id === "attempt-a")).toMatchObject({
			state: "pending",
			nonce: f.authorization.material.nonce,
			pkce_verifier: f.authorization.material.pkceVerifier,
		});
		// Act
		let response: Response;
		if (action === "cancel")
			response = (await f.handlers.cancel(post(f, "cancel"), "trusted-client")).response;
		else {
			const url = new URL(f.url);
			url.searchParams.delete("code");
			url.searchParams.set("error", "access_denied");
			response = (await f.callback(new Request(url, { headers: { cookie: f.header } }))).response;
		}
		// Assert
		expect(response.status).toBe(action === "cancel" ? 200 : 403);
		expect(response.headers.getSetCookie()).toEqual([clearBrowserCookie("transaction")]);
		expect(rows(f)[0]).toMatchObject({
			state: "failed",
			failure_reason: action === "cancel" ? "browser_cancelled" : "provider_failure",
		});
		expect(rows(f, TABLE).find((row) => row.attempt_id === "attempt-a")).toMatchObject({
			state: action === "cancel" ? "expired" : "consumed",
			nonce: null,
			pkce_verifier: null,
		});
		expect(f.operations.retireAuthBrowserTransactions).toHaveBeenCalledExactlyOnceWith(f.config, {
			attemptId: "attempt-a",
		});
		expect(rows(f, TABLE).filter((row) => row.attempt_id !== "attempt-a")).toEqual(unrelated);
		expect(rows(f).find((row) => row.attempt_id === "other-attempt")).toEqual(otherAttempt);
		expect(authority(f)).toEqual(before);
		for (const spy of Object.values(f.callbackStore).slice(1)) expect(spy).not.toHaveBeenCalled();
		if (action === "cancel") {
			const retry = await f.handlers.cancel(post(f, "cancel"), "trusted-client");
			await safe(retry.response, 403);
		}
	},
);

it.each(["before-write", "after-write"])(
	"keeps the cookie when cancellation fails %s",
	async (fault) => {
		// Arrange
		const f = await setup();
		const before = authority(f);
		f.operations.failAuthLinkAttempt.mockImplementation(async (...args) => {
			if (fault === "after-write") await f.store.failAuthLinkAttempt(...args);
			throw new Error("privateCause");
		});
		// Act
		const result = await f.handlers.cancel(post(f, "cancel"), "trusted-client");
		// Assert
		await safe(result.response, 503);
		expect(authority(f)).toEqual(before);
		expect(rows(f)[0].state).toBe(fault === "after-write" ? "failed" : "browser_claimed");
	},
);

it("rejects a provider callback from another browser without contacting Google or failing the attempt", async () => {
	// Arrange
	const f = await setup();
	const before = rows(f);
	const cookie = (await issueBrowserCookie("transaction")).setCookie.split(";")[0];
	f.oidc.fetch.mockClear();
	// Act
	const result = await f.callback(new Request(f.url, { headers: { cookie } }));
	// Assert
	await safe(result.response, 403);
	expect(f.oidc.fetch).not.toHaveBeenCalled();
	expect(f.operations.recordAuthLinkOidcVerified).not.toHaveBeenCalled();
	expect(f.operations.failAuthLinkAttempt).not.toHaveBeenCalled();
	expect(f.operations.retireAuthBrowserTransactions).not.toHaveBeenCalled();
	expect(rows(f)).toEqual(before);
});

it("disables trusted configuration without calling dependencies or discovering Google", async () => {
	// Arrange
	const f = await setup();
	for (const spy of Object.values(f.operations)) spy.mockClear();
	f.oidc.fetch.mockClear();
	// Act
	const result = createCoordinatorBrowserLinkHandlers({
		config: { ...f.config, enabled: false },
		csrfKey: f.csrfKey,
		store: f.operations,
		limiter: f.limiter,
	});
	// Assert
	expect(result).toEqual({ ok: false, error: "browser_auth_disabled" });
	expect(Object.isFrozen(result)).toBe(true);
	for (const spy of Object.values(f.operations)) expect(spy).not.toHaveBeenCalled();
	expect(f.limiter.check).not.toHaveBeenCalled();
	expect(f.oidc.fetch).not.toHaveBeenCalled();
});

it.each(["missing-cookie", "wrong-cookie", "changed-config", "other-attempt"])(
	"cancellation rejects %s and leaves unrelated proof intact",
	async (scenario) => {
		// Arrange
		const f = await setup();
		const before = rows(f);
		let cookie = f.header;
		if (scenario === "missing-cookie") cookie = "";
		if (scenario === "wrong-cookie")
			cookie = (await issueBrowserCookie("transaction")).setCookie.split(";")[0];
		const other = "other-attempt";
		if (scenario === "other-attempt")
			expect(
				await f.store.createAuthLinkAttempt(
					attempt({ attemptId: other, runtimeVerifierHash: "e".repeat(64) }),
					f.config,
				),
			).toMatchObject({ kind: "created" });
		const otherBefore = rows(f).find((row) => row.attempt_id === other);
		const handlers =
			scenario === "changed-config"
				? createCoordinatorBrowserLinkHandlers({
						config: { ...f.config, revision: "b".repeat(64) },
						csrfKey: f.csrfKey,
						store: f.operations,
						limiter: f.limiter,
					})
				: f.link;
		if (!handlers.ok) throw new Error("Enabled trusted config expected");
		// Act
		const result = await handlers.handlers.cancel(
			post(f, "cancel", scenario === "other-attempt" ? { attempt_id: other } : {}, cookie),
			"trusted-client",
		);
		// Assert
		await safe(result.response, 403);
		expect(f.operations.failAuthLinkAttempt).not.toHaveBeenCalled();
		expect(f.operations.retireAuthBrowserTransactions).not.toHaveBeenCalled();
		expect(rows(f).find((row) => row.attempt_id === "attempt-a")).toEqual(before[0]);
		expect(rows(f).find((row) => row.attempt_id === other)).toEqual(otherBefore);
	},
);

it.each(["throw", "rejected", "more"])(
	"retirement %s keeps the cookie after failure committed, without claiming rollback",
	async (fault) => {
		// Arrange: pending LINK still holds raw nonce/PKCE before explicit cancellation.
		const f = await setup();
		const unrelated = await unrelatedPending(f);
		const before = authority(f);
		if (fault === "throw")
			f.operations.retireAuthBrowserTransactions.mockRejectedValue(new Error("privateCause"));
		if (fault === "rejected")
			f.operations.retireAuthBrowserTransactions.mockResolvedValue({
				kind: "rejected",
				error: "invalid_input",
			});
		if (fault === "more")
			f.operations.retireAuthBrowserTransactions.mockResolvedValue({
				kind: "retired",
				processedCount: 0,
				more: true,
			});
		// Act
		const result = await f.handlers.cancel(post(f, "cancel"), "trusted-client");
		// Assert: later maintenance is required; failed attempts are not browser-resolvable.
		await safe(result.response, 503);
		expect(rows(f)[0]).toMatchObject({ state: "failed", failure_reason: "browser_cancelled" });
		expect(rows(f, TABLE).find((row) => row.attempt_id === "attempt-a")).toMatchObject({
			state: "pending",
			nonce: f.authorization.material.nonce,
			pkce_verifier: f.authorization.material.pkceVerifier,
		});
		expect(f.operations.retireAuthBrowserTransactions).toHaveBeenCalledExactlyOnceWith(f.config, {
			attemptId: "attempt-a",
		});
		expect(rows(f, TABLE).filter((row) => row.attempt_id !== "attempt-a")).toEqual(unrelated);
		expect(authority(f)).toEqual(before);
	},
);

it("cancellation renderer failure precedes failure and retirement writes", async () => {
	// Arrange
	const f = await setup();
	const before = rows(f, TABLE);
	const digest = crypto.subtle.digest.bind(crypto.subtle);
	vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
		const data = args[1];
		if (ArrayBuffer.isView(data) && data.byteLength > 32) throw new Error("privateCause");
		return digest(...args);
	});
	// Act
	const result = await f.handlers.cancel(post(f, "cancel"), "trusted-client");
	// Assert
	await safe(result.response, 503);
	expect(f.operations.failAuthLinkAttempt).not.toHaveBeenCalled();
	expect(f.operations.retireAuthBrowserTransactions).not.toHaveBeenCalled();
	expect(rows(f, TABLE)).toEqual(before);
	expect(rows(f)[0].state).toBe("browser_claimed");
});

it.each(["digest", "style"])(
	"renderer crypto failure %s cannot confirm or release a hop",
	async (fault) => {
		// Arrange
		const f = await setup();
		await verified(f);
		const before = rows(f);
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		let calls = 0;
		vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
			// Two cookie hashes precede the raw completion hash and then the page style hash.
			calls += 1;
			if (calls === (fault === "digest" ? 3 : 4)) throw new Error("privateCause");
			return digest(...args);
		});
		// Act
		const result = await f.handlers.confirm(post(f), "trusted-client");
		// Assert
		await safe(result.response, 503);
		expect(await result.response.text()).not.toContain("completion=");
		expect(f.operations.confirmAuthLinkAttempt).not.toHaveBeenCalled();
		expect(rows(f)).toEqual(before);
	},
);
