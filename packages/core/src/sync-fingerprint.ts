import { createHash } from "node:crypto";

/** SHA-256 hex digest of a public key string. */
export function fingerprintPublicKey(publicKey: string): string {
	return createHash("sha256").update(publicKey, "utf-8").digest("hex");
}
