import { Buffer } from "node:buffer";
import {
	hashEd25519KeyId,
	parseSshEd25519PublicKeyWithDecoder,
	type SshEd25519Parse,
} from "./coordinator-ed25519-key-id.js";

function decodeWireForRevocation(encoded: string): Uint8Array | null {
	try {
		return Buffer.from(encoded, "base64");
	} catch {
		return null;
	}
}

/** Metadata only: Buffer aliases do not expand signature acceptance or prove key possession. */
export function parseSshEd25519PublicKeyForRevocation(publicKey: string): SshEd25519Parse {
	return parseSshEd25519PublicKeyWithDecoder(publicKey, decodeWireForRevocation);
}

/** Canonical SSH identity for revocation metadata, not an authorization check. */
export async function ed25519KeyIdForRevocation(publicKey: string): Promise<string | null> {
	return hashEd25519KeyId(parseSshEd25519PublicKeyForRevocation(publicKey));
}
