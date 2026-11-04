import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "@codemem/core";
import { afterEach, describe, expect, it } from "vitest";
import { projectFromDirectory, resolveCallerProject } from "./project.js";

const roots: string[] = [];

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "memory-tools-project-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("projectFromDirectory", () => {
	it("uses the repository directory name when .git is a directory", () => {
		const root = scratch();
		const repo = join(root, "acme-api");
		mkdirSync(join(repo, ".git", "objects"), { recursive: true });
		mkdirSync(join(repo, "packages", "deep"), { recursive: true });

		expect(projectFromDirectory(join(repo, "packages", "deep"))).toBe("acme-api");
		expect(projectFromDirectory(join(repo, "packages", "deep"))).toBe(
			resolveProject(join(repo, "packages", "deep")),
		);
	});

	it("resolves a linked worktree back to the primary checkout name", () => {
		const root = scratch();
		const primary = join(root, "acme-api");
		const worktreeGitDir = join(primary, ".git", "worktrees", "feature-x");
		mkdirSync(worktreeGitDir, { recursive: true });
		// `git worktree add` writes commondir relative to the worktree gitdir.
		writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
		const worktree = join(root, "acme-api-feature-x");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

		expect(projectFromDirectory(worktree)).toBe("acme-api");
		expect(projectFromDirectory(worktree)).toBe(resolveProject(worktree));
	});

	it("keeps the current directory name when a gitdir file has no commondir", () => {
		const root = scratch();
		const detached = join(root, "detached");
		mkdirSync(join(root, "gitdir-target"), { recursive: true });
		mkdirSync(detached);
		writeFileSync(join(detached, ".git"), `gitdir: ${join(root, "gitdir-target")}\n`);

		expect(projectFromDirectory(detached)).toBe("detached");
		expect(projectFromDirectory(detached)).toBe(resolveProject(detached));
	});

	it("matches core on this repository's own worktree", () => {
		const here = import.meta.dirname;
		expect(projectFromDirectory(here)).toBe(resolveProject(here));
	});

	it("falls back to the directory basename outside any repository", () => {
		const root = scratch();
		const plain = join(root, "notes");
		mkdirSync(plain);

		expect(projectFromDirectory(plain)).toBe("notes");
		expect(projectFromDirectory(plain)).toBe(resolveProject(plain));
	});
});

describe("resolveCallerProject", () => {
	it("prefers a non-blank CODEMEM_PROJECT over the directory", () => {
		const root = scratch();
		expect(resolveCallerProject(root, { CODEMEM_PROJECT: " forced " })).toBe("forced");
	});

	it("ignores a blank CODEMEM_PROJECT", () => {
		const root = scratch();
		const plain = join(root, "notes");
		mkdirSync(plain);
		expect(resolveCallerProject(plain, { CODEMEM_PROJECT: "   " })).toBe("notes");
	});
});
