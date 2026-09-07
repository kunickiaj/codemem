import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	guardPackages,
	isPrereleaseVersion,
	latestGuardAction,
	readDistTags,
} from "./release-latest-guard.mjs";

const releaseWorkflow = readFileSync(
	new URL("../.github/workflows/release.yml", import.meta.url),
	"utf8",
);

const PUBLISHED_PACKAGES = [
	"@codemem/embeddings",
	"@codemem/core",
	"@codemem/mcp",
	"@codemem/server",
	"codemem",
	"@codemem/opencode-plugin",
];

/** Build a fake `spawnSync` that answers `npm view <pkg> dist-tags --json`. */
function fakeNpm(distTagsByPackage, { failView = new Set(), failRm = new Set() } = {}) {
	const calls = [];
	const spawn = (command, args) => {
		calls.push([command, ...args]);
		const [subcommand, ...rest] = args;
		if (subcommand === "dist-tag" && rest[0] === "ls") {
			const packageName = rest[1];
			if (failView.has(packageName)) {
				return { status: 1, stdout: "", stderr: `npm error 500 for ${packageName}` };
			}
			const distTags = distTagsByPackage[packageName];
			if (distTags === undefined) {
				return { status: 1, stdout: "", stderr: `npm error code E404\nnpm error 404 Not Found - GET ${packageName}` };
			}
			return { status: 0, stdout: Object.entries(distTags).map(([tag, version]) => `${tag}: ${version}`).join("\n"), stderr: "" };
		}
		if (subcommand === "dist-tag") {
			const packageName = rest[1];
			return failRm.has(packageName) ? { status: 1 } : { status: 0 };
		}
		throw new Error(`unexpected npm invocation: ${args.join(" ")}`);
	};
	return { spawn, calls };
}

describe("release latest-tag guard: classification", () => {
	it("classifies prerelease versions", () => {
		assert.equal(isPrereleaseVersion("0.44.0-alpha.1"), true);
		assert.equal(isPrereleaseVersion("0.44.0-beta.2"), true);
		assert.equal(isPrereleaseVersion("1.0.0-rc.0"), true);
		assert.equal(isPrereleaseVersion("0.43.2"), false);
		assert.equal(isPrereleaseVersion("1.0.0"), false);
	});

	it("removes latest only when it points at a prerelease", () => {
		// npm's first-publish behavior: a brand-new package published with
		// --tag alpha still gets latest set to that alpha.
		assert.deepEqual(latestGuardAction({ alpha: "0.44.0-alpha.1", latest: "0.44.0-alpha.1" }), {
			action: "remove",
			reason: "latest points at prerelease 0.44.0-alpha.1",
		});
	});

	it("never touches a stable latest, even during a prerelease publish", () => {
		assert.deepEqual(latestGuardAction({ alpha: "0.44.0-alpha.1", latest: "0.43.2" }), {
			action: "none",
			reason: "latest is stable 0.43.2",
		});
	});

	it("treats an absent latest as already correct", () => {
		assert.deepEqual(latestGuardAction({ alpha: "0.44.0-alpha.1" }), {
			action: "none",
			reason: "latest absent",
		});
		assert.deepEqual(latestGuardAction({}), { action: "none", reason: "latest absent" });
		assert.deepEqual(latestGuardAction(undefined), { action: "none", reason: "latest absent" });
		assert.deepEqual(latestGuardAction({ latest: "" }), { action: "none", reason: "latest absent" });
	});
});

describe("release latest-tag guard: registry reads", () => {
	it("reads package tags without needing latest to exist", () => {
		const { spawn, calls } = fakeNpm({ "@codemem/core": { beta: "0.44.0-beta.1" } });
		assert.deepEqual(readDistTags("@codemem/core", { spawn }), { beta: "0.44.0-beta.1" });
		assert.deepEqual(calls, [["npm", "dist-tag", "ls", "@codemem/core"]]);
	});

	it("treats an unpublished package as having no dist-tags", () => {
		// The guard must be runnable before a new package's first publish.
		const { spawn } = fakeNpm({});
		assert.deepEqual(readDistTags("@codemem/not-yet", { spawn }), {});
	});

	it("propagates non-404 registry failures", () => {
		const { spawn } = fakeNpm({}, { failView: new Set(["@codemem/core"]) });
		assert.throws(() => readDistTags("@codemem/core", { spawn }), /npm error 500/u);
	});
});

describe("release latest-tag guard: guardPackages", () => {
	it("counts packages needing action without mutating in dry-run mode", () => {
		const { spawn, calls } = fakeNpm({
			"@codemem/embeddings": { alpha: "0.44.0-alpha.1", latest: "0.44.0-alpha.1" },
			"@codemem/core": { alpha: "0.44.0-alpha.1", latest: "0.43.2" },
		});
		const needing = guardPackages(["@codemem/embeddings", "@codemem/core"], {
			apply: false,
			log: () => {},
			spawn,
		});
		assert.equal(needing, 1);
		assert.ok(calls.every(([, sub, action]) => sub === "dist-tag" && action === "ls"), "dry run must only list tags");
	});

	it("removes latest only for the flagged package in apply mode", () => {
		const { spawn, calls } = fakeNpm({
			"@codemem/embeddings": { alpha: "0.44.0-alpha.1", latest: "0.44.0-alpha.1" },
			"@codemem/core": { alpha: "0.44.0-alpha.1", latest: "0.43.2" },
		});
		guardPackages(["@codemem/embeddings", "@codemem/core"], { apply: true, log: () => {}, spawn });
		const removals = calls.filter(([, sub, action]) => sub === "dist-tag" && action === "rm");
		assert.deepEqual(removals, [["npm", "dist-tag", "rm", "@codemem/embeddings", "latest"]]);
	});

	it("inspects every package even when an earlier one fails, then reports all failures", () => {
		// A transient failure on package 2 must not leave packages 3-6 unseen.
		const { spawn, calls } = fakeNpm(
			{
				"@codemem/embeddings": { latest: "0.43.2" },
				"@codemem/core": { latest: "0.43.2" },
				"@codemem/mcp": { latest: "0.43.2" },
			},
			{ failView: new Set(["@codemem/core"]) },
		);
		assert.throws(
			() => guardPackages(["@codemem/embeddings", "@codemem/core", "@codemem/mcp"], { log: () => {}, spawn }),
			/latest-tag guard failures:\n@codemem\/core: /u,
		);
		const viewed = calls.filter(([, sub, action]) => sub === "dist-tag" && action === "ls").map(([, , , name]) => name);
		assert.deepEqual(viewed, ["@codemem/embeddings", "@codemem/core", "@codemem/mcp"]);
	});

	it("is idempotent: a second run after removal is a no-op", () => {
		const { spawn, calls } = fakeNpm({ "@codemem/embeddings": { alpha: "0.44.0-alpha.1" } });
		const needing = guardPackages(["@codemem/embeddings"], { apply: true, log: () => {}, spawn });
		assert.equal(needing, 0);
		assert.ok(calls.every(([, sub, action]) => sub === "dist-tag" && action === "ls"));
	});
});

describe("release latest-tag guard: workflow wiring", () => {
	it("runs verify-only after publishing, covering every published package on one step", () => {
		// OIDC trusted publishing grants `publish` only, not `dist-tag`, so the
		// workflow must not attempt --apply: it would 401 after packages are
		// already published. Verify-only, with the fix documented for a human.
		const stepStart = releaseWorkflow.indexOf("- name: Verify latest dist-tag is absent or stable");
		assert.ok(stepStart >= 0, "verify step missing");
		const nextStep = releaseWorkflow.indexOf("\n      - name:", stepStart + 1);
		const nextJob = releaseWorkflow.indexOf("\n  release:", stepStart);
		const stepEnd = [nextStep, nextJob].filter((i) => i > 0).reduce((a, b) => Math.min(a, b));
		const step = releaseWorkflow.slice(stepStart, stepEnd);

		assert.match(step, /node scripts\/release-latest-guard\.mjs/u);
		assert.doesNotMatch(step, /--apply/u, "workflow must never run the guard in apply mode");
		assert.doesNotMatch(step, /NODE_AUTH_TOKEN/u, "verify is unauthenticated");
		for (const packageName of PUBLISHED_PACKAGES) {
			assert.ok(step.includes(packageName), `verify step must cover ${packageName}`);
		}
		assert.ok(
			releaseWorkflow.indexOf('publish_if_missing "@codemem/opencode-plugin"') < stepStart,
			"verify must run after the last publish",
		);
	});

	it("points at the documented manual fix and stays warning-only until clean", () => {
		// The workflow must not itself contain a dist-tag mutation command
		// (release-workflow.test.mjs enforces that); it points at the doc.
		assert.match(releaseWorkflow, /docs\/versioning\.md/u);
		assert.match(releaseWorkflow, /continue-on-error: true/u);
	});
});
