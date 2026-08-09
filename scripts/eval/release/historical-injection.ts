import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { CommandExecutor } from "./historical-observer.js";
import { exactKeys, jsonObject, jsonValue, parseJson } from "./json-shape.js";
import { isPathOutside, resolvePathWithinAllowedRoots } from "./path-safety.js";
import type {
	HistoricalInjectionRequestV1,
	HistoricalInjectionTraceV1,
	JsonValue,
} from "./types.js";

export interface HistoricalInjectionDriverInput {
	execute: CommandExecutor;
	nodeExecutable: string;
	driverPath: string;
	runnerPath: string;
	pluginPath: string;
	tracePath: string;
	worktreePath: string;
	repositoryRoot: string;
	request: HistoricalInjectionRequestV1;
	tsxImportPath?: string;
	dependencyRoot?: string;
	prepareDependencies?(worktreePath: string, dependencyRoot: string): Promise<void>;
	clearTrace?(path: string): Promise<void>;
	realpath?(path: string): Promise<string>;
}

async function prepareDependencies(worktreePath: string, dependencyRoot: string): Promise<void> {
	const packageRoot = resolve(
		dependencyRoot,
		".tmp/release-eval-plugin-dependencies/node_modules/@opencode-ai/plugin",
	);
	await mkdir(packageRoot, { recursive: true });
	await writeFile(
		resolve(packageRoot, "package.json"),
		`${JSON.stringify({ name: "@opencode-ai/plugin", version: "0.0.0-release-eval", type: "module", exports: "./index.js" })}\n`,
		"utf8",
	);
	await writeFile(
		resolve(packageRoot, "index.js"),
		"const s=()=>({optional:s});export const tool=Object.assign((d)=>d,{schema:{number:s}});\n",
		"utf8",
	);
	const target = await realpath(
		resolve(dependencyRoot, ".tmp/release-eval-plugin-dependencies/node_modules"),
	);
	const link = resolve(worktreePath, "packages/opencode-plugin/.opencode/node_modules");
	const existing = await realpath(link).catch((error: NodeJS.ErrnoException) =>
		error.code === "ENOENT" ? null : Promise.reject(error),
	);
	if (existing === target) return;
	if (existing)
		throw new TypeError("Historical injection dependency link points outside the workspace");
	await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}
function strings(value: unknown, path: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
		throw new TypeError(`${path} must be a string array`);
	return value as string[];
}
function context(value: unknown, path: string): { system: string[]; messages: JsonValue[] } {
	const input = jsonObject(value, path);
	exactKeys(input, ["system", "messages"], path);
	if (!Array.isArray(input.messages)) throw new TypeError(`${path}.messages must be an array`);
	return {
		system: strings(input.system, `${path}.system`),
		messages: input.messages.map((entry, index) => jsonValue(entry, `${path}.messages[${index}]`)),
	};
}
function response(stdout: string): HistoricalInjectionTraceV1 {
	const root = jsonObject(
		parseJson(stdout, "historical injection response"),
		"historical injection response",
	);
	if (root.schema_version !== 1 || typeof root.ok !== "boolean")
		throw new TypeError("unsupported historical injection response");
	if (!root.ok)
		throw new Error(String(jsonObject(root.error, "historical injection error").message));
	const result = jsonObject(root.result, "historical injection result");
	exactKeys(
		result,
		["hook", "runner", "before", "after", "session_survived", "process_id"],
		"historical injection result",
	);
	if (
		result.hook !== "experimental.chat.system.transform" &&
		result.hook !== "experimental.chat.messages.transform"
	)
		throw new TypeError("historical injection hook is invalid");
	if (typeof result.session_survived !== "boolean" || !Number.isSafeInteger(result.process_id))
		throw new TypeError("historical injection lifecycle fields are invalid");
	const runner = jsonObject(result.runner, "historical injection runner");
	return {
		hook: result.hook,
		runner: {
			invoked: Boolean(runner.invoked),
			args: strings(runner.args, "runner.args"),
			query: runner.query === null ? null : String(runner.query),
			memory_ids: strings(runner.memory_ids, "runner.memory_ids"),
		},
		before: context(result.before, "before"),
		after: context(result.after, "after"),
		session_survived: result.session_survived,
		process_id: Number(result.process_id),
	};
}
export async function runHistoricalInjectionDriver(
	input: HistoricalInjectionDriverInput,
): Promise<HistoricalInjectionTraceV1> {
	const real = input.realpath ?? realpath;
	const [root, worktree, driver, runner, plugin] = await Promise.all([
		real(input.repositoryRoot),
		real(input.worktreePath),
		real(input.driverPath),
		real(input.runnerPath),
		real(input.pluginPath),
	]);
	const trace = await resolvePathWithinAllowedRoots(root, input.tracePath, [
		".tmp/eval-results/release",
	]);
	if (!isPathOutside(worktree, trace))
		throw new TypeError(
			"Historical injection trace must be inside the repository and outside the subject worktree",
		);
	await (input.prepareDependencies ?? prepareDependencies)(worktree, input.dependencyRoot ?? root);
	await (input.clearTrace ?? (async (path) => await writeFile(path, "", "utf8")))(trace);
	const tsx = input.tsxImportPath ?? createRequire(resolve(root, "package.json")).resolve("tsx");
	const execution = await input.execute(
		input.nodeExecutable,
		["--import", tsx, driver, plugin, runner, trace],
		{
			cwd: root,
			stdin: `${JSON.stringify(input.request)}\n`,
			env: {
				PATH: process.env.PATH,
				TMPDIR: process.env.TMPDIR,
				HOME: resolve(root, ".tmp/release-eval-home"),
			},
		},
	);
	if (execution.exitCode !== 0)
		throw new Error(`Historical injection driver failed: ${execution.stderr.trim()}`);
	return response(execution.stdout);
}
