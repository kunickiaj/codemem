import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPeerHttpExecutor,
	type OwnedPeerHttpConnection,
	type PeerHttpConnectionFactory,
} from "./peer-http-client.js";
import { PeerHttpExchangeError } from "./peer-http-policy.js";
import { deferred, jsonBytes, type PeerReply, peerHttpFactory } from "./peer-http-test-fixtures.js";
import type { RequestJsonOptions } from "./sync-http-client.js";

const URL = "https://peer.invalid/a%2fb?z=2&x=%2f&z=1";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
function fixture(reply?: PeerReply, gate?: Promise<void>) {
	const f = peerHttpFactory(reply, gate);
	cleanups.push(() => f.close());
	return { ...f, execute: createPeerHttpExecutor({ factory: f.factory }) };
}
function clock() {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const now = vi.spyOn(performance, "now").mockReturnValue(1000);
	return {
		now,
		async advance(ms: number) {
			now.mockReturnValue(1000 + ms);
			await vi.advanceTimersByTimeAsync(ms);
		},
	};
}
async function errorCode(pending: Promise<unknown>, code: string) {
	const error: unknown = await pending.catch((failure: unknown) => failure);
	expect(error).toBeInstanceOf(PeerHttpExchangeError);
	expect(error).toHaveProperty("code", code);
	expect(error).not.toHaveProperty("cause");
	expect(String(error)).not.toContain("private");
}
function fakeOwner(native = false) {
	const duplex = native
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
	const connection: OwnedPeerHttpConnection = { duplex, completion: deferred().promise, dispose };
	cleanups.push(async () => {
		duplex.destroy();
		await finished(duplex).catch(() => {});
	});
	return { connection, dispose };
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("peer HTTP owned requests and clean responses", () => {
	it.each(["GET", "POST"])(
		"preserves %s, exact target and auth values on a fresh connection for every call",
		async (method) => {
			const f = fixture();
			const bodyBytes = Buffer.from(' \t{"value":"héllo 🌲"}\r\n');
			const options = {
				bodyBytes,
				headers: { Authorization: "Bearer disposable-token", "X-Exact": "nonce:ABC/def==" },
				get body(): never {
					throw new Error("Body must not be read");
				},
			};

			const results = await Promise.all([
				f.execute(method, URL, options),
				f.execute(method, URL, options),
			]);
			const requests = await Promise.all(f.exchanges.map((item) => item.request));

			expect(results).toEqual([
				[200, { ok: true }],
				[200, { ok: true }],
			]);
			expect(f.factory.open).toHaveBeenCalledTimes(2);
			expect(f.exchanges[0]?.source).not.toBe(f.exchanges[1]?.source);
			for (const wire of requests) {
				const boundary = wire.indexOf("\r\n\r\n");
				expect(wire.subarray(0, boundary).toString()).toContain(
					`${method} /a%2fb?z=2&x=%2f&z=1 HTTP/1.1\r\n`,
				);
				expect(wire.toString()).toContain("authorization: Bearer disposable-token\r\n");
				expect(wire.toString()).toContain("x-exact: nonce:ABC/def==\r\n");
				expect(wire.subarray(boundary + 4)).toEqual(bodyBytes);
			}
			for (const item of f.exchanges) {
				expect(item.errors).toEqual([]);
				expect(item.connection.dispose).not.toHaveBeenCalled();
				expect(item.channels.map((c) => [c.disposals, c.dropped, c.listeners])).toEqual([
					[1, 0, 0],
					[1, 0, 0],
				]);
			}
		},
	);

	it("sends Content-Length zero for an empty request and accepts an empty response with cap zero", async () => {
		const f = fixture({ body: Buffer.alloc(0), status: 204 });

		const result = await f.execute("GET", URL, { maxResponseBytes: 0 });
		const wire = await f.exchanges[0]?.request;

		expect(result).toEqual([204, null]);
		expect(wire?.toString()).toContain("content-length: 0\r\n");
	});
});

describe("peer HTTP body boundaries and captured inputs", () => {
	it.each([2 * 1024 * 1024, 16 * 1024 * 1024])(
		"accepts an exact %i-byte JSON response through real Noise/traversal",
		async (size) => {
			const f = fixture({ body: jsonBytes(size) });

			const [status, payload] = await f.execute("GET", URL);

			expect(status).toBe(200);
			const data = payload?.data;
			if (typeof data !== "string") throw new Error("Fixture response data must be a string");
			expect(typeof data).toBe("string");
			expect(data.length).toBe(size - Buffer.byteLength('{"data":""}'));
			expect(f.exchanges[0]?.errors).toEqual([]);
			expect(f.exchanges[0]?.channels.map((c) => [c.disposals, c.dropped, c.listeners])).toEqual([
				[1, 0, 0],
				[1, 0, 0],
			]);
		},
		65000,
	);

	it("transmits an exact 1 MiB POST without reserialization", async () => {
		const f = fixture();
		const bodyBytes = jsonBytes(1048576);

		const result = await f.execute("POST", URL, { bodyBytes });
		const wire = await f.exchanges[0]?.request;
		if (!wire) throw new Error("Missing captured request");
		const body = wire.subarray(wire.indexOf("\r\n\r\n") + 4);

		expect(result).toEqual([200, { ok: true }]);
		expect(body.length).toBe(1048576);
		expect(digest(body)).toBe(digest(bodyBytes));
		expect(f.exchanges[0]?.channels.map((c) => [c.disposals, c.dropped, c.listeners])).toEqual([
			[1, 0, 0],
			[1, 0, 0],
		]);
	}, 65000);

	it.each([
		[Buffer.from("private text"), "non_json_response"],
		[Buffer.from([0xff]), "non_json_response"],
		[Buffer.from("[]"), "unexpected_json_type"],
		[Buffer.from("42"), "unexpected_json_type"],
		[Buffer.from("null"), "unexpected_json_type"],
	] as const)("returns a fixed record for non-object JSON %#", async (body, error) => {
		const f = fixture({ body });

		const result = await f.execute("GET", URL);

		expect(result).toEqual([200, { error }]);
	});

	it("captures headers and owned body before a paused factory resolves", async () => {
		const f = fixture();
		const entered = deferred();
		const release = deferred();
		const factory: PeerHttpConnectionFactory = {
			open: async (options) => {
				entered.resolve();
				await release.promise;
				return f.factory.open(options);
			},
		};
		const execute = createPeerHttpExecutor({ factory });
		const bodyBytes = Buffer.from('{"old":true}');
		const original = Buffer.from(bodyBytes);
		const options = { bodyBytes, headers: { Authorization: "old" } };

		const pending = execute("POST", URL, options);
		await entered.promise;
		bodyBytes.fill(120);
		options.headers.Authorization = "new";
		Object.assign(options, {
			bodyBytes: Buffer.from("new"),
			headers: { Authorization: "replacement" },
		});
		release.resolve();
		await pending;
		const wire = await f.exchanges[0]?.request;

		expect(wire?.toString()).toContain("authorization: old\r\n");
		expect(wire?.subarray(wire.indexOf("\r\n\r\n") + 4)).toEqual(original);
	});
});

describe("peer HTTP rejects unsent requests", () => {
	const invalidRequests: {
		name: string;
		method: string;
		url: string;
		options?: RequestJsonOptions;
	}[] = [
		{ name: "method", method: "PUT", url: URL },
		{ name: "normalized target", method: "GET", url: "https://peer.invalid/a/../b" },
		{ name: "large body", method: "POST", url: URL, options: { bodyBytes: Buffer.alloc(1048577) } },
		{
			name: "duplicate header",
			method: "GET",
			url: URL,
			options: { headers: { Authorization: "a", authorization: "b" } },
		},
	];
	it.each(invalidRequests)("rejects $name before opening", async ({ method, url, options }) => {
		const factory = { open: vi.fn() };
		const execute = createPeerHttpExecutor({ factory });

		await errorCode(execute(method, url, options), "framing");

		expect(factory.open).not.toHaveBeenCalled();
	});
});

describe("peer HTTP paused input and complete native header visibility", () => {
	it("completes a valid response on an explicitly paused fresh Noise duplex", async () => {
		const f = fixture();
		const factory: PeerHttpConnectionFactory = {
			open: async (options) => {
				const connection = await f.factory.open(options);
				connection.duplex.pause();
				expect(connection.duplex.readableFlowing).toBe(false);
				expect(connection.duplex.readableLength).toBe(0);
				expect(connection.duplex.writableLength).toBe(0);
				return connection;
			},
		};
		const execute = createPeerHttpExecutor({ factory });

		const result = await execute("GET", URL, { timeoutS: 0.1 });
		const item = await f.opened;

		expect(result).toEqual([200, { ok: true }]);
		expect(f.factory.open).toHaveBeenCalledTimes(1);
		expect(item.errors).toEqual([]);
		expect(item.channels.map((c) => [c.disposals, c.dropped, c.listeners])).toEqual([
			[1, 0, 0],
			[1, 0, 0],
		]);
	});

	it.each(["Trailer", "Expect"])(
		"rejects forbidden %s beyond the native default header count",
		async (name) => {
			const padding = Array.from(
				{ length: 1000 },
				(_, index) => `x${index.toString(36)}: a\r\n`,
			).join("");
			const head = `HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n${padding}${name}: forbidden\r\n\r\n`;
			expect(Buffer.byteLength(head, "latin1")).toBeLessThan(16384);
			const f = fixture({ head, body: Buffer.from("{}") });

			await errorCode(f.execute("GET", URL), "framing");

			expect(f.exchanges[0]?.connection.dispose).toHaveBeenCalledTimes(1);
			expect(f.exchanges[0]?.channels.map((c) => [c.disposals, c.listeners])).toEqual([
				[1, 0],
				[1, 0],
			]);
		},
	);

	it("accepts more than 1000 legitimate unique headers within the byte limit", async () => {
		const padding = Array.from(
			{ length: 1000 },
			(_, index) => `x${index.toString(36)}: a\r\n`,
		).join("");
		const head = `HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n${padding}\r\n`;
		expect(Buffer.byteLength(head, "latin1")).toBeLessThan(16384);
		const f = fixture({ head, body: Buffer.from("{}") });

		const result = await f.execute("GET", URL);

		expect(result).toEqual([200, {}]);
		expect(f.exchanges[0]?.errors).toEqual([]);
		expect(f.exchanges[0]?.channels.map((c) => [c.disposals, c.dropped, c.listeners])).toEqual([
			[1, 0, 0],
			[1, 0, 0],
		]);
	});
});

describe("peer HTTP response framing and one-shot failures", () => {
	it.each([
		"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n",
		"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n",
		"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
		...(["Trailer", "Upgrade", "Expect"] as const).map(
			(name) => `HTTP/1.1 200 OK\r\nContent-Length: 2\r\n${name}: forbidden\r\n\r\n`,
		),
		"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n",
		"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n",
		"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
	])("rejects unsupported native response framing %# without POST retry", async (head) => {
		const f = fixture({ head, body: Buffer.from("{}") });

		await expect(f.execute("POST", URL, { bodyBytes: Buffer.from("{}") })).rejects.toBeInstanceOf(
			PeerHttpExchangeError,
		);

		expect(f.factory.open).toHaveBeenCalledTimes(1);
		expect(f.exchanges[0]?.connection.dispose).toHaveBeenCalledTimes(1);
		expect(f.exchanges[0]?.channels.map((c) => [c.disposals, c.listeners])).toEqual([
			[1, 0],
			[1, 0],
		]);
	});
	it("accepts one decimal Content-Length with leading zeros", async () => {
		const f = fixture({
			head: "HTTP/1.1 200 OK\r\nContent-Length: 0002\r\nConnection: close\r\n\r\n",
			body: Buffer.from("{}"),
		});

		const result = await f.execute("GET", URL);

		expect(result).toEqual([200, {}]);
	});
	it.each([
		[16777217, undefined],
		[3, 2],
		[1, 0],
	] as const)(
		"classifies declared length %i above cap %s before byte auditing",
		async (length, maxResponseBytes) => {
			const f = fixture({
				head: `HTTP/1.1 200 OK\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n`,
				body: Buffer.alloc(0),
			});

			await errorCode(f.execute("GET", URL, { maxResponseBytes }), "response_too_large");

			expect(f.exchanges[0]?.connection.dispose).toHaveBeenCalledTimes(1);
		},
	);
	it.each([
		["X", false],
		["X", true],
		["HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}", false],
		["HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}", true],
	] as const)(
		"rejects surplus %# through plaintext EOF and preserves first framing code",
		async (extra, late) => {
			const f = fixture({ body: Buffer.from("{}"), extra: Buffer.from(extra), late });

			await errorCode(f.execute("GET", URL), "framing");

			expect(f.exchanges[0]?.connection.dispose).toHaveBeenCalledTimes(1);
			expect(f.exchanges[0]?.channels.map((c) => [c.disposals, c.listeners])).toEqual([
				[1, 0],
				[1, 0],
			]);
		},
	);
	it("rejects surplus after a JSON body sent through the large-response chunk loop", async () => {
		const f = fixture({ body: jsonBytes(65536), extra: Buffer.from("X") });

		await errorCode(f.execute("GET", URL), "framing");

		expect(f.exchanges[0]?.connection.dispose).toHaveBeenCalledTimes(1);
		expect(f.exchanges[0]?.channels.map((c) => [c.disposals, c.listeners])).toEqual([
			[1, 0],
			[1, 0],
		]);
	});
	it("rejects truncated response bytes instead of returning parser progress", async () => {
		const f = fixture({
			head: "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\n",
			body: Buffer.from("{}"),
			truncate: true,
		});

		await expect(f.execute("GET", URL)).rejects.toBeInstanceOf(PeerHttpExchangeError);

		expect(f.exchanges[0]?.connection.dispose).toHaveBeenCalledTimes(1);
	});
});

describe("peer HTTP validates completion evidence before sending", () => {
	it.each(["missing", "undefined", "true", "object", "thenable"] as const)(
		"rejects %s completion without sending and retains its captured disposer",
		async (kind) => {
			const f = fixture();
			let sentBeforeAdoption = -1;
			const then = vi.fn((resolve: () => void) => resolve());
			const readThen = vi.fn(() => then);
			const fakeThenable = new Proxy(
				{},
				{
					get(_target, property) {
						if (property === "then") return readThen();
						return undefined;
					},
				},
			);
			const invalid = { undefined: undefined, true: true, object: {}, thenable: fakeThenable };
			const factory: PeerHttpConnectionFactory = {
				open: async (options) => {
					const connection = await f.factory.open(options);
					const item = await f.opened;
					sentBeforeAdoption = item.channels[0].sent.length;
					if (kind === "missing") Reflect.deleteProperty(connection, "completion");
					else Reflect.set(connection, "completion", invalid[kind]);
					return connection;
				},
			};
			const execute = createPeerHttpExecutor({ factory });

			await errorCode(execute("GET", URL), "transport");
			const item = await f.opened;
			const request = await Promise.allSettled([item.request]);

			expect(item.connection.dispose).toHaveBeenCalledTimes(1);
			expect(item.channels[0].sent.length).toBe(sentBeforeAdoption);
			expect(request[0]?.status).toBe("rejected");
			expect(readThen).not.toHaveBeenCalled();
			expect(then).not.toHaveBeenCalled();
			expect(item.channels.map((c) => [c.disposals, c.listeners])).toEqual([
				[1, 0],
				[1, 0],
			]);
		},
	);

	it.each(["completion", "duplex"] as const)(
		"cleans up when the captured port's %s getter throws",
		async (field) => {
			const f = fixture();
			const factory: PeerHttpConnectionFactory = {
				open: async (options) => {
					const connection = await f.factory.open(options);
					Object.defineProperty(connection, field, {
						get() {
							throw new Error(`private ${field} access`);
						},
					});
					return connection;
				},
			};
			const execute = createPeerHttpExecutor({ factory });

			await errorCode(execute("GET", URL), "transport");
			const item = await f.opened;

			expect(item.connection.dispose).toHaveBeenCalledTimes(1);
			expect(item.channels.map((c) => [c.disposals, c.listeners])).toEqual([
				[1, 0],
				[1, 0],
			]);
		},
	);

	it("accepts a genuine cross-realm Promise of clean raw completion", async () => {
		const f = fixture();
		const factory: PeerHttpConnectionFactory = {
			open: async (options) => {
				const connection = await f.factory.open(options);
				const completion: unknown = runInNewContext("Promise.resolve(value)", {
					value: connection.completion,
				});
				Reflect.set(connection, "completion", completion);
				return connection;
			},
		};
		const execute = createPeerHttpExecutor({ factory });

		const result = await execute("GET", URL);
		const item = await f.opened;

		expect(result).toEqual([200, { ok: true }]);
		expect(item.connection.dispose).not.toHaveBeenCalled();
		expect(item.errors).toEqual([]);
		expect(item.channels.map((c) => [c.disposals, c.dropped, c.listeners])).toEqual([
			[1, 0, 0],
			[1, 0, 0],
		]);
	});
});

describe("peer HTTP invalid adoption cleanup is awaited", () => {
	it.each(["reject", "hang"] as const)(
		"classifies %s disposal after invalid adoption as cleanup",
		async (mode) => {
			const time = clock();
			const owner = fakeOwner();
			Reflect.deleteProperty(owner.connection, "completion");
			const disposing = deferred();
			owner.dispose.mockImplementation(async () => {
				disposing.resolve();
				if (mode === "reject") throw new Error("private invalid adoption cleanup failure");
				await deferred().promise;
			});
			const execute = createPeerHttpExecutor({ factory: { open: async () => owner.connection } });

			const checked = errorCode(execute("GET", URL), "cleanup");
			await disposing.promise;
			if (mode === "hang") await time.advance(1500);
			await checked;

			expect(owner.dispose).toHaveBeenCalledTimes(1);
		},
	);
});

describe("peer HTTP owned completion and cleanup", () => {
	it.each(["resolve", "reject"] as const)(
		"waits past HTTP end for owned completion to %s",
		async (outcome) => {
			const gate = deferred();
			const f = fixture(undefined, gate.promise);
			let settled = false;
			const pending = f.execute("GET", URL);
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			const item = await f.opened;

			await item.io;
			expect(settled).toBe(false);
			if (outcome === "resolve") gate.resolve();
			else gate.reject(new Error("private completion failure"));

			if (outcome === "resolve") {
				expect(await pending).toEqual([200, { ok: true }]);
				expect(item.connection.dispose).not.toHaveBeenCalled();
			} else {
				await errorCode(pending, "transport");
				expect(item.connection.dispose).toHaveBeenCalledTimes(1);
			}
		},
	);
	it.each([false, true])(
		"rejects a non-Noise owned duplex, native socket=%s, and disposes once",
		async (native) => {
			const owner = fakeOwner(native);
			const factory = { open: vi.fn(async () => owner.connection) };
			const execute = createPeerHttpExecutor({ factory });

			await errorCode(execute("GET", URL), "transport");

			expect(owner.dispose).toHaveBeenCalledTimes(1);
		},
	);
	it.each(["reject", "hang"] as const)(
		"classifies %s disposal as cleanup failure within its grace",
		async (mode) => {
			const time = clock();
			const owner = fakeOwner();
			const disposing = deferred();
			owner.dispose.mockImplementation(async () => {
				disposing.resolve();
				if (mode === "reject") throw new Error("private cleanup failure");
				await deferred().promise;
			});
			const execute = createPeerHttpExecutor({ factory: { open: async () => owner.connection } });
			const pending = execute("GET", URL);
			const checked = errorCode(pending, "cleanup");

			await disposing.promise;
			if (mode === "hang") await time.advance(1500);
			await checked;

			expect(owner.dispose).toHaveBeenCalledTimes(1);
		},
	);
});

describe("peer HTTP deadlines and cancellation", () => {
	it.each(["cancelled", "deadline"] as const)("rejects already %s before opening", async (code) => {
		clock();
		const controller = new AbortController();
		if (code === "cancelled") controller.abort(new Error("private abort reason"));
		const factory = { open: vi.fn() };
		const execute = createPeerHttpExecutor({
			factory,
			signal: controller.signal,
			deadlineMs: code === "deadline" ? 999 : 61000,
		});

		await errorCode(execute("GET", URL), code);

		expect(factory.open).not.toHaveBeenCalled();
	});
	it.each([
		[undefined, undefined, 60000],
		[0.02, undefined, 20],
		[0.02, 1010, 10],
	] as const)(
		"bounds unresolved factory open for timeout %s and absolute deadline %s",
		async (timeoutS, deadlineMs, elapsed) => {
			const time = clock();
			const open = vi.fn(() => deferred<OwnedPeerHttpConnection>().promise);
			const execute = createPeerHttpExecutor({ factory: { open }, deadlineMs });
			const pending = execute("GET", URL, { timeoutS });
			const checked = errorCode(pending, "deadline");

			await time.advance(elapsed);
			await checked;

			expect(open).toHaveBeenCalledTimes(1);
			expect(open).toHaveBeenCalledWith({
				signal: expect.any(AbortSignal),
				deadlineMs: 1000 + elapsed,
			});
		},
	);
	it.each(
		(["cancelled", "deadline"] as const).flatMap((code) =>
			(["promise", "missing", "thenable"] as const).map((completion) => ({ code, completion })),
		),
	)(
		"disposes a late factory connection exactly once after $code with $completion completion",
		async ({ code, completion }) => {
			const time = clock();
			const controller = new AbortController();
			const gate = deferred<OwnedPeerHttpConnection>();
			const owner = fakeOwner();
			const then = vi.fn((resolve: () => void) => resolve());
			if (completion === "missing") Reflect.deleteProperty(owner.connection, "completion");
			if (completion === "thenable") Reflect.set(owner.connection, "completion", { then });
			const disposed = deferred();
			const original = owner.dispose.getMockImplementation();
			owner.dispose.mockImplementation(async (error) => {
				await original?.(error);
				disposed.resolve();
			});
			const open = vi.fn(() => gate.promise);
			const execute = createPeerHttpExecutor({ factory: { open }, signal: controller.signal });
			const checked = errorCode(
				execute("POST", URL, { bodyBytes: Buffer.from("{}"), timeoutS: 0.01 }),
				code,
			);

			if (code === "cancelled") controller.abort(new Error("private cancellation reason"));
			else await time.advance(10);
			await checked;
			gate.resolve(owner.connection);
			await disposed.promise;

			expect(open).toHaveBeenCalledTimes(1);
			expect(owner.dispose).toHaveBeenCalledTimes(1);
			expect(then).not.toHaveBeenCalled();
		},
	);
	it("normalizes a rejected factory without leaking its error or retrying", async () => {
		const open = vi.fn().mockRejectedValue(new Error("private factory failure"));
		const execute = createPeerHttpExecutor({ factory: { open } });

		await errorCode(execute("POST", URL, { bodyBytes: Buffer.from("{}") }), "transport");

		expect(open).toHaveBeenCalledTimes(1);
	});
	it("checks the same deadline after synchronous JSON decoding", async () => {
		const time = clock();
		const gate = deferred();
		const f = fixture(undefined, gate.promise);
		const pending = f.execute("GET", URL, { timeoutS: 0.1 });
		const checked = errorCode(pending, "deadline");
		const item = await f.opened;
		await item.io;
		const parse = JSON.parse;
		vi.spyOn(JSON, "parse").mockImplementationOnce((text: string) => {
			time.now.mockReturnValue(1100);
			return parse(text);
		});

		gate.resolve();
		await checked;

		expect(item.connection.dispose).toHaveBeenCalledTimes(1);
	});
});
