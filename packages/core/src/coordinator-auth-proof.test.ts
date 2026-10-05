import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
	decodeCoordinatorAuthProof32,
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";

afterEach(() => vi.restoreAllMocks());
it("round trips canonical 32 bytes and hashes bytes rather than their text", async () => {
	// Arrange
	const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
	const canonical = Buffer.from(bytes).toString("base64url");
	// Act
	const encoded = encodeCoordinatorAuthProof32(bytes);
	const decoded = decodeCoordinatorAuthProof32(encoded);
	const digest = await hashCoordinatorAuthProofBytes32(bytes);
	// Assert
	expect(encoded).toBe(canonical);
	expect(decoded).toEqual(bytes);
	expect(digest).toBe(createHash("sha256").update(bytes).digest("hex"));
	expect(digest).not.toBe(createHash("sha256").update(canonical).digest("hex"));
});
it.each([
	null,
	undefined,
	32,
	"A".repeat(42),
	"A".repeat(44),
	`${"A".repeat(43)}=`,
	`${"A".repeat(42)}B`,
	"/".repeat(43),
	`${"A".repeat(42)}\n`,
])("rejects noncanonical proof %j", (value) => {
	// Arrange: permissive Buffer decoding must not become an HTTP proof parser.
	const input = value;
	// Act
	const result = decodeCoordinatorAuthProof32(input);
	// Assert
	expect(result).toBeNull();
});
it.each([0, 31, 33])("rejects wrong byte length %i for encoding and hashing", async (length) => {
	// Arrange
	const bytes = new Uint8Array(length);
	// Act
	const encode = () => encodeCoordinatorAuthProof32(bytes);
	const digest = hashCoordinatorAuthProofBytes32(bytes);
	// Assert
	expect(encode).toThrow("auth_proof_invalid_input");
	await expect(digest).rejects.toThrow("auth_proof_invalid_input");
});
it("redacts underlying crypto exceptions", async () => {
	// Arrange
	vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(
		new Error("private-proof-transport"),
	);
	// Act
	const result = hashCoordinatorAuthProofBytes32(new Uint8Array(32));
	// Assert
	await expect(result).rejects.toThrow(/^auth_proof_crypto_failed$/);
});
