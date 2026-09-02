import { spawn, spawnSync } from "node:child_process";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { detectInstallKind, getUpdateStatus, isStableReleaseVersion, VERSION } from "@codemem/core";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import { addJsonOption, emitJsonError, type JsonOpts } from "../shared-options.js";

interface UpdateCheckOptions extends JsonOpts {
	refresh?: boolean;
}

interface UpdateInstallOptions extends JsonOpts {}

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const INSTALL_TIMEOUT_MS = 7 * 60 * 1_000;
const VERIFY_TIMEOUT_MS = 30_000;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const UPDATE_LOCK_FILE = "update-install.lock";

class UpdateInstallLockedError extends Error {}

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
	options: { cwd?: string; windowsVerbatimArguments?: boolean } = {},
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsVerbatimArguments: options.windowsVerbatimArguments,
		});
		let settled = false;
		let timedOut = false;
		let stdout = "";
		let stderr = "";
		let timer: ReturnType<typeof setTimeout>;
		const finish = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const terminate = (signal: NodeJS.Signals) => {
			if (process.platform === "win32" && child.pid) {
				const systemRoot = process.env.SystemRoot?.trim();
				if (systemRoot && isAbsolute(systemRoot)) {
					spawnSync(
						join(systemRoot, "System32", "taskkill.exe"),
						["/PID", String(child.pid), "/T", "/F"],
						{
							stdio: "ignore",
							windowsHide: true,
						},
					);
					return;
				}
			}
			if (process.platform !== "win32" && child.pid) {
				try {
					process.kill(-child.pid, signal);
					return;
				} catch {
					// Fall back to terminating the direct child.
				}
			}
			child.kill(signal);
		};
		timer = setTimeout(() => {
			timedOut = true;
			terminate("SIGTERM");
			setTimeout(() => terminate("SIGKILL"), 5_000).unref();
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			if (!settled) reject(error);
		});
		child.once("close", (code) =>
			finish({ exitCode: code ?? 1, stdout, stderr: timedOut ? "command timed out" : stderr }),
		);
	});
}

async function resolveWindowsShim(name: "npm.cmd" | "codemem.cmd"): Promise<string> {
	const systemRoot = process.env.SystemRoot?.trim();
	if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows SystemRoot is unavailable");
	const result = await runCommand(join(systemRoot, "System32", "where.exe"), [name], 10_000, {
		cwd: join(systemRoot, "System32"),
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

async function resolveInstallCommand(): Promise<{ command: string; args: string[]; cwd?: string }> {
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
	if (status.update_available) {
		return `Update available${cacheQualifier(status.stale)}: ${status.current_version} → ${status.latest_version}. ${status.recommended_action}${warning}`;
	}
	if (!isStableReleaseVersion(status.current_version)) {
		return `Unable to compare current version ${status.current_version} with ${status.latest_version}. ${status.recommended_action}${warning}`;
	}
	return `${status.current_version} is up to date${cacheQualifier(status.stale)}.${warning}`;
}

const checkCommand = addJsonOption(
	new Command("check").description("Check for a newer stable codemem release"),
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

async function installUpdate(options: UpdateInstallOptions): Promise<void> {
	let releaseInstallLock: (() => Promise<void>) | null = null;
	try {
		const installKind = detectInstallKind({
			entryPath: process.argv[1] ?? "",
			env: process.env,
		});
		const status = await getUpdateStatus({
			currentVersion: VERSION,
			installKind,
			refresh: true,
		});
		if (!status.auto_update_eligible || !status.latest_version) {
			failInstall(options, "update_install_refused", status.recommended_action);
			return;
		}

		const targetVersion = status.latest_version;
		if (!isStableReleaseVersion(targetVersion)) {
			failInstall(
				options,
				"update_install_refused",
				"release version is not a stable semantic version",
			);
			return;
		}
		releaseInstallLock = await acquireInstallLock();
		const npm = await resolveInstallCommand();
		const installation = await runCommand(
			npm.command,
			process.platform === "win32"
				? [
						...npm.args.slice(0, 3),
						windowsCommandLine(npm.args[3] ?? "", [
							"install",
							"-g",
							"--registry",
							PUBLIC_NPM_REGISTRY,
							`codemem@${targetVersion}`,
							`@codemem/embeddings@${targetVersion}`,
						]),
					]
				: [
						"install",
						"-g",
						"--registry",
						PUBLIC_NPM_REGISTRY,
						`codemem@${targetVersion}`,
						`@codemem/embeddings@${targetVersion}`,
					],
			INSTALL_TIMEOUT_MS,
			{ cwd: npm.cwd, windowsVerbatimArguments: process.platform === "win32" },
		);
		if (installation.exitCode !== 0) {
			failInstall(
				options,
				"update_install_failed",
				installation.stderr.trim() || "npm installation failed",
			);
			return;
		}

		const codemem = await resolveVerificationCommand();
		const verification = await runCommand(
			codemem.command,
			process.platform === "win32"
				? [...codemem.args.slice(0, 3), windowsCommandLine(codemem.args[3] ?? "", ["version"])]
				: ["version"],
			VERIFY_TIMEOUT_MS,
			{ cwd: codemem.cwd, windowsVerbatimArguments: process.platform === "win32" },
		);
		if (verification.exitCode !== 0 || verification.stdout.trim() !== targetVersion) {
			failInstall(options, "update_verification_failed", "installed version verification failed");
			return;
		}

		const result = { previous_version: VERSION, installed_version: targetVersion };
		if (options.json) console.log(JSON.stringify(result));
		else console.log(`Updated codemem from ${VERSION} to ${targetVersion}.`);
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
	new Command("install").description("Install an eligible stable codemem update"),
)
	.configureHelp(helpStyle)
	.action(installUpdate);

export const updateCommand = new Command("update")
	.description("Inspect and manage codemem updates")
	.enablePositionalOptions()
	.configureHelp(helpStyle)
	.addCommand(checkCommand)
	.addCommand(installCommand);
