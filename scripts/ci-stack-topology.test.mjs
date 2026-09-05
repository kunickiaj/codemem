import assert from "node:assert/strict";
import test from "node:test";
import { classifyCi, classifyPullRequestTopology, isDocsOnly } from "./ci-stack-topology.mjs";

const REPOSITORY = "codemem/codemem";

function pullRequest(number, baseRef, headRef, labels = []) {
	return {
		number,
		baseRef,
		headRef,
		baseRepo: REPOSITORY,
		headRepo: REPOSITORY,
		labels,
	};
}

function classifyPullRequest(
	current,
	openPullRequests,
	changedFiles = ["packages/core/src/index.ts"],
) {
	return classifyCi({
		eventName: "pull_request",
		pullRequest: current,
		openPullRequests,
		changedFiles,
	});
}

test("classifies every position in a 17-PR chain", () => {
	const stack = Array.from({ length: 17 }, (_, index) =>
		pullRequest(index + 1, index === 0 ? "main" : `stack-${index}`, `stack-${index + 1}`),
	);

	assert.equal(
		classifyPullRequestTopology({ pullRequest: stack[0], openPullRequests: stack }),
		"bottom",
	);
	assert.equal(
		classifyPullRequestTopology({ pullRequest: stack[8], openPullRequests: stack }),
		"middle",
	);
	assert.equal(
		classifyPullRequestTopology({ pullRequest: stack[16], openPullRequests: stack }),
		"tip",
	);
	assert.deepEqual(
		stack.map((current) => classifyPullRequest(current, stack).runFull),
		[true, ...Array.from({ length: 16 }, () => false)],
	);
});

test("runs full CI for a standalone pull request", () => {
	const current = pullRequest(1, "main", "feature");
	assert.equal(classifyPullRequest(current, [current]).runFull, true);
});

test("runs full CI for a forced middle pull request", () => {
	const stack = [
		pullRequest(1, "main", "one"),
		pullRequest(2, "one", "two", ["ci:full"]),
		pullRequest(3, "two", "three"),
	];
	assert.deepEqual(classifyPullRequest(stack[1], stack), {
		runFull: true,
		docsOnly: false,
		topology: "middle",
		reason: "ci:full",
	});
});

test("keeps a stacked PR reduced when its child closes", () => {
	const stack = [
		pullRequest(1, "main", "one"),
		pullRequest(2, "one", "two"),
		pullRequest(3, "two", "three"),
	];
	assert.deepEqual(classifyPullRequest(stack[1], stack), {
		runFull: false,
		docsOnly: false,
		topology: "middle",
		reason: "stacked-pr",
	});
	assert.deepEqual(classifyPullRequest(stack[1], stack.slice(0, 2)), {
		runFull: false,
		docsOnly: false,
		topology: "tip",
		reason: "stacked-pr",
	});
});

test("runs full CI when topology metadata is missing", () => {
	const current = pullRequest(2, "missing-parent", "feature");
	assert.equal(classifyPullRequest(current, [current]).reason, "unknown-topology");
});

test("runs full CI when changed-file metadata is malformed", () => {
	const stack = [
		pullRequest(1, "main", "one"),
		pullRequest(2, "one", "two"),
		pullRequest(3, "two", "three"),
	];
	assert.equal(classifyPullRequest(stack[1], stack, [undefined]).reason, "invalid-changed-files");
});

test("runs full CI for push, merge group, and workflow call events", () => {
	for (const eventName of ["push", "merge_group", "workflow_call"]) {
		assert.equal(classifyCi({ eventName }).runFull, true);
	}
});

test("reduces known docs-only pull requests", () => {
	const current = pullRequest(1, "main", "docs");
	const result = classifyPullRequest(current, [current], ["README.md", "docs/ci.md"]);
	assert.deepEqual(result, {
		runFull: false,
		docsOnly: true,
		topology: "standalone",
		reason: "docs-only",
	});
});

test("classifies stacked docs changes as stacked before docs-only", () => {
	const stack = [pullRequest(1, "main", "one"), pullRequest(2, "one", "two")];
	assert.deepEqual(classifyPullRequest(stack[1], stack, ["docs/ci.md"]), {
		runFull: false,
		docsOnly: true,
		topology: "tip",
		reason: "stacked-pr",
	});
});

test("does not treat workflow or source changes as docs-only", () => {
	assert.equal(isDocsOnly([".github/workflows/ci.yml"]), false);
	assert.equal(isDocsOnly(["docs/ci.md", "packages/core/src/index.ts"]), false);
	assert.equal(isDocsOnly([]), false);
});

test("fails open for ambiguous branches", () => {
	const current = pullRequest(1, "main", "one");
	const stack = [current, pullRequest(2, "one", "two"), pullRequest(3, "one", "three")];
	assert.equal(classifyPullRequest(current, stack).runFull, true);
});
