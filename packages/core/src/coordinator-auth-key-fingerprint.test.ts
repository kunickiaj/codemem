import { describe, expect, it } from "vitest";
import { formatShortKeyFingerprint } from "./coordinator-auth-key-fingerprint.js";

describe("formatShortKeyFingerprint", () => {
	it("prints the first and last 8 hex characters in ASCII", () => {
		// Arrange
		const fingerprint = `0123abcd${"5".repeat(48)}89abcdef`;
		// Act
		const short = formatShortKeyFingerprint(fingerprint);
		// Assert
		expect(short).toBe("SHA256:0123abcd...89abcdef");
		expect(/^[\x20-\x7e]+$/.test(short)).toBe(true);
	});

	it.each([["A".repeat(64)], ["a".repeat(63)], [`${"a".repeat(64)}\n`], [""]])(
		"refuses a value that is not a stored fingerprint",
		(value) => {
			// Act / Assert
			expect(() => formatShortKeyFingerprint(value)).toThrow("key_fingerprint_invalid");
		},
	);
});
