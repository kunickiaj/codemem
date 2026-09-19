import { describe, expect, it } from "vitest";
import type { ProjectScopeInventoryProject } from "../../lib/api/sync";
import type { ProjectsInventoryViewModel } from "../projects-inventory-model";
import { firstScopeSelection, scopeIsAvailable } from "./project-view";

const view = {
	scopeGroups: [
		{
			label: "Active Team",
			scopes: [{ label: "Active Space", scope_id: "active-space" }],
		},
	],
} as unknown as ProjectsInventoryViewModel;

describe("project Space selection", () => {
	it("rejects draft and suggested Spaces that disappeared from inventory", () => {
		const project = {
			resolved_scope_id: "resolved-unavailable",
			suggested_scope_id: "suggested-unavailable",
		} as ProjectScopeInventoryProject;

		expect(scopeIsAvailable("draft-unavailable", view)).toBe(false);
		expect(firstScopeSelection(project, "draft-unavailable", view)).toBe("resolved-unavailable");
	});

	it("prefers an available draft Space", () => {
		const project = {
			resolved_scope_id: "resolved-unavailable",
			suggested_scope_id: "suggested-unavailable",
		} as ProjectScopeInventoryProject;

		expect(scopeIsAvailable("active-space", view)).toBe(true);
		expect(firstScopeSelection(project, "active-space", view)).toBe("active-space");
	});
});
