import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildWorkspaceConfigPatch,
	configCommand,
	mergeWorkspaceConfig,
	runWorkspaceConfigCommand,
} from "./config.js";

describe("runWorkspaceConfigCommand", () => {
	let tmpHome: string;
	let prevHome: string | undefined;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "codemem-config-command-"));
		prevHome = process.env.HOME;
		process.env.HOME = tmpHome;
	});

	afterEach(() => {
		if (prevHome == null) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("rejects no-op workspace config writes", () => {
		expect(() => runWorkspaceConfigCommand({ workspaceId: "pilot-1" })).toThrow(
			"Provide at least one config field to update",
		);
	});

	it("rejects conflicting sync enable flags", () => {
		expect(() =>
			runWorkspaceConfigCommand({
				workspaceId: "pilot-1",
				enableSync: true,
				disableSync: true,
			}),
		).toThrow("Use only one of --enable-sync or --disable-sync");
	});

	it("writes the workspace config file and reports updated keys", () => {
		const result = runWorkspaceConfigCommand({
			workspaceId: "pilot-1",
			enableSync: true,
			syncHost: "0.0.0.0",
			coordinatorGroup: "team-a",
			json: true,
		});
		expect(result.config_path).toBe(
			join(tmpHome, ".codemem", "workspaces", "pilot-1", "config", "codemem.json"),
		);
		expect(result.updated_keys).toEqual(["sync_coordinator_group", "sync_enabled", "sync_host"]);
		expect(result.config).toMatchObject({
			sync_enabled: true,
			sync_host: "0.0.0.0",
			sync_coordinator_group: "team-a",
		});
	});

	it("seeds a first workspace config from the currently effective config", () => {
		process.env.CODEMEM_CONFIG = join(tmpHome, ".config", "codemem", "config.json");
		const result = runWorkspaceConfigCommand({
			workspaceId: "pilot-3",
			coordinatorGroup: "team-c",
		});
		expect(result.config).toMatchObject({
			sync_coordinator_group: "team-c",
		});
	});

	it("supports the commander command path with json output", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await configCommand.parseAsync(
				[
					"workspace",
					"--workspace-id",
					"pilot-2",
					"--enable-sync",
					"--coordinator-group",
					"team-b",
					"--json",
				],
				{ from: "user" },
			);
			const output = logSpy.mock.calls.at(-1)?.[0];
			expect(typeof output).toBe("string");
			expect(JSON.parse(String(output))).toMatchObject({
				workspace_id: "pilot-2",
				updated_keys: ["sync_coordinator_group", "sync_enabled"],
			});
		} finally {
			logSpy.mockRestore();
		}
	});
});

describe("buildWorkspaceConfigPatch", () => {
	it("builds a patch from supported sync options", () => {
		expect(
			buildWorkspaceConfigPatch({
				workspaceId: "pilot-1",
				syncEnabled: true,
				syncHost: "0.0.0.0",
				syncPort: "47337",
				syncIntervalS: "5",
				coordinatorUrl: "http://coord.example.test:47347",
				coordinatorGroup: "team-a",
			}),
		).toEqual({
			sync_enabled: true,
			sync_host: "0.0.0.0",
			sync_port: 47337,
			sync_interval_s: 5,
			sync_coordinator_url: "http://coord.example.test:47347",
			sync_coordinator_group: "team-a",
		});
	});

	it("ignores unset values and preserves disable-sync", () => {
		expect(
			buildWorkspaceConfigPatch({
				workspaceId: "pilot-1",
				syncEnabled: false,
			}),
		).toEqual({ sync_enabled: false });
	});

	it("rejects invalid numeric flags", () => {
		expect(() =>
			buildWorkspaceConfigPatch({
				workspaceId: "pilot-1",
				syncPort: "not-a-port",
			}),
		).toThrow("Invalid --sync-port");
	});
});

describe("mergeWorkspaceConfig", () => {
	it("merges the patch over existing config", () => {
		expect(
			mergeWorkspaceConfig(
				{ sync_enabled: false, observer_model: "gpt-5.1" },
				{ sync_enabled: true, sync_port: 47337 },
			),
		).toEqual({ sync_enabled: true, observer_model: "gpt-5.1", sync_port: 47337 });
	});
});
