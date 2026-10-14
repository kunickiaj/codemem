import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createApp, createSyncApp } from "../index.js";
import { createAccountGuard } from "./guard.js";

const HOST = "127.0.0.1:7337";
const ORIGIN = `http://${HOST}`;
const SESSION = "/api/account/session";
type Listener = { host: string; port: number } | null;

function fixture(listener: Listener = { host: "127.0.0.1", port: 7337 }) {
	const storeFactory = vi.fn(() => {
		throw new Error("Account requests must not initialize the store");
	});
	const getListenerAddress = vi.fn(() => listener);
	const app = createApp({ storeFactory, accountLink: { getListenerAddress } });
	return { app, storeFactory, getListenerAddress };
}

function request(
	app: Hono,
	path = SESSION,
	options: {
		host?: string | null;
		urlOrigin?: string;
		method?: string;
		headers?: HeadersInit;
	} = {},
) {
	const headers = new Headers(options.headers);
	if (options.host !== null) headers.set("Host", options.host ?? HOST);
	return app.request(`${options.urlOrigin ?? ORIGIN}${path}`, {
		method: options.method ?? "GET",
		headers,
	});
}

function expectPrivate(response: Response) {
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect([...response.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual(
		[],
	);
	expect(response.headers.get("Set-Cookie")).toBeNull();
}

async function tokenFor(app: Hono): Promise<string> {
	const response = await request(app);
	expect(response.status).toBe(200);
	return (await response.json()).csrfToken;
}

describe("account session and listener boundary", () => {
	it("returns only a version and one stable 32-byte base64url token without opening the store", async () => {
		// Arrange
		const { app, storeFactory } = fixture();
		// Act
		const first = await request(app);
		const payload = await first.json();
		const second = await request(app);
		// Assert
		expect(first.status).toBe(200);
		expect(payload).toEqual({
			version: 1,
			csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
		});
		expect(Buffer.from(payload.csrfToken, "base64url")).toHaveLength(32);
		expect(await second.json()).toEqual(payload);
		expectPrivate(first);
		expectPrivate(second);
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it.each([
		["127.0.0.1", 200],
		["127.0.0.1:80", 200],
		["127.0.0.1:8080", 403],
	] as const)("checks default-port Host %s against the bound port 80", async (host, status) => {
		// Arrange
		const { app, storeFactory } = fixture({ host: "127.0.0.1", port: 80 });
		// Act
		const response = await request(app, SESSION, {
			host,
			urlOrigin: "http://127.0.0.1",
			headers: { Origin: "http://127.0.0.1" },
		});
		// Assert
		expect(response.status).toBe(status);
		expectPrivate(response);
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it.each([
		["http://[::1]:7441", 200],
		["http://localhost:7441", 403],
	] as const)(
		"requires exact bracketed IPv6 Origin rather than an alias: %s",
		async (origin, status) => {
			// Arrange
			const { app, storeFactory } = fixture({ host: "::1", port: 7441 });
			// Act
			const response = await request(app, SESSION, {
				host: "[::1]:7441",
				urlOrigin: "http://[::1]:7441",
				headers: { Origin: origin },
			});
			// Assert
			expect(response.status).toBe(status);
			expectPrivate(response);
			expect(storeFactory).not.toHaveBeenCalled();
		},
	);

	it.each([
		["127.0.0.1", "127.0.0.1"],
		["127.0.0.1", "localhost"],
		["::1", "[::1]"],
		["::1", "localhost"],
		["localhost", "127.0.0.1"],
		["localhost", "[::1]"],
		["localhost", "localhost"],
	])("accepts listener %s through Host %s on its actual port", async (bindHost, hostname) => {
		// Arrange
		const { app, storeFactory } = fixture({ host: bindHost, port: 7441 });
		const host = `${hostname}:7441`;
		// Act
		const response = await request(app, SESSION, { host, urlOrigin: `http://${host}` });
		// Assert
		expect(response.status).toBe(200);
		expectPrivate(response);
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it.each<Listener>([
		null,
		{ host: "127.0.0.1", port: 0 },
		{ host: "127.0.0.1", port: -1 },
		{ host: "127.0.0.1", port: 65536 },
		{ host: "127.0.0.1", port: 7337.5 },
		{ host: "127.0.0.1", port: Number.NaN },
		{ host: "0.0.0.0", port: 7337 },
		{ host: "::", port: 7337 },
		{ host: "192.0.2.1", port: 7337 },
		{ host: "127.1", port: 7337 },
		{ host: "LOCALHOST", port: 7337 },
	])("rejects unverified or unsafe listener %j before store access", async (listener) => {
		// Arrange
		const { app, storeFactory } = fixture(listener);
		// Act
		const response = await request(app);
		// Assert
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "account_local_viewer_required" });
		expectPrivate(response);
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it.each([
		null,
		"example.test:7337",
		"localhost:7338",
		"localhost",
		"localhost:0",
		"localhost:7337:1",
		"user@localhost:7337",
		"localhost:07337",
		"[::1]:7337",
	])("rejects missing, malformed, wrong-port, or disallowed Host %s", async (host) => {
		// Arrange
		const { app, storeFactory } = fixture();
		// Act
		const response = await request(app, SESSION, { host });
		// Assert
		expect(response.status).toBe(403);
		expectPrivate(response);
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it("rechecks the actual listener on every request", async () => {
		// Arrange
		const { app, getListenerAddress, storeFactory } = fixture();
		await tokenFor(app);
		getListenerAddress.mockReturnValue(null);
		// Act
		const response = await request(app);
		// Assert
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "account_local_viewer_required" });
		expect(storeFactory).not.toHaveBeenCalled();
	});
});

describe("account browser-origin isolation", () => {
	it.each([undefined, "same-origin"])(
		"allows exact Origin with Fetch Metadata %s",
		async (site) => {
			// Arrange
			const { app } = fixture();
			const headers: Record<string, string> = { Origin: ORIGIN };
			if (site) headers["Sec-Fetch-Site"] = site;
			// Act
			const response = await request(app, SESSION, { headers });
			// Assert
			expect(response.status).toBe(200);
			expectPrivate(response);
		},
	);

	it.each([
		"http://127.0.0.1:7338",
		"http://localhost:7337",
		"https://127.0.0.1:7337",
		"http://example.test:7337",
		"null",
		`${ORIGIN}/`,
		`${ORIGIN}/path`,
		`${ORIGIN}?query`,
		"http://user@127.0.0.1:7337",
		"not-an-origin",
	])("denies Origin %s before CSRF and never echoes global loopback CORS", async (origin) => {
		// Arrange
		const { app, storeFactory } = fixture();
		// Act
		const response = await request(app, "/api/account/unknown", { headers: { Origin: origin } });
		// Assert
		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain("csrf_invalid");
		expectPrivate(response);
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it.each(["none", "same-site", "cross-site", "invalid"])(
		"denies Fetch Metadata %s",
		async (site) => {
			// Arrange
			const { app } = fixture();
			// Act
			const response = await request(app, SESSION, { headers: { "Sec-Fetch-Site": site } });
			// Assert
			expect(response.status).toBe(403);
			expectPrivate(response);
		},
	);

	it.each(["http://localhost:7337", "http://127.0.0.1:7338", "https://127.0.0.1:7337"])(
		"rejects request URL origin %s when it disagrees with Host",
		async (urlOrigin) => {
			// Arrange
			const { app } = fixture();
			// Act
			const response = await request(app, SESSION, { urlOrigin });
			// Assert
			expect(response.status).toBe(403);
			expectPrivate(response);
		},
	);

	it("denies preflight before the existing global preflight handler", async () => {
		// Arrange
		const { app, storeFactory } = fixture();
		// Act
		const response = await request(app, SESSION, {
			method: "OPTIONS",
			headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET" },
		});
		// Assert
		expect(response.status).toBe(403);
		expectPrivate(response);
		expect(storeFactory).not.toHaveBeenCalled();
	});
});

describe("account CSRF and route isolation", () => {
	it.each(["/api/account", "/api/account/unknown", "/api/account/session/extra"])(
		"requires CSRF for %s and preserves a private 404 with the correct token",
		async (path) => {
			// Arrange
			const { app, storeFactory } = fixture();
			const token = await tokenFor(app);
			// Act
			const denied = await request(app, path);
			const allowed = await request(app, path, { headers: { "X-Codemem-Account-Csrf": token } });
			// Assert
			expect(denied.status).toBe(403);
			expect(await denied.json()).toEqual({ error: "account_csrf_invalid" });
			expect(allowed.status).toBe(404);
			expect(await allowed.text()).not.toContain(token);
			expectPrivate(denied);
			expectPrivate(allowed);
			expect(storeFactory).not.toHaveBeenCalled();
		},
	);

	it("rejects malformed, wrong-length, same-length wrong, foreign-app and query-only tokens", async () => {
		// Arrange
		const { app, storeFactory } = fixture();
		const token = await tokenFor(app);
		const otherToken = await tokenFor(fixture().app);
		const wrongToken = `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`;
		// Act
		const responses = await Promise.all(
			["", "invalid!", token.slice(1), `${token}A`, wrongToken, otherToken].map((candidate) =>
				request(app, "/api/account/unknown", { headers: { "X-Codemem-Account-Csrf": candidate } }),
			),
		);
		responses.push(await request(app, `/api/account/unknown?csrfToken=${token}`));
		// Assert
		expect(otherToken).not.toBe(token);
		for (const response of responses) {
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "account_csrf_invalid" });
			expectPrivate(response);
		}
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it.each(["HEAD", "POST"])("never returns the session token through %s", async (method) => {
		// Arrange
		const { app, storeFactory } = fixture();
		const token = await tokenFor(app);
		// Act
		const response = await request(app, SESSION, {
			method,
			headers: { Origin: ORIGIN, "X-Codemem-Account-Csrf": token },
		});
		// Assert
		expect(response.status).not.toBe(200);
		expect(await response.text()).not.toContain(token);
		expectPrivate(response);
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it.each([
		{ path: `${SESSION}?unused=1`, headers: {} },
		{ path: SESSION, headers: { "Content-Length": "1" } },
		{ path: SESSION, headers: { "Transfer-Encoding": "chunked" } },
	])("rejects session query/body framing: %j", async ({ path, headers }) => {
		// Arrange
		const { app, storeFactory } = fixture();
		// Act
		const response = await request(app, path, { headers });
		// Assert
		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain("csrfToken");
		expectPrivate(response);
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it("does not mount account sessions when disabled or on the sync listener", async () => {
		// Arrange
		const storeFactory = vi.fn(() => {
			throw new Error("Unexpected store access");
		});
		const disabled = createApp({ storeFactory });
		const sync = createSyncApp({
			storeFactory,
			accountLink: { getListenerAddress: () => ({ host: "127.0.0.1", port: 7337 }) },
		});
		// Act
		const responses = await Promise.all([request(disabled), request(sync)]);
		// Assert
		for (const response of responses) {
			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain("csrfToken");
		}
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it("preserves non-account loopback CORS and does not leak the session into HTML", async () => {
		// Arrange
		const { app, storeFactory } = fixture();
		const token = await tokenFor(app);
		// Act
		const preflight = await request(app, "/api/unrelated", {
			method: "OPTIONS",
			headers: { Origin: "http://localhost:7338" },
		});
		const html = await request(app, "/");
		// Assert
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:7338");
		expect(html.status).toBe(200);
		expect(await html.text()).not.toContain(token);
		expect(storeFactory).not.toHaveBeenCalled();
	});
});

// Synthetic downstream handlers exercise mutations/errors without adding production routes.
function mutationFixture() {
	const app = new Hono();
	const guard = createAccountGuard({
		getListenerAddress: () => ({ host: "127.0.0.1", port: 7337 }),
	});
	const mutate = vi.fn();
	app.use("*", guard.middleware);
	app.route("/", guard.routes);
	app.post("/api/account/action", (c) => {
		mutate();
		return c.json({ ok: true });
	});
	app.get("/api/account/error", () => {
		throw new Error("synthetic downstream failure");
	});
	app.get("/api/account/non-error", () => {
		throw "synthetic non-Error failure";
	});
	app.onError((_error, c) => {
		c.header("Access-Control-Allow-Origin", ORIGIN);
		c.header("Access-Control-Expose-Headers", "X-Test");
		return c.json({ error: "synthetic_failure" }, 500);
	});
	return { app, mutate };
}

describe("standalone account action guard", () => {
	it("returns a generic private failure when a downstream handler throws a non-Error", async () => {
		// Arrange
		const { app } = mutationFixture();
		const token = await tokenFor(app);
		// Act
		const response = await request(app, "/api/account/non-error", {
			headers: { "X-Codemem-Account-Csrf": token },
		});
		// Assert
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "account_request_rejected" });
		expectPrivate(response);
	});

	it.each(["valid", "missing-origin", "foreign-origin", "missing-token"])(
		"accepts only a current CSRF token with exact POST Origin: %s",
		async (scenario) => {
			// Arrange
			const { app, mutate } = mutationFixture();
			const token = await tokenFor(app);
			const headers: Record<string, string> = {};
			if (scenario !== "missing-origin") headers.Origin = ORIGIN;
			if (scenario === "foreign-origin") headers.Origin = "http://127.0.0.1:7338";
			if (scenario !== "missing-token") headers["X-Codemem-Account-Csrf"] = token;
			// Act
			const response = await request(app, "/api/account/action", { method: "POST", headers });
			// Assert
			expect(response.status).toBe(scenario === "valid" ? 200 : 403);
			expect(mutate).toHaveBeenCalledTimes(scenario === "valid" ? 1 : 0);
			expect(await response.text()).not.toContain(token);
			expectPrivate(response);
		},
	);

	it("keeps thrown-handler responses private and strips downstream CORS headers", async () => {
		// Arrange
		const { app } = mutationFixture();
		const token = await tokenFor(app);
		// Act
		const response = await request(app, "/api/account/error", {
			headers: { "X-Codemem-Account-Csrf": token },
		});
		// Assert
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain(token);
		expectPrivate(response);
	});
});
