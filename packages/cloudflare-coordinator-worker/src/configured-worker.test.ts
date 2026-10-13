import { generateKeyPairSync, sign } from "node:crypto";
import {
	buildCanonicalRequest,
	connectCoordinator,
	fingerprintPublicKey,
	SIGNATURE_VERSION,
} from "@codemem/core";
import type {
	D1DatabaseLike,
	D1PreparedStatementLike,
} from "@codemem/core/internal/cloudflare-coordinator";
import { D1CoordinatorStore } from "@codemem/core/internal/cloudflare-coordinator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import defaultWorker, {
	type CloudflareCoordinatorEnv,
	createConfiguredCloudflareCoordinatorWorker,
} from "./index.js";

const ORIGIN = "https://coordinator.example.test";
const NOW = 1790899200000;
const CONFIG = {
	enabled: true,
	coordinatorId: "fixture-coordinator",
	issuer: "https://accounts.google.com",
	clientId: "fixture-client-id",
	redirectUri: `${ORIGIN}/auth/callback`,
	revision: "a".repeat(64),
};

// Local SQLite implements the D1 boundary; provider discovery never leaves this process.
function databaseFixture() {
	const db = connectCoordinator(":memory:");
	function prepare(query: string): D1PreparedStatementLike {
		const statement = db.prepare(query);
		let bound: unknown[] = [];
		return {
			bind(...values: unknown[]) {
				bound = values;
				return this;
			},
			async first<T>() {
				return (statement.get(...bound) as T | undefined) ?? null;
			},
			async all<T>() {
				return { results: statement.all(...bound) as T[] };
			},
			async raw<T>() {
				return statement.raw(true).all(...bound) as T[];
			},
			async run() {
				if (statement.reader) return { results: statement.all(...bound), meta: { changes: 0 } };
				return { meta: { changes: statement.run(...bound).changes } };
			},
		};
	}
	const binding: D1DatabaseLike = {
		prepare,
		async batch(statements) {
			return Promise.all(statements.map((statement) => statement.run()));
		},
	};
	return { db, binding };
}

const databases: ReturnType<typeof databaseFixture>[] = [];
function environment(): CloudflareCoordinatorEnv {
	const fixture = databaseFixture();
	databases.push(fixture);
	return {
		COORDINATOR_DB: fixture.binding,
		CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: JSON.stringify(CONFIG),
		CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET: "dummy-client-secret",
		CODEMEM_COORDINATOR_BROWSER_CSRF_KEY: "0123456789abcdef".repeat(4),
	};
}

function request(path: string, init?: RequestInit) {
	return new Request(`${ORIGIN}${path}`, init);
}

function signinPost(fields: Record<string, string>, cookie: string) {
	return request("/auth/sign-in", {
		method: "POST",
		headers: {
			origin: ORIGIN,
			cookie,
			"content-type": "application/x-www-form-urlencoded",
			"CF-Connecting-IP": "192.0.2.1",
		},
		body: new URLSearchParams(fields),
	});
}

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		if (String(input) !== `${CONFIG.issuer}/.well-known/openid-configuration`)
			throw new Error("Unexpected provider request; network forbidden");
		return new Response(
			JSON.stringify({
				issuer: CONFIG.issuer,
				authorization_endpoint: `${CONFIG.issuer}/authorize`,
				token_endpoint: `${CONFIG.issuer}/token`,
				jwks_uri: `${CONFIG.issuer}/jwks`,
				response_types_supported: ["code"],
				subject_types_supported: ["public"],
				id_token_signing_alg_values_supported: ["RS256"],
				token_endpoint_auth_methods_supported: ["client_secret_post"],
			}),
			{ headers: { "content-type": "application/json" } },
		);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const { db } of databases.splice(0)) db.close();
});

async function ordinaryRoutes(
	worker: ReturnType<typeof createConfiguredCloudflareCoordinatorWorker>,
	env: CloudflareCoordinatorEnv,
) {
	const missing = await worker.fetch(request("/unknown-path"), env);
	const presence = await worker.fetch(
		request("/v1/presence", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ group_id: "fixture-group", addresses: [] }),
		}),
		env,
	);
	return { missing, presence, body: await presence.json() };
}

it.each([undefined, JSON.stringify({ enabled: false })])(
	"leaves auth unmounted and performs no discovery for config %s",
	async (config) => {
		// Arrange: exercise the shipped default, not just the explicit-options factory.
		const env = environment();
		env.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = config;
		delete env.CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET;
		delete env.CODEMEM_COORDINATOR_BROWSER_CSRF_KEY;
		// Act
		const signin = await defaultWorker.fetch(request("/auth/sign-in"), env);
		const routes = await ordinaryRoutes(defaultWorker, env);
		// Assert: ordinary routing and signed-API rejection remain active.
		expect(signin.status).toBe(404);
		expect(signin.headers.get("set-cookie")).toBeNull();
		expect(routes.missing.status).toBe(404);
		expect(routes.presence.status).toBe(401);
		expect(routes.body).toEqual({ error: "missing_headers" });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);

it.each([
	["malformed JSON", "{"],
	["invalid issuer", JSON.stringify({ ...CONFIG, issuer: "https://untrusted.example.test" })],
	["invalid revision", JSON.stringify({ ...CONFIG, revision: "not-a-revision" })],
])("disables only auth routes for %s", async (_name, config) => {
	// Arrange
	const env = environment();
	env.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = config;
	const worker = createConfiguredCloudflareCoordinatorWorker();
	// Act
	const auth = await Promise.all(
		["/auth/sign-in", "/auth/callback", "/v1/auth/link-attempts"].map((path) =>
			worker.fetch(request(path), env),
		),
	);
	const routes = await ordinaryRoutes(worker, env);
	// Assert: failure is generic, never secret-bearing, and never replaces the device API.
	for (const response of auth) {
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("Authentication unavailable. Try again.");
		expect(response.headers.get("set-cookie")).toBeNull();
	}
	expect(routes.missing.status).toBe(404);
	expect(routes.presence.status).toBe(401);
	expect(routes.body).toEqual({ error: "missing_headers" });
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("mounts sign-in from bindings and preserves its CSRF key across independent workers", async () => {
	// Arrange: a browser form from one isolate must work in another with the same bindings.
	const env = environment();
	const first = createConfiguredCloudflareCoordinatorWorker();
	const second = createConfiguredCloudflareCoordinatorWorker();
	const page = await first.fetch(request("/auth/sign-in"), env);
	const html = await page.text();
	const fields = Object.fromEntries(
		[...html.matchAll(/name="([a-z_]+)" value="([^"]+)"/g)].map((match) => [match[1], match[2]]),
	);
	const cookie = page.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");
	// Act
	const forged = await second.fetch(signinPost({ ...fields, csrf: "forged" }, cookie), env);
	const started = await second.fetch(signinPost(fields, cookie), env);
	const repeatedPage = await second.fetch(request("/auth/sign-in"), { ...env });
	const routes = await ordinaryRoutes(second, env);
	// Assert: use the real SDK with fake discovery; no browser redirect actually reaches Google.
	expect(page.status).toBe(200);
	expect(html).toContain("<form");
	expect(fields.csrf).toBeTruthy();
	expect(cookie).toBeTruthy();
	expect(forged.status).toBe(403);
	expect(started.status).toBe(200);
	expect(await started.text()).toContain(`${CONFIG.issuer}/authorize`);
	expect(repeatedPage.status).toBe(200);
	expect(routes.presence.status).toBe(401);
	expect(routes.body).toEqual({ error: "missing_headers" });
	expect(globalThis.fetch).toHaveBeenCalled();
});

it("keeps valid signed presence usable when browser configuration is malformed", async () => {
	// Arrange: a fixture-only Ed25519 identity enrolled through the real D1 adapter.
	const env = environment();
	env.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = "{";
	const worker = createConfiguredCloudflareCoordinatorWorker();
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(8 + kind.length + raw.length);
	wire.writeUInt32BE(kind.length);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	const fingerprint = fingerprintPublicKey(publicKey);
	if (!env.COORDINATOR_DB) throw new Error("Fixture DB missing");
	const store = new D1CoordinatorStore(env.COORDINATOR_DB);
	await store.createGroup("fixture-group");
	await store.enrollDevice("fixture-group", {
		deviceId: "fixture-device",
		publicKey,
		fingerprint,
	});
	const body = JSON.stringify({
		group_id: "fixture-group",
		fingerprint,
		addresses: ["http://127.0.0.1:7337"],
		ttl_s: 180,
	});
	const timestamp = String(NOW / 1000);
	const nonce = "configured-worker-fixture";
	const signature = sign(
		null,
		buildCanonicalRequest("POST", "/v1/presence", timestamp, nonce, Buffer.from(body)),
		keys.privateKey,
	);
	const headers = {
		"content-type": "application/json",
		"X-Opencode-Device": "fixture-device",
		"X-Opencode-Timestamp": timestamp,
		"X-Opencode-Nonce": nonce,
		"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature.toString("base64")}`,
	};
	// Act
	const accepted = await worker.fetch(
		request("/v1/presence", { method: "POST", headers, body }),
		env,
	);
	const rejected = await worker.fetch(
		request("/v1/presence", {
			method: "POST",
			headers: { ...headers, "X-Opencode-Signature": `v3:${signature.toString("base64")}` },
			body,
		}),
		env,
	);
	// Assert: browser failure neither accepts invalid signatures nor blocks enrolled devices.
	expect(accepted.status).toBe(200);
	expect(rejected.status).toBe(401);
	expect(await rejected.json()).toEqual({ error: "invalid_signature" });
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("contains discovery failure to auth and reuses the settled failure", async () => {
	// Arrange: provider errors may contain secrets but must never reach responses.
	const env = environment();
	const worker = createConfiguredCloudflareCoordinatorWorker();
	vi.mocked(globalThis.fetch).mockRejectedValue(new Error("dummy-client-secret provider failure"));
	// Act
	const first = await worker.fetch(request("/auth/sign-in"), env);
	const discoveryCalls = vi.mocked(globalThis.fetch).mock.calls.length;
	const second = await worker.fetch(request("/auth/sign-in"), env);
	const routes = await ordinaryRoutes(worker, env);
	// Assert: retries do not discover again or change unrelated route behavior.
	for (const response of [first, second]) {
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("Authentication unavailable. Try again.");
	}
	expect(discoveryCalls).toBeGreaterThan(0);
	expect(globalThis.fetch).toHaveBeenCalledTimes(discoveryCalls);
	expect(routes.missing.status).toBe(404);
	expect(routes.presence.status).toBe(401);
	expect(routes.body).toEqual({ error: "missing_headers" });
});

it.each(["config", "csrfKey", "clientSecret", "database"] as const)(
	"rejects %s drift without replacing ordinary routes or the captured worker",
	async (field) => {
		// Arrange: setup settles before any binding changes.
		const env = environment();
		const worker = createConfiguredCloudflareCoordinatorWorker();
		const initial = await worker.fetch(request("/auth/sign-in"), env);
		const changed = { ...env };
		if (field === "config")
			changed.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({
				...CONFIG,
				revision: "b".repeat(64),
			});
		if (field === "csrfKey") changed.CODEMEM_COORDINATOR_BROWSER_CSRF_KEY = "ab".repeat(32);
		if (field === "clientSecret") changed.CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET = "changed-dummy";
		if (field === "database") changed.COORDINATOR_DB = environment().COORDINATOR_DB;
		vi.mocked(globalThis.fetch).mockClear();
		// Act
		const denied = await worker.fetch(request("/auth/sign-in"), changed);
		const routes = await ordinaryRoutes(worker, changed);
		const restored = await worker.fetch(request("/auth/sign-in"), env);
		// Assert: drift never triggers discovery or silently replaces captured credentials.
		expect(initial.status).toBe(200);
		expect(denied.status).toBe(503);
		expect(await denied.text()).toBe("Authentication unavailable. Try again.");
		expect(routes.missing.status).toBe(404);
		expect(routes.presence.status).toBe(401);
		expect(routes.body).toEqual({ error: "missing_headers" });
		expect(restored.status).toBe(200);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	},
);
