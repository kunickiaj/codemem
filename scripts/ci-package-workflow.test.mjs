import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { it } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/ci-package-probe.yml");
const steps = workflow.split(/^ {6}- /m).slice(1);
const step = (text) => steps.find((entry) => entry.includes(text));

it("restricts the diagnostic to first-party prototype PRs without changing required CI", () => {
	// Arrange
	const normal = read(".github/workflows/ci.yml");
	// Act
	const restriction = workflow.match(/^ {4}if: (.+)$/m)?.[1];
	// Assert
	assert.equal(
		restriction,
		"github.head_ref == 'ci/pr-restack-reuse-prototype' && github.event.pull_request.head.repo.full_name == github.repository",
	);
	assert.match(workflow, /^on:\n {2}pull_request:/m);
	assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
	assert.doesNotMatch(workflow, /pull_request_target|secrets\.|: write\b|gh api|checks:|statuses:/);
	assert.doesNotMatch(normal, /ci:package-probe|ci-package-probe\.yml|ci-package-pipeline/);
});

it("runs both lanes with an independent forced-fresh control before saving successful results", () => {
	// Arrange
	const candidate = step("id: candidate"),
		control = step("id: control");
	const save = step("actions/cache/save@"),
		restore = step("id: restore");
	// Act
	const commands = [candidate, control].map((entry) => entry.match(/run: (.+)/)?.[1]);
	// Assert
	assert.match(workflow, /pipeline: \[ci-packages, ci-worker\]/);
	assert.deepEqual(commands, Array(2).fill("pnpm run ci:package-probe ${{ matrix.pipeline }}"));
	assert.match(control, /CI_FORCE_FULL: '1'/);
	assert.match(candidate, /steps\.restore\.outcome == 'failure' && '1'/);
	assert.match(restore, /continue-on-error: true/);
	assert.match(
		save,
		/if: success\(\) && env\.CI_FORCE_FULL != '1' && steps\.restore\.outcome != 'failure'/,
	);
	assert.ok(steps.indexOf(save) > steps.indexOf(control));
	assert.doesNotMatch(control, /if:.*cache-hit|continue-on-error/);
});

it("caches only native tasks under a PR, lane, runtime, and original-age prefix", () => {
	// Arrange
	const restore = step("id: restore"),
		save = step("actions/cache/save@");
	// Act
	const paths = [restore, save].map((entry) => entry.match(/path: (.+)/)?.[1]);
	const prefix = restore.match(/restore-keys: \|\n\s+(.+)/)?.[1];
	// Assert
	assert.deepEqual(paths, Array(2).fill("${{ steps.identity.outputs.cache }}/pipeline/*/tasks"));
	assert.equal(
		prefix,
		"package-probe-v1-${{ github.event.pull_request.number }}-${{ matrix.pipeline }}-${{ steps.identity.outputs.runtime }}-${{ steps.identity.outputs.epoch }}-",
	);
	assert.doesNotMatch(prefix, /sha|commit|run_id|run_attempt/);
	assert.match(workflow, /runtimeFingerprint\(process\.cwd\(\)\)/);
	assert.match(workflow, /Math\.floor\(Date\.now\(\) \/ 86400000\)/);
	assert.doesNotMatch(paths.join("\n"), /profile|home|store|node_modules/);
});

it("publishes candidate and control reports separately, including native run events", () => {
	// Arrange
	const uploads = steps.filter((entry) => entry.includes("actions/upload-artifact@"));
	// Act
	const names = uploads.map((entry) => entry.match(/name: (package-.+)/)?.[1]);
	// Assert
	assert.deepEqual(names, [
		"package-candidate-${{ matrix.pipeline }}",
		"package-control-${{ matrix.pipeline }}",
	]);
	for (const upload of uploads) {
		assert.match(upload, /if: always\(\)/);
		assert.match(upload, /\.tmp\/ci-package-test\/\*\*/);
		assert.match(upload, /packages\/\*\/\.tmp\/ci-package-test\/\*\*/);
		assert.match(upload, /pipeline\/\*\/runs\/\*\*/);
		assert.doesNotMatch(upload, /pipeline\/\*\/tasks/);
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
