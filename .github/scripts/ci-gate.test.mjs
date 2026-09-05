import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findCiGateFailures } from "./ci-gate.mjs";

const successfulNeeds = {
	classify: {
		result: "success",
		outputs: { run_full: "true", reason: "bottom" },
	},
	tsc: { result: "success", outputs: {} },
	"ts-test": { result: "success", outputs: {} },
};

const mainPullRequest = { eventName: "pull_request", baseRef: "main", defaultBranch: "main" };
const stackedPullRequest = {
	eventName: "pull_request",
	baseRef: "stack-parent",
	defaultBranch: "main",
};

test("accepts successful full CI", () => {
	assert.deepEqual(findCiGateFailures(successfulNeeds, mainPullRequest), []);
});

test("accepts the Windows smoke skip only on pull requests", () => {
	const needs = {
		...successfulNeeds,
		"windows-embedding-runtime-smoke": { result: "skipped", outputs: {} },
	};
	assert.deepEqual(findCiGateFailures(needs, mainPullRequest), []);
	assert.deepEqual(findCiGateFailures(needs, { eventName: "push" }), [
		"windows-embedding-runtime-smoke=skipped",
	]);
});

test("rejects skipped jobs when full CI was required", () => {
	const needs = { ...successfulNeeds, "ts-test": { result: "skipped", outputs: {} } };
	assert.deepEqual(findCiGateFailures(needs, mainPullRequest), ["ts-test=skipped"]);
});

test("accepts skipped jobs for a docs-only pull request", () => {
	const needs = {
		classify: {
			result: "success",
			outputs: { run_full: "false", reason: "docs-only" },
		},
		tsc: { result: "skipped", outputs: {} },
		"ts-test": { result: "skipped", outputs: {} },
	};
	assert.deepEqual(findCiGateFailures(needs, mainPullRequest), []);
});

test("blocks a reduced stacked pull request from merge authorization", () => {
	const needs = {
		classify: {
			result: "success",
			outputs: { run_full: "false", reason: "stacked-pr" },
		},
		tsc: { result: "skipped", outputs: {} },
		"ts-test": { result: "skipped", outputs: {} },
	};
	assert.deepEqual(findCiGateFailures(needs, stackedPullRequest), ["authorization=stacked-pr"]);
});

test("rejects failed jobs and invalid reduced classifications", () => {
	const invalidClassification = {
		classify: {
			result: "success",
			outputs: { run_full: "false", reason: "unknown-topology" },
		},
		tsc: { result: "skipped", outputs: {} },
		"ts-test": { result: "skipped", outputs: {} },
	};
	assert.deepEqual(findCiGateFailures(invalidClassification, mainPullRequest), [
		"classification=run_full:false,reason:unknown-topology",
	]);

	const failedReducedJob = {
		classify: {
			result: "success",
			outputs: { run_full: "false", reason: "docs-only" },
		},
		tsc: { result: "skipped", outputs: {} },
		"ts-test": { result: "failure", outputs: {} },
	};
	assert.deepEqual(findCiGateFailures(failedReducedJob, mainPullRequest), ["ts-test=failure"]);
});

test("accepts successful full jobs when the classifier fails open", () => {
	for (const result of ["failure", "cancelled"]) {
		const needs = {
			...successfulNeeds,
			classify: { result, outputs: {} },
		};
		assert.deepEqual(findCiGateFailures(needs, mainPullRequest), []);
	}
});

test("accepts the Windows smoke skip when the classifier fails open on a pull request", () => {
	const needs = {
		...successfulNeeds,
		classify: { result: "failure", outputs: {} },
		"windows-embedding-runtime-smoke": { result: "skipped", outputs: {} },
	};
	assert.deepEqual(findCiGateFailures(needs, mainPullRequest), []);
});

test("rejects incomplete full jobs when the classifier fails open", () => {
	const needs = {
		...successfulNeeds,
		classify: { result: "failure", outputs: {} },
		"ts-test": { result: "skipped", outputs: {} },
	};
	assert.deepEqual(findCiGateFailures(needs, mainPullRequest), ["ts-test=skipped"]);
});

test("rejects malformed needs metadata", () => {
	assert.deepEqual(findCiGateFailures(undefined), ["required-jobs=missing"]);
	assert.deepEqual(findCiGateFailures({ classify: { result: "failure", outputs: {} } }), [
		"required-jobs=missing",
	]);
});

test("supports successful full classifications before conditional CI is enabled", () => {
	const needs = {
		classify: {
			result: "success",
			outputs: { run_full: "true", reason: "bottom" },
		},
		...successfulNeeds,
	};
	assert.deepEqual(findCiGateFailures(needs, mainPullRequest), []);
});

test("accepts docs-only skips but blocks stacked merge authorization", () => {
	const reducedJobs = {
		tsc: { result: "skipped", outputs: {} },
		"ts-test": { result: "skipped", outputs: {} },
	};
	assert.deepEqual(
		findCiGateFailures(
			{
				classify: {
					result: "success",
					outputs: { run_full: "false", reason: "docs-only" },
				},
				...reducedJobs,
			},
			mainPullRequest,
		),
		[],
	);
	assert.deepEqual(
		findCiGateFailures(
			{
				classify: {
					result: "success",
					outputs: { run_full: "false", reason: "stacked-pr" },
				},
				...reducedJobs,
			},
			stackedPullRequest,
		),
		["authorization=stacked-pr"],
	);
});

test("blocks a full run while the pull request still targets a stack branch", () => {
	const needs = {
		...successfulNeeds,
		classify: {
			result: "success",
			outputs: { run_full: "true", reason: "ci:full" },
		},
	};
	assert.deepEqual(findCiGateFailures(needs, stackedPullRequest), ["authorization=stacked-pr"]);
});

test("blocks a stacked pull request when classification fails", () => {
	const needs = {
		classify: { result: "failure", outputs: {} },
		...successfulNeeds,
	};
	assert.deepEqual(findCiGateFailures(needs, stackedPullRequest), ["authorization=stacked-pr"]);
	assert.deepEqual(findCiGateFailures(needs, mainPullRequest), []);
});

test("depends on every other workflow job", async () => {
	const workflow = await readFile(new URL("../workflows/ci.yml", import.meta.url), "utf8");
	const jobs = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
	const jobIds = [...jobs.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((match) => match[1]);
	const gateBlock = jobs.slice(jobs.indexOf("  ci-gate:\n"));
	const needsMatch = gateBlock.match(/^ {4}needs: \[([^\]]+)]$/m);
	assert.ok(needsMatch);
	const gateNeeds = needsMatch[1].split(",").map((job) => job.trim());
	assert.deepEqual(
		gateNeeds,
		jobIds.filter((job) => job !== "ci-gate"),
	);
});

test("runs merge-sensitive scripts from the default branch", async () => {
	const workflow = await readFile(new URL("../workflows/ci.yml", import.meta.url), "utf8");
	const jobs = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
	const classifyBlock = jobs.slice(jobs.indexOf("  classify:\n"), jobs.indexOf("  tsc:\n"));
	const gateBlock = jobs.slice(jobs.indexOf("  ci-gate:\n"));
	const trustedRef = ["ref: $", "{{ github.event.repository.default_branch }}"].join("");
	const baseRefEnv = ["CI_BASE_REF: $", "{{ github.event.pull_request.base.ref }}"].join("");
	const defaultBranchEnv = [
		"CI_DEFAULT_BRANCH: $",
		"{{ github.event.repository.default_branch }}",
	].join("");
	assert.equal(classifyBlock.includes(trustedRef), true);
	assert.equal(gateBlock.includes(trustedRef), true);
	assert.equal(gateBlock.includes(baseRefEnv), true);
	assert.equal(gateBlock.includes(defaultBranchEnv), true);
});
