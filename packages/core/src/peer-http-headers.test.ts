import { describe, expect, it } from "vitest";
import {
	peerHttpBodyCap,
	preparePeerHttpRequest,
	readPeerHttpBodyLength,
} from "./peer-http-headers.js";
import { PeerHttpExchangeError } from "./peer-http-policy.js";
import type { RequestJsonOptions } from "./sync-http-client.js";

const URL = "https://peer.invalid/a%2fb?z=2&x=%2f&z=1";
function expectError(action: () => unknown, code = "framing") {
	let failure: unknown;
	try {
		action();
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(PeerHttpExchangeError);
	expect(failure).toHaveProperty("code", code);
	expect(failure).not.toHaveProperty("cause");
	expect(String(failure)).not.toContain("private");
}

describe("peer HTTP request metadata", () => {
	it.each(["GET", "POST"])(
		"owns exact %s raw bytes and metadata without reading a JSON body",
		(method) => {
			const bodyBytes = Buffer.from(' \t{"value":"héllo 🌲"}\r\n');
			const original = Buffer.from(bodyBytes);
			const headers = { Authorization: "Bearer disposable-token", "X-Exact": "nonce:ABC/def==" };
			const options = {
				headers,
				bodyBytes,
				timeoutS: 0.2,
				maxResponseBytes: 0,
				get body(): never {
					throw new Error("private JSON must not be read");
				},
			};

			const prepared = preparePeerHttpRequest(method, URL, options);
			bodyBytes.fill(120);
			headers.Authorization = "changed";

			expect(prepared).toMatchObject({
				method,
				path: "/a%2fb?z=2&x=%2f&z=1",
				host: "peer.invalid",
				hostname: "peer.invalid",
				body: original,
				lifetimeMs: 200,
				maxResponseBytes: 0,
			});
			expect(prepared.headers).toMatchObject({
				authorization: "Bearer disposable-token",
				"x-exact": "nonce:ABC/def==",
				"content-length": String(original.length),
			});
		},
	);
	it("prepares an empty request with default caps and Content-Length zero", () => {
		const prepared = preparePeerHttpRequest("GET", "http://peer.invalid", {});

		expect(prepared).toMatchObject({
			path: "/",
			body: Buffer.alloc(0),
			lifetimeMs: 60000,
			maxResponseBytes: 16777216,
		});
		expect(prepared.headers).toMatchObject({
			host: "peer.invalid",
			connection: "close",
			"content-length": "0",
		});
	});
	it.each(["PUT", "DELETE", "HEAD", "get"])("rejects method %s", (method) => {
		const prepare = () => preparePeerHttpRequest(method, URL, {});

		expectError(prepare);
	});
	it.each([
		"ftp://peer.invalid/",
		"https://user:pass@peer.invalid/",
		"https://peer.invalid/a#x",
		"https://peer.invalid/a\\b",
		"https://peer.invalid/a\nb",
		"https://peer.invalid/a/../b",
		"https://peer.invalid/%2e%2e/b",
		"https://peer.invalid/é",
	])("rejects unsafe or normalized URL %s", (url) => {
		const prepare = () => preparePeerHttpRequest("GET", url, {});

		expectError(prepare);
	});
	const invalidOptions: RequestJsonOptions[] = [
		{ body: { value: "must not serialize" } },
		{ bodyBytes: Buffer.alloc(1048577) },
		{ headers: { Authorization: "a", authorization: "b" } },
		{ headers: { "Transfer-Encoding": "chunked" } },
		{ headers: { Trailer: "X-Trailer" } },
		{ headers: { Upgrade: "websocket" } },
		{ headers: { Expect: "100-continue" } },
		{ headers: { "Content-Length": "1" } },
		{ headers: { Host: "other.invalid" } },
		{ timeoutS: 0 },
		{ timeoutS: 61 },
		{ maxResponseBytes: -1 },
		{ maxResponseBytes: 16777217 },
	];
	it.each(invalidOptions)("rejects invalid request options %#", (options) => {
		const prepare = () => preparePeerHttpRequest("POST", URL, options);

		expectError(prepare);
	});
	it.each([16384, 16385])("bounds complete outgoing header wire at %i bytes", (size) => {
		const base =
			"GET / HTTP/1.1\r\nx-pad: \r\nhost: peer.invalid\r\nconnection: close\r\ncontent-length: 0\r\naccept: application/json\r\n\r\n";
		const headers = { "X-Pad": "x".repeat(size - Buffer.byteLength(base, "latin1")) };
		const prepare = () => preparePeerHttpRequest("GET", "http://peer.invalid/", { headers });

		if (size === 16385) {
			expectError(prepare);
			return;
		}
		const prepared = prepare();
		const wire = `GET ${prepared.path} HTTP/1.1\r\n${Object.entries(prepared.headers)
			.map(([name, value]) => `${name}: ${value}\r\n`)
			.join("")}\r\n`;
		expect(Buffer.byteLength(wire, "latin1")).toBe(size);
	});
});

describe("peer HTTP declared body policy", () => {
	it.each([
		["request", 1048576],
		["response", 16777216],
	] as const)("accepts default, zero, lowered and exact %s caps", (direction, maximum) => {
		const caps = [undefined, 0, 2, maximum];

		const results = caps.map((cap) => peerHttpBodyCap(direction, cap));

		expect(results).toEqual([maximum, 0, 2, maximum]);
	});
	it.each([
		["request", 1048576],
		["response", 16777216],
	] as const)("rejects invalid %s cap values", (direction, maximum) => {
		const invalid = [-1, 1.5, NaN, Infinity, maximum + 1];

		for (const cap of invalid) expectError(() => peerHttpBodyCap(direction, cap));
	});
	it.each(["request", "response"] as const)(
		"accepts one decimal %s Content-Length including leading zeros",
		(direction) => {
			const declared = ["0", "0002", "2"];

			const lengths = declared.map((value) =>
				readPeerHttpBodyLength(["Content-Length", value], { direction }),
			);

			expect(lengths).toEqual([0, 2, 2]);
		},
	);
	it.each(["request", "response"] as const)(
		"enforces exact %s body cap and classifies oversized declarations",
		(direction) => {
			const maximum = peerHttpBodyCap(direction);
			const code = direction === "response" ? "response_too_large" : "framing";

			const exact = readPeerHttpBodyLength(["Content-Length", String(maximum)], { direction });

			expect(exact).toBe(maximum);
			expect(readPeerHttpBodyLength(["Content-Length", "0"], { direction, maxBodyBytes: 0 })).toBe(
				0,
			);
			expectError(
				() => readPeerHttpBodyLength(["Content-Length", String(maximum + 1)], { direction }),
				code,
			);
			expectError(
				() => readPeerHttpBodyLength(["Content-Length", "3"], { direction, maxBodyBytes: 2 }),
				code,
			);
		},
	);
	const invalidHeaders = [
		[],
		["Content-Length"],
		["Content-Length", "2", "content-length", "2"],
		["Content-Length", "2", "X-Value", "a", "x-value", "b"],
		...["Transfer-Encoding", "Trailer", "Upgrade", "Expect"].map((name) => [
			"Content-Length",
			"2",
			name,
			"private forbidden value",
		]),
		...["", "+2", "-1", "2.0", "2e0", " 2", "2 ", "private"].map((value) => [
			"Content-Length",
			value,
		]),
	];
	it.each(invalidHeaders.map((headers) => ({ headers })))(
		"rejects malformed or forbidden raw headers %#",
		({ headers }) => {
			const read = () => readPeerHttpBodyLength(headers, { direction: "response" });

			expectError(read);
		},
	);
});
