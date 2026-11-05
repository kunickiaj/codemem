import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema, MemoryStore, queryRetrievalAttempts } from "@codemem/core";
import { callCodememToolLocally } from "@codemem/mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseToolArguments, runMemoryTool } from "./memory-tool.js";

const ENV_KEYS = ["CODEMEM_CONFIG", "CODEMEM_EMBEDDING_DISABLED", "HOME", "CODEMEM_PROJECT"];
const savedEnv: Record<string, string | undefined> = {};

let tempDirectory: string;
let databasePath: string;
let output: string[];

function run(name: string, stdin: string): Promise<void> {
	return runMemoryTool(
		name,
		{ dbPath: databasePath },
		{ readStdin: async () => stdin, write: (line) => output.push(line) },
	);
}

function lastLine(): Record<string, unknown> {
	return JSON.parse(output.at(-1) ?? "null") as Record<string, unknown>;
}

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	tempDirectory = mkdtempSync(join(tmpdir(), "codemem-memory-tool-"));
	const projectDirectory = join(tempDirectory, "tool-fixture");
	mkdirSync(projectDirectory);
	process.env.CODEMEM_CONFIG = join(tempDirectory, "config.json");
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	process.env.HOME = tempDirectory;
	delete process.env.CODEMEM_PROJECT;
	vi.spyOn(process, "cwd").mockReturnValue(projectDirectory);
	databasePath = join(tempDirectory, "memory.sqlite");
	const database = connect(databasePath);
	initTestSchema(database);
	database.close();
	output = [];
	process.exitCode = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(tempDirectory, { recursive: true, force: true });
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	process.exitCode = undefined;
});

describe("parseToolArguments", () => {
	it("treats empty stdin as no arguments", () => {
		expect(parseToolArguments("  \n")).toEqual({});
	});

	it("rejects JSON that is not an object", () => {
		expect(() => parseToolArguments("[1]")).toThrow(/JSON object/);
		expect(() => parseToolArguments("null")).toThrow(/JSON object/);
	});
});

describe("runMemoryTool", () => {
	it("writes a memory and finds it from the caller's project directory", async () => {
		await run(
			"memory_remember",
			JSON.stringify({
				kind: "decision",
				title: "CLI fallback",
				body: "Fallback body",
				project: "tool-fixture",
			}),
		);
		const remembered = lastLine() as { ok: boolean; result: { id: number } };
		expect(remembered.ok).toBe(true);

		await run("memory_recent", "");

		const recent = lastLine() as { result: { items: Array<{ id: number }> } };
		expect(recent.result.items.map((item) => item.id)).toEqual([remembered.result.id]);
		expect(process.exitCode).toBeUndefined();
	});

	it("does not return another project's memory by default", async () => {
		await run(
			"memory_remember",
			JSON.stringify({ kind: "decision", title: "Elsewhere", body: "b", project: "other" }),
		);

		await run("memory_recent", "");

		expect(lastLine()).toEqual({ ok: true, result: { items: [] } });
	});

	it("exits 0 with ok:false when the tool itself reports an error", async () => {
		await run("memory_get", JSON.stringify({ memory_id: 424242 }));

		expect(lastLine()).toMatchObject({ ok: false, error: "not_found" });
		expect(process.exitCode).toBeUndefined();
	});

	it("exits 1 for a name outside the memory tool namespace", async () => {
		await run("shell_exec", "");

		expect(lastLine()).toMatchObject({ ok: false, error: "invalid_tool" });
		expect(process.exitCode).toBe(1);
	});

	it("exits 1 for stdin that is not a JSON object", async () => {
		await run("memory_search", "not json");

		expect(lastLine()).toMatchObject({ ok: false, error: "invalid_arguments" });
		expect(process.exitCode).toBe(1);
	});
});

describe("runMemoryTool ledger identity", () => {
	it("records one attempt when a viewer call is retried through the CLI", async () => {
		// The viewer route runs the same handler statelessly. A read whose viewer
		// response was lost and that the host retried here must not count twice.
		await run(
			"memory_remember",
			JSON.stringify({ kind: "decision", title: "Ledger", body: "b", project: "tool-fixture" }),
		);
		const store = new MemoryStore(databasePath);
		try {
			await callCodememToolLocally(
				store,
				"memory_search",
				{ query: "Ledger" },
				{ sessionId: "ses_retry", requestId: "call_1", statelessLedger: true },
			);
		} finally {
			await store.closeAsync();
		}

		await runMemoryTool(
			"memory_search",
			{ dbPath: databasePath, sessionId: "ses_retry", requestId: "call_1" },
			{ readStdin: async () => JSON.stringify({ query: "Ledger" }), write: () => {} },
		);

		const reader = new MemoryStore(databasePath);
		try {
			expect(queryRetrievalAttempts(reader.db, { surface: "mcp_search" })).toHaveLength(1);
		} finally {
			await reader.closeAsync();
		}
	});
});
