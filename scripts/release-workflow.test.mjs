import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { npmDistTagForReleaseTag } from "./release-dist-tag.mjs";
import { releaseNotesForTag } from "./release-notes.mjs";

const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const patchReleaseNotes = releaseNotesForTag(changelog, "v0.46.1");
const publishedPackages = [
	["@codemem/embeddings", "packages/embeddings"],
	["@codemem/core", "packages/core"],
	["@codemem/mcp", "packages/mcp-server"],
	["@codemem/server", "packages/viewer-server"],
	["codemem", "packages/cli"],
	["@codemem/opencode-plugin", "packages/opencode-plugin"],
	["@codemem/pi-extension", "packages/pi-extension"],
];

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
		assert.match(releaseWorkflow, /TAG_OUTPUT="\$\(node scripts\/release-dist-tag\.mjs "\$RELEASE_TAG"\)"/);
		assert.match(releaseWorkflow, /\^tag=\(alpha\|beta\|rc\|latest\)\$/);
		assert.match(releaseWorkflow, /printf '%s\\n' "\$TAG_OUTPUT" >> "\$GITHUB_OUTPUT"/);
		assert.match(releaseWorkflow, /publish --tag "\$\{DIST_TAG\}"/);
		for (const [packageName, packageDirectory] of publishedPackages) {
			assert.match(
				releaseWorkflow,
				new RegExp(
					`publish_if_missing "${packageName.replaceAll("/", "\\/")}" "${packageDirectory.replaceAll("/", "\\/")}"`,
				),
			);
		}
		assert.doesNotMatch(releaseWorkflow, /npm dist-tag (?:add|rm)/);
	});

	it("emits a dist-tag when executed from a path containing spaces", () => {
		const directory = mkdtempSync(join(tmpdir(), "codemem release tag "));
		const scriptPath = join(directory, "release dist tag.mjs");
		try {
			copyFileSync(fileURLToPath(new URL("./release-dist-tag.mjs", import.meta.url)), scriptPath);
			const result = spawnSync(process.execPath, [scriptPath, "v0.44.0-alpha.2"], {
				encoding: "utf8",
			});

			assert.equal(result.status, 0);
			assert.equal(result.stdout, "tag=alpha\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("GitHub release presentation", () => {
	it("uses the lowercase product name and prepends curated notes to generated changes", () => {
		assert.match(releaseWorkflow, /--title "codemem \$RELEASE_TAG"/);
 assert.match(releaseWorkflow, /RELEASE_NOTES="\$\(node scripts\/release-notes\.mjs "\$RELEASE_TAG"\)"/);
 assert.match(releaseWorkflow, /RELEASE_NOTES_ARGS=\(--notes "\$RELEASE_NOTES"\)/);
		assert.match(releaseWorkflow, /--generate-notes/);
		assert.doesNotMatch(patchReleaseNotes, /^# /m);
		assert.doesNotMatch(patchReleaseNotes, /\b(?:CodeMem|Codemem)\b/);
	});
});

describe("changelog release notes", () => {
	const fixture = "# Changelog\n\n## 1.2.3\n\nCurrent notes.\n\n### Limits\n\nA caveat.\n\n## 1.2.2\n\nPrevious notes.\n";

	it("extracts only the matching release while preserving subheadings", () => {
		assert.equal(releaseNotesForTag(fixture, "v1.2.3"), "Current notes.\n\n### Limits\n\nA caveat.");
		assert.equal(releaseNotesForTag(fixture, "v1.2.2"), "Previous notes.");
	});

	it("handles CRLF and a final entry without a trailing newline", () => {
		assert.equal(releaseNotesForTag(fixture.replaceAll("\n", "\r\n").trimEnd(), "1.2.2"), "Previous notes.");
	});

	it("matches prereleases exactly instead of including the stable entry", () => {
		const text = "## 1.2.3-rc.1\n\nCandidate.\n\n## 1.2.3\n\nStable.";
		assert.equal(releaseNotesForTag(text, "v1.2.3-rc.1"), "Candidate.");
		assert.equal(releaseNotesForTag(text, "v1.2.3"), "Stable.");
	});

	it("leaves missing or empty entries to generated GitHub notes", () => {
		assert.equal(releaseNotesForTag(fixture, "v9.9.9"), "");
		assert.equal(releaseNotesForTag("## 1.2.3\n\n## 1.2.2\nOld", "v1.2.3"), "");
	});

	it("rejects invalid tags and ambiguous duplicate entries", () => {
		for (const tag of ["main", "v1.2", "v1.2.3\n", "v1.2.3-other.1"]) {
			assert.throws(() => releaseNotesForTag(fixture, tag), /Invalid release tag/);
		}
		assert.throws(() => releaseNotesForTag(`${fixture}\n## 1.2.3\nDuplicate`, "v1.2.3"), /Duplicate changelog entry/);
	});

	it("preserves the migrated patch notes and upgrade caveats", () => {
		assert.match(patchReleaseNotes, /do \*\*not\*\* enforce a provider-side output-token cap/);
		const latest = releaseNotesForTag(changelog, "v0.46.2");
		assert.match(latest, /gpt-6-luna/);
		assert.match(latest, /Legacy `api_http`/);
		assert.doesNotMatch(latest, /This patch improves OpenCode 2 observer authentication/);
	});

	it("prints notes through the CLI and fails for an invalid tag", () => {
		const script = fileURLToPath(new URL("./release-notes.mjs", import.meta.url));
		const result = spawnSync(process.execPath, [script, "v0.46.2"], { encoding: "utf8" });
		assert.equal(result.status, 0);
		assert.equal(result.stdout, `${releaseNotesForTag(changelog, "v0.46.2")}\n`);
		const invalid = spawnSync(process.execPath, [script, "main"], { encoding: "utf8" });
		assert.equal(invalid.status, 1);
		assert.match(invalid.stderr, /Invalid release tag/);
	});
});
