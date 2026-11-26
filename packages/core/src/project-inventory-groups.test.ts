import { describe, expect, it } from "vitest";
import { projectInventoryGroupKeys } from "./project-inventory-groups.js";

// The same cases pin projectClusterKeys in packages/ui/src/tabs/projects/project-view.test.ts.
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

describe("project inventory row keys", () => {
	it.each(GROUP_CASES)("%s", (_name, entries, rows) => {
		const keys = projectInventoryGroupKeys(entries);
		expect(rowLetters(entries.map((item) => keys.get(item) ?? ""))).toBe(rows);
	});
});
