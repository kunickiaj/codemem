import { join } from "node:path";

/** Set by the test setup. The attestation keychain witness then refuses every read and write. */
export const REAL_KEYCHAIN_DISABLED = Symbol.for("codemem.test.real-keychain-disabled");

/**
 * Points key material at the test process's own directory, uses file key storage, and turns
 * off the real keychain, whatever the inherited environment says. Code that finds no keys
 * directory otherwise uses the developer's own, where coordinator entry points write a
 * permanent managed mark beside the device key.
 */
export function isolateTestKeys(
	env: NodeJS.ProcessEnv,
	directory: string,
	scope: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
): void {
	env.CODEMEM_KEYS_DIR = join(directory, "keys");
	env.CODEMEM_SYNC_KEY_STORE = "file";
	scope[REAL_KEYCHAIN_DISABLED] = true;
}
