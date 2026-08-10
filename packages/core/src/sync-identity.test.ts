import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { signRequest, verifySignature } from "./sync-auth.js";
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
const HAS_KEYCHAIN_PLATFORM = process.platform === "darwin" || process.platform === "linux";

function slashPath(value: string): string {
	return value.replace(/\\/g, "/");
}

function installFakeKeychainCli(
	baseDir: string,
	keychainPath: string,
	expectedAccount: string,
): void {
	const binDir = join(baseDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const command = process.platform === "darwin" ? "security" : "secret-tool";
	const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args[0];
const keychainPath = ${JSON.stringify(keychainPath)};
const expectedAccount = ${JSON.stringify(expectedAccount)};
const accountFlag = command === "lookup" || command === "store" ? "account" : "-a";
const accountIndex = args.indexOf(accountFlag);
if (accountIndex < 0 || args[accountIndex + 1] !== expectedAccount) {
	process.exit(2);
}
if (command === "lookup" || command === "find-generic-password") {
	try {
		process.stdout.write(fs.readFileSync(keychainPath));
	} catch {
		process.exit(1);
	}
} else if (command === "store") {
	fs.writeFileSync(keychainPath, fs.readFileSync(0));
} else if (command === "add-generic-password") {
	const valueIndex = args.indexOf("-w");
	fs.writeFileSync(keychainPath, args[valueIndex + 1] || "");
} else {
	process.exit(1);
}
`;
	const commandPath = join(binDir, command);
	writeFileSync(commandPath, script);
	chmodSync(commandPath, 0o755);
	process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync-identity", () => {
	let tmpDir: string;
	let originalKeyStore: string | undefined;
	let originalKeychainWarning: string | undefined;
	let originalPath: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-sync-id-test-"));
		originalKeyStore = process.env.CODEMEM_SYNC_KEY_STORE;
		originalKeychainWarning = process.env.CODEMEM_SYNC_KEYCHAIN_WARN;
		originalPath = process.env.PATH;
	});

	afterEach(() => {
		if (originalKeyStore === undefined) delete process.env.CODEMEM_SYNC_KEY_STORE;
		else process.env.CODEMEM_SYNC_KEY_STORE = originalKeyStore;
		if (originalKeychainWarning === undefined) delete process.env.CODEMEM_SYNC_KEYCHAIN_WARN;
		else process.env.CODEMEM_SYNC_KEYCHAIN_WARN = originalKeychainWarning;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
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
			const dbPath = join(tmpDir, `test-${randomUUID()}.sqlite`);
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

		it("restores the same identity and signs coordinator and direct-peer requests", () => {
			const sourceDbPath = join(tmpDir, "source.sqlite");
			const sourceKeysDir = join(tmpDir, "source-keys");
			const sourceDb = connect(sourceDbPath);
			initTestSchema(sourceDb);
			const [sourceDeviceId, sourceFingerprint] = ensureDeviceIdentity(sourceDb, {
				keysDir: sourceKeysDir,
			});
			const sourcePublicKey = loadPublicKey(sourceKeysDir);
			sourceDb.close();
			if (!sourcePublicKey) throw new Error("expected source public key");

			const restoredDbPath = join(tmpDir, "restored.sqlite");
			const restoredKeysDir = join(tmpDir, "restored-keys");
			cpSync(sourceDbPath, restoredDbPath);
			cpSync(sourceKeysDir, restoredKeysDir, { recursive: true });

			const restoredDb = connect(restoredDbPath);
			try {
				const restoredIdentity = ensureDeviceIdentity(restoredDb, { keysDir: restoredKeysDir });
				expect(restoredIdentity).toEqual([sourceDeviceId, sourceFingerprint]);

				for (const url of [
					"https://coordinator.example.test/v1/presence",
					"https://peer.example.test/v1/status",
				]) {
					const timestamp = String(Math.floor(Date.now() / 1000));
					const bodyBytes = Buffer.from("{}");
					const headers = signRequest({
						method: "POST",
						url,
						bodyBytes,
						keysDir: restoredKeysDir,
						timestamp,
						nonce: `restore-${new URL(url).pathname}`,
					});
					expect(
						verifySignature({
							method: "POST",
							pathWithQuery: new URL(url).pathname,
							bodyBytes,
							timestamp: headers["X-Opencode-Timestamp"],
							nonce: headers["X-Opencode-Nonce"],
							signature: headers["X-Opencode-Signature"],
							publicKey: sourcePublicKey,
							deviceId: sourceDeviceId,
						}),
					).toBe(true);
				}
			} finally {
				restoredDb.close();
			}
		});

		it("recreates only the public key when the restored private key matches the database", () => {
			const db = makeDb();
			const keysDir = join(tmpDir, "keys-private-only");
			try {
				const originalIdentity = ensureDeviceIdentity(db, { keysDir });
				const [, publicPath] = resolveKeyPaths(keysDir);
				rmSync(publicPath);

				expect(ensureDeviceIdentity(db, { keysDir })).toEqual(originalIdentity);
				expect(loadPublicKey(keysDir)).toMatch(/^ssh-ed25519 /);
			} finally {
				db.close();
			}
		});

		it.skipIf(!HAS_KEYCHAIN_PLATFORM).each(["corrupt", "another identity"])(
			"prefers a matching restored key file over %s keychain material and repopulates the keychain",
			(keychainMaterial) => {
				const dbPath = join(tmpDir, "restored-keychain.sqlite");
				const db = connect(dbPath);
				initTestSchema(db);
				const keysDir = join(tmpDir, "keys-restored-keychain");
				const keychainPath = join(tmpDir, "keychain-value");
				try {
					const originalIdentity = ensureDeviceIdentity(db, { keysDir });
					const [privatePath] = resolveKeyPaths(keysDir);
					const restoredPrivateKey = readFileSync(privatePath);
					if (keychainMaterial === "corrupt") {
						writeFileSync(keychainPath, "not-a-private-key");
					} else {
						const unrelatedKeysDir = join(tmpDir, "keys-unrelated-keychain");
						const [unrelatedPrivatePath, unrelatedPublicPath] = resolveKeyPaths(unrelatedKeysDir);
						generateKeypair(unrelatedPrivatePath, unrelatedPublicPath);
						writeFileSync(keychainPath, readFileSync(unrelatedPrivatePath));
					}

					installFakeKeychainCli(tmpDir, keychainPath, originalIdentity[0]);
					process.env.CODEMEM_SYNC_KEY_STORE = "keychain";
					process.env.CODEMEM_SYNC_KEYCHAIN_WARN = "0";

					expect(loadPrivateKey(keysDir, dbPath, originalIdentity[0])).toEqual(restoredPrivateKey);
					expect(ensureDeviceIdentity(db, { keysDir })).toEqual(originalIdentity);
					expect(readFileSync(keychainPath)).toEqual(restoredPrivateKey);
				} finally {
					db.close();
				}
			},
		);

		it.skipIf(!HAS_KEYCHAIN_PLATFORM)(
			"uses a matching keychain key when a valid restored file belongs to another identity",
			() => {
				const db = makeDb();
				const keysDir = join(tmpDir, "keys-foreign-file-keychain");
				const unrelatedKeysDir = join(tmpDir, "keys-foreign-file-keychain-unrelated");
				const keychainPath = join(tmpDir, "keychain-value");
				try {
					const originalIdentity = ensureDeviceIdentity(db, { keysDir });
					const [privatePath] = resolveKeyPaths(keysDir);
					const originalPrivateKey = readFileSync(privatePath);
					const [unrelatedPrivatePath, unrelatedPublicPath] = resolveKeyPaths(unrelatedKeysDir);
					generateKeypair(unrelatedPrivatePath, unrelatedPublicPath);
					const unrelatedPrivateKey = readFileSync(unrelatedPrivatePath);
					writeFileSync(privatePath, unrelatedPrivateKey);
					writeFileSync(keychainPath, originalPrivateKey);
					installFakeKeychainCli(tmpDir, keychainPath, originalIdentity[0]);
					process.env.CODEMEM_SYNC_KEY_STORE = "keychain";
					process.env.CODEMEM_SYNC_KEYCHAIN_WARN = "0";

					expect(ensureDeviceIdentity(db, { keysDir })).toEqual(originalIdentity);
					expect(readFileSync(privatePath)).toEqual(unrelatedPrivateKey);
					expect(readFileSync(keychainPath)).toEqual(originalPrivateKey);
				} finally {
					db.close();
				}
			},
		);

		it.skipIf(!HAS_KEYCHAIN_PLATFORM)(
			"falls back to a valid keychain key when device.key is missing",
			() => {
				const dbPath = join(tmpDir, "keychain-only.sqlite");
				const db = connect(dbPath);
				initTestSchema(db);
				const keysDir = join(tmpDir, "keys-keychain-only");
				const keychainPath = join(tmpDir, "keychain-value");
				try {
					const originalIdentity = ensureDeviceIdentity(db, { keysDir });
					const [privatePath] = resolveKeyPaths(keysDir);
					const originalPrivateKey = readFileSync(privatePath);
					writeFileSync(keychainPath, originalPrivateKey);
					installFakeKeychainCli(tmpDir, keychainPath, originalIdentity[0]);
					process.env.CODEMEM_SYNC_KEY_STORE = "keychain";
					process.env.CODEMEM_SYNC_KEYCHAIN_WARN = "0";
					rmSync(privatePath);

					expect(loadPrivateKey(keysDir, dbPath)).toEqual(originalPrivateKey);
					expect(ensureDeviceIdentity(db, { keysDir })).toEqual(originalIdentity);
				} finally {
					db.close();
				}
			},
		);

		it.skipIf(!HAS_KEYCHAIN_PLATFORM).each(["corrupt", "non-Ed25519"])(
			"falls back to a valid keychain key when device.key is %s",
			(fileMaterial) => {
				const dbPath = join(tmpDir, "corrupt-file-keychain.sqlite");
				const db = connect(dbPath);
				initTestSchema(db);
				const keysDir = join(tmpDir, "keys-corrupt-file-keychain");
				const keychainPath = join(tmpDir, "keychain-value");
				try {
					const originalIdentity = ensureDeviceIdentity(db, { keysDir });
					const [privatePath] = resolveKeyPaths(keysDir);
					const originalPrivateKey = readFileSync(privatePath);
					writeFileSync(keychainPath, originalPrivateKey);
					installFakeKeychainCli(tmpDir, keychainPath, originalIdentity[0]);
					process.env.CODEMEM_SYNC_KEY_STORE = "keychain";
					process.env.CODEMEM_SYNC_KEYCHAIN_WARN = "0";
					if (fileMaterial === "corrupt") {
						writeFileSync(privatePath, "not-a-private-key");
					} else {
						const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
						writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }));
					}

					expect(loadPrivateKey(keysDir, dbPath)).toEqual(originalPrivateKey);
					expect(ensureDeviceIdentity(db, { keysDir })).toEqual(originalIdentity);
				} finally {
					db.close();
				}
			},
		);

		it.skipIf(!HAS_KEYCHAIN_PLATFORM)(
			"falls back to a matching keychain key when device.key cannot be read",
			() => {
				const dbPath = join(tmpDir, "unreadable-file-keychain.sqlite");
				const db = connect(dbPath);
				initTestSchema(db);
				const keysDir = join(tmpDir, "keys-unreadable-file-keychain");
				const keychainPath = join(tmpDir, "keychain-value");
				try {
					const originalIdentity = ensureDeviceIdentity(db, { keysDir });
					const [privatePath] = resolveKeyPaths(keysDir);
					const originalPrivateKey = readFileSync(privatePath);
					writeFileSync(keychainPath, originalPrivateKey);
					installFakeKeychainCli(tmpDir, keychainPath, originalIdentity[0]);
					process.env.CODEMEM_SYNC_KEY_STORE = "keychain";
					process.env.CODEMEM_SYNC_KEYCHAIN_WARN = "0";
					rmSync(privatePath);
					mkdirSync(privatePath);

					expect(loadPrivateKey(keysDir, dbPath, originalIdentity[0])).toEqual(originalPrivateKey);
					expect(ensureDeviceIdentity(db, { keysDir })).toEqual(originalIdentity);
				} finally {
					db.close();
				}
			},
		);

		it("accepts a matching stored public key with an SSH comment", () => {
			const db = makeDb();
			const keysDir = join(tmpDir, "keys-commented-public");
			try {
				const [deviceId] = ensureDeviceIdentity(db, { keysDir });
				const publicKey = loadPublicKey(keysDir);
				if (!publicKey) throw new Error("expected public key");
				const commentedPublicKey = `${publicKey} restored@example.test`;
				const fingerprint = fingerprintPublicKey(commentedPublicKey);
				const [, publicPath] = resolveKeyPaths(keysDir);
				writeFileSync(publicPath, `${commentedPublicKey}\n`);
				db.prepare(
					"UPDATE sync_device SET public_key = ?, fingerprint = ? WHERE device_id = ?",
				).run(commentedPublicKey, fingerprint, deviceId);

				expect(ensureDeviceIdentity(db, { keysDir })).toEqual([deviceId, fingerprint]);
				expect(loadPublicKey(keysDir)).toBe(commentedPublicKey);
			} finally {
				db.close();
			}
		});

		it("fails closed when a restored database has no private key", () => {
			const db = makeDb();
			const keysDir = join(tmpDir, "keys-missing-private");
			process.env.CODEMEM_SYNC_KEY_STORE = "file";
			try {
				ensureDeviceIdentity(db, { keysDir });
				const [privatePath] = resolveKeyPaths(keysDir);
				const before = db.prepare("SELECT * FROM sync_device LIMIT 1").get();
				rmSync(privatePath);

				expect(() => ensureDeviceIdentity(db, { keysDir })).toThrow(
					"device_identity_private_key_missing",
				);
				expect(db.prepare("SELECT * FROM sync_device LIMIT 1").get()).toEqual(before);
			} finally {
				db.close();
			}
		});

		it("fails closed when restored key material belongs to another identity", () => {
			const db = makeDb();
			const originalKeysDir = join(tmpDir, "keys-original");
			const unrelatedKeysDir = join(tmpDir, "keys-unrelated");
			const unrelatedDb = makeDb();
			try {
				ensureDeviceIdentity(db, { keysDir: originalKeysDir });
				ensureDeviceIdentity(unrelatedDb, { keysDir: unrelatedKeysDir });
				const before = db.prepare("SELECT * FROM sync_device LIMIT 1").get();

				expect(() => ensureDeviceIdentity(db, { keysDir: unrelatedKeysDir })).toThrow(
					"device_identity_key_mismatch",
				);
				expect(db.prepare("SELECT * FROM sync_device LIMIT 1").get()).toEqual(before);
			} finally {
				db.close();
				unrelatedDb.close();
			}
		});

		it("fails closed when restored private key material is corrupt", () => {
			const db = makeDb();
			const keysDir = join(tmpDir, "keys-corrupt-private");
			process.env.CODEMEM_SYNC_KEY_STORE = "file";
			try {
				ensureDeviceIdentity(db, { keysDir });
				const [privatePath] = resolveKeyPaths(keysDir);
				const before = db.prepare("SELECT * FROM sync_device LIMIT 1").get();
				writeFileSync(privatePath, "not-a-private-key");

				expect(() => ensureDeviceIdentity(db, { keysDir })).toThrow(
					"device_identity_private_key_invalid",
				);
				expect(db.prepare("SELECT * FROM sync_device LIMIT 1").get()).toEqual(before);
			} finally {
				db.close();
			}
		});

		it("rejects non-Ed25519 private key material", () => {
			const db = makeDb();
			const keysDir = join(tmpDir, "keys-wrong-algorithm");
			process.env.CODEMEM_SYNC_KEY_STORE = "file";
			try {
				ensureDeviceIdentity(db, { keysDir });
				const [privatePath] = resolveKeyPaths(keysDir);
				const before = db.prepare("SELECT * FROM sync_device LIMIT 1").get();
				const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
				writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }));

				expect(() => ensureDeviceIdentity(db, { keysDir })).toThrow(
					"device_identity_private_key_invalid",
				);
				expect(db.prepare("SELECT * FROM sync_device LIMIT 1").get()).toEqual(before);
			} finally {
				db.close();
			}
		});
	});
});
