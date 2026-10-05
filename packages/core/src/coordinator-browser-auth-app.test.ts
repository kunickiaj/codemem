import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorAccountLinkReceiver } from "./coordinator-account-link-receiver.js";
import { type CreateCoordinatorAppOptions, createCoordinatorApp } from "./coordinator-api.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { review } from "./coordinator-auth-store-test-fixtures.js";
import {
	type CoordinatorBrowserAuthSnapshot,
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
	maintainCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";
import { buildCanonicalRequest, SIGNATURE_VERSION, verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const ORIGIN = "https://app.example.test";
const ROOT = "/v1/auth/link-attempts";
const TX = "coordinator_auth_browser_transactions";
const cleanup: (() => void | Promise<void>)[] = [];
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
});
afterEach(async () => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		for (const close of cleanup.splice(0)) await close();
	}
});
const hash = (raw: string) =>
	createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex");
function identity() {
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(8 + kind.length + raw.length);
	wire.writeUInt32BE(kind.length);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	return { deviceId: "device-a", publicKey, fingerprint: fingerprintPublicKey(publicKey), keys };
}
async function setup() {
	const directory = mkdtempSync(join(tmpdir(), "browser-auth-app-"));
	const path = join(directory, "fixture.sqlite");
	const store = new BetterSqliteCoordinatorStore(path, { authClock: () => NOW });
	cleanup.push(() => {
		store.db.close();
		rmSync(directory, { recursive: true });
	});
	const key = identity();
	await store.createGroup("group-a");
	await store.enrollDevice("group-a", key);
	await store.createAuthControllerAttestation(review(key));
	const config = {
		enabled: true,
		coordinatorId: "coordinator-a",
		issuer: "https://accounts.google.com",
		revision: "a".repeat(64),
		redirectUri: PROVIDER.redirectUri,
		clientId: PROVIDER.clientId,
		clientSecret: PROVIDER.clientSecret,
	};
	const oidc = oidcFixture({ issuer: config.issuer });
	const csrfKey = await importBrowserCsrfKey(randomBytes(32));
	const snapshot = captureCoordinatorBrowserAuthOptions({
		config,
		csrfKey,
		oidcOptions: { fetch: oidc.fetch },
	});
	const limiter = createInMemoryRequestRateLimiter({ now: () => NOW });
	const result = await createCoordinatorBrowserAuth(snapshot, store, limiter);
	if (!result.ok) throw new Error("Fixture composition failed");
	const requestStores: BetterSqliteCoordinatorStore[] = [];
	const storeFactory = () => {
		const requestStore = new BetterSqliteCoordinatorStore(path, { authClock: () => NOW });
		requestStores.push(requestStore);
		return requestStore;
	};
	const options: Pick<CreateCoordinatorAppOptions, "storeFactory" | "runtime" | "requestVerifier"> =
		{
			storeFactory,
			runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
			requestVerifier: (input) =>
				verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		};
	const mount = (auth = result.auth) =>
		createCoordinatorApp({
			...options,
			browserAuth: {
				kind: "ready",
				auth,
				storeFactory,
				clientKey: (c) => c.req.header("x-test-client") ?? "client-a",
			},
		});
	return {
		store,
		key,
		config,
		oidc,
		csrfKey,
		snapshot,
		limiter,
		mount,
		options,
		requestStores,
		app: mount(),
	};
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function rows(f: Fixture, table = TX) {
	return f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<
		string,
		unknown
	>[];
}
function authority(f: Fixture) {
	return [
		"groups",
		"enrolled_devices",
		"coordinator_scope_memberships",
		"coordinator_auth_controller_attestations",
	].map((table) => [table, rows(f, table)]);
}
async function form(response: Response, action?: string) {
	const html = await response.text();
	let markup = html;
	if (action)
		markup =
			html.match(new RegExp(`<form[^>]+action="${action}"[^>]*>([\\s\\S]*?)</form>`))?.[1] ?? "";
	return Object.fromEntries(
		[...markup.matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map((m) => [m[1], m[2]]),
	);
}
function cookie(response: Response) {
	return (
		response.headers
			.getSetCookie()
			.find((value) => !value.includes("Max-Age=0"))
			?.split(";")[0] ?? ""
	);
}
function post(
	app: Fixture["app"],
	path: string,
	fields: Record<string, string>,
	binder: string,
	client = "client-a",
) {
	return app.request(`${ORIGIN}${path}`, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			cookie: binder,
			"content-type": "application/x-www-form-urlencoded",
			"x-test-client": client,
		},
		body: new URLSearchParams(fields),
	});
}
async function signed(f: Fixture, path: string, value: unknown) {
	const body = JSON.stringify(value);
	const timestamp = String(NOW / 1000);
	const nonce = randomBytes(16).toString("hex");
	const signature = sign(
		null,
		buildCanonicalRequest("POST", path, timestamp, nonce, Buffer.from(body)),
		f.key.keys.privateKey,
	);
	return f.app.request(`${ORIGIN}${path}`, {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"X-Opencode-Device": f.key.deviceId,
			"X-Opencode-Timestamp": timestamp,
			"X-Opencode-Nonce": nonce,
			"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature.toString("base64")}`,
		},
	});
}
async function startLink(
	f: Fixture,
	attemptId = "attempt-a",
	options = { loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete" },
) {
	const startCode = randomBytes(32).toString("base64url");
	const runtimeVerifier = randomBytes(32).toString("base64url");
	const created = await signed(f, ROOT, {
		group_id: "group-a",
		attempt_id: attemptId,
		runtime_verifier_hash: hash(runtimeVerifier),
		browser_start_hash: hash(startCode),
		loopback_redirect: options.loopbackRedirect,
	});
	expect(created.status).toBe(201);
	const pinned = (await created.json()) as { identity_id: string; coordinator_id: string };
	const page = await f.app.request(
		`${ORIGIN}/auth/link/start?attempt_id=${attemptId}&start_code=${startCode}`,
	);
	const binder = cookie(page);
	const started = await post(f.app, "/auth/link/start", await form(page), binder);
	expect(started.status).toBe(200);
	return {
		pinned,
		startCode,
		runtimeVerifier,
		attemptId,
		binder: cookie(started),
		callback: f.oidc.authorize(authorization(await started.text())),
	};
}
function authorization(html: string) {
	const href = html.match(/href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/)?.[1];
	if (!href) throw new Error("Provider link missing");
	return new URL(href.replaceAll("&amp;", "&"));
}
async function signin(f: Fixture) {
	const page = await f.app.request(`${ORIGIN}/auth/sign-in`);
	const started = await post(f.app, "/auth/sign-in", await form(page), cookie(page));
	const callback = f.oidc.authorize(authorization(await started.text()));
	const binder = cookie(started);
	const response = await f.app.fetch(new Request(callback, { headers: { cookie: binder } }));
	return { response, callback, binder };
}
function navigateLoopback(href: string) {
	const url = new URL(href);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
		throw new Error("Only fixture loopback navigation is allowed");
	return new Promise<Response>((resolve, reject) => {
		const request = get(url, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => {
				body += chunk;
			});
			response.on("error", reject);
			response.on("end", () => resolve(new Response(body, { status: response.statusCode })));
		});
		request.on("error", reject);
	});
}

it("mounts signed device → Google → confirmation → finalize → completion → account/logout and fresh sign-in", async () => {
	// Arrange: one browser-held connection, separate closing HTTP connections, real SDK and signer.
	const f = await setup();
	const before = authority(f);
	const receiver = await createCoordinatorAccountLinkReceiver({
		attemptId: "attempt-a",
		coordinatorOrigin: ORIGIN,
	});
	cleanup.push(() => receiver.close());
	const link = await startLink(f, "attempt-a", { loopbackRedirect: receiver.destination });
	const callback = await f.app.fetch(
		new Request(link.callback, { headers: { cookie: link.binder } }),
	);
	const confirmed = await post(
		f.app,
		"/auth/link/confirm",
		await form(callback, "/auth/link/confirm"),
		link.binder,
	);
	const href = (await confirmed.text()).match(/href="(http:\/\/127\.0\.0\.1[^"]+)"/)?.[1];
	if (!href) throw new Error("Loopback hop missing");
	const received = await navigateLoopback(href.replaceAll("&amp;", "&"));
	const returnPage = await received.text();
	const returnHref = returnPage.match(/href="([^"]+)"/)?.[1];
	if (!returnHref) throw new Error("Receiver return navigation missing");
	const completion = await receiver.completion;
	expect(received.status).toBe(200);
	expect(returnHref).toBe(`${ORIGIN}/auth/link/complete?attempt_id=${link.attemptId}`);
	expect(returnPage).not.toContain(completion);
	expect(returnPage).toContain('referrerpolicy="no-referrer"');
	expect(new Set([link.startCode, link.runtimeVerifier, completion]).size).toBe(3);
	for (const raw of [link.startCode, link.runtimeVerifier, completion])
		expect(Buffer.from(raw, "base64url")).toHaveLength(32);
	expect(rows(f, "coordinator_auth_link_attempts")[0]).toMatchObject({
		runtime_verifier_hash: hash(link.runtimeVerifier),
		completion_secret_hash: hash(completion),
	});
	expect(rows(f, "coordinator_auth_account_profiles")).toEqual([]);
	// Act: only the pinned authenticated device can finalize the independent two proofs.
	const finalized = await signed(f, `${ROOT}/${link.attemptId}/finalize`, {
		purpose: "coordinator-account-link-v1",
		coordinator_id: link.pinned.coordinator_id,
		identity_id: link.pinned.identity_id,
		attempt_id: link.attemptId,
		group_id: "group-a",
		device_id: f.key.deviceId,
		fingerprint: f.key.fingerprint,
		runtime_verifier: link.runtimeVerifier,
		completion,
	});
	const page = await f.app.request(returnHref, {
		headers: { cookie: link.binder },
	});
	const completed = await post(f.app, "/auth/link/complete", await form(page), link.binder);
	const session = cookie(completed);
	const fresh = await signin(f);
	const freshSession = cookie(fresh.response);
	const account = await f.app.request(`${ORIGIN}/auth/account`, { headers: { cookie: session } });
	const accountHtml = await account.clone().text();
	const logout = await post(f.app, "/auth/logout", await form(account), session);
	const replay = await f.app.fetch(
		new Request(fresh.callback, { headers: { cookie: fresh.binder } }),
	);
	// Assert: replay mints nothing, logout ends only its SID, and enrollment authority never changes.
	expect(finalized.status).toBe(200);
	expect(completed.status).toBe(303);
	expect(fresh.response.status).toBe(303);
	expect(accountHtml).toContain("Fixture User");
	expect(accountHtml).toContain("user@example.test");
	expect(logout.status).toBe(200);
	expect(replay.status).toBe(403);
	expect(replay.headers.getSetCookie()).toEqual([]);
	expect(rows(f, "coordinator_auth_sessions")).toHaveLength(2);
	expect(
		rows(f, "coordinator_auth_sessions").filter((row) => row.revoked_at_ms === null),
	).toHaveLength(1);
	expect(
		(await f.app.request(`${ORIGIN}/auth/account`, { headers: { cookie: freshSession } })).status,
	).toBe(200);
	expect(authority(f)).toEqual(before);
	expect(f.requestStores.length).toBeGreaterThan(0);
	for (const store of f.requestStores) expect(store.db.open).toBe(false);
});

it("shares the captured CSRF key and twenty-request quota across fresh mounted apps", async () => {
	// Arrange
	const f = await setup();
	const app2 = f.mount();
	const page = await f.app.request(`${ORIGIN}/auth/sign-in`);
	const fields = await form(page);
	const binder = cookie(page);
	// Act: GET and POST enter different Hono apps but one frozen composition.
	const admitted = await post(app2, "/auth/sign-in", fields, binder);
	const responses = [];
	for (let i = 0; i < 20; i++) {
		const page = await f.app.request(`${ORIGIN}/auth/sign-in`);
		responses.push(
			await post(i % 2 ? app2 : f.app, "/auth/sign-in", await form(page), cookie(page)),
		);
	}
	const otherPage = await app2.request(`${ORIGIN}/auth/sign-in`);
	const other = await post(
		app2,
		"/auth/sign-in",
		await form(otherPage),
		cookie(otherPage),
		"client-b",
	);
	const otherKey = await importBrowserCsrfKey(randomBytes(32));
	const wrong = await createCoordinatorBrowserAuth(
		captureCoordinatorBrowserAuthOptions({
			config: f.config,
			csrfKey: otherKey,
			oidcOptions: { fetch: f.oidc.fetch },
		}),
		f.store,
		createInMemoryRequestRateLimiter(),
	);
	if (!wrong.ok) throw new Error("Wrong-key fixture failed");
	const rejected = await post(f.mount(wrong.auth), "/auth/sign-in", fields, binder);
	// Assert
	expect(admitted.status).toBe(200);
	expect(responses.slice(0, 19).every((r) => r.status === 200)).toBe(true);
	expect(responses[19].status).toBe(429);
	expect(other.status).toBe(200);
	expect(rejected.status).toBe(403);
});

it("captures config and transport once; accessor failures disclose no private cause", async () => {
	// Arrange
	const f = await setup();
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const getter = vi.fn(() => {
		throw new Error("private-config-secret");
	});
	const hostile = Object.defineProperty({ ...f.config }, "clientSecret", { get: getter });
	// Act
	f.config.clientSecret = "mutated-secret";
	f.config.redirectUri = "https://changed.example.test/auth/callback";
	const created = await createCoordinatorBrowserAuth(f.snapshot, f.store, f.limiter);
	const invalid = captureCoordinatorBrowserAuthOptions({ config: hostile, csrfKey: f.csrfKey });
	// Assert
	expect(created.ok).toBe(true);
	expect(Object.isFrozen(f.snapshot)).toBe(true);
	expect(invalid).toMatchObject({ kind: "invalid", field: "clientSecret" });
	expect(getter).not.toHaveBeenCalled();
	expect(errors).not.toHaveBeenCalled();
});

it("keeps captured snapshots opaque and rejects reconstructed authority before SDK or store calls", async () => {
	// Arrange: a real handle works, but copied fields cannot nominate callback authority.
	const f = await setup();
	const serialized = JSON.stringify(f.snapshot);
	const legitimate = await createCoordinatorBrowserAuth(f.snapshot, f.store, f.limiter);
	const maintain = vi.spyOn(f.store, "maintainAuthLinkAttempts");
	f.oidc.fetch.mockClear();
	const copies = [
		{ kind: "enabled" },
		{ ...f.snapshot, callbackPath: "/auth/injected-callback" },
	] as unknown as CoordinatorBrowserAuthSnapshot[];
	// Act: both admission and maintenance must require the original captured handle.
	const created = await Promise.all(
		copies.map((copy) => createCoordinatorBrowserAuth(copy, f.store, f.limiter)),
	);
	const maintained = await Promise.all(
		copies.map((copy) => maintainCoordinatorBrowserAuth(copy, f.store)),
	);
	// Assert: soft assertions show both disclosure and authority bypass in the pre-fix regression.
	expect(legitimate.ok).toBe(true);
	expect.soft(serialized === '{"kind":"enabled"}').toBe(true);
	expect
		.soft(
			[PROVIDER.clientSecret, "clientSecret", "clientId", "CryptoKey", "transport"].some((value) =>
				serialized.includes(value),
			),
		)
		.toBe(false);
	expect
		.soft(created)
		.toEqual(copies.map(() => ({ ok: false, error: "browser_auth_setup_failed" })));
	expect
		.soft(maintained)
		.toEqual(copies.map(() => ({ kind: "failed", error: "maintenance_failed", step: "options" })));
	expect.soft(f.oidc.fetch).not.toHaveBeenCalled();
	expect.soft(maintain).not.toHaveBeenCalled();
});

it("keeps defaults off and invalid callback patterns unavailable without partial mounts", async () => {
	// Arrange
	const f = await setup();
	const legacy = createCoordinatorApp(f.options);
	const unavailable = createCoordinatorApp({ ...f.options, browserAuth: { kind: "unavailable" } });
	f.oidc.fetch.mockClear();
	// Act
	const disabled = captureCoordinatorBrowserAuthOptions({
		config: { enabled: false },
		csrfKey: f.csrfKey,
	});
	const paths = ["/auth/sign-in", "/other/callback", "/auth/:callback", "/auth/*"];
	const invalid = paths.map((path) =>
		captureCoordinatorBrowserAuthOptions({
			config: { ...f.config, redirectUri: `${ORIGIN}${path}` },
			csrfKey: f.csrfKey,
		}),
	);
	const responses = await Promise.all([
		legacy.request(`${ORIGIN}/v1/admin/groups`),
		legacy.request(`${ORIGIN}/auth/sign-in`),
		legacy.request(`${ORIGIN}${ROOT}`, { method: "POST" }),
		unavailable.request(`${ORIGIN}/v1/admin/groups`),
		unavailable.request(`${ORIGIN}${ROOT}`, { method: "POST" }),
	]);
	// Assert
	expect(disabled).toEqual({ kind: "disabled" });
	expect(invalid.every((snapshot) => snapshot.kind === "invalid")).toBe(true);
	expect(responses.map((r) => r.status)).toEqual([401, 404, 404, 401, 503]);
	expect(f.oidc.fetch).not.toHaveBeenCalled();
});

it("rejects wrong methods before creating state and contains store failures", async () => {
	// Arrange
	const f = await setup();
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const methods = [
		["/auth/sign-in", "HEAD"],
		["/auth/link/confirm", "GET"],
		["/auth/account", "PUT"],
	];
	// Act
	const responses = await Promise.all(
		methods.map(([path, method]) => f.app.request(`${ORIGIN}${path}`, { method })),
	);
	vi.spyOn(f.store, "readAuthSessionAccount").mockRejectedValue(new Error("private-store-input"));
	const created = await createCoordinatorBrowserAuth(f.snapshot, f.store, f.limiter);
	if (!created.ok) throw new Error("Fault composition failed");
	const failure = await f.mount(created.auth).request(`${ORIGIN}/auth/account`, {
		headers: { cookie: `__Host-codemem-session=${randomBytes(32).toString("base64url")}` },
	});
	// Assert
	expect(responses.map((r) => r.status)).toEqual([405, 405, 405]);
	expect(rows(f)).toEqual([]);
	expect(failure.status).toBe(503);
	expect(failure.headers.get("cache-control")).toBe("no-store");
	expect(failure.headers.get("referrer-policy")).toBe("no-referrer");
	expect(await failure.text()).not.toContain("private-store-input");
	expect(errors).not.toHaveBeenCalled();
});

it("mounted cancel retires only its link proofs and rejects the cancelled callback", async () => {
	// Arrange
	const f = await setup();
	const first = await startLink(f);
	const second = await startLink(f, "attempt-b");
	const callback = await f.app.fetch(
		new Request(first.callback, { headers: { cookie: first.binder } }),
	);
	const fields = await form(callback, "/auth/link/cancel");
	const before = rows(f).find((row) => row.attempt_id === "attempt-b");
	// Act
	const cancelled = await post(f.app, "/auth/link/cancel", fields, first.binder);
	const replay = await f.app.fetch(
		new Request(first.callback, { headers: { cookie: first.binder } }),
	);
	// Assert
	expect(cancelled.status).toBe(200);
	expect(replay.status).toBe(403);
	expect(rows(f).find((row) => row.attempt_id === second.attemptId)).toEqual(before);
	expect(rows(f).find((row) => row.attempt_id === first.attemptId)).toMatchObject({
		nonce: null,
		pkce_verifier: null,
	});
	expect(rows(f, "coordinator_auth_sessions")).toEqual([]);
	expect(rows(f, "coordinator_auth_account_profiles")).toEqual([]);
});

it("maintenance runs stages in order with independent budgets and fixed failed-step errors", async () => {
	// Arrange
	const f = await setup();
	const names = [
		"maintainAuthLinkAttempts",
		"retireAuthBrowserTransactions",
		"purgeAuthSigninBrowserTransactions",
		"purgeAuthGuardedSigninSessions",
		"purgeAuthGuardedSigninReceipts",
	] as const;
	const calls: string[] = [];
	const methods = Object.fromEntries(
		names.map((name) => [
			name,
			vi.fn(async () => {
				calls.push(name);
				return { kind: "purged", processedCount: 2, more: true };
			}),
		]),
	);
	const store = methods as unknown as Parameters<typeof maintainCoordinatorBrowserAuth>[1];
	// Act
	const result = await maintainCoordinatorBrowserAuth(f.snapshot, store, { maxBatches: 2 });
	methods.retireAuthBrowserTransactions.mockRejectedValueOnce(
		new Error("private-maintenance-cause"),
	);
	const failed = await maintainCoordinatorBrowserAuth(f.snapshot, store, { maxBatches: 1 });
	const invalid = await maintainCoordinatorBrowserAuth(f.snapshot, store, { maxBatches: 0 });
	// Assert
	expect(result).toEqual({ kind: "maintained", processedCount: 20, more: true });
	expect(calls.slice(0, 10)).toEqual(names.flatMap((name) => [name, name]));
	expect(failed).toEqual({
		kind: "failed",
		error: "maintenance_failed",
		step: "browser_retirement",
	});
	expect(invalid).toEqual({ kind: "failed", error: "maintenance_failed", step: "options" });
});

it("actual maintenance zeroes failed pending link material without erasing reviewed history", async () => {
	// Arrange
	const f = await setup();
	const link = await startLink(f);
	const before = authority(f);
	await f.store.failAuthLinkAttempt(
		{
			attemptId: link.attemptId,
			requester: { kind: "device", signer: { groupId: "group-a", ...f.key } },
			reason: "cancelled",
		},
		f.config,
	);
	// Act
	const result = await maintainCoordinatorBrowserAuth(f.snapshot, f.store, { maxBatches: 1 });
	const again = await maintainCoordinatorBrowserAuth(f.snapshot, f.store, { maxBatches: 1 });
	// Assert
	expect(result.kind).toBe("maintained");
	expect(again).toEqual({ kind: "maintained", processedCount: 0, more: false });
	expect(rows(f)[0]).toMatchObject({ state: "expired", nonce: null, pkce_verifier: null });
	expect(rows(f, "coordinator_auth_link_attempts")[0].state).toBe("failed");
	expect(authority(f)).toEqual(before);
});
