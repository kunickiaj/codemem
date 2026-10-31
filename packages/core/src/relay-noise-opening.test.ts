import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	RELAY_NOISE_OPENING_BYTES,
	RelayNoiseOpening,
	relayNoiseOpeningDigest,
	validateRelayNoiseOpeningDigest,
} from "./relay-noise-opening.js";

function openingBytes(): Uint8Array {
	return Uint8Array.from([0, 32, ...Array.from({ length: 32 }, (_, i) => i)]);
}

describe("relay Noise opening framing", () => {
	it.each(Array.from({ length: 35 }, (_, i) => i))(
		"accepts the exact 34-byte opening split at %i",
		(split) => {
			// Arrange: admission binds u16BE(32) plus all 32 ephemeral bytes.
			const bytes = openingBytes();
			const opening = new RelayNoiseOpening();
			const chunks = [bytes.subarray(0, split), bytes.subarray(split)].filter(
				(chunk) => chunk.length > 0,
			);
			// Act
			const outputs = chunks.map((chunk) => opening.append(chunk));
			// Assert
			expect(RELAY_NOISE_OPENING_BYTES).toBe(34);
			expect(outputs.at(-1)).toEqual(bytes);
			expect(outputs.slice(0, -1)).toEqual(new Array(outputs.length - 1).fill(undefined));
			expect(() => opening.end()).not.toThrow();
			expect(() => opening.append(new Uint8Array())).toThrow("already consumed");
		},
	);

	it("accepts bytewise arrival and owns both retained input and emitted output", () => {
		// Arrange
		const expected = openingBytes();
		const backing = Uint8Array.from([255, ...expected, 255]);
		const view = backing.subarray(1, 35);
		const opening = new RelayNoiseOpening();
		const outputs: (Uint8Array | undefined)[] = [];
		// Act
		for (const byte of view) {
			const input = Uint8Array.of(byte);
			outputs.push(opening.append(input));
			input.fill(255);
		}
		view.fill(0);
		// Assert
		expect(outputs.slice(0, 33)).toEqual(new Array(33).fill(undefined));
		expect(outputs[33]).toEqual(expected);
		expect(outputs[33]?.buffer).not.toBe(backing.buffer);
		expect(() => opening.end()).not.toThrow();
	});

	it.each([0, 1, 31, 33, 255, 256, 8192, 65535])(
		"rejects u16BE length %i and blocks subsequent appends",
		(length) => {
			// Arrange
			const prefix = Buffer.alloc(2);
			prefix.writeUInt16BE(length);
			const opening = new RelayNoiseOpening();
			// Act
			const append = () => opening.append(prefix);
			// Assert
			expect(append).toThrow("Invalid Noise opening length");
			expect(() => opening.append(new Uint8Array(32))).toThrow("already consumed");
			expect(() => opening.end()).toThrow("Truncated Noise opening");
		},
	);

	it.each(Array.from({ length: 34 }, (_, i) => i))(
		"rejects EOF after %i bytes without allowing reuse",
		(length) => {
			// Arrange
			const opening = new RelayNoiseOpening();
			opening.append(openingBytes().subarray(0, length));
			// Act
			const end = () => opening.end();
			// Assert
			expect(end).toThrow("Truncated Noise opening");
			expect(() => opening.append(openingBytes())).toThrow("already consumed");
		},
	);

	it.each([0, 1, 2, 33])("rejects extra early bytes after buffering %i bytes", (split) => {
		// Arrange
		const bytes = openingBytes();
		const opening = new RelayNoiseOpening();
		opening.append(bytes.subarray(0, split));
		const excess = Uint8Array.from([...bytes.subarray(split), 255]);
		// Act
		const append = () => opening.append(excess);
		// Assert
		expect(append).toThrow("Extra early Noise data");
		expect(() => opening.append(bytes.subarray(split))).toThrow("already consumed");
		expect(() => opening.end()).toThrow("Truncated Noise opening");
	});

	it.each([null, undefined, "opening", new ArrayBuffer(34), new Array(34).fill(0)])(
		"rejects non-byte runtime input %j permanently",
		(chunk) => {
			// Arrange
			const opening = new RelayNoiseOpening();
			// Act
			const append = () => Reflect.apply(opening.append, opening, [chunk]);
			// Assert
			expect(append).toThrow("Extra early Noise data");
			expect(() => opening.append(openingBytes())).toThrow("already consumed");
		},
	);
});

describe("relay Noise opening digest", () => {
	it("hashes the exact full wire view, including its length prefix", () => {
		// Arrange
		const bytes = openingBytes();
		const backing = Uint8Array.from([255, ...bytes, 254]);
		const view = backing.subarray(1, 35);
		const original = Uint8Array.from(view);
		// Act
		const digest = relayNoiseOpeningDigest(view);
		// Assert
		expect(digest).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(digest).not.toBe(createHash("sha256").update(bytes.subarray(2)).digest("hex"));
		expect(digest).not.toBe(createHash("sha256").update(backing).digest("hex"));
		expect(view).toEqual(original);
		expect(() => validateRelayNoiseOpeningDigest(digest)).not.toThrow();
	});

	it.each(["bad full length", "truncated", "extra bytes"])(
		"never returns an accepted digest for %s",
		(kind) => {
			// Arrange
			let bytes = openingBytes();
			if (kind === "bad full length") bytes[1] = 31;
			if (kind === "truncated") bytes = bytes.subarray(0, 33);
			if (kind === "extra bytes") bytes = Uint8Array.from([...bytes, 255]);
			// Act
			const digest = () => relayNoiseOpeningDigest(bytes);
			// Assert
			expect(digest).toThrow();
		},
	);

	it.each(["0".repeat(64), "abcdef0123456789".repeat(4)])(
		"accepts canonical lowercase digest %s",
		(digest) => {
			// Arrange
			const input = digest;
			// Act
			const result = validateRelayNoiseOpeningDigest(input);
			// Assert
			expect(result).toBeUndefined();
		},
	);

	it.each([
		"",
		"a".repeat(63),
		"a".repeat(65),
		"A".repeat(64),
		"g".repeat(64),
		` ${"a".repeat(64)}`,
		`${"a".repeat(64)}\n`,
		null,
		123,
		new Uint8Array(32),
	])("rejects noncanonical runtime digest %j", (digest) => {
		// Arrange
		const input = digest;
		// Act
		const act = () => Reflect.apply(validateRelayNoiseOpeningDigest, undefined, [input]);
		// Assert
		expect(act).toThrow("Invalid verified Noise opening digest");
	});
});
