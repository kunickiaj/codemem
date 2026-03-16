/**
 * Sync authentication: request signing, verification, and nonce management.
 *
 * Uses ssh-keygen for Ed25519 signature operations (sign/verify) and
 * SHA-256 canonical request hashing. Ported from codemem/sync_auth.py.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "./db.js";
import { loadPrivateKey, resolveKeyPaths } from "./sync-identity.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SIGNATURE_VERSION = "v1";
export const DEFAULT_TIME_WINDOW_S = 300;

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
 * Uses ssh-keygen -Y sign with the device's Ed25519 private key.
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

	const [privateKeyPath] = resolveKeyPaths(options.keysDir);
	let keyOverride: Buffer | null = null;
	if (!existsSync(privateKeyPath)) {
		const key = loadPrivateKey(options.keysDir);
		if (!key) {
			throw new Error("private key missing");
		}
		keyOverride = key;
	}

	const tmp = mkdtempSync(join(tmpdir(), "codemem-sign-"));
	try {
		const dataPath = join(tmp, "request");
		writeFileSync(dataPath, canonical);

		let signingKeyPath = privateKeyPath;
		if (keyOverride !== null) {
			const tempKey = join(tmp, "temp.key");
			writeFileSync(tempKey, keyOverride);
			chmodSync(tempKey, 0o600);
			signingKeyPath = tempKey;
		}

		execFileSync(
			"ssh-keygen",
			["-Y", "sign", "-f", signingKeyPath, "-n", "codemem-sync", dataPath],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);

		const sigPath = `${dataPath}.sig`;
		const signatureBytes = readFileSync(sigPath);
		const signature = signatureBytes.toString("base64");

		return {
			"X-Opencode-Timestamp": ts,
			"X-Opencode-Nonce": nonceValue,
			"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature}`,
		};
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
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
 * Checks timestamp freshness, signature version prefix, then delegates
 * to ssh-keygen -Y verify with an allowed_signers file.
 */
export function verifySignature(options: VerifySignatureOptions): boolean {
	const timeWindow = options.timeWindowS ?? DEFAULT_TIME_WINDOW_S;

	// Parse and validate timestamp — reject non-numeric strings (matches Python's int())
	if (!/^\d+$/.test(options.timestamp)) return false;
	const tsInt = Number.parseInt(options.timestamp, 10);
	if (Number.isNaN(tsInt)) return false;

	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - tsInt) > timeWindow) return false;

	// Validate signature version prefix
	const prefix = `${SIGNATURE_VERSION}:`;
	if (!options.signature.startsWith(prefix)) return false;

	const encoded = options.signature.slice(prefix.length);
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

	const tmp = mkdtempSync(join(tmpdir(), "codemem-verify-"));
	try {
		const keyPath = join(tmp, "allowed_signers");
		writeFileSync(keyPath, `${options.deviceId} ${options.publicKey}\n`);

		const sigPath = join(tmp, "request.sig");
		writeFileSync(sigPath, signatureBytes);

		execFileSync(
			"ssh-keygen",
			["-Y", "verify", "-f", keyPath, "-I", options.deviceId, "-n", "codemem-sync", "-s", sigPath],
			{ input: canonical, stdio: ["pipe", "pipe", "pipe"] },
		);
		// If execFileSync didn't throw, returncode is 0
		return true;
	} catch {
		return false;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Auth headers (convenience)
// ---------------------------------------------------------------------------

export interface BuildAuthHeadersOptions {
	deviceId: string;
	method: string;
	url: string;
	bodyBytes: Buffer;
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
	try {
		db.prepare("INSERT INTO sync_nonces(nonce, device_id, created_at) VALUES (?, ?, ?)").run(
			nonce,
			deviceId,
			createdAt,
		);
		return true;
	} catch (err: unknown) {
		// SQLite UNIQUE constraint violation
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
	db.prepare("DELETE FROM sync_nonces WHERE created_at < ?").run(cutoff);
}
