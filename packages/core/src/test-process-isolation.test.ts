import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { removeDeveloperCredentials } from "./test-process-isolation.js";

describe("removing the developer's credentials from a test environment", () => {
	it("removes every coordinator setting and every credential-bearing codemem variable", () => {
		const removed = [
			"CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET",
			"CODEMEM_SYNC_COORDINATOR_URL",
			"CODEMEM_SYNC_COORDINATOR_GROUP",
			"CODEMEM_SYNC_COORDINATOR_GROUPS",
			"CODEMEM_INVITE_TOKEN_KEY",
			"CODEMEM_INVITE_TOKEN_KEY_PREVIOUS",
			"CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET",
			"CODEMEM_COORDINATOR_BROWSER_CSRF_KEY",
			"CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG",
			"CODEMEM_MCP_OIDC_CLIENT_SECRET",
			"CODEMEM_OBSERVER_API_KEY",
			"CODEMEM_OBSERVER_AUTH_FILE",
			"CODEMEM_OBSERVER_AUTH_COMMAND",
			"CODEMEM_RELAY_SERVICE_KEY",
			"CODEMEM_RELAY_HEALTH_PROBE_KEY",
		];
		const kept = {
			CODEMEM_KEYS_DIR: "/tmp/keys",
			CODEMEM_SYNC_KEY_STORE: "file",
			CODEMEM_INJECT_TOKEN_BUDGET: "100",
			CODEMEM_OBSERVER_AUTH_SOURCE: "env",
			PATH: "/usr/bin",
		};
		const env: NodeJS.ProcessEnv = {
			...kept,
			...Object.fromEntries(removed.map((name) => [name, "fixture"])),
		};

		removeDeveloperCredentials(env);

		expect(env).toEqual(kept);
	});
});

const CHECK_TIMEOUT_MS = 60_000;

describe("a node --test run with the isolation preload", () => {
	it(
		"isolates HOME and the fixtures, and guards the real paths, with nothing else set",
		() => {
			const decoyHome = mkdtempSync(join(tmpdir(), "codemem-decoy-home-"));
			try {
				// Only PATH and a decoy HOME: the preload must do all of the isolation itself.
				const unset = Object.fromEntries(
					[
						"VITEST",
						"NODE_ENV",
						"USERPROFILE",
						"XDG_CONFIG_HOME",
						"XDG_DATA_HOME",
						"CODEMEM_DB",
						"CODEMEM_KEYS_DIR",
						"CODEMEM_CONFIG",
						"CODEMEM_SYNC_KEY_STORE",
						"CODEMEM_TEST_ISOLATION",
					].map((name) => [name, undefined]),
				);
				const result = spawnSync(
					process.execPath,
					[
						"--import",
						resolve(import.meta.dirname, "test-process-isolation.ts"),
						"--import",
						"tsx",
						"--test",
						resolve(import.meta.dirname, "test-process-isolation.node-check.mts"),
					],
					{
						cwd: resolve(import.meta.dirname, ".."),
						encoding: "utf8",
						timeout: CHECK_TIMEOUT_MS,
						env: { ...unset, PATH: process.env.PATH ?? "", HOME: decoyHome, DECOY_HOME: decoyHome },
					},
				);

				expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
				expect(result.stdout).toMatch(/\bpass 4\b/u);
				expect(result.stdout).toMatch(/\bfail 0\b/u);
				expect(readdirSync(decoyHome)).toEqual([]);
			} finally {
				rmSync(decoyHome, { recursive: true, force: true });
			}
		},
		CHECK_TIMEOUT_MS + 5_000,
	);
});
