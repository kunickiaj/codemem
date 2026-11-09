import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	exportMemories: vi.fn(),
	importMemories: vi.fn(),
	readImportPayload: vi.fn(),
	resolveDbPath: vi.fn((path: string) => path),
}));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	...mocks,
}));

import { registerRootCommands } from "../command-tree.js";

describe("canonical memory import/export parsed routing", () => {
	const originalArgv = process.argv;
	const originalExitCode = process.exitCode;
	const payload = {
		version: 1,
		sessions: [],
		memory_items: [],
		session_summaries: [],
		user_prompts: [],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		// Deliberately unrelated to parseAsync input. Routes must use parsed arguments.
		process.argv = [
			"node",
			"codemem",
			"memory",
			"export",
			"wrong.json",
			"--db-path",
			"wrong.sqlite",
		];
		process.exitCode = undefined;
		mocks.exportMemories.mockReturnValue(payload);
		mocks.readImportPayload.mockReturnValue(payload);
		mocks.importMemories.mockReturnValue({ sessions: 0, memory_items: 0, dryRun: true });
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
		vi.restoreAllMocks();
	});

	function program() {
		const root = registerRootCommands(new Command("codemem"))
			.exitOverride()
			.configureOutput({ writeErr: () => {} });
		const configure = (command: Command) => {
			command.exitOverride().configureOutput({ writeErr: () => {} });
			for (const child of command.commands) configure(child);
		};
		configure(root);
		return root;
	}

	it("exports using parsed shared flags and preserves a command-shaped project value", async () => {
		// Arrange
		const root = program();
		// Act
		await root.parseAsync(
			[
				"memory",
				"export",
				"-",
				"--db-path",
				"selected.sqlite",
				"--project",
				"export",
				"--include-inactive",
				"--since",
				"2026-01-01",
			],
			{ from: "user" },
		);
		// Assert
		expect(mocks.exportMemories).toHaveBeenCalledExactlyOnceWith({
			dbPath: "selected.sqlite",
			project: "export",
			includeInactive: true,
			since: "2026-01-01",
			allProjects: undefined,
		});
		expect(process.stdout.write).toHaveBeenCalledWith(`${JSON.stringify(payload, null, 2)}\n`);
	});

	it("imports parsed positional and option values without reading raw argv", async () => {
		// Arrange
		const root = program();
		// Act
		await root.parseAsync(
			[
				"memory",
				"import",
				"import",
				"--db-path",
				"selected.sqlite",
				"--remap-project",
				"export",
				"--dry-run",
				"--json",
			],
			{ from: "user" },
		);
		// Assert
		expect(mocks.readImportPayload).toHaveBeenCalledExactlyOnceWith("import");
		expect(mocks.importMemories).toHaveBeenCalledExactlyOnceWith(payload, {
			dbPath: "selected.sqlite",
			remapProject: "export",
			dryRun: true,
		});
	});

	it.each(["export", "import"])(
		"rejects unknown %s flags before invoking storage",
		async (name) => {
			// Arrange
			const root = program();
			// Act
			const result = root.parseAsync(["memory", name, "-", "--unsupported"], { from: "user" });
			// Assert
			await expect(result).rejects.toMatchObject({ code: "commander.unknownOption" });
			expect(mocks.exportMemories).not.toHaveBeenCalled();
			expect(mocks.readImportPayload).not.toHaveBeenCalled();
			expect(mocks.importMemories).not.toHaveBeenCalled();
		},
	);

	it("reports invalid import input before any writes", async () => {
		// Arrange
		const root = program();
		mocks.readImportPayload.mockImplementationOnce(() => {
			throw new Error("Invalid JSON");
		});
		// Act
		await root.parseAsync(["memory", "import", "invalid.json", "--json"], { from: "user" });
		// Assert
		expect(mocks.importMemories).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("invalid_input"));
	});
});
