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
	write(join(repo, "packages/core/package.json"), '{"version":"0.41.0"}\n');
	runGit(repo, "add", "README.md", "packages/core/package.json");
	runGit(repo, "commit", "-m", "initial");
	runGit(repo, "remote", "add", "origin", remote);
	runGit(repo, "push", "--set-upstream", "origin", "main");
	runGit(remote, "symbolic-ref", "HEAD", "refs/heads/main");

	return { remote, repo, root };
}

function advanceBranch({ remote, root }, branch = "main") {
	const clone = mkdtempSync(join(root, "advance-"));
	runGit(root, "clone", "--branch", branch, remote, clone);
	configureAuthor(clone);
	write(join(clone, "README.md"), `advanced ${branch}\n`);
	runGit(clone, "add", "README.md");
	runGit(clone, "commit", "-m", `advance ${branch}`);
	runGit(clone, "push", "origin", branch);
}

function createReleaseBranch(repo, branch = "release/0.41", { version } = {}) {
	runGit(repo, "checkout", "-b", branch);
	write(join(repo, "release.txt"), "release branch only\n");
	runGit(repo, "add", "release.txt");
	if (version) {
		write(join(repo, "packages/core/package.json"), `${JSON.stringify({ version })}\n`);
		runGit(repo, "add", "packages/core/package.json");
	}
	runGit(repo, "commit", "-m", "release branch commit");
	runGit(repo, "push", "--set-upstream", "origin", branch);
}

function runPreflight(repo, env = {}) {
	return spawnSync("bash", [preflightScript], {
		cwd: repo,
		encoding: "utf8",
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			GITHUB_SHA: "",
			RELEASE_TAG: "",
			RELEASE_TAG_COMMIT: "",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
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

	it("passes locally on the matching maintenance branch using the core package version", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo);

		const result = runPreflight(repo);

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /passed .* on release\/0\.41/);
	});

	it("rejects RELEASE_TAG when its version differs from the committed core version", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo, "release/0.47");

		const result = runPreflight(repo, { RELEASE_TAG: "v0.47.2" });

		assert.equal(result.status, 1, result.stdout);
		assert.match(result.stderr, /RELEASE_TAG version does not match/);
	});

	it("passes locally when the tag, committed core version, and maintenance series match", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo, "release/0.47", { version: "0.47.2" });

		const result = runPreflight(repo, { RELEASE_TAG: "v0.47.2" });

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /passed .* on release\/0\.47/);
	});

	for (const branch of ["release/0.47", "release/0.41.0"]) {
		it(`rejects local ${branch} when the candidate version is 0.41.0`, () => {
			const { repo } = makeRepo();
			createReleaseBranch(repo, branch);

			const result = runPreflight(repo);

			assert.equal(result.status, 1, result.stdout);
			assert.match(result.stderr, /Release tag preflight failed/);
		});
	}

	it("rejects a local maintenance branch that does not match RELEASE_TAG", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo, "release/0.41", { version: "0.47.1" });

		const result = runPreflight(repo, { RELEASE_TAG: "v0.47.1" });

		assert.equal(result.status, 1, result.stdout);
		assert.match(result.stderr, /does not match version series 'release\/0\.47'/);
	});

	it("rejects a local feature branch even when its HEAD equals origin/main", () => {
		const { repo } = makeRepo();
		runGit(repo, "checkout", "-b", "feature/release");

		const result = runPreflight(repo);

		assert.equal(result.status, 1, result.stdout);
		assert.match(result.stderr, /current branch|branch.*expected|approved branch/);
	});

	it("rejects a stale local main checkout", () => {
		const state = makeRepo();
		advanceBranch(state);

		const result = runPreflight(state.repo, {
			GITHUB_SHA: "origin/main",
			RELEASE_TAG_COMMIT: "origin/main",
		});

		assert.equal(result.status, 1);
		assert.match(result.stderr, /not origin\/main HEAD/);
	});

	for (const override of ["GITHUB_SHA", "RELEASE_TAG_COMMIT"]) {
		it(`ignores local ${override} rather than accepting an approved commit instead of HEAD`, () => {
			const { repo } = makeRepo();
			const approvedCommit = runGit(repo, "rev-parse", "HEAD");
			write(join(repo, "README.md"), "unpushed main commit\n");
			runGit(repo, "add", "README.md");
			runGit(repo, "commit", "-m", "unpushed main");

			const result = runPreflight(repo, { [override]: approvedCommit });

			assert.equal(result.status, 1, result.stdout);
			assert.match(result.stderr, /not origin\/main HEAD/);
		});
	}

	it("rejects a stale local maintenance checkout after fetching the remote branch", () => {
		const state = makeRepo();
		createReleaseBranch(state.repo);
		advanceBranch(state, "release/0.41");

		const result = runPreflight(state.repo);

		assert.equal(result.status, 1, result.stdout);
		assert.match(result.stderr, /not origin\/release\/0\.41 HEAD/);
	});

	it("rejects an untracked file on local main", () => {
		const { repo } = makeRepo();
		write(join(repo, "dirty.txt"), "uncommitted\n");

		const result = runPreflight(repo);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /working tree is not clean/);
	});

	for (const path of ["README.md", "untracked.txt"]) {
		it(`rejects a local maintenance checkout with changes to ${path}`, () => {
			const { repo } = makeRepo();
			createReleaseBranch(repo);
			write(join(repo, path), "uncommitted\n");

			const result = runPreflight(repo);

			assert.equal(result.status, 1, result.stdout);
			assert.match(result.stderr, /working tree is not clean/);
		});
	}

	for (const deleted of [false, true]) {
		it(`rejects a ${deleted ? "deleted" : "never-pushed"} remote maintenance branch`, () => {
			const { repo, remote } = makeRepo();
			if (deleted) {
				createReleaseBranch(repo);
				runGit(remote, "branch", "-D", "release/0.41");
				assert.ok(runGit(repo, "rev-parse", "refs/remotes/origin/release/0.41"));
			} else {
				runGit(repo, "checkout", "-b", "release/0.41");
				runGit(repo, "commit", "--allow-empty", "-m", "unpublished release");
			}

			const result = runPreflight(repo);

			assert.equal(result.status, 1, result.stdout);
			assert.match(result.stderr, /release\/0\.41/);
		});
	}

	it("passes in CI when main advances after the tag commit", () => {
		const state = makeRepo();
		const tagCommit = runGit(state.repo, "rev-parse", "HEAD");
		advanceBranch(state);

		const result = runPreflight(state.repo, {
			GITHUB_ACTIONS: "1",
			RELEASE_TAG_COMMIT: tagCommit,
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /passed .* on main/);
	});

	it("passes in CI for a release-only tag commit on the matching maintenance branch", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo, "release/0.41", { version: "0.41.1" });
		const tagCommit = runGit(repo, "rev-parse", "HEAD");

		const result = runPreflight(repo, {
			GITHUB_ACTIONS: "1",
			RELEASE_TAG: "v0.41.1",
			RELEASE_TAG_COMMIT: tagCommit,
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /passed .* on release\/0\.41/);
	});

	it("passes in CI when the matching maintenance branch advances after the tag commit", () => {
		const state = makeRepo();
		createReleaseBranch(state.repo, "release/0.41", { version: "0.41.1" });
		const tagCommit = runGit(state.repo, "rev-parse", "HEAD");
		advanceBranch(state, "release/0.41");

		const result = runPreflight(state.repo, {
			GITHUB_ACTIONS: "1",
			RELEASE_TAG: "v0.41.1",
			RELEASE_TAG_COMMIT: tagCommit,
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /passed .* on release\/0\.41/);
	});

	for (const tag of ["", "v0.47.1", "not-a-version"]) {
		it(`rejects a CI maintenance commit with ${tag || "no RELEASE_TAG"}`, () => {
			const { repo } = makeRepo();
			createReleaseBranch(repo);
			const tagCommit = runGit(repo, "rev-parse", "HEAD");

			const result = runPreflight(repo, {
				GITHUB_ACTIONS: "1",
				RELEASE_TAG: tag,
				RELEASE_TAG_COMMIT: tagCommit,
			});

			assert.equal(result.status, 1, result.stdout);
			const diagnostic = {
				"": /RELEASE_TAG is required/,
				"v0.47.1": /RELEASE_TAG version does not match/,
				"not-a-version": /RELEASE_TAG must start with v/,
			};
			assert.match(result.stderr, diagnostic[tag]);
		});
	}

	it("rejects a CI commit reachable only from a patch-specific release branch", () => {
		const { repo } = makeRepo();
		createReleaseBranch(repo, "release/0.41.0", { version: "0.41.1" });
		const tagCommit = runGit(repo, "rev-parse", "HEAD");

		const result = runPreflight(repo, {
			GITHUB_ACTIONS: "1",
			RELEASE_TAG: "v0.41.1",
			RELEASE_TAG_COMMIT: tagCommit,
		});

		assert.equal(result.status, 1, result.stdout);
		assert.match(result.stderr, /could not fetch origin\/release\/0\.41/);
	});

	it("rejects a CI maintenance commit when the remote branch was deleted despite its cached ref", () => {
		const { repo, remote } = makeRepo();
		createReleaseBranch(repo, "release/0.41", { version: "0.41.1" });
		const tagCommit = runGit(repo, "rev-parse", "HEAD");
		runGit(remote, "branch", "-D", "release/0.41");
		assert.equal(runGit(repo, "rev-parse", "origin/release/0.41"), tagCommit);

		const result = runPreflight(repo, {
			GITHUB_ACTIONS: "1",
			RELEASE_TAG: "v0.41.1",
			RELEASE_TAG_COMMIT: tagCommit,
		});

		assert.equal(result.status, 1, result.stdout);
		assert.match(result.stderr, /could not fetch origin\/release\/0\.41/);
	});

	for (const published of [false, true]) {
		it(`rejects a CI ${published ? "pushed feature" : "unpushed maintenance"} commit outside approved ancestry`, () => {
			const { repo } = makeRepo();
			createReleaseBranch(repo, "release/0.41", { version: "0.41.1" });
			if (published) runGit(repo, "checkout", "-b", "feature/release");
			write(join(repo, "README.md"), "unmerged change\n");
			runGit(repo, "add", "README.md");
			runGit(repo, "commit", "-m", "unmerged change");
			if (published) runGit(repo, "push", "origin", "feature/release");
			const tagCommit = runGit(repo, "rev-parse", "HEAD");

			const result = runPreflight(repo, {
				GITHUB_ACTIONS: "1",
				RELEASE_TAG: "v0.41.1",
				RELEASE_TAG_COMMIT: tagCommit,
			});

			assert.equal(result.status, 1, result.stdout);
			assert.match(result.stderr, /not reachable|not an ancestor/);
		});
	}
});
