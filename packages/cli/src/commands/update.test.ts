import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getUpdateStatus, spawn } = vi.hoisted(() => ({
	getUpdateStatus: vi.fn(),
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn }));

vi.mock("@codemem/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@codemem/core")>();
	return {
		...actual,
		getUpdateStatus,
		VERSION: "0.40.2",
	};
});

import { updateCommand } from "./update.js";

const originalHome = process.env.HOME;
let testHome = "";

const availableStatus = {
	current_version: "0.40.2",
	latest_version: "0.41.0",
	update_available: true,
	first_seen_at: "2026-08-10T12:00:00.000Z",
	checked_at: "2026-08-10T12:00:00.000Z",
	stale: false,
	install_kind: "npm-global",
	auto_update_eligible: false,
	recommended_action: "npm install -g codemem@0.41.0 @codemem/embeddings@0.41.0",
	error: null,
} as const;

const currentStatus = {
	...availableStatus,
	latest_version: "0.40.2",
	update_available: false,
	recommended_action: "No action required; codemem is up to date.",
} as const;

const unavailableStatus = {
	...availableStatus,
	latest_version: null,
	update_available: false,
	first_seen_at: null,
	checked_at: null,
	stale: false,
	install_kind: "unknown",
	recommended_action: "Check network access and try again.",
	error: "registry request timed out",
} as const;

async function parseUpdateCommand(args: string[]): Promise<void> {
	const root = new Command("codemem");
	root.enablePositionalOptions();
	root.addCommand(updateCommand);
	await root.parseAsync(["update", ...args], { from: "user" });
}

beforeEach(async () => {
	testHome = await mkdtemp(join(tmpdir(), "codemem-update-test-"));
	process.env.HOME = testHome;
});

afterEach(async () => {
	getUpdateStatus.mockReset();
	spawn.mockReset();
	process.exitCode = undefined;
	process.env.HOME = originalHome;
	await rm(testHome, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function commandProcess(options: { stdout?: string; stderr?: string; exitCode?: number } = {}) {
	const child = new EventEmitter() as EventEmitter & {
		kill: ReturnType<typeof vi.fn>;
		stdout: EventEmitter & { setEncoding: () => void };
		stderr: EventEmitter & { setEncoding: () => void };
	};
	child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
	child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
	child.kill = vi.fn();
	queueMicrotask(() => {
		if (options.stdout) child.stdout.emit("data", options.stdout);
		if (options.stderr) child.stderr.emit("data", options.stderr);
		child.emit("close", options.exitCode ?? 0);
	});
	return child;
}

describe("update check command", () => {
	it("renders a concise human message for an available release and its guidance", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue(availableStatus);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check"]);

		// Assert
		const output = log.mock.calls.flat().join("\n");
		expect(output).toContain("0.41.0");
		expect(output).toContain("0.40.2");
		expect(output).toContain(availableStatus.recommended_action);
		expect(process.exitCode).toBeUndefined();
	});

	it("renders a human up-to-date message when no newer release exists", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue(currentStatus);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check"]);

		// Assert
		expect(log.mock.calls.flat().join("\n")).toMatch(/0\.40\.2.*up to date/i);
		expect(process.exitCode).toBeUndefined();
	});

	it("qualifies a stale up-to-date human result as cached", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue({
			...currentStatus,
			stale: true,
			error: "registry offline",
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check"]);

		// Assert
		const output = log.mock.calls.flat().join("\n");
		expect(output).toMatch(/up to date/i);
		expect(output).toMatch(/cached|stale/i);
	});

	it("does not tell a human that an unparseable current version is up to date", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue({
			...currentStatus,
			current_version: "development",
			recommended_action: "Verify the current codemem version and try again.",
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check"]);

		// Assert
		const output = log.mock.calls.flat().join("\n");
		expect(output).not.toMatch(/up to date/i);
		expect(output).toMatch(/verify.*current.*version/i);
	});

	it.each([
		{ label: "cache write", warning: "cache write failed: permission denied" },
		{ label: "cache read", warning: "cache read failed: corrupt filesystem entry" },
	])("shows the $label warning in human output", async ({ warning }) => {
		// Arrange
		getUpdateStatus.mockResolvedValue({ ...availableStatus, error: warning });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check"]);

		// Assert
		expect(log.mock.calls.flat().join("\n")).toContain(warning);
		expect(process.exitCode).toBeUndefined();
	});

	it("emits exactly one stable status object in JSON mode", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue(availableStatus);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check", "--json"]);

		// Assert
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(availableStatus);
		expect(error).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("passes forced refresh through to release discovery", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue(currentStatus);
		vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check", "--refresh", "--json"]);

		// Assert
		expect(getUpdateStatus).toHaveBeenCalledWith(
			expect.objectContaining({ installKind: "unknown", refresh: true }),
		);
	});

	it("treats valid stale status as successful and preserves the status JSON", async () => {
		// Arrange
		const staleStatus = {
			...availableStatus,
			stale: true,
			auto_update_eligible: false,
			error: "registry offline",
		};
		getUpdateStatus.mockResolvedValue(staleStatus);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check", "--json"]);

		// Assert
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(staleStatus);
		expect(process.exitCode).toBeUndefined();
	});

	it("returns structured JSON and non-zero status when release status is unavailable", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue(unavailableStatus);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check", "--json"]);

		// Assert
		const output = JSON.parse(String(log.mock.calls[0]?.[0]));
		expect(output).toMatchObject({
			error: "update_check_unavailable",
			message: "registry request timed out",
		});
		expect(error).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("returns non-zero human failure when no valid fresh or stale status exists", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue(unavailableStatus);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check"]);

		// Assert
		expect(error.mock.calls.flat().join("\n")).toContain("registry request timed out");
		expect(process.exitCode).toBe(1);
	});
});

describe("update install command", () => {
	it("refuses before spawning when release status is not eligible", async () => {
		getUpdateStatus.mockResolvedValue(availableStatus);
		vi.spyOn(console, "error").mockImplementation(() => {});

		await parseUpdateCommand(["install"]);

		expect(getUpdateStatus).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }));
		expect(spawn).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("installs the exact validated release without a shell and verifies it", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		getUpdateStatus.mockResolvedValue({ ...availableStatus, auto_update_eligible: true });
		spawn
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn).toHaveBeenNthCalledWith(
			1,
			"npm",
			[
				"install",
				"-g",
				"--registry",
				"https://registry.npmjs.org/",
				"codemem@0.41.0",
				"@codemem/embeddings@0.41.0",
			],
			expect.objectContaining({ env: undefined, shell: false }),
		);
		expect(spawn).toHaveBeenNthCalledWith(
			2,
			"codemem",
			["version"],
			expect.objectContaining({ shell: false }),
		);
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			previous_version: "0.40.2",
			installed_version: "0.41.0",
		});
		expect(process.exitCode).toBeUndefined();
	});

	it("keeps the bare update command non-mutating", async () => {
		getUpdateStatus.mockResolvedValue({ ...availableStatus, auto_update_eligible: true });

		await expect(parseUpdateCommand([])).rejects.toThrow(
			'process.exit unexpectedly called with "1"',
		);

		expect(getUpdateStatus).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("preserves the CPU-only ONNX install policy on Linux", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		getUpdateStatus.mockResolvedValue({ ...availableStatus, auto_update_eligible: true });
		spawn
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn).toHaveBeenNthCalledWith(
			1,
			"npm",
			expect.arrayContaining(["codemem@0.41.0", "@codemem/embeddings@0.41.0"]),
			expect.objectContaining({
				env: expect.objectContaining({
					ONNXRUNTIME_NODE_INSTALL: "skip",
					PATH: process.env.PATH,
				}),
			}),
		);
		expect(process.exitCode).toBeUndefined();
	});

	it.runIf(process.platform !== "win32")(
		"recognizes an npm-global executable invoked through its bin symlink",
		async () => {
			const packageEntry = join(
				testHome,
				"prefix",
				"lib",
				"node_modules",
				"codemem",
				"dist",
				"index.js",
			);
			const binEntry = join(testHome, "prefix", "bin", "codemem");
			await mkdir(join(testHome, "prefix", "lib", "node_modules", "codemem", "dist"), {
				recursive: true,
			});
			await mkdir(join(testHome, "prefix", "bin"), { recursive: true });
			await writeFile(packageEntry, "#!/usr/bin/env node\n", "utf8");
			await symlink(packageEntry, binEntry);
			const previousArgv = [...process.argv];
			process.argv[1] = binEntry;
			getUpdateStatus.mockResolvedValue(availableStatus);
			vi.spyOn(console, "log").mockImplementation(() => {});

			try {
				await parseUpdateCommand(["check", "--json"]);
			} finally {
				process.argv.splice(0, process.argv.length, ...previousArgv);
			}

			expect(getUpdateStatus).toHaveBeenCalledWith(
				expect.objectContaining({ installKind: "npm-global" }),
			);
		},
	);

	it("fails when the active CLI does not report the installed version", async () => {
		getUpdateStatus.mockResolvedValue({ ...availableStatus, auto_update_eligible: true });
		spawn
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: "0.40.2\n" }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			error: "update_verification_failed",
		});
		expect(process.exitCode).toBe(1);
	});

	it("refuses a concurrent installation while another process owns the update lock", async () => {
		getUpdateStatus.mockResolvedValue({ ...availableStatus, auto_update_eligible: true });
		const lockDirectory = join(testHome, ".codemem");
		await mkdir(lockDirectory, { recursive: true });
		await writeFile(join(lockDirectory, "update-install.lock"), `${process.pid}\n`, "utf8");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn).not.toHaveBeenCalled();
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			error: "update_install_locked",
		});
		expect(process.exitCode).toBe(1);
	});

	it("reclaims a stale update lock before installing", async () => {
		getUpdateStatus.mockResolvedValue({ ...availableStatus, auto_update_eligible: true });
		const lockDirectory = join(testHome, ".codemem");
		await mkdir(lockDirectory, { recursive: true });
		await writeFile(join(lockDirectory, "update-install.lock"), "99999999\n", "utf8");
		spawn
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn).toHaveBeenCalledTimes(2);
		expect(process.exitCode).toBeUndefined();
	});
});
