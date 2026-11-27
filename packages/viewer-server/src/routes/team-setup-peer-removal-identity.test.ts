import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeviceIdentity, MemoryStore, readCoordinatorSyncConfig } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookupPeerRemovalsAsDaemon } from "./team-setup.js";

describe("the Team reconciliation's peer removal lookup", () => {
	let keysDir: string;
	let store: MemoryStore;

	beforeEach(() => {
		keysDir = mkdtempSync(join(tmpdir(), "peer-removal-identity-"));
		vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
		store = new MemoryStore(":memory:");
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				throw new Error("Unexpected network request");
			}),
		);
	});

	afterEach(() => {
		store.close();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		rmSync(keysDir, { recursive: true, force: true });
	});

	it("reports the lookup unavailable and creates no signing identity on a store without one", async () => {
		const config = {
			...readCoordinatorSyncConfig({}),
			syncCoordinatorUrl: "https://coord.example.test",
			syncCoordinatorGroups: ["group-a"],
		};

		const lookup = await lookupPeerRemovalsAsDaemon(store, config);

		expect(lookup).toMatchObject({ status: "failed", removed: [], enrolled: [] });
		expect(store.db.prepare("SELECT COUNT(*) FROM sync_device").pluck().get()).toBe(0);
		expect(existsSync(keysDir) ? readdirSync(keysDir) : []).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("asks the coordinator with an identity the device already has", async () => {
		ensureDeviceIdentity(store.db, { keysDir });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 404 })),
		);

		const lookup = await lookupPeerRemovalsAsDaemon(store, {
			...readCoordinatorSyncConfig({}),
			syncCoordinatorUrl: "https://coord.example.test",
			syncCoordinatorGroups: ["group-a"],
		});

		expect(globalThis.fetch).toHaveBeenCalled();
		expect(lookup.status).toBe("unsupported");
	});
});
