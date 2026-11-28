/**
 * Isolates a test process from the developer's own codemem data and credentials.
 *
 * Vitest's setup (`test-environment-isolation.ts`) imports it, and every `node --test`
 * script preloads it (`node --import <this file> --test ...`). It runs once per
 * process when first imported:
 *
 * - HOME (and USERPROFILE, XDG_CONFIG_HOME, XDG_DATA_HOME) point at a temporary home of
 *   this process, removed when it exits, so a path that falls back to the home
 *   directory stays out of `~/.codemem` and `~/.config/codemem` even when a test
 *   deletes CODEMEM_KEYS_DIR or another override;
 * - CODEMEM_DB, CODEMEM_KEYS_DIR and CODEMEM_CONFIG point inside it, and
 *   CODEMEM_SYNC_KEY_STORE is `file`;
 * - every coordinator setting and every codemem variable that carries a secret, key or
 *   credential is removed, since agent shells export a real coordinator admin secret;
 * - CODEMEM_TEST_ISOLATION marks the process, and the processes it starts, as a test,
 *   which the real-path guard (`test-real-path-guard.ts`) checks;
 * - a child process started with an environment of its own gets these variables when
 *   that environment leaves them out.
 *
 * It imports only Node built-ins so Node can load it directly, without a build.
 */
import childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const TEST_ISOLATION_MARKER = "CODEMEM_TEST_ISOLATION";

/** Developer settings read from the environment in preference to the config file. */
const DEVELOPER_CREDENTIAL_VARIABLE =
	/^CODEMEM_(?:SYNC_COORDINATOR_\w*|\w*(?:SECRET|PASSWORD|CREDENTIAL|API_KEY|SERVICE_KEY|PROBE_KEY|CSRF_KEY|TOKEN_KEY|TOKEN_KEY_PREVIOUS|AUTH_FILE|AUTH_COMMAND|AUTH_CONFIG|AUTH_TOKEN))$/u;

/** Set for every child process unless the test's own environment for it names them. */
const CHILD_ISOLATION_VARIABLES = [
	"HOME",
	"USERPROFILE",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"CODEMEM_DB",
	"CODEMEM_KEYS_DIR",
	"CODEMEM_CONFIG",
	"CODEMEM_SYNC_KEY_STORE",
	"VITEST",
	TEST_ISOLATION_MARKER,
];

const STATE_KEY = Symbol.for("codemem.test.process-isolation");
type IsolationState = { home: string };
type IsolatedGlobal = typeof globalThis & { [STATE_KEY]?: IsolationState };

/** Removes the developer's coordinator settings and credentials from `env`. */
export function removeDeveloperCredentials(env: NodeJS.ProcessEnv): void {
	for (const name of Object.keys(env)) {
		if (DEVELOPER_CREDENTIAL_VARIABLE.test(name)) delete env[name];
	}
}

function withIsolation(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const isolated = { ...env };
	for (const name of CHILD_ISOLATION_VARIABLES) {
		if (!(name in isolated) && process.env[name] !== undefined) isolated[name] = process.env[name];
	}
	return isolated;
}

/** Gives a child started with its own environment the isolation variables it leaves out. */
function isolateChildProcesses(): void {
	const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
	const target = childProcess as unknown as Record<string, unknown>;
	const isolateArgs = (args: unknown[]) =>
		args.map((arg) => {
			if (!arg || typeof arg !== "object" || Array.isArray(arg)) return arg;
			const options = arg as { env?: NodeJS.ProcessEnv };
			return options.env ? { ...options, env: withIsolation(options.env) } : arg;
		});
	type Callable = ((...args: unknown[]) => unknown) & { [promisify.custom]?: Callable };
	for (const name of names) {
		const original = target[name] as Callable | undefined;
		if (typeof original !== "function") continue;
		const wrapped: Callable = function isolatedChildProcess(this: unknown, ...args: unknown[]) {
			return original.apply(this, isolateArgs(args));
		};
		// exec and execFile promisify to { stdout, stderr } through this hook; keep it.
		const custom = original[promisify.custom];
		if (custom) {
			wrapped[promisify.custom] = function isolatedPromisified(this: unknown, ...args: unknown[]) {
				return custom.apply(this, isolateArgs(args));
			};
		}
		target[name] = wrapped;
	}
	// ES module imports of node:child_process read these exports too.
	syncBuiltinESMExports();
}

/** Isolates this process once and returns its temporary home. */
export function isolateTestProcess(): string {
	const scope = globalThis as IsolatedGlobal;
	const existing = scope[STATE_KEY];
	if (existing) return existing.home;
	const home = mkdtempSync(join(tmpdir(), "codemem-test-home-"));
	scope[STATE_KEY] = { home };
	process.once("exit", () => rmSync(home, { recursive: true, force: true }));

	const env = process.env;
	removeDeveloperCredentials(env);
	env.HOME = home;
	env.USERPROFILE = home;
	env.XDG_CONFIG_HOME = join(home, ".config");
	env.XDG_DATA_HOME = join(home, ".local", "share");
	const data = join(home, "codemem-test");
	mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
	mkdirSync(join(data, "keys"), { recursive: true });
	writeFileSync(join(data, "config.json"), "{}\n");
	env.CODEMEM_DB = join(data, "mem.sqlite");
	env.CODEMEM_KEYS_DIR = join(data, "keys");
	env.CODEMEM_CONFIG = join(data, "config.json");
	env.CODEMEM_SYNC_KEY_STORE = "file";
	env.CODEMEM_INVITE_TOKEN_KEY = randomBytes(32).toString("hex");
	env[TEST_ISOLATION_MARKER] = "1";
	isolateChildProcesses();
	return home;
}

isolateTestProcess();
