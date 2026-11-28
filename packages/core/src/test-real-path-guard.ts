import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * True in a Vitest run, a `node --test` run, a process the test isolation preload
 * marked, any process those start with the inherited environment, or with NODE_ENV=test.
 */
export function runningUnderTest(): boolean {
	const env = process.env;
	return (
		Boolean(env.VITEST) ||
		Boolean(env.NODE_TEST_CONTEXT) ||
		env.CODEMEM_TEST_ISOLATION === "1" ||
		env.NODE_ENV === "test"
	);
}

/**
 * The account's home from the user database. HOME is not used: the test setup
 * points it at a temporary directory, and a child process may be given another.
 */
function accountHome(): string | null {
	try {
		return userInfo().homedir || null;
	} catch {
		return null;
	}
}

/** macOS and Windows file systems ignore case by default, so the paths are compared that way. */
function comparable(path: string): string {
	return process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
}

/**
 * Under test, refuses a path inside the developer's own codemem data: the store
 * and its files in `~/.codemem`, and config and keys in `~/.config/codemem`.
 * Outside tests it does nothing.
 */
export function assertNotRealCodememPath(path: string, what: string): void {
	if (!runningUnderTest()) return;
	const home = accountHome();
	if (!home) return;
	const target = comparable(resolve(path));
	for (const root of [join(home, ".codemem"), join(home, ".config", "codemem")]) {
		const protectedRoot = comparable(resolve(root));
		if (target === protectedRoot || target.startsWith(`${protectedRoot}${sep}`)) {
			throw new Error(
				`A test tried to use the real codemem ${what} at ${resolve(path)}. Tests must stay in the temporary directory the test setup provides: pass --db, or set CODEMEM_DB, CODEMEM_KEYS_DIR or CODEMEM_CONFIG to a temporary path.`,
			);
		}
	}
}
