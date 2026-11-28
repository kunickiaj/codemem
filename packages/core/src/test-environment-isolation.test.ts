import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { markCoordinatorManaged } from "./coordinator-free-attestation.js";
import { readCodememConfigFile } from "./observer-config.js";
import { ensureDeviceIdentity } from "./sync-identity.js";
import { isolateTestKeys, REAL_KEYCHAIN_DISABLED } from "./test-environment-keys.js";
import { initTestSchema } from "./test-utils.js";

/** The state that the setup file keeps for its connection guard. */
function connectionGuard(): { blocked: string[] } {
	const state = (globalThis as Record<symbol, unknown>)[
		Symbol.for("codemem.test.connection-guard")
	];
	if (!state) throw new Error("test-environment-isolation.ts did not run for this test file");
	return state as { blocked: string[] };
}

describe("test environment isolation", () => {
	it("gives the test file an empty codemem config of its own", () => {
		// Act
		const configPath = process.env.CODEMEM_CONFIG ?? "";
		// Assert
		expect(readFileSync(configPath, "utf8").trim()).toBe("{}");
		expect(readCodememConfigFile()).toEqual({});
	});

	it("removes the developer's coordinator variables from the environment", () => {
		expect(process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET).toBeUndefined();
		expect(process.env.CODEMEM_SYNC_COORDINATOR_URL).toBeUndefined();
	});

	it("isolates key material even when the caller's environment sets it", () => {
		// Arrange: settings a developer's shell could pass down.
		const inherited = { CODEMEM_KEYS_DIR: "/inherited/keys", CODEMEM_SYNC_KEY_STORE: "keychain" };
		const scope: Record<symbol, unknown> = {};
		// Act
		isolateTestKeys(inherited, "/test-directory", scope);
		// Assert
		expect(inherited).toEqual({
			CODEMEM_KEYS_DIR: join("/test-directory", "keys"),
			CODEMEM_SYNC_KEY_STORE: "file",
		});
		expect(scope[REAL_KEYCHAIN_DISABLED]).toBe(true);
		expect(process.env.CODEMEM_SYNC_KEY_STORE).toBe("file");
		expect(dirname(process.env.CODEMEM_KEYS_DIR ?? "")).toBe(
			dirname(process.env.CODEMEM_CONFIG ?? ""),
		);
	});

	it("keeps the attestation witness out of the real keychain", () => {
		// Arrange: a test that asks for the keychain without supplying one.
		const db = new Database(":memory:");
		initTestSchema(db);
		ensureDeviceIdentity(db, { keysDir: process.env.CODEMEM_KEYS_DIR });
		vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "keychain");
		try {
			// Act and assert: the keychain refuses, so the managed mark can't be written.
			expect(() => markCoordinatorManaged(db)).toThrow("coordinator_free_witness_unavailable");
		} finally {
			vi.unstubAllEnvs();
			db.close();
		}
	});

	it("refuses a connection to another host and records it", async () => {
		// Act
		const request = fetch("https://coordinator.invalid/v1/peers");
		// Assert
		await expect(request).rejects.toThrow();
		expect(connectionGuard().blocked.splice(0)).toEqual(["coordinator.invalid"]);
	});

	it.fails("fails a test that leaves a refused connection behind", async () => {
		await fetch("https://coordinator.invalid/v1/presence").catch(() => undefined);
	});

	it("allows a connection to this machine", async () => {
		// Arrange
		const server = createServer((_request, response) => response.end("ok"));
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const { port } = server.address() as AddressInfo;
		try {
			// Act
			const response = await fetch(`http://127.0.0.1:${port}/`);
			// Assert
			expect(await response.text()).toBe("ok");
			expect(connectionGuard().blocked).toEqual([]);
		} finally {
			server.close();
		}
	});

	it("is wired into every vitest config that runs tests in Node", () => {
		// Arrange: each package's project config, the configs that scripts name directly, and the root.
		const packages = new URL("../../", import.meta.url);
		const configs = [
			...readdirSync(packages).map((name) => `${name}/vite.config.ts`),
			"cli/smoke.vitest.config.ts",
			"cli/.opencode/vitest.config.ts",
			"cloudflare-coordinator-worker/vitest.node.config.ts",
			"cloudflare-coordinator-worker/scripts/d1-statement-check/capture.vitest.config.ts",
			"../vitest.config.ts",
		].filter((path) => existsSync(new URL(path, packages)));
		// Act
		const unwired = configs.filter(
			(path) =>
				!readFileSync(new URL(path, packages), "utf8").includes(
					"src/test-environment-isolation.ts",
				),
		);
		// Assert
		expect(configs.length).toBeGreaterThanOrEqual(15);
		expect(unwired).toEqual([]);
	});
});
