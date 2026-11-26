// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ProjectScopeInventoryProject } from "../../lib/api/sync";
import type { ProjectsInventoryViewModel } from "../projects-inventory-model";
import {
	firstScopeSelection,
	projectClusterKeys,
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

// The same cases pin projectInventoryGroupKeys in packages/core/src/project-inventory-groups.test.ts.
const entry = (
	workspace: string,
	overrides: Partial<{
		display_project: string;
		git_remote: string | null;
		identity_source: string;
		project: string | null;
		repository_identity: string | null;
		resolved_scope_id: string;
	}> = {},
) => ({
	display_project: "api",
	git_remote: null,
	identity_source: "cwd",
	project: "api",
	repository_identity: null,
	resolved_scope_id: "local-default",
	workspace_identity: workspace,
	...overrides,
});
const REMOTE_A = "https://example.test/acme/api.git";
const REMOTE_B = "https://example.test/other/api.git";

/** Each case lists entries, then which of them share a row (same letter, same row). */
const GROUP_CASES: Array<[string, ReturnType<typeof entry>[], string]> = [
	[
		"same name, Space and repository form one row",
		[entry("a", { git_remote: REMOTE_A }), entry("b", { git_remote: REMOTE_A })],
		"xx",
	],
	[
		"the same name in different Spaces stays separate",
		[entry("a"), entry("b", { resolved_scope_id: "team" })],
		"xy",
	],
	[
		"different repositories with one name stay separate",
		[entry("a", { git_remote: REMOTE_A }), entry("b", { git_remote: REMOTE_B })],
		"xy",
	],
	[
		"a folder without a repository joins the only repository of its name and Space",
		[
			entry("a", { git_remote: REMOTE_A }),
			entry("b"),
			entry("c", { display_project: "/old/API", project: null }),
		],
		"xxx",
	],
	[
		"folders without a repository stay apart when the name has two repositories",
		[
			entry("a", { git_remote: REMOTE_A }),
			entry("b", { git_remote: REMOTE_B }),
			entry("c"),
			entry("d"),
		],
		"xyzz",
	],
	[
		"an entry with only a generated workspace ID keeps its own row",
		[
			entry("ws-1", { display_project: "ws-1", identity_source: "workspace_id", project: null }),
			entry("ws-2", { display_project: "ws-2", identity_source: "workspace_id", project: null }),
		],
		"xy",
	],
];

function rowLetters(keys: string[]): string {
	const letters = new Map<string, string>();
	return keys
		.map((key) => {
			if (!letters.has(key)) letters.set(key, "xyzw"[letters.size] ?? "?");
			return letters.get(key);
		})
		.join("");
}

describe("Project row keys", () => {
	it.each(GROUP_CASES)("%s", (_name, entries, rows) => {
		const keys = projectClusterKeys(entries);
		expect(rowLetters(entries.map((item) => keys.get(item) ?? ""))).toBe(rows);
	});
});
