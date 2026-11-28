import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keychainWitness } from "./coordinator-free-attestation.js";
import {
	assertKeychainCommandAllowed,
	keychainCommandAvailable,
	runKeychainCommand,
} from "./keychain-command.js";
import { loadPrivateKeyKeychain, storePrivateKeyKeychain } from "./sync-identity.js";
import { installFakeKeychain } from "./test-keychain-fake.js";

const REFUSED = /A test tried to run the real `(security|secret-tool)` keychain tool/u;
const HAS_KEYCHAIN_PLATFORM = process.platform === "darwin" || process.platform === "linux";

let fake: ReturnType<typeof installFakeKeychain> | null = null;
afterEach(() => {
	fake?.uninstall();
	fake = null;
	vi.unstubAllEnvs();
});

describe("the real keychain tools under test", () => {
	it.each(["security", "secret-tool"] as const)("refuses to run %s", (command) => {
		expect(() => runKeychainCommand(command, ["lookup"])).toThrow(REFUSED);
		expect(() => keychainCommandAvailable(command)).toThrow(REFUSED);
	});

	it.skipIf(!HAS_KEYCHAIN_PLATFORM)(
		"makes the device key store and lookup throw, instead of reporting a missing key",
		() => {
			vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "keychain");
			expect(() => storePrivateKeyKeychain(Buffer.from("key"), "device-a")).toThrow(REFUSED);
			expect(() => loadPrivateKeyKeychain("device-a")).toThrow(REFUSED);
		},
	);

	it.each(["darwin", "linux"] as const)(
		"refuses the attestation witness on %s unless it is given a runner",
		(platform) => {
			const directory = mkdtempSync(join(tmpdir(), "codemem-keychain-guard-"));
			try {
				expect(() => keychainWitness({ directory, platform })).toThrow(REFUSED);
				expect(() => keychainWitness({ directory, platform, run: () => "" })).not.toThrow();
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("allows the tools outside a test run", () => {
		for (const name of ["VITEST", "NODE_TEST_CONTEXT", "CODEMEM_TEST_ISOLATION"])
			vi.stubEnv(name, "");
		vi.stubEnv("NODE_ENV", "production");
		// Only checked: nothing is run.
		expect(() => assertKeychainCommandAllowed("security")).not.toThrow();
		expect(() => assertKeychainCommandAllowed("secret-tool")).not.toThrow();
	});
});

describe("the shared fake keychain", () => {
	it.skipIf(!HAS_KEYCHAIN_PLATFORM)(
		"stores and returns the device key through the code's own commands",
		() => {
			fake = installFakeKeychain();
			vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "keychain");

			expect(storePrivateKeyKeychain(Buffer.from("pem-a"), "device-a")).toBe(true);

			expect(fake.get("codemem-sync", "device-a")).toBe("pem-a");
			expect(loadPrivateKeyKeychain("device-a")?.toString("utf8")).toBe("pem-a");
			expect(loadPrivateKeyKeychain("device-b")).toBeNull();
			expect(fake.calls.map(({ action, account }) => `${action} ${account}`)).toEqual(
				process.platform === "darwin"
					? [
							"add-generic-password device-a",
							"find-generic-password device-a",
							"find-generic-password device-b",
						]
					: ["store device-a", "lookup device-a", "lookup device-b"],
			);
		},
	);

	it("serves the attestation witness, which never replaces a record", () => {
		fake = installFakeKeychain();
		const directory = mkdtempSync(join(tmpdir(), "codemem-keychain-fake-"));
		try {
			const witness = keychainWitness({ directory, platform: "darwin" });

			expect(witness.create("record", "one")).toBe("created");
			expect(witness.create("record", "two")).toBe("exists");
			expect(witness.read("record")).toBe("one");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("is gone after uninstall, so the guard refuses again", () => {
		installFakeKeychain().uninstall();
		expect(() => runKeychainCommand("security", ["find-generic-password"])).toThrow(REFUSED);
	});
});
