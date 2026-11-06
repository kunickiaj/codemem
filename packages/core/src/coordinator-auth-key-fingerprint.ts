const STORED_FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * Short form of a stored device key fingerprint (64 lowercase hex characters,
 * the SHA-256 of the public key) for people to compare between a browser and
 * a terminal: "SHA256:" + the first 8 + "..." + the last 8 characters. ASCII
 * only, so every terminal prints it exactly as the browser shows it.
 */
export function formatShortKeyFingerprint(fingerprint: string): string {
	if (typeof fingerprint !== "string" || !STORED_FINGERPRINT.test(fingerprint))
		throw new Error("key_fingerprint_invalid");
	return `SHA256:${fingerprint.slice(0, 8)}...${fingerprint.slice(-8)}`;
}
