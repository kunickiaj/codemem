import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { HEADLESS_CODE_LIMITS_TABLE } from "./coordinator-auth-headless-schema.js";
import {
	HEADLESS_ID,
	headlessCreate,
	USER_CODE,
} from "./coordinator-auth-link-headless-test-fixtures.js";
import { authorize, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

const render = vi.hoisted(() => ({ fail: false }));
vi.mock("./coordinator-auth-browser-view.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./coordinator-auth-browser-view.js")>();
	return {
		...original,
		renderAuthSigninContinuePage: (
			input: Parameters<typeof original.renderAuthSigninContinuePage>[0],
		) => {
			if (render.fail) throw new Error("fixture_render_failed");
			return original.renderAuthSigninContinuePage(input);
		},
	};
});

const ORIGIN = "https://app.example.test";
const PAGE = `${ORIGIN}/auth/link/device`;
const databases: ReturnType<typeof setupStore>["db"][] = [];

beforeEach(() => {
	render.fail = false;
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

async function setup() {
	const f = setupStore("SQLite", { authClock: () => NOW });
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
	expect(await f.store.createHeadlessAuthLinkAttempt(await headlessCreate(), config)).toMatchObject(
		{ kind: "created" },
	);
	const snapshot = captureCoordinatorBrowserAuthOptions({
		config,
		csrfKey: await importBrowserCsrfKey(randomBytes(32)),
		oidcOptions: { fetch: oidcFixture({ issuer: config.issuer }).fetch },
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
			clientAddress: () => "203.0.113.7",
		},
	});
	return { ...f, app };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

async function enter(f: Fixture, code = USER_CODE) {
	const page = await f.app.request(PAGE);
	const binder = page.headers.getSetCookie()[0]?.split(";")[0] ?? "";
	const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
	return f.app.request(PAGE, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			cookie: binder,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ csrf, user_code: code }),
	});
}

function attemptState(f: Fixture) {
	return (
		f.db
			.prepare("SELECT state FROM coordinator_auth_link_attempts WHERE attempt_id = ?")
			.get(HEADLESS_ID) as { state: string }
	).state;
}

describe("headless code entry when the continuation page cannot render", () => {
	it("leaves the attempt pending so the same code still works", async () => {
		// Arrange
		const f = await setup();
		render.fail = true;
		// Act
		const failed = await enter(f);
		render.fail = false;
		const stateAfterFailure = attemptState(f);
		const retried = await enter(f);
		// Assert
		expect(failed.status).toBe(503);
		expect(failed.headers.getSetCookie()).toEqual([]);
		expect(stateAfterFailure).toBe("pending");
		expect(retried.status).toBe(200);
		expect(await retried.text()).toContain('href="https://accounts.google.com/');
		expect(attemptState(f)).toBe("browser_claimed");
	});
});

describe("headless capability after the first request", () => {
	it("reports not found for GET and POST once a required table is dropped", async () => {
		// Arrange
		const f = await setup();
		expect((await f.app.request(PAGE)).status).toBe(200);
		f.db.exec(`DROP TABLE ${HEADLESS_CODE_LIMITS_TABLE}`);
		// Act
		const page = await f.app.request(PAGE);
		const post = await f.app.request(PAGE, {
			method: "POST",
			headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
			body: "csrf=x&user_code=BCDFGHJK",
		});
		const confirm = await f.app.request(`${ORIGIN}/auth/link/device/confirm`, {
			method: "POST",
			headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
			body: `csrf=x&attempt_id=${HEADLESS_ID}`,
		});
		// Assert
		expect(page.status).toBe(404);
		expect(post.status).toBe(404);
		expect(confirm.status).toBe(404);
	});
});
