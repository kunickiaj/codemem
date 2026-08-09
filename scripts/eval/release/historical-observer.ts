import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, rm, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commitId, exactKeys, jsonObject, parseJson } from "./json-shape.js";
import { parseSanitizedSubjectIdentifier } from "./manifest.js";
import { isPathInside, isPathOutside, resolvePathWithinAllowedRoots } from "./path-safety.js";
import type {
	HistoricalObserverFailureV1,
	HistoricalObserverRequestV1,
	SanitizedSubjectIdentifier,
} from "./types.js";

const EXPLICIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OBSERVER_MODULE_PATH = "packages/core/src/ingest-prompts.ts";
const DRIVER_PATH = fileURLToPath(new URL("./historical-observer-driver.ts", import.meta.url));
const HISTORICAL_ENV_KEYS = [
	"COMSPEC",
	"HOME",
	"LANG",
	"LC_ALL",
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"TMPDIR",
	"TZ",
	"WINDIR",
] as const;

export interface CommandOptions {
	cwd: string;
	stdin?: string;
	env?: NodeJS.ProcessEnv;
}
export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}
export type CommandExecutor = (
	command: string,
	args: readonly string[],
	options: CommandOptions,
) => Promise<CommandResult>;

export interface HistoricalObserverSubjectSpec {
	label: string;
	requestedRef: string;
	observerContextSchemaVersion: 1;
	sanitizedSubject: SanitizedSubjectIdentifier;
}

export interface HistoricalObserverSubject extends HistoricalObserverSubjectSpec {
	productVersion: string;
	resolvedCommit: string;
	worktreePath: string;
	buildObserverPrompt(
		context: HistoricalObserverRequestV1["context"],
	): Promise<{ system: string; user: string }>;
}

export interface HistoricalObserverRunOptions {
	repositoryRoot: string;
	runRoot: string;
	runId: string;
	subjects: HistoricalObserverSubjectSpec[];
	retention?: "cleanup" | "keep-on-failure" | "keep";
	dependencies?: Partial<HistoricalObserverDependencies>;
}

interface HistoricalObserverDependencies {
	execute: CommandExecutor;
	withRepositoryLock<T>(repositoryCommonDirectory: string, action: () => Promise<T>): Promise<T>;
	nodeExecutable: string;
	driverPath: string;
}

export class HistoricalObserverError extends Error {
	cleanupError?: unknown;

	constructor(
		readonly code: string,
		message: string,
		readonly details: object,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "HistoricalObserverError";
	}
}

export function historicalProcessEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const key of HISTORICAL_ENV_KEYS) {
		const value = source[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}

export const executeCommand: CommandExecutor = async (command, args, options) =>
	await new Promise((resolveResult, reject) => {
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("error", reject);
		child.on("close", (exitCode) =>
			resolveResult({
				exitCode: exitCode ?? 1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			}),
		);
		child.stdin.end(options.stdin);
	});

async function defaultRepositoryLock<T>(
	commonDirectory: string,
	action: () => Promise<T>,
): Promise<T> {
	const lockPath = resolve(commonDirectory, "codemem-release-eval-worktrees.lock");
	const deadline = Date.now() + 30_000;
	while (true) {
		try {
			await mkdir(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
			await new Promise((resolveWait) => setTimeout(resolveWait, 25));
		}
	}
	try {
		return await action();
	} finally {
		await rmdir(lockPath);
	}
}

const DEFAULT_DEPENDENCIES: HistoricalObserverDependencies = {
	execute: executeCommand,
	withRepositoryLock: defaultRepositoryLock,
	nodeExecutable: process.execPath,
	driverPath: DRIVER_PATH,
};

function explicitRef(value: string): string {
	if (
		!EXPLICIT_REF_PATTERN.test(value) ||
		value === "HEAD" ||
		value === "@" ||
		value.includes("..") ||
		value.includes("//") ||
		value.endsWith("/") ||
		value.endsWith(".") ||
		value.endsWith(".lock")
	) {
		throw new HistoricalObserverError(
			"invalid_input",
			`Unsupported explicit subject ref: ${value}`,
			{ requestedRef: value },
		);
	}
	return value;
}

function safeSegment(value: string, field: string): string {
	if (!SAFE_SEGMENT_PATTERN.test(value) || value === "." || value === "..")
		throw new HistoricalObserverError("invalid_input", `${field} must be a safe path segment`, {});
	return value;
}

async function git(
	deps: HistoricalObserverDependencies,
	root: string,
	args: readonly string[],
	cwd = root,
): Promise<CommandResult> {
	return await deps.execute("git", args, {
		cwd,
		env: historicalProcessEnvironment(process.env),
	});
}

async function resolveCommit(
	deps: HistoricalObserverDependencies,
	root: string,
	subject: HistoricalObserverSubjectSpec,
): Promise<string> {
	const requestedRef = explicitRef(subject.requestedRef);
	const result = await git(deps, root, [
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${requestedRef}^{commit}`,
	]);
	const commit = result.stdout.trim();
	try {
		commitId(commit, "resolved subject commit");
	} catch {
		throw new HistoricalObserverError(
			"ref_resolution_failed",
			`Could not resolve subject ref: ${requestedRef}`,
			{ label: subject.label, requestedRef, stderr: result.stderr.trim() },
		);
	}
	if (result.exitCode !== 0)
		throw new HistoricalObserverError(
			"ref_resolution_failed",
			`Could not resolve subject ref: ${requestedRef}`,
			{ label: subject.label, requestedRef },
		);
	return commit;
}

function parseProtocolResponse(
	stdout: string,
	identity: Omit<HistoricalObserverSubject, "buildObserverPrompt">,
): { system: string; user: string } {
	let response: Record<string, unknown>;
	try {
		response = jsonObject(
			parseJson(stdout, "historical observer response"),
			"historical observer response",
		);
	} catch (error) {
		throw new HistoricalObserverError(
			"subject_protocol_failed",
			"Historical observer returned malformed JSON",
			identity,
			error,
		);
	}
	if (response.schema_version !== 1 || typeof response.ok !== "boolean")
		throw new HistoricalObserverError(
			"subject_protocol_failed",
			"Historical observer returned an unsupported protocol response",
			identity,
		);
	if (!response.ok) {
		exactKeys(response, ["schema_version", "ok", "error"], "historical observer response");
		const protocolError = jsonObject(response.error, "historical observer response.error");
		exactKeys(protocolError, ["code", "message"], "historical observer response.error");
		throw new HistoricalObserverError("subject_protocol_failed", String(protocolError.message), {
			...identity,
			protocolError: protocolError as HistoricalObserverFailureV1["error"],
		});
	}
	exactKeys(response, ["schema_version", "ok", "result"], "historical observer response");
	const result = jsonObject(response.result, "historical observer response.result");
	exactKeys(result, ["system", "user"], "historical observer response.result");
	if (typeof result.system !== "string" || typeof result.user !== "string")
		throw new HistoricalObserverError(
			"subject_protocol_failed",
			"Historical observer returned an invalid prompt result",
			identity,
		);
	return { system: result.system, user: result.user };
}

async function cleanup(
	deps: HistoricalObserverDependencies,
	root: string,
	commonDirectory: string,
	registered: string[],
): Promise<void> {
	await deps.withRepositoryLock(commonDirectory, async () => {
		let firstFailure: { path?: string; result: CommandResult } | undefined;
		for (const path of registered.toReversed()) {
			const result = await git(deps, root, ["worktree", "remove", "--force", path]);
			if (result.exitCode !== 0 && !firstFailure) firstFailure = { path, result };
		}
		const prune = await git(deps, root, ["worktree", "prune"]);
		if (prune.exitCode !== 0 && !firstFailure) firstFailure = { result: prune };
		if (firstFailure) {
			throw new HistoricalObserverError(
				"cleanup_failed",
				"Could not clean up a registered historical worktree",
				{
					worktreePath: firstFailure.path,
					stderr: firstFailure.result.stderr.trim(),
				},
			);
		}
	});
}

function registeredWorktreePaths(value: string): string[] {
	return value.split("\n").flatMap((line) => (line.startsWith("worktree ") ? [line.slice(9)] : []));
}

async function resetRunNamespace(
	deps: HistoricalObserverDependencies,
	repositoryRoot: string,
	commonDirectory: string,
	namespaceRoot: string,
): Promise<void> {
	await deps.withRepositoryLock(commonDirectory, async () => {
		const prune = await git(deps, repositoryRoot, ["worktree", "prune"]);
		if (prune.exitCode !== 0) {
			throw new HistoricalObserverError(
				"cleanup_failed",
				"Could not prune stale historical worktrees",
				{
					stderr: prune.stderr.trim(),
				},
			);
		}
		const listed = await git(deps, repositoryRoot, ["worktree", "list", "--porcelain"]);
		if (listed.exitCode !== 0) {
			throw new HistoricalObserverError("cleanup_failed", "Could not list historical worktrees", {
				stderr: listed.stderr.trim(),
			});
		}
		for (const path of registeredWorktreePaths(listed.stdout).filter((path) =>
			isPathInside(namespaceRoot, path),
		)) {
			const removed = await git(deps, repositoryRoot, ["worktree", "remove", "--force", path]);
			if (removed.exitCode !== 0) {
				throw new HistoricalObserverError(
					"cleanup_failed",
					"Could not remove stale historical worktree",
					{
						worktreePath: path,
						stderr: removed.stderr.trim(),
					},
				);
			}
		}
		await rm(namespaceRoot, { recursive: true, force: true });
		await mkdir(namespaceRoot, { recursive: true });
	});
}

function preserveCleanupError(original: unknown, cleanupError: unknown): void {
	if (original instanceof HistoricalObserverError) {
		original.cleanupError = cleanupError;
		return;
	}
	if (original instanceof Error) {
		Object.defineProperty(original, "cleanupError", { value: cleanupError, enumerable: false });
	}
}

export async function withHistoricalObserverSubjects<T>(
	options: HistoricalObserverRunOptions,
	action: (subjects: HistoricalObserverSubject[]) => Promise<T>,
): Promise<T> {
	const deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
	const repositoryRoot = await realpath(options.repositoryRoot);
	let runRoot: string;
	try {
		runRoot = await resolvePathWithinAllowedRoots(repositoryRoot, options.runRoot, [
			options.runRoot,
		]);
	} catch (error) {
		throw new HistoricalObserverError(
			"invalid_input",
			"runRoot must resolve inside the repository",
			{},
			error,
		);
	}
	const runId = safeSegment(options.runId, "runId");
	if (options.subjects.length === 0)
		throw new HistoricalObserverError(
			"invalid_input",
			"At least one historical observer subject is required",
			{},
		);
	if (options.subjects.some((subject) => subject.observerContextSchemaVersion !== 1))
		throw new HistoricalObserverError(
			"invalid_input",
			"observerContextSchemaVersion must be 1",
			{},
		);
	const labels = options.subjects.map((subject) => safeSegment(subject.label, "subject label"));
	if (new Set(labels).size !== labels.length)
		throw new HistoricalObserverError(
			"invalid_input",
			"Historical observer subject labels must be unique",
			{},
		);
	const sanitized = options.subjects.map((subject, index) =>
		parseSanitizedSubjectIdentifier(
			subject.sanitizedSubject,
			`historical observer subjects[${index}].sanitizedSubject`,
		),
	);
	if (new Set(sanitized.map((subject) => JSON.stringify(subject))).size !== sanitized.length)
		throw new HistoricalObserverError(
			"invalid_input",
			"Historical observer structured subjects must be unique",
			{},
		);
	const ignored = await git(deps, repositoryRoot, [
		"check-ignore",
		"--quiet",
		"--no-index",
		"--",
		runRoot,
	]);
	if (ignored.exitCode !== 0)
		throw new HistoricalObserverError(
			"invalid_input",
			"runRoot must be ignored by the subject repository",
			{},
		);
	const common = await git(deps, repositoryRoot, ["rev-parse", "--git-common-dir"]);
	if (common.exitCode !== 0)
		throw new HistoricalObserverError(
			"invalid_input",
			"repositoryRoot is not a Git repository",
			{},
		);
	const commonDirectory = await realpath(resolve(repositoryRoot, common.stdout.trim()));
	const namespaceRoot = resolve(runRoot, runId, "subjects");
	const driverPath = await realpath(deps.driverPath);
	await resetRunNamespace(deps, repositoryRoot, commonDirectory, namespaceRoot);
	const registered: string[] = [];
	let cleanupAttempted = false;
	try {
		const resolved = await Promise.all(
			options.subjects.map(async (spec) => ({
				spec,
				commit: await resolveCommit(deps, repositoryRoot, spec),
			})),
		);
		const subjects: HistoricalObserverSubject[] = [];
		for (const [index, item] of resolved.entries()) {
			const label = labels[index];
			if (!label)
				throw new HistoricalObserverError(
					"invalid_input",
					"Historical observer subject label is missing",
					{},
				);
			const sanitizedSubject = sanitized[index];
			if (!sanitizedSubject)
				throw new HistoricalObserverError(
					"invalid_input",
					"Historical observer subject identity is missing",
					{},
				);
			const worktreePath = resolve(namespaceRoot, `${label}-${item.commit.slice(0, 12)}`);
			if (!isPathOutside(worktreePath, driverPath))
				throw new HistoricalObserverError(
					"invalid_input",
					"driverPath must be outside the historical worktree",
					{},
				);
			await deps.withRepositoryLock(commonDirectory, async () => {
				const prune = await git(deps, repositoryRoot, ["worktree", "prune"]);
				if (prune.exitCode !== 0) {
					throw new HistoricalObserverError(
						"worktree_add_failed",
						"Could not prune before adding historical worktree",
						{
							stderr: prune.stderr.trim(),
						},
					);
				}
				const added = await git(deps, repositoryRoot, [
					"worktree",
					"add",
					"--detach",
					worktreePath,
					item.commit,
				]);
				if (added.exitCode !== 0)
					throw new HistoricalObserverError(
						"worktree_add_failed",
						`Could not create worktree for ${item.spec.label}`,
						{ stderr: added.stderr.trim() },
					);
				registered.push(worktreePath);
			});
			const head = await git(deps, repositoryRoot, ["rev-parse", "HEAD"], worktreePath);
			const status = await git(
				deps,
				repositoryRoot,
				["status", "--porcelain=v1", "--untracked-files=all"],
				worktreePath,
			);
			if (head.stdout.trim() !== item.commit || status.exitCode !== 0 || status.stdout.length !== 0)
				throw new HistoricalObserverError(
					"dirty_worktree",
					"Historical observer worktree is not clean",
					{ resolvedCommit: item.commit, worktreePath },
				);
			const packageValue = parseJson(
				await readFile(resolve(worktreePath, "packages/core/package.json"), "utf8"),
				"historical core package",
			);
			const productVersion = jsonObject(packageValue, "historical core package").version;
			if (typeof productVersion !== "string" || productVersion !== sanitizedSubject.version) {
				throw new HistoricalObserverError(
					"version_mismatch",
					"Historical subject version does not match its immutable commit",
					{
						resolvedCommit: item.commit,
						expectedVersion: sanitizedSubject.version,
						actualVersion: productVersion,
					},
				);
			}
			const identity = {
				...item.spec,
				sanitizedSubject,
				productVersion,
				resolvedCommit: item.commit,
				worktreePath,
			};
			subjects.push({
				...identity,
				buildObserverPrompt: async (context) => {
					const request: HistoricalObserverRequestV1 = {
						schema_version: 1,
						operation: "build_observer_prompt",
						observer_context_schema_version: 1,
						context,
					};
					const execution = await deps.execute(
						deps.nodeExecutable,
						[driverPath, resolve(worktreePath, OBSERVER_MODULE_PATH)],
						{
							cwd: worktreePath,
							env: historicalProcessEnvironment(process.env),
							stdin: `${JSON.stringify(request)}\n`,
						},
					);
					if (execution.exitCode !== 0)
						throw new HistoricalObserverError(
							"subject_protocol_failed",
							"Historical observer driver failed",
							{ ...identity, stderr: execution.stderr.trim() },
						);
					return parseProtocolResponse(execution.stdout, identity);
				},
			});
		}
		const result = await action(subjects);
		if (options.retention !== "keep") {
			cleanupAttempted = true;
			await cleanup(deps, repositoryRoot, commonDirectory, registered);
		}
		return result;
	} catch (error) {
		if (
			!cleanupAttempted &&
			options.retention !== "keep" &&
			options.retention !== "keep-on-failure" &&
			registered.length > 0
		) {
			try {
				await cleanup(deps, repositoryRoot, commonDirectory, registered);
			} catch (cleanupError) {
				preserveCleanupError(error, cleanupError);
			}
		}
		throw error;
	}
}
