import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Script } from "node:vm";

const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const fullE2eWorkflow = readFileSync(
	new URL("../.github/workflows/e2e-full.yml", import.meta.url),
	"utf8",
);
const workerPackage = JSON.parse(
	readFileSync(
		new URL("../packages/cloudflare-coordinator-worker/package.json", import.meta.url),
		"utf8",
	),
);
const githubExpressionOpen = ["$", "{", "{"].join("");
const pluginPackage = JSON.parse(
	readFileSync(new URL("../packages/opencode-plugin/package.json", import.meta.url), "utf8"),
);

function readBetaWorkflow() {
	return readFileSync(
		new URL("../.github/workflows/opencode-beta-compat.yml", import.meta.url),
		"utf8",
	);
}

function resolveBetaVersions(cliVersion, pluginVersion) {
	const workflow = readBetaWorkflow();
	const resolver = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)^ {10}NODE$/m);
	assert.ok(resolver, "expected an executable beta version resolver");
	const queries = [];
	const outputs = [];
	new Script(resolver[1].replace(/^\s*import .+;\n/gm, "")).runInNewContext({
		execFileSync(command, args, options) {
			queries.push([command, args, options]);
			return JSON.stringify(args[1] === "@opencode/cli@beta" ? cliVersion : pluginVersion);
		},
		appendFileSync(path, value) {
			assert.equal(path, "workflow-output");
			outputs.push(value);
		},
		process: { env: { GITHUB_OUTPUT: "workflow-output" } },
	});
	return { queries: JSON.parse(JSON.stringify(queries)), outputs };
}

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
	it("does not rebuild workspace dependencies from the Worker build", () => {
		assert.match(workerPackage.scripts.build, /pnpm run check:bundle:prepared/u);
		assert.doesNotMatch(workerPackage.scripts.build, /pnpm run check:bundle(?:\s|$)/u);
		assert.match(workerPackage.scripts["check:bundle"], /pnpm --filter @codemem\/core build/u);
	});

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

	it("enforces the Biome delta against immutable stacked PR revisions in required lint", () => {
		const lintJob = getJob(ciWorkflow, "ts-lint");

		assert.match(lintJob, /^ {4}name: TypeScript Lint$/m);
		assert.match(lintJob, /^ {10}fetch-depth: 0$/m);
		assert.match(lintJob, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
		assert.match(lintJob, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
		assert.match(
			lintJob,
			/pnpm lint:delta -- --base "\$BASE_SHA" --head "\$HEAD_SHA" --json --github-annotations > \.tmp\/biome-delta\/report\.json/u,
		);
		assert.match(lintJob, /uses: actions\/upload-artifact@v6/u);
		assert.match(lintJob, /if-no-files-found: error/u);
		assert.doesNotMatch(lintJob, /continue-on-error/u);
		assert.doesNotMatch(lintJob, /--base (?:main|origin\/main)/u);
	});
});

describe("required OpenCode host workflow contract", () => {
	it("tests the minimum OpenCode 1 plugin runtime through both package suites", () => {
		const pluginJob = getJob(ciWorkflow, "plugin-smoke");

		assert.match(
			pluginJob,
			/npm install --prefix packages\/cli\/\.opencode --no-save @opencode-ai\/plugin@1\.18\.29/u,
		);
		assert.match(
			pluginJob,
			/npm install --prefix packages\/opencode-plugin\/\.opencode --no-save @opencode-ai\/plugin@1\.18\.29/u,
		);
		assert.match(pluginJob, /pnpm --filter @codemem\/opencode-plugin test &&/u);
		assert.equal(pluginPackage.dependencies["@opencode-ai/plugin"], "1.18.29");
		assert.doesNotMatch(pluginJob, /^ {4}(?:if|continue-on-error):/m);
	});

	it("requires packed OpenCode 1 and exactly matched OpenCode 2.0.2 hosts on every normal run", () => {
		const packedJob = getJob(ciWorkflow, "packaged-plugin-smoke");
		assert.equal(pluginPackage.devDependencies["@opencode/cli"], "2.0.2");
		assert.equal(pluginPackage.dependencies["@opencode/plugin"], "2.0.2");
		assert.equal(
			pluginPackage.scripts["test:opencode-v2-contract"],
			"node ./scripts/packed-v2-host-smoke.mjs",
		);
		assert.match(
			pluginPackage.scripts["test:packed-artifact"],
			/node \.\/scripts\/packed-artifact-smoke\.mjs$/u,
		);
		assert.match(packedJob, /^ {10}pnpm --filter @codemem\/opencode-plugin test:packed-artifact$/m);
		assert.match(
			packedJob,
			/^ {10}pnpm --filter @codemem\/opencode-plugin test:opencode-v2-contract$/m,
		);
		assert.match(packedJob, /pnpm install --frozen-lockfile/u);
		assert.doesNotMatch(packedJob, /^\s*(?:if|continue-on-error):/m);
		assert.doesNotMatch(ciWorkflow, /CODEMEM_OPENCODE_V2_VERSION|@opencode\/(?:cli|plugin)@beta/u);
	});
});

describe("normal CI E2E workflow contract", () => {
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

describe("advisory OpenCode beta workflow contract", () => {
	it("runs only manually and on a schedule with a non-blocking compatibility job", () => {
		const workflow = readBetaWorkflow();
		assert.equal(
			getTopLevelBlock(workflow, "on"),
			["on:", "  workflow_dispatch:", "  schedule:", '    - cron: "43 4 * * *"'].join("\n"),
		);
		const job = getJob(workflow, "opencode-beta-compat");
		assert.match(job, /^ {4}continue-on-error: true$/m);
		assert.match(job, /^ {4}timeout-minutes: 20$/m);
		assert.doesNotMatch(
			fullE2eWorkflow,
			/CODEMEM_OPENCODE_V2_VERSION|@opencode\/(?:cli|plugin)@beta/u,
		);
	});

	it("resolves both beta tags to one exact version before publishing an override", () => {
		const version = "2.0.3-beta.7";
		const result = resolveBetaVersions(version, version);
		assert.deepEqual(result.queries, [
			["npm", ["view", "@opencode/cli@beta", "version", "--json"], { encoding: "utf8" }],
			["npm", ["view", "@opencode/plugin@beta", "version", "--json"], { encoding: "utf8" }],
		]);
		assert.deepEqual(result.outputs, [`version=${version}\n`]);
		assert.throws(
			() => resolveBetaVersions(version, "2.0.3-beta.8"),
			/OpenCode beta version mismatch/u,
		);
		for (const invalid of [
			"beta",
			"^2.0.2",
			"2.0.2\n",
			"2.0.2 --ignore-scripts",
			"2.0.3-beta.01",
		]) {
			assert.throws(() => resolveBetaVersions(invalid, invalid), /exact semver/u);
		}
	});
});

describe("advisory OpenCode beta execution contract", () => {
	it("installs the matched pair outside the workspace without changing lockfiles and runs the packed contract", () => {
		const job = getJob(readBetaWorkflow(), "opencode-beta-compat");
		assert.match(job, /pnpm install --frozen-lockfile/u);
		assert.match(
			job,
			/npm install --prefix "\$RUNNER_TEMP\/opencode-beta" --no-save --package-lock=false "@opencode\/cli@\$CODEMEM_OPENCODE_V2_VERSION" "@opencode\/plugin@\$CODEMEM_OPENCODE_V2_VERSION"/u,
		);
		for (const name of ["cli", "plugin"]) {
			assert.ok(
				job.includes(
					`ln -sfn "$RUNNER_TEMP/opencode-beta/node_modules/@opencode/${name}" "packages/opencode-plugin/node_modules/@opencode/${name}"`,
				),
			);
		}
		assert.match(
			job,
			/^ {8}run: pnpm --filter @codemem\/opencode-plugin test:opencode-v2-contract$/m,
		);
		assert.match(
			job,
			/CODEMEM_OPENCODE_V2_VERSION: \$\{\{ steps\.beta-version\.outputs\.version \}\}/u,
		);
		assert.doesNotMatch(job, /pnpm (?:add|update)|--no-frozen-lockfile|--lockfile-only/u);
		assert.ok(job.indexOf("id: beta-version") < job.indexOf("npm install --prefix"));
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
