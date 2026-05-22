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

	it("supports explicit null default project for future all-project contexts", async () => {
		const { buildFilters } = await import("./project-scope.js");
		expect(buildFilters({ scope_id: "scope-a" }, null)).toEqual({
			scope_id: "scope-a",
		});
	});

	it("falls back to default project when env or request project is blank on read filters", async () => {
		process.env.CODEMEM_PROJECT = "   ";
		const { buildFilters, resolveDefaultProject } = await import("./project-scope.js");
		expect(resolveDefaultProject()).toBe("codemem");
		expect(buildFilters({ project: "   ", kind: "change" }, "repo-name")).toEqual({
			kind: "change",
			project: "repo-name",
		});
	});

	it("resolveWriteProject never falls back to the server default project", async () => {
		// Writes intentionally do not inherit cwd/server default. Otherwise blank
		// inputs in stdio mode would silently stamp a project the caller did not
		// ask for. See memory_remember in tools/items.ts.
		const { resolveWriteProject } = await import("./project-scope.js");
		expect(resolveWriteProject({ project: undefined, envProject: undefined })).toBeNull();
		expect(resolveWriteProject({ project: "   ", envProject: "   " })).toBeNull();
		expect(resolveWriteProject({ project: "explicit" })).toBe("explicit");
		expect(resolveWriteProject({ envProject: "env-value" })).toBe("env-value");
	});
});
