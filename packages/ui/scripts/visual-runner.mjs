import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	IMAGE,
	isPublicSource,
	parseMode,
	selectSourcePaths,
	validateGeneratedGoldens,
} from "./visual-policy.mjs";

const root = resolve(import.meta.dirname, "../../..");
const mode = parseMode(process.argv.slice(2), process.env.CI);
const { packageManager } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager))
	throw new Error("Expected an exact pnpm packageManager pin.");

/** @param {string} command @param {string[]} args @param {Omit<import('node:child_process').SpawnSyncOptionsWithStringEncoding, 'encoding'>} options */
function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		stdio: "inherit",
		...options,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	return result;
}

/** @param {string} path @param {string} target */
function copySource(path, target) {
	if (!isPublicSource(path)) return;
	const source = join(root, path);
	if (!existsSync(source)) return;
	if (!lstatSync(source).isFile()) throw new Error(`Refusing non-regular source: ${path}`);
	const destination = join(target, path);
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(source, destination);
}

// Each invocation owns a fresh ignored directory; nothing deletes existing user files.
const parent = join(root, ".tmp/visual");
mkdirSync(parent, { recursive: true });
const workspace = mkdtempSync(join(parent, "run-"));
const input = join(workspace, "input");
const results = join(workspace, "results");
mkdirSync(input);
mkdirSync(results);
const tracked = run("git", ["ls-files", "-z"], { stdio: "pipe" });
if (tracked.status !== 0 || typeof tracked.stdout !== "string")
	throw new Error("Cannot list tracked public sources.");
for (const path of selectSourcePaths(tracked.stdout.split("\0").filter(Boolean)))
	copySource(path, input);

const config = mode === "--control" ? "playwright.control.config.ts" : "playwright.config.ts";
const command = [
	"cp -R /input/. /work/",
	`npm install --global ${packageManager}`,
	"cd /work && HUSKY=0 pnpm install --frozen-lockfile",
	`cd /work/packages/ui && pnpm exec playwright test --config ${config}`,
].join(" && ");
const args = [
	"run",
	"--rm",
	"--init",
	"--platform",
	"linux/amd64",
	"--shm-size=1g",
	"--mount",
	`type=bind,src=${input},dst=/input,readonly`,
	"--mount",
	`type=bind,src=${results},dst=/results`,
	"--tmpfs",
	"/work:exec,size=4g",
	"--workdir",
	"/work",
	"--env",
	"CODEMEM_VISUAL_OUTPUT=/results",
	"--env",
	"PLAYWRIGHT_HTML_OPEN=never",
];
if (process.env.CI) args.push("--env", "CI=1");
if (mode === "--update") args.push("--env", "CODEMEM_VISUAL_UPDATE=1");
args.push(
	IMAGE,
	"sh",
	"-c",
	`${command}; status=$?; if [ -d /work/packages/ui/visual/__screenshots__ ]; then cp -R /work/packages/ui/visual/__screenshots__ /results/goldens; fi; exit "$status"`,
);
console.log(`Visual artifacts: ${results}`);
const result = run("docker", args);

/** @param {string} source @param {string} prefix @returns {string[]} */
function listGoldens(source, prefix = "") {
	const paths = [];
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const from = join(source, entry.name);
		const path = `${prefix}${entry.name}`;
		if (entry.isDirectory()) {
			paths.push(...listGoldens(from, `${path}/`));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".png"))
			throw new Error("Only PNG goldens can be copied.");
		paths.push(path);
	}
	return paths;
}
if (mode === "--update" && result.status === 0) {
	const source = join(results, "goldens");
	const paths = validateGeneratedGoldens(listGoldens(source));
	for (const path of paths) {
		const destination = join(root, "packages/ui/visual/__screenshots__", path);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(join(source, path), destination);
	}
}
process.exitCode = result.status ?? 1;
