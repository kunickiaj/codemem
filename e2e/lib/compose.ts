import { spawnSync } from "node:child_process";
import { writeCommandArtifact, type CommandRecord } from "./artifacts.js";

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

function stringifyCommand(command: string, args: string[]): string {
	return [command, ...args].join(" ");
}

export function runCommand(command: string, args: string[], options: RunCommandOptions): RunCommandResult {
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
		throw new Error(`Command failed: ${record.command}\n${record.stderr || record.stdout}`);
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
		return this.commandRunner("docker", this.composeArgs(args), {
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
		return this.commandRunner("docker", this.composeArgs(args), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs: 600_000,
		});
	}

	down(artifactName: string, allowFailure = false): RunCommandResult {
		return this.commandRunner("docker", this.composeArgs(["down", "-v", "--remove-orphans"]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs: 180_000,
			allowFailure,
		});
	}

	exec(
		service: string,
		commandArgs: string[],
		artifactName: string,
		timeoutMs = 120_000,
		allowFailure = false,
	): RunCommandResult {
		return this.commandRunner(
			"docker",
			this.composeArgs(["exec", "-T", service, ...commandArgs]),
			{
				artifactsDir: this.options.artifactsDir,
				artifactName,
				timeoutMs,
				allowFailure,
			},
		);
	}

	execDetached(
		service: string,
		commandArgs: string[],
		artifactName: string,
		timeoutMs = 120_000,
	): RunCommandResult {
		return this.commandRunner(
			"docker",
			this.composeArgs(["exec", "-d", service, ...commandArgs]),
			{
				artifactsDir: this.options.artifactsDir,
				artifactName,
				timeoutMs,
			},
		);
	}

	ps(artifactName: string): RunCommandResult {
		return this.commandRunner("docker", this.composeArgs(["ps"]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
		});
	}

	hasProjectResources(artifactName: string): boolean {
		const projectFilter = `label=com.docker.compose.project=${this.options.projectName}`;
		const containers = this.commandRunner(
			"docker",
			["ps", "-a", "--filter", projectFilter, "--format", "{{.ID}}"],
			{
				artifactsDir: this.options.artifactsDir,
				artifactName: `${artifactName}-containers`,
				timeoutMs: RESOURCE_INSPECTION_TIMEOUT_MS,
			},
		);
		const volumes = this.commandRunner(
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
		return this.commandRunner("docker", this.composeArgs(["logs", "--no-color"]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs: 180_000,
			allowFailure,
		});
	}

	stop(service: string, artifactName: string): RunCommandResult {
		return this.serviceOperation(
			["stop", "--timeout", SERVICE_STOP_GRACE_SECONDS, service],
			artifactName,
		);
	}

	start(service: string, artifactName: string): RunCommandResult {
		return this.serviceOperation(["start", service], artifactName);
	}

	restart(service: string, artifactName: string): RunCommandResult {
		return this.serviceOperation(
			["restart", "--timeout", SERVICE_STOP_GRACE_SECONDS, service],
			artifactName,
		);
	}

	copyFromContainer(containerPath: string, hostPath: string, artifactName: string, allowFailure = true) {
		return this.commandRunner(
			"docker",
			this.composeArgs(["cp", containerPath, hostPath]),
			{
				artifactsDir: this.options.artifactsDir,
				artifactName,
				timeoutMs: 180_000,
				allowFailure,
			},
		);
	}

	copyToContainer(hostPath: string, containerPath: string, artifactName: string, allowFailure = false) {
		return this.commandRunner(
			"docker",
			this.composeArgs(["cp", hostPath, containerPath]),
			{
				artifactsDir: this.options.artifactsDir,
				artifactName,
				timeoutMs: 180_000,
				allowFailure,
			},
		);
	}
}
