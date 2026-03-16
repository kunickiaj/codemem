/**
 * Device identity management for the codemem sync system.
 *
 * Handles Ed25519 keypair generation, fingerprinting, and optional
 * keychain storage. Ported from codemem/sync_identity.py.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Database } from "./db.js";
import { connect as connectDb, resolveDbPath } from "./db.js";

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

function sshKeygenAvailable(): boolean {
	return cliAvailable("ssh-keygen");
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
		const row = conn.prepare("SELECT device_id FROM sync_device LIMIT 1").get() as
			| { device_id: string }
			| undefined;
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

/** Generate an Ed25519 keypair using ssh-keygen. */
export function generateKeypair(privatePath: string, publicPath: string): void {
	mkdirSync(dirname(privatePath), { recursive: true });
	if (existsSync(privatePath) && existsSync(publicPath)) return;
	if (!sshKeygenAvailable()) {
		throw new Error("ssh-keygen not available for key generation");
	}

	if (existsSync(privatePath) && !existsSync(publicPath)) {
		// Private key exists but public is missing — derive public from private
		try {
			const result = execFileSync("ssh-keygen", ["-y", "-f", privatePath], {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const derivedKey = (result ?? "").trim();
			if (derivedKey && publicKeyLooksValid(derivedKey)) {
				writeFileSync(publicPath, `${derivedKey}\n`, { mode: 0o644 });
				return;
			}
		} catch {
			// Derivation failed — fall through to full regeneration with backup
		}
		// Back up the orphaned private key before regenerating
		const stamp = new Date().toISOString().replace(/[:.]/g, "");
		renameSync(privatePath, `${privatePath}.orphan-${stamp}`);
	}

	execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", privatePath, "-q"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	chmodSync(privatePath, 0o600);
	if (!existsSync(publicPath)) {
		throw new Error("public key generation failed");
	}
}

/** Validate that an existing keypair is consistent. */
export function validateExistingKeypair(privatePath: string, publicPath: string): boolean {
	if (!existsSync(privatePath) || !existsSync(publicPath)) return false;
	const publicKey = readFileSync(publicPath, "utf-8").trim();
	if (!publicKey || !publicKeyLooksValid(publicKey)) return false;
	if (!sshKeygenAvailable()) return true;
	try {
		const derived = execFileSync("ssh-keygen", ["-y", "-f", privatePath], {
			stdio: ["pipe", "pipe", "pipe"],
			encoding: "utf-8",
		}).trim();
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
	const row = db
		.prepare("SELECT device_id, public_key, fingerprint FROM sync_device LIMIT 1")
		.get() as { device_id: string; public_key: string; fingerprint: string } | undefined;
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
			db.prepare("UPDATE sync_device SET public_key = ?, fingerprint = ? WHERE device_id = ?").run(
				publicKey,
				fingerprint,
				existingDeviceId,
			);
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
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
	).run(resolvedDeviceId, publicKey, fingerprint, now);
	if (keyStoreMode() === "keychain") {
		const privateKey = existsSync(privatePath) ? readFileSync(privatePath) : null;
		if (privateKey) {
			storePrivateKeyKeychain(privateKey, resolvedDeviceId);
		}
	}
	return [resolvedDeviceId, fingerprint];
}
