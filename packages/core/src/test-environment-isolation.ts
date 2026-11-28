import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";
import { isolateTestKeys } from "./test-environment-keys.js";
import { removeDeveloperCredentials } from "./test-process-isolation.js";

/**
 * The setup file of every vitest project that runs in Node. It keeps a test from
 * reading the developer's own codemem config or coordinator credentials, and
 * from opening a connection to a host other than this machine.
 *
 * It also points CODEMEM_KEYS_DIR at a directory of its own, uses file key storage, and turns
 * off the real keychain, even when the caller's environment sets them, so code that falls back
 * to them doesn't read or mark the developer's device key.
 *
 * It also sets CODEMEM_INVITE_TOKEN_KEY to a key generated for this process, so
 * coordinator stores can create invitations. A test of a missing or rotated key
 * passes its own keys to the store.
 *
 * A test that needs a config writes its own file and sets CODEMEM_CONFIG. A test
 * that expects a refused connection empties the `blocked` list of the guard
 * state, which is stored on `globalThis` under `Symbol.for(GUARD_KEY_NAME)`.
 *
 * The process-wide isolation, shared with `node --test` scripts, comes from
 * `test-process-isolation.ts`: a temporary HOME, removed credentials, and child processes
 * that keep the isolation variables. On top of it each test file gets its own config,
 * keys directory and store (CODEMEM_DB). The store opener, the keys directory and the
 * config resolver also refuse the developer's real `~/.codemem` and `~/.config/codemem`
 * under test (`test-real-path-guard.ts`).
 *
 * The connection guard covers the test process only. A child process or a worker thread
 * that a test starts loads its own `node:net` and is not guarded. A child process does
 * inherit the environment set here.
 */

/** The embedding tests download their model. Tracked separately; allowed until then. */
const ALLOWED_HOST_SUFFIXES = ["huggingface.co", "hf.co"];

const LOOPBACK_HOST =
	/^(?:localhost|127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3}|0\.0\.0\.0|::)$/iu;

interface GuardState {
	blocked: string[];
}

const GUARD_KEY_NAME = "codemem.test.connection-guard";
const GUARD_KEY = Symbol.for(GUARD_KEY_NAME);
type GuardedGlobal = typeof globalThis & { [GUARD_KEY]?: GuardState };

function isAllowedHost(host: string): boolean {
	const name = host.replace(/^\[|\]$/gu, "").toLowerCase();
	if (LOOPBACK_HOST.test(name)) return true;
	return ALLOWED_HOST_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/** The host a `Socket.connect` call names, or null for a local pipe. */
function connectionHost(args: unknown[]): string | null {
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (first && typeof first === "object") {
		const options = first as { path?: unknown; host?: unknown };
		if (options.path) return null;
		return typeof options.host === "string" ? options.host : "localhost";
	}
	if (typeof first === "string" && Number.isNaN(Number(first))) return null;
	return typeof args[1] === "string" ? args[1] : "localhost";
}

/** Installed once for each test process. Later test files in that process reuse it. */
function installConnectionGuard(): GuardState {
	const guarded = globalThis as GuardedGlobal;
	const existing = guarded[GUARD_KEY];
	if (existing) return existing;
	const state: GuardState = { blocked: [] };
	guarded[GUARD_KEY] = state;
	const connect = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
		const host = connectionHost(args);
		if (host === null || isAllowedHost(host)) {
			return (connect as (...rest: unknown[]) => net.Socket).apply(this, args);
		}
		state.blocked.push(host);
		throw new Error(`Test tried to connect to ${host}. Tests may only connect to this machine.`);
	} as typeof net.Socket.prototype.connect;
	return state;
}

function failOnBlockedConnections(state: GuardState): void {
	if (state.blocked.length === 0) return;
	const hosts = [...new Set(state.blocked.splice(0))].join(", ");
	throw new Error(
		`A test tried to connect to: ${hosts}. Point the code at a local server or a stub, and give the test its own CODEMEM_CONFIG.`,
	);
}

const guard = installConnectionGuard();
const configDirectory = mkdtempSync(join(tmpdir(), "codemem-test-config-"));
const configPath = join(configDirectory, "config.json");
writeFileSync(configPath, "{}\n");
process.env.CODEMEM_CONFIG = configPath;
process.env.CODEMEM_DB = join(configDirectory, "mem.sqlite");
removeDeveloperCredentials(process.env);
process.env.CODEMEM_INVITE_TOKEN_KEY = randomBytes(32).toString("hex");
isolateTestKeys(process.env, configDirectory);

afterEach(() => failOnBlockedConnections(guard));
afterAll(() => {
	rmSync(configDirectory, { recursive: true, force: true });
	failOnBlockedConnections(guard);
});
