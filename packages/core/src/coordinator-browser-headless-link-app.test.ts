import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { HEADLESS_CODE_LIMITS_TABLE } from "./coordinator-auth-headless-schema.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	admitCoordinatorBrowserAuthSetup,
	type CoordinatorBrowserAuthClientKey,
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

const ORIGIN = "https://app.example.test";
const PAGE = `${ORIGIN}/auth/link/device`;
const stores: BetterSqliteCoordinatorStore[] = [];

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		for (const store of stores.splice(0)) store.db.close();
	}
});

const config = {
	enabled: true,
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.google.com",
	revision: "a".repeat(64),
	redirectUri: PROVIDER.redirectUri,
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
};

async function snapshotFor(overrides: Partial<typeof config> = {}) {
	return captureCoordinatorBrowserAuthOptions({
		config: { ...config, ...overrides },
		csrfKey: await importBrowserCsrfKey(randomBytes(32)),
		oidcOptions: { fetch: oidcFixture({ issuer: config.issuer }).fetch },
	});
}

async function mount(options: { clientAddress?: CoordinatorBrowserAuthClientKey } = {}) {
	const store = new BetterSqliteCoordinatorStore(":memory:", { authClock: () => NOW });
	stores.push(store);
	const limiter = createInMemoryRequestRateLimiter({ now: () => NOW });
	const result = await createCoordinatorBrowserAuth(await snapshotFor(), store, limiter);
	if (!result.ok) throw new Error("fixture_composition_failed");
	const app = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
		requestVerifier: () => false,
		browserAuth: {
			kind: "ready",
			auth: result.auth,
			storeFactory: () => store,
			clientKey: () => "client-a",
			...options,
		},
	});
	return { store, app };
}

describe("headless code entry mounting", () => {
	it("serves the code form when the host supplies a verified client address", async () => {
		// Arrange
		const { app } = await mount({ clientAddress: () => "203.0.113.7" });
		// Act
		const response = await app.fetch(new Request(PAGE));
		// Assert
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Enter the code shown on your device");
	});

	it("is not mounted on a host without a verified client address", async () => {
		// Arrange: a Node host that only knows forwarded headers supplies no clientAddress.
		const { app } = await mount();
		// Act
		const page = await app.fetch(new Request(PAGE, { headers: { "x-forwarded-for": "1.2.3.4" } }));
		// Assert
		expect(page.status).toBe(404);
		expect(await page.text()).not.toContain("Enter the code");
	});

	it("reports not found until both headless tables exist", async () => {
		// Arrange
		const { store, app } = await mount({ clientAddress: () => "203.0.113.7" });
		store.db.exec(`DROP TABLE ${HEADLESS_CODE_LIMITS_TABLE}`);
		// Act
		const page = await app.fetch(new Request(PAGE));
		const post = await app.fetch(
			new Request(PAGE, {
				method: "POST",
				headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
				body: "csrf=x&user_code=BCDFGHJK",
			}),
		);
		// Assert
		expect(page.status).toBe(404);
		expect(post.status).toBe(404);
	});

	it("answers 503 when browser authentication is unavailable", async () => {
		// Arrange
		const app = createCoordinatorApp({
			storeFactory: () => {
				throw new Error("unused");
			},
			runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
			requestVerifier: () => false,
			browserAuth: { kind: "unavailable" },
		});
		// Act
		const response = await app.fetch(new Request(PAGE));
		// Assert
		expect(response.status).toBe(503);
	});
});

describe("headless code entry paths", () => {
	it("cannot be claimed as the OIDC callback path", async () => {
		// Act
		const snapshot = await snapshotFor({ redirectUri: PAGE });
		// Assert
		expect(snapshot).toEqual({
			kind: "invalid",
			error: "browser_auth_config_invalid",
			field: "redirectUri",
		});
	});

	it("is admitted for GET and POST setup and refuses other methods", async () => {
		// Arrange
		const snapshot = await snapshotFor();
		const limiter = createInMemoryRequestRateLimiter({ now: () => NOW });
		// Act
		const get = admitCoordinatorBrowserAuthSetup(snapshot, new Request(PAGE), limiter, "client-a");
		const put = admitCoordinatorBrowserAuthSetup(
			snapshot,
			new Request(PAGE, { method: "PUT" }),
			limiter,
			"client-a",
		);
		// Assert
		expect(get).toBe(true);
		expect(put).toBeInstanceOf(Response);
		expect((put as Response).status).toBe(405);
		expect((put as Response).headers.get("allow")).toBe("GET, POST");
	});
});
