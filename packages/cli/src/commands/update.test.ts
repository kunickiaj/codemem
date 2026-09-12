import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const originalArgv = [...process.argv];
const originalMiseConfigDir = process.env.MISE_CONFIG_DIR;
const originalMiseGlobalConfigFile = process.env.MISE_GLOBAL_CONFIG_FILE;
const originalPnpmHome = process.env.PNPM_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
let testHome = "";

function useMiseEntrypoint(): void {
	process.argv[1] = "/home/user/.local/share/mise/installs/npm-codemem/0.40.2/dist/index.js";
}

const availableStatus = {
	current_version: "0.40.2",
	channel: "latest",
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

const miseStatus = {
	...availableStatus,
	install_kind: "mise",
	recommended_action: "mise use -g npm:codemem@0.41.0",
} as const;

const pnpmStatus = {
	...availableStatus,
	install_kind: "pnpm-global",
	recommended_action: "pnpm add -g codemem@0.41.0 @codemem/embeddings@0.41.0",
} as const;

function pnpmRoot(): string {
	return join(testHome, ".local", "share", "pnpm", "global", "v11");
}

function pnpmGroup(version: string): string {
	if (version === "0.40.2") return "a".repeat(64);
	if (version === "0.41.0") return "b".repeat(64);
	return "c".repeat(64);
}

function pnpmPackagePath(name: "codemem" | "embeddings", version = "0.40.2"): string {
	const groupRoot = join(pnpmRoot(), pnpmGroup(version), "node_modules");
	if (name === "codemem") return join(groupRoot, "codemem");
	return join(groupRoot, "@codemem", "embeddings");
}

function canonicalPnpmPackagePath(name: "codemem" | "embeddings", version = "0.40.2"): string {
	const virtualStore = join(pnpmRoot(), pnpmGroup(version), "node_modules", ".pnpm");
	if (name === "codemem") {
		return join(
			virtualStore,
			`codemem@${version}_better-sqlite3@12.6.2`,
			"node_modules",
			"codemem",
		);
	}
	return join(
		virtualStore,
		`@codemem+embeddings@${version}`,
		"node_modules",
		"@codemem",
		"embeddings",
	);
}

function pnpmBin(): string {
	return join(testHome, ".local", "share", "pnpm");
}

function canonicalPnpmBin(): string {
	return realpathSync(pnpmBin());
}

function pnpmUpdateCwd(): string {
	return join(testHome, ".codemem");
}

function pnpmListState(
	options: {
		codememPath?: string;
		codememVersion?: string;
		embeddingsPath?: string;
		embeddingsVersion?: string;
		includeEmbeddings?: boolean;
		private?: boolean;
		rootPath?: string;
	} = {},
): string {
	const codememVersion = options.codememVersion ?? "0.40.2";
	const dependencies: Record<string, unknown> = {
		codemem: {
			path: options.codememPath ?? pnpmPackagePath("codemem", codememVersion),
			version: codememVersion,
		},
	};
	if (options.includeEmbeddings ?? true) {
		const embeddingsVersion = options.embeddingsVersion ?? codememVersion;
		dependencies["@codemem/embeddings"] = {
			path: options.embeddingsPath ?? pnpmPackagePath("embeddings", embeddingsVersion),
			version: embeddingsVersion,
		};
	}
	return JSON.stringify([
		{
			path: options.rootPath ?? pnpmRoot(),
			private: options.private ?? true,
			dependencies,
		},
	]);
}

function updatedPnpmListState(options: Parameters<typeof pnpmListState>[0] = {}): string {
	return pnpmListState({
		codememVersion: "0.41.0",
		embeddingsVersion: "0.41.0",
		...options,
	});
}

async function usePnpmEntrypoint(): Promise<void> {
	for (const version of ["0.40.2", "0.41.0"]) {
		for (const name of ["codemem", "embeddings"] as const) {
			const listedPath = pnpmPackagePath(name, version);
			const canonicalPath = canonicalPnpmPackagePath(name, version);
			await mkdir(canonicalPath, { recursive: true });
			await mkdir(dirname(listedPath), { recursive: true });
			await symlink(canonicalPath, listedPath, "dir");
		}
	}
	const entryPath = join(pnpmPackagePath("codemem"), "dist", "index.js");
	await mkdir(join(canonicalPnpmPackagePath("codemem"), "dist"), { recursive: true });
	await mkdir(pnpmBin(), { recursive: true });
	await writeFile(entryPath, "#!/usr/bin/env node\n", "utf8");
	process.argv[1] = entryPath;
}

function legacyPnpmListRoot(): string {
	return join(testHome, ".local", "share", "pnpm", "global", "5");
}

function legacyPnpmPackagePath(name: "codemem" | "embeddings"): string {
	const packageSegments = name === "codemem" ? ["codemem"] : ["@codemem", "embeddings"];
	return join(legacyPnpmListRoot(), "node_modules", ...packageSegments);
}

function legacyCanonicalPnpmPackagePath(name: "codemem" | "embeddings", version: string): string {
	const packageSegments = name === "codemem" ? ["codemem"] : ["@codemem", "embeddings"];
	const storeName = name === "codemem" ? `codemem@${version}` : `@codemem+embeddings@${version}`;
	return join(legacyPnpmListRoot(), ".pnpm", storeName, "node_modules", ...packageSegments);
}

async function useLegacyPnpmEntrypoint(): Promise<void> {
	for (const version of ["0.40.2", "0.41.0"]) {
		for (const name of ["codemem", "embeddings"] as const) {
			const listedPath = legacyPnpmPackagePath(name);
			const canonicalPath = legacyCanonicalPnpmPackagePath(name, version);
			await mkdir(canonicalPath, { recursive: true });
			await mkdir(dirname(listedPath), { recursive: true });
			if (version === "0.40.2") await symlink(canonicalPath, listedPath, "dir");
		}
	}
	const entryPath = join(legacyPnpmPackagePath("codemem"), "dist", "index.js");
	await mkdir(join(legacyCanonicalPnpmPackagePath("codemem", "0.40.2"), "dist"), {
		recursive: true,
	});
	await mkdir(pnpmBin(), { recursive: true });
	await writeFile(entryPath, "#!/usr/bin/env node\n", "utf8");
	process.argv[1] = entryPath;
}

function miseState(
	options: {
		installPath?: string;
		requestedVersion?: string;
		source?: Record<string, unknown>;
		version?: string;
	} = {},
): string {
	const version = options.version ?? "0.40.2";
	return JSON.stringify([
		{
			active: true,
			install_path:
				options.installPath ?? "/home/user/.local/share/mise/installs/npm-codemem/0.40.2",
			requested_version: options.requestedVersion ?? version,
			source:
				options.source ??
				({ path: join(testHome, ".config", "mise", "config.toml"), type: "mise.toml" } as const),
			version,
		},
	]);
}

const globalMiseState = (): string => miseState();
const updatedGlobalMiseState = (source?: Record<string, unknown>): string =>
	miseState({
		installPath: "/home/user/.local/share/mise/installs/npm-codemem/0.41.0",
		source,
		version: "0.41.0",
	});
const localMiseState = (): string =>
	miseState({ source: { path: join(testHome, "workspace", "mise.toml"), type: "mise.toml" } });

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
	delete process.env.MISE_CONFIG_DIR;
	delete process.env.MISE_GLOBAL_CONFIG_FILE;
	delete process.env.PNPM_HOME;
	delete process.env.XDG_CONFIG_HOME;
	const miseConfigDirectory = join(testHome, ".config", "mise");
	await mkdir(miseConfigDirectory, { recursive: true });
	await writeFile(join(miseConfigDirectory, "config.toml"), "");
});

afterEach(async () => {
	getUpdateStatus.mockReset();
	spawn.mockReset();
	process.exitCode = undefined;
	process.argv.splice(0, process.argv.length, ...originalArgv);
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalMiseConfigDir === undefined) delete process.env.MISE_CONFIG_DIR;
	else process.env.MISE_CONFIG_DIR = originalMiseConfigDir;
	if (originalMiseGlobalConfigFile === undefined) delete process.env.MISE_GLOBAL_CONFIG_FILE;
	else process.env.MISE_GLOBAL_CONFIG_FILE = originalMiseGlobalConfigFile;
	if (originalPnpmHome === undefined) delete process.env.PNPM_HOME;
	else process.env.PNPM_HOME = originalPnpmHome;
	if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	await rm(testHome, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function commandProcess(
	options: {
		stdout?: string;
		stdoutChunks?: string[];
		stderr?: string;
		exitCode?: number;
		error?: Error;
	} = {},
) {
	const child = new EventEmitter() as EventEmitter & {
		kill: ReturnType<typeof vi.fn>;
		stdout: EventEmitter & { setEncoding: () => void };
		stderr: EventEmitter & { setEncoding: () => void };
	};
	child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
	child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
	child.kill = vi.fn();
	queueMicrotask(() => {
		if (options.error) {
			child.emit("error", options.error);
			return;
		}
		for (const chunk of options.stdoutChunks ?? (options.stdout ? [options.stdout] : [])) {
			child.stdout.emit("data", chunk);
		}
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

	it("describes repository source without claiming its package metadata is up to date", async () => {
		getUpdateStatus.mockResolvedValue({
			...currentStatus,
			install_kind: "repo-dev",
			latest_version: "0.41.0",
			recommended_action:
				"Package-release updates do not apply to repository source. Run git pull, pnpm install, and pnpm build in the codemem repository.",
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["check"]);

		const output = log.mock.calls.flat().join("\n");
		expect(output).toMatch(/running from repository source/i);
		expect(output).toMatch(/package metadata: 0\.40\.2/i);
		expect(output).not.toMatch(/up to date/i);
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

	it("emits exactly one channel-aware status object in JSON mode", async () => {
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

	it("pins the public default and scoped registries in the POSIX install command", async () => {
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
				"--@codemem:registry=https://registry.npmjs.org/",
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

	it("installs an eligible prerelease within its reported channel", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		getUpdateStatus.mockResolvedValue({
			...availableStatus,
			current_version: "0.44.0-alpha.1",
			channel: "alpha",
			latest_version: "0.44.0-alpha.2",
			auto_update_eligible: true,
		});
		spawn
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: "0.44.0-alpha.2\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn).toHaveBeenNthCalledWith(
			1,
			"npm",
			expect.arrayContaining(["codemem@0.44.0-alpha.2", "@codemem/embeddings@0.44.0-alpha.2"]),
			expect.objectContaining({ shell: false }),
		);
		expect(process.exitCode).toBeUndefined();
	});

	it("fails closed when npm install output exceeds the capture limit", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		getUpdateStatus.mockResolvedValue({ ...availableStatus, auto_update_eligible: true });
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: "x".repeat(65 * 1_024) }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn.mock.results[0]?.value.kill).not.toHaveBeenCalled();
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_failed",
			message: "command output too large",
		});
		expect(process.exitCode).toBe(1);
	});
});

describe("mise update install execution", () => {
	beforeEach(useMiseEntrypoint);
	it("proves global ownership and installs with safe Unix options", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: updatedGlobalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn.mock.calls.map(([, args]) => args)).toEqual([
			["ls", "npm:codemem", "--current", "--json"],
			["ls", "npm:codemem", "--global", "--json"],
			["use", "-g", "npm:codemem@0.41.0"],
			["ls", "npm:codemem", "--global", "--json"],
			["exec", "--", "codemem", "version"],
		]);
		expect(spawn.mock.calls[2]?.[2]).toEqual(
			expect.objectContaining({
				cwd: "/",
				detached: true,
				env: expect.objectContaining({
					HOME: testHome,
					ONNXRUNTIME_NODE_INSTALL: "skip",
					npm_config_registry: "https://registry.npmjs.org/",
					"npm_config_@codemem:registry": "https://registry.npmjs.org/",
				}),
				shell: false,
			}),
		);
		expect(spawn.mock.calls[4]?.[2]).toEqual(expect.objectContaining({ cwd: "/" }));
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			previous_version: "0.40.2",
			installed_version: "0.41.0",
		});
		expect(process.exitCode).toBeUndefined();
	});
});

describe("mise update install failures", () => {
	beforeEach(useMiseEntrypoint);
	it("reports a failed mise update", async () => {
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() =>
				commandProcess({ stderr: "mise backend failed\n", exitCode: 1 }),
			);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			error: "update_install_failed",
			message: "mise backend failed",
		});
		expect(spawn).toHaveBeenCalledTimes(3);
		expect(process.exitCode).toBe(1);
	});

	it("bounds failed install output without returning raw oversized stderr", async () => {
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() =>
				commandProcess({ stderr: `sensitive-marker${"x".repeat(65 * 1_024)}`, exitCode: 1 }),
			);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_failed",
			message: "command output too large",
		});
		expect(log.mock.calls.flat().join("\n")).not.toContain("sensitive-marker");
		expect(process.exitCode).toBe(1);
	});
});

describe("mise update install safeguards", () => {
	beforeEach(useMiseEntrypoint);
	it("reports missing mise with the exact manual recovery command", async () => {
		getUpdateStatus.mockResolvedValue(miseStatus);
		const missingMise = Object.assign(new Error("spawn mise ENOENT"), { code: "ENOENT" });
		spawn.mockImplementationOnce(() => commandProcess({ error: missingMise }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			error: "update_install_failed",
			message: "mise was not found on PATH; install mise, then run mise use -g npm:codemem@0.41.0",
		});
		expect(process.exitCode).toBe(1);
	});
});

describe("mise update ownership safeguards", () => {
	beforeEach(useMiseEntrypoint);
	it("refuses when the active mise source is not the global source", async () => {
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: localMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message:
				"Could not prove the active mise codemem installation is globally configured. mise use -g npm:codemem@0.41.0",
		});
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(process.exitCode).toBe(1);
	});

	it("refuses a matching system-scope global source", async () => {
		const systemState = miseState({
			source: { path: "/etc/mise/config.toml", type: "mise.toml" },
		});
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: systemState }))
			.mockImplementationOnce(() => commandProcess({ stdout: systemState }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			error: "update_install_refused",
		});
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(process.exitCode).toBe(1);
	});

	it("accepts a user conf.d source before writing the exact release to config.toml", async () => {
		const confSource = {
			path: join(testHome, ".config", "mise", "conf.d", "codemem.toml"),
			type: "mise.toml",
		};
		const configSource = {
			path: join(testHome, ".config", "mise", "config.toml"),
			type: "mise.toml",
		};
		await mkdir(join(testHome, ".config", "mise", "conf.d"), { recursive: true });
		await writeFile(confSource.path, "");
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: miseState({ source: confSource }) }))
			.mockImplementationOnce(() => commandProcess({ stdout: miseState({ source: confSource }) }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() =>
				commandProcess({ stdout: updatedGlobalMiseState(configSource) }),
			)
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn).toHaveBeenCalledTimes(5);
		expect(process.exitCode).toBeUndefined();
	});

	it("accepts an explicit user-owned MISE_GLOBAL_CONFIG_FILE", async () => {
		const source = {
			path: join(testHome, "dotfiles", "mise-global.toml"),
			type: "mise.toml",
		};
		await mkdir(join(testHome, "dotfiles"), { recursive: true });
		await writeFile(source.path, "");
		process.env.MISE_GLOBAL_CONFIG_FILE = source.path;
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: miseState({ source }) }))
			.mockImplementationOnce(() => commandProcess({ stdout: miseState({ source }) }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: updatedGlobalMiseState(source) }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn).toHaveBeenCalledTimes(5);
		expect(process.exitCode).toBeUndefined();
	});

	it("migrates a user-level ~/.config/mise.toml source when --global is empty", async () => {
		const source = {
			path: join(testHome, ".config", "mise.toml"),
			type: "mise.toml",
		};
		await writeFile(source.path, "");
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: miseState({ source }) }))
			.mockImplementationOnce(() => commandProcess({ stdout: "[]" }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: updatedGlobalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn).toHaveBeenCalledTimes(5);
		expect(process.exitCode).toBeUndefined();
	});

	it("refuses an empty --global result for a non-legacy source", async () => {
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: "[]" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn).toHaveBeenCalledTimes(2);
		expect(process.exitCode).toBe(1);
	});
});

describe("mise install-path ownership safeguards", () => {
	beforeEach(useMiseEntrypoint);
	it("refuses when the active install path does not own the running entry", async () => {
		const previousArgv = [...process.argv];
		process.argv[1] =
			"/home/user/.local/share/mise/installs/npm-codemem/0.40.2/lib/node_modules/codemem/dist/index.js";
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn.mockImplementationOnce(() =>
			commandProcess({
				stdout: miseState({
					installPath: "/home/other/.local/share/mise/installs/npm-codemem/0.40.2",
				}),
			}),
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await parseUpdateCommand(["install", "--json"]);
		} finally {
			process.argv.splice(0, process.argv.length, ...previousArgv);
		}

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			error: "update_install_refused",
		});
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(process.exitCode).toBe(1);
	});

	it.runIf(process.platform !== "win32")(
		"canonicalizes a symlinked mise install path before ownership comparison",
		async () => {
			const installPath = join(
				testHome,
				".local",
				"share",
				"mise",
				"installs",
				"npm-codemem",
				"0.40.2",
			);
			const entryPath = join(installPath, "lib", "node_modules", "codemem", "dist", "index.js");
			const linkedInstallPath = join(testHome, "linked-mise-install");
			await mkdir(join(installPath, "lib", "node_modules", "codemem", "dist"), {
				recursive: true,
			});
			await writeFile(entryPath, "#!/usr/bin/env node\n", "utf8");
			await symlink(installPath, linkedInstallPath, "dir");
			const previousArgv = [...process.argv];
			process.argv[1] = entryPath;
			const activeState = miseState({ installPath: linkedInstallPath });
			getUpdateStatus.mockResolvedValue(miseStatus);
			spawn
				.mockImplementationOnce(() => commandProcess({ stdout: activeState }))
				.mockImplementationOnce(() => commandProcess({ stdout: activeState }))
				.mockImplementationOnce(() => commandProcess())
				.mockImplementationOnce(() => commandProcess({ stdout: updatedGlobalMiseState() }))
				.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
			vi.spyOn(console, "log").mockImplementation(() => {});

			try {
				await parseUpdateCommand(["install", "--json"]);
			} finally {
				process.argv.splice(0, process.argv.length, ...previousArgv);
			}

			expect(spawn).toHaveBeenCalledTimes(5);
			expect(process.exitCode).toBeUndefined();
		},
	);
});

describe("mise update state validation", () => {
	beforeEach(useMiseEntrypoint);
	it("ignores additional bounded fields in mise source metadata", async () => {
		const source = Object.fromEntries([
			["path", join(testHome, ".config", "mise", "config.toml")],
			["metadata", { origin: "future-mise-version" }],
			...Array.from({ length: 9 }, (_, index) => [`field-${index}`, `value-${index}`]),
			["x".repeat(5_000), "long-key"],
		]);
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: miseState({ source }) }))
			.mockImplementationOnce(() => commandProcess({ stdout: miseState({ source }) }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() =>
				commandProcess({ stdout: miseState({ source, version: "0.41.0" }) }),
			)
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn).toHaveBeenCalledTimes(5);
		expect(process.exitCode).toBeUndefined();
	});

	it("refuses malformed mise ownership state before mutation", async () => {
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn.mockImplementationOnce(() => commandProcess({ stdout: "{not-json" }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			error: "update_install_refused",
			message: expect.stringContaining("mise use -g npm:codemem@0.41.0"),
		});
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(process.exitCode).toBe(1);
	});

	it("bounds mise ownership output before parsing", async () => {
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn.mockImplementationOnce(() => commandProcess({ stdout: "x".repeat(65 * 1_024) }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			error: "update_install_refused",
		});
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(process.exitCode).toBe(1);
	});
});

describe("mise update lifecycle safeguards", () => {
	beforeEach(useMiseEntrypoint);
	it("refuses a stale mise release before spawning", async () => {
		getUpdateStatus.mockResolvedValue({ ...miseStatus, stale: true });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			error: "update_install_refused",
		});
		expect(spawn).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("fails when mise exits successfully but global state remains on the old version", async () => {
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			error: "update_verification_failed",
		});
		expect(spawn).toHaveBeenCalledTimes(4);
		expect(process.exitCode).toBe(1);
	});

	it("accepts the target requested version when the installed version field lags", async () => {
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() =>
				commandProcess({
					stdout: miseState({ requestedVersion: "0.41.0", version: "0.40.2" }),
				}),
			)
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			installed_version: "0.41.0",
			previous_version: "0.40.2",
		});
		expect(spawn).toHaveBeenCalledTimes(5);
		expect(process.exitCode).toBeUndefined();
	});

	it("fails when a mise update does not become the active CLI version", async () => {
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: updatedGlobalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.40.2\n" }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			error: "update_verification_failed",
		});
		expect(process.exitCode).toBe(1);
	});

	it("bounds verification output and reports a generic failure", async () => {
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: updatedGlobalMiseState() }))
			.mockImplementationOnce(() =>
				commandProcess({
					stdoutChunks: ["0.41.0\n", `sensitive-marker${"x".repeat(65 * 1_024)}`],
				}),
			);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_verification_failed",
			message:
				"mise updated global configuration, but installed version verification failed; inspect the global mise codemem state before retrying",
		});
		expect(log.mock.calls.flat().join("\n")).not.toContain("sensitive-marker");
		expect(process.exitCode).toBe(1);
	});
});

describe("pnpm-global update execution", () => {
	it("proves ownership, installs the exact pair, and verifies the pnpm-owned Unix shim", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		await usePnpmEntrypoint();
		expect(pnpmRoot()).toContain(join("global", "v11"));
		expect(realpathSync(pnpmPackagePath("codemem"))).toBe(
			realpathSync(canonicalPnpmPackagePath("codemem")),
		);
		expect(realpathSync(pnpmPackagePath("codemem"))).toContain(
			join(".pnpm", "codemem@0.40.2_better-sqlite3@12.6.2"),
		);
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		const originalRegistry = process.env.NPM_CONFIG_REGISTRY;
		const originalScopedRegistry = process.env["npm_config_@codemem:registry"];
		const originalOnnxPolicy = process.env.OnnxRuntime_Node_Install;
		process.env.NPM_CONFIG_REGISTRY = "https://untrusted.invalid/";
		process.env["npm_config_@codemem:registry"] = "https://untrusted-scope.invalid/";
		process.env.OnnxRuntime_Node_Install = "build";
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: updatedPnpmListState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await parseUpdateCommand(["install", "--json"]);
		} finally {
			if (originalRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY;
			else process.env.NPM_CONFIG_REGISTRY = originalRegistry;
			if (originalScopedRegistry === undefined) {
				delete process.env["npm_config_@codemem:registry"];
			} else {
				process.env["npm_config_@codemem:registry"] = originalScopedRegistry;
			}
			if (originalOnnxPolicy === undefined) delete process.env.OnnxRuntime_Node_Install;
			else process.env.OnnxRuntime_Node_Install = originalOnnxPolicy;
		}

		expect(spawn.mock.calls.map(([, args]) => args)).toEqual([
			["root", "-g"],
			["bin", "-g"],
			["list", "-g", "--depth", "0", "--json"],
			[
				"add",
				"-g",
				"--registry",
				"https://registry.npmjs.org/",
				"--config.@codemem:registry=https://registry.npmjs.org/",
				"codemem@0.41.0",
				"@codemem/embeddings@0.41.0",
			],
			["list", "-g", "--depth", "0", "--json"],
			["version"],
		]);
		const installOptions = spawn.mock.calls[3]?.[2];
		expect(realpathSync(pnpmUpdateCwd())).toContain(".codemem");
		expect(installOptions).toEqual(
			expect.objectContaining({
				cwd: pnpmUpdateCwd(),
				env: expect.objectContaining({
					ONNXRUNTIME_NODE_INSTALL: "skip",
					npm_config_registry: "https://registry.npmjs.org/",
					"npm_config_@codemem:registry": "https://registry.npmjs.org/",
				}),
				shell: false,
			}),
		);
		expect(installOptions?.env).not.toHaveProperty("NPM_CONFIG_REGISTRY");
		expect(installOptions?.env).not.toHaveProperty("OnnxRuntime_Node_Install");
		expect(spawn.mock.calls[3]?.[1].join(" ")).not.toMatch(/allow-build|approve-builds/);
		for (const callIndex of [0, 1, 2, 4]) {
			expect(spawn.mock.calls[callIndex]?.[2]).toEqual(
				expect.objectContaining({ cwd: pnpmUpdateCwd(), shell: false }),
			);
		}
		expect(spawn).toHaveBeenNthCalledWith(
			6,
			join(canonicalPnpmBin(), "codemem"),
			["version"],
			expect.objectContaining({ cwd: pnpmUpdateCwd(), shell: false }),
		);
		expect(process.exitCode).toBeUndefined();
	});
});

describe("pnpm-global compatibility", () => {
	it("accepts pnpm 9-11 list metadata and node_modules root semantics", async () => {
		await useLegacyPnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		const legacyState = (version: string) =>
			pnpmListState({
				codememPath: legacyPnpmPackagePath("codemem"),
				codememVersion: version,
				embeddingsPath: legacyPnpmPackagePath("embeddings"),
				embeddingsVersion: version,
				private: false,
				rootPath: legacyPnpmListRoot(),
			});
		spawn
			.mockImplementationOnce(() =>
				commandProcess({ stdout: `${join(legacyPnpmListRoot(), "node_modules")}\n` }),
			)
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: legacyState("0.40.2") }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: legacyState("0.41.0") }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn.mock.calls[2]?.[1]).toEqual(["list", "-g", "--depth", "0", "--json"]);
		expect(process.exitCode).toBeUndefined();
	});

	it("ignores benign notice lines around the one existing root and bin directory", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() =>
				commandProcess({ stdout: `Update available: run pnpm self-update\n${pnpmRoot()}\n` }),
			)
			.mockImplementationOnce(() =>
				commandProcess({ stdout: `WARN using configured global bin\n${pnpmBin()}\n` }),
			)
			.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: updatedPnpmListState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(process.exitCode).toBeUndefined();
	});
});

describe("pnpm-global ownership probe validation", () => {
	it.each([
		["malformed JSON", "{not-json"],
		["an empty result", "[]"],
		[
			"ambiguous results",
			JSON.stringify([
				{ dependencies: { codemem: { path: "/one", version: "0.40.2" } } },
				{ dependencies: { codemem: { path: "/two", version: "0.40.2" } } },
			]),
		],
		["a missing dependency map", JSON.stringify([{ name: "global" }])],
		["a relative list root", pnpmListState({ rootPath: "relative/global/5" })],
		[
			"an invalid codemem record",
			JSON.stringify([
				{
					path: pnpmRoot(),
					private: false,
					dependencies: { codemem: { path: pnpmPackagePath("codemem") } },
				},
			]),
		],
		["a relative package path", pnpmListState({ codememPath: "relative/node_modules/codemem" })],
	])("refuses %s from the bounded package-state probe", async (_label, listOutput) => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: listOutput }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message: "pnpm list -g returned malformed or ambiguous global package state",
		});
		expect(spawn).toHaveBeenCalledTimes(3);
	});

	it("accepts real top-level private false metadata", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState({ private: false }) }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() =>
				commandProcess({ stdout: updatedPnpmListState({ private: false }) }),
			)
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(process.exitCode).toBeUndefined();
	});
});

describe("pnpm-global path ownership safeguards", () => {
	it.each([
		{ args: ["root", "-g"], label: "root" },
		{ args: ["bin", "-g"], label: "bin" },
		{ args: ["list", "-g", "--depth", "0", "--json"], label: "list" },
	])("reports a failed pnpm $label probe before mutation", async ({ args: failedArgs }) => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		const results: Array<Parameters<typeof commandProcess>[0]> = [
			{ stdout: `${pnpmRoot()}\n` },
			{ stdout: `${pnpmBin()}\n` },
			{ stdout: pnpmListState() },
		];
		const failedIndex = [
			["root", "-g"],
			["bin", "-g"],
			["list", "-g", "--depth", "0", "--json"],
		].findIndex((args) => args.join("\0") === failedArgs.join("\0"));
		results[failedIndex] = { exitCode: 1, stderr: "probe failed\n", stdout: "" };
		for (const result of results) {
			spawn.mockImplementationOnce(() => commandProcess(result));
		}
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message: `pnpm ${failedArgs.join(" ")} failed: probe failed`,
		});
		expect(spawn).toHaveBeenCalledTimes(failedIndex + 1);
	});

	it("refuses a pnpm package version that differs from the running CLI", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() =>
				commandProcess({ stdout: pnpmListState({ codememVersion: "0.39.0" }) }),
			);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message: "pnpm global codemem is 0.39.0, but the running CLI is 0.40.2",
		});
		expect(spawn).toHaveBeenCalledTimes(3);
	});

	it("refuses ambiguous root output containing two existing absolute directories", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message: "pnpm root -g did not return one absolute non-root path",
		});
		expect(spawn).toHaveBeenCalledTimes(3);
	});

	it("returns pnpm setup guidance for a missing global bin directory", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn.mockImplementationOnce(() =>
			commandProcess({
				exitCode: 1,
				stderr:
					' ERROR  The configured global bin directory "/home/user/.local/share/pnpm" is not in PATH\nFor help, run: pnpm help root\n',
			}),
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message: "Run pnpm setup, then retry codemem update install",
		});
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("bounds pnpm ownership output before parsing", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: "x".repeat(65 * 1_024) }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message: "pnpm list -g --depth 0 --json returned too much output; inspect pnpm global state",
		});
		expect(spawn).toHaveBeenCalledTimes(3);
	});
});

describe("pnpm-global package ownership safeguards", () => {
	it.each([
		{
			bin: "/",
			expectedMessage: "pnpm bin -g did not return one absolute non-root path",
			label: "root bin directory",
			list: () => pnpmListState(),
			root: (): string => pnpmRoot(),
		},
		{
			bin: () => pnpmBin(),
			expectedMessage: "pnpm list -g root does not own the listed codemem package path",
			label: "package outside root",
			list: () => pnpmListState({ codememPath: join(testHome, "other", "codemem") }),
			root: (): string => pnpmRoot(),
			setup: () => mkdir(join(testHome, "other", "codemem"), { recursive: true }),
		},
		{
			bin: () => pnpmBin(),
			expectedMessage: "pnpm root -g did not return one absolute non-root path",
			label: "root path",
			list: () => pnpmListState(),
			root: (): string => "/",
		},
		{
			bin: () => pnpmBin(),
			expectedMessage:
				"pnpm root -g is neither the pnpm list -g root nor its node_modules directory",
			label: "listed root",
			list: () => pnpmListState({ rootPath: join(testHome, "other-root") }),
			root: (): string => pnpmRoot(),
			setup: () => mkdir(join(testHome, "other-root"), { recursive: true }),
		},
	])("refuses a $label mismatch", async ({ bin, expectedMessage, list, root, setup }) => {
		await usePnpmEntrypoint();
		await setup?.();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		const binOutput = typeof bin === "function" ? bin() : bin;
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${root()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${binOutput}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: list() }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message: expectedMessage,
		});
		expect(spawn).toHaveBeenCalledTimes(3);
		expect(process.exitCode).toBe(1);
	});
});

describe("pnpm-global entry ownership safeguards", () => {
	it("refuses when pnpm package ownership does not include the running entry", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() =>
				commandProcess({ stdout: pnpmListState({ codememPath: pnpmPackagePath("embeddings") }) }),
			);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message: "the pnpm global codemem package does not own the running JavaScript entry",
		});
		expect(spawn).toHaveBeenCalledTimes(3);
	});

	it("does not trust a pnpm-global environment marker without entry-path ownership", async () => {
		await usePnpmEntrypoint();
		const outsideEntry = join(testHome, "other", "index.js");
		await mkdir(join(testHome, "other"), { recursive: true });
		await writeFile(outsideEntry, "#!/usr/bin/env node\n", "utf8");
		process.argv[1] = outsideEntry;
		const originalInstallKind = process.env.CODEMEM_INSTALL_KIND;
		process.env.CODEMEM_INSTALL_KIND = "pnpm-global";
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await parseUpdateCommand(["install", "--json"]);
		} finally {
			if (originalInstallKind === undefined) delete process.env.CODEMEM_INSTALL_KIND;
			else process.env.CODEMEM_INSTALL_KIND = originalInstallKind;
		}

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message: "the pnpm global codemem package does not own the running JavaScript entry",
		});
		expect(spawn).toHaveBeenCalledTimes(3);
	});

	it("reports a missing pnpm executable before mutation", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		const missingPnpm = Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" });
		spawn.mockImplementationOnce(() => commandProcess({ error: missingPnpm }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message: "pnpm was not found on PATH; install pnpm, then retry codemem update install",
		});
		expect(spawn).toHaveBeenCalledTimes(1);
	});
});

describe("pnpm-global install and verification failures", () => {
	it("reports pnpm install failure without attempting verification", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }))
			.mockImplementationOnce(() => commandProcess({ exitCode: 1, stderr: "pnpm add failed\n" }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_failed",
			message: "pnpm add failed",
		});
		expect(spawn).toHaveBeenCalledTimes(4);
	});

	it("verifies state after an oversized successful pnpm install", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }))
			.mockImplementationOnce(() => commandProcess({ exitCode: 0, stdout: "x".repeat(65 * 1_024) }))
			.mockImplementationOnce(() => commandProcess({ stdout: updatedPnpmListState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			installed_version: "0.41.0",
			previous_version: "0.40.2",
		});
		expect(spawn).toHaveBeenCalledTimes(6);
		expect(process.exitCode).toBeUndefined();
	});

	it("returns pnpm setup guidance when installation reports a missing global bin directory", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }))
			.mockImplementationOnce(() =>
				commandProcess({
					exitCode: 1,
					stderr: "ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH Configure PNPM_HOME first\n",
				}),
			);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_failed",
			message: "Run pnpm setup, then retry codemem update install",
		});
		expect(spawn).toHaveBeenCalledTimes(4);
	});
});

describe("pnpm-global post-install package verification", () => {
	it.each([
		{
			expectedMessage:
				"pnpm update completed, but global package versions do not both equal 0.41.0",
			label: "stale package versions",
			state: () => pnpmListState({ codememVersion: "0.40.2", embeddingsVersion: "0.40.2" }),
		},
		{
			expectedMessage:
				"pnpm update completed, but @codemem/embeddings is absent from global package state",
			label: "a missing paired package",
			state: () => updatedPnpmListState({ includeEmbeddings: false }),
		},
		{
			expectedMessage:
				"pnpm update completed, but the pnpm list -g root does not own both package paths",
			label: "a package path outside the proven root",
			setup: () => mkdir(join(testHome, "other", "embeddings"), { recursive: true }),
			state: () => updatedPnpmListState({ embeddingsPath: join(testHome, "other", "embeddings") }),
		},
		{
			expectedMessage:
				"pnpm update completed, but the pnpm list -g root changed after ownership was proven",
			label: "a changed listed root",
			setup: () => mkdir(join(testHome, "other-root"), { recursive: true }),
			state: () => updatedPnpmListState({ rootPath: join(testHome, "other-root") }),
		},
	])(
		"fails post-install verification for $label",
		async ({ expectedMessage, setup, state: postInstallState }) => {
			await usePnpmEntrypoint();
			await setup?.();
			getUpdateStatus.mockResolvedValue(pnpmStatus);
			spawn
				.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
				.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
				.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }))
				.mockImplementationOnce(() => commandProcess())
				.mockImplementationOnce(() => commandProcess({ stdout: postInstallState() }));
			const log = vi.spyOn(console, "log").mockImplementation(() => {});

			await parseUpdateCommand(["install", "--json"]);

			expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
				error: "update_verification_failed",
				message: expectedMessage,
			});
			expect(spawn).toHaveBeenCalledTimes(5);
		},
	);

	it.each([
		{
			expectedMessage:
				"pnpm update completed, but package-state verification failed: pnpm list -g --depth 0 --json failed: post-install list failed",
			label: "fails",
			result: { exitCode: 1, stderr: "post-install list failed\n" },
		},
		{
			expectedMessage:
				"pnpm update completed, but package-state verification failed: pnpm list -g --depth 0 --json returned too much output; inspect pnpm global state",
			label: "exceeds the output bound",
			result: { stdout: "x".repeat(65 * 1_024) },
		},
	])(
		"fails verification when the post-install package probe $label",
		async ({ expectedMessage, result }) => {
			await usePnpmEntrypoint();
			getUpdateStatus.mockResolvedValue(pnpmStatus);
			spawn
				.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
				.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
				.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }))
				.mockImplementationOnce(() => commandProcess())
				.mockImplementationOnce(() => commandProcess(result));
			const log = vi.spyOn(console, "log").mockImplementation(() => {});

			await parseUpdateCommand(["install", "--json"]);

			expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
				error: "update_verification_failed",
				message: expectedMessage,
			});
			expect(spawn).toHaveBeenCalledTimes(5);
		},
	);
});

describe("pnpm-global launcher verification", () => {
	it("accepts benign launcher notices around one target-version line", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: updatedPnpmListState() }))
			.mockImplementationOnce(() =>
				commandProcess({ stdout: "A newer pnpm is available\n0.41.0\nRun pnpm self-update\n" }),
			);
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(process.exitCode).toBeUndefined();
	});

	it("fails when the exact pnpm-owned shim reports another version", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: updatedPnpmListState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.40.2\n" }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_verification_failed",
			message: "pnpm-owned codemem launcher did not report 0.41.0",
		});
		expect(spawn.mock.calls[5]?.[0]).toBe(join(canonicalPnpmBin(), "codemem"));
	});

	it("refuses launcher output containing more than one version line", async () => {
		await usePnpmEntrypoint();
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: updatedPnpmListState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.40.2\n0.41.0\n" }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_verification_failed",
			message: "pnpm-owned codemem launcher did not report 0.41.0",
		});
	});
});

describe("pnpm-global update execution on Windows", () => {
	it("uses the bounded pnpm.cmd wrapper and the exact bin-directory codemem.cmd shim", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		await usePnpmEntrypoint();
		const originalSystemRoot = process.env.SystemRoot;
		const systemRoot = join(tmpdir(), "Windows");
		const system32 = join(systemRoot, "System32");
		const pnpmShim = join(system32, "pnpm.cmd");
		process.env.SystemRoot = systemRoot;
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmShim}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmRoot()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: `${pnpmBin()}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: pnpmListState() }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: updatedPnpmListState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await parseUpdateCommand(["install", "--json"]);
		} finally {
			if (originalSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = originalSystemRoot;
		}

		expect(spawn.mock.calls.slice(1, 4).map(([, args]) => args)).toEqual([
			["/d", "/s", "/c", `""${pnpmShim}" root -g"`],
			["/d", "/s", "/c", `""${pnpmShim}" bin -g"`],
			["/d", "/s", "/c", `""${pnpmShim}" list -g --depth 0 --json"`],
		]);
		for (const callIndex of [1, 2, 3, 4, 5, 6]) {
			expect(spawn.mock.calls[callIndex]?.[2]).toEqual(
				expect.objectContaining({ cwd: pnpmUpdateCwd(), shell: false }),
			);
		}
		expect(spawn).toHaveBeenNthCalledWith(
			5,
			join(system32, "cmd.exe"),
			[
				"/d",
				"/s",
				"/c",
				`""${pnpmShim}" add -g --registry https://registry.npmjs.org/ --config.@codemem:registry=https://registry.npmjs.org/ codemem@0.41.0 @codemem/embeddings@0.41.0"`,
			],
			expect.objectContaining({ shell: false, windowsVerbatimArguments: true }),
		);
		expect(spawn).toHaveBeenNthCalledWith(
			7,
			join(system32, "cmd.exe"),
			["/d", "/s", "/c", `""${join(canonicalPnpmBin(), "codemem.cmd")}" version"`],
			expect.objectContaining({ shell: false, windowsVerbatimArguments: true }),
		);
		expect(process.exitCode).toBeUndefined();
	});
});

describe("pnpm-global Windows shim resolution safeguards", () => {
	it("maps a missing pnpm.cmd shim to the pnpm recovery error", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		await usePnpmEntrypoint();
		const originalSystemRoot = process.env.SystemRoot;
		process.env.SystemRoot = join(tmpdir(), "Windows");
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn.mockImplementationOnce(() => commandProcess({ exitCode: 1 }));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await parseUpdateCommand(["install", "--json"]);
		} finally {
			if (originalSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = originalSystemRoot;
		}

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message: "pnpm was not found on PATH; install pnpm, then retry codemem update install",
		});
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("rejects oversized where.exe output before accepting a pnpm.cmd shim", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		await usePnpmEntrypoint();
		const originalSystemRoot = process.env.SystemRoot;
		const systemRoot = join(tmpdir(), "Windows");
		const pnpmShim = join(systemRoot, "System32", "pnpm.cmd");
		process.env.SystemRoot = systemRoot;
		getUpdateStatus.mockResolvedValue(pnpmStatus);
		spawn.mockImplementationOnce(() =>
			commandProcess({ stdoutChunks: [`${pnpmShim}\n`, "x".repeat(65 * 1_024)] }),
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await parseUpdateCommand(["install", "--json"]);
		} finally {
			if (originalSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = originalSystemRoot;
		}

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_refused",
			message: "unable to resolve pnpm.cmd: where.exe output too large",
		});
		expect(spawn).toHaveBeenCalledTimes(1);
	});
});

describe("update install command on Windows", () => {
	it("pins the public default and scoped registries in the Windows install command", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const originalSystemRoot = process.env.SystemRoot;
		const systemRoot = join(tmpdir(), "Windows");
		const system32 = join(systemRoot, "System32");
		const npmShim = join(system32, "npm.cmd");
		const codememShim = join(system32, "codemem.cmd");
		process.env.SystemRoot = systemRoot;
		getUpdateStatus.mockResolvedValue({ ...availableStatus, auto_update_eligible: true });
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${npmShim}\n` }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: `${codememShim}\n` }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await parseUpdateCommand(["install", "--json"]);
		} finally {
			if (originalSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = originalSystemRoot;
		}

		expect(spawn).toHaveBeenNthCalledWith(
			2,
			join(system32, "cmd.exe"),
			[
				"/d",
				"/s",
				"/c",
				`""${npmShim}" install -g --registry https://registry.npmjs.org/ --@codemem:registry=https://registry.npmjs.org/ codemem@0.41.0 @codemem/embeddings@0.41.0"`,
			],
			expect.objectContaining({ shell: false, windowsVerbatimArguments: true }),
		);
		expect(process.exitCode).toBeUndefined();
	});
});

describe("Windows updater shim output safeguards", () => {
	it("rejects oversized where.exe output before accepting an npm.cmd shim", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const originalSystemRoot = process.env.SystemRoot;
		const systemRoot = join(tmpdir(), "Windows");
		const npmShim = join(systemRoot, "System32", "npm.cmd");
		process.env.SystemRoot = systemRoot;
		getUpdateStatus.mockResolvedValue({ ...availableStatus, auto_update_eligible: true });
		spawn.mockImplementationOnce(() =>
			commandProcess({ stdoutChunks: [`${npmShim}\n`, "x".repeat(65 * 1_024)] }),
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await parseUpdateCommand(["install", "--json"]);
		} finally {
			if (originalSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = originalSystemRoot;
		}

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_failed",
			message: "unable to resolve npm.cmd: where.exe output too large",
		});
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("rejects oversized where.exe output before accepting a codemem.cmd shim", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		const originalSystemRoot = process.env.SystemRoot;
		const systemRoot = join(tmpdir(), "Windows");
		const system32 = join(systemRoot, "System32");
		const npmShim = join(system32, "npm.cmd");
		const codememShim = join(system32, "codemem.cmd");
		process.env.SystemRoot = systemRoot;
		getUpdateStatus.mockResolvedValue({ ...availableStatus, auto_update_eligible: true });
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: `${npmShim}\n` }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() =>
				commandProcess({ stdoutChunks: [`${codememShim}\n`, "x".repeat(65 * 1_024)] }),
			);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await parseUpdateCommand(["install", "--json"]);
		} finally {
			if (originalSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = originalSystemRoot;
		}

		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
			error: "update_install_failed",
			message: "unable to resolve codemem.cmd: where.exe output too large",
		});
		expect(spawn).toHaveBeenCalledTimes(3);
	});
});

describe("mise update install command on Windows", () => {
	beforeEach(useMiseEntrypoint);
	it("uses direct argv and Windows-safe spawn options", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		getUpdateStatus.mockResolvedValue(miseStatus);
		spawn
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: globalMiseState() }))
			.mockImplementationOnce(() => commandProcess())
			.mockImplementationOnce(() => commandProcess({ stdout: updatedGlobalMiseState() }))
			.mockImplementationOnce(() => commandProcess({ stdout: "0.41.0\n" }));
		vi.spyOn(console, "log").mockImplementation(() => {});

		await parseUpdateCommand(["install", "--json"]);

		expect(spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
			["mise", ["ls", "npm:codemem", "--current", "--json"]],
			["mise", ["ls", "npm:codemem", "--global", "--json"]],
			["mise", ["use", "-g", "npm:codemem@0.41.0"]],
			["mise", ["ls", "npm:codemem", "--global", "--json"]],
			["mise", ["exec", "--", "codemem", "version"]],
		]);
		expect(spawn.mock.calls[2]?.[2]).toEqual(
			expect.objectContaining({
				detached: false,
				env: expect.objectContaining({
					npm_config_registry: "https://registry.npmjs.org/",
					"npm_config_@codemem:registry": "https://registry.npmjs.org/",
				}),
				shell: false,
				windowsVerbatimArguments: undefined,
			}),
		);
		expect(process.exitCode).toBeUndefined();
	});
});

describe("update install command behavior", () => {
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
