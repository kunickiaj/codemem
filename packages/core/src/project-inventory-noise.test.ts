import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectInventoryGroupKeys } from "./project-inventory-groups.js";
import {
	NOISE_FIXTURE_UNUSABLE_NAMES,
	seedProjectInventoryNoiseFixture,
} from "./project-inventory-noise-test-fixtures.js";
import { isUnusableProjectName, listProjectScopeInventory } from "./project-scope-settings.js";
import { initTestSchema } from "./test-utils.js";

function warningCounts(projects: ReturnType<typeof listProjectScopeInventory>["projects"]) {
	const counts: Record<string, number> = {};
	for (const project of projects)
		for (const warning of project.guardrail_warnings)
			counts[warning.code] = (counts[warning.code] ?? 0) + 1;
	return counts;
}

describe("Projects inventory on a store with years of folder history", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		seedProjectInventoryNoiseFixture(db);
	});

	afterEach(() => db.close());

	it("lists one row per name, Space and repository", () => {
		// Act
		const listed = listProjectScopeInventory(db, { includeEmpty: false, limit: 250 });

		// Assert: 99 entries, 4 without a usable name hidden, 95 entries in 45 rows.
		const keys = projectInventoryGroupKeys(listed.projects);
		expect(listed.total).toBe(95);
		expect(new Set(listed.projects.map((project) => keys.get(project))).size).toBe(45);
		const alpha = listed.projects.filter((project) => project.display_project === "alpha-repo");
		expect(new Set(alpha.map((project) => keys.get(project))).size).toBe(1);
		expect(alpha).toHaveLength(30);
	});

	it("asks for a name review only between rows that differ", () => {
		// Act
		const listed = listProjectScopeInventory(db, { includeEmpty: false, limit: 250 });

		// Assert: only the two split names, two folders each, in different Spaces.
		expect(warningCounts(listed.projects)).toEqual({ basename_collision_review: 4 });
		const flagged = listed.projects
			.filter((project) =>
				project.guardrail_warnings.some((warning) => warning.code === "basename_collision_review"),
			)
			.map((project) => project.display_project)
			.sort();
		expect(flagged).toEqual(["split-1", "split-1", "split-2", "split-2"]);
	});

	it("shows staying on this device as a status, not a warning", () => {
		const listed = listProjectScopeInventory(db, { includeEmpty: false, limit: 250 });
		const solo = listed.projects.find((project) => project.display_project === "solo-1");

		expect(solo?.statuses).toContain("local_only");
		expect(solo?.resolution_reason).toBe("local_default");
		expect(solo?.guardrail_warnings).toEqual([]);
	});

	it("keeps sharing unavailable for any entry whose name another entry uses", () => {
		const listed = listProjectScopeInventory(db, { limit: 250 });
		const byName = (name: string) =>
			listed.projects.filter((project) => project.display_project === name);

		expect(byName("alpha-repo").every((project) => project.ambiguous_name)).toBe(true);
		expect(byName("solo-1").every((project) => project.ambiguous_name === false)).toBe(true);
	});

	it("leaves entries without a usable name out of the default list, with a count and a filter", () => {
		// Act
		const listed = listProjectScopeInventory(db, { includeEmpty: false, limit: 250 });
		const unnamed = listProjectScopeInventory(db, {
			includeEmpty: false,
			limit: 250,
			status: "unnamed",
		});

		// Assert
		expect(listed.hidden_unnamed_count).toBe(4);
		expect(listed.projects.some((project) => project.statuses.includes("unnamed"))).toBe(false);
		expect(unnamed.projects.map((project) => project.display_project).sort()).toEqual(
			[...NOISE_FIXTURE_UNUSABLE_NAMES].sort(),
		);
		// Lookups by identity and the sharing list still see every entry.
		expect(listProjectScopeInventory(db, { limit: 250 }).total).toBe(99);
	});
});

describe("isUnusableProjectName", () => {
	it.each([
		["", true],
		["/", true],
		["\\", true],
		[".", true],
		["GitError: spawn git ENOENT", true],
		["fatal: not a git repository", true],
		["__sync_bootstrap__:shared", true],
		["api", false],
		["shared:default", false],
		["error-budget", false],
	])("treats %j as unusable: %s", (name, unusable) => {
		expect(isUnusableProjectName({ display_project: name, project: name })).toBe(unusable);
	});
});

describe("Projects inventory row keys", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		seedProjectInventoryNoiseFixture(db);
	});

	afterEach(() => db.close());

	it("returns the same row key on every page and under filters", () => {
		// Arrange
		const full = new Map(
			listProjectScopeInventory(db, { includeEmpty: false, limit: 250 }).projects.map((project) => [
				project.workspace_identity,
				project.group_key,
			]),
		);

		// Act: page through in small pages, and search for one old folder on its own.
		const paged = new Map<string, string | undefined>();
		for (let offset = 0; offset < full.size; offset += 7) {
			for (const project of listProjectScopeInventory(db, { includeEmpty: false, limit: 7, offset })
				.projects)
				paged.set(project.workspace_identity, project.group_key);
		}
		const [alone] = listProjectScopeInventory(db, {
			includeEmpty: false,
			query: "/fixture/worktrees/alpha-repo-7",
		}).projects;

		// Assert: the lone folder keeps the key of the repository row it was folded into.
		expect([...full.values()].every((key) => typeof key === "string" && key.length > 0)).toBe(true);
		expect(paged).toEqual(full);
		expect(alone?.group_key).toBe(full.get("/fixture/worktrees/alpha-repo-7"));
		expect(alone?.group_key).toBe(
			full.get("https://git.example.invalid/fixture-org/alpha-repo.git"),
		);
	});
});

describe("Projects hidden from the default list", () => {
	it("can reveal every hidden entry through the filter that counts it", () => {
		// Arrange: add unnamed entries with no memories, which are both unnamed and empty.
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			seedProjectInventoryNoiseFixture(db);
			for (const [index, name] of ["/", "GitError: spawn git EACCES"].entries())
				db.prepare(
					`INSERT INTO sessions(started_at, cwd, project, user, tool_version)
					 VALUES ('2026-10-01T00:00:00.000Z', ?, ?, 'fixture-user', 'test')`,
				).run(`/fixture/junk/empty-${index}`, name);
			db.prepare(
				`INSERT INTO sessions(started_at, cwd, project, user, tool_version)
				 VALUES ('2026-10-01T00:00:00.000Z', '/fixture/idle/quiet', 'quiet', 'fixture-user', 'test')`,
			).run();
			const ids = (projects: Array<{ workspace_identity: string }>) =>
				new Set(projects.map((project) => project.workspace_identity));
			const everything = listProjectScopeInventory(db, { limit: 250 }).projects;

			// Act
			const listed = listProjectScopeInventory(db, { includeEmpty: false, limit: 250 });
			const unnamed = ids(
				listProjectScopeInventory(db, { includeEmpty: false, limit: 250, status: "unnamed" })
					.projects,
			);
			const empty = ids(
				listProjectScopeInventory(db, { includeEmpty: false, limit: 250, status: "empty" })
					.projects,
			);

			// Assert
			const shown = ids(listed.projects);
			const hidden = everything.filter((project) => !shown.has(project.workspace_identity));
			const hiddenUnnamed = hidden.filter((project) => project.statuses.includes("unnamed"));
			const hiddenEmpty = hidden.filter((project) => !project.statuses.includes("unnamed"));
			expect([listed.hidden_unnamed_count, listed.hidden_empty_count]).toEqual([6, 1]);
			expect(hiddenUnnamed).toHaveLength(listed.hidden_unnamed_count);
			expect(hiddenEmpty).toHaveLength(listed.hidden_empty_count);
			for (const project of hiddenUnnamed) expect(unnamed).toContain(project.workspace_identity);
			for (const project of hidden.filter((entry) => entry.statuses.includes("empty")))
				expect(empty).toContain(project.workspace_identity);
		} finally {
			db.close();
		}
	});
});
