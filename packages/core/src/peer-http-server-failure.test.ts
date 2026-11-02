import { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createPeerHttpExecutor } from "./peer-http-client.js";
import { PeerHttpExchangeError } from "./peer-http-policy.js";
import {
	type PeerHttpServerRequest,
	type PeerHttpServerResponse,
	servePeerHttpConnection,
} from "./peer-http-server.js";
import {
	captureServerWire,
	ORIGIN,
	requestWire,
	serverNoisePair,
	TARGET,
	writeServerRequest,
} from "./peer-http-server-test-fixtures.js";
import { deferred } from "./peer-http-test-fixtures.js";
import { flush } from "./peer-traversal-stream-test-fixtures.js";
import { writeNoiseBytes } from "./relay-noise-test-fixtures.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
async function pair() {
	const f = await serverNoisePair();
	cleanups.push(() => f.close());
	return f;
}
const reply = (): PeerHttpServerResponse => ({
	status: 200,
	bodyBytes: Buffer.from('{"ok":true}'),
});
function observe<T>(pending: Promise<T>): Promise<T> {
	void pending.catch(() => {});
	return pending;
}
async function fixedError(pending: Promise<unknown>, code: string) {
	const error: unknown = await pending.catch((failure: unknown) => failure);
	expect(error).toBeInstanceOf(PeerHttpExchangeError);
	expect(error).toHaveProperty("code", code);
	expect(error).not.toHaveProperty("cause");
	expect(String(error)).not.toContain("private");
}
function assertReleased(f: Awaited<ReturnType<typeof pair>>) {
	expect(
		f.channels.map((channel) => [channel.disposals, channel.listeners, channel.dropped]),
	).toEqual([
		[1, 0, 0],
		[1, 0, 0],
	]);
}

const badRequests = [
	requestWire({ method: "PUT" }),
	requestWire({ method: "get" }),
	requestWire({ version: "1.0" }),
	requestWire({ headers: "Host: peer.invalid\r\n" }),
	requestWire({ headers: "Host: peer.invalid\r\nContent-Length: 0\r\ncontent-length: 0\r\n" }),
	requestWire({ headers: "Host: peer.invalid\r\nContent-Length: +0\r\n" }),
	requestWire({ headers: "Host: peer.invalid\r\nContent-Length: 0\r\nX-A: one\r\nx-a: two\r\n" }),
	requestWire({
		headers: "Host: peer.invalid\r\nTransfer-Encoding: chunked\r\n",
		body: Buffer.from("0\r\n\r\n"),
	}),
	requestWire({ headers: "Host: peer.invalid\r\nContent-Length: 0\r\nTrailer: x-a\r\n" }),
	requestWire({
		headers:
			"Host: peer.invalid\r\nContent-Length: 0\r\nUpgrade: websocket\r\nConnection: upgrade\r\n",
	}),
	requestWire({ method: "CONNECT", target: "peer.invalid:443" }),
	requestWire({ headers: "Host: other.invalid\r\nContent-Length: 0\r\n" }),
	requestWire({ headers: "Content-Length: 0\r\n" }),
	requestWire({ target: "https://peer.invalid/" }),
	requestWire({ target: "//peer.invalid/" }),
	requestWire({ target: "/a/../b" }),
	requestWire({ target: "/a/%2e%2e/b" }),
	requestWire({ target: "/a\\b" }),
	requestWire({ target: "/a#fragment" }),
	requestWire({ target: "/a\u0001b" }),
	requestWire({ headers: "Host: peer.invalid\r\nContent-Length: 1048577\r\n" }),
];
it.each(badRequests)(
	"rejects malformed request %# before dispatch and echoes no parser detail",
	async (wire) => {
		// Arrange
		const f = await pair();
		const write = vi.spyOn(f.target, "write");
		const capture = captureServerWire(f.source);
		const dispatch = vi.fn(async () => reply());
		const serving = observe(servePeerHttpConnection(f.targetOwner, { origin: ORIGIN, dispatch }));
		// Act
		await writeServerRequest(f.source, wire).catch(() => {});
		await fixedError(serving, "framing");
		// Assert
		expect(dispatch).not.toHaveBeenCalled();
		expect(capture.bytes().length).toBe(0);
		expect(write).not.toHaveBeenCalled();
		expect(f.target.destroyed).toBe(true);
		expect(f.targetOwner.dispose).toHaveBeenCalledTimes(1);
	},
);

const padding = Array.from({ length: 1001 }, (_, index) => `x${index.toString(36)}: a\r\n`).join(
	"",
);
it.each(["100-continue", "private-expectation"])(
	"rejects Expect: %s without implicit 100/417, including after 1000 headers",
	async (expectation) => {
		// Arrange
		const f = await pair();
		const write = vi.spyOn(f.target, "write");
		const capture = captureServerWire(f.source);
		const dispatch = vi.fn(async () => reply());
		const serving = observe(servePeerHttpConnection(f.targetOwner, { origin: ORIGIN, dispatch }));
		const wire = requestWire({
			headers: `Host: peer.invalid\r\nContent-Length: 0\r\n${padding}Expect: ${expectation}\r\n`,
		});
		// Act
		await writeServerRequest(f.source, wire).catch(() => {});
		await fixedError(serving, "framing");
		// Assert
		expect(wire.length).toBeLessThan(16384);
		expect(dispatch).not.toHaveBeenCalled();
		expect(capture.bytes().length).toBe(0);
		expect(write).not.toHaveBeenCalled();
	},
);

it.each(["", "Trailer: private-trailer\r\n"])(
	"preserves native visibility beyond 1000 headers: %j",
	async (suffix) => {
		// Arrange
		const f = await pair();
		const write = vi.spyOn(f.target, "write");
		const capture = captureServerWire(f.source);
		const dispatch = vi.fn(async () => reply());
		const serving = observe(servePeerHttpConnection(f.targetOwner, { origin: ORIGIN, dispatch }));
		const wire = requestWire({
			headers: `Host: peer.invalid\r\nContent-Length: 0\r\n${padding}${suffix}`,
		});
		// Act
		await writeServerRequest(f.source, wire).catch(() => {});
		if (suffix) await fixedError(serving, "framing");
		else {
			await capture.complete;
			f.source.end();
			await serving;
		}
		// Assert
		expect(wire.length).toBeLessThan(16384);
		expect(dispatch).toHaveBeenCalledTimes(suffix ? 0 : 1);
		if (suffix) expect(write).not.toHaveBeenCalled();
		if (!suffix)
			expect(dispatch).toHaveBeenCalledWith(
				expect.objectContaining({ headers: expect.objectContaining({ xrs: "a" }) }),
			);
	},
);

it.each([16384, 16385])("counts all request start-line and header bytes at %i", async (size) => {
	// Arrange
	const f = await pair();
	const capture = captureServerWire(f.source);
	const dispatch = vi.fn(async () => reply());
	const serving = observe(servePeerHttpConnection(f.targetOwner, { origin: ORIGIN, dispatch }));
	const base = requestWire({ headers: "Host: peer.invalid\r\nContent-Length: 0\r\nX-Pad: \r\n" });
	const wire = requestWire({
		headers: `Host: peer.invalid\r\nContent-Length: 0\r\nX-Pad: ${"x".repeat(size - base.length)}\r\n`,
	});
	// Act
	await writeServerRequest(f.source, wire).catch(() => {});
	if (size === 16384) {
		await capture.complete;
		f.source.end();
		await serving;
	} else await fixedError(serving, "framing");
	// Assert
	expect(wire.length).toBe(size);
	expect(dispatch).toHaveBeenCalledTimes(size === 16384 ? 1 : 0);
});

it.each(["short-body", "surplus-body", "pipeline"])(
	"rejects %s with at most one callback",
	async (kind) => {
		// Arrange
		const f = await pair();
		captureServerWire(f.source);
		const dispatch = vi.fn(async () => reply());
		const serving = observe(servePeerHttpConnection(f.targetOwner, { origin: ORIGIN, dispatch }));
		let wire = requestWire({
			headers: "Host: peer.invalid\r\nContent-Length: 3\r\n",
			body: Buffer.from("ab"),
		});
		if (kind === "surplus-body")
			wire = requestWire({
				body: Buffer.from("x"),
				headers: "Host: peer.invalid\r\nContent-Length: 0\r\n",
			});
		if (kind === "pipeline") wire = Buffer.concat([requestWire(), requestWire()]);
		// Act
		await writeServerRequest(f.source, wire).catch(() => {});
		if (kind === "short-body") f.source.end();
		await fixedError(serving, "framing");
		// Assert
		expect(dispatch.mock.calls.length).toBeLessThanOrEqual(1);
		expect(f.targetOwner.dispose).toHaveBeenCalledTimes(1);
	},
);

it("rejects late pipelining after a committed callback and written response, without claiming rollback", async () => {
	// Arrange
	const f = await pair();
	const capture = captureServerWire(f.source);
	let applied = 0;
	const dispatch = vi.fn(async () => {
		applied++;
		return reply();
	});
	const serving = observe(servePeerHttpConnection(f.targetOwner, { origin: ORIGIN, dispatch }));
	let settled = false;
	void serving.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	// Act: the application responds before source EOF, then extra bytes follow native completion.
	await writeServerRequest(f.source, requestWire());
	await capture.complete;
	expect(applied).toBe(1);
	expect(settled).toBe(false);
	await writeNoiseBytes(f.source, requestWire()).catch(() => {});
	f.source.end();
	await fixedError(serving, "framing");
	// Assert
	expect(applied).toBe(1);
	expect(dispatch).toHaveBeenCalledTimes(1);
	expect(f.target.destroyed).toBe(true);
	expect(f.targetOwner.dispose).toHaveBeenCalledTimes(1);
});

const badResponses: { name: string; value: unknown; code: string }[] = [
	{ name: "informational", value: { ...reply(), status: 100 }, code: "framing" },
	{ name: "invalid status", value: { ...reply(), status: 600 }, code: "framing" },
	{ name: "non-byte body", value: { ...reply(), bodyBytes: "private" }, code: "framing" },
	{
		name: "oversize body",
		value: { status: 200, bodyBytes: Buffer.alloc(16777217) },
		code: "response_too_large",
	},
	{
		name: "conflicting length",
		value: { ...reply(), headers: { "Content-Length": "0" } },
		code: "framing",
	},
	{
		name: "duplicate",
		value: { ...reply(), headers: { "X-A": "a", "x-a": "b" } },
		code: "framing",
	},
	{
		name: "header control",
		value: { ...reply(), headers: { "X-A": "private\r\ninjection" } },
		code: "framing",
	},
	{ name: "header name", value: { ...reply(), headers: { "X A": "private" } }, code: "framing" },
	{ name: "header value type", value: { ...reply(), headers: { "X-A": 1 } }, code: "framing" },
	{
		name: "transfer encoding",
		value: { ...reply(), headers: { "Transfer-Encoding": "chunked" } },
		code: "framing",
	},
	{ name: "trailer", value: { ...reply(), headers: { Trailer: "x-a" } }, code: "framing" },
	{ name: "upgrade", value: { ...reply(), headers: { Upgrade: "websocket" } }, code: "framing" },
	{ name: "expect", value: { ...reply(), headers: { Expect: "100-continue" } }, code: "framing" },
	{ name: "204 body", value: { ...reply(), status: 204 }, code: "framing" },
	{ name: "304 body", value: { ...reply(), status: 304 }, code: "framing" },
];
it.each(badResponses)(
	"rejects application response $name with a fixed code",
	async ({ value, code }) => {
		// Arrange
		const f = await pair();
		const write = vi.spyOn(f.target, "write");
		const capture = captureServerWire(f.source);
		const serving = observe(
			servePeerHttpConnection(f.targetOwner, {
				origin: ORIGIN,
				dispatch: async () => value as PeerHttpServerResponse,
			}),
		);
		// Act
		await writeServerRequest(f.source, requestWire());
		await fixedError(serving, code);
		// Assert
		expect(capture.bytes().length).toBe(0);
		expect(write).not.toHaveBeenCalled();
		expect(f.targetOwner.dispose).toHaveBeenCalledTimes(1);
	},
);

it.each([16384, 16385])(
	"counts exact response start-line and injected headers at %i bytes",
	async (size) => {
		// Arrange
		const f = await pair();
		const capture = captureServerWire(f.source);
		const fixed = "HTTP/1.1 200 OK\r\nX-Pad: \r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
		const dispatch = async () => ({
			status: 200,
			headers: { "X-Pad": "x".repeat(size - Buffer.byteLength(fixed)) },
			bodyBytes: Buffer.alloc(0),
		});
		const serving = observe(servePeerHttpConnection(f.targetOwner, { origin: ORIGIN, dispatch }));
		// Act
		await writeServerRequest(f.source, requestWire());
		let wire: Buffer | undefined;
		if (size === 16384) {
			wire = await capture.complete;
			f.source.end();
			await serving;
		} else await fixedError(serving, "framing");
		// Assert
		if (wire) expect(wire.length).toBe(size);
		else expect(capture.bytes().length).toBe(0);
	},
);

it("converts a private application exception to transport without echoing a payload", async () => {
	// Arrange
	const f = await pair();
	const capture = captureServerWire(f.source);
	const serving = observe(
		servePeerHttpConnection(f.targetOwner, {
			origin: ORIGIN,
			dispatch: async () => {
				throw new Error("private application error");
			},
		}),
	);
	// Act
	await writeServerRequest(f.source, requestWire());
	await fixedError(serving, "transport");
	// Assert
	expect(capture.bytes().length).toBe(0);
	expect(f.targetOwner.dispose).toHaveBeenCalledTimes(1);
});

it.each(["resolve", "reject"])(
	"waits for owned raw completion to %s after the response",
	async (outcome) => {
		// Arrange
		const f = await pair();
		const gate = deferred();
		const owner = {
			...f.targetOwner,
			completion: f.targetOwner.completion.then(() => gate.promise),
		};
		const serving = observe(
			servePeerHttpConnection(owner, { origin: ORIGIN, dispatch: async () => reply() }),
		);
		let settled = false;
		void serving.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const execute = createPeerHttpExecutor({ factory: { open: async () => f.sourceOwner } });
		// Act
		await execute("GET", ORIGIN + TARGET);
		await f.targetOwner.completion;
		await flush();
		expect(settled).toBe(false);
		if (outcome === "resolve") gate.resolve();
		else gate.reject(new Error("private completion failure"));
		// Assert
		if (outcome === "resolve") {
			await expect(serving).resolves.toBeUndefined();
			assertReleased(f);
		} else await fixedError(serving, "transport");
	},
);

it.each(["stalled-body", "late-handler"])(
	"cancels %s, destroys plaintext before disposing, and prevents a late response",
	async (stage) => {
		// Arrange
		const f = await pair();
		const capture = captureServerWire(f.source);
		const controller = new AbortController();
		const entered = deferred<PeerHttpServerRequest>();
		const release = deferred<PeerHttpServerResponse>();
		const dispatch = vi.fn(async (request: PeerHttpServerRequest) => {
			entered.resolve(request);
			return release.promise;
		});
		const dispose = vi.fn(async (error: Error) => {
			expect(f.target.destroyed).toBe(true);
			await f.targetOwner.dispose(error);
		});
		const serving = observe(
			servePeerHttpConnection(
				{ ...f.targetOwner, dispose },
				{ origin: ORIGIN, signal: controller.signal, dispatch },
			),
		);
		// Act
		if (stage === "late-handler") await writeServerRequest(f.source, requestWire());
		else
			await writeServerRequest(
				f.source,
				requestWire({
					headers: "Host: peer.invalid\r\nContent-Length: 2\r\n",
					body: Buffer.from("x"),
				}),
			);
		let request: PeerHttpServerRequest | undefined;
		if (stage === "late-handler") request = await entered.promise;
		controller.abort();
		await fixedError(serving, "cancelled");
		release.resolve(reply());
		await flush();
		// Assert
		if (request) expect(request.signal.aborted).toBe(true);
		expect(dispatch).toHaveBeenCalledTimes(stage === "late-handler" ? 1 : 0);
		expect(capture.bytes().length).toBe(0);
		expect(dispose).toHaveBeenCalledTimes(1);
	},
);

function invalidOwner(kind: "socket" | "duplex") {
	const duplex =
		kind === "socket"
			? new Socket()
			: new Duplex({
					read() {},
					write(_bytes, _encoding, done) {
						done();
					},
				});
	duplex.on("error", () => {});
	const dispose = vi.fn(async (error: Error) => {
		duplex.destroy(error);
		await finished(duplex).catch(() => {});
	});
	cleanups.push(async () => {
		duplex.destroy();
		await finished(duplex).catch(() => {});
	});
	return { duplex, completion: deferred().promise, dispose };
}

it.each(["socket", "duplex"] as const)(
	"rejects a non-Noise %s without native parser bypass",
	async (kind) => {
		// Arrange
		const owner = invalidOwner(kind);
		const dispatch = vi.fn(async () => reply());
		// Act
		await fixedError(servePeerHttpConnection(owner, { origin: ORIGIN, dispatch }), "transport");
		// Assert
		expect(dispatch).not.toHaveBeenCalled();
		expect(owner.dispose).toHaveBeenCalledTimes(1);
	},
);

it.each(["flowing", "buffered"])(
	"rejects a non-fresh %s Noise target and still owns cleanup",
	async (state) => {
		// Arrange
		const f = await pair();
		if (state === "flowing") f.target.resume();
		else f.target.push(Buffer.from("private buffered bytes"));
		const dispatch = vi.fn(async () => reply());
		// Act
		await fixedError(
			servePeerHttpConnection(f.targetOwner, { origin: ORIGIN, dispatch }),
			"transport",
		);
		// Assert
		expect(dispatch).not.toHaveBeenCalled();
		expect(f.targetOwner.dispose).toHaveBeenCalledTimes(1);
	},
);

it("expires a stalled incomplete request at an earlier caller deadline", async () => {
	// Arrange: the test awaits the adapter's deadline, with no fixed sleep or fake Noise timers.
	const f = await pair();
	const dispatch = vi.fn(async () => reply());
	const serving = observe(
		servePeerHttpConnection(f.targetOwner, {
			origin: ORIGIN,
			dispatch,
			deadlineMs: performance.now() + 100,
		}),
	);
	// Act
	await fixedError(serving, "deadline");
	// Assert
	expect(dispatch).not.toHaveBeenCalled();
	expect(f.target.destroyed).toBe(true);
	expect(f.targetOwner.dispose).toHaveBeenCalledTimes(1);
});

it.each([undefined, 120000])(
	"never extends the fixed 60-second deadline for caller duration %s",
	async (duration) => {
		// Arrange
		const f = await pair();
		const controller = new AbortController();
		const timer = vi.spyOn(globalThis, "setTimeout");
		const dispatch = vi.fn(async () => reply());
		// Act
		const serving = observe(
			servePeerHttpConnection(f.targetOwner, {
				origin: ORIGIN,
				dispatch,
				signal: controller.signal,
				deadlineMs: duration === undefined ? undefined : performance.now() + duration,
			}),
		);
		await flush();
		const delays = timer.mock.calls.map((call) => call[1]);
		controller.abort();
		await fixedError(serving, "cancelled");
		// Assert
		expect(
			delays.some((delay) => typeof delay === "number" && delay > 59000 && delay <= 60000),
		).toBe(true);
		expect(delays.every((delay) => typeof delay === "number" && delay <= 60000)).toBe(true);
		expect(dispatch).not.toHaveBeenCalled();
		expect(f.targetOwner.dispose).toHaveBeenCalledTimes(1);
	},
);

it.each(["thenable", "getter"])(
	"retains captured disposal for invalid completion %s",
	async (kind) => {
		// Arrange
		const owner = invalidOwner("duplex");
		Object.defineProperty(owner, "completion", {
			get: () => {
				if (kind === "getter") throw new Error("private getter");
				const then = () => {};
				return { then };
			},
		});
		// Act
		await fixedError(
			servePeerHttpConnection(owner, { origin: ORIGIN, dispatch: async () => reply() }),
			"transport",
		);
		// Assert
		expect(owner.dispose).toHaveBeenCalledTimes(1);
	},
);

it.each([
	"https://user:pass@peer.invalid",
	"https://peer.invalid/path",
	"https://peer.invalid/?q=1",
	"https://peer.invalid/#f",
	"file:///",
	"not an origin",
])("owns and disposes even with invalid origin %s", async (origin) => {
	// Arrange
	const f = await pair();
	const dispatch = vi.fn(async () => reply());
	// Act
	await fixedError(servePeerHttpConnection(f.targetOwner, { origin, dispatch }), "framing");
	// Assert
	expect(dispatch).not.toHaveBeenCalled();
	expect(f.targetOwner.dispose).toHaveBeenCalledTimes(1);
});

it.each(["expired", "aborted", "invalid-dispatch"] as const)(
	"transfers ownership for %s options",
	async (kind) => {
		// Arrange
		const f = await pair();
		const controller = new AbortController();
		if (kind === "aborted") controller.abort();
		const dispatch = vi.fn(async () => reply());
		const options = {
			origin: ORIGIN,
			dispatch,
			signal: controller.signal,
			deadlineMs: kind === "expired" ? performance.now() - 1 : undefined,
		};
		if (kind === "invalid-dispatch") Object.defineProperty(options, "dispatch", { value: null });
		// Act
		const codes = { expired: "deadline", aborted: "cancelled", "invalid-dispatch": "framing" };
		await fixedError(servePeerHttpConnection(f.targetOwner, options), codes[kind]);
		// Assert
		expect(dispatch).not.toHaveBeenCalled();
		expect(f.targetOwner.dispose).toHaveBeenCalledTimes(1);
	},
);

it.each(["reject", "hang"])("bounds cleanup %s at 1500 ms and disposes only once", async (mode) => {
	// Arrange: no live Noise pair runs under fake timers.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const owner = invalidOwner("duplex");
	const gate = deferred();
	owner.dispose.mockImplementation(async (error: Error) => {
		owner.duplex.destroy(error);
		if (mode === "reject") throw new Error("private disposal error");
		await gate.promise;
	});
	const serving = observe(
		servePeerHttpConnection(owner, { origin: ORIGIN, dispatch: async () => reply() }),
	);
	// Act
	await vi.advanceTimersByTimeAsync(1500);
	// Assert: failed cleanup overrides the initial transport failure.
	await fixedError(serving, "cleanup");
	expect(owner.dispose).toHaveBeenCalledTimes(1);
	expect(owner.duplex.destroyed).toBe(true);
	expect(vi.getTimerCount()).toBe(0);
	gate.resolve();
});
