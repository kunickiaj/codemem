import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ed25519KeyId,
	parseSshEd25519PublicKey,
} from "../../core/src/coordinator-ed25519-key-id.js";
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
	// RFC 8032 public test seed, imported by native Worker WebCrypto, not Node APIs.
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
	// Existing v2 canonical UTF-8 method/path/timestamp/nonce/body hash, no request or DB calls.
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

describe("native Worker canonical Ed25519 identity preparation", () => {
	beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(REQUEST_TIME_MS));
	afterEach(() => vi.restoreAllMocks());

	it.each(ACCEPTED_ALIASES)(
		"Worker verifies $name with the pinned canonical identity",
		async ({ publicKey }) => {
			// Arrange
			const request = await signedRequest(publicKey);
			// Act
			const valid = await verifyCloudflareCoordinatorRequest(request);
			const parsed = parseSshEd25519PublicKey(publicKey);
			const id = await ed25519KeyId(publicKey);
			// Assert
			expect(valid).toBe(true);
			expect(parsed).toEqual({ kind: "ed25519", blob: wireBytes() });
			expect(id).toBe(EXPECTED_KEY_ID);
		},
	);

	it.each([...MALFORMED_KEYS, ...NODE_ONLY_ALIASES])(
		"Worker rejects $name rather than adopting Node's permissive decoder",
		async ({ publicKey }) => {
			// Arrange
			const request = await signedRequest(publicKey);
			// Act
			const valid = await verifyCloudflareCoordinatorRequest(request);
			const parsed = parseSshEd25519PublicKey(publicKey);
			const id = await ed25519KeyId(publicKey);
			// Assert
			expect(valid).toBe(false);
			expect(parsed).toEqual({ kind: "malformed_ed25519" });
			expect(id).toBeNull();
		},
	);

	it.each(OTHER_KEYS)(
		"Worker rejects non-SSH input %j with no canonical identity",
		async (publicKey) => {
			// Arrange
			const request = await signedRequest(publicKey);
			// Act
			const valid = await verifyCloudflareCoordinatorRequest(request);
			const parsed = parseSshEd25519PublicKey(publicKey);
			const id = await ed25519KeyId(publicKey);
			// Assert
			expect(valid).toBe(false);
			expect(parsed).toEqual({ kind: "other" });
			expect(id).toBeNull();
		},
	);

	it("keeps different raw keys distinct and rejects the original key's signature", async () => {
		// Arrange
		const changedBlob = wireBytes();
		changedBlob[19] = (changedBlob[19] ?? 0) ^ 1;
		const publicKey = publicKeyFromWire(changedBlob);
		const request = await signedRequest(publicKey);
		// Act
		const id = await ed25519KeyId(publicKey);
		const valid = await verifyCloudflareCoordinatorRequest(request);
		// Assert
		expect(id).toMatch(/^[0-9a-f]{64}$/);
		expect(id).not.toBe(EXPECTED_KEY_ID);
		expect(valid).toBe(false);
	});

	it("rejects tampered request bytes even for an accepted key alias", async () => {
		// Arrange
		const request = await signedRequest(`${CANONICAL_PUBLIC_KEY} alias`);
		// Act
		const valid = await verifyCloudflareCoordinatorRequest({
			...request,
			bodyBytes: new TextEncoder().encode("tampered"),
		});
		// Assert
		expect(valid).toBe(false);
	});

	it("hashes the canonical blob with native WebCrypto without network access", async () => {
		// Arrange
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("network forbidden"));
		const bytes = Uint8Array.from(wireBytes());
		// Act
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
		const ids = await Promise.all([
			ed25519KeyId(CANONICAL_PUBLIC_KEY),
			ed25519KeyId("ssh-ed25519 $$$$"),
		]);
		// Assert
		expect(bytes).toHaveLength(51);
		expect(hash).toBe(EXPECTED_KEY_ID);
		expect(ids).toEqual([EXPECTED_KEY_ID, null]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
