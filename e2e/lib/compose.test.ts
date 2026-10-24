import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCommandArtifact } from "./artifacts.js";
import {
	ComposeManager,
	type RunCommandOptions,
	type RunCommandResult,
	runCommand,
} from "./compose.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("./artifacts.js", () => ({ writeCommandArtifact: vi.fn() }));

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
	vi.restoreAllMocks();
});

function createTimingManager(commandRunner = createCommandRunner()) {
	return new ComposeManager(
		{ composeFile: "docker-compose.e2e.yml", artifactsDir: "/artifacts", projectName: "timings" },
		commandRunner,
	);
}

describe("ComposeManager command timings", () => {
	it("returns an empty summary before any command runs", () => {
		// Arrange: no Docker calls are needed for an empty scenario.
		const compose = createTimingManager();

		// Act
		const summary = compose.getTimingSummary();

		// Assert
		expect(summary).toEqual({ count: 0, totalCommandMs: 0, slowest: [] });
	});

	it("sums repeated labels separately and retains only timing metadata", () => {
		// Arrange: command text and output must never enter the summary.
		const commandRunner = createCommandRunner()
			.mockReturnValueOnce({
				...SUCCESS,
				durationMs: 20,
				command: "secret command",
				stdout: "secret output",
			})
			.mockReturnValueOnce({ ...SUCCESS, durationMs: 50, status: 2, stderr: "secret error" });
		const compose = createTimingManager(commandRunner);

		// Act: the second result is an allowed failure, not an exception.
		compose.exec("peer-a", ["secret argument"], "poll");
		compose.logs("poll", true);
		const summary = compose.getTimingSummary();

		// Assert: exact shape excludes raw command, arguments, stdout, and stderr.
		expect(summary).toEqual({
			count: 2,
			totalCommandMs: 70,
			slowest: [
				{ artifactName: "poll", status: 2, durationMs: 50 },
				{ artifactName: "poll", status: 0, durationMs: 20 },
			],
		});
	});

	it("limits slowest commands to ten without truncating totals or sharing mutable records", () => {
		// Arrange
		const commandRunner = createCommandRunner();
		const compose = createTimingManager(commandRunner);
		for (let durationMs = 1; durationMs <= 12; durationMs++) {
			commandRunner.mockReturnValueOnce({ ...SUCCESS, durationMs });
		}

		// Act
		for (let index = 1; index <= 12; index++) compose.ps(`ps-${index}`);
		const first = compose.getTimingSummary();
		first.slowest[0].durationMs = 999;
		first.slowest.pop();
		const summary = compose.getTimingSummary();

		// Assert
		expect(summary.count).toBe(12);
		expect(summary.totalCommandMs).toBe(78);
		expect(summary.slowest.map((timing) => timing.durationMs)).toEqual([
			12, 11, 10, 9, 8, 7, 6, 5, 4, 3,
		]);
	});

	it.each([1, null])(
		"records thrown command failures with status %s without changing the error",
		(status) => {
			// Arrange: mock process execution and artifact writes; never invoke Docker.
			vi.mocked(spawnSync).mockReturnValue({
				status,
				stdout: "",
				stderr: "failure detail",
			} as ReturnType<typeof spawnSync>);
			vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);
			const compose = new ComposeManager(
				{
					composeFile: "docker-compose.e2e.yml",
					artifactsDir: "/artifacts",
					projectName: "timings",
				},
				runCommand,
			);

			// Act
			const invoke = () => compose.ps("failed-ps");

			// Assert: original message and artifact stay intact, summary uses only metadata.
			expect(invoke).toThrow(
				"Command failed: docker compose -f docker-compose.e2e.yml -p timings ps\nfailure detail",
			);
			expect(writeCommandArtifact).toHaveBeenCalledWith(
				"/artifacts",
				"failed-ps",
				expect.objectContaining({ status, durationMs: 45, stderr: "failure detail" }),
			);
			expect(compose.getTimingSummary()).toEqual({
				count: 1,
				totalCommandMs: 45,
				slowest: [{ artifactName: "failed-ps", status, durationMs: 45 }],
			});
		},
	);

	it("rethrows an unknown runner error unchanged without inventing timing metadata", () => {
		// Arrange
		const failure = new Error("artifact could not be written");
		const commandRunner = createCommandRunner().mockImplementation(() => {
			throw failure;
		});
		const compose = createTimingManager(commandRunner);

		// Act
		let caught: unknown;
		try {
			compose.ps("unknown-failure");
		} catch (error) {
			caught = error;
		}

		// Assert
		expect(caught).toBe(failure);
		expect(compose.getTimingSummary()).toEqual({ count: 0, totalCommandMs: 0, slowest: [] });
	});
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
				composeFiles: ["/repo/docker-compose.e2e.yml", "/repo/docker-compose.dogfood.yml"],
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

		expect(commandRunner.mock.calls[0]?.[1].slice(-4)).toEqual(["up", "-d", "--build", "peer-a"]);
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

describe("docker-compose.e2e.yml", () => {
	it.each(["peer-a", "peer-b", "peer-c"])(
		"uses an init process for %s rather than making sleep PID 1",
		(service) => {
			// Arrange
			const contents = readFileSync(resolve("docker-compose.e2e.yml"), "utf8");

			// Act: isolate this service so a neighboring init setting cannot satisfy it.
			const block = contents.match(new RegExp(`^  ${service}:\\n(?:^    .*\\n|^\\n)*`, "mu"))?.[0];

			// Assert
			expect(block).toBeDefined();
			expect(block).toMatch(/^ {4}init: true$/mu);
			expect(block).not.toMatch(/^ {4}init: false$/mu);
		},
	);
});

describe("docker-compose.dogfood.yml", () => {
	it("builds dogfood peers on the supported Node runtime", () => {
		const contents = readFileSync(resolve("e2e/images/peer.Dockerfile"), "utf8");

		expect(contents).toMatch(/^FROM node:24-bookworm-slim$/mu);
	});

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

	it("advertises recipient peers by their Compose-reachable service URLs", () => {
		const contents = readFileSync(resolve("docker-compose.dogfood.yml"), "utf8");
		const peerA = contents.slice(contents.indexOf("  peer-a:"), contents.indexOf("  peer-b:"));
		const peerB = contents.slice(contents.indexOf("  peer-b:"), contents.indexOf("  peer-c:"));
		const peerC = contents.slice(contents.indexOf("  peer-c:"));

		expect(peerA).not.toContain("CODEMEM_SYNC_ADVERTISE");
		expect(peerB).toContain("CODEMEM_SYNC_ADVERTISE: http://peer-b:7337");
		expect(peerC).toContain("CODEMEM_SYNC_ADVERTISE: http://peer-c:7337");
	});
});
