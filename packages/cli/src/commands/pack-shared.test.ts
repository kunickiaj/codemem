import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
	addPackRequestOptions,
	buildPackRequestOptions,
	collectWorkingSetFile,
	PackUsageError,
} from "./pack-shared.js";

describe("collectWorkingSetFile", () => {
	it("appends paths in order", () => {
		expect(collectWorkingSetFile("src/a.ts", ["src/z.ts"])).toEqual(["src/z.ts", "src/a.ts"]);
	});
});

describe("buildPackRequestOptions", () => {
	it("prefers CODEMEM_PROJECT over explicit project option", () => {
		const result = buildPackRequestOptions(
			{
				limit: "12",
				budget: "300",
				project: "from-option",
				workingSetFile: ["src/a.ts"],
			},
			{
				envProject: "from-env",
				resolveProjectFn: () => "from-resolver",
			},
		);

		expect(result).toEqual({
			limit: 12,
			budget: 300,
			filters: {
				project: "from-env",
				working_set_paths: ["src/a.ts"],
			},
		});
	});

	it("uses resolver project when env override is absent", () => {
		const result = buildPackRequestOptions(
			{
				limit: "8",
				tokenBudget: "250",
				project: "from-option",
			},
			{
				cwd: "/tmp/worktree",
				resolveProjectFn: (cwd, project) => `${cwd}:${project}`,
			},
		);

		expect(result).toEqual({
			limit: 8,
			budget: 250,
			filters: {
				project: "/tmp/worktree:from-option",
			},
		});
	});

	it("omits project filter when allProjects is enabled", () => {
		const result = buildPackRequestOptions(
			{
				allProjects: true,
				workingSetFile: ["src/a.ts", "src/b.ts"],
			},
			{
				envProject: "from-env",
				resolveProjectFn: () => "from-resolver",
			},
		);

		expect(result).toEqual({
			limit: 10,
			budget: undefined,
			filters: {
				working_set_paths: ["src/a.ts", "src/b.ts"],
			},
		});
	});

	it("rejects invalid numeric inputs instead of silently coercing them", () => {
		expect(() => buildPackRequestOptions({ limit: "nope" })).toThrow(PackUsageError);
		expect(() => buildPackRequestOptions({ tokenBudget: "bad" })).toThrow(PackUsageError);
	});
});

describe("addPackRequestOptions", () => {
	it("attaches the shared pack flags to a command", () => {
		const command = addPackRequestOptions(new Command("pack-test"));
		const longs = command.options.map((option) => option.long);
		expect(longs).toContain("--limit");
		expect(longs).toContain("--budget");
		expect(longs).toContain("--token-budget");
		expect(longs).toContain("--working-set-file");
		expect(longs).toContain("--project");
		expect(longs).toContain("--all-projects");
	});
});
