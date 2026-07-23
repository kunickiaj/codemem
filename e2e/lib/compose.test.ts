import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ComposeManager,
	type RunCommandOptions,
	type RunCommandResult,
} from "./compose.js";

const SUCCESS: RunCommandResult = {
	command: "docker compose",
	status: 0,
	stdout: "",
	stderr: "",
	durationMs: 1,
};

function createCommandRunner() {
	return vi.fn((_command: string, _args: string[], _options: RunCommandOptions) => SUCCESS);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("ComposeManager", () => {
	it("preserves the legacy composeFile up arguments and defaults", () => {
		vi.stubEnv("CODEMEM_E2E_BUILD", "0");
		const commandRunner = createCommandRunner();
		const compose = new ComposeManager(
			{
				composeFile: "/repo/docker-compose.e2e.yml",
				artifactsDir: "/artifacts",
				projectName: "codemem-e2e-smoke",
			},
			commandRunner,
		);

		compose.up(["coordinator", "peer-a"], "compose-up");

		expect(commandRunner).toHaveBeenCalledWith(
			"docker",
			[
				"compose",
				"-f",
				"/repo/docker-compose.e2e.yml",
				"-p",
				"codemem-e2e-smoke",
				"up",
				"-d",
				"coordinator",
				"peer-a",
			],
			{
				artifactsDir: "/artifacts",
				artifactName: "compose-up",
				timeoutMs: 600_000,
			},
		);
	});

	it("keeps multiple Compose files and fixed profiles in declared order", () => {
		const commandRunner = createCommandRunner();
		const compose = new ComposeManager(
			{
				composeFiles: [
					"/repo/docker-compose.e2e.yml",
					"/repo/docker-compose.dogfood.yml",
				],
				profiles: ["bootstrap", "diagnostics"],
				artifactsDir: "/artifacts",
				projectName: "codemem-dogfood",
			},
			commandRunner,
		);

		compose.ps("compose-ps");

		expect(commandRunner.mock.calls[0]?.[1]).toEqual([
			"compose",
			"-f",
			"/repo/docker-compose.e2e.yml",
			"-f",
			"/repo/docker-compose.dogfood.yml",
			"-p",
			"codemem-dogfood",
			"--profile",
			"bootstrap",
			"--profile",
			"diagnostics",
			"ps",
		]);
	});

	it("preserves the opt-in image build behavior", () => {
		vi.stubEnv("CODEMEM_E2E_BUILD", "1");
		const commandRunner = createCommandRunner();
		const compose = new ComposeManager(
			{
				composeFile: "/repo/docker-compose.e2e.yml",
				artifactsDir: "/artifacts",
				projectName: "codemem-e2e-smoke",
			},
			commandRunner,
		);

		compose.up(["peer-a"], "compose-up");

		expect(commandRunner.mock.calls[0]?.[1].slice(-4)).toEqual([
			"up",
			"-d",
			"--build",
			"peer-a",
		]);
	});

	it("runs service lifecycle operations with fixed command bounds", () => {
		const commandRunner = createCommandRunner();
		const compose = new ComposeManager(
			{
				composeFile: "/repo/docker-compose.e2e.yml",
				artifactsDir: "/artifacts",
				projectName: "codemem-dogfood",
			},
			commandRunner,
		);

		compose.stop("peer-b", "stop-peer-b");
		compose.start("peer-b", "start-peer-b");
		compose.restart("peer-b", "restart-peer-b");

		expect(commandRunner.mock.calls[0]?.[1].slice(-4)).toEqual([
			"stop",
			"--timeout",
			"30",
			"peer-b",
		]);
		expect(commandRunner.mock.calls[1]?.[1].slice(-2)).toEqual(["start", "peer-b"]);
		expect(commandRunner.mock.calls[2]?.[1].slice(-4)).toEqual([
			"restart",
			"--timeout",
			"30",
			"peer-b",
		]);
		expect(commandRunner.mock.calls.map((call) => call[2].timeoutMs)).toEqual([
			180_000, 180_000, 180_000,
		]);
	});

	it("checks all fixed-project containers and labeled volumes with exact Docker arguments", () => {
		const commandRunner = createCommandRunner()
			.mockReturnValueOnce({ ...SUCCESS, stdout: "" })
			.mockReturnValueOnce({ ...SUCCESS, stdout: "codemem-dogfood_peer-a-data\n" });
		const compose = new ComposeManager(
			{
				composeFile: "/repo/docker-compose.e2e.yml",
				artifactsDir: "/artifacts",
				projectName: "codemem-dogfood",
			},
			commandRunner,
		);

		expect(compose.hasProjectResources("dogfood-resources")).toBe(true);
		expect(commandRunner).toHaveBeenNthCalledWith(
			1,
			"docker",
			[
				"ps",
				"-a",
				"--filter",
				"label=com.docker.compose.project=codemem-dogfood",
				"--format",
				"{{.ID}}",
			],
			{
				artifactsDir: "/artifacts",
				artifactName: "dogfood-resources-containers",
				timeoutMs: 30_000,
			},
		);
		expect(commandRunner).toHaveBeenNthCalledWith(
			2,
			"docker",
			[
				"volume",
				"ls",
				"--filter",
				"label=com.docker.compose.project=codemem-dogfood",
				"--format",
				"{{.Name}}",
			],
			{
				artifactsDir: "/artifacts",
				artifactName: "dogfood-resources-volumes",
				timeoutMs: 30_000,
			},
		);
	});

	it("reports no fixed-project resources only when containers and volumes are both absent", () => {
		const commandRunner = createCommandRunner();
		const compose = new ComposeManager(
			{
				composeFile: "/repo/docker-compose.e2e.yml",
				artifactsDir: "/artifacts",
				projectName: "codemem-dogfood",
			},
			commandRunner,
		);

		expect(compose.hasProjectResources("dogfood-resources")).toBe(false);
		expect(commandRunner).toHaveBeenCalledTimes(2);
	});

	it("detects stopped fixed-project containers even when no labeled volume remains", () => {
		const commandRunner = createCommandRunner()
			.mockReturnValueOnce({ ...SUCCESS, stdout: "stopped-container-id\n" })
			.mockReturnValueOnce({ ...SUCCESS, stdout: "" });
		const compose = new ComposeManager(
			{
				composeFile: "/repo/docker-compose.e2e.yml",
				artifactsDir: "/artifacts",
				projectName: "codemem-dogfood",
			},
			commandRunner,
		);

		expect(compose.hasProjectResources("dogfood-resources")).toBe(true);
		expect(commandRunner).toHaveBeenCalledTimes(2);
	});
});

describe("docker-compose.dogfood.yml", () => {
	it("publishes exactly one loopback viewer port per peer", () => {
		const contents = readFileSync(resolve("docker-compose.dogfood.yml"), "utf8");
		const lines = contents.split("\n");
		const portBlocks = lines.flatMap((line, index) => {
			if (line !== "    ports:") return [];
			const entries: string[] = [];
			for (const candidate of lines.slice(index + 1)) {
				if (!candidate.startsWith("      ")) break;
				entries.push(candidate.trim());
			}
			return [entries];
		});

		expect(portBlocks).toEqual([
			['- "127.0.0.1:38881:38888"'],
			['- "127.0.0.1:38882:38888"'],
			['- "127.0.0.1:38883:38888"'],
		]);
		expect(contents).not.toMatch(/^\s*network_mode:\s*["']?host["']?\s*$/mu);
		expect(contents).toContain("serve start --foreground");
	});
});
