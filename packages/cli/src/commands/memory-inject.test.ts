import * as p from "@clack/prompts";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildMemoryPackAsync = vi.fn();
const closeStore = vi.fn();
const closeStoreAsync = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
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
			closeAsync = closeStoreAsync;
		},
		resolveDbPath: (value?: string) => value,
		resolveProject: (_cwd: string, override?: string | null) =>
			override?.trim() || "default-project",
	};
});

import { registerRootCommands } from "../command-tree.js";

beforeEach(() => vi.stubEnv("CODEMEM_PROJECT", ""));
afterEach(() => {
	buildMemoryPackAsync.mockReset();
	closeStore.mockReset();
	closeStoreAsync.mockReset().mockResolvedValue(undefined);
	storePaths.length = 0;
	process.exitCode = 0;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

async function parseInjectCommand(args: string[]): Promise<void> {
	const root = new Command("codemem");
	root.enablePositionalOptions();
	registerRootCommands(root);
	await root.parseAsync(["memory", "context", ...args], { from: "user" });
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("memory context command", () => {
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

		expect(buildMemoryPackAsync).toHaveBeenCalledWith(
			"continue viewer health work",
			10,
			90,
			{
				project: "codemem",
				working_set_paths: ["packages/ui/src/app.ts"],
			},
			undefined,
		);
		expect(logSpy).toHaveBeenLastCalledWith("RAW PACK BODY");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(storePaths.at(-1)).toBe("/tmp/codemem-test.sqlite");
		expect(closeStoreAsync).toHaveBeenCalledTimes(1);
		expect(closeStore).not.toHaveBeenCalled();
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
			undefined,
		);
		expect(logSpy).toHaveBeenLastCalledWith("");
		expect(closeStoreAsync).toHaveBeenCalledTimes(1);
		expect(closeStore).not.toHaveBeenCalled();
	});

	it("prints an empty string when inject returns no pack text", async () => {
		buildMemoryPackAsync.mockResolvedValue({ pack_text: "" });
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		await parseInjectCommand(["continue viewer health work"]);

		expect(logSpy).toHaveBeenLastCalledWith("");
		expect(closeStoreAsync).toHaveBeenCalledTimes(1);
		expect(closeStore).not.toHaveBeenCalled();
	});

	it("closes the store when inject pack generation fails", async () => {
		// Arrange: default context output is prompt text, so errors belong on stderr.
		buildMemoryPackAsync.mockRejectedValue(new Error("inject failed"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const clackError = vi.spyOn(p.log, "error").mockImplementation(() => {});

		// Act
		await parseInjectCommand(["continue viewer health work"]);

		// Assert
		expect(errorSpy).toHaveBeenCalledWith("inject failed");
		expect(logSpy).not.toHaveBeenCalled();
		expect(clackError).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(closeStoreAsync).toHaveBeenCalledTimes(1);
		expect(closeStore).not.toHaveBeenCalled();
	});
});

describe("memory context asynchronous store shutdown", () => {
	it.each(["success", "failure"] as const)(
		"awaits store shutdown after pack %s",
		async (outcome) => {
			// Arrange: command completion must join the owned store even after generation fails.
			vi.useFakeTimers();
			const failure = new Error("fixture pack failure");
			if (outcome === "failure") buildMemoryPackAsync.mockRejectedValueOnce(failure);
			else buildMemoryPackAsync.mockResolvedValueOnce({ pack_text: "DRAIN PACK" });
			const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
			const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
			const clackError = vi.spyOn(p.log, "error").mockImplementation(() => {});
			const closeEntered = deferred();
			const closeRelease = deferred();
			closeStoreAsync.mockImplementation(() => {
				closeEntered.resolve();
				return closeRelease.promise;
			});
			const finished = vi.fn();

			// Act: observe rejection immediately and release shutdown before making assertions.
			const command = parseInjectCommand(["fixture drain query"])
				.then(
					() => ({ error: null }),
					(error: unknown) => ({ error }),
				)
				.then((result) => {
					finished();
					return result;
				});
			await closeEntered.promise;
			await vi.advanceTimersByTimeAsync(0);
			const completedBeforeClose = finished.mock.calls.length;
			closeRelease.resolve();
			const result = await command;

			// Assert
			expect(completedBeforeClose).toBe(0);
			expect(result).toEqual({ error: null });
			expect(process.exitCode).toBe(outcome === "failure" ? 1 : 0);
			expect(closeStoreAsync).toHaveBeenCalledTimes(1);
			expect(closeStore).not.toHaveBeenCalled();
			expect(finished).toHaveBeenCalledTimes(1);
			expect(clackError).not.toHaveBeenCalled();
			if (outcome === "failure") {
				expect(stdout).not.toHaveBeenCalled();
				expect(stderr).toHaveBeenCalledExactlyOnceWith("fixture pack failure");
			} else {
				expect(stdout).toHaveBeenCalledExactlyOnceWith("DRAIN PACK");
				expect(stderr).not.toHaveBeenCalled();
			}
		},
	);
});
