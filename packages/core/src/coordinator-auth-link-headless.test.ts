import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	deriveHeadlessUserCodeStartBytes,
	formatHeadlessUserCode,
	generateHeadlessUserCode,
	HEADLESS_USER_CODE_ALPHABET,
	HEADLESS_USER_CODE_LENGTH,
	hashHeadlessUserCode,
	normalizeHeadlessUserCode,
} from "./coordinator-auth-link-headless.js";
import { encodeCoordinatorAuthProof32 } from "./coordinator-auth-proof.js";

function bytes(...values: number[]) {
	return () => Uint8Array.from(values);
}

describe("headless user code generation", () => {
	it("produces normalized codes from the alphabet only", () => {
		// Arrange
		const codes = Array.from({ length: 200 }, () => generateHeadlessUserCode());
		// Assert
		for (const code of codes) {
			expect(code).toHaveLength(HEADLESS_USER_CODE_LENGTH);
			expect(normalizeHeadlessUserCode(code)).toBe(code);
		}
	});

	it("discards bytes at or above 240 instead of folding them into the alphabet", () => {
		// Arrange: 240..255 would map to the first 16 letters if folded.
		const random = bytes(240, 255, 0, 19, 20, 241, 39, 1, 2, 3, 4, 5, 6, 7, 8, 9);
		// Act
		const code = generateHeadlessUserCode({ randomBytes: random });
		// Assert: accepted bytes 0,19,20,39,1,2,3,4 map by modulo 20.
		expect(code).toBe("BZBZCDFG");
	});

	it("fails closed when the random source never yields an unbiased byte", () => {
		expect(() =>
			generateHeadlessUserCode({ randomBytes: () => new Uint8Array(16).fill(250) }),
		).toThrow("headless_user_code_entropy_failed");
	});

	it("spreads letters roughly evenly across a large sample", () => {
		// Arrange
		const counts = new Map<string, number>();
		const samples = 4000;
		// Act
		for (let n = 0; n < samples; n += 1)
			for (const letter of generateHeadlessUserCode())
				counts.set(letter, (counts.get(letter) ?? 0) + 1);
		// Assert: expected 1600 per letter; bounds are about ten standard deviations wide.
		const expected = (samples * HEADLESS_USER_CODE_LENGTH) / HEADLESS_USER_CODE_ALPHABET.length;
		expect(counts.size).toBe(HEADLESS_USER_CODE_ALPHABET.length);
		for (const count of counts.values()) {
			expect(count).toBeGreaterThan(expected * 0.7);
			expect(count).toBeLessThan(expected * 1.3);
		}
	});
});

describe("headless user code normalization", () => {
	it.each([
		["BCDF-GHJK", "BCDFGHJK"],
		["bcdf-ghjk", "BCDFGHJK"],
		[" bcdf ghjk\n", "BCDFGHJK"],
		["B-C-D-F-G-H-J-K", "BCDFGHJK"],
		["zxwvtsrq", "ZXWVTSRQ"],
	])("accepts %j as %s", (input, normalized) => {
		expect(normalizeHeadlessUserCode(input)).toBe(normalized);
	});

	it.each([
		["vowel", "BCDF-GHJA"],
		["digit", "BCDF-GHJ1"],
		["too short", "BCDF-GHJ"],
		["too long", "BCDF-GHJKL"],
		["punctuation", "BCDF_GHJK"],
		["unicode expanding to letters", "BCDFGHJß"],
		["fullwidth letter", "BCDFGHJＫ"],
		["empty", ""],
		["oversized", `${"-".repeat(64)}BCDFGHJK`],
	])("rejects %s", (_label, input) => {
		expect(normalizeHeadlessUserCode(input)).toBeNull();
	});

	it.each([null, undefined, 12345678, {}, ["BCDFGHJK"]])("rejects non-string %j", (input) => {
		expect(normalizeHeadlessUserCode(input)).toBeNull();
	});

	it("formats normalized codes for display", () => {
		expect(formatHeadlessUserCode("bcdfghjk")).toBe("BCDF-GHJK");
		expect(() => formatHeadlessUserCode("AEIOUAEI")).toThrow("headless_user_code_invalid");
	});
});

describe("headless user code derivation", () => {
	it.each([
		[
			"BCDFGHJK",
			"1398b91fd7664268acb1c50fa542dd342df1d6b939f5d4d15599f087a579c451",
			"03a7177522489b99064ee076498d79e1003f22f7f9026cd9d68831c1f32e343d",
		],
		[
			"ZXWVTSRQ",
			"0fde11aa2fe408b9bdf373f89b280dc5556f61d940a9959c4d59b0bc943cf7c8",
			"dc45a4eb54731b0307d97f82bf8b85f4ef278547dc07803802fcbeee9fa6ed1b",
		],
	])("derives stable bytes and stored hash for %s", async (code, inner, stored) => {
		// Act
		const derived = await deriveHeadlessUserCodeStartBytes(code);
		// Assert
		expect(Buffer.from(derived).toString("hex")).toBe(inner);
		expect(await hashHeadlessUserCode(code)).toBe(stored);
	});

	it("stores the same hash desktop computes from the same 32 start bytes", async () => {
		// Arrange
		const inner = await deriveHeadlessUserCodeStartBytes("BCDFGHJK");
		// Act: desktop hashes the decoded start code bytes with SHA-256.
		const desktop = createHash("sha256").update(inner).digest("hex");
		// Assert
		expect(encodeCoordinatorAuthProof32(inner)).toHaveLength(43);
		expect(await hashHeadlessUserCode("BCDFGHJK")).toBe(desktop);
	});

	it("refuses unnormalized input so display and typed forms cannot diverge", async () => {
		await expect(deriveHeadlessUserCodeStartBytes("bcdf-ghjk")).rejects.toThrow(
			"headless_user_code_invalid",
		);
	});
});
