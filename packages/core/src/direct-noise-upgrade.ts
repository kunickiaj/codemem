/**
 * Wire constants for direct sync over Noise. A client sends a signed
 * `GET /v1/noise?session=<32 hex>&opening=<64 hex>` with this Upgrade token.
 * The signature covers the exact target, so it binds the session ID and the
 * client's Noise Message A. The responder answers 101 only after verifying it.
 */
export const DIRECT_NOISE_UPGRADE_PROTOCOL = "codemem-peer-stream/1";

export const DIRECT_NOISE_PATH = "/v1/noise";

/** Noise prologue transport label for direct connections. Relay uses 1 and traversal 3. */
export const DIRECT_NOISE_TRANSPORT_LABEL = 2;

/** Origin of the HTTP exchanges inside a direct Noise stream. It is never dialed. */
export const DIRECT_NOISE_LOGICAL_ORIGIN = "https://direct.codemem.invalid";

const TARGET_PATTERN = /^\/v1\/noise\?session=([0-9a-f]{32})&opening=([0-9a-f]{64})$/;

export function directNoiseUpgradeTarget(sessionId: Uint8Array, openingDigest: string): string {
	const target = `${DIRECT_NOISE_PATH}?session=${Buffer.from(sessionId).toString("hex")}&opening=${openingDigest}`;
	if (!TARGET_PATTERN.test(target)) throw new Error("Invalid direct Noise upgrade target");
	return target;
}

/**
 * The session and opening digest from an upgrade target, or null unless the
 * target is exactly the canonical form. Extra, missing, reordered or
 * differently encoded parameters are refused, so one signature has one meaning.
 */
export function parseDirectNoiseUpgradeTarget(
	target: string | undefined,
): { sessionId: Uint8Array; openingDigest: string } | null {
	const match = typeof target === "string" ? TARGET_PATTERN.exec(target) : null;
	if (!match?.[1] || !match[2]) return null;
	return { sessionId: Uint8Array.from(Buffer.from(match[1], "hex")), openingDigest: match[2] };
}
