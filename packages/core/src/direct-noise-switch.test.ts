import { expect, it } from "vitest";
import {
	DirectNoiseBusy,
	DirectNoiseNotOffered,
	DirectNoiseRejected,
	MAX_SWITCH_RESPONSE_BYTES,
	readSwitchResponse,
} from "./direct-noise-switch.js";

const read = (reply: string, closed = true) =>
	readSwitchResponse(Buffer.from(reply, "latin1"), closed);
const errorOf = (reply: string, closed = true) => {
	const reading = read(reply, closed);
	return reading.kind === "refused" ? reading.error : reading.kind;
};

it.each([
	[
		"Content-Length",
		'HTTP/1.1 404 Not Found\r\nContent-Length: 23\r\n\r\n{"error":"not found"}\r\n',
	],
	["chunked", "HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nnope\r\n0\r\n\r\n"],
	["an empty body", "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"],
])("reads a complete 404 with %s as Noise not offered", (_label, reply) => {
	expect(errorOf(reply, false)).toBeInstanceOf(DirectNoiseNotOffered);
});

it.each([
	["no length", "HTTP/1.1 404 Not Found\r\n\r\nnot found"],
	["a body cut short", "HTTP/1.1 404 Not Found\r\nContent-Length: 20\r\n\r\nnot"],
	["bytes past its length", "HTTP/1.1 404 Not Found\r\nContent-Length: 1\r\n\r\nxy"],
	["two lengths", "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n"],
	[
		"a length and chunked",
		"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
	],
	[
		"a chunked body cut short",
		"HTTP/1.1 404 Not Found\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nno",
	],
	["a bad header line", "HTTP/1.1 404 Not Found\r\nbad header\r\nContent-Length: 0\r\n\r\n"],
	["HTTP/1.0", "HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\n\r\n"],
	["a cut-off head", "HTTP/1.1 404 Not Fou"],
	["garbage", "SSH-2.0-OpenSSH\r\n\r\n"],
])(
	"refuses a 404 with %s once the connection closes, never as Noise not offered",
	(_label, reply) => {
		expect(errorOf(reply)).toBeInstanceOf(DirectNoiseRejected);
	},
);

it("waits for the rest of a 404 body while the connection is open", () => {
	expect(read("HTTP/1.1 404 Not Found\r\nContent-Length: 20\r\n\r\nnot", false).kind).toBe(
		"pending",
	);
});

it.each([
	["401", "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"],
	["400", "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"],
	["200", "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"],
	["101 with bytes after it", "HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\n\r\nnoise"],
])("refuses a %s reply", (_label, reply) => {
	expect(errorOf(reply, false)).toBeInstanceOf(DirectNoiseRejected);
});

it("refuses a reply larger than the limit", () => {
	const reply = `HTTP/1.1 404 Not Found\r\nX-Pad: ${"a".repeat(MAX_SWITCH_RESPONSE_BYTES)}\r\n\r\n`;
	expect(errorOf(reply, false)).toBeInstanceOf(DirectNoiseRejected);
});

it("reads 429, 503 and a close with no bytes as busy", () => {
	expect(
		errorOf("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 3\r\n\r\n", false),
	).toMatchObject({
		status: 503,
		retryAfterS: 3,
	});
	expect(errorOf("HTTP/1.1 429 Too Many Requests\r\n\r\n", false)).toBeInstanceOf(DirectNoiseBusy);
	expect(errorOf("")).toMatchObject({ status: "closed" });
});

it("reads a clean 101 as switched", () => {
	expect(
		read(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: codemem-peer-stream/1\r\nConnection: Upgrade\r\n\r\n",
			false,
		),
	).toEqual({
		kind: "switched",
	});
});
