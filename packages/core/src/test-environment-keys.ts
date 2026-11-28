import { join } from "node:path";

/**
 * Points key material at the test process's own directory and uses file key storage,
 * whatever the inherited environment says. Code that finds no keys directory otherwise
 * uses the developer's own, where coordinator entry points write a permanent managed mark
 * beside the device key. Under test the real keychain tools are refused
 * (`keychain-command.ts`); a test that needs a keychain installs the fake one.
 */
export function isolateTestKeys(env: NodeJS.ProcessEnv, directory: string): void {
	env.CODEMEM_KEYS_DIR = join(directory, "keys");
	env.CODEMEM_SYNC_KEY_STORE = "file";
}
