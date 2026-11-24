import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	createDeviceRejoinStatusHandler,
	type DeviceRejoinStatusHttpDeps,
} from "./coordinator-device-rejoin-status-http.js";
import {
	finalizeStatusLive,
	liveReceipt,
	statusLiveScope as scope,
	seedStatusLive,
	statusLiveSnapshot,
} from "./coordinator-device-rejoin-status-live-test-harness.js";

const path = "/v1/auth/rejoin-attempts/attempt/status";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	vi.restoreAllMocks();
});

async function fixture(kind: "SQLite" | "D1") {
	const clock = vi.spyOn(Date, "now").mockReturnValue(scope.now);
	const { db, store } = setupStore(kind);
	closers.push(async () => {
		await store.close();
		if (db.open) db.close();
	});
	const fixtureDb = {
		first: async <T>({ sql, values }: { sql: string; values: (string | number | null)[] }) =>
			(db.prepare(sql).get(...values) as T | undefined) ?? null,
		run: async (sql: string, ...values: (string | number | null)[]) =>
			db.prepare(sql).run(...values),
	};
	const poll = await seedStatusLive(fixtureDb);
	const backend = await store.readDeviceRejoinBackend();
	if (!backend) throw new Error("Synthetic backend unavailable");
	const first = vi.fn(backend.first.bind(backend));
	const readBackend = vi.fn(
		async (): Promise<AuthLinkBackend | null> => ({
			...backend,
			first: first as AuthLinkBackend["first"],
		}),
	);
	const close = vi.fn(async () => {});
	const storeFactory = vi.fn(() => ({ readDeviceRejoinBackend: readBackend, close }));
	const clientKey = vi.fn<() => string | null>(() => "client-a");
	const buckets = new Map<string, number>();
	const rateLimitedResponse = vi.fn<DeviceRejoinStatusHttpDeps["rateLimitedResponse"]>(
		(c, key, options) => {
			expect(options).toEqual({ authenticated: false });
			const spent = (buckets.get(key) ?? 0) + 1;
			buckets.set(key, spent);
			return spent > 10 ? c.json({ error: "rate_limited" }, 429) : null;
		},
	);
	const readRequestBytes = vi.fn<DeviceRejoinStatusHttpDeps["readRequestBytes"]>(
		async (c, maxBytes) => {
			expect(maxBytes).toBe(4096);
			const raw = new Uint8Array(await c.req.raw.arrayBuffer());
			return raw.byteLength > maxBytes ? null : raw;
		},
	);
	const deps: DeviceRejoinStatusHttpDeps = {
		config: {
			enabled: true,
			coordinatorId: scope.coordinatorId,
			issuer: scope.issuer,
			revision: scope.authConfigRevision,
			redirectUri: `${scope.origin}/auth/callback`,
		},
		clientKey,
		rateLimitedResponse,
		readRequestBytes,
		storeFactory,
	};
	const handler = createDeviceRejoinStatusHandler(deps);
	const app = new Hono();
	const internal: unknown[] = [];
	// This test adapter records the non-wire result. Production has no adapter or route.
	app.post("/v1/auth/rejoin-attempts/:attemptId/status", async (c) => {
		const result = await handler(c);
		if (result instanceof Response) return result;
		internal.push(result);
		return new Response(null, { status: 204 });
	});
	const body = (now = scope.now) => {
		const proof = poll(now);
		return {
			device_id: proof.deviceId,
			timestamp_ms: proof.timestampMs,
			signature: proof.signature,
		};
	};
	const send = (data: object | string | Uint8Array = body(), url = `${scope.origin}${path}`) =>
		app.request(url, {
			method: "POST",
			body: data instanceof Uint8Array || typeof data === "string" ? data : JSON.stringify(data),
		});
	return {
		clock,
		fixtureDb,
		body,
		send,
		deps,
		internal,
		first,
		close,
		clientKey,
		readBackend,
		storeFactory,
		readRequestBytes,
		rateLimitedResponse,
	};
}

describe.each(["SQLite", "D1"] as const)("unmounted status handler (%s)", (kind) => {
	it("returns pending status and the exact live finalized projection using the retained tombstone", async () => {
		const f = await fixture(kind);
		const pending = await f.send();
		expect(pending.status).toBe(200);
		expect(pending.headers.get("Cache-Control")).toBe("no-store");
		expect(pending.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(await pending.json()).toEqual({ state: "pending", expires_at_ms: scope.now + 600_000 });
		await finalizeStatusLive(f.fixtureDb);
		const before = await statusLiveSnapshot(f.fixtureDb);
		const result = await f.send();
		expect(await result.json()).toEqual({
			state: "finalized",
			expires_at_ms: scope.now + 600_000,
			confirmation_view: {
				destinations: [["group", null]],
				non_destinations: [["other", "excluded"]],
			},
			receipt: liveReceipt,
		});
		expect(await statusLiveSnapshot(f.fixtureDb)).toEqual(before);
		expect(f.close).toHaveBeenCalledTimes(2);
	});

	it("rejects transport before storage and accepts exactly 4096 bytes", async () => {
		const f = await fixture(kind);
		expect((await f.send("x".repeat(4097))).status).toBe(413);
		expect((await f.send(new Uint8Array([0xff]))).status).toBe(400);
		expect((await f.send({ ...f.body(), completion: "private" })).status).toBe(400);
		expect((await f.send(f.body(), `${scope.origin}${path}?x=1`)).status).toBe(400);
		expect((await f.send(f.body(), `https://other.example.test${path}`)).status).toBe(403);
		expect(f.storeFactory).not.toHaveBeenCalled();
		const raw = JSON.stringify(f.body());
		expect((await f.send(raw.padEnd(4096, " "))).status).toBe(200);
	});

	it("masks missing attempts and invalid proofs without any projection read", async () => {
		const f = await fixture(kind);
		const before = await statusLiveSnapshot(f.fixtureDb);
		for (const [data, url] of [
			[{ ...f.body(), signature: "invalid" }, `${scope.origin}${path}`],
			[f.body(), `${scope.origin}/v1/auth/rejoin-attempts/missing/status`],
			[{ ...f.body(), timestamp_ms: scope.now + 300_001 }, `${scope.origin}${path}`],
		] as const) {
			const response = await f.send(data, url);
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "device_rejoin_unavailable" });
		}
		expect(
			f.first.mock.calls.some(([statement]) => statement.sql.includes("final_receipt_json")),
		).toBe(false);
		expect(await statusLiveSnapshot(f.fixtureDb)).toEqual(before);
	});

	it("charges only the trusted client budget before reads, independent of body and attempt", async () => {
		const f = await fixture(kind);
		for (let n = 0; n < 10; n++)
			expect(
				(await f.send("invalid", `${scope.origin}/v1/auth/rejoin-attempts/attempt-${n}/status`))
					.status,
			).toBe(400);
		const reads = f.readRequestBytes.mock.calls.length;
		expect((await f.send()).status).toBe(429);
		expect(f.readRequestBytes).toHaveBeenCalledTimes(reads);
		expect(f.storeFactory).not.toHaveBeenCalled();
		f.clientKey.mockReturnValueOnce(null);
		expect((await f.send()).status).toBe(403);
		expect(f.rateLimitedResponse).toHaveBeenCalledTimes(11);
		f.clientKey.mockReturnValueOnce("client-b");
		expect((await f.send()).status).toBe(200);
		expect(f.rateLimitedResponse.mock.calls.at(-1)?.[1]).toBe(
			JSON.stringify(["device-rejoin:status", scope.coordinatorId, "client-b"]),
		);
	});

	it("checks readiness and closes storage on refusal and exceptions", async () => {
		const f = await fixture(kind);
		f.readBackend.mockResolvedValueOnce(null);
		expect((await f.send()).status).toBe(404);
		f.readBackend.mockRejectedValueOnce(new Error("synthetic failure"));
		const unknown = await f.send();
		expect(unknown.status).toBe(503);
		expect(await unknown.json()).toEqual({ error: "device_rejoin_unknown" });
		expect(f.close).toHaveBeenCalledTimes(2);
		f.deps.config.enabled = false;
		expect((await f.send()).status).toBe(403);
		expect(f.storeFactory).toHaveBeenCalledTimes(2);
	});

	it("returns only authenticated internal tags at elapsed and stored-expired boundaries", async () => {
		const f = await fixture(kind);
		await finalizeStatusLive(f.fixtureDb);
		f.clock.mockReturnValue(scope.now + 600_000);
		await f.send(f.body(scope.now + 600_000));
		expect(f.internal).toEqual([{ kind: "authenticated_deadline_elapsed" }]);
		expect(
			f.first.mock.calls.some(([statement]) => statement.sql.includes("final_receipt_json")),
		).toBe(false);
		expect(f.close).toHaveBeenCalledOnce();
	});
});
