import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const buildMemoryPackAsync = vi.fn();
const buildMemoryPackTraceAsync = vi.fn();
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
			buildMemoryPackTraceAsync = buildMemoryPackTraceAsync;
			close = closeStore;
		},
		resolveDbPath: (value?: string) => value,
	};
});

import { packCommand, renderPackTrace } from "./pack.js";

afterEach(() => {
	buildMemoryPackAsync.mockReset();
	buildMemoryPackTraceAsync.mockReset();
	closeStore.mockReset();
	storePaths.length = 0;
	process.exitCode = 0;
	vi.restoreAllMocks();
});

async function parsePackCommand(args: string[]): Promise<void> {
	const root = new Command("codemem");
	root.enablePositionalOptions();
	root.addCommand(packCommand);
	await root.parseAsync(["pack", ...args], { from: "user" });
}

async function parseTraceCommand(args: string[]): Promise<void> {
	const trace = packCommand.commands.find((command) => command.name() === "trace");
	if (!trace) throw new Error("trace command missing");
	await trace.parseAsync(args, { from: "user" });
}

describe("pack command", () => {
	it("registers trace as a pack subcommand with shared options", () => {
		const trace = packCommand.commands.find((command) => command.name() === "trace");
		expect(trace).toBeDefined();
		expect(trace?.registeredArguments[0]?.required).toBe(true);
		expect(trace?.registeredArguments[0]?.name()).toBe("context");
		const longs = trace?.options.map((option) => option.long) ?? [];
		expect(longs).toContain("--db-path");
		expect(longs).toContain("--json");
		expect(longs).toContain("--working-set-file");
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
	});

	it("renders grouped human-readable trace text", () => {
		const rendered = renderPackTrace({
			version: 1,
			inputs: {
				query: "continue viewer health work",
				project: "codemem",
				working_set_files: ["packages/ui/src/app.ts"],
				token_budget: 1800,
				limit: 10,
			},
			mode: {
				selected: "task",
				reasons: ["query matched task hints", "working set present"],
			},
			retrieval: {
				candidate_count: 2,
				candidates: [
					{
						id: 101,
						rank: 1,
						kind: "decision",
						title: "Keep Search as the inspector entry point",
						preview: "Search is the first manual query surface.",
						scores: {
							base_score: 1.2,
							combined_score: 2.4,
							recency: 0.9,
							kind_bonus: 0.2,
							quality_boost: 0.1,
							working_set_overlap: 0.16,
							query_path_overlap: 0,
							personal_bias: 0,
							shared_trust_penalty: 0,
							recap_penalty: 0,
							tasklike_penalty: 0,
							text_overlap: 2,
							tag_overlap: 1,
						},
						reasons: ["matched query terms", "selected for summary"],
						disposition: "selected",
						section: "summary",
					},
					{
						id: 102,
						rank: 2,
						kind: "feature",
						title: "Viewer Inspector follow-on",
						preview: "Manual query inspection follows the CLI trace.",
						scores: {
							base_score: 0.8,
							combined_score: 1.4,
							recency: 0.8,
							kind_bonus: 0.18,
							quality_boost: 0.08,
							working_set_overlap: 0,
							query_path_overlap: 0,
							personal_bias: 0,
							shared_trust_penalty: 0,
							recap_penalty: 0,
							tasklike_penalty: 0,
							text_overlap: 1,
							tag_overlap: 0,
						},
						reasons: ["not selected for final pack"],
						disposition: "dropped",
						section: null,
					},
				],
			},
			assembly: {
				deduped_ids: [],
				collapsed_groups: [],
				trimmed_ids: [],
				trim_reasons: [],
				sections: {
					summary: [101],
					timeline: [],
					observations: [],
				},
			},
			output: {
				estimated_tokens: 42,
				truncated: false,
				section_counts: {
					summary: 1,
					timeline: 0,
					observations: 0,
				},
				pack_text: "## Summary\n[101] (decision) Keep Search as the inspector entry point",
			},
		});

		expect(rendered).toContain("Pack trace");
		expect(rendered).toContain("Mode reasons: query matched task hints, working set present");
		expect(rendered).toContain("Selected");
		expect(rendered).toContain("Dropped");
		expect(rendered).toContain("truncated: no");
		expect(rendered).toContain("Final pack");
		expect(rendered).toContain("## Summary");
	});

	it("supports the commander command path with json output", async () => {
		buildMemoryPackTraceAsync.mockResolvedValue({
			version: 1,
			inputs: {
				query: "continue viewer health work",
				project: "codemem",
				working_set_files: [],
				token_budget: null,
				limit: 10,
			},
			mode: { selected: "task", reasons: ["query matched task hints"] },
			retrieval: { candidate_count: 0, candidates: [] },
			assembly: {
				deduped_ids: [],
				collapsed_groups: [],
				trimmed_ids: [],
				trim_reasons: [],
				sections: { summary: [], timeline: [], observations: [] },
			},
			output: {
				estimated_tokens: 0,
				truncated: false,
				section_counts: { summary: 0, timeline: 0, observations: 0 },
				pack_text: "",
			},
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseTraceCommand(["continue viewer health work", "--json"]);

		const output = logSpy.mock.calls.at(-1)?.[0];
		expect(typeof output).toBe("string");
		expect(JSON.parse(String(output))).toMatchObject({
			version: 1,
			mode: { selected: "task" },
		});
	});

	it("emits structured json errors for trace failures", async () => {
		buildMemoryPackTraceAsync.mockRejectedValue(new Error("trace blew up"));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await parseTraceCommand(["continue viewer health work", "--json"]);

		const output = logSpy.mock.calls.at(-1)?.[0];
		expect(JSON.parse(String(output))).toEqual({
			error: "pack_trace_failed",
			message: "trace blew up",
		});
		expect(process.exitCode).toBe(1);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("emits structured usage errors for invalid numeric json input", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await parseTraceCommand(["continue viewer health work", "--json", "--limit", "nope"]);

		const output = logSpy.mock.calls.at(-1)?.[0];
		expect(JSON.parse(String(output))).toEqual({
			error: "usage_error",
			message: "limit must be a positive integer",
		});
		expect(process.exitCode).toBe(2);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(buildMemoryPackTraceAsync).not.toHaveBeenCalled();
	});

	it("dispatches the nested pack trace commander path", async () => {
		buildMemoryPackTraceAsync.mockResolvedValue({
			version: 1,
			inputs: {
				query: "continue viewer health work",
				project: null,
				working_set_files: [],
				token_budget: null,
				limit: 10,
			},
			mode: { selected: "task", reasons: ["query matched task hints"] },
			retrieval: { candidate_count: 0, candidates: [] },
			assembly: {
				deduped_ids: [],
				collapsed_groups: [],
				trimmed_ids: [],
				trim_reasons: [],
				sections: { summary: [], timeline: [], observations: [] },
			},
			output: {
				estimated_tokens: 0,
				truncated: false,
				section_counts: { summary: 0, timeline: 0, observations: 0 },
				pack_text: "",
			},
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await parsePackCommand(["trace", "continue viewer health work"]);

		expect(buildMemoryPackTraceAsync).toHaveBeenCalledTimes(1);
		expect(String(logSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Pack trace");
	});

	it("routes trace flags to the trace subcommand after the positional context", async () => {
		buildMemoryPackTraceAsync.mockResolvedValue({
			version: 1,
			inputs: {
				query: "continue viewer health work",
				project: null,
				working_set_files: [],
				token_budget: null,
				limit: 10,
			},
			mode: { selected: "task", reasons: ["query matched task hints"] },
			retrieval: { candidate_count: 0, candidates: [] },
			assembly: {
				deduped_ids: [],
				collapsed_groups: [],
				trimmed_ids: [],
				trim_reasons: [],
				sections: { summary: [], timeline: [], observations: [] },
			},
			output: {
				estimated_tokens: 0,
				truncated: false,
				section_counts: { summary: 0, timeline: 0, observations: 0 },
				pack_text: "",
			},
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await parsePackCommand([
			"trace",
			"continue viewer health work",
			"--json",
			"--db-path",
			"/tmp/codemem-test.sqlite",
		]);

		expect(buildMemoryPackTraceAsync).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({ version: 1 });
		expect(storePaths.at(-1)).toBe("/tmp/codemem-test.sqlite");
	});
});
