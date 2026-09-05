import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findCiGateFailures } from "./ci-gate.mjs";

const successfulNeeds = {
	tsc: { result: "success", outputs: {} },
	"ts-test": { result: "success", outputs: {} },
};

test("accepts successful required jobs", () => {
	assert.deepEqual(findCiGateFailures(successfulNeeds), []);
});

test("accepts the Windows smoke skip only on pull requests", () => {
	const needs = {
		...successfulNeeds,
		"windows-embedding-runtime-smoke": { result: "skipped", outputs: {} },
	};
	assert.deepEqual(findCiGateFailures(needs, { eventName: "pull_request" }), []);
	assert.deepEqual(findCiGateFailures(needs, { eventName: "push" }), [
		"windows-embedding-runtime-smoke=skipped",
	]);
});

test("rejects failed, cancelled, skipped, and missing jobs", () => {
	for (const result of ["failure", "cancelled", "skipped", "missing"]) {
		const needs = { ...successfulNeeds, "ts-test": { result, outputs: {} } };
		assert.deepEqual(findCiGateFailures(needs), [`ts-test=${result}`]);
	}
});

test("rejects non-Windows skipped jobs on pull requests", () => {
	const needs = { ...successfulNeeds, "ts-test": { result: "skipped", outputs: {} } };
	assert.deepEqual(findCiGateFailures(needs, { eventName: "pull_request" }), ["ts-test=skipped"]);
});

test("rejects malformed or empty needs metadata", () => {
	assert.deepEqual(findCiGateFailures(undefined), ["required-jobs=missing"]);
	assert.deepEqual(findCiGateFailures({}), ["required-jobs=missing"]);
});

test("supports successful full classifications before conditional CI is enabled", () => {
	const needs = {
		classify: { result: "success", outputs: { run_full: "true", reason: "bottom" } },
		...successfulNeeds,
	};
	assert.deepEqual(findCiGateFailures(needs), []);
});

test("accepts docs-only skips but blocks stacked merge authorization", () => {
	const reducedJobs = {
		tsc: { result: "skipped", outputs: {} },
		"ts-test": { result: "skipped", outputs: {} },
	};
	assert.deepEqual(
		findCiGateFailures({
			classify: { result: "success", outputs: { run_full: "false", reason: "docs-only" } },
			...reducedJobs,
		}),
		[],
	);
	assert.deepEqual(
		findCiGateFailures({
			classify: { result: "success", outputs: { run_full: "false", reason: "stacked-pr" } },
			...reducedJobs,
		}),
		["authorization=stacked-pr"],
	);
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
