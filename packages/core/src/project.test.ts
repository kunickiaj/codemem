import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	projectBasename,
	projectClause,
	projectMatchesFilter,
	resolveProject,
	resolveProjectRoot,
} from "./project.js";

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
			clause:
				"(sessions.project = ? OR sessions.project LIKE ? ESCAPE '\\' OR sessions.project LIKE ? ESCAPE '\\')",
			params: ["codemem", "%/codemem", "%\\codemem"],
		});
	});

	it("escapes SQL LIKE wildcards in project filters", () => {
		expect(projectClause("weird_%project")).toEqual({
			clause:
				"(sessions.project = ? OR sessions.project LIKE ? ESCAPE '\\' OR sessions.project LIKE ? ESCAPE '\\')",
			params: ["weird_%project", "%/weird\\_\\%project", "%\\weird\\_\\%project"],
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

	it("resolves the working-tree root from a subdirectory", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const repoRoot = join(tmpDir, "my-repo");
		const nested = join(repoRoot, "packages", "core");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });

		expect(resolveProjectRoot(nested)).toBe(repoRoot);
	});

	it("resolves the linked worktree root, not the primary checkout", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const mainRepo = join(tmpDir, "main-repo");
		const worktree = join(tmpDir, "feature-worktree");
		mkdirSync(join(mainRepo, ".git", "worktrees", "feature-worktree"), { recursive: true });
		mkdirSync(join(worktree, "packages"), { recursive: true });
		writeFileSync(
			join(worktree, ".git"),
			`gitdir: ${join(mainRepo, ".git", "worktrees", "feature-worktree")}`,
		);

		// resolveProject keeps the primary repo name, but the file root must be the
		// worktree itself so AGENTS.md is read from the worktree being mined.
		expect(resolveProject(worktree)).toBe("main-repo");
		expect(resolveProjectRoot(join(worktree, "packages"))).toBe(worktree);
	});

	it("honors explicit override before cwd resolution", () => {
		expect(resolveProject("/tmp/anything", " custom-project ")).toBe("custom-project");
	});

	it("returns cwd basename when no git repo exists", () => {
		expect(projectBasename("/tmp/foo/bar")).toBe("bar");
		expect(resolveProject("/tmp/foo/bar")).toBe("bar");
	});
});
