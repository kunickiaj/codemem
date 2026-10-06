import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ed25519KeyId,
	parseSshEd25519PublicKey,
} from "../../core/src/coordinator-ed25519-key-id.js";
import {
	ed25519KeyIdForRevocation,
	parseSshEd25519PublicKeyForRevocation,
} from "../../core/src/coordinator-ed25519-key-id-compat.js";
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
	hexBytes,
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
} from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { verifyCloudflareCoordinatorRequest } from "../src/request-verifier.js";

async function signedRequest(publicKey: string) {
	// RFC 8032 public test seed, signed by native Worker WebCrypto, not a credential.
	const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		hexBytes(`302e020100300506032b657004220420${seed}`),
		{ name: "Ed25519" },
		false,
		["sign"],
	);
	const bodyBytes = new TextEncoder().encode(REQUEST_BODY);
	const bodyHash = Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bodyBytes)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
	const canonical = new TextEncoder().encode(
		[REQUEST_METHOD, REQUEST_PATH, REQUEST_TIMESTAMP, REQUEST_NONCE, bodyHash].join("\n"),
	);
	const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, canonical));
	return {
		method: REQUEST_METHOD,
		pathWithQuery: REQUEST_PATH,
		timestamp: REQUEST_TIMESTAMP,
		nonce: REQUEST_NONCE,
		bodyBytes,
		publicKey,
		deviceId: "key-id-test-device",
		signature: `v2:${btoa(String.fromCharCode(...signature))}`,
	};
}

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(REQUEST_TIME_MS));
afterEach(() => vi.restoreAllMocks());

describe("native Worker revocation metadata decoder compatibility", () => {
	it.each(ACCEPTED_ALIASES)(
		"preserves strict identity and Worker verification for $name",
		async ({ publicKey }) => {
			// Arrange
			const request = await signedRequest(publicKey);
			// Act
			const parsed = parseSshEd25519PublicKeyForRevocation(publicKey);
			const strict = parseSshEd25519PublicKey(publicKey);
			const ids = await Promise.all([
				ed25519KeyIdForRevocation(publicKey),
				ed25519KeyId(publicKey),
			]);
			const valid = await verifyCloudflareCoordinatorRequest(request);
			// Assert
			expect(parsed).toEqual({ kind: "ed25519", blob: wireBytes() });
			expect(parsed).toEqual(strict);
			expect(ids).toEqual([EXPECTED_KEY_ID, EXPECTED_KEY_ID]);
			expect(valid).toBe(true);
		},
	);

	it.each(NODE_ONLY_ALIASES)(
		"native Worker Buffer accepts $name metadata but real verifier denies authentication",
		async ({ publicKey }) => {
			// Arrange
			const request = await signedRequest(publicKey);
			const encoded = publicKey.split(/\s+/)[1] ?? "";
			// Act
			const nativeBytes = Buffer.from(encoded, "base64");
			const parsed = parseSshEd25519PublicKeyForRevocation(publicKey);
			const strict = parseSshEd25519PublicKey(publicKey);
			const ids = await Promise.all([
				ed25519KeyIdForRevocation(publicKey),
				ed25519KeyId(publicKey),
			]);
			const valid = await verifyCloudflareCoordinatorRequest(request);
			// Assert - direct native evidence, not an assumed Node compatibility promise.
			expect(new Uint8Array(nativeBytes)).toEqual(wireBytes());
			expect(parsed).toEqual({ kind: "ed25519", blob: wireBytes() });
			expect(strict).toEqual({ kind: "malformed_ed25519" });
			expect(ids).toEqual([EXPECTED_KEY_ID, null]);
			expect(valid).toBe(false);
		},
	);

	it.each(MALFORMED_KEYS)(
		"rejects $name without throwing or assigning metadata",
		async ({ publicKey }) => {
			// Arrange
			const request = await signedRequest(publicKey);
			// Act
			const parsed = parseSshEd25519PublicKeyForRevocation(publicKey);
			const id = await ed25519KeyIdForRevocation(publicKey);
			const valid = await verifyCloudflareCoordinatorRequest(request);
			// Assert
			expect(parsed).toEqual({ kind: "malformed_ed25519" });
			expect(id).toBeNull();
			expect(valid).toBe(false);
		},
	);

	it.each(OTHER_KEYS)("keeps non-Ed25519 input %j separate", async (publicKey) => {
		// Arrange
		const request = await signedRequest(publicKey);
		// Act
		const parsed = parseSshEd25519PublicKeyForRevocation(publicKey);
		const id = await ed25519KeyIdForRevocation(publicKey);
		const valid = await verifyCloudflareCoordinatorRequest(request);
		// Assert
		expect(parsed).toEqual({ kind: "other" });
		expect(id).toBeNull();
		expect(valid).toBe(false);
	});
});

describe("native Worker metadata ownership and authentication separation", () => {
	it.each([...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES])(
		"owns returned metadata bytes for $name",
		async ({ publicKey }) => {
			// Arrange
			const first = parseSshEd25519PublicKeyForRevocation(publicKey);
			if (first.kind !== "ed25519") throw new Error("expected fixture key");
			// Act
			first.blob.fill(0);
			const second = parseSshEd25519PublicKeyForRevocation(publicKey);
			const id = await ed25519KeyIdForRevocation(publicKey);
			// Assert
			expect(second).toEqual({ kind: "ed25519", blob: wireBytes() });
			if (second.kind === "ed25519") expect(second.blob).not.toBe(first.blob);
			expect(id).toBe(EXPECTED_KEY_ID);
		},
	);

	it("keeps changed raw keys distinct and rejects the original signature", async () => {
		// Arrange
		const changedBlob = wireBytes();
		changedBlob[19] = (changedBlob[19] ?? 0) ^ 1;
		const publicKey = publicKeyFromWire(changedBlob);
		const request = await signedRequest(publicKey);
		const expectedHash = Array.from(
			new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(changedBlob))),
			(byte) => byte.toString(16).padStart(2, "0"),
		).join("");
		// Act
		const id = await ed25519KeyIdForRevocation(publicKey);
		const valid = await verifyCloudflareCoordinatorRequest(request);
		// Assert
		expect(id).toBe(expectedHash);
		expect(id).not.toBe(EXPECTED_KEY_ID);
		expect(valid).toBe(false);
	});

	it("rejects tampered signed bytes despite accepted alias metadata", async () => {
		// Arrange
		const publicKey = `${CANONICAL_PUBLIC_KEY} alias`;
		const request = await signedRequest(publicKey);
		// Act
		const valid = await verifyCloudflareCoordinatorRequest({
			...request,
			bodyBytes: new TextEncoder().encode("tampered"),
		});
		const id = await ed25519KeyIdForRevocation(publicKey);
		// Assert
		expect(valid).toBe(false);
		expect(id).toBe(EXPECTED_KEY_ID);
	});

	it("derives valid and malformed metadata locally without network access", async () => {
		// Arrange
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("network forbidden"));
		// Act
		const ids = await Promise.all([
			ed25519KeyIdForRevocation(CANONICAL_PUBLIC_KEY),
			ed25519KeyIdForRevocation("ssh-ed25519 $$$$"),
		]);
		// Assert
		expect(ids).toEqual([EXPECTED_KEY_ID, null]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
