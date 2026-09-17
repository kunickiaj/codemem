import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	projectBasename,
	projectClause,
	projectMatchesFilter,
	resolveGitRepositoryIdentity,
	resolveProject,
	resolveProjectRoot,
} from "./project.js";

let tmpDir: string | null = null;

afterEach(() => {
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = null;
	}
});

describe("project filters", () => {
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
});

describe("Git repository identity", () => {
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
		const worktreeGitDir = join(mainRepo, ".git", "worktrees", "feature-worktree");
		mkdirSync(worktreeGitDir, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
		writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}`);

		expect(resolveProject(worktree)).toBe("main-repo");
	});

	it("groups externally placed worktrees by their shared remote", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const mainRepo = join(tmpDir, "repos", "main-repo");
		const worktree = join(tmpDir, "unrelated", "feature-worktree");
		const worktreeGitDir = join(mainRepo, ".git", "worktrees", "feature-worktree");
		mkdirSync(worktreeGitDir, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(
			join(mainRepo, ".git", "config"),
			'[remote "origin"]\n\turl = https://example.test/acme/main-repo.git\n',
		);
		writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
		writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

		expect(resolveGitRepositoryIdentity(worktree)).toEqual({
			identity: "https://example.test/acme/main-repo.git",
			root: mainRepo,
			source: "git_remote",
		});
	});

	it("uses Git config parsing for included origin remotes and inline comments", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const repoRoot = join(tmpDir, "main-repo");
		const gitDirectory = join(repoRoot, ".git");
		mkdirSync(gitDirectory, { recursive: true });
		writeFileSync(join(gitDirectory, "config"), "[include]\n\tpath = remotes.config\n");
		writeFileSync(
			join(gitDirectory, "remotes.config"),
			'[remote "ORIGIN"]\n\turl = https://wrong.example.test/repository.git\n[remote "origin"]\n\turl = https://example.test/acme/repository.git # canonical\n',
		);

		expect(resolveGitRepositoryIdentity(repoRoot)).toEqual({
			identity: "https://example.test/acme/repository.git",
			root: repoRoot,
			source: "git_remote",
		});
	});

	it("removes credentials and query secrets from HTTPS origin identities", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const repoRoot = join(tmpDir, "credentialed-repo");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		writeFileSync(
			join(repoRoot, ".git", "config"),
			'[remote "origin"]\n\turl = https://deploy-user:secret-token@example.test/acme/repository.git?token=query-secret#fragment\n',
		);

		expect(resolveGitRepositoryIdentity(repoRoot)).toEqual({
			identity: "https://example.test/acme/repository.git",
			root: repoRoot,
			source: "git_remote",
		});
	});

	it("resolves relative filesystem origins against each repository root", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const firstRepo = join(tmpDir, "team-a", "repo");
		const secondRepo = join(tmpDir, "team-b", "repo");
		for (const repoRoot of [firstRepo, secondRepo]) {
			mkdirSync(join(repoRoot, ".git"), { recursive: true });
			writeFileSync(
				join(repoRoot, ".git", "config"),
				'[remote "origin"]\n\turl = ../upstream.git\n',
			);
		}

		expect(resolveGitRepositoryIdentity(firstRepo)?.identity).toBe(
			join(tmpDir, "team-a", "upstream.git").replaceAll("\\", "/"),
		);
		expect(resolveGitRepositoryIdentity(secondRepo)?.identity).toBe(
			join(tmpDir, "team-b", "upstream.git").replaceAll("\\", "/"),
		);
		expect(resolveGitRepositoryIdentity(firstRepo)?.identity).not.toBe(
			resolveGitRepositoryIdentity(secondRepo)?.identity,
		);
	});

	it("groups worktrees without a remote by their common Git directory", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const mainRepo = join(tmpDir, "main-repo");
		const worktree = join(tmpDir, "elsewhere", "feature-worktree");
		const worktreeGitDir = join(mainRepo, ".git", "worktrees", "feature-worktree");
		mkdirSync(worktreeGitDir, { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
		writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

		expect(resolveGitRepositoryIdentity(worktree)).toEqual({
			identity: join(mainRepo, ".git").replaceAll("\\", "/"),
			root: mainRepo,
			source: "git_common_dir",
		});
	});

	it("does not invent repository identity for ordinary directories", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const general = join(tmpDir, "general");
		mkdirSync(general);

		expect(resolveGitRepositoryIdentity(general)).toBeNull();
	});
});

describe("project directory resolution", () => {
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
		const worktreeGitDir = join(mainRepo, ".git", "worktrees", "feature-worktree");
		mkdirSync(worktreeGitDir, { recursive: true });
		mkdirSync(join(worktree, "packages"), { recursive: true });
		writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
		writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}`);

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
