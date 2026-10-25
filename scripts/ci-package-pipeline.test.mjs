import assert from "node:assert/strict";
import { it } from "node:test";
import { execute, invocation } from "./ci-package-pipeline.mjs";

const day = 86_400_000;
const pr = {
	CI: "1",
	GITHUB_EVENT_NAME: "pull_request",
	ImageOS: "fixture-os",
	ImageVersion: "fixture-version",
};
const input = (env = pr) => ({
	pipeline: "ci-packages",
	shared: { digest: "fixture-digest", cacheable: true },
	runtime: "fixture-runtime",
	commit: "fixture-commit",
	env,
	now: day * 10,
});

for (const pipeline of ["ci-packages", "ci-worker"]) {
	it(`${pipeline} passes automatic inputs and allows verified PR reuse`, () => {
		// Arrange
		const options = { ...input(), pipeline };
		// Act
		const command = invocation(options);
		// Assert
		assert.deepEqual(command.args, ["pipeline", pipeline, "--full", "--include-workspace-root"]);
		assert.equal(command.fresh, false);
		assert.deepEqual(command.env, {
			...pr,
			CI_SHARED_INPUTS: "fixture-digest",
			CI_RUNTIME: "fixture-runtime",
			CI_UI_COMMIT: "fixture-commit",
			CI_RESULT_EPOCH: "10",
		});
	});
}

for (const reason of [
	"main",
	"release",
	"unknown-event",
	"unknown-image",
	"unverified",
	"forced",
]) {
	it(`forces fresh execution for ${reason}`, () => {
		// Arrange
		const options = input({ ...pr });
		if (["main", "release", "unknown-event"].includes(reason))
			options.env.GITHUB_EVENT_NAME = { main: "push", release: "release" }[reason];
		if (reason === "unknown-image") delete options.env.ImageVersion;
		if (reason === "unverified") options.shared.cacheable = false;
		if (reason === "forced") options.env.CI_FORCE_FULL = "1";
		// Act
		const command = invocation(options);
		// Assert
		assert.equal(command.fresh, true);
		assert.equal(command.args.filter((arg) => arg === "--no-cache").length, 1);
	});
}

it("allows explicit local cache use but rejects unknown pipelines", () => {
	// Arrange
	const options = input({});
	// Act
	const command = invocation(options);
	// Assert
	assert.equal(command.fresh, false);
	assert.ok(!command.args.includes("--no-cache"));
	assert.throws(() => invocation({ ...options, pipeline: "unknown" }), /Unknown package pipeline/);
});

it("passes an explicit cache directory as one argument without shell splitting", () => {
	// Arrange
	const path = "fixture cache/with spaces;not-a-command";
	// Act
	const command = invocation(input({ ...pr, CI_PACKAGE_CACHE_DIR: path }));
	// Assert
	assert.deepEqual(command.args, [
		`--config.cacheDir=${path}`,
		"pipeline",
		"ci-packages",
		"--full",
		"--include-workspace-root",
	]);
	assert.equal(command.fresh, false);
});

for (const executable of ["fixture/pinned pnpm.cjs", undefined]) {
	it(`defaults to ${executable ?? "pnpm when no pinned invoker exists"} without spawning`, () => {
		// Arrange
		const original = process.env.npm_execpath;
		const calls = [];
		if (executable === undefined) delete process.env.npm_execpath;
		else process.env.npm_execpath = executable;
		try {
			const command = invocation(input({ ...pr, CI_FORCE_FULL: "1" }));
			// Act
			const code = execute(command, {
				run: (name) => {
					calls.push(name);
					return { status: 0 };
				},
			});
			// Assert
			assert.equal(code, 0);
			assert.deepEqual(calls, [executable ?? "pnpm"]);
		} finally {
			if (original === undefined) delete process.env.npm_execpath;
			else process.env.npm_execpath = original;
		}
	});
}

for (const [fresh, statuses, epoch, expected] of [
	[true, [19], 11, 19],
	[true, [0], 11, 0],
	[false, [23], 11, 23],
	[false, [null], 11, 1],
	[false, [0], 10, 0],
	[false, [0, 0], 11, 0],
	[false, [0, 29], 11, 29],
	[false, [0, null], 11, 1],
]) {
	it(`executes fresh=${fresh}, statuses=${statuses}, epoch=${epoch} without masking failure`, () => {
		// Arrange
		const command = invocation(input(fresh ? { ...pr, CI_FORCE_FULL: "1" } : pr)),
			calls = [];
		// Act
		const code = execute(command, {
			executable: "pnpm",
			clock: () => epoch * day,
			run: (name, args, options) => {
				calls.push({ name, args, options });
				return { status: statuses[calls.length - 1] };
			},
		});
		// Assert
		assert.equal(code, expected);
		assert.equal(calls.length, statuses.length);
		assert.equal(calls[0].name, "pnpm");
		assert.deepEqual(calls[0].args, command.args);
		assert.deepEqual(calls[0].options.env, command.env);
		if (calls.length === 2) assert.deepEqual(calls[1].args, [...command.args, "--no-cache"]);
	});
}
