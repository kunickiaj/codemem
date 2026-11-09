import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { HEADLESS_CODE_LIMITS_TABLE } from "./coordinator-auth-headless-schema.js";
import { formatShortKeyFingerprint } from "./coordinator-auth-key-fingerprint.js";
import {
	HEADLESS_ID,
	HEADLESS_VERIFIER,
	headlessCreate,
	headlessFinalize,
	SUBJECT,
	USER_CODE,
} from "./coordinator-auth-link-headless-test-fixtures.js";
import { attempt, authorize, NOW, signer } from "./coordinator-auth-link-test-fixtures.js";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	admitCoordinatorBrowserAuthSetup,
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

const ORIGIN = "https://app.example.test";
const WARNING =
	'Only continue if you ran <code class="command">codemem coordinator account link --headless</code> on this device yourself in the last 10 minutes and the key fingerprint matches its terminal.';
const RETURN = "Return to your device's terminal to finish.";
const databases: ReturnType<typeof setupStore>["db"][] = [];

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		for (const db of databases.splice(0)) db.close();
	}
});

async function setup(backend: Backend = "SQLite", options: { clientAddress?: boolean } = {}) {
	const f = setupStore(backend, { authClock: () => NOW });
	databases.push(f.db);
	const config = {
		enabled: true,
		coordinatorId: "coordinator-a",
		issuer: "https://accounts.google.com",
		revision: "a".repeat(64),
		redirectUri: PROVIDER.redirectUri,
		clientId: PROVIDER.clientId,
		clientSecret: PROVIDER.clientSecret,
	};
	await authorize({ ...f, now: NOW, cfg: config });
	f.db.prepare("UPDATE enrolled_devices SET display_name = 'Build box'").run();
	const oidc = oidcFixture({ issuer: config.issuer });
	oidc.claims.sub = SUBJECT;
	const snapshot = captureCoordinatorBrowserAuthOptions({
		config,
		csrfKey: await importBrowserCsrfKey(randomBytes(32)),
		oidcOptions: { fetch: oidc.fetch },
	});
	const limiter = createInMemoryRequestRateLimiter({ now: () => NOW });
	const result = await createCoordinatorBrowserAuth(snapshot, f.store, limiter);
	if (!result.ok) throw new Error("fixture_composition_failed");
	const app = createCoordinatorApp({
		storeFactory: () => f.store,
		runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
		requestVerifier: () => false,
		browserAuth: {
			kind: "ready",
			auth: result.auth,
			storeFactory: () => f.store,
			clientKey: () => "client-a",
			...(options.clientAddress === false ? {} : { clientAddress: () => "203.0.113.7" }),
		},
	});
	return { ...f, cfg: config, oidc, app, snapshot, limiter };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

function fields(html: string, action?: string) {
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
function post(f: Fixture, path: string, body: Record<string, string>, binder: string) {
	return f.app.request(`${ORIGIN}${path}`, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			cookie: binder,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(body),
	});
}
function providerLink(html: string) {
	const href = html.match(/href="(https:\/\/accounts\.google\.com\/authorize[^"]+)"/)?.[1];
	if (!href) throw new Error("provider_link_missing");
	return new URL(href.replaceAll("&amp;", "&"));
}
async function callback(f: Fixture, started: Response) {
	const binder = cookie(started);
	const url = f.oidc.authorize(providerLink(await started.text()));
	const response = await f.app.fetch(new Request(url, { headers: { cookie: binder } }));
	return { binder, response, html: await response.text() };
}

/** Code entry → Google → the consent page for the headless attempt. */
async function headlessConsent(f: Fixture) {
	expect(await f.store.createHeadlessAuthLinkAttempt(await headlessCreate(), f.cfg)).toMatchObject({
		kind: "created",
	});
	const page = await f.app.request(`${ORIGIN}/auth/link/device`);
	const started = await post(
		f,
		"/auth/link/device",
		{ ...fields(await page.text()), user_code: USER_CODE },
		cookie(page),
	);
	expect(started.status).toBe(200);
	return callback(f, started);
}

/** Desktop start code → Google → the desktop consent page. */
async function desktopConsent(f: Fixture) {
	const startRaw = randomBytes(32);
	const browserStartHash = createHash("sha256").update(startRaw).digest("hex");
	expect(await f.store.createAuthLinkAttempt(attempt({ browserStartHash }), f.cfg)).toMatchObject({
		kind: "created",
	});
	const page = await f.app.request(
		`${ORIGIN}/auth/link/start?attempt_id=attempt-a&start_code=${startRaw.toString("base64url")}`,
	);
	const started = await post(f, "/auth/link/start", fields(await page.text()), cookie(page));
	return callback(f, started);
}

function state(f: Fixture, attemptId = HEADLESS_ID) {
	return f.db
		.prepare(
			"SELECT state, completion_secret_hash FROM coordinator_auth_link_attempts WHERE attempt_id = ?",
		)
		.get(attemptId) as { state: string; completion_secret_hash: string | null };
}

describe("headless consent", () => {
	it("names the Identity, device, group and short key fingerprint with the warning", async () => {
		// Arrange
		const f = await setup();
		// Act
		const consent = await headlessConsent(f);
		// Assert
		expect(consent.response.status).toBe(200);
		expect(consent.html).toContain("identity-a");
		expect(consent.html).toContain("Build box");
		expect(consent.html).toContain(signer.deviceId);
		expect(consent.html).toContain(signer.groupId);
		expect(consent.html).toContain(formatShortKeyFingerprint(signer.fingerprint));
		expect(consent.html).toContain(WARNING);
		expect(fields(consent.html, "/auth/link/device/confirm")).toMatchObject({
			attempt_id: HEADLESS_ID,
		});
		expect(fields(consent.html, "/auth/link/cancel")).toMatchObject({ attempt_id: HEADLESS_ID });
		expect(consent.html).not.toContain('action="/auth/link/confirm"');
		expect(consent.response.headers.get("x-frame-options")).toBe("DENY");
	});

	it("shows the device ID when the device has no name", async () => {
		// Arrange
		const f = await setup();
		f.db.prepare("UPDATE enrolled_devices SET display_name = NULL").run();
		// Act
		const consent = await headlessConsent(f);
		// Assert
		expect(consent.html).toContain(
			`<dt>Device</dt><dd><bdi>Device</bdi><br><code>${signer.deviceId}`,
		);
	});
});

describe("headless approval", () => {
	it("confirms the attempt and sends the person back to the device terminal", async () => {
		// Arrange
		const f = await setup();
		const consent = await headlessConsent(f);
		// Act
		const approved = await post(
			f,
			"/auth/link/device/confirm",
			fields(consent.html, "/auth/link/device/confirm"),
			consent.binder,
		);
		// Assert
		const html = await approved.text();
		expect(approved.status).toBe(200);
		expect(html).toContain(RETURN);
		expect(html).not.toMatch(/<form|<a\b|http-equiv/);
		expect(approved.headers.getSetCookie()).toEqual([]);
		expect(state(f)).toEqual({ state: "confirmed", completion_secret_hash: HEADLESS_VERIFIER });
	});

	it("refuses the desktop confirm route for a headless attempt with a clear page", async () => {
		// Arrange
		const f = await setup();
		const consent = await headlessConsent(f);
		// Act
		const refused = await post(
			f,
			"/auth/link/confirm",
			fields(consent.html, "/auth/link/device/confirm"),
			consent.binder,
		);
		// Assert
		expect(refused.status).toBe(409);
		expect(await refused.text()).toContain("Approve on the device page");
		expect(state(f).state).toBe("oidc_verified");
	});

	it("refuses the device confirm route for a desktop attempt", async () => {
		// Arrange
		const f = await setup();
		const consent = await desktopConsent(f);
		// Act
		const refused = await post(
			f,
			"/auth/link/device/confirm",
			fields(consent.html, "/auth/link/confirm"),
			consent.binder,
		);
		// Assert
		expect(consent.html).not.toContain("Key fingerprint");
		expect(refused.status).toBe(403);
		expect(state(f, "attempt-a").state).toBe("oidc_verified");
	});

	it("cancels a headless attempt through the shared cancel route", async () => {
		// Arrange
		const f = await setup();
		const consent = await headlessConsent(f);
		// Act
		const cancelled = await post(
			f,
			"/auth/link/cancel",
			fields(consent.html, "/auth/link/cancel"),
			consent.binder,
		);
		// Assert
		expect(cancelled.status).toBe(200);
		expect(await cancelled.text()).toContain("Linking cancelled");
		expect(state(f).state).toBe("failed");
	});
});

describe("headless completion", () => {
	it("offers no session after the device finalizes", async () => {
		// Arrange
		const f = await setup();
		const consent = await headlessConsent(f);
		const form = fields(consent.html, "/auth/link/device/confirm");
		await post(f, "/auth/link/device/confirm", form, consent.binder);
		expect(await f.store.finalizeHeadlessAuthLinkAttempt(headlessFinalize(f), f.cfg)).toMatchObject(
			{ kind: "applied" },
		);
		// Act
		const page = await f.app.request(`${ORIGIN}/auth/link/complete?attempt_id=${HEADLESS_ID}`, {
			headers: { cookie: consent.binder },
		});
		const complete = await post(f, "/auth/link/complete", form, consent.binder);
		// Assert
		const html = await page.text();
		expect(state(f).state).toBe("finalized");
		expect(html).toContain(RETURN);
		expect(html).not.toContain("<form");
		expect(complete.status).toBe(403);
		expect(complete.headers.getSetCookie()).toEqual([]);
		expect(f.db.prepare("SELECT count(*) AS n FROM coordinator_auth_sessions").get()).toEqual({
			n: 0,
		});
	});
});

describe("D1 headless consent", () => {
	it("confirms through the device route and refuses the desktop route", async () => {
		// Arrange
		const f = await setup("D1");
		const consent = await headlessConsent(f);
		const form = fields(consent.html, "/auth/link/device/confirm");
		// Act
		const desktop = await post(f, "/auth/link/confirm", form, consent.binder);
		const approved = await post(f, "/auth/link/device/confirm", form, consent.binder);
		// Assert
		expect(desktop.status).toBe(409);
		expect(approved.status).toBe(200);
		expect(state(f).state).toBe("confirmed");
	});
});

describe("device confirm route mounting", () => {
	const confirm = `${ORIGIN}/auth/link/device/confirm`;
	const body = { csrf: "x", attempt_id: HEADLESS_ID };

	it("is not mounted without a verified client address", async () => {
		// Arrange
		const f = await setup("SQLite", { clientAddress: false });
		// Act
		const response = await post(f, "/auth/link/device/confirm", body, "");
		// Assert
		expect(response.status).toBe(404);
	});

	it("reports not found until both headless tables exist", async () => {
		// Arrange
		const f = await setup();
		f.db.exec(`DROP TABLE ${HEADLESS_CODE_LIMITS_TABLE}`);
		// Act
		const response = await post(f, "/auth/link/device/confirm", body, "");
		// Assert
		expect(response.status).toBe(404);
	});

	it("is admitted for POST setup only", async () => {
		// Arrange
		const f = await setup();
		// Act
		const get = admitCoordinatorBrowserAuthSetup(f.snapshot, new Request(confirm), f.limiter, "c");
		// Assert
		expect(get).toBeInstanceOf(Response);
		expect((get as Response).status).toBe(405);
		expect((get as Response).headers.get("allow")).toBe("POST");
	});
});

describe("headless completion before approval", () => {
	it("refuses the completion page before and after Google without offering an action", async () => {
		// Arrange
		const f = await setup();
		expect(
			await f.store.createHeadlessAuthLinkAttempt(await headlessCreate(), f.cfg),
		).toMatchObject({ kind: "created" });
		const entry = await f.app.request(`${ORIGIN}/auth/link/device`);
		const started = await post(
			f,
			"/auth/link/device",
			{ ...fields(await entry.text()), user_code: USER_CODE },
			cookie(entry),
		);
		const binder = cookie(started);
		const complete = () =>
			f.app.request(`${ORIGIN}/auth/link/complete?attempt_id=${HEADLESS_ID}`, {
				headers: { cookie: binder },
			});
		// Act
		const claimed = await complete();
		const claimedHtml = await claimed.text();
		const consent = await callback(f, started);
		const verified = await complete();
		const verifiedHtml = await verified.text();
		// Assert
		expect(state(f).state).toBe("oidc_verified");
		expect(consent.response.status).toBe(200);
		for (const [response, html] of [
			[claimed, claimedHtml],
			[verified, verifiedHtml],
		] as const) {
			expect(response.status).toBe(403);
			expect(html).not.toContain(RETURN);
			expect(html).not.toContain("<form");
			expect(response.headers.getSetCookie()).toEqual([]);
		}
	});
});
