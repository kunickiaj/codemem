/**
 * Device identity management for the codemem sync system.
 *
 * Handles Ed25519 keypair generation, fingerprinting, and optional
 * keychain storage. Ported from codemem/sync_identity.py.
 */

import { execFileSync } from "node:child_process";
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomUUID,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database } from "./db.js";
import { connect as connectDb, resolveDbPath } from "./db.js";
import * as schema from "./schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_KEYS_DIR = join(homedir(), ".config", "codemem", "keys");
const PRIVATE_KEY_NAME = "device.key";
const PUBLIC_KEY_NAME = "device.key.pub";
const KEYCHAIN_SERVICE = "codemem-sync";

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a public key string. */
export function fingerprintPublicKey(publicKey: string): string {
	return createHash("sha256").update(publicKey, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Key store mode
// ---------------------------------------------------------------------------

function keyStoreMode(): "file" | "keychain" {
	const env = process.env.CODEMEM_SYNC_KEY_STORE?.toLowerCase();
	if (env === "keychain") return "keychain";
	return "file";
}

// ---------------------------------------------------------------------------
// CLI availability helpers
// ---------------------------------------------------------------------------

function cliAvailable(cmd: string): boolean {
	try {
		execFileSync("which", [cmd], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Keychain storage (platform-specific)
// ---------------------------------------------------------------------------

function warnKeychainLimitations(): void {
	if (process.platform !== "darwin") return;
	if (keyStoreMode() !== "keychain") return;
	if (process.env.CODEMEM_SYNC_KEYCHAIN_WARN === "0") return;
	console.warn(
		"[codemem] keychain storage on macOS uses the `security` CLI and may expose the key in process arguments.",
	);
}

/** Store a private key in the OS keychain. Returns true on success. */
export function storePrivateKeyKeychain(privateKey: Buffer, deviceId: string): boolean {
	if (process.platform === "linux") {
		if (!cliAvailable("secret-tool")) return false;
		try {
			execFileSync(
				"secret-tool",
				["store", "--label", "codemem sync key", "service", KEYCHAIN_SERVICE, "account", deviceId],
				{ input: privateKey, stdio: ["pipe", "pipe", "pipe"] },
			);
			return true;
		} catch {
			return false;
		}
	}
	if (process.platform === "darwin") {
		if (!cliAvailable("security")) return false;
		try {
			execFileSync(
				"security",
				[
					"add-generic-password",
					"-a",
					deviceId,
					"-s",
					KEYCHAIN_SERVICE,
					"-w",
					privateKey.toString("utf-8"),
					"-U",
				],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

/** Load a private key from the OS keychain. Returns null if unavailable. */
export function loadPrivateKeyKeychain(deviceId: string): Buffer | null {
	if (process.platform === "linux") {
		if (!cliAvailable("secret-tool")) return null;
		try {
			const out = execFileSync(
				"secret-tool",
				["lookup", "service", KEYCHAIN_SERVICE, "account", deviceId],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			return Buffer.from(out);
		} catch {
			return null;
		}
	}
	if (process.platform === "darwin") {
		if (!cliAvailable("security")) return null;
		try {
			const out = execFileSync(
				"security",
				["find-generic-password", "-a", deviceId, "-s", KEYCHAIN_SERVICE, "-w"],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			return Buffer.from(out);
		} catch {
			return null;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Key path resolution
// ---------------------------------------------------------------------------

/** Resolve private and public key file paths. */
export function resolveKeyPaths(keysDir?: string): [string, string] {
	const dir = keysDir ?? DEFAULT_KEYS_DIR;
	return [join(dir, PRIVATE_KEY_NAME), join(dir, PUBLIC_KEY_NAME)];
}

// ---------------------------------------------------------------------------
// Key file I/O
// ---------------------------------------------------------------------------

/** Read the public key from disk. Returns null if missing or empty. */
export function loadPublicKey(keysDir?: string): string | null {
	const [, publicPath] = resolveKeyPaths(keysDir);
	if (!existsSync(publicPath)) return null;
	const content = readFileSync(publicPath, "utf-8").trim();
	return content || null;
}

/** Read the private key from disk (with keychain fallback). Returns null if unavailable. */
export function loadPrivateKey(keysDir?: string, dbPath?: string): Buffer | null {
	if (keyStoreMode() === "keychain") {
		const deviceId = loadDeviceId(dbPath);
		if (deviceId) {
			const keychainValue = loadPrivateKeyKeychain(deviceId);
			if (keychainValue) return keychainValue;
		}
	}
	const [privatePath] = resolveKeyPaths(keysDir);
	if (!existsSync(privatePath)) return null;
	return readFileSync(privatePath);
}

/** Load device_id from the database (for keychain lookups). */
function loadDeviceId(dbPath?: string): string | null {
	const path = resolveDbPath(dbPath);
	if (!existsSync(path)) return null;
	const conn = connectDb(path);
	try {
		const d = drizzle(conn, { schema });
		const row = d
			.select({ device_id: schema.syncDevice.device_id })
			.from(schema.syncDevice)
			.limit(1)
			.get();
		return row?.device_id ?? null;
	} finally {
		conn.close();
	}
}

// ---------------------------------------------------------------------------
// Key generation & validation
// ---------------------------------------------------------------------------

function publicKeyLooksValid(publicKey: string): boolean {
	const value = publicKey.trim();
	return (
		value.startsWith("ssh-ed25519 ") || value.startsWith("ssh-rsa ") || value.startsWith("ecdsa-")
	);
}

function backupInvalidKeyFile(path: string, stamp: string): void {
	if (!existsSync(path)) return;
	const backupPath = path.replace(/([^/]+)$/, `$1.invalid-${stamp}`);
	renameSync(path, backupPath);
}

/**
 * Generate an Ed25519 keypair using Node's native crypto.
 * Stores private key as PEM (PKCS8), public key as SSH format for compatibility.
 */
export function generateKeypair(privatePath: string, publicPath: string): void {
	mkdirSync(dirname(privatePath), { recursive: true });
	if (existsSync(privatePath) && existsSync(publicPath)) return;

	if (existsSync(privatePath) && !existsSync(publicPath)) {
		// Private key exists but public is missing — derive public from private
		try {
			const privKeyObj = loadPrivateKeyObject(privatePath);
			const pubKeyObj = createPublicKey(privKeyObj);
			const sshPub = pubKeyObj.export({ type: "spki", format: "der" });
			const sshPubStr = derToSshEd25519(sshPub);
			if (sshPubStr && publicKeyLooksValid(sshPubStr)) {
				writeFileSync(publicPath, `${sshPubStr}\n`, { mode: 0o644 });
				return;
			}
		} catch {
			// Derivation failed — fall through to full regeneration with backup
		}
		// Back up the orphaned private key before regenerating
		const stamp = new Date().toISOString().replace(/[:.]/g, "");
		renameSync(privatePath, `${privatePath}.orphan-${stamp}`);
	}

	const { publicKey, privateKey } = generateKeyPairSync("ed25519");

	// Export private key as PEM (PKCS8)
	const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
	writeFileSync(privatePath, privatePem, { mode: 0o600 });

	// Export public key as SSH wire format: "ssh-ed25519 <base64>"
	const pubDer = publicKey.export({ type: "spki", format: "der" });
	const sshPub = derToSshEd25519(pubDer);
	if (!sshPub) {
		throw new Error("failed to convert public key to SSH format");
	}
	writeFileSync(publicPath, `${sshPub}\n`, { mode: 0o644 });
}

/**
 * Convert a DER-encoded SPKI Ed25519 public key to SSH wire format.
 * The last 32 bytes of the DER are the raw Ed25519 public key.
 */
function derToSshEd25519(spkiDer: Buffer): string | null {
	// Ed25519 SPKI DER is 44 bytes: 12-byte header + 32-byte key
	if (spkiDer.length < 32) return null;
	const rawKey = spkiDer.subarray(spkiDer.length - 32);

	// SSH wire format: string "ssh-ed25519" + string <32-byte key>
	const keyType = Buffer.from("ssh-ed25519");
	const buf = Buffer.alloc(4 + keyType.length + 4 + rawKey.length);
	let offset = 0;
	buf.writeUInt32BE(keyType.length, offset);
	offset += 4;
	keyType.copy(buf, offset);
	offset += keyType.length;
	buf.writeUInt32BE(rawKey.length, offset);
	offset += 4;
	rawKey.copy(buf, offset);

	return `ssh-ed25519 ${buf.toString("base64")}`;
}

/**
 * Load a private key that may be in OpenSSH format (existing keys) or
 * PKCS8 PEM format (newly generated keys). Node's createPrivateKey
 * handles both transparently.
 */
function loadPrivateKeyObject(privatePath: string): ReturnType<typeof createPrivateKey> {
	const raw = readFileSync(privatePath);
	// Try PKCS8 PEM first (our generated format), then OpenSSH
	try {
		return createPrivateKey(raw);
	} catch {
		return createPrivateKey({ key: raw, format: "pem", type: "pkcs8" });
	}
}

/** Validate that an existing keypair is consistent. */
export function validateExistingKeypair(privatePath: string, publicPath: string): boolean {
	if (!existsSync(privatePath) || !existsSync(publicPath)) return false;
	const publicKey = readFileSync(publicPath, "utf-8").trim();
	if (!publicKey || !publicKeyLooksValid(publicKey)) return false;
	try {
		const privKeyObj = loadPrivateKeyObject(privatePath);
		const pubKeyObj = createPublicKey(privKeyObj);
		const pubDer = pubKeyObj.export({ type: "spki", format: "der" });
		const derived = derToSshEd25519(pubDer);
		if (!derived || !publicKeyLooksValid(derived)) return false;
		// Auto-fix mismatched public key file
		if (derived !== publicKey) {
			writeFileSync(publicPath, `${derived}\n`, "utf-8");
		}
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Main entry: ensure device identity
// ---------------------------------------------------------------------------

export interface EnsureDeviceIdentityOptions {
	keysDir?: string;
	deviceId?: string;
}

/**
 * Ensure this device has a keypair and a row in the sync_device table.
 *
 * Returns [deviceId, fingerprint]. Creates keys and DB row if missing,
 * validates and repairs if existing.
 */
export function ensureDeviceIdentity(
	db: Database,
	options?: EnsureDeviceIdentityOptions,
): [string, string] {
	const keysDir = options?.keysDir ?? DEFAULT_KEYS_DIR;
	const [privatePath, publicPath] = resolveKeyPaths(keysDir);
	warnKeychainLimitations();

	// Check for existing device row
	const d = drizzle(db, { schema });
	const row = d
		.select({
			device_id: schema.syncDevice.device_id,
			public_key: schema.syncDevice.public_key,
			fingerprint: schema.syncDevice.fingerprint,
		})
		.from(schema.syncDevice)
		.limit(1)
		.get();
	const existingDeviceId = row?.device_id ?? "";
	const existingPublicKey = row?.public_key ?? "";
	const existingFingerprint = row?.fingerprint ?? "";

	// Validate or regenerate keys
	let keysReady = existsSync(privatePath) && existsSync(publicPath);
	if (keysReady && !validateExistingKeypair(privatePath, publicPath)) {
		const stamp = new Date()
			.toISOString()
			.replace(/[-:T.Z]/g, "")
			.slice(0, 20);
		backupInvalidKeyFile(privatePath, stamp);
		backupInvalidKeyFile(publicPath, stamp);
		keysReady = false;
	}
	if (!keysReady) {
		generateKeypair(privatePath, publicPath);
	}

	const publicKey = readFileSync(publicPath, "utf-8").trim();
	if (!publicKey) {
		throw new Error("public key missing");
	}
	const fingerprint = fingerprintPublicKey(publicKey);
	const now = new Date().toISOString();

	// Update existing device row if keys changed
	if (existingDeviceId) {
		if (existingPublicKey !== publicKey || existingFingerprint !== fingerprint) {
			d.update(schema.syncDevice)
				.set({ public_key: publicKey, fingerprint })
				.where(eq(schema.syncDevice.device_id, existingDeviceId))
				.run();
		}
		if (keyStoreMode() === "keychain") {
			// Read key from file directly — don't go through loadPrivateKey
			// which would resolve device ID from the default DB
			const privateKey = existsSync(privatePath)
				? readFileSync(privatePath)
				: loadPrivateKeyKeychain(existingDeviceId);
			if (privateKey) {
				storePrivateKeyKeychain(privateKey, existingDeviceId);
			}
		}
		return [existingDeviceId, fingerprint];
	}

	// Insert new device row
	const resolvedDeviceId = options?.deviceId ?? randomUUID();
	d.insert(schema.syncDevice)
		.values({ device_id: resolvedDeviceId, public_key: publicKey, fingerprint, created_at: now })
		.run();
	if (keyStoreMode() === "keychain") {
		const privateKey = existsSync(privatePath) ? readFileSync(privatePath) : null;
		if (privateKey) {
			storePrivateKeyKeychain(privateKey, resolvedDeviceId);
		}
	}
	return [resolvedDeviceId, fingerprint];
}
