import { env, exports } from "cloudflare:workers";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCoordinatorBrowserAuthCallback } from "../../core/src/coordinator-browser-auth-callback.js";
import { importBrowserCsrfKey } from "../../core/src/coordinator-browser-csrf.js";
import { createCoordinatorBrowserLinkHandlers } from "../../core/src/coordinator-browser-link.js";
import { createCoordinatorBrowserLinkStart } from "../../core/src/coordinator-browser-link-start.js";
import { oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { createInMemoryRequestRateLimiter } from "../../core/src/request-rate-limit.js";

const ORIGIN = "https://app.example.test";
const START = `${ORIGIN}/auth/link/start`;
const NOW = 1791028800000;
const TXNS = "coordinator_auth_browser_transactions";
const ATTEMPTS = "coordinator_auth_link_attempts";
const hash = (raw: Uint8Array | string) => createHash("sha256").update(raw).digest("hex");
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
async function setup(legacy = false) {
	const config = {
		enabled: true,
		coordinatorId: crypto.randomUUID(),
		issuer: "https://accounts.google.com",
		redirectUri: PROVIDER.redirectUri,
		revision: "a".repeat(64),
		clientId: PROVIDER.clientId,
		clientSecret: PROVIDER.clientSecret,
	};
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
	const startCode = randomBytes(32).toString("base64url");
	const attempt = {
		attemptId: crypto.randomUUID(),
		signer: review,
		runtimeVerifierHash: hash(randomBytes(32)),
		loopbackRedirect: "http://127.0.0.1:80/codemem/auth/complete",
		...(legacy ? {} : { browserStartHash: hash(Buffer.from(startCode, "base64url")) }),
	};
	expect(await store.createAuthLinkAttempt(attempt, config)).toMatchObject({ kind: "created" });
	const oidc = oidcFixture({ issuer: config.issuer });
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const limiter = createInMemoryRequestRateLimiter();
	const handlers = [];
	for (const store of stores) {
		const factory = await createCoordinatorBrowserLinkStart({
			config,
			csrfKey,
			limiter,
			store,
			oidcOptions: { fetch: oidc.fetch },
		});
		if (!factory.ok) throw new Error("Link start fixture failed");
		handlers.push(factory.handlers);
	}
	oidc.fetch.mockClear();
	return { config, stores, store, attempt, startCode, oidc, csrfKey, limiter, handlers };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function rows(f: Fixture, table = TXNS) {
	return (
		await env.COORDINATOR_DB.prepare(
			`SELECT * FROM ${table} WHERE coordinator_id = ? ORDER BY rowid`,
		)
			.bind(f.config.coordinatorId)
			.all<Record<string, unknown>>()
	).results;
}
async function form(f: Fixture, code = f.startCode) {
	const { response } = await f.handlers[0].linkStartPage(
		new Request(`${START}?attempt_id=${f.attempt.attemptId}&start_code=${code}`),
	);
	const body = await response.text();
	const fields = Object.fromEntries(
		[...body.matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map((m) => [m[1], m[2]]),
	);
	return {
		response,
		body,
		fields,
		cookie: response.headers.getSetCookie()[0]?.split(";")[0] ?? "",
	};
}
function post(c: Awaited<ReturnType<typeof form>>) {
	return new Request(START, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			cookie: c.cookie,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(c.fields),
	});
}

it("native D1 GET/POST feeds actual OIDC consume and existing callback/confirmation without mounting routes", async () => {
	// Arrange: native D1 binding and fake Google transport, no browser navigation or migrations invoked here.
	const f = await setup();
	const before = await rows(f, ATTEMPTS);
	const c = await form(f);
	const link = createCoordinatorBrowserLinkHandlers({
		config: f.config,
		csrfKey: f.csrfKey,
		limiter: f.limiter,
		store: f.store,
	});
	if (!link.ok) throw new Error("Link fixture failed");
	const callback = await createCoordinatorBrowserAuthCallback({
		config: f.config,
		store: f.store,
		completeLink: link.handlers.completeLink,
		oidcOptions: { fetch: f.oidc.fetch },
	});
	if (!callback.ok) throw new Error("Callback fixture failed");
	f.oidc.fetch.mockClear();
	// Assert: GET grants no claim, and the private code is intentionally in its hidden form.
	expect(c.response.status).toBe(200);
	expect(c.fields.start_code).toBe(f.startCode);
	expect(await rows(f)).toEqual([]);
	expect(await rows(f, ATTEMPTS)).toEqual(before);
	// Act
	const { response } = await f.handlers[0].linkStart(post(c), "native-client");
	const body = await response.text();
	const href = /href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/.exec(body)?.[1];
	if (!href) throw new Error("Missing Google continuation");
	const url = new URL(href.replaceAll("&amp;", "&"));
	const cookie = response.headers.getSetCookie()[0].split(";")[0];
	const stored = await rows(f);
	// Assert: independently decode cookie bytes, not the credential helper's hash.
	expect(response.status).toBe(200);
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(response.headers.getSetCookie()).toHaveLength(2);
	expect(stored).toHaveLength(1);
	expect(stored[0]).toMatchObject({
		purpose: "link",
		attempt_id: f.attempt.attemptId,
		binder_hash: hash(Buffer.from(c.cookie.split("=")[1], "base64url")),
		state_hash: hash(url.searchParams.get("state") ?? ""),
	});
	expect(cookie.split("=")[1]).toBe(c.cookie.split("=")[1]);
	expect(body).not.toContain(f.startCode);
	expect(f.oidc.fetch).not.toHaveBeenCalled();
	// Act: existing callback consumes actual state and PKCE through the SDK fake transport.
	const completed = await callback.handlers.callback(
		new Request(f.oidc.authorize(url), { headers: { cookie } }),
	);
	const confirmation = await completed.response.text();
	const csrf = /name="csrf" value="([^"]+)"/.exec(confirmation)?.[1] ?? "";
	const confirmed = await link.handlers.confirm(
		new Request(`${ORIGIN}/auth/link/confirm`, {
			method: "POST",
			headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ csrf, attempt_id: f.attempt.attemptId }),
		}),
		"native-client",
	);
	// Assert
	expect(completed.outcome).toBe("link_dispatched");
	expect(confirmed.response.status).toBe(200);
	expect((await rows(f))[0]).toMatchObject({ state: "consumed", nonce: null, pkce_verifier: null });
	expect((await rows(f, ATTEMPTS))[0].state).toBe("confirmed");
	expect(await rows(f, "coordinator_auth_account_links")).toEqual([]);
	for (const method of ["GET", "POST"]) {
		const unmounted = await exports.default.fetch(START, { method });
		expect(unmounted.status).toBe(404);
		expect(unmounted.headers.getSetCookie()).toEqual([]);
	}
});

it.each(["wrong", "legacy"])(
	"native D1 %s start proof cannot claim even with its own valid browser CSRF",
	async (fault) => {
		// Arrange
		const f = await setup(fault === "legacy");
		const c = await form(
			f,
			fault === "wrong" ? randomBytes(32).toString("base64url") : f.startCode,
		);
		const before = await rows(f, ATTEMPTS);
		// Act
		const { response } = await f.handlers[0].linkStart(post(c), "native-client");
		// Assert
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(await response.text()).not.toContain(c.fields.start_code);
		expect(await rows(f, ATTEMPTS)).toEqual(before);
		expect(await rows(f)).toEqual([]);
		expect(f.oidc.fetch).not.toHaveBeenCalled();
	},
);

it("native D1 competing adapters and browser binders admit one nonce/PKCE pair and retain it on replay", async () => {
	// Arrange: two adapter objects share the real pool binding, not separate production connections.
	const f = await setup();
	const left = await form(f);
	const right = await form(f);
	// Act
	const results = await Promise.all([
		f.handlers[0].linkStart(post(left), "left"),
		f.handlers[1].linkStart(post(right), "right"),
	]);
	const saved = await rows(f);
	const replay = await f.handlers[0].linkStart(post(left), "left");
	// Assert
	expect(results.map((r) => r.response.status).sort()).toEqual([200, 409]);
	expect(saved).toHaveLength(1);
	expect(saved[0].nonce).toBeTruthy();
	expect(saved[0].pkce_verifier).toBeTruthy();
	expect(replay.response.status).toBe(409);
	expect(replay.response.headers.getSetCookie()).toEqual([]);
	expect(await rows(f)).toEqual(saved);
	expect((await rows(f, ATTEMPTS))[0].state).toBe("browser_claimed");
});
