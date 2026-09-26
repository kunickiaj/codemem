import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	projectBasename,
	projectClause,
	projectMatchesFilter,
	recordedRepositoryIdentitiesBySession,
	repositoryIdentityFromMetadata,
	repositoryIdentitySql,
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
});

function unusualGitDirectoryTests(): void {
	it("preserves usernames in URI-style SSH origins", () => {
		const baseDirectory = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		tmpDir = baseDirectory;
		const identities = ["alice", "bob"].map((username) => {
			const repoRoot = join(baseDirectory, username, "repo");
			mkdirSync(join(repoRoot, ".git"), { recursive: true });
			writeFileSync(
				join(repoRoot, ".git", "config"),
				`[remote "origin"]\n\turl = ssh://${username}:secret@example.test/~/repository.git?token=secret#fragment\n`,
			);
			return resolveGitRepositoryIdentity(repoRoot)?.identity;
		});

		expect(identities).toEqual([
			"ssh://alice@example.test/~/repository.git",
			"ssh://bob@example.test/~/repository.git",
		]);
	});

	it("preserves usernames in scp-style origins", () => {
		const baseDirectory = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		tmpDir = baseDirectory;
		const identities = ["alice", "bob"].map((username) => {
			const repoRoot = join(baseDirectory, username, "repo");
			mkdirSync(join(repoRoot, ".git"), { recursive: true });
			writeFileSync(
				join(repoRoot, ".git", "config"),
				`[remote "origin"]\n\turl = ${username}@example.test:repository.git\n`,
			);
			return resolveGitRepositoryIdentity(repoRoot)?.identity;
		});

		expect(identities).toEqual([
			"alice@example.test:repository.git",
			"bob@example.test:repository.git",
		]);
	});

	it("follows a .git directory symlink", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const repoRoot = join(tmpDir, "work", "repository");
		const gitDirectory = join(tmpDir, "storage", "repository.git");
		mkdirSync(repoRoot, { recursive: true });
		mkdirSync(gitDirectory, { recursive: true });
		symlinkSync(gitDirectory, join(repoRoot, ".git"), "dir");
		writeFileSync(
			join(gitDirectory, "config"),
			'[remote "origin"]\n\turl = https://example.test/acme/repository.git\n',
		);

		expect(resolveGitRepositoryIdentity(repoRoot)).toEqual({
			identity: "https://example.test/acme/repository.git",
			root: repoRoot,
			source: "git_remote",
		});
		unlinkSync(join(gitDirectory, "config"));
		expect(resolveGitRepositoryIdentity(repoRoot)).toEqual({
			identity: realpathSync(gitDirectory).replaceAll("\\", "/"),
			root: repoRoot,
			source: "git_common_dir",
		});
	});

	it("anchors a separate Git directory to its checkout", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const repoRoot = join(tmpDir, "work", "repository");
		const nested = join(repoRoot, "packages", "core");
		const gitDirectory = join(tmpDir, "storage", "metadata-only", ".git");
		mkdirSync(nested, { recursive: true });
		mkdirSync(gitDirectory, { recursive: true });
		writeFileSync(join(repoRoot, ".git"), `gitdir: ${gitDirectory}\n`);
		writeFileSync(join(gitDirectory, "config"), '[remote "origin"]\n\turl = ../upstream.git\n');

		expect(resolveProject(nested)).toBe("repository");
		expect(resolveGitRepositoryIdentity(nested)).toEqual({
			identity: join(tmpDir, "work", "upstream.git").replaceAll("\\", "/"),
			root: repoRoot,
			source: "git_remote",
		});
	});

	it("does not invent repository identity for ordinary directories", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-project-test-"));
		const general = join(tmpDir, "general");
		mkdirSync(general);

		expect(resolveGitRepositoryIdentity(general)).toBeNull();
	});
}

describe("unusual Git directory layouts", unusualGitDirectoryTests);

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

describe("recorded repository identity SQL", () => {
	const cases: Array<string | null> = [
		null,
		"",
		"not json",
		"[]",
		"{}",
		JSON.stringify({ codemem_repository_identity: "github.com/acme/repo" }),
		JSON.stringify({ codemem_repository_identity: "  github.com/acme/repo  " }),
		JSON.stringify({ codemem_repository_identity: "   " }),
		JSON.stringify({ codemem_repository_identity: 42 }),
		JSON.stringify({ codemem_repository_identity: null }),
		JSON.stringify({ nested: { codemem_repository_identity: "ignored" } }),
		JSON.stringify({ note: "mentions codemem_repository_identity only in a value" }),
		'{"codemem_repository_identity": "broken',
	];

	it("matches the JavaScript metadata parser for every shape", () => {
		const db = new Database(":memory:");
		try {
			db.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY, metadata_json TEXT)");
			const insert = db.prepare("INSERT INTO sessions (id, metadata_json) VALUES (?, ?)");
			for (const [index, metadata] of cases.entries()) insert.run(index + 1, metadata);
			const rows = db
				.prepare(
					`SELECT id, metadata_json, ${repositoryIdentitySql("metadata_json")} AS identity
					 FROM sessions ORDER BY id`,
				)
				.all() as Array<{ id: number; metadata_json: string | null; identity: string | null }>;
			for (const row of rows) {
				expect(row.identity?.trim() || null).toBe(
					repositoryIdentityFromMetadata(row.metadata_json),
				);
			}
			expect(recordedRepositoryIdentitiesBySession(db)).toEqual(
				new Map([
					[6, "github.com/acme/repo"],
					[7, "github.com/acme/repo"],
				]),
			);
		} finally {
			db.close();
		}
	});
});
