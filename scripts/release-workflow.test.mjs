import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { npmDistTagForReleaseTag, supportsGitStableTags } from "./release-dist-tag.mjs";

const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const publishedPackages = [
	["@codemem/embeddings", "packages/embeddings"],
	["@codemem/core", "packages/core"],
	["@codemem/mcp", "packages/mcp-server"],
	["@codemem/server", "packages/viewer-server"],
	["codemem", "packages/cli"],
	["@codemem/opencode-plugin", "packages/opencode-plugin"],
	["@codemem/pi-extension", "packages/pi-extension"],
];

function workflowStepScript(name) {
	const start = releaseWorkflow.indexOf(`      - name: ${name}\n`);
	assert.ok(start >= 0, `Missing workflow step: ${name}`);
	const next = releaseWorkflow.indexOf("\n      - ", start + 1);
	const step = releaseWorkflow.slice(start, next === -1 ? undefined : next);
	const runStart = step.indexOf("        run: |\n");
	assert.ok(runStart >= 0, `Missing script for step: ${name}`);
	return step.slice(runStart + "        run: |\n".length);
}

function runWorkflowScript(script, { directory, releaseTag = "v0.47.4", distTag = "latest" }) {
	return spawnSync("bash", ["-c", script], {
		cwd: directory,
		encoding: "utf8",
		env: { PATH: process.env.PATH, RELEASE_TAG: releaseTag, DIST_TAG: distTag, GITHUB_OUTPUT: join(directory, "output") },
	});
}

describe("release npm dist-tag routing", () => {
	for (const [releaseTag, expectedTag] of [
		["v0.44.0-alpha.2", "alpha"],
		["v0.44.0-beta.2", "beta"],
		["v0.44.0-rc.2", "rc"],
		["v0.44.0", "latest"],
	]) {
		it(`routes ${releaseTag} to npm ${expectedTag} for every published package`, () => {
			const routes = publishedPackages.map(([packageName]) => ({
				packageName,
				distTag: npmDistTagForReleaseTag(releaseTag),
			}));
			assert.equal(routes.length, publishedPackages.length);
			assert.ok(routes.every(({ distTag }) => distTag === expectedTag));
		});
	}

	it("keeps every published package on the shared computed dist-tag", () => {
		assert.match(releaseWorkflow, /TAG_OUTPUT="\$\(node scripts\/release-dist-tag\.mjs "\$RELEASE_TAG" --from-git\)"/);
		assert.ok(releaseWorkflow.includes("^tag=(alpha|beta|rc|latest|maintenance-[0-9]+\\.[0-9]+)$"));
		assert.match(releaseWorkflow, /printf '%s\\n' "\$TAG_OUTPUT" >> "\$GITHUB_OUTPUT"/);
		assert.match(releaseWorkflow, /publish --tag "\$\{DIST_TAG\}"/);
		for (const [packageName, packageDirectory] of publishedPackages) {
			assert.match(releaseWorkflow, new RegExp(`publish_if_missing "${packageName.replaceAll("/", "\\/")}" "${packageDirectory.replaceAll("/", "\\/")}"`));
		}
		assert.doesNotMatch(releaseWorkflow, /npm dist-tag (?:add|rm)/);
	});

	it("emits a dist-tag when executed from a path containing spaces", () => {
		const directory = mkdtempSync(join(tmpdir(), "codemem release tag "));
		const scriptPath = join(directory, "release dist tag.mjs");
		try {
			copyFileSync(fileURLToPath(new URL("./release-dist-tag.mjs", import.meta.url)), scriptPath);
			const result = spawnSync(process.execPath, [scriptPath, "v0.44.0-alpha.2"], { encoding: "utf8" });
			assert.equal(result.status, 0);
			assert.equal(result.stdout, "tag=alpha\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("history-aware release routing", () => {
	for (const [tag, stableTags, expected] of [
		["v0.47.4", ["v0.48.0"], "maintenance-0.47"],
		["v9.0.0", ["v10.0.0"], "maintenance-9.0"],
		["v0.9.0", ["v0.10.0"], "maintenance-0.9"],
		["v0.47.9", ["v0.47.10"], "maintenance-0.47"],
		["v0.48.0", ["v0.48.0", "v0.47.4"], "latest"],
		["v10.0.0", ["v9.99.99"], "latest"],
		["v0.10.0", ["v0.9.99"], "latest"],
		["v0.47.10", ["v0.47.9"], "latest"],
		["v9007199254740992.0.0", ["v9007199254740993.0.0"], "maintenance-9007199254740992.0"],
		["v9007199254740993.0.0", ["v9007199254740992.0.0"], "latest"],
		["v0.47.4", ["v0.48.0-rc.1", "v0.48.0+build.1", "0.48.0", "v01.48.0", "v0.048.0", "v0.48.00", "garbage", ""], "latest"],
		["v0.47.0-alpha.1", ["v10.0.0"], "alpha"],
		["v0.47.0-beta.2", ["v10.0.0"], "beta"],
		["v0.47.0-rc.3", ["v10.0.0"], "rc"],
	]) {
		it(`routes ${tag} with history ${JSON.stringify(stableTags)} to ${expected}`, () => {
			// Arrange
			const history = { stableTags };
			// Act
			const actual = npmDistTagForReleaseTag(tag, history);
			// Assert
			assert.equal(actual, expected);
		});
	}

	for (const tag of ["", "invalid", "0.47.4", "v01.47.4", "v0.47.4-preview.1"]) {
		it(`rejects invalid or unsupported release tag ${JSON.stringify(tag)}`, () => {
			// Arrange
			const history = { stableTags: ["v0.48.0"] };
			// Act
			const route = () => npmDistTagForReleaseTag(tag, history);
			// Assert
			assert.throws(route, /Invalid .*release tag|Unsupported release channel/);
		});
	}

	it("CLI reads real local git tags to distinguish maintenance and latest", () => {
		// Arrange: lightweight tags on a local blob need no commits or remote.
		const directory = mkdtempSync(join(tmpdir(), "codemem tag history "));
		const script = fileURLToPath(new URL("./release-dist-tag.mjs", import.meta.url));
		const git = (args, input) => {
			const result = spawnSync("git", args, { cwd: directory, encoding: "utf8", input });
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim();
		};
		try {
			git(["init", "--quiet"]);
			const object = git(["hash-object", "-w", "--stdin"], "fixture\n");
			git(["tag", "v0.48.0", object]);
			git(["tag", "v0.47.4", object]);
			// Act
			const maintenance = spawnSync(process.execPath, [script, "v0.47.4", "--from-git"], { cwd: directory, encoding: "utf8" });
			const latest = spawnSync(process.execPath, [script, "v0.48.0", "--from-git"], { cwd: directory, encoding: "utf8" });
			// Assert
			assert.equal(supportsGitStableTags, true);
			assert.equal(maintenance.status, 0, maintenance.stderr);
			assert.equal(maintenance.stdout, "tag=maintenance-0.47\n");
			assert.equal(latest.status, 0, latest.stderr);
			assert.equal(latest.stdout, "tag=latest\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("fetches all tags for publishing and passes the computed tag to the release job", () => {
		// Arrange
		const publishStart = releaseWorkflow.indexOf("\n  publish-npm:\n");
		const releaseStart = releaseWorkflow.indexOf("\n  release:\n");
		// Act
		const publishJob = releaseWorkflow.slice(publishStart, releaseStart);
		const releaseJob = releaseWorkflow.slice(releaseStart);
		// Assert
		assert.match(publishJob, /uses: actions\/checkout@[^\n]+\n        with:\n          ref: \$\{\{ env\.RELEASE_REF \}\}\n          fetch-depth: 0/);
		assert.match(publishJob, /outputs:\n      dist-tag: \$\{\{ steps\.dist-tag\.outputs\.tag \}\}/);
		assert.match(releaseJob, /DIST_TAG: \$\{\{ needs\.publish-npm\.outputs\.dist-tag \}\}/);
	});

	for (const [releaseTag, supportsHistory, output, expectedStatus] of [
		["v0.47.4", false, "latest", 1],
		["v0.47.4", true, "maintenance-0.47", 0],
		["v0.47.4", true, "untrusted-channel", 1],
		["v0.47.4-alpha.1", false, "alpha", 0],
	]) {
		it(`runs dist-tag step for ${releaseTag}, history support ${supportsHistory}, output ${output}`, () => {
			// Arrange: the mock helper cannot perform network or publishing operations.
			const directory = mkdtempSync(join(tmpdir(), "codemem routing step "));
			const script = workflowStepScript("Determine npm dist-tag");
			mkdirSync(join(directory, "scripts"));
			writeFileSync(join(directory, "scripts/release-dist-tag.mjs"), [
				`export const supportsGitStableTags = ${supportsHistory};`,
				'if (process.argv[1]?.endsWith("release-dist-tag.mjs")) {',
				'  console.error("MOCK_HELPER_INVOKED");',
				`  console.log("tag=${output}");`,
				"}",
			].join("\n"));
			try {
				// Act: set -e must prevent even the mocked publish after a routing failure.
				const result = runWorkflowScript(`pnpm() { printf 'MOCK_PUBLISH_INVOKED\\n'; }\n${script}\npnpm publish\n`, { directory, releaseTag });
				// Assert
				assert.equal(result.status, expectedStatus, result.stderr);
				if (expectedStatus === 0) {
					assert.match(result.stdout, /MOCK_PUBLISH_INVOKED/);
					assert.equal(readFileSync(join(directory, "output"), "utf8"), `tag=${output}\n`);
				} else {
					assert.doesNotMatch(result.stdout, /MOCK_PUBLISH_INVOKED/);
				}
				if (!supportsHistory && !releaseTag.includes("-")) {
					assert.match(result.stderr, /lacks history-aware dist-tag routing/);
					assert.doesNotMatch(result.stderr, /MOCK_HELPER_INVOKED/);
				}
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
});

describe("GitHub release presentation", () => {
	it("uses generated notes independently of repository changelog files", () => {
		assert.match(releaseWorkflow, /--title "codemem \$RELEASE_TAG"/);
		assert.match(releaseWorkflow, /--generate-notes/);
		assert.doesNotMatch(releaseWorkflow, /RELEASE_NOTES|release-notes|CHANGELOG\.md/);
	});

	it("can create a release from an older tagged checkout without notes tooling", () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "codemem old release "));
		const releaseStart = releaseWorkflow.indexOf("      - name: Create GitHub Release");
		const nextStep = releaseWorkflow.indexOf("\n      - ", releaseStart + 1);
		const releaseStep = releaseWorkflow.slice(releaseStart, nextStep === -1 ? undefined : nextStep);
		const script = releaseStep.slice(releaseStep.indexOf("          set -euo pipefail"));
		// Mock gh locally: view reports no existing release, create records its arguments.
		const mock = 'gh() { if [ "$2" = "view" ]; then return 1; fi; printf "%s\\n" "$@"; }\n';
		try {
			// Act
			const result = spawnSync("bash", ["-c", mock + script], {
				cwd: directory,
				encoding: "utf8",
				env: { PATH: process.env.PATH, RELEASE_TAG: "v0.46.2", DIST_TAG: "latest" },
			});
			// Assert
			assert.equal(result.status, 0, result.stderr);
			assert.match(result.stdout, /create\nv0\.46\.2\n--generate-notes/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	for (const distTag of ["maintenance-0.47", "latest"]) {
		it(`creates a GitHub Release with the latest flag appropriate for ${distTag}`, () => {
			// Arrange: gh records arguments without contacting GitHub.
			const directory = mkdtempSync(join(tmpdir(), "codemem release flags "));
			const mock = 'gh() { if [ "$2" = "view" ]; then return 1; fi; printf "%s\\n" "$@"; }\n';
			const script = workflowStepScript("Create GitHub Release");
			try {
				// Act
				const result = runWorkflowScript(mock + script, { directory, distTag });
				// Assert
				assert.equal(result.status, 0, result.stderr);
				assert.match(result.stdout, /create\nv0\.47\.4\n--generate-notes/);
				if (distTag.startsWith("maintenance-")) {
					assert.match(result.stdout, /^--latest=false$/m);
				} else {
					assert.doesNotMatch(result.stdout, /--latest/);
				}
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
});

describe("maintenance branch workflow", () => {
	it("creates branches only in the release job after publishing and creating the GitHub Release", () => {
		// Arrange
		const releaseStart = releaseWorkflow.indexOf("\n  release:\n");
		const stepName = "      - name: Create maintenance branch for stable minor release";
		// Act
		const earlierJobs = releaseWorkflow.slice(0, releaseStart);
		const releaseJob = releaseWorkflow.slice(releaseStart);
		const createRelease = releaseJob.indexOf("      - name: Create GitHub Release");
		const createBranch = releaseJob.indexOf(stepName);
		// Assert
		assert.ok(releaseStart >= 0);
		assert.doesNotMatch(earlierJobs, /release-maintenance-branch\.mjs/);
		assert.equal(releaseWorkflow.match(/node scripts\/release-maintenance-branch\.mjs/g)?.length, 1);
		assert.ok(createRelease >= 0 && createBranch > createRelease);
		assert.match(releaseJob, /needs: \[publish-npm\]/);
		assert.match(releaseJob, /if: always\(\) && needs\.publish-npm\.result == 'success'/);
		assert.match(releaseJob, /permissions:\n      contents: write/);
	});

	it("sets up Node 24 before invoking the helper with the release token", () => {
		// Arrange
		const releaseJob = releaseWorkflow.slice(releaseWorkflow.indexOf("\n  release:\n"));
		// Act
		const setupNode = releaseJob.indexOf("uses: actions/setup-node@");
		const helper = releaseJob.indexOf("node scripts/release-maintenance-branch.mjs");
		const branchStep = releaseJob.slice(releaseJob.indexOf("      - name: Create maintenance branch"));
		// Assert
		assert.ok(setupNode >= 0 && helper > setupNode);
		assert.match(releaseJob.slice(setupNode, helper), /node-version: 24/);
		assert.match(branchStep, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
		assert.doesNotMatch(branchStep, /continue-on-error: true|if:.*always\(\)/);
	});

	for (const helperPresent of [false, true]) {
		it(`runs the branch step successfully with helper present: ${helperPresent}`, () => {
			// Arrange: simulate historical checkouts and mock the helper when present.
			const directory = mkdtempSync(join(tmpdir(), "codemem branch step "));
			const script = workflowStepScript("Create maintenance branch for stable minor release");
			if (helperPresent) {
				mkdirSync(join(directory, "scripts"));
				writeFileSync(join(directory, "scripts/release-maintenance-branch.mjs"), 'console.log("MOCK_BRANCH_HELPER_INVOKED");\n');
			}
			try {
				// Act
				const result = runWorkflowScript(script, { directory });
				// Assert
				assert.equal(result.status, 0, result.stderr);
				assert.equal(result.stdout, helperPresent ? "MOCK_BRANCH_HELPER_INVOKED\n" : "");
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		});
	}
});

describe("repository changelog", () => {
	it("uses dated version entries, change categories and comparison links", () => {
		assert.match(changelog, /^## \[Unreleased\]$/m);
		for (const version of ["0.46.2", "0.46.1", "0.46.0"]) {
			assert.ok(changelog.includes(`## [${version}] - `));
			assert.ok(changelog.includes(`[${version}]: https://github.com/kunickiaj/codemem/compare/`));
		}
		assert.match(changelog, /^### (?:Added|Changed|Fixed|Removed)$/m);
		assert.doesNotMatch(changelog, /^### (?:Highlights|Compatibility and upgrade)$/m);
	});
});
