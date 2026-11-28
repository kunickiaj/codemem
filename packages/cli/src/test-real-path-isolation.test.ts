import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The CLI runs from source under tsx, which can take several seconds on a loaded runner.
const CHILD_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 5_000;
const CLI = resolve(import.meta.dirname, "index.ts");

/** Runs `codemem maintenance database init` without --db, with the given child environment. */
function initDefaultStore(env?: NodeJS.ProcessEnv) {
	return spawnSync(
		process.execPath,
		["--import", "tsx", "--conditions", "source", CLI, "maintenance", "database", "init"],
		{
			cwd: resolve(import.meta.dirname, "../../.."),
			encoding: "utf8",
			timeout: CHILD_TIMEOUT_MS,
			...(env ? { env } : {}),
		},
	);
}

describe("a CLI that a test starts without --db", () => {
	it.each([
		["inheriting the test environment", undefined],
		[
			"with an environment of its own that names no codemem paths",
			{ PATH: process.env.PATH ?? "" },
		],
	])(
		"creates its store in the test's temporary directory when %s",
		(_label, env) => {
			const store = process.env.CODEMEM_DB ?? "";
			expect(store.startsWith(resolve(tmpdir()))).toBe(true);

			const result = initDefaultStore(env);

			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain(store);
			expect(existsSync(store)).toBe(true);
			expect(`${result.stdout}${result.stderr}`).not.toContain(
				resolve(userInfo().homedir, ".codemem"),
			);
		},
		TEST_TIMEOUT_MS,
	);
});

/** Reports only whether each coordinator setting is present, never its value. */
const COORDINATOR_PRESENCE = `
import { readCoordinatorSyncConfig } from "@codemem/core";
const config = readCoordinatorSyncConfig();
console.log(JSON.stringify({
	envSecret: Boolean(process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET),
	envUrl: Boolean(process.env.CODEMEM_SYNC_COORDINATOR_URL),
	secret: Boolean(config.syncCoordinatorAdminSecret),
	url: Boolean(config.syncCoordinatorUrl),
	keyStore: process.env.CODEMEM_SYNC_KEY_STORE ?? null,
}));
`;

function coordinatorPresence(env?: NodeJS.ProcessEnv) {
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--conditions",
			"source",
			"--input-type=module",
			"-e",
			COORDINATOR_PRESENCE,
		],
		{
			cwd: resolve(import.meta.dirname, ".."),
			encoding: "utf8",
			timeout: CHILD_TIMEOUT_MS,
			...(env ? { env } : {}),
		},
	);
	expect(result.status, "coordinator presence probe failed").toBe(0);
	return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

describe("coordinator credentials in processes a test starts", () => {
	it(
		"leaves out the developer's coordinator secret and URL, and uses file key storage",
		() => {
			expect(process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET).toBeUndefined();
			expect(process.env.CODEMEM_SYNC_COORDINATOR_URL).toBeUndefined();

			expect(coordinatorPresence()).toEqual({
				envSecret: false,
				envUrl: false,
				secret: false,
				url: false,
				keyStore: "file",
			});
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"passes a coordinator secret and URL that the test sets itself",
		() => {
			const presence = coordinatorPresence({
				...process.env,
				CODEMEM_SYNC_COORDINATOR_URL: "http://127.0.0.1:9",
				CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "fixture-secret",
			});

			expect(presence).toMatchObject({ envSecret: true, envUrl: true, secret: true, url: true });
		},
		TEST_TIMEOUT_MS,
	);
});
