import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { enrollFixtureSigningKey } from "./managed-scope-test-fixtures.js";
import { useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";
import { MemoryStore } from "./store.js";
import { loadRuntimeSigningPublicKey } from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

const { fixture, remember, binding, row, ledger, factRows } = useLocalCaptureFixture();
it.each(["missing", "wrong"])(
	"%s actual private key cannot issue enrolled capture proof",
	(mode) => {
		// Arrange: persist a real device before any birth; reopen with that device's runtime ID.
		enrollFixtureSigningKey(fixture.store.db, fixture.keysDir, "capture-device");
		fixture.store.close();
		fixture.store = new MemoryStore(join(fixture.dir, "memory.sqlite"), {
			keysDir: fixture.keysDir,
		});
		expect(fixture.store.deviceId).toBe("capture-device");
		const good = remember("Actual signing-key control");
		expect(binding(good)?.evidence).toBe("local_creation");
		const before = ledger();
		const snapshots = factRows("memory_local_creation_snapshots");
		const keyPath = join(fixture.keysDir, "device.key");
		const original = readFileSync(keyPath);
		if (mode === "missing") renameSync(keyPath, `${keyPath}.fixture-backup`);
		else {
			const other = new Database(":memory:");
			try {
				initTestSchema(other);
				enrollFixtureSigningKey(other, join(fixture.dir, "other-keys"), "other-device");
				writeFileSync(keyPath, readFileSync(join(fixture.dir, "other-keys", "device.key")));
			} finally {
				other.close();
			}
		}
		expect(
			loadRuntimeSigningPublicKey(fixture.store.db, {
				deviceId: "capture-device",
				keysDir: fixture.keysDir,
			}),
		).toBeNull();
		// Act: ingest still succeeds, without minting historical authority.
		const id = remember("Capture with unavailable actual key");
		// Assert
		expect(row(id).active).toBe(1);
		expect(String(row(id).import_key)).toMatch(/^[0-9a-f-]{36}$/u);
		expect(binding(id)).toBeNull();
		expect(ledger()).toEqual(before);
		expect(factRows("memory_local_creation_snapshots")).toEqual(snapshots);
		writeFileSync(keyPath, original);
		const restored = remember("Restored actual signing key");
		expect(binding(restored)?.evidence).toBe("local_creation");
		expect(binding(id)).toBeNull();
		expect(factRows("memory_local_creation_snapshots")).toHaveLength(snapshots.length + 1);
	},
);
it("nonlocal runtime identity without a persisted device cannot mint unsigned capture proof", () => {
	// Arrange
	fixture.store.close();
	vi.stubEnv("CODEMEM_DEVICE_ID", "configured-but-unenrolled");
	fixture.store = new MemoryStore(join(fixture.dir, "memory.sqlite"), { keysDir: fixture.keysDir });
	expect(fixture.store.db.prepare("SELECT * FROM sync_device").all()).toEqual([]);
	const before = ledger();
	// Act
	const id = remember();
	// Assert
	expect(row(id).active).toBe(1);
	expect(String(row(id).import_key)).toMatch(/^[0-9a-f-]{36}$/u);
	expect(binding(id)).toBeNull();
	expect(ledger()).toEqual(before);
	expect(factRows("memory_local_creation_snapshots")).toEqual([]);
});
