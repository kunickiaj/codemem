import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeSharedInputs, runtimeFingerprint } from "./ci-package-inputs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const day = 86_400_000;

export function invocation({
	pipeline,
	shared,
	runtime,
	commit,
	env = process.env,
	now = Date.now(),
}) {
	if (!["ci-packages", "ci-worker"].includes(pipeline)) throw new Error("Unknown package pipeline");
	const unknownImage = env.CI && (!env.ImageOS || !env.ImageVersion);
	const freshEvent = env.CI && env.GITHUB_EVENT_NAME !== "pull_request";
	const fresh = env.CI_FORCE_FULL === "1" || !shared.cacheable || unknownImage || freshEvent;
	const args = ["pipeline", pipeline, "--full", "--include-workspace-root"];
	if (env.CI_PACKAGE_CACHE_DIR) args.unshift(`--config.cacheDir=${env.CI_PACKAGE_CACHE_DIR}`);
	if (fresh) args.push("--no-cache");
	return {
		args,
		fresh: Boolean(fresh),
		env: {
			...env,
			CI_SHARED_INPUTS: shared.digest,
			CI_RUNTIME: runtime,
			CI_UI_COMMIT: commit,
			CI_RESULT_EPOCH: String(Math.floor(now / day)),
		},
	};
}

export function execute(
	command,
	{ run = spawnSync, clock = Date.now, executable = process.env.npm_execpath ?? "pnpm" } = {},
) {
	console.log(
		command.fresh
			? "Package tasks: fresh execution"
			: "Package tasks: native input-key reuse enabled",
	);
	const options = { cwd: root, stdio: "inherit", env: command.env };
	const result = run(executable, command.args, options);
	if (result.status !== 0) return result.status ?? 1;
	if (!command.fresh && String(Math.floor(clock() / day)) !== command.env.CI_RESULT_EPOCH) {
		console.log("Cache age window changed; executing fresh");
		return run(executable, [...command.args, "--no-cache"], options).status ?? 1;
	}
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const command = invocation({
		pipeline: process.argv[2] ?? "ci-packages",
		shared: computeSharedInputs(root),
		runtime: runtimeFingerprint(root),
		commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
	});
	process.exitCode = execute(command);
}
