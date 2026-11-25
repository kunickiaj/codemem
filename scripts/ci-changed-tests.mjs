// Runs package test scripts, narrowing each `vitest run` to files affected by the PR.
// Vitest traces static imports; files that spawn processes, read repository files at
// runtime, or import computed paths (directly or via shared test fixtures) are invisible
// to that trace, so they always run.
// Main and `ci:full` runs set no base and execute every command unchanged.
// CI_TEST_SHARD (for example `1/2`) runs one Vitest shard of each `vitest run`, after
// selection, so every shard runner splits the same set of files.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VITEST = "pnpm exec vitest run";
const VALUE_FLAGS = new Set(["--config", "--exclude", "--project", "--dir", "--root"]);
const UNTRACED = [
	/from\s+["'](?:node:)?child_process["']/,
	/(?<![\w.$])import\(\s*(?!["'])/,
	// Vite query imports (`?raw`, `?inline`, `?url`) are dropped from the traced graph.
	/\?(?:raw|inline|url)["']/,
	// Worker threads and files addressed by URL load outside the traced graph.
	/new Worker\(|new URL\([^)]*import\.meta\.url/,
];
// Matches `fs` however it is loaded: `from "node:fs"`, `vi.importActual("node:fs")`,
// `vi.mock("node:fs", ...)`, or `typeof import("node:fs")` in `importOriginal`.
const READS_REPO = /["'](?:node:)?fs(?:\/promises)?["']/;
const REPO_PATH = /import\.meta\.(?:url|dirname)|__dirname/;

/** Splits a package script into commands, expanding `pnpm run <script>` from the same package. */
export function expandScripts(names, scripts) {
	return names.flatMap((name) => {
		const body = scripts[name];
		if (typeof body !== "string") throw new Error(`Unknown script: ${name}`);
		return body.split(/\s*&&\s*/).flatMap((command) => {
			const nested = /^pnpm run ([\w:-]+)$/.exec(command.trim());
			return nested ? expandScripts([nested[1]], scripts) : [command.trim()];
		});
	});
}

/** Splits `pnpm exec vitest run ...` arguments into option flags and file filters. */
export function parseVitest(command) {
	const words = (command.match(/"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^"(.*)"$/, "$1"));
	const flags = [];
	const filters = [];
	for (let index = 4; index < words.length; index++) {
		const word = words[index];
		if (!word.startsWith("-")) filters.push(word);
		else if (VALUE_FLAGS.has(word)) flags.push(word, words[++index]);
		else flags.push(word);
	}
	return { flags, filters };
}

/** True when Vitest's static import trace cannot see what this test file depends on. */
export function isUntraced(source) {
	if (UNTRACED.some((pattern) => pattern.test(source))) return true;
	return READS_REPO.test(source) && REPO_PATH.test(source);
}

/** Relative imports of shared test-support files (fixtures, helpers) from a test file. */
export function supportImports(file, source) {
	return [...source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)]
		.map((match) => resolve(dirname(file), match[1]))
		.flatMap((path) => [path, path.replace(/\.js$/, ".ts"), `${path}.ts`, `${path}.js`])
		.filter((path) => /test|fixture|helper/i.test(basename(path)) && !/\.test\./.test(path))
		.filter((path) => existsSync(path) && statSync(path).isFile());
}

// Shared fixtures can also hide spawns, workers, and computed imports. Their repository
// reads (Worker schema and migrations) are covered by forceRerunTriggers instead, which
// avoids always running the ~85 Core tests that share the coordinator store fixture.
function hasUntracedSupport(file, source) {
	return supportImports(file, source).some((path) =>
		UNTRACED.some((pattern) => pattern.test(readFileSync(path, "utf8"))),
	);
}

/** Picks the files to run: traced changes plus untraced files, or `null` to run everything. */
export function selectFiles({ all, changed, untraced }) {
	const affected = all.filter((file) => changed.has(file));
	if (affected.length === all.length) return null;
	return all.filter((file) => changed.has(file) || untraced.has(file));
}

function run(command, args, cwd, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	return spawnSync(command, args, { cwd, stdio: "inherit", ...options }).status ?? 1;
}

function listFiles(cwd, args) {
	const dir = mkdtempSync(join(tmpdir(), "codemem-ci-select-"));
	const output = join(dir, "files.json");
	try {
		const status = run(
			"pnpm",
			["exec", "vitest", "list", "--filesOnly", `--json=${output}`, ...args],
			cwd,
			{
				stdio: ["ignore", "ignore", "inherit"],
			},
		);
		if (status !== 0) throw new Error("vitest list failed");
		return [...new Set(JSON.parse(readFileSync(output, "utf8")).map((entry) => entry.file))];
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Extra `vitest run` arguments that run one shard of the files the command resolves. */
export function shardArgs(shard, { selected }) {
	if (!shard) return [];
	if (!/^[1-9]\d*\/[1-9]\d*$/.test(shard)) throw new Error(`Invalid CI_TEST_SHARD: ${shard}`);
	// Vitest refuses more shards than files unless told to pass with none; a small selection
	// can leave a shard empty, which is a pass. A full run always has files for every shard.
	return selected ? [`--shard=${shard}`, "--passWithNoTests"] : [`--shard=${shard}`];
}

function runSelected(command, cwd, base, shard) {
	const { flags, filters } = parseVitest(command);
	const all = listFiles(cwd, [...flags, ...filters]);
	const changed = new Set(listFiles(cwd, [...flags, "--changed", base]));
	const untraced = new Set(
		all.filter((file) => {
			const source = readFileSync(file, "utf8");
			return isUntraced(source) || hasUntracedSupport(file, source);
		}),
	);
	const files = selectFiles({ all, changed, untraced });
	if (files === null) {
		const args = shardArgs(shard, { selected: false });
		return run("pnpm", ["exec", "vitest", "run", ...flags, ...filters, ...args], cwd);
	}
	console.log(`Selected ${files.length} of ${all.length} test files (${untraced.size} untraced).`);
	if (files.length === 0) return 0;
	const paths = files.map((file) => relative(cwd, file));
	const args = shardArgs(shard, { selected: true });
	return run("pnpm", ["exec", "vitest", "run", ...flags, ...paths, ...args], cwd);
}

const isVitestRun = (command) => command === VITEST || command.startsWith(`${VITEST} `);

export function main(names, { cwd = process.cwd(), env = process.env } = {}) {
	const { scripts } = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
	const base = env.CI_FORCE_FULL === "1" ? "" : (env.CI_TEST_BASE ?? "");
	const shard = env.CI_TEST_SHARD ?? "";
	console.log(base ? `Selecting tests changed since ${base}` : "Running full test scripts");
	if (shard) console.log(`Running Vitest shard ${shard}`);
	const commands = expandScripts(names, scripts);
	// Every shard runner runs every command it is given, so anything else would run twice.
	const unsharded = shard ? commands.filter((command) => !isVitestRun(command)) : [];
	if (unsharded.length) throw new Error(`CI_TEST_SHARD cannot split: ${unsharded.join("; ")}`);
	for (const command of commands) {
		const vitest = isVitestRun(command);
		const full = [command, ...(vitest ? shardArgs(shard, { selected: false }) : [])].join(" ");
		const status =
			base && vitest ? runSelected(command, cwd, base, shard) : run(full, [], cwd, { shell: true });
		if (status !== 0) return status;
	}
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = main(process.argv.slice(2));
}
