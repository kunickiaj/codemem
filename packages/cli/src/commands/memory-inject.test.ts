import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const buildMemoryPackAsync = vi.fn();
const closeStore = vi.fn();
const storePaths: Array<string | undefined> = [];

vi.mock("@codemem/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@codemem/core")>();
	return {
		...actual,
		MemoryStore: class {
			constructor(dbPath?: string) {
				storePaths.push(dbPath);
			}
			buildMemoryPackAsync = buildMemoryPackAsync;
			close = closeStore;
		},
		resolveDbPath: (value?: string) => value,
		resolveProject: (_cwd: string, override?: string | null) =>
			override?.trim() || "default-project",
	};
});

import { memoryCommand } from "./memory.js";

afterEach(() => {
	buildMemoryPackAsync.mockReset();
	closeStore.mockReset();
	storePaths.length = 0;
	process.exitCode = 0;
	vi.restoreAllMocks();
});

async function parseInjectCommand(args: string[]): Promise<void> {
	const root = new Command("codemem");
	root.enablePositionalOptions();
	root.addCommand(memoryCommand);
	await root.parseAsync(["memory", "inject", ...args], { from: "user" });
}

describe("memory inject command", () => {
	it("prints raw pack text and forwards project and working-set flags", async () => {
		buildMemoryPackAsync.mockResolvedValue({ pack_text: "RAW PACK BODY" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await parseInjectCommand([
			"continue viewer health work",
			"--project",
			"codemem",
			"--working-set-file",
			"packages/ui/src/app.ts",
			"--token-budget",
			"90",
			"--db-path",
			"/tmp/codemem-test.sqlite",
		]);

		expect(buildMemoryPackAsync).toHaveBeenCalledWith("continue viewer health work", 10, 90, {
			project: "codemem",
			working_set_paths: ["packages/ui/src/app.ts"],
		});
		expect(logSpy).toHaveBeenLastCalledWith("RAW PACK BODY");
		expect(errorSpy).toHaveBeenCalledWith(
			"Warning: 'codemem memory inject' is deprecated, use 'codemem pack' instead.",
		);
		expect(storePaths.at(-1)).toBe("/tmp/codemem-test.sqlite");
		expect(closeStore).toHaveBeenCalledTimes(1);
	});

	it("omits project filters for all-projects inject requests", async () => {
		buildMemoryPackAsync.mockResolvedValue({ pack_text: "" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		await parseInjectCommand([
			"continue viewer health work",
			"--all-projects",
			"--working-set-file",
			"packages/ui/src/app.ts",
		]);

		expect(buildMemoryPackAsync).toHaveBeenCalledWith(
			"continue viewer health work",
			10,
			undefined,
			{ working_set_paths: ["packages/ui/src/app.ts"] },
		);
		expect(logSpy).toHaveBeenLastCalledWith("");
	});

	it("prints an empty string when inject returns no pack text", async () => {
		buildMemoryPackAsync.mockResolvedValue({ pack_text: "" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		await parseInjectCommand(["continue viewer health work"]);

		expect(logSpy).toHaveBeenLastCalledWith("");
	});

	it("closes the store when inject pack generation fails", async () => {
		buildMemoryPackAsync.mockRejectedValue(new Error("inject failed"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await parseInjectCommand(["continue viewer health work"]).catch(() => {});

		expect(errorSpy).toHaveBeenCalledWith(
			"Warning: 'codemem memory inject' is deprecated, use 'codemem pack' instead.",
		);
		expect(closeStore).toHaveBeenCalledTimes(1);
	});
});
