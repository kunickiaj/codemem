import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "node:test";

const require = createRequire(import.meta.url);
const { parse } = createRequire(require.resolve("vite"))("yaml");
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const normal = parse(read(".github/workflows/ci.yml"));
const diagnostic = parse(read(".github/workflows/ci-package-probe.yml"));
const cacheAction = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";

for (const [id, lane, name, report] of [
	["ts-test", "ci-packages", "TypeScript Test", "package-tests"],
	["worker-test", "ci-worker", "Cloudflare Worker Test", "worker-tests"],
]) {
	it(`${id} runs one required native lane after fresh prerequisites`, () => {
		// Arrange
		const job = normal.jobs[id];
		// Act
		const tests = job.steps.filter((step) => step.run?.includes("ci:package-probe"));
		const commands = job.steps.map((step) => step.run);
		// Assert: no optional job, skipped test, or duplicate legacy test chain.
		assert.equal(job.name, name);
		assert.equal(job.if, undefined);
		assert.equal(job["continue-on-error"], undefined);
		assert.equal(tests.length, 1);
		assert.equal(tests[0].run, `pnpm run ci:package-probe ${lane}`);
		assert.equal(tests[0].if, undefined);
		assert.equal(tests[0]["continue-on-error"], undefined);
		assert.ok(commands.indexOf("pnpm install --frozen-lockfile") < commands.indexOf(tests[0].run));
		assert.ok(commands.includes("pnpm install --frozen-lockfile"));
		for (const step of job.steps.filter((step) =>
			/^(pnpm install|pnpm run build)/.test(step.run),
		)) {
			assert.equal(step.if, undefined);
			assert.equal(step["continue-on-error"], undefined);
		}
		if (lane === "ci-packages") {
			assert.ok(
				commands.indexOf("pnpm run build") > commands.indexOf("pnpm install --frozen-lockfile"),
			);
			assert.ok(commands.indexOf("pnpm run build") < commands.indexOf(tests[0].run));
		}
		assert.doesNotMatch(
			commands.join("\n"),
			/pnpm run test:ci\b|pnpm run test:release|pnpm --filter .* test:worker/,
		);
	});

	it(`${id} restricts task transport to same-PR daily runtime results and fails fresh`, () => {
		// Arrange
		const job = normal.jobs[id];
		// Act
		const caches = job.steps.filter((step) => step.uses?.startsWith("actions/cache"));
		const cache = caches[0];
		const test = job.steps.find((step) => step.run === `pnpm run ci:package-probe ${lane}`);
		const identity = job.steps.find((step) => step.id === "identity");
		// Assert: the main cache action saves only after job success, not a separate save step.
		assert.equal(caches.length, 1);
		assert.equal(cache.uses, cacheAction);
		assert.equal(cache.id, "task-cache");
		assert.equal(cache.if, "env.CI_FORCE_FULL == '0'");
		assert.equal(cache["continue-on-error"], true);
		assert.equal(
			job.env.CI_FORCE_FULL,
			"${{ (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name != github.repository || contains(github.event.pull_request.labels.*.name, 'ci:full')) && '1' || '0' }}",
		);
		assert.equal(
			test.env.CI_FORCE_FULL,
			"${{ steps.task-cache.outcome == 'failure' && '1' || env.CI_FORCE_FULL }}",
		);
		assert.equal(test.env.CI_PACKAGE_CACHE_DIR, "${{ steps.identity.outputs.cache }}");
		assert.equal(cache.with.path, "${{ steps.identity.outputs.cache }}/pipeline/*/tasks");
		const prefix = `package-probe-v1-\${{ github.event.pull_request.number }}-${lane}-\${{ steps.identity.outputs.runtime }}-\${{ steps.identity.outputs.epoch }}-`;
		assert.equal(cache.with["restore-keys"].trim(), prefix);
		assert.equal(cache.with.key, `${prefix}\${{ github.run_id }}-\${{ github.run_attempt }}`);
		assert.doesNotMatch(cache.with["restore-keys"], /sha|commit|run_id|run_attempt/);
		assert.match(identity.run, /runtimeFingerprint\(process\.cwd\(\)\)/);
		assert.match(identity.run, /Math\.floor\(Date\.now\(\) \/ 86400000\)/);
		assert.ok(job.steps.indexOf(identity) < job.steps.indexOf(cache));
		assert.ok(job.steps.indexOf(cache) < job.steps.indexOf(test));
	});

	it(`${id} always uploads original test outputs and native run events, not task caches`, () => {
		// Arrange
		const job = normal.jobs[id];
		// Act
		const uploads = job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
		// Assert
		assert.equal(uploads.length, 1);
		assert.equal(uploads[0].if, "always()");
		assert.equal(uploads[0].with.name, report);
		assert.equal(uploads[0].with["include-hidden-files"], true);
		const paths = uploads[0].with.path.trim().split("\n");
		const outputs =
			lane === "ci-packages"
				? [".tmp/ci-package-test/**", "packages/*/.tmp/ci-package-test/**"]
				: ["packages/cloudflare-coordinator-worker/.tmp/ci-package-test/**"];
		assert.deepEqual(paths, [...outputs, "${{ steps.identity.outputs.cache }}/pipeline/*/runs/**"]);
		assert.doesNotMatch(paths.join("\n"), /\/tasks/);
	});
}

it("keeps the manual diagnostic fresh and single-pass without comparison or cache transport", () => {
	// Arrange
	const job = diagnostic.jobs.probe;
	// Act
	const tests = job.steps.filter((step) => step.run?.includes("ci:package-probe"));
	const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
	// Assert
	assert.deepEqual(Object.keys(diagnostic.on), ["workflow_dispatch"]);
	assert.deepEqual(diagnostic.permissions, { contents: "read" });
	assert.deepEqual(job.strategy.matrix.pipeline, ["ci-packages", "ci-worker"]);
	assert.equal(job.env.CI_FORCE_FULL, "1");
	const build = job.steps.find((step) => step.run === "pnpm run build");
	assert.equal(build.if, "matrix.pipeline == 'ci-packages'");
	assert.ok(job.steps.indexOf(build) < job.steps.indexOf(tests[0]));
	assert.ok(job.steps.some((step) => step.run === "pnpm install --frozen-lockfile"));
	assert.equal(tests.length, 1);
	assert.equal(tests[0].run, "pnpm run ci:package-probe ${{ matrix.pipeline }}");
	assert.equal(tests[0].if, undefined);
	assert.equal(tests[0]["continue-on-error"], undefined);
	assert.equal(tests[0].env, undefined);
	assert.equal(upload.if, "always()");
	assert.equal(upload.with.name, "package-diagnostic-${{ matrix.pipeline }}");
	assert.doesNotMatch(
		JSON.stringify(job),
		/actions\/cache|runtimeFingerprint|CI_PACKAGE_CACHE_DIR|candidate|control/,
	);
	for (const workflow of [normal, diagnostic]) {
		assert.doesNotMatch(
			JSON.stringify(workflow),
			/package-candidate|package-control|id":"(?:candidate|control)"/,
		);
	}
});

it("propagates native input dependencies without defining runnable input scripts", () => {
	// Arrange
	const workspace = read("pnpm-workspace.yaml");
	const packages = readdirSync(new URL("../packages/", import.meta.url));
	// Act
	const manifests = ["package.json", ...packages.map((name) => `packages/${name}/package.json`)]
		.filter((path) => existsSync(new URL(`../${path}`, import.meta.url)))
		.map((path) => JSON.parse(read(path)));
	// Assert
	assert.match(workspace, /'ci:inputs':\n {4}dependsOn: \['\^ci:inputs'\]\n {4}outputs: \[\]/);
	assert.ok(manifests.every((manifest) => !Object.hasOwn(manifest.scripts ?? {}, "ci:inputs")));
});
