import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

describe("MemoryStore identity changes", () => {
	let tmpDir: string;
	let store: MemoryStore;
	const originalEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-store-identity-change-"));
		for (const name of ["CODEMEM_ACTOR_ID", "CODEMEM_CONFIG", "CODEMEM_DEVICE_ID"]) {
			originalEnv[name] = process.env[name];
			delete process.env[name];
		}
		process.env.CODEMEM_CONFIG = join(tmpDir, "config.json");
		const dbPath = join(tmpDir, "memory.sqlite");
		const setupDb = connect(dbPath);
		initTestSchema(setupDb);
		setupDb.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		for (const [name, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("notifies subscribers after persisted actor and device identity changes", () => {
		const listener = vi.fn();
		store.onIdentityChanged(listener);
		const now = "2026-07-23T12:00:00.000Z";
		store.db
			.prepare(
				`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
				 VALUES ('identity-reviewed', 'Reviewed Owner', 1, 'active', ?, ?)`,
			)
			.run(now, now);

		expect(store.refreshPersistedLocalIdentity("identity-reviewed")).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);

		store.adoptEnsuredDeviceIdentity("device-after-refresh");

		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("detects external actor configuration changes without reading persisted device state", () => {
		const configPath = process.env.CODEMEM_CONFIG as string;
		writeFileSync(configPath, JSON.stringify({ actor_id: "actor-before" }));
		store.close();
		store = new MemoryStore(store.dbPath);
		expect(store.hasCurrentConfiguredIdentity()).toBe(true);

		writeFileSync(configPath, JSON.stringify({ actor_id: "actor-after" }));

		expect(store.hasCurrentConfiguredIdentity()).toBe(false);
	});
});
