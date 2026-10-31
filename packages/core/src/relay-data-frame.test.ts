import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	decodeRelayDataFrame,
	encodeRelayDataFrame,
	RELAY_DATA_FRAME_HEADER_BYTES,
	RELAY_DATA_FRAME_KIND,
	RELAY_MAX_NOISE_FRAGMENT_BYTES,
	RELAY_PROTOCOL_VERSION,
	RelayFrameError,
} from "./relay-data-frame.js";

const SESSION_ID = "00112233445566778899aabbccddeeff";
// Independent wire oracle: version, kind, 16 raw session bytes, u32 BE length, payload.
const FIXED_WIRE_HEX = "010100112233445566778899aabbccddeeff000000030080ff";
const FIXED_HEADER = Buffer.from("010100112233445566778899aabbccddeeff00000000", "hex");

function wireWithLength(advertisedLength: number, actualLength: number): Uint8Array {
	const bytes = new Uint8Array(22 + actualLength);
	bytes.set(FIXED_HEADER);
	new DataView(bytes.buffer).setUint32(18, advertisedLength);
	bytes.fill(0xa5, 22);
	return bytes;
}

function captureError(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	return undefined;
}

function expectFrameError(error: unknown, code: string): void {
	expect(error).toBeInstanceOf(RelayFrameError);
	expect(error).toBeInstanceOf(Error);
	expect(error).toMatchObject({ code });
}

const NON_BYTE_INPUTS = [
	{ name: "undefined", make: () => undefined },
	{ name: "null", make: () => null },
	{ name: "Float64Array", make: () => new Float64Array(3) },
	{ name: "Uint16Array", make: () => new Uint16Array(3) },
	{ name: "DataView", make: () => new DataView(new ArrayBuffer(3)) },
	{ name: "ArrayBuffer", make: () => new ArrayBuffer(3) },
	{ name: "plain array", make: () => [0, 0x80, 0xff] },
	{ name: "array-like object", make: () => ({ byteLength: 3 }) },
];

const VIEW_FACTORIES = [
	{
		name: "Uint8Array.subarray",
		make(parent: Uint8Array, start: number, end: number): Uint8Array {
			return parent.subarray(start, end);
		},
	},
	{
		name: "Buffer.slice",
		make(parent: Uint8Array, start: number, end: number): Uint8Array {
			return Buffer.from(parent.buffer, parent.byteOffset, parent.byteLength).slice(start, end);
		},
	},
];

describe("relay data frame wire format", () => {
	it("exports the v1 format limits", () => {
		// Arrange / Act: read the public protocol constants.
		const constants = [
			RELAY_PROTOCOL_VERSION,
			RELAY_DATA_FRAME_KIND,
			RELAY_DATA_FRAME_HEADER_BYTES,
			RELAY_MAX_NOISE_FRAGMENT_BYTES,
		];
		// Assert
		expect(constants).toEqual([1, 1, 22, 65_536]);
	});

	it("encodes the fixed vector at the exact byte positions", () => {
		// Arrange
		const frame = { sessionId: SESSION_ID, payload: Uint8Array.of(0, 0x80, 0xff) };
		// Act
		const encoded = encodeRelayDataFrame(frame);
		// Assert: the literal includes every header and payload byte.
		expect(encoded).toBeInstanceOf(Uint8Array);
		expect(Buffer.from(encoded).toString("hex")).toBe(FIXED_WIRE_HEX);
	});

	it("decodes the independent fixed vector without changing its bytes", () => {
		// Arrange
		const wire = Buffer.from(FIXED_WIRE_HEX, "hex");
		// Act
		const decoded = decodeRelayDataFrame(wire);
		// Assert
		expect(decoded.sessionId).toBe(SESSION_ID);
		expect(decoded.payload).toBeInstanceOf(Uint8Array);
		expect(Array.from(decoded.payload)).toEqual([0, 0x80, 0xff]);
		expect(wire.toString("hex")).toBe(FIXED_WIRE_HEX);
	});

	it.each([
		{ length: 1, lengthBytes: [0, 0, 0, 1] },
		{ length: 256, lengthBytes: [0, 0, 1, 0] },
		{ length: 65_536, lengthBytes: [0, 1, 0, 0] },
	])(
		"encodes $length payload bytes using a four-byte big-endian length",
		({ length, lengthBytes }) => {
			// Arrange
			const payload = new Uint8Array(length).fill(0xa5);
			// Act
			const encoded = encodeRelayDataFrame({ sessionId: SESSION_ID, payload });
			// Assert
			expect(encoded.byteLength).toBe(22 + length);
			expect(Array.from(encoded.subarray(0, 18))).toEqual(Array.from(FIXED_HEADER.subarray(0, 18)));
			expect(Array.from(encoded.subarray(18, 22))).toEqual(lengthBytes);
			expect(Array.from(encoded.subarray(22))).toEqual(Array.from(payload));
		},
	);

	it.each([1, 256, 65_536])("decodes an independently built %i-byte payload", (length) => {
		// Arrange
		const wire = wireWithLength(length, length);
		// Act
		const decoded = decodeRelayDataFrame(wire);
		// Assert
		expect(decoded.sessionId).toBe(SESSION_ID);
		expect(Array.from(decoded.payload)).toEqual(Array.from(new Uint8Array(length).fill(0xa5)));
	});

	it.each(["0".repeat(32), "f".repeat(32)])("preserves session ID %s", (sessionId) => {
		// Arrange
		const frame = { sessionId, payload: Uint8Array.of(0x42) };
		// Act
		const decoded = decodeRelayDataFrame(encodeRelayDataFrame(frame));
		// Assert
		expect(decoded.sessionId).toBe(sessionId);
		expect(Array.from(decoded.payload)).toEqual([0x42]);
	});
});

describe("relay data frame input validation", () => {
	it.each([undefined, null, false, 1, "frame"])("rejects a non-object frame: %j", (frame) => {
		// Arrange
		const args = [frame];
		// Act: Reflect.apply exercises the untyped JavaScript boundary without type casts.
		const error = captureError(() => Reflect.apply(encodeRelayDataFrame, undefined, args));
		// Assert
		expectFrameError(error, "invalid_session_id");
	});

	it.each(NON_BYTE_INPUTS)("rejects $name as an encode payload", ({ make }) => {
		// Arrange
		const frame = { sessionId: SESSION_ID, payload: make() };
		// Act
		const error = captureError(() => Reflect.apply(encodeRelayDataFrame, undefined, [frame]));
		// Assert
		expectFrameError(error, "invalid_payload_length");
	});

	it.each(NON_BYTE_INPUTS)("rejects $name as a decode frame", ({ make }) => {
		// Arrange
		const bytes = make();
		// Act
		const error = captureError(() => Reflect.apply(decodeRelayDataFrame, undefined, [bytes]));
		// Assert
		expectFrameError(error, "invalid_frame");
	});

	it.each([
		"",
		"0".repeat(31),
		"0".repeat(33),
		"g".repeat(32),
		`${"0".repeat(31)}!`,
		SESSION_ID.toUpperCase(),
		` ${SESSION_ID}`,
		`${SESSION_ID}\n`,
	])("rejects a session ID outside strict lowercase 32-character hex: %j", (sessionId) => {
		// Arrange
		const frame = { sessionId, payload: Uint8Array.of(1) };
		// Act
		const error = captureError(() => encodeRelayDataFrame(frame));
		// Assert
		expectFrameError(error, "invalid_session_id");
	});

	it.each([0, 65_537])("rejects an encoded payload of %i bytes", (length) => {
		// Arrange
		const frame = { sessionId: SESSION_ID, payload: new Uint8Array(length) };
		// Act
		const error = captureError(() => encodeRelayDataFrame(frame));
		// Assert
		expectFrameError(error, "invalid_payload_length");
	});

	it.each(Array.from({ length: 22 }, (_, length) => length))(
		"rejects a %i-byte incomplete header with a protocol error",
		(length) => {
			// Arrange
			const bytes = FIXED_HEADER.subarray(0, length);
			// Act
			const error = captureError(() => decodeRelayDataFrame(bytes));
			// Assert
			expectFrameError(error, "truncated_header");
		},
	);

	it.each([
		{ offset: 0, value: 0, name: "zero version", code: "unsupported_version" },
		{ offset: 0, value: 2, name: "future version", code: "unsupported_version" },
		{ offset: 0, value: 255, name: "unknown version", code: "unsupported_version" },
		{ offset: 1, value: 0, name: "zero kind", code: "unsupported_kind" },
		{ offset: 1, value: 2, name: "unknown kind", code: "unsupported_kind" },
		{ offset: 1, value: 255, name: "maximum kind", code: "unsupported_kind" },
	])("rejects $name", ({ offset, value, code }) => {
		// Arrange
		const wire = wireWithLength(1, 1);
		wire[offset] = value;
		// Act
		const error = captureError(() => decodeRelayDataFrame(wire));
		// Assert
		expectFrameError(error, code);
	});

	it.each([
		{
			advertised: 0,
			actual: 0,
			name: "zero length with empty body",
			code: "invalid_payload_length",
		},
		{
			advertised: 0,
			actual: 1,
			name: "zero length with trailing byte",
			code: "invalid_payload_length",
		},
		{
			advertised: 65_537,
			actual: 65_537,
			name: "oversized complete payload",
			code: "frame_too_large",
		},
		{
			advertised: 65_537,
			actual: 0,
			name: "oversized absent payload",
			code: "invalid_payload_length",
		},
		{
			advertised: 0xffff_ffff,
			actual: 1,
			name: "maximum u32 advertised length",
			code: "invalid_payload_length",
		},
		{ advertised: 1, actual: 0, name: "absent payload", code: "length_mismatch" },
		{ advertised: 3, actual: 2, name: "truncated payload", code: "length_mismatch" },
		{ advertised: 3, actual: 4, name: "trailing payload byte", code: "length_mismatch" },
		{
			advertised: 65_536,
			actual: 65_535,
			name: "truncated maximum payload",
			code: "length_mismatch",
		},
		{
			advertised: 65_536,
			actual: 65_537,
			name: "trailing byte after maximum payload",
			code: "frame_too_large",
		},
	])("rejects $name", ({ advertised, actual, code }) => {
		// Arrange: allocate only the actual bytes, even for the maximum u32 advertisement.
		const wire = wireWithLength(advertised, actual);
		// Act
		const error = captureError(() => decodeRelayDataFrame(wire));
		// Assert
		expectFrameError(error, code);
	});

	it.each([
		{ offset: 0, name: "unsupported version" },
		{ offset: 1, name: "unsupported kind" },
		{ offset: 21, name: "invalid advertised length" },
	])("rejects an oversized frame before checking $name", ({ offset }) => {
		// Arrange
		const wire = wireWithLength(1, 65_537);
		wire[offset] = 0;
		// Act
		const error = captureError(() => decodeRelayDataFrame(wire));
		// Assert
		expectFrameError(error, "frame_too_large");
	});
});

describe.each(VIEW_FACTORIES)("relay data frame ownership with $name", ({ make }) => {
	it("encodes only the payload view and does not modify its parent", () => {
		// Arrange: sentinels outside the view must never enter the frame.
		const parent = Uint8Array.of(0xde, 0xad, 0, 0x80, 0xff, 0xbe, 0xef);
		const payload = make(parent, 2, 5);
		// Act
		const encoded = encodeRelayDataFrame({ sessionId: SESSION_ID, payload });
		// Assert
		expect(Buffer.from(encoded).toString("hex")).toBe(FIXED_WIRE_HEX);
		expect(Array.from(parent)).toEqual([0xde, 0xad, 0, 0x80, 0xff, 0xbe, 0xef]);
	});

	it("keeps encoded bytes independent of later source mutations", () => {
		// Arrange
		const parent = Uint8Array.of(0xde, 0xad, 0, 0x80, 0xff, 0xbe, 0xef);
		const payload = make(parent, 2, 5);
		// Act
		const encoded = encodeRelayDataFrame({ sessionId: SESSION_ID, payload });
		parent.fill(0x11);
		// Assert
		expect(Buffer.from(encoded).toString("hex")).toBe(FIXED_WIRE_HEX);
	});

	it("does not change the source when encoded bytes are mutated", () => {
		// Arrange
		const parent = Uint8Array.of(0xde, 0xad, 0, 0x80, 0xff, 0xbe, 0xef);
		const payload = make(parent, 2, 5);
		// Act
		const encoded = encodeRelayDataFrame({ sessionId: SESSION_ID, payload });
		encoded.fill(0x11);
		// Assert
		expect(Array.from(parent)).toEqual([0xde, 0xad, 0, 0x80, 0xff, 0xbe, 0xef]);
	});

	it("decodes only the wire view despite bytes on either side", () => {
		// Arrange
		const parent = new Uint8Array(29).fill(0xcc);
		parent.set(Buffer.from(FIXED_WIRE_HEX, "hex"), 2);
		const wire = make(parent, 2, 27);
		const original = Array.from(parent);
		// Act
		const decoded = decodeRelayDataFrame(wire);
		// Assert
		expect(decoded.sessionId).toBe(SESSION_ID);
		expect(Array.from(decoded.payload)).toEqual([0, 0x80, 0xff]);
		expect(Array.from(parent)).toEqual(original);
	});

	it("keeps decoded values independent of later wire-parent mutations", () => {
		// Arrange
		const parent = new Uint8Array(29).fill(0xcc);
		parent.set(Buffer.from(FIXED_WIRE_HEX, "hex"), 2);
		const wire = make(parent, 2, 27);
		// Act
		const decoded = decodeRelayDataFrame(wire);
		parent.fill(0x11);
		// Assert
		expect(decoded.sessionId).toBe(SESSION_ID);
		expect(Array.from(decoded.payload)).toEqual([0, 0x80, 0xff]);
	});

	it("does not change the wire parent when decoded payload bytes are mutated", () => {
		// Arrange
		const parent = new Uint8Array(29).fill(0xcc);
		parent.set(Buffer.from(FIXED_WIRE_HEX, "hex"), 2);
		const wire = make(parent, 2, 27);
		const original = Array.from(parent);
		// Act
		const decoded = decodeRelayDataFrame(wire);
		decoded.payload.fill(0x11);
		// Assert
		expect(Array.from(parent)).toEqual(original);
	});

	it("rejects a truncated view even when the parent contains the missing payload byte", () => {
		// Arrange
		const parent = new Uint8Array(29).fill(0xcc);
		parent.set(Buffer.from(FIXED_WIRE_HEX, "hex"), 2);
		const wire = make(parent, 2, 26);
		// Act
		const error = captureError(() => decodeRelayDataFrame(wire));
		// Assert
		expectFrameError(error, "length_mismatch");
	});
});
