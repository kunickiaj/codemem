import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	buildDistillReport: vi.fn(),
	closeStore: vi.fn(),
	storePaths: [] as Array<string | undefined>,
}));

vi.mock("@codemem/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@codemem/core")>();
	return {
		...actual,
		buildDistillReport: mocks.buildDistillReport,
		MemoryStore: class {
			constructor(dbPath?: string) {
				mocks.storePaths.push(dbPath);
			}
			close = mocks.closeStore;
		},
		resolveDbPath: (value?: string) => value,
	};
});

import { distillCommand, renderDistillReport } from "./distill.js";

afterEach(() => {
	mocks.buildDistillReport.mockReset();
	mocks.closeStore.mockReset();
	mocks.storePaths.length = 0;
	process.exitCode = 0;
	vi.restoreAllMocks();
});

async function parseDistillCommand(args: string[]): Promise<void> {
	const root = new Command("codemem");
	root.addCommand(distillCommand);
	await root.parseAsync(["distill", ...args], { from: "user" });
}

describe("distill command", () => {
	it("registers shared and distill-specific options", () => {
		const longs = distillCommand.options.map((option) => option.long);

		expect(longs).toContain("--db-path");
		expect(longs).toContain("--json");
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
		expect(longs).toContain("--kind");
		expect(longs).toContain("--min-recurrence");
		expect(longs).toContain("--limit");
		expect(longs).toContain("--explain");
		expect(longs).toContain("--include-documented");
	});

	it("emits JSON candidates and passes parsed options to core", async () => {
		mocks.buildDistillReport.mockResolvedValue({
			version: 1,
			candidates: [
				{
					scope: "project",
					suggested_target: "AGENTS.md",
					score: 0.4,
					recurrence: 2,
					projects: ["codemem"],
					member_ids: [1, 2],
					representative_id: 1,
					concepts: ["distill"],
					artifact_kind: "context_fact",
					evidence: ["Remember this."],
					draft_text: null,
				},
			],
			metadata: {
				candidate_count: 1,
				cluster_count: 1,
				context_document_count: 0,
				corpus_count: 2,
				documented_cluster_count: 0,
				include_documented: false,
				min_recurrence: 2,
			},
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseDistillCommand([
			"--json",
			"--db-path",
			"memory.sqlite",
			"--project",
			"codemem",
			"--kind",
			"decision,discovery",
			"--limit",
			"3",
			"--min-recurrence",
			"2",
		]);

		expect(mocks.storePaths).toEqual(["memory.sqlite"]);
		expect(mocks.buildDistillReport).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				corpus: expect.objectContaining({
					filters: { project: "codemem" },
					kinds: ["decision", "discovery"],
				}),
				limit: 3,
				minRecurrence: 2,
			}),
		);
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
			version: 1,
			candidates: [{ representative_id: 1, draft_text: null }],
		});
		expect(mocks.closeStore).toHaveBeenCalledTimes(1);
	});

	it("emits JSON usage errors without throwing", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await parseDistillCommand(["--json", "--project", "codemem", "--all-projects"]);

		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
			error: "usage_error",
			message: "--project cannot be combined with --all-projects",
		});
		expect(process.exitCode).toBe(2);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(mocks.buildDistillReport).not.toHaveBeenCalled();
	});

	it("renders evidence only when explain is enabled", () => {
		const report = {
			version: 1 as const,
			candidates: [
				{
					scope: "user" as const,
					suggested_target: "~/.config/opencode/AGENTS.md",
					score: 0.5,
					recurrence: 3,
					projects: ["codemem", "memorybench"],
					member_ids: [1, 2, 3],
					representative_id: 1,
					concepts: ["graphite"],
					artifact_kind: "context_fact" as const,
					evidence: ["Use HTTPS rewrite for Graphite submit."],
					draft_text: null,
				},
			],
			metadata: {
				candidate_count: 1,
				cluster_count: 1,
				context_document_count: 0,
				corpus_count: 3,
				corpus_limit: 2000,
				documented_cluster_count: 0,
				include_documented: false,
				min_recurrence: 2,
			},
		};

		expect(renderDistillReport(report, false)).not.toContain("HTTPS rewrite");
		expect(renderDistillReport(report, true)).toContain("Use HTTPS rewrite");
	});
});
