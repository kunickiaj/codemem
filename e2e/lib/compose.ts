import { spawnSync } from "node:child_process";
import { type CommandRecord, writeCommandArtifact } from "./artifacts.js";
import { quoteShellArgument, viewerLogReadScript } from "./viewer-logs.js";

const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const RESOURCE_INSPECTION_TIMEOUT_MS = 30_000;
const SERVICE_OPERATION_TIMEOUT_MS = 180_000;
const SERVICE_STOP_GRACE_SECONDS = "30";

export interface RunCommandOptions {
	artifactsDir: string;
	artifactName: string;
	cwd?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	allowFailure?: boolean;
}

export interface RunCommandResult extends CommandRecord {}

type CommandTiming = Pick<CommandRecord, "status" | "durationMs">;

export interface ComposeCommandTiming extends CommandTiming {
	artifactName: string;
}

export interface ComposeTimingSummary {
	count: number;
	/** Sum of command durations only; excludes waitFor sleeps and other scenario work. */
	totalCommandMs: number;
	slowest: ComposeCommandTiming[];
}

class CommandFailure extends Error {
	readonly timing: CommandTiming;

	constructor(record: RunCommandResult) {
		super(`Command failed: ${record.command}\n${record.stderr || record.stdout}`);
		this.timing = { status: record.status, durationMs: record.durationMs };
	}
}

function stringifyCommand(command: string, args: string[]): string {
	return [command, ...args].join(" ");
}

export function runCommand(
	command: string,
	args: string[],
	options: RunCommandOptions,
): RunCommandResult {
	const startedAt = Date.now();
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		encoding: "utf8",
		timeout: options.timeoutMs ?? 120_000,
		maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
	});
	const record: RunCommandResult = {
		command: stringifyCommand(command, args),
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		durationMs: Date.now() - startedAt,
	};
	writeCommandArtifact(options.artifactsDir, options.artifactName, record);
	if (!options.allowFailure && record.status !== 0) {
		throw new CommandFailure(record);
	}
	return record;
}

export interface ComposeManagerOptions {
	composeFile?: string;
	composeFiles?: readonly string[];
	profiles?: readonly string[];
	artifactsDir: string;
	projectName: string;
}

export class ComposeManager {
	private readonly composeFiles: readonly string[];
	private readonly profiles: readonly string[];
	private readonly commandTimings: ComposeCommandTiming[] = [];
	private readonly detachedLogs: Array<{ service: string; artifactName: string; path: string }> =
		[];

	constructor(
		private readonly options: ComposeManagerOptions,
		private readonly commandRunner: typeof runCommand = runCommand,
	) {
		this.composeFiles = [
			...(options.composeFiles ?? (options.composeFile ? [options.composeFile] : [])),
		];
		this.profiles = [...(options.profiles ?? [])];
		if (this.composeFiles.length === 0) {
			throw new Error("ComposeManager requires composeFile or at least one composeFiles entry");
		}
	}

	getTimingSummary(): ComposeTimingSummary {
		return {
			count: this.commandTimings.length,
			totalCommandMs: this.commandTimings.reduce((total, timing) => total + timing.durationMs, 0),
			slowest: this.commandTimings
				.map((timing) => ({ ...timing }))
				.sort((a, b) => b.durationMs - a.durationMs)
				.slice(0, 10),
		};
	}

	private run(command: string, args: string[], options: RunCommandOptions): RunCommandResult {
		try {
			const result = this.commandRunner(command, args, options);
			this.commandTimings.push({
				artifactName: options.artifactName,
				status: result.status,
				durationMs: result.durationMs,
			});
			return result;
		} catch (error) {
			if (error instanceof CommandFailure) {
				this.commandTimings.push({ artifactName: options.artifactName, ...error.timing });
			}
			throw error;
		}
	}

	private composeArgs(args: string[]): string[] {
		return [
			"compose",
			...this.composeFiles.flatMap((composeFile) => ["-f", composeFile]),
			"-p",
			this.options.projectName,
			...this.profiles.flatMap((profile) => ["--profile", profile]),
			...args,
		];
	}

	private serviceOperation(args: string[], artifactName: string): RunCommandResult {
		return this.run("docker", this.composeArgs(args), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs: SERVICE_OPERATION_TIMEOUT_MS,
		});
	}

	up(services: string[], artifactName: string): RunCommandResult {
		const args = [
			"up",
			"-d",
			...(process.env.CODEMEM_E2E_BUILD === "1" ? ["--build"] : []),
			...services,
		];
		return this.run("docker", this.composeArgs(args), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs: 600_000,
		});
	}

	down(artifactName: string, allowFailure = false): RunCommandResult {
		this.captureDetachedLogs("99");
		const result = this.run("docker", this.composeArgs(["down", "-v", "--remove-orphans"]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs: 180_000,
			allowFailure,
		});
		if (result.status === 0) this.detachedLogs.length = 0;
		return result;
	}

	exec(
		service: string,
		commandArgs: string[],
		artifactName: string,
		timeoutMs = 120_000,
		allowFailure = false,
	): RunCommandResult {
		return this.run("docker", this.composeArgs(["exec", "-T", service, ...commandArgs]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs,
			allowFailure,
		});
	}

	execDetached(
		service: string,
		commandArgs: string[],
		artifactName: string,
		timeoutMs = 120_000,
	): RunCommandResult {
		return this.run("docker", this.composeArgs(["exec", "-d", service, ...commandArgs]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs,
		});
	}

	execDetachedLogged(
		service: string,
		commandArgs: string[],
		artifactName: string,
	): RunCommandResult {
		const label = `${service}-${artifactName}`.replace(/[^a-zA-Z0-9._-]/g, "-");
		const path = `/tmp/codemem-e2e-${label}-viewer.log`;
		// Register before launch: detached exec can succeed even when the viewer immediately exits.
		this.detachedLogs.push({ service, artifactName, path });
		const command = `${commandArgs.map(quoteShellArgument).join(" ")} > ${quoteShellArgument(path)} 2>&1`;
		return this.execDetached(service, ["sh", "-c", command], artifactName);
	}

	getDetachedLogPath(service: string): string | undefined {
		return this.detachedLogs.findLast((log) => log.service === service)?.path;
	}

	captureDetachedLogs(artifactPrefix: string, options: { service?: string } = {}): void {
		for (const log of this.detachedLogs) {
			if (options.service && log.service !== options.service) continue;
			try {
				this.exec(
					log.service,
					["node", "--input-type=module", "-e", viewerLogReadScript(log.path)],
					`${artifactPrefix}-${log.service}-${log.artifactName}-viewer-log`,
					RESOURCE_INSPECTION_TIMEOUT_MS,
					true,
				);
			} catch {
				// Diagnostics must not replace the scenario failure or prevent the remaining captures.
			}
		}
	}

	ps(artifactName: string): RunCommandResult {
		return this.run("docker", this.composeArgs(["ps"]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
		});
	}

	hasProjectResources(artifactName: string): boolean {
		const projectFilter = `label=com.docker.compose.project=${this.options.projectName}`;
		const containers = this.run(
			"docker",
			["ps", "-a", "--filter", projectFilter, "--format", "{{.ID}}"],
			{
				artifactsDir: this.options.artifactsDir,
				artifactName: `${artifactName}-containers`,
				timeoutMs: RESOURCE_INSPECTION_TIMEOUT_MS,
			},
		);
		const volumes = this.run(
			"docker",
			["volume", "ls", "--filter", projectFilter, "--format", "{{.Name}}"],
			{
				artifactsDir: this.options.artifactsDir,
				artifactName: `${artifactName}-volumes`,
				timeoutMs: RESOURCE_INSPECTION_TIMEOUT_MS,
			},
		);
		return containers.stdout.trim().length > 0 || volumes.stdout.trim().length > 0;
	}

	logs(artifactName: string, allowFailure = false): RunCommandResult {
		return this.run("docker", this.composeArgs(["logs", "--no-color"]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs: 180_000,
			allowFailure,
		});
	}

	stop(service: string, artifactName: string): RunCommandResult {
		this.captureDetachedLogs(`before-${artifactName}`, { service });
		return this.serviceOperation(
			["stop", "--timeout", SERVICE_STOP_GRACE_SECONDS, service],
			artifactName,
		);
	}

	start(service: string, artifactName: string): RunCommandResult {
		return this.serviceOperation(["start", service], artifactName);
	}

	restart(service: string, artifactName: string): RunCommandResult {
		this.captureDetachedLogs(`before-${artifactName}`, { service });
		return this.serviceOperation(
			["restart", "--timeout", SERVICE_STOP_GRACE_SECONDS, service],
			artifactName,
		);
	}

	copyFromContainer(
		containerPath: string,
		hostPath: string,
		artifactName: string,
		allowFailure = true,
	) {
		return this.run("docker", this.composeArgs(["cp", containerPath, hostPath]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs: 180_000,
			allowFailure,
		});
	}

	copyToContainer(
		hostPath: string,
		containerPath: string,
		artifactName: string,
		allowFailure = false,
	) {
		return this.run("docker", this.composeArgs(["cp", hostPath, containerPath]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs: 180_000,
			allowFailure,
		});
	}
}
