import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDbPath } from "./db.js";
import { getCodememConfigPath } from "./observer-config.js";
import { resolveKeyPaths } from "./sync-identity.js";
import { assertNotRealCodememPath } from "./test-real-path-guard.js";

// These paths are only resolved, never opened, so nothing reads the developer's data.
const realHome = userInfo().homedir;
const REAL_STORE = join(realHome, ".codemem", "guard-test-never-opened.sqlite");
const REAL_KEYS = join(realHome, ".config", "codemem", "keys");
const REAL_CONFIG = join(realHome, ".config", "codemem", "guard-test-never-read.json");

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("test setup isolation", () => {
	it("points HOME, the store, keys and config away from the developer's own", () => {
		for (const name of ["HOME", "CODEMEM_DB", "CODEMEM_KEYS_DIR", "CODEMEM_CONFIG"]) {
			const value = resolve(process.env[name] ?? "");
			expect(value.startsWith(resolve(tmpdir())), name).toBe(true);
			expect(value.startsWith(resolve(realHome)), name).toBe(false);
		}
	});

	it("finds keys under the temporary home when nothing overrides the keys directory", () => {
		vi.stubEnv("CODEMEM_KEYS_DIR", undefined);

		const [privateKey] = resolveKeyPaths();

		expect(privateKey).toBe(
			join(process.env.HOME ?? "", ".config", "codemem", "keys", "device.key"),
		);
		expect(privateKey.startsWith(resolve(tmpdir()))).toBe(true);
	});

	it("opens the default store under the temporary directory when nothing names one", () => {
		expect(resolveDbPath()).toBe(process.env.CODEMEM_DB);
	});
});

describe("the real-path guard", () => {
	it.each([
		["the store opener", () => resolveDbPath(REAL_STORE)],
		["the keys directory", () => resolveKeyPaths(REAL_KEYS)],
		[
			"the config resolver",
			() => {
				vi.stubEnv("CODEMEM_CONFIG", REAL_CONFIG);
				return getCodememConfigPath();
			},
		],
		[
			"the codemem home itself",
			() => assertNotRealCodememPath(join(realHome, ".codemem"), "store"),
		],
	])("refuses %s on the developer's real path", (_label, use) => {
		expect(use).toThrow(/A test tried to use the real codemem/u);
	});

	it("allows paths beside the protected directories", () => {
		expect(() =>
			assertNotRealCodememPath(join(realHome, ".codemem-other", "mem.sqlite"), "store"),
		).not.toThrow();
		expect(() => assertNotRealCodememPath(join(tmpdir(), ".codemem"), "store")).not.toThrow();
	});

	it("does nothing outside a test run", () => {
		vi.stubEnv("VITEST", "");
		vi.stubEnv("NODE_TEST_CONTEXT", "");
		vi.stubEnv("CODEMEM_TEST_ISOLATION", "");
		vi.stubEnv("NODE_ENV", "production");

		expect(() => assertNotRealCodememPath(REAL_STORE, "store")).not.toThrow();
	});
});
