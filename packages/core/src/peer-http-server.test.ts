import { createHash } from "node:crypto";
import dns from "node:dns";
import { Server } from "node:http";
import { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { createPeerHttpExecutor } from "./peer-http-client.js";
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
import { deferred, jsonBytes } from "./peer-http-test-fixtures.js";

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
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function observe<T>(pending: Promise<T>): Promise<T> {
	void pending.catch(() => {});
	return pending;
}
function assertReleased(f: Awaited<ReturnType<typeof pair>>) {
	expect(
		f.channels.map((channel) => [channel.disposals, channel.listeners, channel.dropped]),
	).toEqual([
		[1, 0, 0],
		[1, 0, 0],
	]);
}

it.each(["GET", "POST"] as const)(
	"dispatches exact %s bytes on an explicitly paused Noise target without network fallback",
	async (method) => {
		// Arrange
		const f = await pair();
		f.target.pause();
		const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(() => {
			throw new Error("No listening allowed");
		});
		const connect = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
			throw new Error("No TCP allowed");
		});
		const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => {
			throw new Error("No DNS allowed");
		});
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No fetch allowed"));
		const bodyBytes = Buffer.from(' \t{"raw":"héllo 🌲"}\r\n');
		const dispatch = vi.fn(async (request: PeerHttpServerRequest) => {
			expect(request.bodyBytes).not.toBe(bodyBytes);
			expect(request.bodyBytes).toEqual(bodyBytes);
			expect(Object.isFrozen(request)).toBe(true);
			expect(Object.isFrozen(request.headers)).toBe(true);
			expect(request.signal).toBeInstanceOf(AbortSignal);
			return reply();
		});
		const serving = observe(servePeerHttpConnection(f.targetOwner, { origin: ORIGIN, dispatch }));
		const execute = createPeerHttpExecutor({ factory: { open: async () => f.sourceOwner } });
		// Act
		const result = await execute(method, ORIGIN + TARGET, {
			bodyBytes,
			headers: { Authorization: "Bearer disposable-token", "X-Exact": "nonce:ABC/def==" },
		});
		await serving;
		// Assert
		expect(result).toEqual([200, { ok: true }]);
		expect(dispatch).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				method,
				target: TARGET,
				url: ORIGIN + TARGET,
				headers: expect.objectContaining({
					authorization: "Bearer disposable-token",
					"x-exact": "nonce:ABC/def==",
				}),
			}),
		);
		for (const spy of [listen, connect, lookup, fetch]) expect(spy).not.toHaveBeenCalled();
		expect(f.sourceOwner.dispose).not.toHaveBeenCalled();
		expect(f.targetOwner.dispose).not.toHaveBeenCalled();
		expect(f.errors).toEqual([]);
		assertReleased(f);
	},
);

it("accepts exact 1 MiB request and 16 MiB JSON response without extending the 60-second inner deadline", async () => {
	// Arrange
	const f = await pair();
	const bodyBytes = jsonBytes(1048576);
	const responseBytes = jsonBytes(16777216);
	const dispatch = vi.fn(async (request: PeerHttpServerRequest) => {
		expect(hash(request.bodyBytes)).toBe(hash(bodyBytes));
		return { status: 200, bodyBytes: responseBytes };
	});
	const serving = observe(servePeerHttpConnection(f.targetOwner, { origin: ORIGIN, dispatch }));
	const execute = createPeerHttpExecutor({ factory: { open: async () => f.sourceOwner } });
	// Act
	const [status, payload] = await execute("POST", ORIGIN + TARGET, { bodyBytes });
	await serving;
	// Assert
	expect(status).toBe(200);
	expect(payload?.data).toHaveLength(16777216 - Buffer.byteLength('{"data":""}'));
	expect(dispatch).toHaveBeenCalledTimes(1);
	assertReleased(f);
}, 65000);

it.each([204, 304])(
	"writes empty %i with deterministic framing and no Date header",
	async (status) => {
		// Arrange
		const f = await pair();
		const capture = captureServerWire(f.source);
		const serving = observe(
			servePeerHttpConnection(f.targetOwner, {
				origin: ORIGIN,
				dispatch: async () => ({
					status,
					headers: { "X-Exact": "ABC/def==", "Content-Length": "0" },
					bodyBytes: new Uint8Array(0),
				}),
			}),
		);
		// Act
		await writeServerRequest(f.source, requestWire());
		const wire = await capture.complete;
		f.source.end();
		await serving;
		// Assert
		const text = wire.toString("latin1");
		expect(text).toContain(`HTTP/1.1 ${status} `);
		expect(text.toLowerCase()).toContain("content-length: 0\r\n");
		expect(text.toLowerCase()).toContain("connection: close\r\n");
		expect(text).toContain("ABC/def==");
		expect(text.toLowerCase()).not.toMatch(/\r\n(date|transfer-encoding):/);
		assertReleased(f);
	},
);

it("preserves the response side after request EOF while asynchronous dispatch is pending", async () => {
	// Arrange: observe actual Noise EOF before allowing the application to respond.
	const f = await pair();
	const capture = captureServerWire(f.source);
	const entered = deferred();
	const release = deferred();
	const targetEof = deferred();
	f.target.once("end", targetEof.resolve);
	f.target.once("error", targetEof.reject);
	f.target.once("close", () => targetEof.reject(new Error("Target closed before readable EOF")));
	const dispatch = vi.fn(async () => {
		entered.resolve();
		await release.promise;
		return reply();
	});
	const serving = observe(
		servePeerHttpConnection(f.targetOwner, {
			origin: ORIGIN,
			dispatch,
			deadlineMs: performance.now() + 1000,
		}),
	);
	try {
		// Act
		await writeServerRequest(
			f.source,
			requestWire({ method: "POST", body: Buffer.from("exact raw body") }),
		);
		await entered.promise;
		f.source.end();
		await targetEof.promise;
		// Assert: request EOF must not end the writable response side.
		expect({
			readableEnded: f.target.readableEnded,
			writableEnded: f.target.writableEnded,
		}).toEqual({ readableEnded: true, writableEnded: false });
		release.resolve();
		const wire = await capture.complete;
		await serving;
		expect(wire.toString("latin1")).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
		expect(wire.subarray(wire.indexOf("\r\n\r\n") + 4)).toEqual(reply().bodyBytes);
		expect(dispatch).toHaveBeenCalledTimes(1);
		assertReleased(f);
	} finally {
		release.resolve();
		await f.close();
		await Promise.allSettled([serving]);
	}
});
