import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const broadProjects = new Set(["core", "viewer-server", "cli", "e2e-unit", "fresh-performance"]);

function validateProject(project) {
	if (typeof project !== "string" || !/^[a-z][a-z0-9-]*$/.test(project)) {
		throw new Error("Expected a simple Vitest project name");
	}
	return project;
}

function projectDirectory(project, root, cwd) {
	if (project === "worker-integration") return join(root, "packages/cloudflare-coordinator-worker");
	return broadProjects.has(project) ? root : cwd;
}

export function outputDirectory(project, root, cwd = root) {
	validateProject(project);
	const directory = projectDirectory(project, root, cwd);
	return join(
		directory,
		".tmp/ci-package-test",
		broadProjects.has(project) || project === "worker-integration" ? project : "unit",
	);
}

const reporters = (output, name = "results") => [
	"--reporter",
	"default",
	"--reporter",
	"json",
	"--outputFile",
	join(output, `${name}.json`),
	"--coverage.reportsDirectory",
	join(output, "coverage", name),
];
const command = (name, args, cwd) => ({ name, command: "pnpm", args, cwd });

function workerCommands(cwd, output) {
	const { scripts } = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
	const stages = scripts["test:worker"]
		.split(/\s*&&\s*/)
		.map((stage) => /^pnpm run ([\w:-]+)$/.exec(stage.trim())?.[1]);
	if (stages.some((name) => !name || typeof scripts[name] !== "string"))
		throw new Error("Unexpected worker test chain");
	return stages.map((name) => {
		const body = scripts[name];
		if (!body.startsWith("pnpm exec vitest run")) return command(name, ["run", name], cwd);
		if (typeof body !== "string" || !/^pnpm exec vitest run(?: [A-Za-z0-9_./:@=-]+)*$/.test(body)) {
			throw new Error("Expected a simple pnpm exec vitest run worker script");
		}
		return command(
			name,
			[...body.split(" ").slice(1), ...reporters(output, name.replace(":", "-"))],
			cwd,
		);
	});
}

export function buildCommands(project, root, cwd = root) {
	validateProject(project);
	const directory = projectDirectory(project, root, cwd);
	const output = outputDirectory(project, root, cwd);
	if (project === "worker-integration") return workerCommands(directory, output);
	const prerequisites =
		project === "e2e-unit"
			? ["test:release", "test:adapter-normalizers", "test:ci-workflow", "test:semantic-installed"]
			: [];
	return [
		...prerequisites.map((name) => command(name, ["--workspace-root", "run", name], root)),
		command(
			project,
			["--workspace-root", "exec", "vitest", "run", "--project", project, ...reporters(output)],
			directory,
		),
	];
}

function temporaryProfile(project) {
	const temporary = realpathSync(tmpdir());
	for (let parent = temporary; ; parent = dirname(parent)) {
		if (existsSync(join(parent, ".git")) || existsSync(join(parent, "package.json"))) {
			throw new Error("Test temporary directory must be outside repository and package scopes");
		}
		if (parent === dirname(parent)) break;
	}
	return mkdtempSync(join(temporary, `codemem-ci-${project}-`));
}

function toolPath(profile, original) {
	const bin = join(profile, "bin");
	mkdirSync(bin);
	symlinkSync(process.execPath, join(bin, process.platform === "win32" ? "node.exe" : "node"));
	if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
		symlinkSync(
			process.env.npm_execpath,
			join(bin, process.platform === "win32" ? "pnpm.exe" : "pnpm"),
		);
	}
	return [bin, original].filter(Boolean).join(delimiter);
}

export function isolatedEnv(root, output, baseEnv = process.env) {
	const project = basename(output) === "unit" ? basename(root) : basename(output);
	const profile = temporaryProfile(project);
	const env = Object.fromEntries(
		["SystemRoot", "ComSpec"]
			.filter((key) => baseEnv[key] !== undefined)
			.map((key) => [key, baseEnv[key]]),
	);
	Object.assign(env, {
		PATH: toolPath(profile, baseEnv.PATH),
		HOME: join(profile, "home"),
		USERPROFILE: join(profile, "home"),
		XDG_CONFIG_HOME: join(profile, "config"),
		XDG_CACHE_HOME: join(profile, "cache"),
		XDG_DATA_HOME: join(profile, "data"),
		XDG_STATE_HOME: join(profile, "state"),
		TMPDIR: join(profile, "tmp"),
		TMP: join(profile, "tmp"),
		TEMP: join(profile, "tmp"),
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		TZ: "UTC",
		CI: "1",
		CI_PACKAGE_TEST: "1",
		WRANGLER_SEND_METRICS: "false",
		FORCE_COLOR: "0",
	});
	for (const key of [
		"HOME",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"TMPDIR",
	]) {
		mkdirSync(env[key], { recursive: true });
	}
	return env;
}

export function runCommand(entry, env) {
	return new Promise((resolveExit) => {
		const child = spawn(entry.command, entry.args, {
			cwd: entry.cwd,
			env,
			stdio: "inherit",
			shell: false,
		});
		child.once("error", () => resolveExit(1));
		child.once("close", (code) => resolveExit(code ?? 1));
	});
}

function verifyReport(entry, executedAt) {
	const reportIndex = entry.args.indexOf("--outputFile");
	if (reportIndex === -1) return;
	const report = JSON.parse(readFileSync(entry.args[reportIndex + 1], "utf8"));
	if (
		report.success !== true ||
		!Array.isArray(report.testResults) ||
		!Number.isFinite(report.startTime) ||
		report.startTime < Date.parse(executedAt)
	) {
		throw new Error("Missing complete test results");
	}
}

export async function main(args = process.argv.slice(2), options = {}) {
	if (args.length > 1) throw new Error("Expected at most one project argument");
	const root = options.root ?? repositoryRoot;
	const cwd = options.cwd ?? process.cwd();
	const project = validateProject(args[0] ?? basename(cwd));
	const output = outputDirectory(project, root, cwd);
	mkdirSync(output, { recursive: true });
	const metadata = {
		schemaVersion: 1,
		project,
		executedAt: new Date().toISOString(),
		status: "failure",
		commands: [],
	};
	writeFileSync(join(output, "execution.json"), `${JSON.stringify(metadata, null, 2)}\n`);
	let exitCode = 1;
	try {
		const env = isolatedEnv(
			projectDirectory(project, root, cwd),
			output,
			options.baseEnv ?? process.env,
		);
		const commands = buildCommands(project, root, cwd);
		for (const entry of commands) {
			exitCode = await (options.runCommand ?? runCommand)(entry, env);
			metadata.commands.push({ name: entry.name, exitCode });
			if (exitCode !== 0) break;
			verifyReport(entry, metadata.executedAt);
		}
		if (exitCode === 0) metadata.status = "success";
		return exitCode;
	} finally {
		metadata.finishedAt = new Date().toISOString();
		writeFileSync(join(output, "execution.json"), `${JSON.stringify(metadata, null, 2)}\n`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			process.stderr.write(`Package test launcher failed: ${error.message}\n`);
			process.exitCode = 1;
		});
}
