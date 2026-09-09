import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

const preflightScript = resolve("scripts/release-tag-preflight.sh");
const tempRoots = [];

function runGit(cwd, ...args) {
	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	return execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
}

function write(path, content) {
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

function configureAuthor(repo) {
	runGit(repo, "config", "user.name", "Release Test");
	runGit(repo, "config", "user.email", "release-test@example.invalid");
}

function makeRepo() {
	const root = mkdtempSync(join(tmpdir(), "codemem-release-tag-preflight-"));
	tempRoots.push(root);
	const remote = join(root, "origin.git");
	const repo = join(root, "repo");

	runGit(root, "init", "--bare", "--initial-branch=main", remote);
	runGit(root, "init", "--initial-branch=main", repo);
	configureAuthor(repo);
	write(join(repo, "README.md"), "release test\n");
	write(join(repo, "packages/core/package.json"), '{"version":"0.44.1"}\n');
	runGit(repo, "add", "README.md", "packages/core/package.json");
	runGit(repo, "commit", "-m", "initial");
	runGit(repo, "remote", "add", "origin", remote);
	runGit(repo, "push", "--set-upstream", "origin", "main");
	runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");

	return { remote, repo, root };
}

function advanceMain({ remote, root }, content = "advanced main\n") {
	const clone = join(root, `advance-${Date.now()}-${Math.random()}`);
	runGit(root, "clone", remote, clone);
	configureAuthor(clone);
	write(join(clone, "README.md"), content);
	runGit(clone, "add", "README.md");
	runGit(clone, "commit", "-m", "advance main");
	runGit(clone, "push", "origin", "main");
}

function createReleaseBranch(repo, { branch = "release/0.44", push = true } = {}) {
	runGit(repo, "checkout", "-b", branch);
	write(join(repo, "release.txt"), "release branch only\n");
	runGit(repo, "add", "release.txt");
	runGit(repo, "commit", "-m", "release branch commit");
	if (push) runGit(repo, "push", "--set-upstream", "origin", branch);
}

function advanceReleaseBranch({ remote, root }, branch = "release/0.44") {
	const clone = join(root, `advance-release-${Date.now()}-${Math.random()}`);
	runGit(root, "clone", "--branch", branch, remote, clone);
	configureAuthor(clone);
	write(join(clone, "release-next.txt"), "advanced release branch\n");
	runGit(clone, "add", "release-next.txt");
	runGit(clone, "commit", "-m", "advance release branch");
	runGit(clone, "push", "origin", branch);
}

function runPreflight(repo, env = {}) {
	return spawnSync("bash", [preflightScript], {
		cwd: repo,
		encoding: "utf8",
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			GITHUB_SHA: "",
			RELEASE_TAG_COMMIT: "",
			RELEASE_TAG: "",
			...env,
		},
	});
}

afterEach(() => {
	while (tempRoots.length > 0) {
		rmSync(tempRoots.pop(), { recursive: true, force: true });
	}
});

describe("release tag preflight", () => {
	it("passes locally on a clean main branch at origin/main HEAD", () => {
		const { repo } = makeRepo();
		const result = runPreflight(repo);

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /passed .* on main/);
	});

	it("passes locally at the matching maintenance branch head", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo);
		const result = runPreflight(repo);

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /passed .* on release\/0\.44/);
	});

	it("rejects a patch-specific release branch", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo, { branch: "release/0.44.1" });
		const result = runPreflight(repo);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /expected 'main' or 'release\/0\.44'/);
	});

	it("rejects a maintenance branch from a different release line", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo, { branch: "release/0.43" });
		const result = runPreflight(repo);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /expected 'main' or 'release\/0\.44'/);
	});

	it("rejects a maintenance branch that does not exist on origin", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo, { push: false });
		const result = runPreflight(repo);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /origin\/release\/0\.44 does not exist/);
		assert.match(result.stderr, /Push the maintenance branch before tagging v0\.44\.1/);
	});

	it("rejects a release tag that does not match the package version", () => {
		const { repo } = makeRepo();
		const result = runPreflight(repo, { RELEASE_TAG: "v0.44.2" });

		assert.equal(result.status, 1);
		assert.match(result.stderr, /does not match package version '0\.44\.1'/);
	});

	it("rejects a stale local main checkout", () => {
		const state = makeRepo();
		advanceMain(state);
		const result = runPreflight(state.repo, {
			GITHUB_SHA: "origin/main",
			RELEASE_TAG_COMMIT: "origin/main",
		});

		assert.equal(result.status, 1);
		assert.match(result.stderr, /not origin\/main HEAD/);
	});

	it("rejects a dirty local main checkout", () => {
		const { repo } = makeRepo();
		write(join(repo, "dirty.txt"), "uncommitted\n");
		const result = runPreflight(repo);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /working tree is not clean/);
	});

	it("rejects a dirty local maintenance checkout", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo);
		write(join(repo, "dirty.txt"), "uncommitted\n");
		const result = runPreflight(repo);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /working tree is not clean/);
	});

	it("passes in CI when main advances after the tag commit", () => {
		const state = makeRepo();
		const tagCommit = runGit(state.repo, "rev-parse", "HEAD");
		advanceMain(state);
		const result = runPreflight(state.repo, {
			GITHUB_ACTIONS: "1",
			RELEASE_TAG_COMMIT: tagCommit,
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /passed .* on main/);
	});

	it("passes in CI at the matching maintenance branch head", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo);
		const result = runPreflight(repo, {
			GITHUB_ACTIONS: "1",
			RELEASE_TAG: "v0.44.1",
			RELEASE_TAG_COMMIT: runGit(repo, "rev-parse", "HEAD"),
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /passed .* on release\/0\.44/);
	});

	it("rejects a stale maintenance commit in CI", () => {
		const state = makeRepo();
		createReleaseBranch(state.repo);
		const tagCommit = runGit(state.repo, "rev-parse", "HEAD");
		advanceReleaseBranch(state);
		const result = runPreflight(state.repo, {
			GITHUB_ACTIONS: "1",
			RELEASE_TAG: "v0.44.1",
			RELEASE_TAG_COMMIT: tagCommit,
		});

		assert.equal(result.status, 1);
		assert.match(result.stderr, /nor the head of origin\/release\/0\.44/);
	});

	it("rejects a release-only commit from a different line in CI", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo, { branch: "release/0.43" });
		const result = runPreflight(repo, {
			GITHUB_ACTIONS: "1",
			RELEASE_TAG: "v0.44.1",
			RELEASE_TAG_COMMIT: runGit(repo, "rev-parse", "HEAD"),
		});

		assert.equal(result.status, 1);
		assert.match(result.stderr, /nor the head of origin\/release\/0\.44/);
	});
});
