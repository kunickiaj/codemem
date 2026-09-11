import { buildMemoryPackTrace, MemoryStore } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as retrieval from "../../../core/src/search.js";
import { buildInjectQuery, workingSetPathsFromState } from "./claude-hook-session-state.js";

const runtimePath = "../../../opencode-plugin/.opencode/lib/runtime.js";
const { __testUtils: runtime } = await import(new URL(runtimePath, import.meta.url).href);
const project = "codemem";
const files = Array.from({ length: 9 }, (_, index) => `src/file${index}.ts`);

const builders = {
	claude(prompt: string, modifiedFiles = files) {
		const state = {
			first_prompt: prompt,
			last_prompt: prompt,
			files_modified: modifiedFiles,
			updated_at: "",
		};
		return {
			query: buildInjectQuery({ prompt, project, state }),
			paths: workingSetPathsFromState(state),
		};
	},
	opencode(prompt: string, modifiedFiles = files) {
		const query: string = runtime.buildInjectQuery({
			firstPrompt: prompt,
			lastPromptText: prompt,
			projectName: project,
			filesModified: new Set(modifiedFiles),
		});
		const args: string[] = runtime.buildPackArgs({ query, filesModified: new Set(modifiedFiles) });
		const paths = args.filter((_, index) => args[index - 1] === "--working-set-file");
		return { query, paths };
	},
};

afterEach(() => vi.restoreAllMocks());

describe.each(Object.entries(builders))("%s hook task intent", (_, build) => {
	it.each([
		{ prompt: "show pending tasks", mode: "task" },
		{ prompt: "list tasks", mode: "task" },
		{ prompt: "PLEASE show us our open follow ups about Orchid?!", mode: "task" },
		{ prompt: "pending tasks!!!", mode: "task" },
		{ prompt: "show follow\tups", mode: "default" },
		{ prompt: "show the pending tasks table schema", mode: "default" },
		{ prompt: "show how the scheduler queues tasks", mode: "default" },
	])("classifies the prompt without losing retrieval context: $prompt", ({ prompt, mode }) => {
		const { query, paths } = build(prompt);
		expect(query).toBe(`${prompt} codemem file4.ts file5.ts file6.ts file7.ts file8.ts`);
		expect(paths).toEqual(files.slice(-8));
		const store = new MemoryStore(":memory:");
		try {
			const search = vi.spyOn(retrieval, "search");
			const trace = buildMemoryPackTrace(store, query, 10, null, {
				project,
				working_set_paths: paths,
			});
			expect(trace.mode.selected).toBe(mode);
			expect(trace.inputs.query).toBe(query);
			const searched = search.mock.calls[0]?.[1];
			if (mode === "task") expect(searched?.startsWith(`${query} `)).toBe(true);
			else expect(searched).toBe(query);
		} finally {
			store.close();
		}
	});

	it("does not guess a suffix when metadata differs or the builder truncated it", () => {
		const { query, paths } = build("show pending tasks");
		const truncated = build(`show pending tasks ${"x".repeat(490)}`).query;
		const store = new MemoryStore(":memory:");
		try {
			for (const { context, filters } of [
				{ context: query, filters: { project: "different", working_set_paths: paths } },
				{ context: query, filters: undefined },
				{ context: truncated, filters: { project, working_set_paths: paths } },
			]) {
				const trace = buildMemoryPackTrace(store, context, 10, null, filters);
				expect(trace.mode.selected).toBe("default");
				expect(trace.inputs.query).toBe(context);
			}
		} finally {
			store.close();
		}
	});

	it("handles adversarial prompts through the real capped builder", () => {
		const store = new MemoryStore(":memory:");
		try {
			for (const prompt of [
				`show ${"open ".repeat(20_000)}tasks trailing`,
				`show${" ".repeat(100_000)}!`,
				`tasks${"!".repeat(100_000)}x`,
			]) {
				const { query, paths } = build(prompt);
				expect(query.length).toBeLessThanOrEqual(500);
				const trace = buildMemoryPackTrace(store, query, 10, null, {
					project,
					working_set_paths: paths,
				});
				expect(trace.inputs.query).toBe(query);
				// The punctuation run is truncated to a valid bare collection.
				expect(trace.mode.selected).toBe(prompt.startsWith("tasks") ? "task" : "default");
			}
		} finally {
			store.close();
		}
	});

	it("handles a long trailing-slash path using the builder's actual query and metadata", () => {
		const { query, paths } = build("list tasks", [`src/file.ts${"/".repeat(100_000)}`]);
		const store = new MemoryStore(":memory:");
		try {
			const trace = buildMemoryPackTrace(store, query, 10, null, {
				project,
				working_set_paths: paths,
			});
			expect(trace.mode.selected).toBe("task");
			expect(trace.inputs.query).toBe(query);
		} finally {
			store.close();
		}
	});
});
