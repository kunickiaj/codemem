import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { type Backend, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { createDeviceRebindDeviceSteps } from "./coordinator-device-rebind-ceremony.js";
import {
	type DeviceRebindAttempt,
	deviceRebindFinalMessage,
} from "./coordinator-device-rebind-proof.js";
import { COORDINATOR_DEVICE_REBIND_SCHEMA_SQL } from "./coordinator-device-rebind-schema.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { commitPendingKey } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { createD1AuthLinkBackend } from "./d1-coordinator-store.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

const ORIGIN = new URL(PROVIDER.redirectUri).origin;
const config = {
	enabled: true,
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.google.com",
	redirectUri: PROVIDER.redirectUri,
	revision: "a".repeat(64),
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
};
const CURRENT = "local:device-work";
const TARGET = "identity-target";
const LOOPBACK = "http://127.0.0.1:4567/codemem/auth/complete";
const REVIEW = "e".repeat(64);
const closers: Array<() => unknown> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	vi.restoreAllMocks();
});

/** A device in two groups whose person's Google account (the fixture subject) is linked to TARGET. */
function seed(f: ReturnType<typeof setupStore>, key: ReturnType<typeof commitPendingKey>) {
	const fingerprint = createHash("sha256").update(key.publicKey).digest("hex");
	for (const group of ["group-a", "group-b"]) {
		f.db.prepare("INSERT INTO groups (group_id, created_at) VALUES (?, 'created')").run(group);
		f.db
			.prepare(
				`INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, identity_id, enabled, created_at)
				 VALUES (?, 'device-work', ?, ?, ?, 1, 'created')`,
			)
			.run(group, key.publicKey, fingerprint, group === "group-a" ? null : CURRENT);
	}
	f.db
		.prepare(
			`INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id,
			 attempt_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
			 VALUES (?, 'link-target', ?, 'fixture-subject', ?, 'link-attempt', ?, 1, 'device_claim', 'claim-target')`,
		)
		.run(config.coordinatorId, config.issuer, TARGET, config.revision);
	return { groupId: "group-a", deviceId: "device-work", publicKey: key.publicKey, fingerprint };
}

async function rebindBrowserFixture(
	kind: Backend,
	options: { beforeSetup?: (f: ReturnType<typeof setupStore>) => void } = {},
) {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	const f = setupStore(kind, { authClock: () => NOW });
	closers.push(async () => {
		await f.store.close();
		if (f.db.open) f.db.close();
	});
	const key = commitPendingKey();
	const signer = seed(f, key);
	options.beforeSetup?.(f);
	const oidc = oidcFixture({ issuer: config.issuer });
	const snapshot = captureCoordinatorBrowserAuthOptions({
		config,
		csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(7)),
		oidcOptions: { fetch: oidc.fetch },
	});
	const result = await createCoordinatorBrowserAuth(
		snapshot,
		f.store,
		createInMemoryRequestRateLimiter({ now: () => NOW }),
	);
	if (!result.ok) throw new Error(`browser auth: ${result.error}`);
	const app = new Hono();
	result.auth.register(app, () => "client-a");
	const backend = kind === "SQLite" ? nativeBackend(f.db) : createD1AuthLinkBackend(sqliteD1(f.db));
	const device = createDeviceRebindDeviceSteps({
		backend,
		config: result.auth.storeConfig,
		publicOrigin: ORIGIN,
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		now: () => NOW,
	});
	return { ...f, app, oidc, key, signer, device };
}
type Fixture = Awaited<ReturnType<typeof rebindBrowserFixture>>;

const cookieOf = (response: Response, index = 0) =>
	response.headers.getSetCookie()[index]?.split(";")[0] ?? "";
const field = (html: string, name: string) =>
	new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
const decodeAmpersands = (text: string) => text.replaceAll("&amp;", "&");

function post(f: Fixture, path: string, cookie: string, fields: Record<string, string>) {
	return f.app.request(`${ORIGIN}${path}`, {
		method: "POST",
		headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields).toString(),
	});
}

/** The device starts; the person opens the start page and signs in with Google. */
async function throughCallback(f: Fixture, beforeCallback?: () => void) {
	const code = randomBytes(32).toString("base64url");
	const started = await f.device.start(
		{
			attemptId: "rebind-a",
			signer: f.signer,
			currentIdentityId: CURRENT,
			loopbackRedirect: LOOPBACK,
			browserStartHash: createHash("sha256").update(Buffer.from(code, "base64url")).digest("hex"),
			reviewDigest: REVIEW,
		},
		"device",
	);
	expect(started).toMatchObject({ kind: "started" });
	const page = await f.app.request(
		`${ORIGIN}/auth/rebind/start?attempt_id=rebind-a&start_code=${code}`,
	);
	expect(page.status).toBe(200);
	const html = await page.text();
	const startCookie = cookieOf(page);
	const claimed = await post(f, "/auth/rebind/start", startCookie, {
		csrf: field(html, "csrf"),
		attempt_id: "rebind-a",
		start_code: field(html, "start_code"),
	});
	expect(claimed.status).toBe(200);
	const transactionCookie = cookieOf(claimed);
	const authorization = decodeAmpersands(
		/content="0;url=([^"]+)"/.exec(await claimed.text())?.[1] ?? "",
	);
	beforeCallback?.();
	const callback = await f.app.request(f.oidc.authorize(authorization).href, {
		headers: { cookie: transactionCookie },
	});
	return { callback, transactionCookie };
}

async function confirm(f: Fixture, transactionCookie: string, confirmPage: string, hash?: string) {
	return post(f, "/auth/rebind/confirm", transactionCookie, {
		csrf: field(confirmPage, "csrf"),
		attempt_id: "rebind-a",
		confirmation_hash: hash ?? field(confirmPage, "confirmation_hash"),
	});
}

describe.each(["SQLite", "D1"] as const)("device rebind browser pages (%s)", (kind) => {
	it("takes the person from the start page to the device's loopback", async () => {
		// Arrange
		const f = await rebindBrowserFixture(kind);
		// Act
		const { callback, transactionCookie } = await throughCallback(f);
		const confirmPage = await callback.text();
		const hop = await confirm(f, transactionCookie, confirmPage);
		const loopback = new URL(
			decodeAmpersands(/href="(http:\/\/127[^"]+)"/.exec(await hop.text())?.[1] ?? ""),
		);
		const status = await f.device.status({ attemptId: "rebind-a", signer: f.signer });
		const signed = {
			coordinator_id: config.coordinatorId,
			origin: ORIGIN,
			auth_config_revision: config.revision,
			attempt_id: "rebind-a",
			device_id: f.signer.deviceId,
			public_key: f.signer.publicKey,
			key_id: await ed25519KeyId(f.signer.publicKey),
			fingerprint: f.signer.fingerprint,
			issuer: config.issuer,
			current_identity_id: CURRENT,
			target_identity_id: status?.kind === "status" ? status.targetIdentityId : null,
			review_digest: REVIEW,
			confirmation_hash: loopback.searchParams.get("confirmation"),
		} as DeviceRebindAttempt;
		const completion = loopback.searchParams.get("completion") ?? "";
		const finalized = await f.device.finalize({
			attemptId: "rebind-a",
			signer: f.signer,
			completionSecret: completion,
			signature: f.key.sign(deviceRebindFinalMessage(signed, completion)),
		});
		// Assert
		expect(callback.status).toBe(200);
		expect(confirmPage).toContain("Sign in on this device");
		expect(confirmPage).toContain(TARGET);
		expect(confirmPage).toContain("group-b");
		expect(hop.status).toBe(200);
		expect(hop.headers.getSetCookie().join()).toContain("Max-Age=0");
		expect(`${loopback.origin}${loopback.pathname}`).toBe(LOOPBACK);
		expect(loopback.searchParams.get("attempt_id")).toBe("rebind-a");
		expect(finalized).toMatchObject({ kind: "finalized", receipt: { targetIdentityId: TARGET } });
	});

	it("refuses a confirmation whose hash differs from the page shown", async () => {
		// Arrange
		const f = await rebindBrowserFixture(kind);
		const { callback, transactionCookie } = await throughCallback(f);
		// Act
		const response = await confirm(f, transactionCookie, await callback.text(), "0".repeat(64));
		// Assert
		expect(response.status).toBe(403);
		const state = f.db
			.prepare("SELECT state FROM coordinator_device_rebind_attempts WHERE attempt_id = 'rebind-a'")
			.pluck()
			.get();
		expect(state).toBe("oidc_verified");
	});

	it("leaves the callback to owner dispatch when the rebind lookup fails", async () => {
		// Arrange: rebind storage was ready when the browser claimed the attempt.
		const f = await rebindBrowserFixture(kind);
		// Act
		const { callback } = await throughCallback(f, () =>
			f.db.exec("ALTER TABLE coordinator_device_rebind_attempts RENAME TO rebind_attempts_moved"),
		);
		// Assert: no rebind page and nothing burned; without owner enrollment it is unavailable.
		expect(callback.status).toBe(403);
		expect(await callback.text()).not.toContain("Sign-in result unknown");
		const state = f.db
			.prepare(
				"SELECT state FROM coordinator_auth_browser_transactions WHERE attempt_id = 'rebind-a'",
			)
			.pluck()
			.get();
		expect(state).toBe("pending");
	});

	it("rejects a confirmation body that is not UTF-8", async () => {
		// Arrange
		const f = await rebindBrowserFixture(kind);
		// Act
		const response = await f.app.request(`${ORIGIN}/auth/rebind/confirm`, {
			method: "POST",
			headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
			body: new Uint8Array([0xff, 0xfe]),
		});
		// Assert
		expect(response.status).toBe(400);
	});

	it("rejects a start page without exactly an attempt and a start code", async () => {
		// Arrange
		const f = await rebindBrowserFixture(kind);
		// Act
		const response = await f.app.request(`${ORIGIN}/auth/rebind/start?attempt_id=rebind-a`);
		// Assert
		expect(response.status).toBe(400);
		expect(response.headers.getSetCookie()).toEqual([]);
	});

	it("leaves rebind off, and sign-in on, until the rebind tables exist", async () => {
		// Arrange
		const f = await rebindBrowserFixture(kind, {
			beforeSetup: (store) => store.db.exec("DROP TABLE coordinator_device_rebind_audit_log"),
		});
		// Act
		const rebind = await f.app.request(`${ORIGIN}/auth/rebind/start?attempt_id=a&start_code=b`);
		const signIn = await f.app.request(`${ORIGIN}/auth/sign-in`);
		// Assert
		expect(rebind.status).toBe(404);
		expect(signIn.status).toBe(200);
	});

	it("turns rebind on once its tables appear, without a restart", async () => {
		// Arrange
		const f = await rebindBrowserFixture(kind, {
			beforeSetup: (store) => store.db.exec("DROP TABLE coordinator_device_rebind_audit_log"),
		});
		const before = await f.app.request(`${ORIGIN}/auth/rebind/start?attempt_id=a`);
		// Act
		f.db.exec(COORDINATOR_DEVICE_REBIND_SCHEMA_SQL);
		const after = await f.app.request(`${ORIGIN}/auth/rebind/start?attempt_id=a`);
		// Assert: the malformed start now reaches the rebind page handler.
		expect(before.status).toBe(404);
		expect(after.status).toBe(400);
	});
});

describe.each(["SQLite", "D1"] as const)("device rebind callback cleanup (%s)", (kind) => {
	it("tells the person their Google account isn't linked, then returns to the device", async () => {
		// Arrange
		const f = await rebindBrowserFixture(kind);
		f.db.prepare("DELETE FROM coordinator_auth_account_links").run();
		// Act
		const { callback } = await throughCallback(f);
		const page = await callback.text();
		// Assert: the device learns the refusal from the loopback and stops waiting.
		expect(page).toContain("This Google account isn’t set up");
		expect(decodeAmpersands(page)).toContain(
			`${LOOPBACK}?attempt_id=rebind-a&refused=account_not_linked`,
		);
		expect(callback.headers.getSetCookie().join()).toMatch(/Max-Age=0/);
	});

	it("keeps the cookie when another request already used the transaction", async () => {
		// Arrange: a second tab of the same browser burned the transaction first.
		const f = await rebindBrowserFixture(kind);
		// Act
		const { callback } = await throughCallback(f, () =>
			f.db.exec(`UPDATE coordinator_auth_browser_transactions SET state = 'consumed',
			 consumed_at_ms = created_at_ms, claim_token = 'other', nonce = NULL, pkce_verifier = NULL
			 WHERE attempt_id = 'rebind-a'`),
		);
		// Assert: the winning tab still owns the cookie.
		expect(callback.status).toBeGreaterThanOrEqual(400);
		expect(callback.headers.getSetCookie()).toEqual([]);
	});
});
