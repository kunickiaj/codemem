import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Backend, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import type { DeviceAuthLinkDeps } from "./coordinator-device-auth-link.js";
import { verifiedFixture } from "./coordinator-device-rejoin-start-evidence-test-harness.js";
import { prepareDeviceRejoinStartHandler } from "./coordinator-device-rejoin-start-http.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

const origin = "https://coordinator.example.test";
const path = "/v1/auth/rejoin-attempts";
const issuer = "https://accounts.google.com";
const revision = "b".repeat(64);
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
	vi.restoreAllMocks();
});

async function fixture(kind: Backend) {
	const { db, store } = setupStore(kind);
	const realClose = store.close.bind(store);
	disposers.push(async () => {
		await realClose();
		if (db.open) db.close();
	});
	vi.spyOn(store, "close").mockResolvedValue(undefined);
	const { input } = await verifiedFixture({
		run: async (sql, ...values) => db.prepare(sql).run(...values),
	});
	const now = vi.spyOn(Date, "now").mockReturnValue(input.timestampMs);
	const body = {
		device_id: input.deviceId,
		public_key: input.publicKey,
		attempt_id: input.attemptId,
		browser_start_hash: input.browserStartHash,
		loopback_redirect: input.loopbackRedirect,
		timestamp_ms: input.timestampMs,
		signature: input.signature,
	};
	const storeFactory = vi.fn(() => store);
	const address = vi.fn<() => string | null>(() => "a");
	const pending = vi.fn();
	const limiter = createInMemoryRequestRateLimiter({ now: Date.now });
	const readRequestBytes = vi.fn<DeviceAuthLinkDeps["readRequestBytes"]>(async (c, max) => {
		const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
		return bytes.length <= max ? bytes : null;
	});
	const rate = vi.fn<DeviceAuthLinkDeps["rateLimitedResponse"]>((c, key, { authenticated }) => {
		const result = limiter.check(JSON.stringify([authenticated, key]), authenticated ? 2 : 4);
		return result.allowed ? null : c.json({ error: "rate_limited" }, 429);
	});
	const start = prepareDeviceRejoinStartHandler({
		config: {
			enabled: true,
			coordinatorId: "coordinator",
			redirectUri: `${origin}/auth/callback`,
			revision,
			issuer,
		},
		clientAddress: address,
		storeFactory,
		readRequestBytes,
		rateLimitedResponse: rate,
	});
	const app = new Hono();
	app.post(path, async (c) => {
		const outcome = await start(c);
		if (outcome instanceof Response) return outcome;
		pending(outcome);
		// This is a test transport, not the pending duplicate-start HTTP decision.
		return new Response(null, { status: 204 });
	});
	const send = (payload: unknown = body, url = `${origin}${path}`) =>
		app.request(url, {
			method: "POST",
			body: typeof payload === "string" ? payload : JSON.stringify(payload),
		});
	const attempts = () => db.prepare("SELECT * FROM coordinator_device_rejoin_attempts").all();
	return { body, address, now, pending, readRequestBytes, rate, send, storeFactory, attempts };
}

describe.each(["SQLite", "D1"] as const)("prepared rejoin start (%s)", (kind) => {
	it("reads the raw bounded body, admits verified evidence and returns only the committed pins", async () => {
		const f = await fixture(kind);
		const response = await f.send();
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(f.readRequestBytes.mock.calls[0]?.[1]).toBe(4096);
		const stored = f.attempts()[0] as { removal_digest: string };
		expect(await response.json()).toEqual({
			attempt_id: "attempt",
			expires_at_ms: f.body.timestamp_ms + 600_000,
			coordinator_id: "coordinator",
			origin,
			issuer,
			auth_config_revision: revision,
			identity_id: "identity",
			binding_id: "binding",
			removal_digest: stored.removal_digest,
		});
		expect(
			f.rate.mock.calls.map(([, key, options]) => [JSON.parse(key), options.authenticated]),
		).toEqual([
			[["device-rejoin:start", "coordinator", "a"], false],
			[["device-rejoin:start", "coordinator", "a", "device"], true],
		]);
		const before = f.attempts();
		await f.send();
		expect(f.pending).toHaveBeenCalledExactlyOnceWith({ kind: "duplicate_start" });
		expect(f.attempts()).toEqual(before);
	});

	it("charges only the verified source before reading the body and isolates the device budget", async () => {
		const f = await fixture(kind);
		for (let n = 0; n < 4; n++) {
			const denied = await f.send({ ...f.body, signature: "invalid" });
			expect(denied.status).toBe(403);
			expect(await denied.json()).toEqual({ error: "device_rejoin_unavailable" });
		}
		expect(f.rate.mock.calls.every(([, , options]) => !options.authenticated)).toBe(true);
		expect((await f.send()).status).toBe(429);
		expect(f.readRequestBytes).toHaveBeenCalledTimes(4);
		expect(f.attempts()).toEqual([]);
		f.address.mockReturnValue("b");
		expect((await f.send()).status).toBe(200);
		const before = f.attempts();
		await f.send();
		expect((await f.send()).status).toBe(429);
		f.address.mockReturnValue("c");
		await f.send();
		expect(f.pending).toHaveBeenCalledTimes(2);
		expect(f.attempts()).toEqual(before);
	});

	it("refuses requests with no trusted source or invalid transport before accessing storage", async () => {
		const f = await fixture(kind);
		f.address.mockReturnValueOnce(null);
		expect((await f.send()).status).toBe(403);
		expect(f.readRequestBytes).not.toHaveBeenCalled();
		expect((await f.send(f.body, `https://foreign.example.test${path}`)).status).toBe(403);
		expect((await f.send(f.body, `${origin}${path}?extra=1`)).status).toBe(400);
		expect((await f.send("a".repeat(4097))).status).toBe(413);
		expect((await f.send({ ...f.body, extra: true })).status).toBe(400);
		expect(f.storeFactory).not.toHaveBeenCalled();
	});

	it("rechecks proof freshness after the device budget step", async () => {
		const f = await fixture(kind);
		const limit = f.rate.getMockImplementation();
		f.rate.mockImplementation((c, key, options) => {
			if (options.authenticated) f.now.mockReturnValue(f.body.timestamp_ms + 300_001);
			return limit?.(c, key, options) ?? null;
		});
		expect((await f.send()).status).toBe(403);
		expect(f.attempts()).toEqual([]);
	});
});
