import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { npmDistTagForReleaseTag } from "./release-dist-tag.mjs";

const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const publishedPackages = [
	["@codemem/embeddings", "packages/embeddings"],
	["@codemem/core", "packages/core"],
	["@codemem/mcp", "packages/mcp-server"],
	["@codemem/server", "packages/viewer-server"],
	["codemem", "packages/cli"],
	["@codemem/opencode-plugin", "packages/opencode-plugin"],
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
