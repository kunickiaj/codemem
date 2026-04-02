import { spawnSync } from "node:child_process";
import { writeCommandArtifact, type CommandRecord } from "./artifacts.js";

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
	composeFile: string;
	artifactsDir: string;
	projectName: string;
}

export class ComposeManager {
	constructor(private readonly options: ComposeManagerOptions) {}

	private composeArgs(args: string[]): string[] {
		return [
			"compose",
			"-f",
			this.options.composeFile,
			"-p",
			this.options.projectName,
			...args,
		];
	}

	up(services: string[], artifactName: string): RunCommandResult {
		const args = ["up", "-d", ...(process.env.CODEMEM_E2E_BUILD === "1" ? ["--build"] : []), ...services];
		return runCommand("docker", this.composeArgs(args), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs: 600_000,
		});
	}

	down(artifactName: string, allowFailure = false): RunCommandResult {
		return runCommand("docker", this.composeArgs(["down", "-v", "--remove-orphans"]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs: 180_000,
			allowFailure,
		});
	}

	exec(service: string, commandArgs: string[], artifactName: string, timeoutMs = 120_000): RunCommandResult {
		return runCommand(
			"docker",
			this.composeArgs(["exec", "-T", service, ...commandArgs]),
			{
				artifactsDir: this.options.artifactsDir,
				artifactName,
				timeoutMs,
			},
		);
	}

	execDetached(
		service: string,
		commandArgs: string[],
		artifactName: string,
		timeoutMs = 120_000,
	): RunCommandResult {
		return runCommand(
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
		return runCommand("docker", this.composeArgs(["ps"]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
		});
	}

	logs(artifactName: string, allowFailure = false): RunCommandResult {
		return runCommand("docker", this.composeArgs(["logs", "--no-color"]), {
			artifactsDir: this.options.artifactsDir,
			artifactName,
			timeoutMs: 180_000,
			allowFailure,
		});
	}

	copyFromContainer(containerPath: string, hostPath: string, artifactName: string, allowFailure = true) {
		return runCommand(
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
		return runCommand(
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
