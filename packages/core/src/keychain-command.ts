/**
 * Runs the OS credential tools that hold device keys and attestation records: `security`
 * on macOS and `secret-tool` on Linux.
 *
 * Under test the real tools are refused. A test that sets CODEMEM_SYNC_KEY_STORE=keychain
 * would otherwise write into the developer's login keychain, or, with the test setup's
 * temporary HOME, make macOS ask on screen for a keychain to store the item in. A test
 * opts into an in-memory keychain instead (`installFakeKeychain` in
 * `test-keychain-fake.ts`), which registers its runner here.
 */
import { execFileSync } from "node:child_process";
import { runningUnderTest } from "./test-real-path-guard.js";

export type KeychainCommand = "security" | "secret-tool";

/** Runs one keychain command and returns its standard output. Throws when it fails. */
export type KeychainCommandRunner = (
	command: KeychainCommand,
	args: string[],
	input?: string,
) => string;

const TEST_RUNNER = Symbol.for("codemem.test.keychain-runner");
type RunnerGlobal = typeof globalThis & { [TEST_RUNNER]?: KeychainCommandRunner };

/** Registers the runner a test uses in place of the real tools, or clears it with null. */
export function setTestKeychainRunner(runner: KeychainCommandRunner | null): void {
	const scope = globalThis as RunnerGlobal;
	if (runner) scope[TEST_RUNNER] = runner;
	else delete scope[TEST_RUNNER];
}

/** The runner a test registered. Outside tests none is used. */
function testRunner(): KeychainCommandRunner | null {
	if (!runningUnderTest()) return null;
	return (globalThis as RunnerGlobal)[TEST_RUNNER] ?? null;
}

/**
 * Throws under test unless the test registered a runner. Callers check this before
 * their own error handling, so the refusal isn't read as "not in the keychain".
 */
export function assertKeychainCommandAllowed(command: KeychainCommand): void {
	if (!runningUnderTest() || testRunner()) return;
	throw new Error(
		`A test tried to run the real \`${command}\` keychain tool. Tests must not reach the developer's keychain: call installFakeKeychain() from test-keychain-fake.ts, or pass the code a keychain runner.`,
	);
}

/** True when the tool can run: the test's runner, or the real tool on PATH. */
export function keychainCommandAvailable(command: KeychainCommand): boolean {
	assertKeychainCommandAllowed(command);
	if (testRunner()) return true;
	try {
		execFileSync("which", [command], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/** Runs the tool through the test's runner, or for real outside tests. */
export function runKeychainCommand(
	command: KeychainCommand,
	args: string[],
	input?: string,
): string {
	assertKeychainCommandAllowed(command);
	const runner = testRunner();
	if (runner) return runner(command, args, input);
	return execFileSync(command, args, { input, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8");
}
