import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectBasename, projectClause, projectMatchesFilter, resolveProject } from "./project.js";

describe("project helpers", () => {
	let tmpDir: string | null = null;

	afterEach(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = null;
		}
	});

	it("uses basename-aware SQL matching for project filters", () => {
		expect(projectClause("/Users/adam/workspace/codemem")).toEqual({
			clause: "(sessions.project = ? OR sessions.project LIKE ? OR sessions.project LIKE ?)",
			params: ["codemem", "%/codemem", "%\\codemem"],
		});
	});

	it("matches exact and suffix project paths like Python", () => {
		expect(projectMatchesFilter("codemem", "codemem")).toBe(true);
		expect(projectMatchesFilter("/Users/adam/workspace/codemem", "codemem")).toBe(true);
		expect(projectMatchesFilter("codemem", "workspace/codemem")).toBe(true);
		expect(projectMatchesFilter("codemem", "workspace/other")).toBe(false);
		expect(projectMatchesFilter("codemem", null)).toBe(false);
	});

	it("resolves git repo basename as project", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const repoRoot = join(tmpDir, "my-repo");
		const nested = join(repoRoot, "packages", "core");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });

		expect(resolveProject(nested)).toBe("my-repo");
	});

	it("resolves main repo basename for git worktrees", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const mainRepo = join(tmpDir, "main-repo");
		const worktree = join(tmpDir, "feature-worktree");
		mkdirSync(join(mainRepo, ".git", "worktrees", "feature-worktree"), { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(
			join(worktree, ".git"),
			`gitdir: ${join(mainRepo, ".git", "worktrees", "feature-worktree")}`,
		);

		expect(resolveProject(worktree)).toBe("main-repo");
	});

	it("honors explicit override before cwd resolution", () => {
		expect(resolveProject("/tmp/anything", " custom-project ")).toBe("custom-project");
	});

	it("returns cwd basename when no git repo exists", () => {
		expect(projectBasename("/tmp/foo/bar")).toBe("bar");
		expect(resolveProject("/tmp/foo/bar")).toBe("bar");
	});
});
