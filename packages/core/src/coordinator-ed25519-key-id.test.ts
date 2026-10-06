import { createHash, createPrivateKey, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519KeyId, parseSshEd25519PublicKey } from "./coordinator-ed25519-key-id.js";
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
	MALFORMED_KEYS,
	NODE_ONLY_ALIASES,
	OTHER_KEYS,
	publicKeyFromWire,
	REQUEST_BODY,
	REQUEST_METHOD,
	REQUEST_NONCE,
	REQUEST_PATH,
	REQUEST_TIME_MS,
	REQUEST_TIMESTAMP,
	wireBytes,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { buildCanonicalRequest, verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

function signedRequest(publicKey: string) {
	// RFC 8032 public test seed; this disposable signing fixture is not a credential.
	const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
	const privateKey = createPrivateKey({
		key: Buffer.from(`302e020100300506032b657004220420${seed}`, "hex"),
		format: "der",
		type: "pkcs8",
	});
	const bodyBytes = Buffer.from(REQUEST_BODY);
	const canonical = buildCanonicalRequest(
		REQUEST_METHOD,
		REQUEST_PATH,
		REQUEST_TIMESTAMP,
		REQUEST_NONCE,
		bodyBytes,
	);
	return {
		method: REQUEST_METHOD,
		pathWithQuery: REQUEST_PATH,
		timestamp: REQUEST_TIMESTAMP,
		nonce: REQUEST_NONCE,
		bodyBytes,
		publicKey,
		deviceId: "key-id-test-device",
		signature: `v2:${sign(null, canonical, privateKey).toString("base64")}`,
	};
}

describe("canonical Ed25519 key identity (preparation only)", () => {
	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(REQUEST_TIME_MS);
	});
	afterEach(() => vi.restoreAllMocks());

	it("pins the standard 51-byte SSH blob and independent SHA-256 fixture", async () => {
		// Arrange
		const expectedBlob = wireBytes();
		// Act
		const parsed = parseSshEd25519PublicKey(CANONICAL_PUBLIC_KEY);
		const id = await ed25519KeyId(CANONICAL_PUBLIC_KEY);
		const nodeHash = createHash("sha256").update(expectedBlob).digest("hex");
		const webHash = Buffer.from(
			await crypto.subtle.digest("SHA-256", Uint8Array.from(expectedBlob)),
		).toString("hex");
		// Assert
		expect(parsed).toEqual({ kind: "ed25519", blob: expectedBlob });
		expect(expectedBlob).toHaveLength(51);
		expect([id, nodeHash, webHash]).toEqual([EXPECTED_KEY_ID, EXPECTED_KEY_ID, EXPECTED_KEY_ID]);
		expect(id).toMatch(/^[0-9a-f]{64}$/);
	});

	it.each(ACCEPTED_ALIASES)(
		"Node verifies $name with the same canonical identity",
		async ({ publicKey }) => {
			// Arrange
			const request = signedRequest(publicKey);
			// Act
			const valid = verifySignature(request);
			const parsed = parseSshEd25519PublicKey(publicKey);
			const id = await ed25519KeyId(publicKey);
			// Assert
			expect(valid).toBe(true);
			expect(parsed).toEqual({ kind: "ed25519", blob: wireBytes() });
			expect(id).toBe(EXPECTED_KEY_ID);
		},
	);

	it.each(MALFORMED_KEYS)(
		"rejects $name without throwing or assigning an identity",
		async ({ publicKey }) => {
			// Arrange
			const request = signedRequest(publicKey);
			// Act
			const parsed = parseSshEd25519PublicKey(publicKey);
			const id = await ed25519KeyId(publicKey);
			const valid = verifySignature(request);
			// Assert
			expect(parsed).toEqual({ kind: "malformed_ed25519" });
			expect(id).toBeNull();
			expect(valid).toBe(false);
		},
	);

	it.each(OTHER_KEYS)("classifies non-Ed25519 input %j separately", async (publicKey) => {
		// Arrange
		const request = signedRequest(publicKey);
		// Act
		const parsed = parseSshEd25519PublicKey(publicKey);
		const id = await ed25519KeyId(publicKey);
		const valid = verifySignature(request);
		// Assert
		expect(parsed).toEqual({ kind: "other" });
		expect(id).toBeNull();
		expect(valid).toBe(false);
	});

	it.each(NODE_ONLY_ALIASES)(
		"records Node-only $name acceptance without activating it in the portable parser",
		async ({ publicKey }) => {
			// Arrange
			const request = signedRequest(publicKey);
			// Act
			const valid = verifySignature(request);
			const parsed = parseSshEd25519PublicKey(publicKey);
			const id = await ed25519KeyId(publicKey);
			// Assert - Buffer is permissive; Worker atob is not. No verifier policy changes.
			expect(valid).toBe(true);
			expect(parsed).toEqual({ kind: "malformed_ed25519" });
			expect(id).toBeNull();
		},
	);

	it.each(ACCEPTED_ALIASES.filter(({ publicKey }) => publicKey !== CANONICAL_PUBLIC_KEY))(
		"preserves the distinct legacy whole-string fingerprint for $name",
		async ({ publicKey }) => {
			// Arrange
			const original = fingerprintPublicKey(CANONICAL_PUBLIC_KEY);
			// Act
			const fingerprint = fingerprintPublicKey(publicKey);
			const id = await ed25519KeyId(publicKey);
			// Assert
			expect(fingerprint).toBe(createHash("sha256").update(publicKey, "utf8").digest("hex"));
			expect(fingerprint).not.toBe(original);
			expect(id).toBe(EXPECTED_KEY_ID);
		},
	);

	it("owns each returned blob so caller mutation cannot corrupt subsequent results", async () => {
		// Arrange
		const first = parseSshEd25519PublicKey(CANONICAL_PUBLIC_KEY);
		if (first.kind !== "ed25519") throw new Error("expected fixture key");
		// Act
		first.blob.fill(0);
		const second = parseSshEd25519PublicKey(CANONICAL_PUBLIC_KEY);
		const id = await ed25519KeyId(CANONICAL_PUBLIC_KEY);
		// Assert
		expect(second).toEqual({ kind: "ed25519", blob: wireBytes() });
		if (second.kind === "ed25519") expect(second.blob).not.toBe(first.blob);
		expect(id).toBe(EXPECTED_KEY_ID);
	});

	it("keeps different raw public keys distinct and rejects signatures from the original key", async () => {
		// Arrange
		const changedBlob = wireBytes();
		changedBlob[19] = (changedBlob[19] ?? 0) ^ 1;
		const publicKey = publicKeyFromWire(changedBlob);
		const request = signedRequest(publicKey);
		// Act
		const id = await ed25519KeyId(publicKey);
		const valid = verifySignature(request);
		// Assert
		expect(id).toBe(createHash("sha256").update(changedBlob).digest("hex"));
		expect(id).not.toBe(EXPECTED_KEY_ID);
		expect(valid).toBe(false);
	});

	it("rejects a changed signed body even when the public-key alias has the same identity", () => {
		// Arrange
		const request = signedRequest(`${CANONICAL_PUBLIC_KEY} changed-comment`);
		// Act
		const valid = verifySignature({ ...request, bodyBytes: Buffer.from("tampered") });
		// Assert
		expect(valid).toBe(false);
	});

	it("derives identity locally without calling fetch for valid or malformed input", async () => {
		// Arrange
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("network forbidden"));
		// Act
		const ids = await Promise.all([
			ed25519KeyId(CANONICAL_PUBLIC_KEY),
			ed25519KeyId("ssh-ed25519 $$$$"),
		]);
		// Assert
		expect(ids).toEqual([EXPECTED_KEY_ID, null]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
