import { afterEach, describe, expect, it } from "vitest";
import { readCoordinatorSyncConfig } from "./coordinator-runtime.js";

describe("readCoordinatorSyncConfig.syncOpsLimit", () => {
	afterEach(() => {
		delete process.env.CODEMEM_SYNC_OPS_LIMIT;
	});

	it("defaults to 500 when neither config nor env supplies a value", () => {
		const config = readCoordinatorSyncConfig({});
		expect(config.syncOpsLimit).toBe(500);
	});

	it("reads the value from the sync_ops_limit config key", () => {
		const config = readCoordinatorSyncConfig({ sync_ops_limit: "250" });
		expect(config.syncOpsLimit).toBe(250);
	});

	it("honors the CODEMEM_SYNC_OPS_LIMIT env var over config", () => {
		process.env.CODEMEM_SYNC_OPS_LIMIT = "750";
		const config = readCoordinatorSyncConfig({ sync_ops_limit: "250" });
		expect(config.syncOpsLimit).toBe(750);
	});

	it("clamps values above the server cap of 1000", () => {
		const config = readCoordinatorSyncConfig({ sync_ops_limit: "10000" });
		expect(config.syncOpsLimit).toBe(1000);
	});

	it("clamps values below 1 up to 1", () => {
		const config = readCoordinatorSyncConfig({ sync_ops_limit: "0" });
		expect(config.syncOpsLimit).toBe(1);
	});

	it("falls back to the default when the config value is not an integer", () => {
		const config = readCoordinatorSyncConfig({ sync_ops_limit: "not-a-number" });
		expect(config.syncOpsLimit).toBe(500);
	});
});
