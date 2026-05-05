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

	it("passes through advanced search knobs", async () => {
		const { buildFilters } = await import("./project-scope.js");
		expect(
			buildFilters(
				{
					personal_first: false,
					trust_bias: "soft",
					widen_shared_when_weak: true,
					widen_shared_min_personal_results: 2,
					widen_shared_min_personal_score: 0.3,
					ownership_scope: "mine",
				},
				"repo-name",
			),
		).toEqual({
			personal_first: false,
			project: "repo-name",
			trust_bias: "soft",
			widen_shared_when_weak: true,
			widen_shared_min_personal_results: 2,
			widen_shared_min_personal_score: 0.3,
			ownership_scope: "mine",
		});
	});

	it("passes through scope filters while preserving default project narrowing", async () => {
		const { buildFilters } = await import("./project-scope.js");
		expect(
			buildFilters(
				{
					scope_id: "scope-a",
					include_scope_ids: ["scope-a", "scope-b"],
					exclude_scope_ids: ["scope-c"],
				},
				"repo-name",
			),
		).toEqual({
			project: "repo-name",
			scope_id: "scope-a",
			include_scope_ids: ["scope-a", "scope-b"],
			exclude_scope_ids: ["scope-c"],
		});
	});

	it("supports scope-only filters for direct ID tools without default project widening", async () => {
		const { buildFilters } = await import("./project-scope.js");
		expect(buildFilters({ scope_id: "scope-a" }, null)).toEqual({
			scope_id: "scope-a",
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
