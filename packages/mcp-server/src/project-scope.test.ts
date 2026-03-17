import { afterEach, describe, expect, it, vi } from "vitest";

describe("project-scope helpers", () => {
	afterEach(() => {
		delete process.env.CODEMEM_PROJECT;
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	it("prefers CODEMEM_PROJECT when set", async () => {
		process.env.CODEMEM_PROJECT = "forced-project";
		const { resolveDefaultProject } = await import("./project-scope.js");
		expect(resolveDefaultProject()).toBe("forced-project");
	});

	it("buildFilters applies the default project when project is omitted", async () => {
		const { buildFilters } = await import("./project-scope.js");
		expect(buildFilters({ kind: "decision" }, "repo-name")).toEqual({
			kind: "decision",
			project: "repo-name",
		});
	});

	it("buildFilters respects an explicit project override", async () => {
		const { buildFilters } = await import("./project-scope.js");
		expect(buildFilters({ project: "manual", kind: "change" }, "repo-name")).toEqual({
			kind: "change",
			project: "manual",
		});
	});

	it("falls back to default project when env or request project is blank", async () => {
		process.env.CODEMEM_PROJECT = "   ";
		const { buildFilters, resolveDefaultProject } = await import("./project-scope.js");
		expect(resolveDefaultProject()).toBe("codemem");
		expect(buildFilters({ project: "   ", kind: "change" }, "repo-name")).toEqual({
			kind: "change",
			project: "repo-name",
		});
	});
});
