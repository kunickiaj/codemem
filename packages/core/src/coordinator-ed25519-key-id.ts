export type SshEd25519Parse =
	| { kind: "ed25519"; blob: Uint8Array }
	| { kind: "malformed_ed25519" }
	| { kind: "other" };

function decodeWire(encoded: string): Uint8Array | null {
	try {
		const binary = atob(encoded);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

function readRawKey(wire: Uint8Array): Uint8Array | null {
	if (wire.length < 4) return null;
	const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
	const typeEnd = 4 + view.getUint32(0);
	if (wire.length < typeEnd + 4) return null;
	const keyLength = view.getUint32(typeEnd);
	const keyStart = typeEnd + 4;
	if (keyLength !== 32 || wire.length < keyStart + keyLength) return null;
	return wire.subarray(keyStart, keyStart + keyLength);
}

function canonicalBlob(rawKey: Uint8Array): Uint8Array {
	const blob = new Uint8Array(51);
	const view = new DataView(blob.buffer);
	view.setUint32(0, 11);
	blob.set(new TextEncoder().encode("ssh-ed25519"), 4);
	view.setUint32(15, 32);
	blob.set(rawKey, 19);
	return blob;
}

/**
 * Internal string contract, not an authentication acceptance check. Like the
 * Worker verifier, skip the inner type bytes and ignore trailing wire bytes.
 * atob rejects some encodings accepted by Node's Buffer base64 decoder.
 */
export function parseSshEd25519PublicKey(publicKey: string): SshEd25519Parse {
	return parseSshEd25519PublicKeyWithDecoder(publicKey, decodeWire);
}

/** Internal trusted decoder seam; callers must not use it to decide authentication acceptance. */
export function parseSshEd25519PublicKeyWithDecoder(
	publicKey: string,
	decode: (encoded: string) => Uint8Array | null,
): SshEd25519Parse {
	if (typeof publicKey !== "string") return { kind: "other" };
	const [keyType, keyData] = publicKey.trim().split(/\s+/);
	if (keyType !== "ssh-ed25519") return { kind: "other" };
	if (!keyData) return { kind: "malformed_ed25519" };
	let wire: Uint8Array | null;
	try {
		wire = decode(keyData);
	} catch {
		return { kind: "malformed_ed25519" };
	}
	if (!wire) return { kind: "malformed_ed25519" };
	const rawKey = readRawKey(wire);
	if (!rawKey) return { kind: "malformed_ed25519" };
	return { kind: "ed25519", blob: canonicalBlob(rawKey) };
}

/** SHA-256 hex of the canonical SSH blob; leaves legacy text fingerprints unchanged. */
export async function ed25519KeyId(publicKey: string): Promise<string | null> {
	return hashEd25519KeyId(parseSshEd25519PublicKey(publicKey));
}

/** Internal canonical identity hash, not proof of key possession or authorization. */
export async function hashEd25519KeyId(parsed: SshEd25519Parse): Promise<string | null> {
	if (parsed.kind !== "ed25519") return null;
	// Copy to an owned ArrayBuffer for the portable Web Crypto BufferSource API.
	const bytes = new Uint8Array(parsed.blob);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.buffer);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
