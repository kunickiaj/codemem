import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
	deactivateLowSignalMemories: vi.fn(),
	db: {},
}));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	MemoryStore: class {
		db = mocks.db;
		constructor(path: string) {
			mocks.open(path);
		}
		close = mocks.close;
	},
	deactivateLowSignalMemories: mocks.deactivateLowSignalMemories,
	resolveDbPath: (path: string) => path,
}));

import { registerRootCommands } from "../command-tree.js";

describe("maintenance memory prune routing", () => {
	const exitCode = process.exitCode;
	beforeEach(() => {
		vi.clearAllMocks();
		process.exitCode = undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		mocks.deactivateLowSignalMemories.mockReturnValue({ checked: 2, deactivated: 1 });
	});
	afterEach(() => {
		process.exitCode = exitCode;
		vi.restoreAllMocks();
	});

	async function run(args: string[]) {
		const root = registerRootCommands(new Command("codemem")).exitOverride();
		await root.parseAsync(
			["maintenance", "memory", "prune", "--db-path", "fixture.sqlite", "--json", ...args],
			{ from: "user" },
		);
	}

	it("preserves the historical default kinds without adding exploration", async () => {
		// Arrange
		const kinds = [
			"observation",
			"discovery",
			"change",
			"feature",
			"bugfix",
			"refactor",
			"decision",
			"note",
			"entities",
			"session_summary",
		];
		// Act
		await run([]);
		// Assert
		expect(mocks.deactivateLowSignalMemories).toHaveBeenCalledExactlyOnceWith(mocks.db, {
			kinds,
			limit: null,
			dryRun: false,
		});
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("targets only the explicit legacy observation kind set", async () => {
		// Arrange: an explicit set must not add the default note/entity/summary kinds.
		const kinds = [
			"observation",
			"bugfix",
			"feature",
			"refactor",
			"change",
			"discovery",
			"decision",
			"exploration",
		];
		// Act
		await run(["--kinds", kinds.join(",")]);
		// Assert
		expect(mocks.deactivateLowSignalMemories).toHaveBeenCalledExactlyOnceWith(mocks.db, {
			kinds,
			limit: null,
			dryRun: false,
		});
	});

	it("combines repeated kind flags and CSV values as a replacement set", async () => {
		// Arrange
		const args = [
			"--kind",
			"exploration",
			"--kind",
			"bugfix",
			"--kinds",
			"bugfix,discovery",
			"--limit",
			"7",
			"--dry-run",
		];
		// Act
		await run(args);
		// Assert
		expect(mocks.deactivateLowSignalMemories).toHaveBeenCalledExactlyOnceWith(mocks.db, {
			kinds: ["exploration", "bugfix", "discovery"],
			limit: 7,
			dryRun: true,
		});
		expect(mocks.open).toHaveBeenCalledExactlyOnceWith("fixture.sqlite");
	});

	it.each([
		["--kind", "bogus"],
		["--kinds", "discovery,bogus"],
		["--kinds", ""],
	])("rejects invalid kinds before opening the database: %j", async (...args) => {
		// Arrange
		const flags = args as string[];
		// Act
		await run(flags);
		// Assert
		expect(mocks.open).not.toHaveBeenCalled();
		expect(mocks.deactivateLowSignalMemories).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("memory_prune_failed"));
	});
});
