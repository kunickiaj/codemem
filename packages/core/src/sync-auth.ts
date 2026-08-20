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

/** Direct-peer-only recipient-bound signature version. */
export const DIRECT_PEER_SIGNATURE_VERSION = "v3";

function isValidRecipientId(recipientId: string): boolean {
	return (
		Boolean(recipientId.trim()) && recipientId === recipientId.trim() && !/[\r\n]/.test(recipientId)
	);
}

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

/**
 * Build the direct-peer v3 canonical request without changing the v2 bytes.
 * The recipient is the sixth field so the signature cannot be replayed to a
 * different peer.
 */
export function buildDirectPeerCanonicalRequest(
	method: string,
	pathWithQuery: string,
	timestamp: string,
	nonce: string,
	bodyBytes: Buffer,
	recipientId: string,
): Buffer {
	if (!isValidRecipientId(recipientId)) {
		throw new Error("recipientId must be a non-empty single-line value");
	}
	return Buffer.concat([
		buildCanonicalRequest(method, pathWithQuery, timestamp, nonce, bodyBytes),
		Buffer.from(`\n${recipientId}`, "utf-8"),
	]);
}

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

export interface SignRequestOptions {
	method: string;
	url: string;
	bodyBytes: Buffer;
	keysDir?: string;
	deviceId?: string;
	dbPath?: string;
	timestamp?: string;
	nonce?: string;
}

export interface SignedRequestHeaders {
	"X-Opencode-Timestamp": string;
	"X-Opencode-Nonce": string;
	"X-Opencode-Signature": string;
}

interface SigningKeyOptions {
	keysDir?: string;
	deviceId?: string;
	dbPath?: string;
}

function requestPath(url: string): string {
	const parsed = new URL(url);
	return `${parsed.pathname || "/"}${parsed.search}`;
}

function signCanonicalRequest(canonical: Buffer, options: SigningKeyOptions): string {
	const keyData = loadPrivateKey(options.keysDir, options.dbPath, options.deviceId);
	if (!keyData) throw new Error("private key missing");

	let privateKeyObj: ReturnType<typeof createPrivateKey>;
	try {
		privateKeyObj = createPrivateKey(keyData);
	} catch {
		privateKeyObj = createPrivateKey({ key: keyData, format: "pem", type: "pkcs8" });
	}
	return sign(null, canonical, privateKeyObj).toString("base64");
}

/**
 * Sign an HTTP request and return the auth headers.
 *
 * Uses Node's native Ed25519 crypto.sign() — no ssh-keygen shelling.
 * Returns X-Opencode-Timestamp, X-Opencode-Nonce, X-Opencode-Signature headers.
 */
export function signRequest(options: SignRequestOptions): SignedRequestHeaders {
	const ts = options.timestamp ?? String(Math.floor(Date.now() / 1000));
	const nonceValue = options.nonce ?? randomBytes(16).toString("hex");

	const path = requestPath(options.url);
	const canonical = buildCanonicalRequest(options.method, path, ts, nonceValue, options.bodyBytes);
	const signature = signCanonicalRequest(canonical, options);

	return {
		"X-Opencode-Timestamp": ts,
		"X-Opencode-Nonce": nonceValue,
		"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature}`,
	};
}

export interface SignDirectPeerRequestOptions
	extends Omit<SignRequestOptions, "timestamp" | "nonce"> {
	recipientId: string;
	timestamp: string;
	nonce: string;
}

export interface DirectPeerSignatureHeaders {
	"X-Codemem-Recipient": string;
	"X-Codemem-Signature": string;
}

/** Sign the isolated recipient-bound v3 material for a direct-peer request. */
export function signDirectPeerRequest(
	options: SignDirectPeerRequestOptions,
): DirectPeerSignatureHeaders {
	const path = requestPath(options.url);
	const canonical = buildDirectPeerCanonicalRequest(
		options.method,
		path,
		options.timestamp,
		options.nonce,
		options.bodyBytes,
		options.recipientId,
	);
	const signature = signCanonicalRequest(canonical, options);

	return {
		"X-Codemem-Recipient": options.recipientId,
		"X-Codemem-Signature": `${DIRECT_PEER_SIGNATURE_VERSION}:${signature}`,
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

function isFreshTimestamp(timestamp: string, timeWindowS: number): boolean {
	if (!/^\d+$/.test(timestamp)) return false;
	const seconds = Number.parseInt(timestamp, 10);
	return Math.abs(Math.floor(Date.now() / 1000) - seconds) <= timeWindowS;
}

function decodeStrictBase64(encoded: string): Buffer | undefined {
	if (!encoded) return undefined;
	const decoded = Buffer.from(encoded, "base64");
	return decoded.toString("base64") === encoded ? decoded : undefined;
}

/**
 * Verify a signed request.
 *
 * Checks timestamp freshness, signature version prefix, then uses
 * Node's native crypto.verify() with the sender's Ed25519 public key.
 */
export function verifySignature(options: VerifySignatureOptions): boolean {
	const timeWindow = options.timeWindowS ?? DEFAULT_TIME_WINDOW_S;

	if (!isFreshTimestamp(options.timestamp, timeWindow)) return false;

	// Validate signature version prefix — accept both v1 and v2 during migration
	const ACCEPTED_VERSIONS = ["v1", "v2"];
	const colonIdx = options.signature.indexOf(":");
	if (colonIdx < 1) return false;
	const sigVersion = options.signature.slice(0, colonIdx);
	if (!ACCEPTED_VERSIONS.includes(sigVersion)) return false;

	const signatureBytes = decodeStrictBase64(options.signature.slice(colonIdx + 1));
	if (!signatureBytes) return false;

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

export interface VerifyDirectPeerSignatureOptions {
	method: string;
	pathWithQuery: string;
	bodyBytes: Buffer;
	timestamp: string;
	nonce: string;
	recipientId?: string;
	expectedRecipientId: string;
	signature?: string;
	publicKey: string;
	timeWindowS?: number;
}

export type DirectPeerSignatureVerification =
	| { status: "absent" }
	| {
			status: "invalid";
			reason:
				| "incomplete_material"
				| "malformed_recipient"
				| "invalid_timestamp"
				| "unsupported_version"
				| "invalid_signature"
				| "recipient_mismatch";
	  }
	| { status: "valid"; version: "v3" };

/**
 * Verify direct-peer v3 material with an explicit absent/invalid distinction.
 * Callers may permit legacy v2 only for `absent`; any `invalid` result must fail
 * closed rather than falling back to the accompanying v2 signature.
 */
export function verifyDirectPeerSignature(
	options: VerifyDirectPeerSignatureOptions,
): DirectPeerSignatureVerification {
	const recipientId = options.recipientId === "" ? undefined : options.recipientId;
	const signature = options.signature === "" ? undefined : options.signature;
	if (recipientId === undefined && signature === undefined) {
		return { status: "absent" };
	}
	if (!recipientId || !signature) {
		return { status: "invalid", reason: "incomplete_material" };
	}
	if (!isValidRecipientId(recipientId)) {
		return { status: "invalid", reason: "malformed_recipient" };
	}
	const timeWindow = options.timeWindowS ?? DEFAULT_TIME_WINDOW_S;
	if (!isFreshTimestamp(options.timestamp, timeWindow)) {
		return { status: "invalid", reason: "invalid_timestamp" };
	}

	const prefix = `${DIRECT_PEER_SIGNATURE_VERSION}:`;
	if (!signature.startsWith(prefix)) {
		return { status: "invalid", reason: "unsupported_version" };
	}
	const signatureBytes = decodeStrictBase64(signature.slice(prefix.length));
	if (!signatureBytes) {
		return { status: "invalid", reason: "invalid_signature" };
	}

	const canonical = buildDirectPeerCanonicalRequest(
		options.method,
		options.pathWithQuery,
		options.timestamp,
		options.nonce,
		options.bodyBytes,
		recipientId,
	);
	try {
		const publicKeyObj = sshEd25519ToPublicKey(options.publicKey);
		if (!verify(null, canonical, publicKeyObj, signatureBytes)) {
			return { status: "invalid", reason: "invalid_signature" };
		}
	} catch {
		return { status: "invalid", reason: "invalid_signature" };
	}
	if (recipientId !== options.expectedRecipientId) {
		return { status: "invalid", reason: "recipient_mismatch" };
	}
	return {
		status: "valid",
		version: DIRECT_PEER_SIGNATURE_VERSION,
	};
}

/**
 * Parse an SSH ed25519 public key string into a Node crypto KeyObject.
 *
 * SSH format: "ssh-ed25519 <base64-wire-format>"
 * Wire format: uint32 key-type-len + key-type + uint32 key-data-len + key-data
 */
function sshEd25519ToPublicKey(sshPub: string): ReturnType<typeof createPublicKey> {
	const parts = sshPub.trim().split(/\s+/);
	const [keyType, keyData] = parts;
	if (keyType !== "ssh-ed25519" || !keyData) {
		throw new Error("not an ssh-ed25519 key");
	}
	const wireFormat = Buffer.from(keyData, "base64");

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
	dbPath?: string;
	timestamp?: string;
	nonce?: string;
}

export type AuthHeaders = Record<string, string> &
	SignedRequestHeaders & {
		"X-Opencode-Device": string;
	};

/**
 * Build full auth headers including device ID and request signature.
 */
export function buildAuthHeaders(options: BuildAuthHeadersOptions): AuthHeaders {
	return {
		"X-Opencode-Device": options.deviceId,
		...(options.bootstrapGrantId ? { "X-Codemem-Bootstrap-Grant": options.bootstrapGrantId } : {}),
		...signRequest({
			method: options.method,
			url: options.url,
			bodyBytes: options.bodyBytes,
			keysDir: options.keysDir,
			deviceId: options.deviceId,
			dbPath: options.dbPath,
			timestamp: options.timestamp,
			nonce: options.nonce,
		}),
	};
}

export interface BuildDirectPeerAuthHeadersOptions extends BuildAuthHeadersOptions {
	recipientId: string;
}

export type DirectPeerAuthHeaders = AuthHeaders & DirectPeerSignatureHeaders;

/** Build dual v2 + recipient-bound v3 headers for direct-peer requests only. */
export function buildDirectPeerAuthHeaders(
	options: BuildDirectPeerAuthHeadersOptions,
): DirectPeerAuthHeaders {
	const legacyHeaders = buildAuthHeaders(options);
	const directHeaders = signDirectPeerRequest({
		method: options.method,
		url: options.url,
		bodyBytes: options.bodyBytes,
		recipientId: options.recipientId,
		keysDir: options.keysDir,
		deviceId: options.deviceId,
		dbPath: options.dbPath,
		timestamp: legacyHeaders["X-Opencode-Timestamp"],
		nonce: legacyHeaders["X-Opencode-Nonce"],
	});

	return {
		...legacyHeaders,
		...directHeaders,
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
