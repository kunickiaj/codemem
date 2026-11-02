import { describe, expect, it } from "vitest";
import { PEER_HTTP_LIMITS, PeerHttpExchangeError } from "./peer-http-policy.js";
import { PeerHttpWireAudit } from "./peer-http-wire-audit.js";

const HEADER = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n");
function failure(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("Expected framing failure");
}
function expectFraming(error: unknown) {
	expect(error).toBeInstanceOf(PeerHttpExchangeError);
	expect(error).toHaveProperty("code", "framing");
}
function paddedHeader(
	direction: "request" | "response",
	padding: "header" | "startline",
	size: number,
) {
	const render = (count: number) => {
		const fill = "x".repeat(count);
		const startlinePadding = padding === "startline" ? fill : "";
		const headerPadding = padding === "header" ? fill : "";
		let start = `GET /${startlinePadding} HTTP/1.1`;
		if (direction === "response") {
			const reason = padding === "startline" ? fill : "OK";
			start = `HTTP/1.1 200 ${reason}`;
		}
		return `${start}\r\nContent-Length: 0\r\nX-Pad: ${headerPadding}\r\n\r\n`;
	};
	return Buffer.from(render(size - Buffer.byteLength(render(0), "latin1")), "latin1");
}

describe("peer HTTP wire boundary scan", () => {
	it("pins the header, role body and exchange lifetime ceilings", () => {
		const limits = { ...PEER_HTTP_LIMITS };

		expect(limits).toEqual({
			headerBytes: 16384,
			requestBytes: 1048576,
			responseBytes: 16777216,
			exchangeMs: 60000,
			cleanupMs: 1500,
		});
	});
	it.each(Array.from({ length: HEADER.length + 1 }, (_, split) => split))(
		"finds the first delimiter split at %i",
		(split) => {
			const audit = new PeerHttpWireAudit({ direction: "response" });

			audit.observe(HEADER.subarray(0, split));
			audit.observe(HEADER.subarray(split));
			audit.expectBodyBytes(2);
			audit.observe(Buffer.from("{}"));
			expect(audit.state).toBe("body");
			audit.finish();

			expect(audit.state).toBe("ended");
		},
	);

	it.each([HEADER, Buffer.from("\r\n\r\r\n\r\n")])(
		"scans bytewise with overlapping CRLF prefixes %#",
		(header) => {
			const audit = new PeerHttpWireAudit({ direction: "response" });

			for (const byte of header) audit.observe(Uint8Array.of(byte));
			audit.expectBodyBytes(0);
			audit.finish();

			expect(audit.state).toBe("ended");
		},
	);

	it.each(["request", "response"] as const)(
		"counts complete Latin-1 %s headers including start line and delimiter",
		(direction) => {
			for (const padding of ["header", "startline"] as const) {
				const accepted = new PeerHttpWireAudit({ direction });
				const rejected = new PeerHttpWireAudit({ direction });
				const exact = paddedHeader(direction, padding, 16384);
				const excess = paddedHeader(direction, padding, 16385);

				accepted.observe(exact);
				accepted.expectBodyBytes(0);
				accepted.finish();
				const error = failure(() => rejected.observe(excess));

				expect(exact).toHaveLength(16384);
				expect(excess).toHaveLength(16385);
				expect(accepted.state).toBe("ended");
				expectFraming(error);
				expect(rejected.state).toBe("failed");
			}
		},
	);

	it("rejects a header that reaches its cap without the delimiter", () => {
		const audit = new PeerHttpWireAudit({ direction: "request", maxHeaderBytes: 4 });
		audit.observe(Buffer.from("xxx"));

		const error = failure(() => audit.observe(Uint8Array.of(120)));

		expectFraming(error);
		expect(audit.state).toBe("failed");
	});
});

describe("peer HTTP wire body accounting", () => {
	it("counts later header delimiters as body bytes and allows repeated successful EOF", () => {
		const audit = new PeerHttpWireAudit({ direction: "response" });
		const body = Buffer.from("\r\n\r\nX");

		audit.observe(Buffer.concat([HEADER, body]));
		audit.expectBodyBytes(body.length);
		audit.finish();
		audit.finish();

		expect(audit.state).toBe("ended");
	});
	it.each([
		["request", 1048576],
		["response", 16777216],
	] as const)("accepts exact %s body cap %i and rejects larger declarations", (direction, cap) => {
		const audit = new PeerHttpWireAudit({ direction });
		const rejected = new PeerHttpWireAudit({ direction });
		const chunk = Buffer.alloc(65536);
		audit.observe(HEADER);
		rejected.observe(HEADER);

		audit.expectBodyBytes(cap);
		for (let count = 0; count < cap; count += chunk.length) audit.observe(chunk);
		audit.finish();
		const error = failure(() => rejected.expectBodyBytes(cap + 1));

		expect(audit.state).toBe("ended");
		expectFraming(error);
	});

	it.each([0, 2])("accepts a lowered body cap of %i", (maxBodyBytes) => {
		const audit = new PeerHttpWireAudit({ direction: "request", maxHeaderBytes: 4, maxBodyBytes });

		audit.observe(Buffer.from("\r\n\r\n"));
		audit.expectBodyBytes(maxBodyBytes);
		audit.observe(Buffer.alloc(maxBodyBytes));
		audit.finish();

		expect(audit.state).toBe("ended");
	});

	it.each(["same-chunk", "later-chunk"] as const)(
		"rejects %s surplus without waiting for EOF",
		(timing) => {
			const audit = new PeerHttpWireAudit({ direction: "response" });
			audit.observe(Buffer.concat([HEADER, Buffer.from(timing === "same-chunk" ? "{}X" : "{}")]));

			const error = failure(() => {
				audit.expectBodyBytes(2);
				if (timing === "later-chunk") audit.observe(Buffer.from("X"));
			});

			expectFraming(error);
			expect(audit.state).toBe("failed");
		},
	);

	it.each([
		"before-headers",
		"duplicate",
		"missing-expectation",
		"partial-header",
		"truncated-body",
	] as const)("rejects %s lifecycle", (fault) => {
		const audit = new PeerHttpWireAudit({ direction: "response" });
		if (fault !== "before-headers" && fault !== "partial-header") audit.observe(HEADER);
		if (fault === "partial-header") audit.observe(Buffer.from("HTTP/1.1 200 OK\r\n"));
		if (fault === "duplicate" || fault === "truncated-body") audit.expectBodyBytes(2);
		if (fault === "truncated-body") audit.observe(Buffer.from("{"));

		const error = failure(() => {
			if (fault === "before-headers" || fault === "duplicate") audit.expectBodyBytes(2);
			else audit.finish();
		});

		expectFraming(error);
		expect(audit.state).toBe("failed");
	});

	it.each(["observe", "expect"] as const)("rejects %s after successful EOF", (operation) => {
		const audit = new PeerHttpWireAudit({ direction: "request" });
		audit.observe(HEADER);
		audit.expectBodyBytes(0);
		audit.finish();

		const error = failure(() =>
			operation === "observe" ? audit.observe(Buffer.from("X")) : audit.expectBodyBytes(0),
		);

		expectFraming(error);
		expect(audit.state).toBe("failed");
	});

	it("retains the identical first generic failure across every later operation", () => {
		const audit = new PeerHttpWireAudit({ direction: "request" });
		const first = failure(() => audit.expectBodyBytes(0));

		const later = [
			() => audit.observe(Buffer.from("private payload")),
			() => audit.expectBodyBytes(0),
			() => audit.finish(),
		].map(failure);

		expectFraming(first);
		for (const error of later) expect(error).toBe(first);
		expect(String(first)).not.toContain("private payload");
	});
});

describe("peer HTTP wire audit input boundaries", () => {
	it.each([0, -1, 1.5, NaN, Infinity, 3, 16385])(
		"rejects invalid header cap %s",
		(maxHeaderBytes) => {
			const construct = () => new PeerHttpWireAudit({ direction: "response", maxHeaderBytes });

			expectFraming(failure(construct));
		},
	);
	it.each(["request", "response"] as const)(
		"rejects invalid %s body caps and declarations",
		(direction) => {
			const roleCap = direction === "request" ? 1048576 : 16777216;
			const invalid = [-1, 1.5, NaN, Infinity, roleCap + 1];

			for (const length of invalid) {
				expectFraming(failure(() => new PeerHttpWireAudit({ direction, maxBodyBytes: length })));
				const audit = new PeerHttpWireAudit({ direction });
				audit.observe(HEADER);
				expectFraming(failure(() => audit.expectBodyBytes(length)));
			}
		},
	);
	it.each([null, {}, { direction: "other" }, { direction: "response", maxBodyBytes: null }])(
		"rejects malformed runtime options %j",
		(options) => {
			const construct = () => Reflect.construct(PeerHttpWireAudit, [options]);

			expectFraming(failure(construct));
		},
	);
	it.each([
		null,
		"private",
		[],
		new ArrayBuffer(4),
		new Uint16Array(4),
		new DataView(new ArrayBuffer(4)),
		Object.create(Uint8Array.prototype),
		new Proxy(Uint8Array.of(1), {}),
	])("rejects non-native byte input %#", (bytes) => {
		const audit = new PeerHttpWireAudit({ direction: "request" });

		const error = failure(() => audit.observe(bytes));

		expectFraming(error);
		expect(audit.state).toBe("failed");
	});
	it("rejects detached bytes", () => {
		const audit = new PeerHttpWireAudit({ direction: "request" });
		const bytes = new Uint8Array(4);
		structuredClone(bytes.buffer, { transfer: [bytes.buffer] });

		const error = failure(() => audit.observe(bytes));

		expectFraming(error);
	});
	it("uses native view bytes despite hostile length, iterator, constructor and species", () => {
		class Bytes extends Uint8Array {
			static get [Symbol.species](): Uint8ArrayConstructor {
				throw new Error("private species");
			}
		}
		const audit = new PeerHttpWireAudit({ direction: "response" });
		const bytes = new Bytes(HEADER);
		for (const field of ["byteLength", "length", "constructor", Symbol.iterator])
			Object.defineProperty(bytes, field, {
				get() {
					throw new Error("private metadata");
				},
			});

		audit.observe(bytes);
		audit.expectBodyBytes(0);
		audit.finish();

		expect(audit.state).toBe("ended");
	});

	it("counts actual nonzero-offset bytes despite shadowed short lengths", () => {
		const audit = new PeerHttpWireAudit({ direction: "response" });
		const backing = Buffer.concat([
			Buffer.from([255]),
			HEADER,
			Buffer.from("X"),
			Buffer.from([255]),
		]);
		const bytes = backing.subarray(1, -1);
		Object.defineProperty(bytes, "length", { value: 1 });
		Object.defineProperty(bytes, "byteLength", { value: 1 });
		audit.observe(bytes);

		const error = failure(() => audit.expectBodyBytes(0));

		expectFraming(error);
	});
});
