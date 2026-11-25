// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ProjectScopeInventoryProject } from "../../lib/api/sync";
import type { ProjectsInventoryViewModel } from "../projects-inventory-model";
import {
	firstScopeSelection,
	projectClusterKey,
	projectDomId,
	projectHeading,
	scopeIsAvailable,
} from "./project-view";

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

describe("project DOM IDs", () => {
	it("keeps punctuation-only identity differences unique", () => {
		const left = projectDomId("project-title", "cwd:/work/foo.bar");
		const right = projectDomId("project-title", "cwd:/work/foo/bar");

		expect(left).not.toBe(right);
	});
});

function namedProject(overrides: Partial<ProjectScopeInventoryProject>) {
	return {
		cwd: null,
		display_project: "api",
		git_remote: null,
		identity_source: "git_remote",
		project: "api",
		repository_identity: null,
		workspace_identity: "git:api",
		...overrides,
	} as ProjectScopeInventoryProject;
}

describe("project heading", () => {
	it("keeps a recorded project name and shortens the home directory in its path", () => {
		const heading = projectHeading(namedProject({ cwd: "/Users/sam/work/api" }));

		expect(heading).toEqual({ title: "api", signal: "~/work/api" });
	});

	it("prefers the git remote over the path as the secondary line", () => {
		const heading = projectHeading(
			namedProject({ cwd: "/Users/sam/work/api", git_remote: "git@example.invalid:team/api.git" }),
		);

		expect(heading.signal).toBe("git@example.invalid:team/api.git");
	});

	it.each([
		["/Users/sam/work/points-tracker", "points-tracker", "~/work/points-tracker"],
		["C:\\Users\\sam\\work\\points-tracker", "points-tracker", "~\\work\\points-tracker"],
		["/", "/", "/"],
	])("names a path-only Project %s by its last folder", (path, title, signal) => {
		const heading = projectHeading(
			namedProject({ display_project: path, project: path, identity_source: "workspace_id" }),
		);

		expect(heading).toEqual({ title, signal });
	});

	it.each(["peer-received:0f0f", "shared:default"])(
		"labels memories recorded without a project name (%s)",
		(workspaceIdentity) => {
			const heading = projectHeading(
				namedProject({
					display_project: workspaceIdentity,
					identity_source: "workspace_id",
					project: null,
					workspace_identity: workspaceIdentity,
				}),
			);

			expect(heading).toEqual({ title: "No project", signal: "" });
		},
	);

	it("keeps a generated-looking name that the user recorded as the project", () => {
		const heading = projectHeading(
			namedProject({
				display_project: "shared:default",
				identity_source: "workspace_id",
				project: "shared:default",
				workspace_identity: "shared:default",
			}),
		);

		expect(heading.title).toBe("shared:default");
	});
});

// The same cases pin projectInventoryGroupKey in packages/core/src/project-scope-settings.test.ts.
describe("Project group key", () => {
	it.each([
		[
			{ git_remote: "https://example.test/acme/api.git", project: "api", workspace_identity: "a" },
			"git:https://example.test/acme/api.git",
		],
		[{ git_remote: null, project: "api", workspace_identity: "/workspace/api" }, "project:api"],
		[{ git_remote: null, project: null, workspace_identity: "ws-1" }, "identity:ws-1"],
	])("groups %o under %s", (project, key) => {
		expect(projectClusterKey(project)).toBe(key);
	});
});
