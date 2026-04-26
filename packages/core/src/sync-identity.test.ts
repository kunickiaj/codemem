import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import {
	ensureDeviceIdentity,
	fingerprintPublicKey,
	generateKeypair,
	loadPrivateKey,
	loadPublicKey,
	resolveKeyPaths,
	validateExistingKeypair,
} from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sshKeygenAvailable(): boolean {
	try {
		if (process.platform === "win32") {
			execFileSync("where.exe", ["ssh-keygen"], { stdio: "pipe" });
		} else {
			execFileSync("which", ["ssh-keygen"], { stdio: "pipe" });
		}
		return true;
	} catch {
		return false;
	}
}

const HAS_SSH_KEYGEN = sshKeygenAvailable();

function slashPath(value: string): string {
	return value.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync-identity", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-sync-id-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// -- fingerprintPublicKey -----------------------------------------------

	describe("fingerprintPublicKey", () => {
		it("produces consistent SHA-256 hex", () => {
			const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey test@host";
			const fp1 = fingerprintPublicKey(key);
			const fp2 = fingerprintPublicKey(key);
			expect(fp1).toBe(fp2);
			expect(fp1).toMatch(/^[0-9a-f]{64}$/);
		});

		it("different keys produce different fingerprints", () => {
			const fp1 = fingerprintPublicKey("key-a");
			const fp2 = fingerprintPublicKey("key-b");
			expect(fp1).not.toBe(fp2);
		});
	});

	// -- resolveKeyPaths ----------------------------------------------------

	describe("resolveKeyPaths", () => {
		it("returns correct paths for custom dir", () => {
			const [priv, pub] = resolveKeyPaths("/tmp/mykeys");
			expect(slashPath(priv)).toBe("/tmp/mykeys/device.key");
			expect(slashPath(pub)).toBe("/tmp/mykeys/device.key.pub");
		});

		it("uses default dir when none provided", () => {
			const [priv, pub] = resolveKeyPaths();
			expect(priv).toContain("device.key");
			expect(pub).toContain("device.key.pub");
			expect(slashPath(priv)).toContain(".config/codemem/keys");
		});
	});

	// -- generateKeypair ----------------------------------------------------

	describe("generateKeypair", () => {
		it.skipIf(!HAS_SSH_KEYGEN)("creates key files on disk", () => {
			const keysDir = join(tmpDir, "keys");
			const [privPath, pubPath] = resolveKeyPaths(keysDir);
			generateKeypair(privPath, pubPath);

			const privContent = readFileSync(privPath, "utf-8");
			const pubContent = readFileSync(pubPath, "utf-8");
			expect(privContent).toContain("PRIVATE KEY");
			expect(pubContent).toMatch(/^ssh-ed25519 /);
		});

		it.skipIf(!HAS_SSH_KEYGEN)("is idempotent when keys exist", () => {
			const keysDir = join(tmpDir, "keys");
			const [privPath, pubPath] = resolveKeyPaths(keysDir);
			generateKeypair(privPath, pubPath);
			const pub1 = readFileSync(pubPath, "utf-8");
			// Second call should not regenerate
			generateKeypair(privPath, pubPath);
			const pub2 = readFileSync(pubPath, "utf-8");
			expect(pub1).toBe(pub2);
		});
	});

	// -- validateExistingKeypair --------------------------------------------

	describe("validateExistingKeypair", () => {
		it("returns false when files do not exist", () => {
			expect(validateExistingKeypair("/no/such/priv", "/no/such/pub")).toBe(false);
		});

		it.skipIf(!HAS_SSH_KEYGEN)("returns true for valid generated keypair", () => {
			const keysDir = join(tmpDir, "keys");
			const [privPath, pubPath] = resolveKeyPaths(keysDir);
			generateKeypair(privPath, pubPath);
			expect(validateExistingKeypair(privPath, pubPath)).toBe(true);
		});

		it("returns false for invalid public key content", () => {
			const keysDir = join(tmpDir, "keys-invalid");
			const [privPath, pubPath] = resolveKeyPaths(keysDir);
			mkdirSync(keysDir, { recursive: true });
			writeFileSync(privPath, "fake-private-key\n");
			writeFileSync(pubPath, "not-a-valid-key\n");
			expect(validateExistingKeypair(privPath, pubPath)).toBe(false);
		});
	});

	// -- loadPublicKey / loadPrivateKey --------------------------------------

	describe("loadPublicKey", () => {
		it("returns null when file does not exist", () => {
			expect(loadPublicKey(join(tmpDir, "nope"))).toBeNull();
		});

		it.skipIf(!HAS_SSH_KEYGEN)("reads generated public key", () => {
			const keysDir = join(tmpDir, "keys");
			const [privPath, pubPath] = resolveKeyPaths(keysDir);
			generateKeypair(privPath, pubPath);
			const key = loadPublicKey(keysDir);
			expect(key).toMatch(/^ssh-ed25519 /);
		});
	});

	describe("loadPrivateKey", () => {
		it("returns null when file does not exist", () => {
			expect(loadPrivateKey(join(tmpDir, "nope"))).toBeNull();
		});

		it.skipIf(!HAS_SSH_KEYGEN)("reads generated private key", () => {
			const keysDir = join(tmpDir, "keys");
			const [privPath, pubPath] = resolveKeyPaths(keysDir);
			generateKeypair(privPath, pubPath);
			const key = loadPrivateKey(keysDir);
			expect(key).not.toBeNull();
			expect(key?.toString("utf-8")).toContain("PRIVATE KEY");
		});
	});

	// -- ensureDeviceIdentity -----------------------------------------------

	describe("ensureDeviceIdentity", () => {
		function makeDb() {
			const dbPath = join(tmpDir, `test-${Date.now()}.sqlite`);
			const db = connect(dbPath);
			initTestSchema(db);
			return db;
		}

		it.skipIf(!HAS_SSH_KEYGEN)("creates new device in fresh DB", () => {
			const db = makeDb();
			const keysDir = join(tmpDir, "keys-new");
			try {
				const [deviceId, fingerprint] = ensureDeviceIdentity(db, { keysDir });
				expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
				expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

				// Verify DB row
				const row = db.prepare("SELECT device_id, fingerprint FROM sync_device LIMIT 1").get() as {
					device_id: string;
					fingerprint: string;
				};
				expect(row.device_id).toBe(deviceId);
				expect(row.fingerprint).toBe(fingerprint);
			} finally {
				db.close();
			}
		});

		it.skipIf(!HAS_SSH_KEYGEN)("returns existing device on second call", () => {
			const db = makeDb();
			const keysDir = join(tmpDir, "keys-existing");
			try {
				const [id1, fp1] = ensureDeviceIdentity(db, { keysDir });
				const [id2, fp2] = ensureDeviceIdentity(db, { keysDir });
				expect(id2).toBe(id1);
				expect(fp2).toBe(fp1);
			} finally {
				db.close();
			}
		});

		it.skipIf(!HAS_SSH_KEYGEN)("uses provided deviceId", () => {
			const db = makeDb();
			const keysDir = join(tmpDir, "keys-custom-id");
			const customId = "custom-device-id-123";
			try {
				const [deviceId] = ensureDeviceIdentity(db, { keysDir, deviceId: customId });
				expect(deviceId).toBe(customId);
			} finally {
				db.close();
			}
		});
	});
});
