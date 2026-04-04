/**
 * Sync authentication: request signing, verification, and nonce management.
 *
 * Uses Node's native Ed25519 crypto for sign/verify and SHA-256 canonical
 * request hashing. No ssh-keygen shelling.
 */

import {
	createHash,
	createPrivateKey,
	createPublicKey,
	randomBytes,
	sign,
	verify,
} from "node:crypto";
import { lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import * as schema from "./schema.js";
import { DEFAULT_TIME_WINDOW_S } from "./sync-auth-constants.js";
import { loadPrivateKey } from "./sync-identity.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Signature version.  v1 = SSHSIG format (ssh-keygen era), v2 = raw Ed25519.
 *
 * v2 is a breaking change: Python peers using `ssh-keygen -Y verify` cannot
 * verify v2 signatures.  Once all peers run the TS runtime, v1 support can
 * be removed.  During migration, the verifier accepts both versions.
 */
export const SIGNATURE_VERSION = "v2";

// ---------------------------------------------------------------------------
// Canonical request
// ---------------------------------------------------------------------------

/**
 * Build a canonical request buffer for signing/verification.
 *
 * SHA-256 hashes the body, then joins method/path/timestamp/nonce/bodyHash
 * with newlines and returns the UTF-8 encoded result.
 */
export function buildCanonicalRequest(
	method: string,
	pathWithQuery: string,
	timestamp: string,
	nonce: string,
	bodyBytes: Buffer,
): Buffer {
	const bodyHash = createHash("sha256").update(bodyBytes).digest("hex");
	const canonical = [method.toUpperCase(), pathWithQuery, timestamp, nonce, bodyHash].join("\n");
	return Buffer.from(canonical, "utf-8");
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

export interface SignRequestOptions {
	method: string;
	url: string;
	bodyBytes: Buffer;
	keysDir?: string;
	timestamp?: string;
	nonce?: string;
}

/**
 * Sign an HTTP request and return the auth headers.
 *
 * Uses Node's native Ed25519 crypto.sign() — no ssh-keygen shelling.
 * Returns X-Opencode-Timestamp, X-Opencode-Nonce, X-Opencode-Signature headers.
 */
export function signRequest(options: SignRequestOptions): Record<string, string> {
	const ts = options.timestamp ?? String(Math.floor(Date.now() / 1000));
	const nonceValue = options.nonce ?? randomBytes(16).toString("hex");

	const parsed = new URL(options.url);
	let path = parsed.pathname || "/";
	if (parsed.search) {
		path = `${path}${parsed.search}`;
	}

	const canonical = buildCanonicalRequest(options.method, path, ts, nonceValue, options.bodyBytes);

	const keyData = loadPrivateKey(options.keysDir);
	if (!keyData) {
		throw new Error("private key missing");
	}

	// Handle both OpenSSH format (existing keys) and PKCS8 PEM (newly generated)
	let privateKeyObj: ReturnType<typeof createPrivateKey>;
	try {
		privateKeyObj = createPrivateKey(keyData);
	} catch {
		privateKeyObj = createPrivateKey({ key: keyData, format: "pem", type: "pkcs8" });
	}
	const signatureBytes = sign(null, canonical, privateKeyObj);
	const signature = signatureBytes.toString("base64");

	return {
		"X-Opencode-Timestamp": ts,
		"X-Opencode-Nonce": nonceValue,
		"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature}`,
	};
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export interface VerifySignatureOptions {
	method: string;
	pathWithQuery: string;
	bodyBytes: Buffer;
	timestamp: string;
	nonce: string;
	signature: string;
	publicKey: string;
	deviceId: string;
	timeWindowS?: number;
}

/**
 * Verify a signed request.
 *
 * Checks timestamp freshness, signature version prefix, then uses
 * Node's native crypto.verify() with the sender's Ed25519 public key.
 */
export function verifySignature(options: VerifySignatureOptions): boolean {
	const timeWindow = options.timeWindowS ?? DEFAULT_TIME_WINDOW_S;

	// Parse and validate timestamp — reject non-numeric strings (matches Python's int())
	if (!/^\d+$/.test(options.timestamp)) return false;
	const tsInt = Number.parseInt(options.timestamp, 10);
	if (Number.isNaN(tsInt)) return false;

	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - tsInt) > timeWindow) return false;

	// Validate signature version prefix — accept both v1 and v2 during migration
	const ACCEPTED_VERSIONS = ["v1", "v2"];
	const colonIdx = options.signature.indexOf(":");
	if (colonIdx < 1) return false;
	const sigVersion = options.signature.slice(0, colonIdx);
	if (!ACCEPTED_VERSIONS.includes(sigVersion)) return false;

	const encoded = options.signature.slice(colonIdx + 1);
	if (!encoded) return false;

	let signatureBytes: Buffer;
	try {
		signatureBytes = Buffer.from(encoded, "base64");
		// Verify it was valid base64 by round-tripping
		if (signatureBytes.toString("base64") !== encoded) return false;
	} catch {
		return false;
	}

	const canonical = buildCanonicalRequest(
		options.method,
		options.pathWithQuery,
		options.timestamp,
		options.nonce,
		options.bodyBytes,
	);

	try {
		const publicKeyObj = sshEd25519ToPublicKey(options.publicKey);
		return verify(null, canonical, publicKeyObj, signatureBytes);
	} catch {
		return false;
	}
}

/**
 * Parse an SSH ed25519 public key string into a Node crypto KeyObject.
 *
 * SSH format: "ssh-ed25519 <base64-wire-format>"
 * Wire format: uint32 key-type-len + key-type + uint32 key-data-len + key-data
 */
function sshEd25519ToPublicKey(sshPub: string): ReturnType<typeof createPublicKey> {
	const parts = sshPub.trim().split(/\s+/);
	if (parts.length < 2 || parts[0] !== "ssh-ed25519") {
		throw new Error("not an ssh-ed25519 key");
	}
	const wireFormat = Buffer.from(parts[1]!, "base64");

	// Read key type length
	if (wireFormat.length < 4) throw new Error("truncated wire format");
	const typeLen = wireFormat.readUInt32BE(0);
	const typeEnd = 4 + typeLen;
	if (wireFormat.length < typeEnd + 4) throw new Error("truncated wire format");

	// Read key data length
	const keyLen = wireFormat.readUInt32BE(typeEnd);
	const keyStart = typeEnd + 4;
	if (wireFormat.length < keyStart + keyLen) throw new Error("truncated wire format");
	const rawKey = wireFormat.subarray(keyStart, keyStart + keyLen);

	if (rawKey.length !== 32) throw new Error(`unexpected Ed25519 key length: ${rawKey.length}`);

	// Wrap raw 32-byte key in SPKI DER: 12-byte Ed25519 header + 32-byte key
	const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
	const spkiDer = Buffer.concat([ed25519SpkiPrefix, rawKey]);

	return createPublicKey({ key: spkiDer, format: "der", type: "spki" });
}

// ---------------------------------------------------------------------------
// Auth headers (convenience)
// ---------------------------------------------------------------------------

export interface BuildAuthHeadersOptions {
	deviceId: string;
	method: string;
	url: string;
	bodyBytes: Buffer;
	bootstrapGrantId?: string;
	keysDir?: string;
	timestamp?: string;
	nonce?: string;
}

/**
 * Build full auth headers including device ID and request signature.
 */
export function buildAuthHeaders(options: BuildAuthHeadersOptions): Record<string, string> {
	return {
		"X-Opencode-Device": options.deviceId,
		...(options.bootstrapGrantId ? { "X-Codemem-Bootstrap-Grant": options.bootstrapGrantId } : {}),
		...signRequest({
			method: options.method,
			url: options.url,
			bodyBytes: options.bodyBytes,
			keysDir: options.keysDir,
			timestamp: options.timestamp,
			nonce: options.nonce,
		}),
	};
}

// ---------------------------------------------------------------------------
// Nonce management
// ---------------------------------------------------------------------------

/**
 * Record a nonce to prevent replay attacks.
 *
 * Returns true on success, false if the nonce was already recorded
 * (duplicate = potential replay).
 */
export function recordNonce(
	db: Database,
	deviceId: string,
	nonce: string,
	createdAt: string,
): boolean {
	const d = drizzle(db, { schema });
	try {
		d.insert(schema.syncNonces).values({ nonce, device_id: deviceId, created_at: createdAt }).run();
		return true;
	} catch (err: unknown) {
		if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
			return false;
		}
		throw err;
	}
}

/**
 * Remove nonces older than the given cutoff timestamp.
 */
export function cleanupNonces(db: Database, cutoff: string): void {
	const d = drizzle(db, { schema });
	d.delete(schema.syncNonces).where(lt(schema.syncNonces.created_at, cutoff)).run();
}
