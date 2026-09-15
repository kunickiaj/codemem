import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ChangedPath, compareBiomeReports, compareBiomeToolPolicy } from "./biome-ratchet.js";
import { formatDiagnostic } from "./lint-diagnostics.js";

const HUMAN_DIAGNOSTIC_LIMIT = 10;
const GITHUB_ANNOTATION_LIMIT = 10;

export function resolveRootBiomeEntrypoint(root: string): string {
	return createRequire(path.join(root, "package.json")).resolve("@biomejs/biome/bin/biome");
}

export interface CliOptions {
	base: string;
	head?: string;
	json: boolean;
	githubAnnotations?: boolean;
}

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface Snapshot {
	directory: string;
	commit: string;
}

const BOOLEAN_FLAGS = new Map<string, "json" | "githubAnnotations">([
	["--json", "json"],
	["--github-annotations", "githubAnnotations"],
]);

function referenceOption(argument: string, value: string): Partial<CliOptions> {
	return argument === "--base" ? { base: value } : { head: value };
}

export function parseArguments(argv: string[]): CliOptions {
	const options: Partial<CliOptions> = { json: false, githubAnnotations: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index] ?? "";
		if (argument === "--") continue;
		const booleanFlag = BOOLEAN_FLAGS.get(argument);
		if (booleanFlag) {
			options[booleanFlag] = true;
			continue;
		}
		if (argument !== "--base" && argument !== "--head") {
			throw new Error(`Unknown argument: ${argument}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		Object.assign(options, referenceOption(argument, value));
		index += 1;
	}
	if (!options.base) throw new Error("--base is required");
	return options as CliOptions;
}

export function runCommand(
	executable: string,
	args: string[],
	options: {
		cwd: string;
		allowedExitCodes?: number[];
		env?: NodeJS.ProcessEnv;
		stdin?: string;
	},
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.stdin.end(options.stdin);
		child.once("error", reject);
		child.once("close", (code, signal) => {
			const result = {
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				exitCode: code ?? -1,
			};
			if (signal || !options.allowedExitCodes?.includes(result.exitCode)) {
				reject(
					new Error(
						`${path.basename(executable)} failed${signal ? ` with ${signal}` : ` (${result.exitCode})`}: ${result.stderr.trim()}`,
					),
				);
				return;
			}
			resolve(result);
		});
	});
}

async function git(root: string, args: string[], allowedExitCodes = [0]): Promise<string> {
	return (await runCommand("git", args, { cwd: root, allowedExitCodes })).stdout;
}

async function gitWithOptions(
	root: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv; stdin?: string },
): Promise<string> {
	return (
		await runCommand("git", args, {
			cwd: root,
			allowedExitCodes: [0],
			...options,
		})
	).stdout;
}

async function resolveCommit(root: string, reference: string): Promise<string> {
	const output = await git(root, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${reference}^{commit}`,
	]);
	const commit = output.trim();
	if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error(`Invalid git commit: ${reference}`);
	return commit;
}

async function addSnapshot(
	root: string,
	parent: string,
	name: string,
	commit: string,
): Promise<Snapshot> {
	const directory = path.join(parent, name);
	await git(root, ["worktree", "add", "--detach", directory, commit]);
	return { directory, commit };
}

function zeroSeparated(output: string): string[] {
	const values = output.split("\0");
	if (values.at(-1) === "") values.pop();
	return values;
}

function singlePathChange(status: string, changedPath: string): ChangedPath {
	if (status === "A") return { status: "added", afterPath: changedPath };
	if (status === "D") return { status: "deleted", beforePath: changedPath };
	return { status: "modified", beforePath: changedPath, afterPath: changedPath };
}

async function captureWorkingTreeCommit(root: string, temporaryRoot: string): Promise<string> {
	const indexPath = path.join(temporaryRoot, "working-tree.index");
	const env = { ...process.env, GIT_INDEX_FILE: indexPath };
	await gitWithOptions(root, ["read-tree", "HEAD"], { env });
	const paths = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	await gitWithOptions(root, ["update-index", "-z", "--add", "--remove", "--stdin"], {
		env,
		stdin: paths,
	});
	const tree = (await gitWithOptions(root, ["write-tree"], { env })).trim();
	const commitEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "codemem Biome ratchet",
		GIT_AUTHOR_EMAIL: "biome-ratchet@example.invalid",
		GIT_COMMITTER_NAME: "codemem Biome ratchet",
		GIT_COMMITTER_EMAIL: "biome-ratchet@example.invalid",
	};
	return (
		await gitWithOptions(
			root,
			["commit-tree", tree, "-p", "HEAD", "-m", "Biome ratchet snapshot"],
			{
				env: commitEnv,
			},
		)
	).trim();
}

export function parseNameStatus(output: string): ChangedPath[] {
	const values = zeroSeparated(output);
	const changes: ChangedPath[] = [];
	for (let index = 0; index < values.length; ) {
		const status = values[index++];
		if (!status) throw new Error("Git returned malformed name-status output");
		if (status.startsWith("R") || status.startsWith("C")) {
			const beforePath = values[index++];
			const afterPath = values[index++];
			if (!beforePath || !afterPath) throw new Error("Git returned an incomplete rename");
			changes.push({ status: "renamed", beforePath, afterPath });
			continue;
		}
		const changedPath = values[index++];
		if (!changedPath) throw new Error("Git returned an incomplete changed path");
		changes.push(singlePathChange(status, changedPath));
	}
	return changes;
}

async function listChanges(root: string, base: string, head?: string): Promise<ChangedPath[]> {
	const args = ["diff", "--name-status", "-z", "-M", base];
	if (head) args.push(head);
	args.push("--");
	const changes = parseNameStatus(await git(root, args));
	if (head) return changes;
	const knownAfterPaths = new Set(
		changes.flatMap((change) => (change.afterPath ? [change.afterPath] : [])),
	);
	const untracked = zeroSeparated(
		await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
	);
	for (const untrackedPath of untracked) {
		if (!knownAfterPaths.has(untrackedPath)) {
			changes.push({ status: "added", afterPath: untrackedPath });
		}
	}
	return changes;
}

async function optionalFile(filePath: string): Promise<string | undefined> {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		if (
			typeof error !== "object" ||
			error === null ||
			!("code" in error) ||
			error.code !== "ENOENT"
		) {
			throw error;
		}
		return undefined;
	}
}

async function addSources(
	changes: ChangedPath[],
	baseDirectory: string,
	headDirectory: string,
): Promise<ChangedPath[]> {
	return Promise.all(
		changes.map(async (change) => ({
			...change,
			beforeSource: change.beforePath
				? await optionalFile(path.join(baseDirectory, change.beforePath))
				: undefined,
			afterSource: change.afterPath
				? await optionalFile(path.join(headDirectory, change.afterPath))
				: undefined,
		})),
	);
}

async function applyHeadIgnorePolicy(
	changes: ChangedPath[],
	baseDirectory: string,
	headDirectory: string,
): Promise<void> {
	for (const change of changes) {
		if (
			change.beforePath &&
			isIgnorePath(change.beforePath) &&
			change.beforePath !== change.afterPath
		) {
			await rm(path.join(baseDirectory, change.beforePath), { force: true });
		}
		if (!change.afterPath || !isIgnorePath(change.afterPath)) continue;
		const basePath = path.join(baseDirectory, change.afterPath);
		await mkdir(path.dirname(basePath), { recursive: true });
		await copyFile(path.join(headDirectory, change.afterPath), basePath);
	}
}

function isIgnorePath(filePath: string): boolean {
	return filePath.endsWith(".gitignore") || filePath.endsWith(".ignore");
}

async function runBiome(directory: string, entrypoint: string): Promise<string> {
	const result = await runCommand(
		process.execPath,
		[entrypoint, "lint", "--reporter=json", "--max-diagnostics=none", "."],
		{
			cwd: directory,
			allowedExitCodes: [0, 1],
		},
	);
	return result.stdout;
}

async function removeSnapshot(root: string, snapshot: Snapshot | undefined): Promise<void> {
	if (!snapshot) return;
	try {
		await git(root, ["worktree", "remove", "--force", snapshot.directory]);
	} catch {
		await rm(snapshot.directory, { recursive: true, force: true });
		await git(root, ["worktree", "prune"]);
	}
}

export function formatHumanResult(result: Awaited<ReturnType<typeof runRatchet>>): string {
	if (result.regressions.length === 0 && result.policyViolations.length === 0) {
		return `Biome ratchet passed (${result.changedFiles} changed files, ${result.headDiagnosticCount} head diagnostics).`;
	}
	const policy = result.policyViolations.map(
		(violation) => `- ${violation.path ? `${violation.path} — ` : ""}${violation.message}`,
	);
	const diagnostics = result.regressions.slice(0, HUMAN_DIAGNOSTIC_LIMIT).map(formatDiagnostic);
	const hidden = result.regressions.length - diagnostics.length;
	if (hidden > 0) diagnostics.push(`- …and ${hidden} more regression${hidden === 1 ? "" : "s"}.`);
	return ["Biome ratchet failed.", ...policy, ...diagnostics].join("\n");
}

function escapeWorkflowData(value: string): string {
	return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeWorkflowProperty(value: string): string {
	return escapeWorkflowData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function workflowError(
	message: string,
	options: { title: string; path?: string; line?: number },
): string {
	const properties = [`title=${escapeWorkflowProperty(options.title)}`];
	if (options.path) properties.push(`file=${escapeWorkflowProperty(options.path)}`);
	if (options.line) properties.push(`line=${options.line}`);
	return `::error ${properties.join(",")}::${escapeWorkflowData(message)}`;
}

export function formatGithubAnnotations(result: Awaited<ReturnType<typeof runRatchet>>): string {
	const policy = result.policyViolations.map((violation) => ({
		message: violation.message,
		title: "Biome policy regression",
		path: violation.path,
		line: undefined,
	}));
	const diagnostics = result.regressions.map((diagnostic) => ({
		message: diagnostic.description,
		title: diagnostic.category,
		path: diagnostic.path,
		line: diagnostic.line,
	}));
	const findings = [...policy, ...diagnostics];
	const visibleLimit =
		findings.length > GITHUB_ANNOTATION_LIMIT
			? GITHUB_ANNOTATION_LIMIT - 1
			: GITHUB_ANNOTATION_LIMIT;
	const annotations = findings.slice(0, visibleLimit).map((finding) =>
		workflowError(finding.message, {
			title: finding.title,
			path: finding.path,
			line: finding.line,
		}),
	);
	const hidden = findings.length - annotations.length;
	if (hidden > 0) {
		annotations.push(
			workflowError(`${hidden} additional Biome findings are available in the JSON artifact.`, {
				title: "Biome delta findings",
			}),
		);
	}
	return annotations.join("\n");
}

function emitGithubAnnotations(
	enabled: boolean | undefined,
	result: Awaited<ReturnType<typeof runRatchet>>,
): void {
	if (!enabled) return;
	const annotations = formatGithubAnnotations(result);
	if (annotations) process.stderr.write(`${annotations}\n`);
}

function emitGithubFailure(enabled: boolean, message: string): void {
	if (!enabled) return;
	process.stderr.write(
		`${workflowError(message, { title: "Biome delta could not compare snapshots" })}\n`,
	);
}

async function loadSnapshotInputs(root: string, baseSnapshot: Snapshot, headSnapshot: Snapshot) {
	const baseConfigPath = path.join(baseSnapshot.directory, "biome.json");
	const headConfigPath = path.join(headSnapshot.directory, "biome.json");
	const [baseConfigText, headConfigText, baseLockfile, headLockfile, changes] = await Promise.all([
		readFile(baseConfigPath, "utf8"),
		readFile(headConfigPath, "utf8"),
		optionalFile(path.join(baseSnapshot.directory, "pnpm-lock.yaml")),
		optionalFile(path.join(headSnapshot.directory, "pnpm-lock.yaml")),
		listChanges(root, baseSnapshot.commit, headSnapshot.commit),
	]);
	const changesWithSources = await addSources(
		changes,
		baseSnapshot.directory,
		headSnapshot.directory,
	);
	return {
		baseConfigPath,
		headConfigPath,
		baseConfigText,
		headConfigText,
		baseLockfile,
		headLockfile,
		changes,
		changesWithSources,
	};
}

export async function runRatchet(
	options: CliOptions,
	dependencies: {
		cwd?: string;
		biomeEntrypoint?: string;
		afterSnapshot?: () => Promise<void> | void;
	} = {},
) {
	const cwd = dependencies.cwd ?? process.cwd();
	const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
	const entrypoint = dependencies.biomeEntrypoint ?? resolveRootBiomeEntrypoint(root);
	const baseCommit = await resolveCommit(root, options.base);
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), "codemem-biome-ratchet-"));
	let baseSnapshot: Snapshot | undefined;
	let headSnapshot: Snapshot | undefined;
	try {
		const headCommit = options.head
			? await resolveCommit(root, options.head)
			: await captureWorkingTreeCommit(root, temporaryRoot);
		baseSnapshot = await addSnapshot(root, temporaryRoot, "base", baseCommit);
		headSnapshot = await addSnapshot(root, temporaryRoot, "head", headCommit);
		await dependencies.afterSnapshot?.();

		const {
			baseConfigPath,
			headConfigPath,
			baseConfigText,
			headConfigText,
			baseLockfile,
			headLockfile,
			changes,
			changesWithSources,
		} = await loadSnapshotInputs(root, baseSnapshot, headSnapshot);
		await copyFile(headConfigPath, baseConfigPath);
		await applyHeadIgnorePolicy(changes, baseSnapshot.directory, headSnapshot.directory);
		const [baseOutput, headOutput] = await Promise.all([
			runBiome(baseSnapshot.directory, entrypoint),
			runBiome(headSnapshot.directory, entrypoint),
		]);
		const comparison = compareBiomeReports({
			baseOutput,
			headOutput,
			baseConfigText,
			headConfigText,
			changes: changesWithSources,
		});
		comparison.policyViolations.push(
			...compareBiomeToolPolicy(baseLockfile, headLockfile, changesWithSources),
		);
		return {
			mode: options.head ? "refs" : "working-tree",
			base: baseCommit,
			head: options.head ? headCommit : null,
			changedFiles: changes.length,
			...comparison,
		};
	} finally {
		await removeSnapshot(root, headSnapshot);
		await removeSnapshot(root, baseSnapshot);
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	let options: CliOptions | undefined;
	try {
		options = parseArguments(argv);
		const result = await runRatchet(options);
		emitGithubAnnotations(options.githubAnnotations, result);
		process.stdout.write(
			options.json ? `${JSON.stringify(result)}\n` : `${formatHumanResult(result)}\n`,
		);
		return result.regressions.length > 0 || result.policyViolations.length > 0 ? 1 : 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		emitGithubFailure(
			Boolean(options?.githubAnnotations || argv.includes("--github-annotations")),
			message,
		);
		if (options?.json || argv.includes("--json")) {
			process.stdout.write(`${JSON.stringify({ error: message })}\n`);
		} else {
			process.stderr.write(`Biome ratchet could not compare snapshots: ${message}\n`);
		}
		return 2;
	}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) process.exitCode = await main();
