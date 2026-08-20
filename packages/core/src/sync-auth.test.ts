import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./db.js";
import { connect } from "./db.js";
import {
	buildAuthHeaders,
	buildCanonicalRequest,
	buildDirectPeerAuthHeaders,
	buildDirectPeerCanonicalRequest,
	cleanupNonces,
	recordNonce,
	signDirectPeerRequest,
	signRequest,
	verifyDirectPeerSignature,
	verifySignature,
} from "./sync-auth.js";
import {
	ensureDeviceIdentity,
	generateKeypair,
	loadPublicKey,
	resolveKeyPaths,
} from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sshKeygenAvailable(): boolean {
	try {
		execFileSync("which", ["ssh-keygen"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const _HAS_SSH_KEYGEN = sshKeygenAvailable();
const HAS_KEYCHAIN_PLATFORM = process.platform === "darwin" || process.platform === "linux";

function installFakeKeychainCli(
	baseDir: string,
	keychainPath: string,
	expectedAccount: string,
): void {
	const binDir = join(baseDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const executable = process.platform === "darwin" ? "security" : "secret-tool";
	const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args[0];
const accountFlag = command === "lookup" || command === "store" ? "account" : "-a";
const accountIndex = args.indexOf(accountFlag);
if (accountIndex < 0 || args[accountIndex + 1] !== ${JSON.stringify(expectedAccount)}) {
	process.exit(2);
}
if (command === "lookup" || command === "find-generic-password") {
	process.stdout.write(fs.readFileSync(${JSON.stringify(keychainPath)}));
} else {
	process.exit(1);
}
`;
	const executablePath = join(binDir, executable);
	writeFileSync(executablePath, script);
	chmodSync(executablePath, 0o755);
	process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync-auth", () => {
	let tmpDir: string;
	let originalDbPath: string | undefined;
	let originalKeyStore: string | undefined;
	let originalKeychainWarning: string | undefined;
	let originalPath: string | undefined;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-sync-auth-test-"));
		originalDbPath = process.env.CODEMEM_DB;
		originalKeyStore = process.env.CODEMEM_SYNC_KEY_STORE;
		originalKeychainWarning = process.env.CODEMEM_SYNC_KEYCHAIN_WARN;
		originalPath = process.env.PATH;
	});

	afterEach(() => {
		if (originalDbPath === undefined) delete process.env.CODEMEM_DB;
		else process.env.CODEMEM_DB = originalDbPath;
		if (originalKeyStore === undefined) delete process.env.CODEMEM_SYNC_KEY_STORE;
		else process.env.CODEMEM_SYNC_KEY_STORE = originalKeyStore;
		if (originalKeychainWarning === undefined) delete process.env.CODEMEM_SYNC_KEYCHAIN_WARN;
		else process.env.CODEMEM_SYNC_KEYCHAIN_WARN = originalKeychainWarning;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// -- buildCanonicalRequest ----------------------------------------------

	describe("buildCanonicalRequest", () => {
		it("preserves the legacy v2 canonical bytes", () => {
			const result = buildCanonicalRequest(
				"get",
				"/api/sync/status?scope=all",
				"1700000000",
				"fixture-nonce",
				Buffer.alloc(0),
			);

			expect(result.toString("utf-8")).toBe(
				"GET\n/api/sync/status?scope=all\n1700000000\nfixture-nonce\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			);
		});

		it("produces deterministic output", () => {
			const body = Buffer.from('{"hello":"world"}');
			const r1 = buildCanonicalRequest("POST", "/api/sync", "1700000000", "abc123", body);
			const r2 = buildCanonicalRequest("POST", "/api/sync", "1700000000", "abc123", body);
			expect(r1.toString("utf-8")).toBe(r2.toString("utf-8"));
		});

		it("uppercases the method", () => {
			const body = Buffer.from("");
			const result = buildCanonicalRequest("get", "/path", "123", "nonce", body);
			const lines = result.toString("utf-8").split("\n");
			expect(lines[0]).toBe("GET");
		});

		it("includes all components in correct order", () => {
			const body = Buffer.from("test-body");
			const result = buildCanonicalRequest("PUT", "/a/b?q=1", "999", "n1", body);
			const lines = result.toString("utf-8").split("\n");
			expect(lines).toHaveLength(5);
			expect(lines[0]).toBe("PUT");
			expect(lines[1]).toBe("/a/b?q=1");
			expect(lines[2]).toBe("999");
			expect(lines[3]).toBe("n1");
			// Line 4 is the SHA-256 hex digest of "test-body"
			expect(lines[4]).toMatch(/^[0-9a-f]{64}$/);
		});
	});

	describe("direct-peer v3 authentication", () => {
		function setupIdentity() {
			const keysDir = join(tmpDir, "direct-peer-keys");
			const dbPath = join(tmpDir, "direct-peer.sqlite");
			const db = connect(dbPath);
			initTestSchema(db);
			const [deviceId] = ensureDeviceIdentity(db, { keysDir });
			const publicKey = loadPublicKey(keysDir);
			if (!publicKey) throw new Error("expected public key after ensureDeviceIdentity");
			return { db, deviceId, publicKey, keysDir };
		}

		it("appends the recipient to the unchanged five-field canonical request", () => {
			const result = buildDirectPeerCanonicalRequest(
				"get",
				"/api/sync/status?scope=all",
				"1700000000",
				"fixture-nonce",
				Buffer.alloc(0),
				"recipient-device",
			);

			expect(result.toString("utf-8")).toBe(
				"GET\n/api/sync/status?scope=all\n1700000000\nfixture-nonce\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nrecipient-device",
			);
		});

		it("signs and verifies only the matching recipient", () => {
			const { db, deviceId, publicKey, keysDir } = setupIdentity();
			try {
				const timestamp = String(Math.floor(Date.now() / 1000));
				const headers = signDirectPeerRequest({
					method: "POST",
					url: "https://peer.example.test/api/sync/ops?limit=10",
					bodyBytes: Buffer.from("{}"),
					recipientId: "recipient-a",
					keysDir,
					deviceId,
					timestamp,
					nonce: "v3-round-trip",
				});

				expect(
					verifyDirectPeerSignature({
						method: "POST",
						pathWithQuery: "/api/sync/ops?limit=10",
						bodyBytes: Buffer.from("{}"),
						timestamp,
						nonce: "v3-round-trip",
						recipientId: headers["X-Codemem-Recipient"],
						expectedRecipientId: "recipient-a",
						signature: headers["X-Codemem-Signature"],
						publicKey,
					}),
				).toEqual({ status: "valid", version: "v3" });

				expect(
					verifyDirectPeerSignature({
						method: "POST",
						pathWithQuery: "/api/sync/ops?limit=10",
						bodyBytes: Buffer.from("{}"),
						timestamp,
						nonce: "v3-round-trip",
						recipientId: headers["X-Codemem-Recipient"],
						expectedRecipientId: "recipient-b",
						signature: headers["X-Codemem-Signature"],
						publicKey,
					}),
				).toEqual({ status: "invalid", reason: "recipient_mismatch" });
			} finally {
				db.close();
			}
		});

		it("distinguishes absent v3 material from invalid present material", () => {
			const { db, publicKey } = setupIdentity();
			try {
				const base = {
					method: "GET",
					pathWithQuery: "/api/sync/status",
					bodyBytes: Buffer.alloc(0),
					timestamp: String(Math.floor(Date.now() / 1000)),
					nonce: "typed-verification",
					expectedRecipientId: "recipient-a",
					publicKey,
				};

				expect(verifyDirectPeerSignature(base)).toEqual({ status: "absent" });
				expect(verifyDirectPeerSignature({ ...base, recipientId: "", signature: "" })).toEqual({
					status: "absent",
				});
				expect(verifyDirectPeerSignature({ ...base, recipientId: "recipient-a" })).toEqual({
					status: "invalid",
					reason: "incomplete_material",
				});
				expect(
					verifyDirectPeerSignature({
						...base,
						recipientId: "recipient-a",
						signature: "v3:not-a-signature",
					}),
				).toEqual({ status: "invalid", reason: "invalid_signature" });
				expect(
					verifyDirectPeerSignature({
						...base,
						recipientId: "recipient-a",
						signature: "v2:AAAA",
					}),
				).toEqual({ status: "invalid", reason: "unsupported_version" });
				expect(
					verifyDirectPeerSignature({
						...base,
						timestamp: "1",
						recipientId: "recipient-a",
						signature: "v3:AAAA",
					}),
				).toEqual({ status: "invalid", reason: "invalid_timestamp" });
			} finally {
				db.close();
			}
		});

		it.each([
			["method", { method: "PUT" }],
			["path", { pathWithQuery: "/v1/ops?limit=1" }],
			["body", { bodyBytes: Buffer.from('{"changed":true}') }],
			["nonce", { nonce: "changed-nonce" }],
			["timestamp", { timestamp: "1", timeWindowS: Number.MAX_SAFE_INTEGER }],
		])("rejects a signature with a mutated %s", (_field, changes) => {
			const { db, deviceId, publicKey, keysDir } = setupIdentity();
			try {
				const timestamp = String(Math.floor(Date.now() / 1000));
				const headers = signDirectPeerRequest({
					method: "POST",
					url: "https://peer.example.test/v1/ops",
					bodyBytes: Buffer.from("{}"),
					recipientId: "recipient-a",
					keysDir,
					deviceId,
					timestamp,
					nonce: "original-nonce",
				});
				const result = verifyDirectPeerSignature({
					method: "POST",
					pathWithQuery: "/v1/ops",
					bodyBytes: Buffer.from("{}"),
					timestamp,
					nonce: "original-nonce",
					recipientId: "recipient-a",
					expectedRecipientId: "recipient-a",
					signature: headers["X-Codemem-Signature"],
					publicKey,
					...changes,
				});

				expect(result).toEqual({ status: "invalid", reason: "invalid_signature" });
			} finally {
				db.close();
			}
		});

		it("rejects empty or multiline recipients before signing", () => {
			const { db, deviceId, keysDir } = setupIdentity();
			try {
				const options = {
					method: "GET",
					url: "https://peer.example.test/v1/status",
					bodyBytes: Buffer.alloc(0),
					keysDir,
					deviceId,
					timestamp: String(Math.floor(Date.now() / 1000)),
					nonce: "recipient-validation",
				};

				expect(() => signDirectPeerRequest({ ...options, recipientId: "" })).toThrow(
					"recipientId must be a non-empty single-line value",
				);
				expect(() => signDirectPeerRequest({ ...options, recipientId: "peer-a\npeer-b" })).toThrow(
					"recipientId must be a non-empty single-line value",
				);
			} finally {
				db.close();
			}
		});

		it("adds v3 headers without replacing any legacy v2 auth header", () => {
			const { db, deviceId, keysDir } = setupIdentity();
			try {
				const options = {
					deviceId,
					method: "GET",
					url: "https://peer.example.test/api/sync/status",
					bodyBytes: Buffer.alloc(0),
					keysDir,
					timestamp: String(Math.floor(Date.now() / 1000)),
					nonce: "dual-signature-fixture",
				};
				const legacyHeaders = buildAuthHeaders(options);
				const directHeaders = buildDirectPeerAuthHeaders({
					...options,
					recipientId: "recipient-a",
				});

				expect({
					"X-Opencode-Device": directHeaders["X-Opencode-Device"],
					"X-Opencode-Timestamp": directHeaders["X-Opencode-Timestamp"],
					"X-Opencode-Nonce": directHeaders["X-Opencode-Nonce"],
					"X-Opencode-Signature": directHeaders["X-Opencode-Signature"],
				}).toEqual(legacyHeaders);
				expect(directHeaders["X-Opencode-Signature"]).toMatch(/^v2:/);
				expect(directHeaders["X-Codemem-Recipient"]).toBe("recipient-a");
				expect(directHeaders["X-Codemem-Signature"]).toMatch(/^v3:/);
			} finally {
				db.close();
			}
		});
	});

	// -- signRequest + verifySignature round-trip ----------------------------

	describe("signRequest + verifySignature", () => {
		function setupIdentity() {
			const keysDir = join(tmpDir, "keys");
			const dbPath = join(tmpDir, "test.sqlite");
			const db = connect(dbPath);
			initTestSchema(db);
			const [deviceId] = ensureDeviceIdentity(db, { keysDir });
			const publicKey = loadPublicKey(keysDir);
			if (!publicKey) throw new Error("expected public key after ensureDeviceIdentity");
			return { db, deviceId, publicKey, keysDir };
		}

		it("round-trips: sign then verify", () => {
			const { db, deviceId, publicKey, keysDir } = setupIdentity();
			try {
				const body = Buffer.from('{"data":"test"}');
				const url = "https://example.com/api/sync?page=1";
				const ts = String(Math.floor(Date.now() / 1000));
				const nonce = "test-nonce-abc";

				const headers = signRequest({
					method: "POST",
					url,
					bodyBytes: body,
					keysDir,
					timestamp: ts,
					nonce,
				});

				expect(headers["X-Opencode-Timestamp"]).toBe(ts);
				expect(headers["X-Opencode-Nonce"]).toBe(nonce);
				expect(headers["X-Opencode-Signature"]).toMatch(/^v[12]:/);

				const valid = verifySignature({
					method: "POST",
					pathWithQuery: "/api/sync?page=1",
					bodyBytes: body,
					timestamp: headers["X-Opencode-Timestamp"],
					nonce: headers["X-Opencode-Nonce"],
					signature: headers["X-Opencode-Signature"],
					publicKey,
					deviceId,
				});
				expect(valid).toBe(true);
			} finally {
				db.close();
			}
		});

		it.skipIf(!HAS_KEYCHAIN_PLATFORM)(
			"buildAuthHeaders signs with an explicit device ID without consulting the default DB",
			() => {
				const keysDir = join(tmpDir, "explicit-device-keys");
				const dbPath = join(tmpDir, "custom.sqlite");
				const keychainPath = join(tmpDir, "keychain-value");
				process.env.CODEMEM_SYNC_KEY_STORE = "file";
				const db = connect(dbPath);
				initTestSchema(db);
				const [deviceId] = ensureDeviceIdentity(db, { keysDir });
				const publicKey = loadPublicKey(keysDir);
				const [privatePath] = resolveKeyPaths(keysDir);
				writeFileSync(keychainPath, readFileSync(privatePath));
				rmSync(privatePath);
				db.close();
				if (!publicKey) throw new Error("expected public key");

				installFakeKeychainCli(tmpDir, keychainPath, deviceId);
				process.env.CODEMEM_SYNC_KEY_STORE = "keychain";
				process.env.CODEMEM_SYNC_KEYCHAIN_WARN = "0";
				delete process.env.CODEMEM_DB;
				const bodyBytes = Buffer.from("{}");
				const timestamp = String(Math.floor(Date.now() / 1000));
				const headers = buildAuthHeaders({
					deviceId,
					method: "POST",
					url: "https://coordinator.example.test/v1/presence",
					bodyBytes,
					keysDir,
					timestamp,
					nonce: "explicit-device-id",
				});

				expect(headers["X-Opencode-Device"]).toBe(deviceId);
				expect(
					verifySignature({
						method: "POST",
						pathWithQuery: "/v1/presence",
						bodyBytes,
						timestamp: headers["X-Opencode-Timestamp"],
						nonce: headers["X-Opencode-Nonce"],
						signature: headers["X-Opencode-Signature"],
						publicKey,
						deviceId,
					}),
				).toBe(true);
			},
		);

		it.skipIf(!HAS_KEYCHAIN_PLATFORM)(
			"signs with the enrolled keychain identity when device.key belongs to another identity",
			() => {
				const keysDir = join(tmpDir, "foreign-file-keys");
				const unrelatedKeysDir = join(tmpDir, "foreign-file-unrelated-keys");
				const dbPath = join(tmpDir, "foreign-file.sqlite");
				const keychainPath = join(tmpDir, "foreign-file-keychain-value");
				process.env.CODEMEM_SYNC_KEY_STORE = "file";
				const db = connect(dbPath);
				initTestSchema(db);
				const [deviceId] = ensureDeviceIdentity(db, { keysDir });
				const publicKey = loadPublicKey(keysDir);
				const [privatePath] = resolveKeyPaths(keysDir);
				const enrolledPrivateKey = readFileSync(privatePath);
				const [unrelatedPrivatePath, unrelatedPublicPath] = resolveKeyPaths(unrelatedKeysDir);
				generateKeypair(unrelatedPrivatePath, unrelatedPublicPath);
				writeFileSync(privatePath, readFileSync(unrelatedPrivatePath));
				writeFileSync(keychainPath, enrolledPrivateKey);
				db.close();
				if (!publicKey) throw new Error("expected public key");

				installFakeKeychainCli(tmpDir, keychainPath, deviceId);
				process.env.CODEMEM_SYNC_KEY_STORE = "keychain";
				process.env.CODEMEM_SYNC_KEYCHAIN_WARN = "0";
				delete process.env.CODEMEM_DB;
				const bodyBytes = Buffer.from("{}");
				const timestamp = String(Math.floor(Date.now() / 1000));
				const headers = buildAuthHeaders({
					deviceId,
					dbPath,
					method: "POST",
					url: "https://coordinator.example.test/v1/presence",
					bodyBytes,
					keysDir,
					timestamp,
					nonce: "foreign-file-matching-keychain",
				});

				expect(
					verifySignature({
						method: "POST",
						pathWithQuery: "/v1/presence",
						bodyBytes,
						timestamp: headers["X-Opencode-Timestamp"],
						nonce: headers["X-Opencode-Nonce"],
						signature: headers["X-Opencode-Signature"],
						publicKey,
						deviceId,
					}),
				).toBe(true);
			},
		);

		it("rejects expired timestamp", () => {
			const { db, deviceId, publicKey, keysDir } = setupIdentity();
			try {
				const body = Buffer.from("{}");
				const oldTs = String(Math.floor(Date.now() / 1000) - 600);

				const headers = signRequest({
					method: "GET",
					url: "https://example.com/api/test",
					bodyBytes: body,
					keysDir,
					timestamp: oldTs,
				});

				const valid = verifySignature({
					method: "GET",
					pathWithQuery: "/api/test",
					bodyBytes: body,
					timestamp: headers["X-Opencode-Timestamp"],
					nonce: headers["X-Opencode-Nonce"],
					signature: headers["X-Opencode-Signature"],
					publicKey,
					deviceId,
					timeWindowS: 300,
				});
				expect(valid).toBe(false);
			} finally {
				db.close();
			}
		});

		it("rejects wrong signature version", () => {
			const { db, deviceId, publicKey, keysDir } = setupIdentity();
			try {
				const body = Buffer.from("{}");
				const ts = String(Math.floor(Date.now() / 1000));

				const headers = signRequest({
					method: "GET",
					url: "https://example.com/api/test",
					bodyBytes: body,
					keysDir,
					timestamp: ts,
				});

				// Replace version prefix with an unknown version
				const tampered = headers["X-Opencode-Signature"].replace(/^v\d+:/, "v99:");

				const valid = verifySignature({
					method: "GET",
					pathWithQuery: "/api/test",
					bodyBytes: body,
					timestamp: headers["X-Opencode-Timestamp"],
					nonce: headers["X-Opencode-Nonce"],
					signature: tampered,
					publicKey,
					deviceId,
				});
				expect(valid).toBe(false);
			} finally {
				db.close();
			}
		});

		it("rejects tampered body", () => {
			const { db, deviceId, publicKey, keysDir } = setupIdentity();
			try {
				const body = Buffer.from('{"original":"data"}');
				const ts = String(Math.floor(Date.now() / 1000));

				const headers = signRequest({
					method: "POST",
					url: "https://example.com/api/sync",
					bodyBytes: body,
					keysDir,
					timestamp: ts,
				});

				// Verify with different body
				const valid = verifySignature({
					method: "POST",
					pathWithQuery: "/api/sync",
					bodyBytes: Buffer.from('{"tampered":"data"}'),
					timestamp: headers["X-Opencode-Timestamp"],
					nonce: headers["X-Opencode-Nonce"],
					signature: headers["X-Opencode-Signature"],
					publicKey,
					deviceId,
				});
				expect(valid).toBe(false);
			} finally {
				db.close();
			}
		});
	});

	// -- recordNonce --------------------------------------------------------

	describe("recordNonce", () => {
		function makeDb(): Database {
			const dbPath = join(tmpDir, `nonce-${Date.now()}.sqlite`);
			const db = connect(dbPath);
			initTestSchema(db);
			return db;
		}

		it("succeeds on first insert", () => {
			const db = makeDb();
			try {
				const ok = recordNonce(db, "device-1", "nonce-abc", "2026-01-01T00:00:00Z");
				expect(ok).toBe(true);
			} finally {
				db.close();
			}
		});

		it("returns false on duplicate nonce for same device", () => {
			const db = makeDb();
			try {
				recordNonce(db, "device-1", "nonce-dup", "2026-01-01T00:00:00Z");
				const ok = recordNonce(db, "device-1", "nonce-dup", "2026-01-01T00:00:01Z");
				expect(ok).toBe(false);
			} finally {
				db.close();
			}
		});

		it("rejects same nonce even from different devices", () => {
			// Nonce is the sole primary key — global replay protection
			const db = makeDb();
			try {
				const ok1 = recordNonce(db, "device-1", "shared-nonce", "2026-01-01T00:00:00Z");
				const ok2 = recordNonce(db, "device-2", "shared-nonce", "2026-01-01T00:00:00Z");
				expect(ok1).toBe(true);
				expect(ok2).toBe(false);
			} finally {
				db.close();
			}
		});
	});

	// -- cleanupNonces ------------------------------------------------------

	describe("cleanupNonces", () => {
		it("removes old entries and keeps recent ones", () => {
			const dbPath = join(tmpDir, "cleanup.sqlite");
			const db = connect(dbPath);
			initTestSchema(db);
			try {
				recordNonce(db, "d1", "old-nonce", "2025-01-01T00:00:00Z");
				recordNonce(db, "d1", "new-nonce", "2026-06-01T00:00:00Z");

				cleanupNonces(db, "2026-01-01T00:00:00Z");

				const rows = db.prepare("SELECT nonce FROM sync_nonces").all() as { nonce: string }[];
				expect(rows).toHaveLength(1);
				expect(rows[0].nonce).toBe("new-nonce");
			} finally {
				db.close();
			}
		});
	});
});
