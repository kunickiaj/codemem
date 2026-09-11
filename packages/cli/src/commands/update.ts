import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";
import {
	detectInstallKind,
	getUpdateStatus,
	type InstallKind,
	isExplicitUpdateInstallEligible,
	isReleaseVersionForChannel,
	resolveComparablePath,
	VERSION,
} from "@codemem/core";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import { addJsonOption, emitJsonError, type JsonOpts } from "../shared-options.js";

interface UpdateCheckOptions extends JsonOpts {
	refresh?: boolean;
}

interface UpdateInstallOptions extends JsonOpts {}

interface CommandResult {
	exitCode: number;
	outputExceeded: boolean;
	stdout: string;
	stderr: string;
}

interface ResolvedCommand {
	command: string;
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	windowsVerbatimArguments?: boolean;
}

interface ExplicitUpdatePlan {
	installKind: InstallKind;
	manualGuidance: string;
	runningEntryPath: string | null;
	targetVersion: string;
}

interface MiseToolState {
	active: boolean;
	installPath: string;
	requestedVersion: string | null;
	sourceIdentity: string;
	sourcePath: string;
	version: string | null;
}

interface MiseStateQuery {
	empty: boolean;
	state: MiseToolState | null;
}

interface CommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	maxOutputBytes?: number;
	windowsVerbatimArguments?: boolean;
}

const INSTALL_TIMEOUT_MS = 7 * 60 * 1_000;
const VERIFY_TIMEOUT_MS = 30_000;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const UPDATE_LOCK_FILE = "update-install.lock";
const UPDATE_COMMAND_MAX_OUTPUT_BYTES = 64 * 1_024;

class UpdateInstallLockedError extends Error {}

function commandStderr(outputExceeded: boolean, timedOut: boolean, stderr: string): string {
	if (outputExceeded) return "command output too large";
	if (timedOut) return "command timed out";
	return stderr;
}

function createOutputCapture(maxOutputBytes?: number) {
	let exceeded = false;
	let outputBytes = 0;
	let stderr = "";
	let stdout = "";
	return {
		append(stream: "stderr" | "stdout", chunk: string): void {
			if (exceeded) return;
			outputBytes += Buffer.byteLength(chunk);
			if (maxOutputBytes !== undefined && outputBytes > maxOutputBytes) {
				exceeded = true;
				return;
			}
			if (stream === "stderr") stderr += chunk;
			else stdout += chunk;
		},
		exceeded: () => exceeded,
		stderr: () => stderr,
		stdout: () => stdout,
	};
}

function terminateWindowsProcessTree(pid: number | undefined): boolean {
	if (process.platform !== "win32" || !pid) return false;
	const systemRoot = process.env.SystemRoot?.trim();
	if (!systemRoot || !isAbsolute(systemRoot)) return false;
	spawnSync(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
		stdio: "ignore",
		windowsHide: true,
	});
	return true;
}

function terminatePosixProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
	if (process.platform === "win32" || !pid) return false;
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}

function terminateCommand(child: ChildProcess, signal: NodeJS.Signals): void {
	if (terminateWindowsProcessTree(child.pid)) return;
	if (terminatePosixProcessGroup(child.pid, signal)) return;
	child.kill(signal);
}

function updateInstallLockPath(): string {
	return join(process.env.HOME?.trim() || homedir(), ".codemem", UPDATE_LOCK_FILE);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function removeStaleInstallLock(lockPath: string): Promise<boolean> {
	try {
		const [rawPid, lockStat] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
		const pid = Number.parseInt(rawPid.trim(), 10);
		if (Number.isSafeInteger(pid) && pid > 0) {
			if (isProcessAlive(pid)) return false;
		} else if (Date.now() - lockStat.mtimeMs <= INSTALL_TIMEOUT_MS + VERIFY_TIMEOUT_MS) {
			return false;
		}
		await unlink(lockPath);
		return true;
	} catch {
		return false;
	}
}

async function acquireInstallLock(): Promise<() => Promise<void>> {
	const lockPath = updateInstallLockPath();
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${process.pid}\n`, "utf8");
			return async () => {
				await handle.close().catch(() => undefined);
				await unlink(lockPath).catch(() => undefined);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (attempt > 0 || !(await removeStaleInstallLock(lockPath))) {
				throw new UpdateInstallLockedError(
					"another codemem update installation is already running",
				);
			}
		}
	}
	throw new UpdateInstallLockedError("another codemem update installation is already running");
}

function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
	options: CommandOptions = {},
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			detached: process.platform !== "win32",
			env: options.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsVerbatimArguments: options.windowsVerbatimArguments,
		});
		let settled = false;
		let timedOut = false;
		const output = createOutputCapture(options.maxOutputBytes);
		let timer: ReturnType<typeof setTimeout>;
		const finish = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const terminate = (signal: NodeJS.Signals) => terminateCommand(child, signal);
		timer = setTimeout(() => {
			timedOut = true;
			terminate("SIGTERM");
			setTimeout(() => terminate("SIGKILL"), 5_000).unref();
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output.append("stdout", chunk);
		});
		child.stderr.on("data", (chunk: string) => {
			output.append("stderr", chunk);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			if (!settled) reject(error);
		});
		child.once("close", (code) => {
			const stderr = commandStderr(output.exceeded(), timedOut, output.stderr());
			finish({
				exitCode: code ?? 1,
				outputExceeded: output.exceeded(),
				stdout: output.stdout(),
				stderr,
			});
		});
	});
}

async function resolveWindowsShim(name: "npm.cmd" | "codemem.cmd"): Promise<string> {
	const systemRoot = process.env.SystemRoot?.trim();
	if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows SystemRoot is unavailable");
	const result = await runCommand(join(systemRoot, "System32", "where.exe"), [name], 10_000, {
		cwd: join(systemRoot, "System32"),
		maxOutputBytes: UPDATE_COMMAND_MAX_OUTPUT_BYTES,
	});
	const shim = result.stdout
		.split(/\r?\n/)
		.map((value) => value.trim())
		.find((value) => isAbsolute(value));
	if (result.exitCode !== 0 || !shim) throw new Error(`unable to resolve ${name} from PATH`);
	return shim;
}

function windowsCommandLine(shim: string, args: string[]): string {
	return `""${shim}" ${args.join(" ")}"`;
}

async function resolveNpmInstallCommand(): Promise<{
	command: string;
	args: string[];
	cwd?: string;
}> {
	if (process.platform !== "win32") return { command: "npm", args: [] };
	const systemRoot = process.env.SystemRoot?.trim();
	if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows SystemRoot is unavailable");
	return {
		command: join(systemRoot, "System32", "cmd.exe"),
		args: ["/d", "/s", "/c", await resolveWindowsShim("npm.cmd")],
		cwd: join(systemRoot, "System32"),
	};
}

async function resolveVerificationCommand(): Promise<{
	command: string;
	args: string[];
	cwd?: string;
}> {
	if (process.platform !== "win32") return { command: "codemem", args: [] };
	const systemRoot = process.env.SystemRoot?.trim();
	if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows SystemRoot is unavailable");
	return {
		command: join(systemRoot, "System32", "cmd.exe"),
		args: ["/d", "/s", "/c", await resolveWindowsShim("codemem.cmd")],
		cwd: join(systemRoot, "System32"),
	};
}

function failInstall(options: UpdateInstallOptions, code: string, message: string): void {
	if (options.json) emitJsonError(code, message);
	else {
		console.error(message);
		process.exitCode = 1;
	}
}

function cacheQualifier(stale: boolean): string {
	return stale ? " (cached result)" : "";
}

function renderStatusWarning(error: string | null): string {
	return error ? ` Warning: ${error}` : "";
}

function renderHumanStatus(status: Awaited<ReturnType<typeof getUpdateStatus>>): string {
	const warning = renderStatusWarning(status.error);
	if (status.install_kind === "repo-dev") {
		return `Running from repository source (package metadata: ${status.current_version}). ${status.recommended_action}${warning}`;
	}
	if (status.update_available) {
		return `Update available${cacheQualifier(status.stale)}: ${status.current_version} → ${status.latest_version}. ${status.recommended_action}${warning}`;
	}
	if (!status.channel || !isReleaseVersionForChannel(status.current_version, status.channel)) {
		return `Unable to compare current version ${status.current_version} with ${status.latest_version}. ${status.recommended_action}${warning}`;
	}
	return `${status.current_version} is up to date${cacheQualifier(status.stale)}.${warning}`;
}

const checkCommand = addJsonOption(
	new Command("check").description("Check for a newer codemem release on the installed channel"),
)
	.addOption(new Option("-r, --refresh", "bypass the six-hour release cache"))
	.configureHelp(helpStyle)
	.action(async (options: UpdateCheckOptions) => {
		try {
			const installKind = detectInstallKind({
				entryPath: process.argv[1] ?? "",
				env: process.env,
			});
			const status = await getUpdateStatus({
				currentVersion: VERSION,
				installKind,
				refresh: options.refresh,
			});
			if (status.latest_version === null) {
				const message = status.error ?? "release status is unavailable";
				if (options.json) emitJsonError("update_check_unavailable", message);
				else {
					console.error(`Unable to check for updates: ${message}`);
					process.exitCode = 1;
				}
				return;
			}
			if (options.json) {
				console.log(JSON.stringify(status));
				return;
			}
			console.log(renderHumanStatus(status));
		} catch (error) {
			const message = error instanceof Error ? error.message : "release status is unavailable";
			if (options.json) emitJsonError("update_check_unavailable", message);
			else {
				console.error(`Unable to check for updates: ${message}`);
				process.exitCode = 1;
			}
		}
	});

function updateInstallArgs(npmArgs: string[], targetVersion: string): string[] {
	const installArgs = [
		"install",
		"-g",
		"--registry",
		PUBLIC_NPM_REGISTRY,
		`--@codemem:registry=${PUBLIC_NPM_REGISTRY}`,
		`codemem@${targetVersion}`,
		`@codemem/embeddings@${targetVersion}`,
	];
	if (process.platform !== "win32") return installArgs;
	return [...npmArgs.slice(0, 3), windowsCommandLine(npmArgs[3] ?? "", installArgs)];
}

function miseCommandEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	const protectedKeys = new Set(["npm_config_registry", "npm_config_@codemem:registry"]);
	if (process.platform === "linux") protectedKeys.add("onnxruntime_node_install");
	for (const key of Object.keys(env)) {
		if (protectedKeys.has(key.toLowerCase())) delete env[key];
	}
	env.npm_config_registry = PUBLIC_NPM_REGISTRY;
	env["npm_config_@codemem:registry"] = PUBLIC_NPM_REGISTRY;
	if (process.platform === "linux") env.ONNXRUNTIME_NODE_INSTALL = "skip";
	return env;
}

function miseGlobalCwd(): string {
	if (process.platform !== "win32") return "/";
	const systemRoot = process.env.SystemRoot?.trim();
	if (systemRoot) {
		const root = win32.parse(systemRoot).root;
		if (root) return root;
	}
	return process.env.HOME?.trim() || homedir();
}

async function resolveUpdateInstallCommand(
	installKind: InstallKind,
	targetVersion: string,
): Promise<ResolvedCommand> {
	if (installKind === "mise") {
		return {
			command: "mise",
			args: ["use", "-g", `npm:codemem@${targetVersion}`],
			cwd: miseGlobalCwd(),
			env: miseCommandEnvironment(),
		};
	}

	const npm = await resolveNpmInstallCommand();
	return {
		command: npm.command,
		args: updateInstallArgs(npm.args, targetVersion),
		cwd: npm.cwd,
		env:
			process.platform === "linux"
				? { ...process.env, ONNXRUNTIME_NODE_INSTALL: "skip" }
				: undefined,
		windowsVerbatimArguments: process.platform === "win32",
	};
}

function installLaunchErrorMessage(
	installKind: InstallKind,
	targetVersion: string,
	error: unknown,
): string {
	if (
		installKind === "mise" &&
		error instanceof Error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	) {
		return `mise was not found on PATH; install mise, then run mise use -g npm:codemem@${targetVersion}`;
	}
	return error instanceof Error ? error.message : "update installation failed";
}

function failedInstallMessage(installKind: InstallKind): string {
	return installKind === "mise" ? "mise installation failed" : "npm installation failed";
}

async function runUpdateInstallCommand(
	installKind: InstallKind,
	targetVersion: string,
): Promise<CommandResult> {
	const install = await resolveUpdateInstallCommand(installKind, targetVersion);
	try {
		return await runCommand(install.command, install.args, INSTALL_TIMEOUT_MS, {
			cwd: install.cwd,
			env: install.env,
			maxOutputBytes: UPDATE_COMMAND_MAX_OUTPUT_BYTES,
			windowsVerbatimArguments: install.windowsVerbatimArguments,
		});
	} catch (error) {
		throw new Error(installLaunchErrorMessage(installKind, targetVersion, error));
	}
}

function parseMiseSourcePath(source: unknown): string | null {
	if (!source || typeof source !== "object" || Array.isArray(source)) return null;
	const sourcePath = (source as Record<string, unknown>).path;
	return typeof sourcePath === "string" && sourcePath ? sourcePath : null;
}

function parseMiseStateRecord(record: unknown): MiseToolState | null {
	if (!record || typeof record !== "object" || Array.isArray(record)) return null;
	const candidate = record as Record<string, unknown>;
	const sourcePath = parseMiseSourcePath(candidate.source);
	const version = candidate.version;
	const requestedVersion = candidate.requested_version;
	if (
		typeof candidate.active !== "boolean" ||
		typeof candidate.install_path !== "string" ||
		!candidate.install_path ||
		(version !== undefined && (typeof version !== "string" || !version)) ||
		(requestedVersion !== undefined &&
			(typeof requestedVersion !== "string" || !requestedVersion)) ||
		(typeof version !== "string" && typeof requestedVersion !== "string") ||
		!sourcePath
	) {
		return null;
	}
	return {
		active: candidate.active,
		installPath: candidate.install_path,
		requestedVersion: typeof requestedVersion === "string" ? requestedVersion : null,
		sourceIdentity: resolveComparablePath(sourcePath),
		sourcePath,
		version: typeof version === "string" ? version : null,
	};
}

function parseMiseState(raw: string): MiseStateQuery | null {
	if (Buffer.byteLength(raw) > UPDATE_COMMAND_MAX_OUTPUT_BYTES) return null;
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!Array.isArray(payload)) return null;
	if (payload.length === 0) return { empty: true, state: null };
	if (payload.length !== 1) return null;
	const state = parseMiseStateRecord(payload[0]);
	return state ? { empty: false, state } : null;
}

async function readMiseState(
	args: string[],
	targetVersion: string,
	options: { cwd?: string } = {},
): Promise<MiseStateQuery | null> {
	try {
		const result = await runCommand("mise", args, VERIFY_TIMEOUT_MS, {
			cwd: options.cwd,
			env: miseCommandEnvironment(),
			maxOutputBytes: UPDATE_COMMAND_MAX_OUTPUT_BYTES,
		});
		if (result.exitCode !== 0 || result.outputExceeded) return null;
		return parseMiseState(result.stdout);
	} catch (error) {
		throw new Error(installLaunchErrorMessage("mise", targetVersion, error));
	}
}

function isPathWithin(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}/`);
}

function isPortableAbsolutePath(value: string): boolean {
	return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function isUserOwnedMiseSource(state: MiseToolState): boolean {
	if (!isPortableAbsolutePath(state.sourcePath)) return false;
	const sourcePath = resolveComparablePath(state.sourcePath);
	const homePath = resolveComparablePath(process.env.HOME?.trim() || homedir());
	if (homePath === "/" || /^[a-z]:$/i.test(homePath)) return false;
	return isPathWithin(sourcePath, homePath);
}

function isLegacyUserMiseSource(state: MiseToolState): boolean {
	if (!isUserOwnedMiseSource(state)) return false;
	const home = process.env.HOME?.trim() || homedir();
	const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
	return state.sourceIdentity === resolveComparablePath(join(configHome, "mise.toml"));
}

function miseStateOwnsEntry(state: MiseToolState, runningEntryPath: string | null): boolean {
	if (!runningEntryPath) return false;
	if (!isPortableAbsolutePath(state.installPath)) return false;
	const installPath = resolveComparablePath(state.installPath);
	const entryPath = resolveComparablePath(runningEntryPath);
	if (installPath === "/" || /^[a-z]:$/i.test(installPath)) return false;
	return entryPath === installPath || entryPath.startsWith(`${installPath}/`);
}

async function proveGlobalMiseOwnership(plan: ExplicitUpdatePlan): Promise<MiseToolState | null> {
	const activeQuery = await readMiseState(
		["ls", "npm:codemem", "--current", "--json"],
		plan.targetVersion,
	);
	const activeState = activeQuery?.state;
	if (!activeState?.active || !miseStateOwnsEntry(activeState, plan.runningEntryPath)) return null;
	const globalQuery = await readMiseState(
		["ls", "npm:codemem", "--global", "--json"],
		plan.targetVersion,
		{ cwd: miseGlobalCwd() },
	);
	if (globalQuery?.empty && isLegacyUserMiseSource(activeState)) return activeState;
	const globalState = globalQuery?.state;
	if (
		!globalState?.active ||
		activeState.sourceIdentity !== globalState.sourceIdentity ||
		!isUserOwnedMiseSource(globalState)
	)
		return null;
	return globalState;
}

async function resolveExplicitUpdatePlan(
	options: UpdateInstallOptions,
): Promise<ExplicitUpdatePlan | null> {
	const detectedInstallKind = detectInstallKind({
		entryPath: process.argv[1] ?? "",
		env: process.env,
	});
	const status = await getUpdateStatus({
		currentVersion: VERSION,
		installKind: detectedInstallKind,
		refresh: true,
	});
	if (!isExplicitUpdateInstallEligible(status) || !status.latest_version) {
		failInstall(options, "update_install_refused", status.recommended_action);
		return null;
	}
	if (!status.channel || !isReleaseVersionForChannel(status.latest_version, status.channel)) {
		failInstall(
			options,
			"update_install_refused",
			"release version does not match the installed channel",
		);
		return null;
	}
	return {
		installKind: status.install_kind,
		manualGuidance: status.recommended_action,
		runningEntryPath:
			detectedInstallKind === "mise" ? resolveRunningEntryPath(process.argv[1] ?? "") : null,
		targetVersion: status.latest_version,
	};
}

function resolveRunningEntryPath(entryPath: string): string {
	return resolveComparablePath(entryPath);
}

async function verifyMiseInstalledVersion(plan: ExplicitUpdatePlan): Promise<boolean> {
	const globalQuery = await readMiseState(
		["ls", "npm:codemem", "--global", "--json"],
		plan.targetVersion,
		{ cwd: miseGlobalCwd() },
	);
	const globalState = globalQuery?.state;
	if (
		!globalState?.active ||
		(globalState.version !== plan.targetVersion &&
			globalState.requestedVersion !== plan.targetVersion)
	) {
		return false;
	}
	const verification = await runCommand(
		"mise",
		["exec", "--", "codemem", "version"],
		VERIFY_TIMEOUT_MS,
		{
			cwd: miseGlobalCwd(),
			env: miseCommandEnvironment(),
			maxOutputBytes: UPDATE_COMMAND_MAX_OUTPUT_BYTES,
		},
	);
	return (
		!verification.outputExceeded &&
		verification.exitCode === 0 &&
		verification.stdout.trim() === plan.targetVersion
	);
}

async function verifyInstalledVersion(plan: ExplicitUpdatePlan): Promise<boolean> {
	if (plan.installKind === "mise") {
		return verifyMiseInstalledVersion(plan);
	}
	const codemem = await resolveVerificationCommand();
	const verificationArgs =
		process.platform === "win32"
			? [...codemem.args.slice(0, 3), windowsCommandLine(codemem.args[3] ?? "", ["version"])]
			: ["version"];
	const verification = await runCommand(codemem.command, verificationArgs, VERIFY_TIMEOUT_MS, {
		cwd: codemem.cwd,
		maxOutputBytes: UPDATE_COMMAND_MAX_OUTPUT_BYTES,
		windowsVerbatimArguments: process.platform === "win32",
	});
	return (
		!verification.outputExceeded &&
		verification.exitCode === 0 &&
		verification.stdout.trim() === plan.targetVersion
	);
}

function emitInstallSuccess(options: UpdateInstallOptions, targetVersion: string): void {
	const result = { previous_version: VERSION, installed_version: targetVersion };
	if (options.json) console.log(JSON.stringify(result));
	else console.log(`Updated codemem from ${VERSION} to ${targetVersion}.`);
}

async function executeExplicitUpdate(
	options: UpdateInstallOptions,
	plan: ExplicitUpdatePlan,
): Promise<void> {
	const globalMiseState = plan.installKind === "mise" ? await proveGlobalMiseOwnership(plan) : null;
	if (plan.installKind === "mise" && !globalMiseState) {
		failInstall(
			options,
			"update_install_refused",
			`Could not prove the active mise codemem installation is globally configured. ${plan.manualGuidance}`,
		);
		return;
	}
	const installation = await runUpdateInstallCommand(plan.installKind, plan.targetVersion);
	if (installation.exitCode !== 0) {
		failInstall(
			options,
			"update_install_failed",
			installation.stderr.trim() || failedInstallMessage(plan.installKind),
		);
		return;
	}
	if (!(await verifyInstalledVersion(plan))) {
		const message =
			plan.installKind === "mise"
				? "mise updated global configuration, but installed version verification failed; inspect the global mise codemem state before retrying"
				: "installed version verification failed";
		failInstall(options, "update_verification_failed", message);
		return;
	}
	emitInstallSuccess(options, plan.targetVersion);
}

async function installUpdate(options: UpdateInstallOptions): Promise<void> {
	let releaseInstallLock: (() => Promise<void>) | null = null;
	try {
		const plan = await resolveExplicitUpdatePlan(options);
		if (!plan) return;
		releaseInstallLock = await acquireInstallLock();
		await executeExplicitUpdate(options, plan);
	} catch (error) {
		failInstall(
			options,
			error instanceof UpdateInstallLockedError ? "update_install_locked" : "update_install_failed",
			error instanceof Error ? error.message : "update installation failed",
		);
	} finally {
		await releaseInstallLock?.();
	}
}

const installCommand = addJsonOption(
	new Command("install").description("Install an eligible codemem update on the installed channel"),
)
	.configureHelp(helpStyle)
	.action(installUpdate);

export const updateCommand = new Command("update")
	.description("Inspect and manage codemem updates")
	.enablePositionalOptions()
	.configureHelp(helpStyle)
	.addCommand(checkCommand)
	.addCommand(installCommand);
