import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ed25519KeyId,
	parseSshEd25519PublicKey,
	parseSshEd25519PublicKeyWithDecoder,
} from "./coordinator-ed25519-key-id.js";
import {
	ed25519KeyIdForRevocation,
	parseSshEd25519PublicKeyForRevocation,
} from "./coordinator-ed25519-key-id-compat.js";
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
	// RFC 8032 public test seed, not an enrolled device credential.
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

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(REQUEST_TIME_MS));
afterEach(() => vi.restoreAllMocks());

describe("Node revocation metadata decoder compatibility", () => {
	it.each(ACCEPTED_ALIASES)(
		"preserves strict identity and Node verification for $name",
		async ({ publicKey }) => {
			// Arrange
			const request = signedRequest(publicKey);
			// Act
			const parsed = parseSshEd25519PublicKeyForRevocation(publicKey);
			const strict = parseSshEd25519PublicKey(publicKey);
			const ids = await Promise.all([
				ed25519KeyIdForRevocation(publicKey),
				ed25519KeyId(publicKey),
			]);
			const valid = verifySignature(request);
			// Assert
			expect(parsed).toEqual({ kind: "ed25519", blob: wireBytes() });
			expect(parsed).toEqual(strict);
			expect(ids).toEqual([EXPECTED_KEY_ID, EXPECTED_KEY_ID]);
			expect(valid).toBe(true);
		},
	);

	it.each(NODE_ONLY_ALIASES)(
		"native Buffer gives $name metadata without changing atob semantics",
		async ({ publicKey }) => {
			// Arrange
			const request = signedRequest(publicKey);
			const encoded = publicKey.split(/\s+/)[1] ?? "";
			// Act
			const nativeBytes = Buffer.from(encoded, "base64");
			const parsed = parseSshEd25519PublicKeyForRevocation(publicKey);
			const strict = parseSshEd25519PublicKey(publicKey);
			const ids = await Promise.all([
				ed25519KeyIdForRevocation(publicKey),
				ed25519KeyId(publicKey),
			]);
			const valid = verifySignature(request);
			// Assert - metadata acceptance is not a signature acceptance policy.
			expect(new Uint8Array(nativeBytes)).toEqual(wireBytes());
			expect(parsed).toEqual({ kind: "ed25519", blob: wireBytes() });
			expect(strict).toEqual({ kind: "malformed_ed25519" });
			expect(ids).toEqual([EXPECTED_KEY_ID, null]);
			expect(valid).toBe(true);
		},
	);

	it.each(MALFORMED_KEYS)(
		"rejects $name without throwing or assigning metadata",
		async ({ publicKey }) => {
			// Arrange
			const request = signedRequest(publicKey);
			// Act
			const parsed = parseSshEd25519PublicKeyForRevocation(publicKey);
			const id = await ed25519KeyIdForRevocation(publicKey);
			const valid = verifySignature(request);
			// Assert
			expect(parsed).toEqual({ kind: "malformed_ed25519" });
			expect(id).toBeNull();
			expect(valid).toBe(false);
		},
	);

	it.each(OTHER_KEYS)("keeps non-Ed25519 input %j separate", async (publicKey) => {
		// Arrange
		const request = signedRequest(publicKey);
		// Act
		const parsed = parseSshEd25519PublicKeyForRevocation(publicKey);
		const id = await ed25519KeyIdForRevocation(publicKey);
		const valid = verifySignature(request);
		// Assert
		expect(parsed).toEqual({ kind: "other" });
		expect(id).toBeNull();
		expect(valid).toBe(false);
	});
});

describe("revocation metadata ownership and legacy separation", () => {
	it.each([...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES])(
		"returns an owned canonical blob for $name",
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

	it.each([...ACCEPTED_ALIASES, ...NODE_ONLY_ALIASES])(
		"leaves the legacy raw fingerprint unchanged for $name",
		async ({ publicKey }) => {
			// Arrange
			const before = fingerprintPublicKey(publicKey);
			const expected = createHash("sha256").update(publicKey, "utf8").digest("hex");
			// Act
			const id = await ed25519KeyIdForRevocation(publicKey);
			const after = fingerprintPublicKey(publicKey);
			// Assert
			expect([before, after]).toEqual([expected, expected]);
			expect(after === fingerprintPublicKey(CANONICAL_PUBLIC_KEY)).toBe(
				publicKey === CANONICAL_PUBLIC_KEY,
			);
			expect(id).toBe(EXPECTED_KEY_ID);
		},
	);

	it("keeps changed raw keys distinct and rejects the original signature", async () => {
		// Arrange
		const changedBlob = wireBytes();
		changedBlob[19] = (changedBlob[19] ?? 0) ^ 1;
		const publicKey = publicKeyFromWire(changedBlob);
		const request = signedRequest(publicKey);
		// Act
		const id = await ed25519KeyIdForRevocation(publicKey);
		const valid = verifySignature(request);
		// Assert
		expect(id).toBe(createHash("sha256").update(changedBlob).digest("hex"));
		expect(id).not.toBe(EXPECTED_KEY_ID);
		expect(valid).toBe(false);
	});

	it("rejects a tampered body even when Node-only metadata matches", async () => {
		// Arrange
		const publicKey = NODE_ONLY_ALIASES[0]?.publicKey ?? CANONICAL_PUBLIC_KEY;
		const request = signedRequest(publicKey);
		// Act
		const valid = verifySignature({ ...request, bodyBytes: Buffer.from("tampered") });
		const id = await ed25519KeyIdForRevocation(publicKey);
		// Assert
		expect(valid).toBe(false);
		expect(id).toBe(EXPECTED_KEY_ID);
	});

	it("derives valid and malformed metadata without network access", async () => {
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

	it("copies a trusted decoder's input rather than exposing its backing buffer", () => {
		// Arrange
		const input = wireBytes();
		const snapshot = Uint8Array.from(input);
		// Act
		const parsed = parseSshEd25519PublicKeyWithDecoder(CANONICAL_PUBLIC_KEY, () => input);
		if (parsed.kind !== "ed25519") throw new Error("expected fixture key");
		parsed.blob.fill(0);
		// Assert
		expect(input).toEqual(snapshot);
		expect(parsed.blob).not.toBe(input);
	});

	it.each(["null", "error"])("classifies trusted decoder %s failure as malformed", (failure) => {
		// Arrange
		const decode = () => {
			if (failure === "error") throw new Error("fixture decode failure");
			return null;
		};
		// Act
		const parsed = parseSshEd25519PublicKeyWithDecoder(CANONICAL_PUBLIC_KEY, decode);
		// Assert
		expect(parsed).toEqual({ kind: "malformed_ed25519" });
	});
});
