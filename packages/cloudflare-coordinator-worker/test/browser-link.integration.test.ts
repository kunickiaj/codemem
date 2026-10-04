import { env, exports } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCoordinatorBrowserAuthCallback } from "../../core/src/coordinator-browser-auth-callback.js";
import {
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
} from "../../core/src/coordinator-browser-credential.js";
import {
	importBrowserCsrfKey,
	issueBrowserCsrfToken,
} from "../../core/src/coordinator-browser-csrf.js";
import { createCoordinatorBrowserLinkHandlers } from "../../core/src/coordinator-browser-link.js";
import { createCoordinatorOidcClient } from "../../core/src/coordinator-oidc.js";
import { oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

const ORIGIN = "https://app.example.test";
const NOW = 1791028800000;
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
	}
});
async function setup(destination = "http://127.0.0.1:80/codemem/auth/complete") {
	const config = Object.freeze({
		enabled: true,
		coordinatorId: crypto.randomUUID(),
		issuer: "https://accounts.google.com",
		redirectUri: PROVIDER.redirectUri,
		revision: "a".repeat(64),
	});
	// Two wrappers over the native pool binding, not independent production connections.
	const stores = [
		new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW }),
		new D1CoordinatorStore(env.COORDINATOR_DB, { authClock: () => NOW }),
	];
	const store = stores[0];
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
	await store.createGroup(review.groupId, "Fixture group");
	await store.enrollDevice(review.groupId, { ...review, identityId: null });
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	const attempt = {
		attemptId: crypto.randomUUID(),
		signer: review,
		runtimeVerifierHash: "d".repeat(64),
		loopbackRedirect: destination,
	};
	expect(await store.createAuthLinkAttempt(attempt, config)).toMatchObject({ kind: "created" });
	const oidc = oidcFixture({ issuer: config.issuer });
	oidc.claims.roles = ["administrator"];
	const rawConfig = { ...config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret };
	const client = await createCoordinatorOidcClient(rawConfig, { fetch: oidc.fetch });
	if (!client.ok) throw new Error("SDK setup failed");
	const authorization = await client.client.createAuthorizationRequest();
	const issued = await issueBrowserCookie("transaction");
	const cookie = issued.setCookie.split(";")[0];
	const parsed = await readBrowserCookie(cookie, "transaction");
	if (parsed.kind !== "present") throw new Error("Cookie setup failed");
	expect(
		await store.startAuthBrowserTransaction(
			{
				purpose: "link",
				attemptId: attempt.attemptId,
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
		retireAuthBrowserTransactions: vi.fn(store.retireAuthBrowserTransactions.bind(store)),
		resolveAuthLinkBrowserTransaction: vi.fn(store.resolveAuthLinkBrowserTransaction.bind(store)),
		recordAuthLinkOidcVerified: vi.fn(store.recordAuthLinkOidcVerified.bind(store)),
		readAuthLinkCompletionDestination: vi.fn(store.readAuthLinkCompletionDestination.bind(store)),
		confirmAuthLinkAttempt: vi.fn(store.confirmAuthLinkAttempt.bind(store)),
		failAuthLinkAttempt: vi.fn(store.failAuthLinkAttempt.bind(store)),
	};
	const link = createCoordinatorBrowserLinkHandlers({
		config,
		csrfKey,
		limiter,
		store: operations,
	});
	if (!link.ok) throw new Error("Link setup failed");
	const callback = await createCoordinatorBrowserAuthCallback({
		config: rawConfig,
		store,
		completeLink: link.handlers.completeLink,
		oidcOptions: { fetch: oidc.fetch },
	});
	if (!callback.ok) throw new Error("Callback setup failed");
	const csrf = await issueBrowserCsrfToken(csrfKey, parsed.secret, "transaction", {
		publicOrigin: ORIGIN,
		store: config,
	});
	return {
		config,
		stores,
		store,
		review,
		attempt,
		oidc,
		cookie,
		csrf,
		limiter,
		operations,
		handlers: link.handlers,
		callback: callback.handlers.callback,
		url: oidc.authorize(new URL(authorization.authorizationUrl)),
		destination,
	};
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function rows(f: Fixture, table = "coordinator_auth_link_attempts") {
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
		links: await rows(f, "coordinator_auth_account_links"),
		audit: await rows(f, "coordinator_auth_link_audit_log"),
		sessions: await rows(f, "coordinator_auth_sessions"),
		profiles: await rows(f, "coordinator_auth_account_profiles"),
		device: await f.stores[1].getEnrollment(f.review.groupId, f.review.deviceId),
		grants: (
			await env.COORDINATOR_DB.prepare(
				"SELECT * FROM coordinator_bootstrap_grants ORDER BY rowid",
			).all()
		).results,
	};
}
function post(
	f: Fixture,
	action = "confirm",
	cookie = f.cookie,
	origin = ORIGIN,
	attemptId = f.attempt.attemptId,
) {
	return new Request(`${ORIGIN}/auth/link/${action}`, {
		method: "POST",
		headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ csrf: f.csrf, attempt_id: attemptId }),
	});
}

it("native D1 Google callback and explicit confirmation preserve literal IPv4/IPv6 loopback destinations", async () => {
	// Arrange: deterministic logical time, actual SDK exchange, native D1 and HMAC.
	for (const destination of [
		"http://127.0.0.1:80/codemem/auth/complete",
		"http://[::1]:80/codemem/auth/complete",
	]) {
		const f = await setup(destination);
		const before = await authority(f);
		// Act
		const callback = await f.callback(new Request(f.url, { headers: { cookie: f.cookie } }));
		const page = await callback.response.text();
		// Assert: callback is display-only until explicit browser and device proof.
		expect(callback.outcome).toBe("link_dispatched");
		expect(callback.response.status).toBe(200);
		expect(callback.response.headers.getSetCookie()).toEqual([]);
		expect(page).toContain("Fixture User");
		for (const target of [f.review.identityId, f.review.groupId, f.review.deviceId])
			expect(page).toContain(target);
		expect(await authority(f)).toEqual(before);
		expect((await rows(f, "coordinator_auth_browser_transactions"))[0]).toMatchObject({
			state: "consumed",
			nonce: null,
			pkce_verifier: null,
		});
		const confirmed = await f.handlers.confirm(post(f), "trusted-client");
		const body = await confirmed.response.text();
		const anchors = [...body.matchAll(/<a\b[^>]*href="([^"]+)"/g)];
		expect(confirmed.outcome).toBe("link_confirmed");
		expect(confirmed.response.status).toBe(200);
		expect(confirmed.response.headers.getSetCookie()).toEqual([]);
		expect(anchors).toHaveLength(1);
		const href = anchors[0][1].replaceAll("&amp;", "&");
		const secret = new URL(href).searchParams.get("completion") ?? "";
		expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(href).toBe(`${destination}?attempt_id=${f.attempt.attemptId}&completion=${secret}`);
		const decoded = Buffer.from(secret, "base64url");
		expect(decoded).toHaveLength(32);
		const hash = createHash("sha256").update(decoded).digest("hex");
		expect((await rows(f))[0]).toMatchObject({ state: "confirmed", completion_secret_hash: hash });
		expect(hash).not.toBe(createHash("sha256").update(secret).digest("hex"));
		expect(body.replace(anchors[0][0], "")).not.toContain(secret);
		expect(JSON.stringify([...confirmed.response.headers])).not.toContain(secret);
		expect(await authority(f)).toEqual(before);
		const final = {
			...f.review,
			...f.attempt,
			purpose: "coordinator-account-link-v1" as const,
			completionSecretHash: hash,
		};
		expect(
			await f.stores[1].finalizeAuthLinkAttempt(
				{ ...final, completionSecretHash: "e".repeat(64) },
				f.config,
			),
		).toMatchObject({ kind: "rejected" });
		expect(
			await f.stores[1].finalizeAuthLinkAttempt(
				{ ...final, runtimeVerifierHash: "e".repeat(64) },
				f.config,
			),
		).toMatchObject({ kind: "rejected" });
		expect(await authority(f)).toEqual(before);
		const replay = await f.handlers.confirm(post(f), "trusted-client");
		expect(replay.response.status).toBe(403);
		expect(replay.response.headers.getSetCookie()).toEqual([]);
		expect(await replay.response.text()).not.toContain("completion=");
		expect((await rows(f))[0].completion_secret_hash).toBe(hash);
		expect(await f.stores[1].finalizeAuthLinkAttempt(final, f.config)).toMatchObject({
			kind: "applied",
		});
		expect(await rows(f, "coordinator_auth_account_links")).toHaveLength(1);
	}
});

it("native D1 cancellation and provider failure clear only the proven transaction cookie", async () => {
	// Arrange
	for (const action of ["cancel", "provider-failure"]) {
		const f = await setup();
		const rawConfig = {
			...f.config,
			clientId: PROVIDER.clientId,
			clientSecret: PROVIDER.clientSecret,
		};
		const client = await createCoordinatorOidcClient(rawConfig, { fetch: f.oidc.fetch });
		if (!client.ok) throw new Error("SDK setup failed");
		const otherAttempt = {
			...f.attempt,
			attemptId: crypto.randomUUID(),
			runtimeVerifierHash: "e".repeat(64),
		};
		expect(await f.store.createAuthLinkAttempt(otherAttempt, f.config)).toMatchObject({
			kind: "created",
		});
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
					? { ...input, purpose, attemptId: otherAttempt.attemptId }
					: { ...input, purpose };
			expect(await f.store.startAuthBrowserTransaction(start, f.config)).toMatchObject({
				kind: "started",
			});
		}
		const unrelated = (await rows(f, "coordinator_auth_browser_transactions")).filter(
			(row) => row.attempt_id !== f.attempt.attemptId,
		);
		const otherBefore = (await rows(f)).find((row) => row.attempt_id === otherAttempt.attemptId);
		const before = await authority(f);
		const pending = (await rows(f, "coordinator_auth_browser_transactions")).find(
			(row) => row.attempt_id === f.attempt.attemptId,
		);
		expect(pending).toMatchObject({ state: "pending" });
		expect(pending?.nonce).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
		expect(pending?.pkce_verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
		// Act
		let response: Response;
		if (action === "cancel")
			response = (await f.handlers.cancel(post(f, "cancel"), "trusted-client")).response;
		else {
			const url = new URL(f.url);
			url.searchParams.delete("code");
			url.searchParams.set("error", "access_denied");
			response = (await f.callback(new Request(url, { headers: { cookie: f.cookie } }))).response;
		}
		// Assert
		expect(response.status).toBe(action === "cancel" ? 200 : 403);
		expect(response.headers.getSetCookie()).toEqual([clearBrowserCookie("transaction")]);
		expect((await rows(f))[0]).toMatchObject({
			state: "failed",
			failure_reason: action === "cancel" ? "browser_cancelled" : "provider_failure",
		});
		expect(
			(await rows(f, "coordinator_auth_browser_transactions")).find(
				(row) => row.attempt_id === f.attempt.attemptId,
			),
		).toMatchObject({
			state: action === "cancel" ? "expired" : "consumed",
			nonce: null,
			pkce_verifier: null,
		});
		expect(f.operations.retireAuthBrowserTransactions).toHaveBeenCalledExactlyOnceWith(f.config, {
			attemptId: f.attempt.attemptId,
		});
		expect(
			(await rows(f, "coordinator_auth_browser_transactions")).filter(
				(row) => row.attempt_id !== f.attempt.attemptId,
			),
		).toEqual(unrelated);
		expect((await rows(f)).find((row) => row.attempt_id === otherAttempt.attemptId)).toEqual(
			otherBefore,
		);
		expect(await authority(f)).toEqual(before);
		const retry = await f.handlers.cancel(post(f, "cancel"), "trusted-client");
		expect(retry.response.status).toBe(403);
		expect(retry.response.headers.getSetCookie()).toEqual([]);
	}
});

it("native D1 rejects wrong Origin/proof/attempt and precommit faults without grants or cookie clearing", async () => {
	// Arrange
	const f = await setup();
	const before = await authority(f);
	const original = await rows(f);
	const wrongCookie = (await issueBrowserCookie("transaction")).setCookie.split(";")[0];
	// Act
	const origin = await f.handlers.confirm(
		post(f, "confirm", f.cookie, "https://evil.example.test"),
		"trusted-client",
	);
	// Assert
	expect(origin.response.status).toBe(403);
	expect(f.limiter.check).not.toHaveBeenCalled();
	for (const spy of Object.values(f.operations)) expect(spy).not.toHaveBeenCalled();
	for (const request of [
		post(f, "cancel", wrongCookie),
		post(f, "cancel", f.cookie, ORIGIN, "another-attempt"),
	]) {
		const result = await f.handlers.cancel(request, "trusted-client");
		expect(result.response.status).toBe(403);
		expect(result.response.headers.getSetCookie()).toEqual([]);
	}
	expect(await rows(f)).toEqual(original);
	f.operations.failAuthLinkAttempt.mockRejectedValue(new Error("privateCause"));
	const fault = await f.handlers.cancel(post(f, "cancel"), "trusted-client");
	expect(fault.response.status).toBe(503);
	expect(fault.response.headers.getSetCookie()).toEqual([]);
	expect(await fault.response.text()).not.toMatch(/privateCause|completion=/);
	expect(await rows(f)).toEqual(original);
	expect(await authority(f)).toEqual(before);
});

it("keeps new link handlers unmounted in the default Worker", async () => {
	// Arrange: native Worker route gate; no running browser or loopback listener implied.
	const paths = ["/auth/link/confirm", "/auth/link/cancel"];
	// Act
	const responses = await Promise.all(
		paths.flatMap((path) =>
			["GET", "POST"].map((method) =>
				exports.default.fetch(new Request(`${ORIGIN}${path}`, { method })),
			),
		),
	);
	// Assert
	for (const response of responses) {
		expect(response.status).toBe(404);
		expect(response.headers.getSetCookie()).toEqual([]);
	}
});
