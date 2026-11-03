import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRelayHealthProbe,
	type RelayHealthProbeObservation,
	verifiedRelayHealthTime,
} from "./relay-health-probe.js";
import { healthFixture, healthMembers } from "./relay-health-test-fixtures.js";
import { verifySignature } from "./sync-auth.js";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("trusted relay health probe", () => {
	it("signs both exact scoped URLs with fresh normal v2 headers and validates both responses", async () => {
		// Arrange: normal wire payloads include enrollment and key evidence.
		const f = healthFixture();
		const observations: RelayHealthProbeObservation[] = [];
		const probe = createRelayHealthProbe(f.options, (value) => observations.push(value));
		// Act
		await probe();
		// Assert
		expect(observations.map((value) => [value.endpoint, value.outcome])).toEqual([
			["catalogue", "success"],
			["members", "success"],
		]);
		expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
			"https://coordinator.example.test/v1/scopes?group_id=group-a",
			"https://coordinator.example.test/v1/scopes/scope-a/members?group_id=group-a",
		]);
		const nonces = new Set<string | null>();
		for (const [, init] of f.fetcher.mock.calls) {
			const headers = new Headers(init?.headers);
			expect(init).toMatchObject({ method: "GET", redirect: "error" });
			expect(headers.get("X-Opencode-Signature")).toMatch(/^v2:/);
			nonces.add(headers.get("X-Opencode-Nonce"));
		}
		expect(nonces.size).toBe(2);
	});
	it.each([401, 403, 429, 500, 302])(
		"does not retry or treat HTTP %s as positive health",
		async (status) => {
			// Arrange
			const f = healthFixture();
			f.fetcher.mockImplementation(async () => new Response(null, { status }));
			const observe = vi.fn();
			// Act
			await createRelayHealthProbe(f.options, observe)();
			// Assert
			expect(f.fetcher).toHaveBeenCalledTimes(2);
			expect(observe.mock.calls.map(([value]) => value.outcome)).toEqual(
				Array(2).fill(status === 401 || status === 403 ? "denied" : "failure"),
			);
		},
	);
	it.each([
		[
			"malformed JSON",
			() => new Response("{", { headers: { "content-type": "application/json" } }),
		],
		[
			"body over 64 KiB",
			() => new Response(" ".repeat(65537), { headers: { "content-type": "application/json" } }),
		],
		["headers over 8 KiB", () => Response.json({}, { headers: { "x-padding": "x".repeat(8193) } })],
		["wrong content type", () => new Response("{}")],
		[
			"wrong realm",
			() => Response.json({ version: 1, items: [{ ...healthMembers.scope, group_id: "other" }] }),
		],
		["absent probe enrollment", () => Response.json({ ...healthMembers, items: [] })],
	] as const)("rejects %s", async (_name, response) => {
		// Arrange
		const f = healthFixture();
		f.fetcher.mockImplementation(async () => response());
		const observe = vi.fn();
		// Act
		await createRelayHealthProbe(f.options, observe)();
		// Assert
		expect(observe.mock.calls.every(([value]) => value.outcome === "failure")).toBe(true);
	});
	it("retains a successful catalogue when the member snapshot is malformed", async () => {
		// Arrange
		const f = healthFixture();
		f.fetcher
			.mockResolvedValueOnce(Response.json({ version: 1, items: [healthMembers.scope] }))
			.mockResolvedValueOnce(
				Response.json({
					...healthMembers,
					scope: { ...healthMembers.scope, membership_epoch: 99 },
				}),
			);
		const observe = vi.fn();
		// Act
		await createRelayHealthProbe(f.options, observe)();
		// Assert
		expect(observe.mock.calls.map(([value]) => value.outcome)).toEqual(["success", "failure"]);
	});
	it("aborts each stalled request at three seconds without retries", async () => {
		// Arrange
		vi.useFakeTimers();
		const f = healthFixture();
		f.fetcher.mockImplementation(async () => new Promise<Response>(() => {}));
		const observe = vi.fn();
		// Act
		const pending = createRelayHealthProbe(f.options, observe)();
		await vi.advanceTimersByTimeAsync(6000);
		await pending;
		// Assert
		expect(f.fetcher).toHaveBeenCalledTimes(2);
		expect(f.fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
		expect(observe.mock.calls.map(([value]) => value.outcome)).toEqual(["failure", "failure"]);
	});
	it("cancels an active cycle without starting its second endpoint", async () => {
		// Arrange
		const f = healthFixture();
		const abort = new AbortController();
		f.fetcher.mockImplementation(async () => {
			abort.abort();
			return new Promise<Response>(() => {});
		});
		const observe = vi.fn();
		// Act
		await createRelayHealthProbe(f.options, observe)(abort.signal);
		// Assert
		expect(f.fetcher).toHaveBeenCalledTimes(1);
		expect(observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure" }));
	});
});

describe("relay probe request boundaries", () => {
	it("uses a real literal-loopback HTTP fixture with verifiable enrolled-device signatures", async () => {
		// Arrange: the only real network traffic in this suite stays on loopback.
		const f = healthFixture();
		vi.spyOn(Date, "now").mockImplementation(f.now);
		const verified: boolean[] = [];
		const server = createServer((request, response) => {
			const header = (name: string) => String(request.headers[name] ?? "");
			verified.push(
				verifySignature({
					method: "GET",
					pathWithQuery: request.url ?? "",
					bodyBytes: Buffer.alloc(0),
					timestamp: header("x-opencode-timestamp"),
					nonce: header("x-opencode-nonce"),
					signature: header("x-opencode-signature"),
					publicKey: healthMembers.items[0]?.enrollment.public_key ?? "",
					deviceId: header("x-opencode-device"),
				}),
			);
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify(
					request.url?.includes("/members")
						? healthMembers
						: { version: 1, items: [healthMembers.scope] },
				),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("missing loopback fixture address");
		const observe = vi.fn();
		try {
			// Act
			await createRelayHealthProbe(
				{
					...f.options,
					coordinatorOrigin: `http://127.0.0.1:${address.port}`,
					allowLoopbackHttpFixture: true,
					fetch,
				},
				observe,
			)();
			// Assert
			expect(verified).toEqual([true, true]);
			expect(observe.mock.calls.map(([value]) => value.outcome)).toEqual(["success", "success"]);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
	it("cancels stalled response readers when their deadline expires", async () => {
		// Arrange
		vi.useFakeTimers();
		const f = healthFixture();
		const cancel = vi.fn();
		f.fetcher.mockImplementation(
			async () =>
				new Response(new ReadableStream({ cancel }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const observe = vi.fn();
		// Act
		const pending = createRelayHealthProbe(f.options, observe)();
		await vi.advanceTimersByTimeAsync(6000);
		await pending;
		// Assert
		expect(observe.mock.calls.map(([value]) => value.outcome)).toEqual(["failure", "failure"]);
		expect(cancel).toHaveBeenCalledTimes(2);
	});
	it.each([
		["wrong content type", { "content-type": "text/plain" }],
		["headers over 8 KiB", { "content-type": "application/json", "x-padding": "x".repeat(8193) }],
	] as const)("immediately cancels open bodies with %s", async (_name, headers) => {
		// Arrange: invalid 200 headers must release both streams without a deadline tick.
		vi.useFakeTimers();
		const f = healthFixture();
		const cancellations = [vi.fn(), vi.fn()];
		for (const cancel of cancellations) {
			f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers }));
		}
		const observe = vi.fn();
		// Act
		await createRelayHealthProbe(f.options, observe)();
		// Assert
		expect(f.fetcher).toHaveBeenCalledTimes(2);
		expect(observe.mock.calls.map(([value]) => [value.endpoint, value.outcome])).toEqual([
			["catalogue", "failure"],
			["members", "failure"],
		]);
		expect(vi.getTimerCount()).toBe(0);
		for (const cancel of cancellations) expect.soft(cancel).toHaveBeenCalledTimes(1);
	});
	it("does not fetch when the signer identifies a different device", async () => {
		// Arrange
		const f = healthFixture();
		f.signer.mockResolvedValue(new Headers({ "X-Opencode-Device": "other-device" }));
		const observe = vi.fn();
		// Act
		await createRelayHealthProbe(f.options, observe)();
		// Assert
		expect(f.fetcher).not.toHaveBeenCalled();
		expect(observe.mock.calls.map(([value]) => value.outcome)).toEqual(["failure", "failure"]);
	});
});

describe("relay probe origin and clock proofs", () => {
	it("captures its configured realm and probe identity before callers can mutate the options", async () => {
		// Arrange
		const f = healthFixture();
		const observe = vi.fn();
		const probe = createRelayHealthProbe(f.options, observe);
		Object.assign(f.options, {
			groupId: "other",
			probeDeviceId: "other-device",
			syntheticScopeId: "other-scope",
		});
		// Act
		await probe();
		// Assert
		expect(
			f.fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("group_id")),
		).toEqual(["group-a", "group-a"]);
		expect(observe.mock.calls.map(([value]) => value.outcome)).toEqual(["success", "success"]);
	});
	it("requires explicit opt-in even for literal loopback HTTP", () => {
		// Arrange
		const f = healthFixture();
		// Act
		const create = () =>
			createRelayHealthProbe({ ...f.options, coordinatorOrigin: "http://127.0.0.1" }, vi.fn());
		// Assert
		expect(create).toThrow("relay_health_origin_invalid");
	});
	it.each([
		"http://example.test",
		"https://user:pass@example.test",
		"https://example.test/path",
		"https://example.test/?query=1",
		"http://localhost",
	])("rejects unsafe origin %s", (coordinatorOrigin) => {
		// Arrange
		const f = healthFixture();
		// Act
		const create = () =>
			createRelayHealthProbe(
				{ ...f.options, coordinatorOrigin, allowLoopbackHttpFixture: true },
				vi.fn(),
			);
		// Assert
		expect(create).toThrow("relay_health_origin_invalid");
	});
	it.each(["http://127.0.0.1:8765", "http://[::1]:8765"])(
		"allows the explicit literal loopback fixture %s",
		(coordinatorOrigin) => {
			// Arrange
			const f = healthFixture();
			// Act
			const create = () =>
				createRelayHealthProbe(
					{ ...f.options, coordinatorOrigin, allowLoopbackHttpFixture: true },
					vi.fn(),
				);
			// Assert
			expect(create).not.toThrow();
		},
	);
	it("accepts the combined five-second clock bound", () => {
		// Arrange
		const stamp = { utcMs: 120000, verified: true, maxErrorMs: 4999, resolutionMs: 1 };
		// Act
		const result = verifiedRelayHealthTime(stamp);
		// Assert
		expect(result).toBe(120000);
	});
	it.each([
		{ verified: false },
		{ maxErrorMs: 5000 },
		{ resolutionMs: 0 },
		{ utcMs: NaN },
		{ utcMs: -1 },
		{ maxErrorMs: -1 },
	])("rejects unverifiable clock readings %j", (override) => {
		// Arrange
		const stamp = { utcMs: 120000, verified: true, maxErrorMs: 10, resolutionMs: 1, ...override };
		// Act
		const result = verifiedRelayHealthTime(stamp);
		// Assert
		expect(result).toBeNull();
	});
});
