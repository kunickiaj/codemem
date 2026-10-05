const CANONICAL_PROOF = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function encodeCoordinatorAuthProof32(bytes: Uint8Array): string {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
		throw new Error("auth_proof_invalid_input");
	}
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

export function decodeCoordinatorAuthProof32(value: unknown): Uint8Array<ArrayBuffer> | null {
	if (typeof value !== "string" || value.length !== 43 || !CANONICAL_PROOF.test(value)) {
		return null;
	}
	try {
		const binary = atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}=`);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		if (bytes.length !== 32 || encodeCoordinatorAuthProof32(bytes) !== value) return null;
		return bytes;
	} catch {
		return null;
	}
}

export async function hashCoordinatorAuthProofBytes32(bytes: Uint8Array): Promise<string> {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
		throw new Error("auth_proof_invalid_input");
	}
	// Own the input before the digest yields, including callers with shared memory.
	const owned = new Uint8Array(bytes);
	try {
		const digest = await globalThis.crypto.subtle.digest("SHA-256", owned);
		return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		);
	} catch {
		throw new Error("auth_proof_crypto_failed");
	}
}
