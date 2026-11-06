import { MEMORY_FILTER_FIELD_TYPES } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const forwardedFilterFields = Object.entries(MEMORY_FILTER_FIELD_TYPES).filter(
	([key]) => key !== "project",
);

const filterValues = {
	string: "requested-value",
	"string-array": ["requested-value", "another-value"],
	int: 2,
	number: 0.3,
	"boolean-or-string": true,
};

const emptyFilterValues = {
	string: "",
	"string-array": [],
	int: 0,
	number: 0,
	"boolean-or-string": false,
};

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

describe("buildFilters shared catalog regression coverage", () => {
	// Generate coverage from core so new filters, especially exclusions, cannot be omitted silently.
	it.each(forwardedFilterFields)("forwards catalog filter %s unchanged", async (key, fieldType) => {
		const { buildFilters } = await import("./project-scope.js");
		const value = filterValues[fieldType];
		const raw = { [key]: value };

		const filters = buildFilters(raw, null);

		expect(filters).toEqual(raw);
		expect(filters?.[key as keyof NonNullable<typeof filters>]).toBe(value);
	});

	it.each(forwardedFilterFields)(
		"preserves empty or falsy catalog filter %s",
		async (key, fieldType) => {
			const { buildFilters } = await import("./project-scope.js");
			const raw = { [key]: emptyFilterValues[fieldType] };

			const filters = buildFilters(raw, null);

			expect(filters).toEqual(raw);
		},
	);

	it.each(forwardedFilterFields)("omits null and undefined catalog filter %s", async (key) => {
		const { buildFilters } = await import("./project-scope.js");

		const nullFilters = buildFilters({ [key]: null }, null);
		const undefinedFilters = buildFilters({ [key]: undefined }, null);

		expect(nullFilters).toBeUndefined();
		expect(undefinedFilters).toBeUndefined();
	});

	it.each([
		{ project: "  explicit  ", defaultProject: "  default  ", expected: { project: "explicit" } },
		{ project: "", defaultProject: "  default  ", expected: { project: "default" } },
		{ project: "   ", defaultProject: "default", expected: { project: "default" } },
		{ project: null, defaultProject: "default", expected: { project: "default" } },
		{ project: undefined, defaultProject: "default", expected: { project: "default" } },
		{ project: 42, defaultProject: "default", expected: { project: "default" } },
		{ project: "explicit", defaultProject: null, expected: { project: "explicit" } },
		{ project: null, defaultProject: null, expected: undefined },
		{ project: "   ", defaultProject: "   ", expected: undefined },
	])("resolves project separately from catalog passthrough: %j", async (testCase) => {
		const { buildFilters } = await import("./project-scope.js");
		const { project, defaultProject, expected } = testCase;

		const filters = buildFilters({ project }, defaultProject);

		expect(filters).toEqual(expected);
	});

	it.each([
		{ raw: { unknown_filter: ["ignored"] }, defaultProject: null, expected: undefined },
		{ raw: {}, defaultProject: null, expected: undefined },
		{
			raw: { unknown_filter: ["ignored"], kind: "decision" },
			defaultProject: "default",
			expected: { kind: "decision", project: "default" },
		},
	])("ignores unknown keys without changing supported filters: %j", async (testCase) => {
		const { buildFilters } = await import("./project-scope.js");
		const { raw, defaultProject, expected } = testCase;

		const filters = buildFilters(raw, defaultProject);

		expect(filters).toEqual(expected);
	});
});
