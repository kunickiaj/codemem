import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./db.js";
import { connect } from "./db.js";
import {
	buildCanonicalRequest,
	cleanupNonces,
	recordNonce,
	signRequest,
	verifySignature,
} from "./sync-auth.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync-auth", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-sync-auth-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// -- buildCanonicalRequest ----------------------------------------------

	describe("buildCanonicalRequest", () => {
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

	// -- signRequest + verifySignature round-trip ----------------------------

	describe("signRequest + verifySignature", () => {
		function setupIdentity() {
			const keysDir = join(tmpDir, "keys");
			const dbPath = join(tmpDir, "test.sqlite");
			const db = connect(dbPath);
			initTestSchema(db);
			const [deviceId] = ensureDeviceIdentity(db, { keysDir });
			const publicKey = loadPublicKey(keysDir)!;
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
