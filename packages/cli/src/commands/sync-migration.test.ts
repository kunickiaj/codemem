import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSyncMigrationCommand } from "./sync-migration.js";

let directory: string;
let dbPath: string;
let configPath: string;
let exitCode: typeof process.exitCode;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "migration-status-cli-"));
	dbPath = join(directory, "store.sqlite");
	configPath = join(directory, "config.json");
	exitCode = process.exitCode;
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	vi.stubEnv("CODEMEM_SYNC_BOUNDARY_MIGRATION", "report");
	for (const key of ["URL", "GROUP", "GROUPS"])
		vi.stubEnv(`CODEMEM_SYNC_COORDINATOR_${key}`, undefined);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network expected"));
	writeFileSync(configPath, "{}");
});
afterEach(() => {
	process.exitCode = exitCode;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function status() {
	return buildSyncMigrationCommand().parseAsync(
		["status", "--json", "--db-path", dbPath, "--config", configPath],
		{ from: "user" },
	);
}

it("distinguishes a fresh peer install from a configured coordinator that cannot be reached", async () => {
	connect(dbPath).close();
	const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	await status();
	expect(output).toHaveBeenLastCalledWith('{"mode":"report","state":"not_applicable"}\n');
	writeFileSync(
		configPath,
		JSON.stringify({
			sync_coordinator_url: "https://coord.example",
			sync_coordinator_group: "test",
		}),
	);
	await status();
	expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual({
		mode: "report",
		state: "local_report",
		local_filters: "none",
		maintenance_window: expect.stringContaining("stop every client"),
		storage_fence: expect.stringContaining("does not erase data from disk"),
		projects: null,
	});
	expect(fetch).not.toHaveBeenCalled();
});

it("does not create a missing database or classify a damaged config as peer-only", async () => {
	const error = vi.spyOn(console, "log").mockImplementation(() => {});
	await status();
	expect(error).toHaveBeenCalledWith(expect.stringContaining("migration_report_unavailable"));
	expect(existsSync(dbPath)).toBe(false);
	connect(dbPath).close();
	writeFileSync(configPath, "{invalid");
	error.mockClear();
	await status();
	expect(error).toHaveBeenCalledWith(expect.stringContaining("migration_report_unavailable"));
	expect(process.exitCode).toBe(1);
});

it("tells the person in text what the storage fence does not erase and how to recover", async () => {
	connect(dbPath).close();
	writeFileSync(
		configPath,
		JSON.stringify({
			sync_coordinator_url: "https://coord.example",
			sync_coordinator_group: "test",
		}),
	);
	const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	await buildSyncMigrationCommand().parseAsync(
		["status", "--db-path", dbPath, "--config", configPath],
		{ from: "user" },
	);
	const text = output.mock.calls.map(([chunk]) => String(chunk)).join("");
	expect(text).toContain("does not erase data from disk");
	expect(text).toContain("leave the project_* tables unchanged");
});
