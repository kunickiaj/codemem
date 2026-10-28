import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { Script } from "node:vm";

const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const fullE2eWorkflow = readFileSync(
	new URL("../.github/workflows/e2e-full.yml", import.meta.url),
	"utf8",
);
const uiVisualWorkflow = readFileSync(
	new URL("../.github/workflows/ui-visual.yml", import.meta.url),
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
const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const heavyTest = "packages/core/src/coordinator-legacy-completion-owner-proof.test.ts";
const parallelArgs = [
	"exec",
	"vitest",
	"run",
	"--exclude",
	"**/coordinator-legacy-completion-owner-proof.test.ts",
	"--project",
	"!cloudflare-coordinator-worker",
];
const heavyArgs = ["exec", "vitest", "run", heavyTest, "--maxWorkers=1"];

function pnpmLauncher(platform, nodePath, stubPath) {
	if (platform === "win32") {
		return `@echo off\r\n"${nodePath}" "${stubPath}" %*\r\nexit /b %errorlevel%\r\n`;
	}
	const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
	return `#!/bin/sh\nexec ${quote(nodePath)} ${quote(stubPath)} "$@"\n`;
}

function writePnpmStub(directory) {
	const stub = join(directory, "node.cjs");
	writeFileSync(
		stub,
		`const fs = require("node:fs");
const log = process.env.CI_CONTRACT_LOG;
fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
const phase = fs.readFileSync(log, "utf8").trim().split("\\n").length;
process.exit(phase === Number(process.env.CI_CONTRACT_FAIL_PHASE) ? 23 : 0);
`,
	);
	const executable = join(directory, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
	writeFileSync(executable, pnpmLauncher(process.platform, process.execPath, stub));
	if (process.platform !== "win32") chmodSync(executable, 0o755);
}

function runCiScript(failPhase) {
	const directory = mkdtempSync(join(tmpdir(), "codemem-ci-contract-"));
	const log = join(directory, "calls.jsonl");
	try {
		writePnpmStub(directory);
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (key.toLowerCase() === "path") delete env[key];
		}
		const result = spawnSync(rootPackage.scripts["test:ci"], {
			shell: true,
			encoding: "utf8",
			env: {
				...env,
				PATH: `${directory}${delimiter}${process.env.PATH}`,
				CI_CONTRACT_LOG: log,
				CI_CONTRACT_FAIL_PHASE: String(failPhase),
			},
		});
		return {
			status: result.status,
			calls: readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

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

it("runs synthetic account acceptance separately with pinned package Chromium and built assets", () => {
	const job = getJob(ciWorkflow, "account-browser");
	const ui = JSON.parse(
		readFileSync(new URL("../packages/ui/package.json", import.meta.url), "utf8"),
	);
	assert.equal(
		ui.scripts["test:account-browser"],
		"pnpm run typecheck:account-browser && playwright test --config playwright.account.config.ts",
	);
	assert.equal(ui.scripts["typecheck:account-browser"], "tsc -p tsconfig.account.json --noEmit");
	const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.match(root.scripts.tsc, /pnpm --filter @codemem\/ui typecheck:account-browser/u);
	assert.match(job, /pnpm install --frozen-lockfile/u);
	assert.match(job, /pnpm --filter @codemem\/ui exec playwright install --with-deps chromium/u);
	assert.ok(
		job.indexOf("run: pnpm run build") <
			job.indexOf("run: pnpm --filter @codemem/ui test:account-browser"),
	);
	assert.match(job, /run: pnpm --filter @codemem\/ui test:account-browser/u);
	assert.doesNotMatch(job, /^\s*(?:if|continue-on-error|permissions|secrets):/m);
});

it("keeps the CI test selector and its tests unchanged under the existing Biome policy", () => {
	// Arrange: use an already-included path without extending the repository's ignore policy.
	const root = new URL("../", import.meta.url);
	const scripts = new URL("scripts/", root);
	const names = readdirSync(scripts).filter((name) => /^ci-changed-tests.*\.mjs$/u.test(name));
	assert.ok(names.length > 0, "expected the CI test selector and its tests");
	for (const name of names) {
		const source = readFileSync(new URL(name, scripts), "utf8");
		for (const input of [source, `${source} `]) {
			// Act: --write returns safe fixes on stdout, never writes the source file.
			const result = spawnSync(
				process.env.npm_execpath ?? "pnpm",
				[
					"exec",
					"biome",
					"check",
					"--write",
					"--error-on-warnings",
					"--stdin-file-path=scripts/ci-workflow.test.mjs",
				],
				{ cwd: root, input, encoding: "utf8" },
			);
			// Assert: reject both diagnostics and safe fixes that would change the source bytes.
			const diagnostic = `${name}: ${result.error?.message ?? ""}\n${result.stderr}`;
			assert.equal(result.status, 0, diagnostic);
			if (input === source) {
				assert.equal(result.stdout, input, diagnostic);
			} else {
				// Negative control: a formatting violation must not pass byte equality.
				assert.notEqual(result.stdout, input, diagnostic);
			}
		}
	}
});

it("opts into D1 profiling only for the Worker integration test step", () => {
	// Arrange
	const job = getJob(ciWorkflow, "worker-test");
	// Act
	const step = job
		.split(/^ {6}- /m)
		.find((entry) => entry.startsWith("name: Worker integration test\n"));
	// Assert: the step opts in, without enabling profiling for other steps or jobs.
	assert.ok(step, "expected the Worker integration test step");
	assert.match(step, /^ {8}env:\n(?:^ {10}.*\n)*^ {10}CODEMEM_WORKER_D1_PROFILE: '1'$/m);
	assert.match(step, /^ {8}run: node \.\.\/\.\.\/scripts\/ci-changed-tests\.mjs test:worker$/m);
	assert.doesNotMatch(ciWorkflow.replace(step, ""), /CODEMEM_WORKER_D1_PROFILE/u);
});

describe("normal CI workflow source contract", () => {
	it("does not rebuild workspace dependencies from the Worker build", () => {
		assert.match(workerPackage.scripts.build, /pnpm run check:bundle:prepared/u);
		assert.doesNotMatch(workerPackage.scripts.build, /pnpm run check:bundle(?:\s|$)/u);
		assert.match(workerPackage.scripts["check:bundle"], /pnpm --filter @codemem\/core build/u);
	});

	it("runs every Worker source test in the Worker job, which TypeScript Test excludes", () => {
		// test:ci excludes the Worker project, so a source test missing from test:node
		// would silently never run in CI.
		const sourceTests = readdirSync(
			new URL("../packages/cloudflare-coordinator-worker/src", import.meta.url),
		)
			.filter((name) => name.endsWith(".test.ts"))
			.map((name) => `src/${name}`)
			.sort();
		const nodeTests = workerPackage.scripts["test:node"]
			.split(/\s+/u)
			.filter((word) => word.endsWith(".test.ts"))
			.sort();
		assert.deepEqual(nodeTests, sourceTests);
		assert.match(workerPackage.scripts["test:worker"], /pnpm run test:node/u);
		assert.match(ciWorkflow, /ci-changed-tests\.mjs test:worker/u);
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

	for (const [id, command] of [
		[
			"ts-test",
			"node scripts/ci-changed-tests.mjs test:release test:adapter-normalizers test:ci-workflow test:semantic-installed test:ci",
		],
		["worker-test", "node ../../scripts/ci-changed-tests.mjs test:worker"],
	]) {
		it(`runs ${id} once through the PR test selector with full history`, () => {
			// Arrange
			const job = getJob(ciWorkflow, id);
			// Act
			const commands = [...job.matchAll(/^ {8}run: (.+)$/gm)].map((match) => match[1]);
			// Assert: ci:full and non-PR events pass no base, so every command runs unchanged.
			assert.equal(commands.filter((entry) => entry === command).length, 1);
			assert.match(job, /fetch-depth: 0/u);
			assert.match(
				job,
				/CI_TEST_BASE: \$\{\{ !contains\(github\.event\.pull_request\.labels\.\*\.name, 'ci:full'\) && github\.event\.pull_request\.base\.sha \|\| '' \}\}/u,
			);
			assert.doesNotMatch(job, /actions\/cache|continue-on-error|ci:package-probe/u);
		});
	}
});

describe("CI test scheduling contract", () => {
	it("keeps normal test filtering and default CI concurrency unchanged", () => {
		// Arrange: CI scheduling must not change development commands or deadlines.
		const config = readFileSync(new URL("../vitest.config.ts", import.meta.url), "utf8");
		const nodePath = "C:\\Program Files\\nodejs\\node.exe";
		const stubPath = "C:\\Temp Files\\node.cjs";
		// Act
		const scripts = rootPackage.scripts;
		const windowsLauncher = pnpmLauncher("win32", nodePath, stubPath);
		const posixLauncher = pnpmLauncher("darwin", "/node's path/node", "/temp files/node.cjs");
		// Assert
		assert.equal(
			windowsLauncher,
			`@echo off\r\n"${nodePath}" "${stubPath}" %*\r\nexit /b %errorlevel%\r\n`,
		);
		assert.equal(
			posixLauncher,
			"#!/bin/sh\nexec '/node'\\''s path/node' '/temp files/node.cjs' \"$@\"\n",
		);
		assert.equal(scripts.test, "pnpm exec vitest run");
		assert.equal(scripts["test:watch"], "pnpm exec vitest");
		assert.match(config, /maxWorkers: process\.env\.CI \? 3 : undefined/u);
		assert.doesNotMatch(
			scripts["test:ci"],
			/testTimeout|passWithNoTests|--testNamePattern|--no-file-parallelism/u,
		);
		// The only project filter excludes the Worker source tests, which the
		// Worker job runs through test:node (pinned below).
		assert.deepEqual(scripts["test:ci"].match(/--project \S+/gu), [
			'--project "!cloudflare-coordinator-worker"',
		]);
		assert.match(getJob(ciWorkflow, "ts-test"), /^ {4}name: TypeScript Test$/m);
		assert.doesNotMatch(getJob(ciWorkflow, "ts-test"), /^ {4}(?:if|continue-on-error):/m);
	});

	for (const { name, failPhase, status, calls } of [
		{
			name: "runs both complete phases after parallel success",
			failPhase: 0,
			status: 0,
			calls: [parallelArgs, heavyArgs],
		},
		{
			name: "stops and fails when the parallel phase fails",
			failPhase: 1,
			status: 23,
			calls: [parallelArgs],
		},
		{
			name: "fails when the isolated file fails",
			failPhase: 2,
			status: 23,
			calls: [parallelArgs, heavyArgs],
		},
	]) {
		it(name, () => {
			// Arrange: replace pnpm, never start a real suite or external service.
			const failure = failPhase;
			// Act
			const result = runCiScript(failure);
			// Assert: exact arguments also reject an extra forwarding separator or skipped cases.
			assert.deepEqual(result, { status, calls });
		});
	}
});

describe("required lint workflow contract", () => {
	it("enforces the Biome delta against immutable stacked PR revisions in required lint", () => {
		const lintJob = getJob(ciWorkflow, "ts-lint");

		assert.match(lintJob, /^ {4}name: TypeScript Lint$/m);
		assert.match(lintJob, /^ {10}fetch-depth: 0$/m);
		assert.match(lintJob, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
		assert.match(lintJob, /MERGE_SHA: \$\{\{ github\.sha \}\}/u);
		assert.match(
			lintJob,
			/pnpm --silent lint:delta -- --base "\$BASE_SHA" --head "\$MERGE_SHA" --json --github-annotations > \.tmp\/biome-delta\/report\.json/u,
		);
		assert.match(lintJob, /uses: actions\/upload-artifact@v6/u);
		assert.match(lintJob, /if-no-files-found: error/u);
		assert.ok(
			lintJob.indexOf("- name: Biome delta ratchet") < lintJob.indexOf("- name: Biome check"),
			"expected the delta report before fail-fast ordinary lint",
		);
		assert.doesNotMatch(lintJob, /continue-on-error/u);
		assert.doesNotMatch(lintJob, /github\.event\.pull_request\.head\.sha/u);
		assert.doesNotMatch(lintJob, /--base (?:main|origin\/main)/u);
	});
});

it("keeps standalone packed smoke self-building and prepared smoke on the same acceptance script", () => {
	const acceptanceScript = "node ./scripts/packed-artifact-smoke.mjs";
	const standalone = pluginPackage.scripts["test:packed-artifact"];
	const prepared = pluginPackage.scripts["test:packed-artifact:prepared"];

	assert.equal(standalone, `pnpm --filter codemem build && ${acceptanceScript}`);
	assert.equal(prepared, acceptanceScript);
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
		assert.equal(pluginPackage.engines.opencode, ">=1.18.29");
		assert.doesNotMatch(pluginJob, /^ {4}(?:if|continue-on-error):/m);
	});

	it("requires packed OpenCode 1 and exactly matched OpenCode 2.0.24 hosts on every normal run", () => {
		const buildCommand = "run: pnpm run build";
		const preparedCommand = "pnpm --filter @codemem/opencode-plugin test:packed-artifact:prepared";

		const packedJob = getJob(ciWorkflow, "packaged-plugin-smoke");
		const buildIndex = packedJob.indexOf(buildCommand);
		const preparedIndex = packedJob.indexOf(preparedCommand);

		// Assert: all host acceptance stays required after a successful same-checkout build.
		assert.equal(pluginPackage.devDependencies["@opencode/cli"], "2.0.24");
		assert.equal(pluginPackage.dependencies["@opencode/plugin"], "2.0.24");
		assert.equal(
			pluginPackage.scripts["test:opencode-v2-contract"],
			"node ./scripts/packed-v2-host-smoke.mjs",
		);
		assert.match(
			pluginPackage.scripts["test:packed-artifact"],
			/node \.\/scripts\/packed-artifact-smoke\.mjs$/u,
		);
		assert.match(
			packedJob,
			/^ {10}pnpm --filter @codemem\/opencode-plugin test:packed-artifact:prepared$/m,
		);
		assert.doesNotMatch(
			packedJob,
			/^ {10}pnpm --filter @codemem\/opencode-plugin test:packed-artifact$/m,
		);
		assert.match(packedJob, /^ {8}run: pnpm run build$/m);
		assert.ok(buildIndex >= 0 && preparedIndex > buildIndex);
		assert.equal([...packedJob.matchAll(/uses: actions\/checkout@/gu)].length, 1);
		assert.ok(packedJob.indexOf("uses: actions/checkout@") < buildIndex);
		assert.match(
			packedJob,
			/^ {10}pnpm --filter @codemem\/opencode-plugin test:opencode-v2-contract$/m,
		);
		assert.match(packedJob, /pnpm install --frozen-lockfile/u);
		assert.match(packedJob, /^ {10}pnpm --filter codemem test:packed-artifact$/m);
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

function assertVisualWorkflowScope() {
	assert.equal(
		getTopLevelBlock(uiVisualWorkflow, "on"),
		["on:", "  push:", "    branches: [main]", "  pull_request:"].join("\n"),
	);
	assert.equal(
		getTopLevelBlock(uiVisualWorkflow, "concurrency"),
		getExpectedConcurrency("ui-visual"),
	);
	assert.equal(getTopLevelBlock(uiVisualWorkflow, "permissions"), "permissions:\n  contents: read");
	assert.deepEqual(
		[...getTopLevelBlock(uiVisualWorkflow, "jobs").matchAll(/^ {2}([a-z0-9-]+):$/gm)].map(
			(match) => match[1],
		),
		["ui-visual"],
	);
	const job = getJob(uiVisualWorkflow, "ui-visual");
	assert.match(job, /^ {4}runs-on: ubuntu-24\.04$/m);
	assert.match(
		job,
		/^ {6}image: mcr\.microsoft\.com\/playwright:v1\.63\.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27$/m,
	);
	assert.match(job, /uses: pnpm\/action-setup@v5/u);
	assert.match(job, /run: pnpm install --frozen-lockfile/u);
	assert.match(
		job,
		/run: pnpm --filter @codemem\/ui visual:test-harness && pnpm --filter @codemem\/ui visual:typecheck/u,
	);
	assert.doesNotMatch(job, /continue-on-error|strategy:|matrix:|secrets:|id-token: write/u);
}

function assertVisualWorkflowComparison() {
	const job = getJob(uiVisualWorkflow, "ui-visual");
	assert.match(job, /CI: "true"/u);
	assert.match(job, /CODEMEM_VISUAL_OUTPUT: \.\.\/\.\.\/\.tmp\/visual-ci\/results/u);
	assert.match(
		job,
		/run: pnpm --filter @codemem\/ui exec playwright test --config playwright\.config\.ts/u,
	);
	assert.match(
		job,
		/run: pnpm --filter @codemem\/ui exec playwright test --config playwright\.control\.config\.ts/u,
	);
	assert.match(job, /if: failure\(\)[\s\S]*?uses: actions\/upload-artifact@v6/u);
	assert.match(job, /^ {10}path: \.tmp\/visual-ci\/\*\*$/m);
	assert.match(job, /^ {10}include-hidden-files: true$/m);
	assert.doesNotMatch(
		job,
		/CODEMEM_VISUAL_UPDATE|--update-snapshots|--ignore-snapshots|(?:^|\s)-u(?:\s|$)|visual:update|docker (?:run|build)/u,
	);
}

describe("UI visual regression workflow contract", () => {
	it(
		"runs a single blocking comparison on pull requests and main pushes with read-only access",
		assertVisualWorkflowScope,
	);
	it(
		"compares without updating baselines and uploads only generated failure results",
		assertVisualWorkflowComparison,
	);
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
