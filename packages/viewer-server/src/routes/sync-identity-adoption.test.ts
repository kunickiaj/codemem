import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncRoutes } from "./sync.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
	for (const run of cleanup.splice(0).reverse()) run();
});

describe("sync route identity adoption", () => {
	it("adopts and publishes device identity initialized by the pairing route", async () => {
		const directory = mkdtempSync(join(tmpdir(), "codemem-sync-identity-"));
		const configPath = join(directory, "config.json");
		const previousConfig = process.env.CODEMEM_CONFIG;
		const previousDeviceId = process.env.CODEMEM_DEVICE_ID;
		const previousKeysDir = process.env.CODEMEM_KEYS_DIR;
		process.env.CODEMEM_CONFIG = configPath;
		delete process.env.CODEMEM_DEVICE_ID;
		process.env.CODEMEM_KEYS_DIR = join(directory, "keys");
		writeFileSync(configPath, JSON.stringify({ sync_enabled: true }));
		const store = new MemoryStore(join(directory, "memory.sqlite"));
		cleanup.push(() => {
			store.close();
			if (previousConfig == null) delete process.env.CODEMEM_CONFIG;
			else process.env.CODEMEM_CONFIG = previousConfig;
			if (previousDeviceId == null) delete process.env.CODEMEM_DEVICE_ID;
			else process.env.CODEMEM_DEVICE_ID = previousDeviceId;
			if (previousKeysDir == null) delete process.env.CODEMEM_KEYS_DIR;
			else process.env.CODEMEM_KEYS_DIR = previousKeysDir;
			rmSync(directory, { recursive: true, force: true });
		});
		expect(store.deviceId).toBe("local");
		const identityChanged = vi.fn();
		store.onIdentityChanged(identityChanged);

		const response = await syncRoutes(() => store).request("/api/sync/pairing");
		const body = (await response.json()) as { device_id: string };

		expect(response.status).toBe(200);
		expect(store.deviceId).toBe(body.device_id);
		expect(store.deviceId).not.toBe("local");
		expect(identityChanged).toHaveBeenCalledOnce();
	});
});
