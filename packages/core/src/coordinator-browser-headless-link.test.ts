import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TABLE } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	HEADLESS_CODE_ENTRY_CLIENT_LIMIT,
	HEADLESS_CODE_ENTRY_WINDOW_MS,
} from "./coordinator-auth-headless-code-limits.js";
import { HEADLESS_CODE_LIMITS_TABLE } from "./coordinator-auth-headless-schema.js";
import { hashHeadlessUserCode } from "./coordinator-auth-link-headless.js";
import {
	DESKTOP_ID,
	HEADLESS_ID,
	headlessCreate,
	USER_CODE,
} from "./coordinator-auth-link-headless-test-fixtures.js";
import { attempt, authorize, NOW, TTL } from "./coordinator-auth-link-test-fixtures.js";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { createCoordinatorBrowserHeadlessLink } from "./coordinator-browser-headless-link.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

const ORIGIN = "https://app.example.test";
const PAGE = `${ORIGIN}/auth/link/device`;
const ADDRESS = "203.0.113.7";
const DESKTOP_CODE = "CDFGHJKL";
const REJECTED = "Code not recognized or expired.";
const databases: ReturnType<typeof setupStore>["db"][] = [];
let now = NOW;

beforeEach(() => {
	now = NOW;
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		for (const db of databases.splice(0)) db.close();
	}
});

async function setup(backend: Backend = "SQLite") {
	const f = setupStore(backend, { authClock: () => now });
	databases.push(f.db);
	const config = {
		enabled: true,
		coordinatorId: "coordinator-a",
		issuer: "https://accounts.google.com",
		redirectUri: PROVIDER.redirectUri,
		revision: "a".repeat(64),
		clientId: PROVIDER.clientId,
		clientSecret: PROVIDER.clientSecret,
	};
	await authorize({ ...f, now: NOW, cfg: config });
	expect(await f.store.createHeadlessAuthLinkAttempt(await headlessCreate(), config)).toMatchObject(
		{ kind: "created" },
	);
	const desktop = attempt({
		attemptId: DESKTOP_ID,
		browserStartHash: await hashHeadlessUserCode(DESKTOP_CODE),
	});
	expect(await f.store.createAuthLinkAttempt(desktop, config)).toMatchObject({ kind: "created" });
	const limits = await f.store.readHeadlessLinkBackend();
	if (!limits) throw new Error("fixture_headless_capability_missing");
	const oidc = oidcFixture({ issuer: config.issuer });
	const start = vi.fn(f.store.startHeadlessAuthLinkBrowserTransaction.bind(f.store));
	const created = await createCoordinatorBrowserHeadlessLink({
		config,
		csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(17)),
		store: {
			startHeadlessAuthLinkBrowserTransaction: start,
			readAuthBrowserTransactionActivity: f.store.readAuthBrowserTransactionActivity.bind(f.store),
		},
		limits,
		limiter: createInMemoryRequestRateLimiter({ now: () => now }),
		oidcOptions: { fetch: oidc.fetch },
	});
	if (!created.ok) throw new Error("fixture_headless_link_failed");
	oidc.fetch.mockClear();
	return { ...f, config, start, handlers: created.handlers };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

async function openForm(f: Fixture, cookie?: string) {
	const response = await f.handlers.codePage(
		new Request(PAGE, { headers: cookie ? { cookie } : {} }),
	);
	const body = await response.text();
	return {
		response,
		body,
		csrf: /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? "",
		cookie: cookie ?? response.headers.getSetCookie()[0]?.split(";")[0] ?? "",
	};
}
type Form = Awaited<ReturnType<typeof openForm>>;

function submit(f: Fixture, form: Form, fields: Record<string, string>, address = ADDRESS) {
	const request = new Request(PAGE, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			"content-type": "application/x-www-form-urlencoded",
			cookie: form.cookie,
		},
		body: new URLSearchParams({ csrf: form.csrf, ...fields }).toString(),
	});
	return f.handlers.codeStart(request, "client-a", address);
}

async function enter(f: Fixture, code: string, address = ADDRESS) {
	return submit(f, await openForm(f), { user_code: code }, address);
}

function attemptState(f: Fixture, attemptId = HEADLESS_ID) {
	return (
		f.db
			.prepare("SELECT state FROM coordinator_auth_link_attempts WHERE attempt_id = ?")
			.get(attemptId) as { state: string }
	).state;
}

/** Bodies differ only by their per-render CSRF nonce. */
async function rejectedShape(response: Response) {
	return {
		status: response.status,
		cookies: response.headers.getSetCookie(),
		body: (await response.text()).replace(/name="csrf" value="[^"]+"/, 'name="csrf" value=""'),
	};
}

describe("headless code entry page", () => {
	it("renders the code form with a start cookie and the standard page headers", async () => {
		// Arrange
		const f = await setup();
		// Act
		const form = await openForm(f);
		// Assert
		expect(form.response.status).toBe(200);
		expect(form.body).toContain("Enter the code shown on your device");
		expect(form.body).toMatch(
			/<input id="user_code" name="user_code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16"/,
		);
		expect(form.body).toContain('action="/auth/link/device"');
		expect(form.cookie).toMatch(/^__Host-/);
		expect(form.response.headers.get("cache-control")).toBe("no-store");
		expect(form.response.headers.get("x-frame-options")).toBe("DENY");
		expect(form.response.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'none'",
		);
		expect(f.start).not.toHaveBeenCalled();
	});

	it.each([
		["a prefilled code", `${PAGE}?code=${USER_CODE}`],
		["an empty query", `${PAGE}?`],
	])("refuses %s with 400", async (_name, url) => {
		// Arrange
		const f = await setup();
		// Act
		const response = await f.handlers.codePage(new Request(url));
		// Assert
		expect(response.status).toBe(400);
		expect(response.headers.getSetCookie()).toEqual([]);
		expect(await response.text()).not.toContain(USER_CODE);
	});
});

describe("headless code submission", () => {
	it("starts the headless attempt and continues to Google", async () => {
		// Arrange
		const f = await setup();
		// Act
		const response = await enter(f, "bcdf-ghjk");
		// Assert
		const body = await response.text();
		expect(response.status).toBe(200);
		expect(body).toContain('href="https://accounts.google.com/');
		expect(response.headers.getSetCookie()).toHaveLength(2);
		expect(f.start).toHaveBeenCalledWith(
			expect.objectContaining({ userCodeHash: await hashHeadlessUserCode(USER_CODE) }),
			expect.anything(),
		);
		expect(attemptState(f)).toBe("browser_claimed");
		expect(f.db.prepare(`SELECT attempt_id FROM ${TABLE}`).all()).toEqual([
			{ attempt_id: HEADLESS_ID },
		]);
	});

	it("rejects a client-supplied code hash field without counting or looking it up", async () => {
		// Arrange
		const f = await setup();
		const form = await openForm(f);
		// Act
		const response = await submit(f, form, {
			user_code: "XXXXXXXX",
			user_code_hash: await hashHeadlessUserCode(USER_CODE),
		});
		// Assert
		expect(response.status).toBe(400);
		expect(f.start).not.toHaveBeenCalled();
		expect(attemptState(f)).toBe("pending");
	});

	it("renders one identical rejection for unknown, malformed, used and desktop codes", async () => {
		// Arrange
		const f = await setup();
		const shapes = [];
		// Act
		shapes.push(await rejectedShape(await enter(f, "ZZZZZZZZ")));
		shapes.push(await rejectedShape(await enter(f, "12-oops")));
		shapes.push(await rejectedShape(await enter(f, DESKTOP_CODE)));
		expect((await enter(f, USER_CODE)).status).toBe(200);
		shapes.push(await rejectedShape(await enter(f, USER_CODE)));
		// Assert
		expect(shapes[0].status).toBe(400);
		expect(shapes[0].body).toContain(REJECTED);
		for (const shape of shapes) expect(shape).toEqual(shapes[0]);
		expect(attemptState(f, DESKTOP_ID)).toBe("pending");
	});

	it("renders the same rejection for an expired headless attempt", async () => {
		// Arrange
		const f = await setup();
		const unknown = await rejectedShape(await enter(f, "ZZZZZZZZ"));
		now = NOW + TTL;
		// Act
		const expired = await rejectedShape(await enter(f, USER_CODE));
		// Assert
		expect(expired).toEqual(unknown);
		expect(attemptState(f)).not.toBe("browser_claimed");
	});

	it("never echoes the entered code", async () => {
		// Arrange
		const f = await setup();
		// Act
		const body = await (await enter(f, "QWRTPSZX")).text();
		// Assert
		expect(body).not.toContain("QWRTPSZX");
	});

	it("starts exactly one of two simultaneous claims of the same code", async () => {
		// Arrange
		const f = await setup();
		const [a, b] = [await openForm(f), await openForm(f)];
		// Act
		const responses = await Promise.all([
			submit(f, a, { user_code: USER_CODE }),
			submit(f, b, { user_code: USER_CODE }, "198.51.100.9"),
		]);
		// Assert
		expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
		expect(f.db.prepare(`SELECT count(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 1 });
	});
});

describe("headless code entry limits", () => {
	it("returns 429 with Retry-After rounded up once the client limit is spent", async () => {
		// Arrange
		const f = await setup();
		for (let n = 0; n < HEADLESS_CODE_ENTRY_CLIENT_LIMIT; n += 1) await enter(f, "ZZZZZZZZ");
		now = NOW + 1500;
		f.start.mockClear();
		// Act
		const response = await enter(f, USER_CODE);
		// Assert
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe(
			String(Math.ceil((HEADLESS_CODE_ENTRY_WINDOW_MS - 1500) / 1000)),
		);
		expect(f.start).toHaveBeenCalledTimes(0);
		expect(attemptState(f)).toBe("pending");
	});

	it("keys stored counts with an HMAC of the address, never the raw address", async () => {
		// Arrange
		const f = await setup();
		// Act
		await enter(f, "ZZZZZZZZ");
		await enter(f, "ZZZZZZZZ");
		await enter(f, "ZZZZZZZZ", "198.51.100.9");
		// Assert
		const rows = f.db
			.prepare(
				`SELECT key_hash, failures FROM ${HEADLESS_CODE_LIMITS_TABLE} WHERE scope = 'client'`,
			)
			.all() as { key_hash: string; failures: number }[];
		expect(rows.map((row) => row.failures).sort()).toEqual([1, 2]);
		expect(JSON.stringify(rows)).not.toContain(ADDRESS);
		for (const row of rows) expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("refuses entry when no verified client address is available", async () => {
		// Arrange
		const f = await setup();
		const form = await openForm(f);
		// Act
		const response = await submit(f, form, { user_code: USER_CODE }, "");
		// Assert
		expect(response.status).toBe(503);
		expect(f.start).not.toHaveBeenCalled();
		expect(f.db.prepare(`SELECT count(*) AS n FROM ${HEADLESS_CODE_LIMITS_TABLE}`).get()).toEqual({
			n: 0,
		});
	});
});

describe("D1 headless code entry", () => {
	it("starts the attempt and rejects a reused code with the same response", async () => {
		// Arrange
		const f = await setup("D1");
		const unknown = await rejectedShape(await enter(f, "ZZZZZZZZ"));
		// Act
		const started = await enter(f, USER_CODE);
		const reused = await rejectedShape(await enter(f, USER_CODE));
		// Assert
		expect(started.status).toBe(200);
		expect(reused).toEqual(unknown);
	});
});
