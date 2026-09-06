import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const fullE2eWorkflow = readFileSync(
	new URL("../.github/workflows/e2e-full.yml", import.meta.url),
	"utf8",
);
const githubExpressionOpen = ["$", "{", "{"].join("");

function getTopLevelBlock(workflow, key) {
	const match = workflow.match(
		new RegExp(`^${key}:\\n([\\s\\S]*?)(?=^[a-z][a-z-]*:\\n|(?![\\s\\S]))`, "m"),
	);
	assert.ok(match, `expected top-level ${key} block`);
	return match[0].trimEnd();
}

function getJob(workflow, jobId) {
	const match = workflow.match(
		new RegExp(`^  ${jobId}:\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:\\n|(?![\\s\\S]))`, "m"),
	);
	assert.ok(match, `expected ${jobId} job`);
	return match[0];
}

function getMatrixScenarios(job) {
	return [...job.matchAll(/^ {10}- name: (.+)\n {12}script: (.+)$/gm)].map(([, name, script]) => ({
		name,
		script,
	}));
}

function getExpectedConcurrency(prefix) {
	const group = [
		"  group: ",
		githubExpressionOpen,
		" github.event_name == 'pull_request' && format('",
		`${prefix}-pr-{0}`,
		"', github.event.pull_request.number) || format('",
		`${prefix}-{0}-{1}`,
		"', github.event_name, github.run_id) }}",
	].join("");
	const cancellation = [
		"  cancel-in-progress: ",
		githubExpressionOpen,
		" github.event_name == 'pull_request' }}",
	].join("");
	return ["concurrency:", group, cancellation].join("\n");
}

const specializedScenarios = [
	{ name: "Legacy Team Migration", script: "e2e:legacy-team-migration" },
	{ name: "Project Sharing", script: "e2e:project-sharing" },
	{ name: "Sharing Domains", script: "e2e:sharing-domains" },
];

describe("normal CI workflow source contract", () => {
	it("contains only main push, default pull request, and workflow call triggers", () => {
		assert.equal(
			getTopLevelBlock(ciWorkflow, "on"),
			["on:", "  push:", "    branches: [main]", "  pull_request:", "", "  workflow_call:"].join(
				"\n",
			),
		);
	});

	it("groups and cancels pull request runs without canceling non-PR runs", () => {
		assert.equal(getTopLevelBlock(ciWorkflow, "concurrency"), getExpectedConcurrency("ci"));
	});

	it("runs the workflow source contract in the TypeScript Test job", () => {
		const testJob = getJob(ciWorkflow, "ts-test");

		assert.match(
			testJob,
			/^ {8}run: pnpm run test:release && pnpm run test:adapter-normalizers && pnpm run test:ci-workflow && pnpm run test$/m,
		);
	});

	it("defines the regular E2E Smoke check without an event condition", () => {
		const smokeJob = getJob(ciWorkflow, "e2e-smoke");

		assert.match(smokeJob, /^ {4}name: E2E Smoke$/m);
		assert.match(smokeJob, /^ {8}run: pnpm run e2e:smoke -- --json$/m);
		assert.doesNotMatch(smokeJob, /^ {4}if:/m);
	});

	it("keeps specialized scenarios off pull request runs", () => {
		const specializedJob = getJob(ciWorkflow, "e2e-specialized");

		assert.match(specializedJob, /^ {4}name: E2E \$\{\{ matrix\.name \}\}$/m);
		assert.match(specializedJob, /^ {4}if: github\.event_name != 'pull_request'$/m);
		assert.deepEqual(getMatrixScenarios(specializedJob), specializedScenarios);
	});
});

describe("full E2E workflow source contract", () => {
	it("contains only pull request reevaluation, manual, and nightly triggers", () => {
		assert.equal(
			getTopLevelBlock(fullE2eWorkflow, "on"),
			[
				"on:",
				"  pull_request:",
				"    types: [opened, reopened, synchronize, labeled, unlabeled]",
				"  workflow_dispatch:",
				"  schedule:",
				'    - cron: "17 3 * * *"',
			].join("\n"),
		);
	});

	it("groups and cancels pull request runs without canceling non-PR runs", () => {
		assert.equal(
			getTopLevelBlock(fullE2eWorkflow, "concurrency"),
			getExpectedConcurrency("e2e-full"),
		);
	});

	it("defines the Full E2E Smoke check for non-PR runs", () => {
		const smokeJob = getJob(fullE2eWorkflow, "e2e-smoke");

		assert.match(smokeJob, /^ {4}name: Full E2E Smoke$/m);
		assert.match(smokeJob, /^ {4}if: github\.event_name != 'pull_request'$/m);
		assert.match(smokeJob, /^ {8}run: pnpm run e2e:smoke -- --json$/m);
	});

	it("defines advisory specialized checks for non-PR or ci:full pull request runs", () => {
		const specializedJob = getJob(fullE2eWorkflow, "e2e-specialized");

		assert.match(specializedJob, /^ {4}name: Full E2E \$\{\{ matrix\.name \}\}$/m);
		assert.match(
			specializedJob,
			/^ {4}if: github\.event_name != 'pull_request' \|\| contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci:full'\)$/m,
		);
		assert.deepEqual(getMatrixScenarios(specializedJob), specializedScenarios);
	});
});
