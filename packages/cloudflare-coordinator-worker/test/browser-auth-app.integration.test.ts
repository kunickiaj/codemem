import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { importBrowserCsrfKey } from "../../core/src/coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { buildCanonicalRequest, SIGNATURE_VERSION } from "../../core/src/sync-auth.js";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint.js";
import { createCloudflareCoordinatorWorker } from "../src/index.js";

const ORIGIN = "https://app.example.test";
const ROOT = "/v1/auth/link-attempts";
const NOW = 1791028800000;
beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});
const hash = (raw: string) =>
	createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex");
async function setup() {
	const config = {
		enabled: true,
		coordinatorId: crypto.randomUUID(),
		issuer: "https://accounts.google.com",
		revision: "a".repeat(64),
		redirectUri: PROVIDER.redirectUri,
		clientId: PROVIDER.clientId,
		clientSecret: PROVIDER.clientSecret,
	};
	const oidc = oidcFixture({ issuer: config.issuer });
	const csrfKey = await importBrowserCsrfKey(crypto.getRandomValues(new Uint8Array(32)));
	const worker = createCloudflareCoordinatorWorker({
		now: () => new Date(NOW).toISOString(),
		browserAuth: { config, csrfKey, oidcOptions: { fetch: oidc.fetch } },
	});
	const store = new D1CoordinatorStore(env.COORDINATOR_DB);
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(8 + kind.length + raw.length);
	wire.writeUInt32BE(kind.length);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const review = {
		coordinatorId: config.coordinatorId,
		groupId: crypto.randomUUID(),
		deviceId: crypto.randomUUID(),
		identityId: crypto.randomUUID(),
		attestationId: crypto.randomUUID(),
		reviewReceiptId: crypto.randomUUID(),
		publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		evidenceDigest: "b".repeat(64),
	};
	await store.createGroup(review.groupId);
	await store.enrollDevice(review.groupId, review);
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	const request = (path: string | URL, init?: RequestInit) =>
		worker.fetch(new Request(new URL(path, ORIGIN), init), env);
	return { config, csrfKey, oidc, worker, store, keys, review, request };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function rows(f: Fixture, suffix: string) {
	return (
		await env.COORDINATOR_DB.prepare(
			`SELECT * FROM coordinator_auth_${suffix} WHERE coordinator_id = ? ORDER BY rowid`,
		)
			.bind(f.config.coordinatorId)
			.all<Record<string, unknown>>()
	).results;
}
async function form(response: Response, action?: string) {
	const html = await response.text();
	const markup = action
		? (html.match(new RegExp(`<form[^>]+action="${action}"[^>]*>([\\s\\S]*?)</form>`))?.[1] ?? "")
		: html;
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
	f: Fixture,
	path: string,
	fields: Record<string, string>,
	binder: string,
	ip = "127.0.0.1",
) {
	return f.request(path, {
		method: "POST",
		body: new URLSearchParams(fields),
		headers: {
			origin: ORIGIN,
			cookie: binder,
			"content-type": "application/x-www-form-urlencoded",
			"CF-Connecting-IP": ip,
		},
	});
}
function signed(f: Fixture, path: string, value: unknown) {
	const body = JSON.stringify(value),
		timestamp = String(NOW / 1000),
		nonce = randomBytes(16).toString("hex");
	const signature = sign(
		null,
		buildCanonicalRequest("POST", path, timestamp, nonce, Buffer.from(body)),
		f.keys.privateKey,
	);
	return f.request(path, {
		method: "POST",
		body,
		headers: {
			"content-type": "application/json",
			"X-Opencode-Device": f.review.deviceId,
			"X-Opencode-Timestamp": timestamp,
			"X-Opencode-Nonce": nonce,
			"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature.toString("base64")}`,
		},
	});
}
function authorize(f: Fixture, html: string) {
	const href = html.match(/href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/)?.[1];
	if (!href) throw new Error("Missing Google continuation");
	return f.oidc.authorize(new URL(href.replaceAll("&amp;", "&")));
}

it("runs the mounted Worker link, native Ed25519 finalize, completion and subsequent Google session", async () => {
	// Arrange: native D1 and actual Worker verifier; only Google transport is fake.
	const f = await setup();
	const deviceBefore = await f.store.getEnrollment(f.review.groupId, f.review.deviceId);
	const attemptId = crypto.randomUUID();
	const startCode = randomBytes(32).toString("base64url"),
		runtimeVerifier = randomBytes(32).toString("base64url");
	const created = await signed(f, ROOT, {
		group_id: f.review.groupId,
		attempt_id: attemptId,
		runtime_verifier_hash: hash(runtimeVerifier),
		browser_start_hash: hash(startCode),
		loopback_redirect: "http://[::1]:4567/codemem/auth/complete",
	});
	const pinned = (await created.json()) as { coordinator_id: string; identity_id: string };
	const page = await f.request(`/auth/link/start?attempt_id=${attemptId}&start_code=${startCode}`);
	const started = await post(f, "/auth/link/start", await form(page), cookie(page));
	const binder = cookie(started);
	const callbackUrl = authorize(f, await started.text());
	const callback = await f.request(callbackUrl, { headers: { cookie: binder } });
	const confirmed = await post(
		f,
		"/auth/link/confirm",
		await form(callback, "/auth/link/confirm"),
		binder,
	);
	const href = (await confirmed.text()).match(/href="(http:[^"]+)"/)?.[1];
	if (!href) throw new Error("Missing loopback hop");
	const completion = new URL(href.replaceAll("&amp;", "&")).searchParams.get("completion") ?? "";
	expect(await rows(f, "account_profiles")).toEqual([]);
	// Act: device, browser and provider each supply their own proofs through mounted routes.
	const finalized = await signed(f, `${ROOT}/${attemptId}/finalize`, {
		purpose: "coordinator-account-link-v1",
		coordinator_id: pinned.coordinator_id,
		identity_id: pinned.identity_id,
		attempt_id: attemptId,
		group_id: f.review.groupId,
		device_id: f.review.deviceId,
		fingerprint: f.review.fingerprint,
		runtime_verifier: runtimeVerifier,
		completion,
	});
	const completePage = await f.request(`/auth/link/complete?attempt_id=${attemptId}`, {
		headers: { cookie: binder },
	});
	const completed = await post(f, "/auth/link/complete", await form(completePage), binder);
	const session = cookie(completed);
	const signInPage = await f.request("/auth/sign-in");
	const signIn = await post(f, "/auth/sign-in", await form(signInPage), cookie(signInPage), "::1");
	const freshUrl = authorize(f, await signIn.text());
	const freshBinder = cookie(signIn);
	const fresh = await f.request(freshUrl, { headers: { cookie: freshBinder } });
	const replay = await f.request(freshUrl, { headers: { cookie: freshBinder } });
	const account = await f.request("/auth/account", { headers: { cookie: session } });
	const accountHtml = await account.clone().text();
	const logout = await post(f, "/auth/logout", await form(account), session);
	// Assert: linking cannot persist a profile, normal sign-in can, and logout is SID-scoped.
	expect(created.status).toBe(201);
	expect(finalized.status).toBe(200);
	expect(completed.status).toBe(303);
	expect(fresh.status).toBe(303);
	expect(replay.status).toBe(403);
	expect(replay.headers.getSetCookie()).toEqual([]);
	expect(accountHtml).toContain("Fixture User");
	expect(logout.status).toBe(200);
	expect((await rows(f, "sessions")).filter((row) => row.revoked_at_ms === null)).toHaveLength(1);
	expect(await f.store.getEnrollment(f.review.groupId, f.review.deviceId)).toEqual(deviceBefore);
	expect(new Set([startCode, runtimeVerifier, completion]).size).toBe(3);
});

it("preserves missing-binding errors, pins native D1, and caches completed setup without changing legacy routes", async () => {
	// Arrange
	const f = await setup();
	// Act
	const missing = await f.worker.fetch(new Request(`${ORIGIN}/auth/sign-in`), {});
	const missingDiscoveryCalls = f.oidc.fetch.mock.calls.length;
	const cold = await f.request("/auth/sign-in");
	const discoveries = f.oidc.fetch.mock.calls.length;
	const warm = await f.request("/auth/sign-in");
	const otherDb = {
		prepare: vi.fn(() => {
			throw new Error("different-binding-private");
		}),
		batch: vi.fn(),
	};
	const mismatch = await f.worker.fetch(new Request(`${ORIGIN}/auth/sign-in`), {
		COORDINATOR_DB: otherDb,
	});
	const failureFetch = vi.fn(async () => {
		throw new Error("private-sdk-secret");
	});
	const failure = createCloudflareCoordinatorWorker({
		browserAuth: { config: f.config, csrfKey: f.csrfKey, oidcOptions: { fetch: failureFetch } },
	});
	const unavailable = await failure.fetch(new Request(`${ORIGIN}/auth/sign-in`), env);
	const legacy = await failure.fetch(new Request(`${ORIGIN}/v1/admin/groups`), env);
	// Assert
	expect(missing.status).toBe(500);
	expect(await missing.json()).toEqual({ error: "missing_d1_binding" });
	expect(missing.headers.getSetCookie()).toEqual([]);
	expect(missingDiscoveryCalls).toBe(0);
	expect([cold.status, warm.status, mismatch.status, unavailable.status, legacy.status]).toEqual([
		200, 200, 503, 503, 401,
	]);
	expect(discoveries).toBe(3);
	expect(f.oidc.fetch.mock.calls).toHaveLength(discoveries);
	expect(otherDb.prepare).not.toHaveBeenCalled();
	expect(await unavailable.text()).not.toContain("private-sdk-secret");
	expect(unavailable.headers.get("cache-control")).toBe("no-store");
	expect(unavailable.headers.get("referrer-policy")).toBe("no-referrer");
});

it("attaches scheduled retirement to waitUntil; defaults and missing/mismatched bindings do nothing", async () => {
	// Arrange
	const f = await setup();
	const attemptId = crypto.randomUUID();
	await f.store.createAuthLinkAttempt(
		{
			attemptId,
			signer: f.review,
			runtimeVerifierHash: "c".repeat(64),
			browserStartHash: "d".repeat(64),
			loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
		},
		f.config,
	);
	expect(
		await f.store.startAuthBrowserTransaction(
			{
				purpose: "link",
				attemptId,
				browserStartHash: "d".repeat(64),
				stateHash: "e".repeat(64),
				binderHash: "f".repeat(64),
				nonce: "n".repeat(43),
				pkceVerifier: "A".repeat(43),
			},
			f.config,
		),
	).toMatchObject({ kind: "started" });
	await f.store.failAuthLinkAttempt(
		{ attemptId, requester: { kind: "device", signer: f.review }, reason: "cancelled" },
		f.config,
	);
	if (!("scheduled" in f.worker)) throw new Error("Scheduled handler missing");
	const ctx = createExecutionContext();
	const wait = vi.spyOn(ctx, "waitUntil");
	// Act
	f.worker.scheduled(createScheduledController(), env, ctx);
	await waitOnExecutionContext(ctx);
	const emptyCtx = createExecutionContext();
	const emptyWait = vi.spyOn(emptyCtx, "waitUntil");
	f.worker.scheduled(createScheduledController(), {}, emptyCtx);
	f.worker.scheduled(
		createScheduledController(),
		{ COORDINATOR_DB: { prepare: vi.fn(), batch: vi.fn() } },
		emptyCtx,
	);
	const disabled = createCloudflareCoordinatorWorker({
		browserAuth: { config: { enabled: false }, csrfKey: f.csrfKey },
	});
	// Assert
	expect(wait).toHaveBeenCalledOnce();
	expect((await rows(f, "browser_transactions"))[0]).toMatchObject({
		nonce: null,
		pkce_verifier: null,
		state: "expired",
	});
	expect((await rows(f, "link_attempts"))[0].state).toBe("failed");
	expect(emptyWait).not.toHaveBeenCalled();
	expect(createCloudflareCoordinatorWorker()).not.toHaveProperty("scheduled");
	expect(disabled).not.toHaveProperty("scheduled");
	expect(f.oidc.fetch).not.toHaveBeenCalled();
});
