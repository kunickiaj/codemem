import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import { loadPublicKey, loadRuntimeSigningPublicKey } from "./sync-identity.js";
import {
	diagnosticDatabaseSnapshot,
	diagnosticKeySnapshot,
	seedSigningStatusFixture,
	selectSigningContext,
	signingContexts,
} from "./sync-status-test-fixtures.js";
import { initTestSchema } from "./test-utils.js";

describe("read-only runtime signing public key", () => {
	it.each([
		...signingContexts,
		"requested-device-mismatch",
		"missing-identity",
		"duplicate-identity",
	] as const)(
		"derives only a matching persisted signer for %s without initialization or repair",
		async (context) => {
			// Arrange: retained proof is not a substitute for the runtime private key.
			const root = mkdtempSync(join(tmpdir(), "runtime-signing-key-test-"));
			const db = connect(join(root, "mem.sqlite"));
			initTestSchema(db);
			vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
			try {
				const fixture = await seedSigningStatusFixture(db, root);
				const publicKey = loadPublicKey(fixture.keysDir);
				let keysDir = fixture.keysDir;
				if (context === "missing-identity") db.prepare("DELETE FROM sync_device").run();
				else if (context === "duplicate-identity") {
					db.prepare(`INSERT INTO sync_device(device_id, public_key, fingerprint, created_at)
						SELECT 'duplicate-device', public_key, fingerprint, created_at FROM sync_device`).run();
				} else if (context !== "requested-device-mismatch") {
					keysDir = selectSigningContext(db, fixture, context);
				}
				const beforeDb = diagnosticDatabaseSnapshot(db);
				const beforeKeys = diagnosticKeySnapshot(root);
				const beforeChanges = db.prepare("SELECT total_changes() AS total").get();
				db.pragma("query_only = ON");

				// Act: read using the caller's query-only connection and selected directory.
				const result = loadRuntimeSigningPublicKey(db, {
					deviceId: context === "requested-device-mismatch" ? "other-device" : fixture.deviceId,
					keysDir,
				});

				// Assert: no database writes, missing-key creation, or public-key repair.
				expect(result).toBe(
					context === "valid" || context === "missing-public-key" ? publicKey : null,
				);
				expect(diagnosticDatabaseSnapshot(db)).toEqual(beforeDb);
				expect(db.prepare("SELECT total_changes() AS total").get()).toEqual(beforeChanges);
				expect(diagnosticKeySnapshot(root)).toEqual(beforeKeys);
			} finally {
				vi.unstubAllEnvs();
				db.close();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
