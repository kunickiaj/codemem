export class RelayPublicKeyError extends Error {}

export interface ParsedRelayEd25519Key {
	readonly rawKey: Uint8Array;
	readonly wireKey: Uint8Array;
}

export function parseRelayEd25519PublicKey(publicKey: string): ParsedRelayEd25519Key {
	if (typeof publicKey !== "string" || hasInvalidControl(publicKey)) {
		throw new RelayPublicKeyError("Invalid SSH public key");
	}
	const match = /^ssh-ed25519[ \t]+([A-Za-z0-9+/]+={0,2})(?:[ \t]+[^\r\n]*)?$/.exec(publicKey);
	const encoded = match?.[1];
	if (encoded === undefined || encoded.length !== 68) {
		throw new RelayPublicKeyError("Invalid SSH public key encoding");
	}
	let wire: Uint8Array;
	try {
		const binary = atob(encoded);
		if (btoa(binary) !== encoded) throw new RelayPublicKeyError("Invalid SSH public key encoding");
		wire = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		throw new RelayPublicKeyError("Invalid SSH public key encoding");
	}
	if (wire.length !== 51) throw new RelayPublicKeyError("Invalid SSH public key wire format");
	const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
	const type = new TextDecoder().decode(wire.subarray(4, 15));
	if (view.getUint32(0) !== 11 || type !== "ssh-ed25519" || view.getUint32(15) !== 32) {
		throw new RelayPublicKeyError("Invalid SSH public key wire format");
	}
	return { rawKey: wire.slice(19), wireKey: wire };
}

function hasInvalidControl(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return (code < 32 && code !== 9) || code === 127;
	});
}

/** Key identity hashes the validated SSH blob, not SSH text or a proof of possession. */
export async function relayEd25519KeyId(publicKey: string): Promise<string> {
	const { wireKey } = parseRelayEd25519PublicKey(publicKey);
	try {
		const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(wireKey).buffer);
		return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		);
	} catch {
		throw new RelayPublicKeyError("Public key hashing failed");
	}
}
