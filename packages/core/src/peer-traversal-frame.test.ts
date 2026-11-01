import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	TRAVERSAL_FRAME_HEADER_BYTES,
	TRAVERSAL_FRAME_VERSION,
	TRAVERSAL_MAX_FRAME_BYTES,
	TRAVERSAL_MAX_FRAME_PAYLOAD_BYTES,
	TraversalFrameDecoder,
	TraversalFrameEncoder,
	TraversalFrameError,
} from "./peer-traversal-frame.js";

function captureError(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	return undefined;
}

function expectFrameError(error: unknown): void {
	expect(error).toBeInstanceOf(Error);
	expect(error).toBeInstanceOf(TraversalFrameError);
	expect(error).toMatchObject({ code: expect.any(String) });
	if (error instanceof TraversalFrameError) expect(error.code.length).toBeGreaterThan(0);
}

const NON_BYTE_INPUTS = [
	{ name: "undefined", make: () => undefined },
	{ name: "null", make: () => null },
	{ name: "ArrayBuffer", make: () => new ArrayBuffer(3) },
	{ name: "DataView", make: () => new DataView(new ArrayBuffer(3)) },
	{ name: "Uint16Array", make: () => new Uint16Array(3) },
	{ name: "plain array", make: () => [1, 0, 42] },
	{ name: "string", make: () => "frame" },
	{ name: "number", make: () => 3 },
	{ name: "object", make: () => ({ byteLength: 3 }) },
];

const VIEW_FACTORIES = [
	{ name: "Uint8Array.subarray", make: (bytes: Uint8Array) => bytes.subarray(2, 5) },
	{
		name: "Buffer.slice",
		make: (bytes: Uint8Array) =>
			Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice(2, 5),
	},
];

describe("traversal frame wire format", () => {
	it("exports the exact v1 message limits", () => {
		// Arrange / Act
		const constants = [
			TRAVERSAL_FRAME_VERSION,
			TRAVERSAL_FRAME_HEADER_BYTES,
			TRAVERSAL_MAX_FRAME_PAYLOAD_BYTES,
			TRAVERSAL_MAX_FRAME_BYTES,
		];
		// Assert
		expect(constants).toEqual([1, 2, 8192, 8194]);
	});

	it.each([1, 256, 8192])("round-trips %i bytes in one exact data message", (length) => {
		// Arrange: the independent wire oracle does not reuse exported constants.
		const payload = Uint8Array.from({ length }, (_, index) => index % 256);
		const expected = Uint8Array.from([1, 0, ...payload]);
		const encoder = new TraversalFrameEncoder();
		const decoder = new TraversalFrameDecoder();
		// Act
		const encoded = encoder.encodeData(payload);
		const decoded = decoder.decode(encoded);
		const independent = new TraversalFrameDecoder().decode(expected);
		// Assert
		expect(encoded).toEqual(expected);
		expect(encoded.byteLength).toBe(length + 2);
		expect(decoded).toEqual({ kind: "data", payload });
		expect(independent).toEqual(decoded);
		expect([encoder.state, decoder.state]).toEqual(["open", "open"]);
	});

	it("encodes and decodes EOF as exactly two bytes", () => {
		// Arrange
		const encoder = new TraversalFrameEncoder();
		const decoder = new TraversalFrameDecoder();
		// Act
		const wire = encoder.encodeEnd();
		const decoded = decoder.decode(Uint8Array.of(1, 1));
		// Assert: EOF describes framing completion only.
		expect(wire).toEqual(Uint8Array.of(1, 1));
		expect(decoded).toEqual({ kind: "end" });
		expect([encoder.state, decoder.state]).toEqual(["ended", "ended"]);
	});

	it("returns independent EOF buffers from separate encoders", () => {
		// Arrange
		const first = new TraversalFrameEncoder();
		const second = new TraversalFrameEncoder();
		// Act
		const firstWire = first.encodeEnd();
		const secondWire = second.encodeEnd();
		firstWire.fill(255);
		const thirdWire = new TraversalFrameEncoder().encodeEnd();
		// Assert
		expect(secondWire).toEqual(Uint8Array.of(1, 1));
		expect(thirdWire).toEqual(Uint8Array.of(1, 1));
	});
});

describe("traversal frame native byte length validation", () => {
	it.each(["encode", "decode"] as const)(
		"uses the native byte length without reading a changing own getter during %s",
		(operation) => {
			// Arrange: the backing store stays small even if a later getter read changes the claim.
			const bytes = Uint8Array.of(1, 0, 42);
			let reads = 0;
			Object.defineProperty(bytes, "byteLength", {
				get() {
					reads += 1;
					return reads === 1 ? 3 : 8195;
				},
			});
			const encoder = new TraversalFrameEncoder();
			const decoder = new TraversalFrameDecoder();
			// Act
			const result = operation === "encode" ? encoder.encodeData(bytes) : decoder.decode(bytes);
			// Assert
			expect(reads).toBe(0);
			if (operation === "encode") {
				expect(result).toEqual(Uint8Array.of(1, 0, 1, 0, 42));
			} else {
				expect(result).toEqual({ kind: "data", payload: Uint8Array.of(42) });
			}
		},
	);

	it.each([
		{ name: "fractional", length: 3.5 },
		{ name: "NaN", length: Number.NaN },
		{ name: "string", length: "3" },
	])("ignores a $name own byteLength getter at both boundaries", ({ length }) => {
		// Arrange
		const bytes = Uint8Array.of(1, 0, 42);
		Object.defineProperty(bytes, "byteLength", { get: () => length });
		const encoder = new TraversalFrameEncoder();
		const decoder = new TraversalFrameDecoder();
		// Act
		const encoded = encoder.encodeData(bytes);
		const decoded = decoder.decode(bytes);
		// Assert
		expect(encoded).toEqual(Uint8Array.of(1, 0, 1, 0, 42));
		expect(decoded).toEqual({ kind: "data", payload: Uint8Array.of(42) });
		expect([encoder.state, decoder.state]).toEqual(["open", "open"]);
	});

	it("rejects an oversized payload despite an own getter reporting the maximum", () => {
		// Arrange: the final byte must not be silently truncated to fit the limit.
		const bytes = new Uint8Array(8193).fill(42);
		bytes[8192] = 255;
		Object.defineProperty(bytes, "byteLength", { get: () => 8192 });
		const encoder = new TraversalFrameEncoder();
		// Act
		const error = captureError(() => encoder.encodeData(bytes));
		// Assert
		expectFrameError(error);
		expect(encoder.state).toBe("failed");
		expect(bytes[8192]).toBe(255);
	});

	it("rejects an oversized wire despite an own getter reporting the maximum", () => {
		// Arrange
		const bytes = new Uint8Array(8195).fill(42);
		bytes.set([1, 0]);
		Object.defineProperty(bytes, "byteLength", { get: () => 8194 });
		const decoder = new TraversalFrameDecoder();
		// Act
		const error = captureError(() => decoder.decode(bytes));
		// Assert
		expectFrameError(error);
		expect(decoder.state).toBe("failed");
	});

	it("uses actual lengths without zero padding when an own getter overreports", () => {
		// Arrange
		const bytes = Uint8Array.of(1, 0, 42);
		Object.defineProperty(bytes, "byteLength", { get: () => 8194 });
		const encoder = new TraversalFrameEncoder();
		const decoder = new TraversalFrameDecoder();
		// Act
		const encoded = encoder.encodeData(bytes);
		const decoded = decoder.decode(bytes);
		// Assert
		expect(encoded).toEqual(Uint8Array.of(1, 0, 1, 0, 42));
		expect(encoded.byteLength).toBe(5);
		expect(decoded).toEqual({ kind: "data", payload: Uint8Array.of(42) });
		if (decoded.kind !== "data") throw new Error("Expected a data frame");
		expect(decoded.payload.byteLength).toBe(1);
	});

	it("does not invoke a throwing own getter on valid bytes", () => {
		// Arrange
		const bytes = Uint8Array.of(1, 0, 42);
		Object.defineProperty(bytes, "byteLength", {
			get() {
				throw new Error("Caller-owned getter must not run");
			},
		});
		const encoder = new TraversalFrameEncoder();
		const decoder = new TraversalFrameDecoder();
		// Act
		const encoded = encoder.encodeData(bytes);
		const decoded = decoder.decode(bytes);
		// Assert
		expect(encoded).toEqual(Uint8Array.of(1, 0, 1, 0, 42));
		expect(decoded).toEqual({ kind: "data", payload: Uint8Array.of(42) });
		expect([encoder.state, decoder.state]).toEqual(["open", "open"]);
	});

	it("rejects a forged Uint8Array prototype with protocol errors at both boundaries", () => {
		// Arrange
		const bytes: unknown = Object.create(Uint8Array.prototype);
		const encoder = new TraversalFrameEncoder();
		const decoder = new TraversalFrameDecoder();
		// Act
		const encodeError = captureError(() => encoder.encodeData(bytes));
		const decodeError = captureError(() => decoder.decode(bytes));
		// Assert
		expectFrameError(encodeError);
		expectFrameError(decodeError);
		expect(encodeError).not.toBeInstanceOf(TypeError);
		expect(decodeError).not.toBeInstanceOf(TypeError);
		expect([encoder.state, decoder.state]).toEqual(["failed", "failed"]);
	});
});

describe("traversal frame validation", () => {
	it.each(NON_BYTE_INPUTS)("rejects $name as a payload and fails permanently", ({ make }) => {
		// Arrange
		const encoder = new TraversalFrameEncoder();
		// Act
		const error = captureError(() => encoder.encodeData(make()));
		const retry = captureError(() => encoder.encodeData(Uint8Array.of(42)));
		const end = captureError(() => encoder.encodeEnd());
		// Assert
		for (const failure of [error, retry, end]) expectFrameError(failure);
		expect(encoder.state).toBe("failed");
	});

	it.each([0, 8193])("rejects %i payload bytes without splitting", (length) => {
		// Arrange
		const encoder = new TraversalFrameEncoder();
		const payload = new Uint8Array(length).fill(42);
		// Act
		const error = captureError(() => encoder.encodeData(payload));
		const retry = captureError(() => encoder.encodeEnd());
		// Assert
		expectFrameError(error);
		expectFrameError(retry);
		expect(encoder.state).toBe("failed");
		expect(payload).toEqual(new Uint8Array(length).fill(42));
	});

	it.each(NON_BYTE_INPUTS)("rejects $name as a message and fails permanently", ({ make }) => {
		// Arrange
		const decoder = new TraversalFrameDecoder();
		// Act
		const error = captureError(() => decoder.decode(make()));
		const data = captureError(() => decoder.decode(Uint8Array.of(1, 0, 42)));
		const end = captureError(() => decoder.decode(Uint8Array.of(1, 1)));
		// Assert
		for (const failure of [error, data, end]) expectFrameError(failure);
		expect(decoder.state).toBe("failed");
	});

	it.each([
		{ name: "empty message", bytes: [] },
		{ name: "partial header", bytes: [1] },
		{ name: "zero-length data", bytes: [1, 0] },
		{ name: "version zero", bytes: [0, 0, 42] },
		{ name: "future version", bytes: [2, 0, 42] },
		{ name: "unknown kind", bytes: [1, 2, 42] },
		{ name: "maximum kind", bytes: [1, 255, 42] },
		{ name: "EOF with one trailing byte", bytes: [1, 1, 42] },
		{ name: "EOF followed by another EOF", bytes: [1, 1, 1, 1] },
	])("rejects $name as a whole message with no later recovery", ({ bytes }) => {
		// Arrange
		const decoder = new TraversalFrameDecoder();
		// Act
		const error = captureError(() => decoder.decode(Uint8Array.from(bytes)));
		const retry = captureError(() => decoder.decode(Uint8Array.of(1, 0, 42)));
		// Assert
		expectFrameError(error);
		expectFrameError(retry);
		expect(decoder.state).toBe("failed");
	});

	it("rejects an 8195-byte message view without altering its parent", () => {
		// Arrange: length applies to the view, including its two-byte header.
		const parent = new Uint8Array(8199).fill(42);
		const wire = parent.subarray(2, 8197);
		wire.set([1, 0]);
		const original = parent.slice();
		const decoder = new TraversalFrameDecoder();
		// Act
		const error = captureError(() => decoder.decode(wire));
		// Assert
		expectFrameError(error);
		expect(decoder.state).toBe("failed");
		expect(parent).toEqual(original);
	});
});

describe.each(VIEW_FACTORIES)("traversal frame ownership with $name", ({ make }) => {
	it("encodes only the view and owns the result independently of the input", () => {
		// Arrange
		const parent = Uint8Array.of(0xde, 0xad, 0, 128, 255, 0xbe);
		const payload = make(parent);
		const encoder = new TraversalFrameEncoder();
		// Act
		const encoded = encoder.encodeData(payload);
		parent.fill(17);
		// Assert
		expect(encoded).toEqual(Uint8Array.of(1, 0, 0, 128, 255));
		expect(encoded.buffer).not.toBe(payload.buffer);
	});

	it("does not mutate the source when encoding or changing the result", () => {
		// Arrange
		const parent = Uint8Array.of(0xde, 0xad, 0, 128, 255, 0xbe);
		const original = parent.slice();
		// Act
		const encoded = new TraversalFrameEncoder().encodeData(make(parent));
		encoded.fill(17);
		// Assert
		expect(parent).toEqual(original);
	});

	it("decodes only the view into an owned Uint8Array despite later input changes", () => {
		// Arrange
		const parent = Uint8Array.of(0xde, 0xad, 1, 0, 255, 0xbe);
		const wire = make(parent);
		// Act
		const decoded = new TraversalFrameDecoder().decode(wire);
		parent.fill(17);
		// Assert
		expect(decoded.kind).toBe("data");
		if (decoded.kind !== "data") throw new Error("Expected a data frame");
		expect(decoded.payload).toEqual(Uint8Array.of(255));
		expect(Buffer.isBuffer(decoded.payload)).toBe(false);
		expect(decoded.payload.buffer).not.toBe(wire.buffer);
		expect(decoded.payload.buffer.byteLength).toBe(1);
	});

	it("does not mutate the wire parent when decoding or changing the payload", () => {
		// Arrange
		const parent = Uint8Array.of(0xde, 0xad, 1, 0, 255, 0xbe);
		const original = parent.slice();
		// Act
		const decoded = new TraversalFrameDecoder().decode(make(parent));
		if (decoded.kind !== "data") throw new Error("Expected a data frame");
		decoded.payload.fill(17);
		// Assert
		expect(parent).toEqual(original);
	});
});

describe("traversal frame decoder species independence", () => {
	it.each([1, 4, 10])("ignores a constructor species returning %i foreign bytes", (length) => {
		// Arrange: native subarray would consult this caller-controlled species.
		const wire = Uint8Array.of(1, 0, 42, 43, 44);
		let constructorReads = 0;
		let speciesCalls = 0;
		Object.defineProperty(wire, "constructor", {
			get() {
				constructorReads += 1;
				return {
					[Symbol.species]: function ForeignBytes() {
						speciesCalls += 1;
						return new Uint8Array(length).fill(99);
					},
				};
			},
		});
		const decoder = new TraversalFrameDecoder();
		// Act
		const decoded = decoder.decode(wire);
		// Assert
		expect(decoded).toEqual({ kind: "data", payload: Uint8Array.of(42, 43, 44) });
		if (decoded.kind !== "data") throw new Error("Expected a data frame");
		expect(decoded.payload.buffer.byteLength).toBe(3);
		expect(decoded.payload.buffer).not.toBe(wire.buffer);
		expect([constructorReads, speciesCalls]).toEqual([0, 0]);
		expect(decoder.state).toBe("open");
	});

	it("does not invoke a throwing constructor getter while decoding valid bytes", () => {
		// Arrange
		const wire = Uint8Array.of(1, 0, 42, 43, 44);
		let constructorReads = 0;
		Object.defineProperty(wire, "constructor", {
			get() {
				constructorReads += 1;
				throw new Error("Caller-owned constructor must not run");
			},
		});
		const decoder = new TraversalFrameDecoder();
		// Act
		const decoded = decoder.decode(wire);
		// Assert
		expect(decoded).toEqual({ kind: "data", payload: Uint8Array.of(42, 43, 44) });
		if (decoded.kind !== "data") throw new Error("Expected a data frame");
		expect(decoded.payload.buffer.byteLength).toBe(3);
		expect(constructorReads).toBe(0);
		expect(decoder.state).toBe("open");
	});
});

describe("traversal frame terminal states", () => {
	it.each(["data", "end"] as const)("fails an encoder after %s following EOF", (kind) => {
		// Arrange
		const encoder = new TraversalFrameEncoder();
		encoder.encodeEnd();
		// Act
		const error = captureError(() => {
			if (kind === "data") return encoder.encodeData(Uint8Array.of(42));
			return encoder.encodeEnd();
		});
		const retry = captureError(() => encoder.encodeEnd());
		// Assert
		expectFrameError(error);
		expectFrameError(retry);
		expect(encoder.state).toBe("failed");
	});

	it.each(["data", "end"] as const)("fails a decoder after %s following EOF", (kind) => {
		// Arrange
		const decoder = new TraversalFrameDecoder();
		decoder.decode(Uint8Array.of(1, 1));
		const bytes = kind === "data" ? Uint8Array.of(1, 0, 42) : Uint8Array.of(1, 1);
		// Act
		const error = captureError(() => decoder.decode(bytes));
		const retry = captureError(() => decoder.decode(Uint8Array.of(1, 1)));
		// Assert
		expectFrameError(error);
		expectFrameError(retry);
		expect(decoder.state).toBe("failed");
	});

	it.each(["open", "ended", "failed"] as const)("closes %s idempotently", (state) => {
		// Arrange
		const decoder = new TraversalFrameDecoder();
		if (state === "ended") decoder.decode(Uint8Array.of(1, 1));
		if (state === "failed") captureError(() => decoder.decode(Uint8Array.of(2, 0, 42)));
		const expected = state === "open" ? "truncated" : state;
		// Act
		const first = decoder.close();
		const second = decoder.close();
		// Assert
		expect([first, second, decoder.state]).toEqual([expected, expected, expected]);
	});

	it.each(["data", "end", "invalid"] as const)("cannot recover truncation with late %s", (kind) => {
		// Arrange
		const decoder = new TraversalFrameDecoder();
		decoder.close();
		const inputs = { data: Uint8Array.of(1, 0, 42), end: Uint8Array.of(1, 1), invalid: null };
		// Act
		const error = captureError(() => decoder.decode(inputs[kind]));
		const closed = decoder.close();
		// Assert
		expectFrameError(error);
		expect([closed, decoder.state]).toEqual(["truncated", "truncated"]);
	});

	it("preserves distinct payload copies across messages, EOF, and close", () => {
		// Arrange
		const decoder = new TraversalFrameDecoder();
		const wire = Uint8Array.of(1, 0, 42);
		// Act
		const first = decoder.decode(wire);
		wire[2] = 255;
		const second = decoder.decode(wire);
		decoder.decode(Uint8Array.of(1, 1));
		const closed = decoder.close();
		wire.fill(17);
		// Assert: clean framing EOF does not assert application or cryptographic completion.
		expect(closed).toBe("ended");
		expect(first).toEqual({ kind: "data", payload: Uint8Array.of(42) });
		expect(second).toEqual({ kind: "data", payload: Uint8Array.of(255) });
	});
});
