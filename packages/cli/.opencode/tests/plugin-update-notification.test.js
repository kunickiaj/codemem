import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const spawnMock = vi.fn();
const execSyncMock = vi.fn(() => "test-version");

vi.mock("node:child_process", () => ({
	spawn: (...args) => spawnMock(...args),
	execSync: (...args) => execSyncMock(...args),
}));

const currentStatus = {
	current_version: "0.40.2",
	latest_version: "0.40.2",
	update_available: false,
	first_seen_at: "2026-08-10T12:00:00.000Z",
	checked_at: "2026-08-10T12:00:00.000Z",
	stale: false,
	install_kind: "npm-global",
	auto_update_eligible: false,
	recommended_action: "No action required; codemem is up to date.",
	error: null,
};

const compatibleStatus = {
	...currentStatus,
	current_version: "0.41.0",
	latest_version: "0.41.0",
};

const availableStatus = {
	...currentStatus,
	latest_version: "0.41.0",
	update_available: true,
	recommended_action: "npm install -g codemem@0.41.0",
};

function makeProcess(
	{ stdout = "", stderr = "", exitCode = 0, settle = true, emitSpawn = false } = {},
) {
	const proc = new EventEmitter();
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdin = { write: vi.fn(), end: vi.fn() };
	proc.kill = vi.fn();
	proc.unref = vi.fn();
	if (emitSpawn) queueMicrotask(() => proc.emit("spawn"));
	if (settle) {
		queueMicrotask(() => {
			if (stdout) proc.stdout.emit("data", stdout);
			if (stderr) proc.stderr.emit("data", stderr);
			proc.emit("exit", exitCode);
		});
	}
	return proc;
}

function installSpawnResult(status = availableStatus) {
	spawnMock.mockImplementation((_command, args) => {
		if (args?.includes("update") && args?.includes("check")) {
			return makeProcess({ stdout: JSON.stringify(status) });
		}
		if (args?.includes("version")) return makeProcess({ stdout: "0.40.2\n" });
		return makeProcess();
	});
}

function installCompatibilityAutoUpdateSpawnResult({ startViewer = false } = {}) {
	let versionCallCount = 0;
	spawnMock.mockImplementation((_command, args) => {
		if (startViewer && args?.includes("serve") && args?.includes("start")) {
			return makeProcess({ emitSpawn: true });
		}
		if (args?.includes("version")) {
			versionCallCount += 1;
			return makeProcess({
				stdout: versionCallCount === 1 ? "0.40.2\n" : "0.41.0\n",
			});
		}
		if (args?.includes("update") && args?.includes("check")) {
			return makeProcess({ stdout: JSON.stringify(compatibleStatus) });
		}
		return makeProcess();
	});
	return () => versionCallCount;
}

async function startPlugin(showToast = vi.fn().mockResolvedValue(undefined)) {
	const { CodememPlugin } = await import("../plugins/codemem.js");
	const hooks = await CodememPlugin({
		project: { name: "codemem" },
		client: {
			app: { log: vi.fn().mockResolvedValue(undefined) },
			tui: { showToast },
		},
		directory: "/tmp/codemem",
		worktree: "/tmp/codemem",
	});
	return { hooks, showToast };
}

async function runStartupChecks() {
	await vi.advanceTimersByTimeAsync(1_500);
	await vi.runAllTicks();
}

function mockViewerHealthFetch(expectedUrl, status) {
	const unexpectedUrls = [];
	const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const actualUrl = input instanceof Request ? input.url : String(input);
		if (actualUrl !== expectedUrl) {
			unexpectedUrls.push(actualUrl);
			throw new Error(`Unexpected fetch URL: ${actualUrl}`);
		}
		return new Response(null, { status });
	});
	return { fetchMock, unexpectedUrls };
}

describe("@codemem/opencode-plugin exports", () => {
	test("exports CodememPlugin canonically while preserving the legacy alias", async () => {
		const plugin = await import("../plugins/codemem.js");

		expect(plugin.default).toBe(plugin.CodememPlugin);
		expect(plugin.OpencodeMemPlugin).toBe(plugin.CodememPlugin);
	});
});

describe("OpenCode startup release notifications", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		spawnMock.mockReset();
		execSyncMock.mockClear();
		process.env = {
			...originalEnv,
			CODEMEM_RUNNER: "codemem",
			CODEMEM_VIEWER: "0",
			CODEMEM_PLUGIN_LOG: "0",
			CODEMEM_INJECT_CONTEXT: "0",
			CODEMEM_BACKEND_UPDATE_POLICY: "notify",
		};
		delete process.env.CODEMEM_MIN_VERSION;
		delete process.env.CODEMEM_RUNNER_FROM;
		delete process.env.CODEMEM_DB;
		delete process.env.CODEMEM_CONFIG;
		delete process.env.CODEMEM_VIEWER_AUTO;
		delete process.env.CODEMEM_VIEWER_HOST;
		delete process.env.CODEMEM_VIEWER_PORT;
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		process.env = originalEnv;
	});

	test("runs `codemem update check --json` asynchronously through the existing runner", async () => {
		// Arrange
		installSpawnResult();

		// Act
		const { hooks } = await startPlugin();
		const callsBeforeDelay = spawnMock.mock.calls.length;
		await runStartupChecks();

		// Assert
		expect(hooks).toBeTypeOf("object");
		expect(callsBeforeDelay).toBe(0);
		expect(spawnMock).toHaveBeenCalledWith(
			"codemem",
			expect.arrayContaining(["update", "check", "--json"]),
			expect.objectContaining({ cwd: "/tmp/codemem" }),
		);
		const updateCall = spawnMock.mock.calls.find((call) => call[1]?.includes("update"));
		expect(updateCall?.[2]).not.toHaveProperty("shell");
	});

	test("notify shows an actionable release toast only once for the same latest version", async () => {
		// Arrange
		installSpawnResult();
		const showToast = vi.fn().mockResolvedValue(undefined);

		// Act
		await startPlugin(showToast);
		await runStartupChecks();
		await startPlugin(showToast);
		await runStartupChecks();

		// Assert
		expect(showToast).toHaveBeenCalledTimes(1);
		expect(showToast).toHaveBeenCalledWith({
			body: expect.objectContaining({
				message: expect.stringMatching(/0\.41\.0.*npm install -g codemem@0\.41\.0/i),
			}),
		});
	});

	test("notify allows a new toast when the discovered latest version changes", async () => {
		// Arrange
		let status = availableStatus;
		spawnMock.mockImplementation((_command, args) => {
			if (args?.includes("update") && args?.includes("check")) {
				return makeProcess({ stdout: JSON.stringify(status) });
			}
			if (args?.includes("version")) return makeProcess({ stdout: "0.40.2\n" });
			return makeProcess();
		});
		const showToast = vi.fn().mockResolvedValue(undefined);

		// Act
		await startPlugin(showToast);
		await runStartupChecks();
		status = {
			...availableStatus,
			latest_version: "0.42.0",
			recommended_action: "npm install -g codemem@0.42.0",
		};
		await startPlugin(showToast);
		await runStartupChecks();

		// Assert
		expect(showToast).toHaveBeenCalledTimes(2);
		expect(showToast.mock.calls[1]?.[0]?.body?.message).toMatch(/0\.42\.0/);
	});

	test("off skips release discovery and notification without disabling compatibility checks", async () => {
		// Arrange
		process.env.CODEMEM_BACKEND_UPDATE_POLICY = "off";
		installSpawnResult();
		const showToast = vi.fn().mockResolvedValue(undefined);

		// Act
		await startPlugin(showToast);
		await runStartupChecks();

		// Assert
		const args = spawnMock.mock.calls.map((call) => call[1]);
		expect(args.some((value) => value?.includes("version"))).toBe(true);
		expect(args.some((value) => value?.includes("update"))).toBe(false);
		expect(showToast).not.toHaveBeenCalled();
	});

	test("auto installs an eligible release through the guarded CLI command", async () => {
		// Arrange
		process.env.CODEMEM_BACKEND_UPDATE_POLICY = "auto";
		installSpawnResult({ ...availableStatus, auto_update_eligible: true });
		const showToast = vi.fn().mockResolvedValue(undefined);

		// Act
		await startPlugin(showToast);
		await runStartupChecks();

		// Assert
		const args = spawnMock.mock.calls.map((call) => call[1]);
		expect(args.some((value) => value?.includes("update") && value?.includes("check"))).toBe(true);
		expect(args.some((value) => value?.includes("update") && value?.includes("install"))).toBe(true);
		expect(showToast).toHaveBeenCalledTimes(1);
		expect(showToast.mock.calls[0]?.[0]?.body).toMatchObject({
			message: "Updated codemem to 0.41.0.",
			variant: "success",
		});
	});

	test("auto restarts the plugin-owned viewer after an eligible update succeeds", async () => {
		// Arrange
		process.env.CODEMEM_BACKEND_UPDATE_POLICY = "auto";
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "1";
		process.env.CODEMEM_VIEWER_HOST = "127.0.0.9";
		process.env.CODEMEM_VIEWER_PORT = "48765";
		process.env.CODEMEM_DB = "/tmp/codemem/viewer.sqlite";
		process.env.CODEMEM_CONFIG = "/tmp/codemem/config.json";
		const { fetchMock, unexpectedUrls } = mockViewerHealthFetch(
			"http://127.0.0.9:48765/api/health",
			503,
		);
		spawnMock.mockImplementation((_command, args) => {
			if (args?.includes("serve") && args?.includes("start")) {
				return makeProcess({ emitSpawn: true });
			}
			if (args?.includes("update") && args?.includes("check")) {
				return makeProcess({
					stdout: JSON.stringify({ ...availableStatus, auto_update_eligible: true }),
				});
			}
			if (args?.includes("version")) return makeProcess({ stdout: "0.40.2\n" });
			return makeProcess();
		});

		// Act
		await startPlugin();
		await vi.advanceTimersByTimeAsync(0);
		await runStartupChecks();

		// Assert
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.9:48765/api/health",
			expect.objectContaining({ method: "GET", redirect: "manual" }),
		);
		expect(unexpectedUrls).toEqual([]);
		expect(spawnMock).toHaveBeenCalledWith(
			"codemem",
			[
				"serve",
				"start",
				"--host",
				"127.0.0.9",
				"--port",
				"48765",
				"--db-path",
				"/tmp/codemem/viewer.sqlite",
				"--config",
				"/tmp/codemem/config.json",
			],
			expect.objectContaining({ cwd: "/tmp/codemem", detached: true }),
		);
		const installIndex = spawnMock.mock.calls.findIndex(
			(call) => call[1]?.includes("update") && call[1]?.includes("install"),
		);
		const restartIndex = spawnMock.mock.calls.findIndex(
			(call) => call[1]?.includes("serve") && call[1]?.includes("restart"),
		);
		expect(installIndex).toBeGreaterThanOrEqual(0);
		expect(restartIndex).toBeGreaterThan(installIndex);
		expect(spawnMock).toHaveBeenCalledWith(
			"codemem",
			[
				"serve",
				"restart",
				"--host",
				"127.0.0.9",
				"--port",
				"48765",
				"--db-path",
				"/tmp/codemem/viewer.sqlite",
				"--config",
				"/tmp/codemem/config.json",
			],
			expect.objectContaining({ cwd: "/tmp/codemem" }),
		);
		expect(
			spawnMock.mock.calls.filter(
				(call) => call[1]?.includes("serve") && call[1]?.includes("restart"),
			),
		).toHaveLength(1);
	});

	test("auto does not restart a viewer that was already running before plugin startup", async () => {
		// Arrange
		process.env.CODEMEM_BACKEND_UPDATE_POLICY = "auto";
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "1";
		process.env.CODEMEM_VIEWER_HOST = "127.0.0.1";
		process.env.CODEMEM_VIEWER_PORT = "38888";
		const { fetchMock, unexpectedUrls } = mockViewerHealthFetch(
			"http://127.0.0.1:38888/api/health",
			200,
		);
		installSpawnResult({ ...availableStatus, auto_update_eligible: true });

		// Act
		await startPlugin();
		await vi.advanceTimersByTimeAsync(0);
		await runStartupChecks();

		// Assert
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:38888/api/health",
			expect.objectContaining({ method: "GET", redirect: "manual" }),
		);
		expect(unexpectedUrls).toEqual([]);
		expect(
			spawnMock.mock.calls.some(
				(call) => call[1]?.includes("update") && call[1]?.includes("install"),
			),
		).toBe(true);
		expect(
			spawnMock.mock.calls.some(
				(call) =>
					call[1]?.includes("serve") &&
					["start", "restart"].some((action) => call[1]?.includes(action)),
			),
		).toBe(false);
	});

	test("compatibility auto-update restarts the plugin-owned viewer after the refreshed CLI is compatible", async () => {
		// Arrange
		process.env.CODEMEM_BACKEND_UPDATE_POLICY = "auto";
		process.env.CODEMEM_MIN_VERSION = "0.41.0";
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "1";
		process.env.CODEMEM_VIEWER_HOST = "127.0.0.7";
		process.env.CODEMEM_VIEWER_PORT = "47777";
		const { fetchMock, unexpectedUrls } = mockViewerHealthFetch(
			"http://127.0.0.7:47777/api/health",
			503,
		);
		const getVersionCallCount = installCompatibilityAutoUpdateSpawnResult({
			startViewer: true,
		});
		const showToast = vi.fn().mockResolvedValue(undefined);

		// Act
		await startPlugin(showToast);
		await vi.advanceTimersByTimeAsync(0);
		await runStartupChecks();
		await vi.waitFor(() => {
			expect(
				spawnMock.mock.calls.some((call) => call[1]?.join(" ") === "update check --json"),
			).toBe(true);
		});

		// Assert
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.7:47777/api/health",
			expect.objectContaining({ method: "GET", redirect: "manual" }),
		);
		expect(unexpectedUrls).toEqual([]);
		expect(getVersionCallCount()).toBe(2);
		const installIndex = spawnMock.mock.calls.findIndex(
			(call) => call[1]?.join(" ") === "update install --json",
		);
		const restartIndex = spawnMock.mock.calls.findIndex(
			(call) => call[1]?.includes("serve") && call[1]?.includes("restart"),
		);
		expect(installIndex).toBeGreaterThanOrEqual(0);
		expect(restartIndex).toBeGreaterThan(installIndex);
		expect(spawnMock).toHaveBeenCalledWith(
			"codemem",
			["serve", "restart", "--host", "127.0.0.7", "--port", "47777"],
			{
				cwd: "/tmp/codemem",
				env: process.env,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		expect(
			spawnMock.mock.calls.filter(
				(call) => call[1]?.includes("serve") && call[1]?.includes("restart"),
			),
		).toHaveLength(1);
		expect(showToast).toHaveBeenCalledWith({
			body: {
				message: "Updated codemem backend from 0.40.2 to 0.41.0.",
				variant: "success",
			},
		});
	});

	test("compatibility auto-update does not restart a pre-existing viewer after verification succeeds", async () => {
		// Arrange
		process.env.CODEMEM_BACKEND_UPDATE_POLICY = "auto";
		process.env.CODEMEM_MIN_VERSION = "0.41.0";
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "1";
		process.env.CODEMEM_VIEWER_HOST = "127.0.0.8";
		process.env.CODEMEM_VIEWER_PORT = "48888";
		const { fetchMock, unexpectedUrls } = mockViewerHealthFetch(
			"http://127.0.0.8:48888/api/health",
			200,
		);
		const getVersionCallCount = installCompatibilityAutoUpdateSpawnResult();
		const showToast = vi.fn().mockResolvedValue(undefined);

		// Act
		await startPlugin(showToast);
		await vi.advanceTimersByTimeAsync(0);
		await runStartupChecks();
		await vi.waitFor(() => {
			expect(
				spawnMock.mock.calls.some((call) => call[1]?.join(" ") === "update check --json"),
			).toBe(true);
		});

		// Assert
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.8:48888/api/health",
			expect.objectContaining({ method: "GET", redirect: "manual" }),
		);
		expect(unexpectedUrls).toEqual([]);
		expect(getVersionCallCount()).toBe(2);
		expect(
			spawnMock.mock.calls.some((call) => call[1]?.join(" ") === "update install --json"),
		).toBe(true);
		expect(
			spawnMock.mock.calls.some(
				(call) =>
					call[1]?.includes("serve") &&
					["start", "restart"].some((action) => call[1]?.includes(action)),
			),
		).toBe(false);
		expect(showToast).toHaveBeenCalledWith({
			body: {
				message: "Updated codemem backend from 0.40.2 to 0.41.0.",
				variant: "success",
			},
		});
	});

	test("auto remains notification-only until the 24-hour eligibility gate opens", async () => {
		process.env.CODEMEM_BACKEND_UPDATE_POLICY = "auto";
		installSpawnResult();
		const showToast = vi.fn().mockResolvedValue(undefined);

		await startPlugin(showToast);
		await runStartupChecks();

		expect(spawnMock.mock.calls.some((call) => call[1]?.includes("install"))).toBe(false);
		expect(showToast.mock.calls[0]?.[0]?.body?.message).toMatch(/0\.41\.0.*npm install/i);
	});

	test("auto does not invoke installation when runner provenance is pinned", async () => {
		process.env.CODEMEM_BACKEND_UPDATE_POLICY = "auto";
		process.env.CODEMEM_RUNNER = "npx";
		process.env.CODEMEM_RUNNER_FROM = "codemem@0.40.2";
		installSpawnResult({ ...availableStatus, auto_update_eligible: true });
		const showToast = vi.fn().mockResolvedValue(undefined);

		await startPlugin(showToast);
		await runStartupChecks();

		expect(spawnMock.mock.calls.some((call) => call[1]?.includes("install"))).toBe(false);
		expect(showToast.mock.calls.at(-1)?.[0]?.body?.message).toMatch(/0\.41\.0/);
	});

	test.each([
		["current", currentStatus, 0],
		["unavailable", { ...currentStatus, latest_version: null, checked_at: null, error: "offline" }, 1],
		["malformed", "not-json", 0],
	])("ignores %s update-check results", async (_label, result, exitCode) => {
		// Arrange
		spawnMock.mockImplementation((_command, args) => {
			if (args?.includes("update") && args?.includes("check")) {
				return makeProcess({
					stdout: typeof result === "string" ? result : JSON.stringify(result),
					exitCode,
				});
			}
			if (args?.includes("version")) return makeProcess({ stdout: "0.40.2\n" });
			return makeProcess();
		});
		const showToast = vi.fn().mockResolvedValue(undefined);

		// Act
		await startPlugin(showToast);
		await runStartupChecks();

		// Assert
		expect(
			spawnMock.mock.calls.some(
				(call) => call[1]?.includes("update") && call[1]?.includes("check") && call[1]?.includes("--json"),
			),
		).toBe(true);
		expect(showToast).not.toHaveBeenCalled();
	});

	test("a hanging update check never blocks plugin startup", async () => {
		// Arrange
		spawnMock.mockImplementation((_command, args) => {
			if (args?.includes("update") && args?.includes("check")) return makeProcess({ settle: false });
			if (args?.includes("version")) return makeProcess({ stdout: "0.40.2\n" });
			return makeProcess();
		});

		// Act
		const startup = startPlugin();
		const result = await startup;
		await runStartupChecks();

		// Assert
		expect(result.hooks).toBeTypeOf("object");
		expect(
			spawnMock.mock.calls.some(
				(call) => call[1]?.includes("update") && call[1]?.includes("check") && call[1]?.includes("--json"),
			),
		).toBe(true);
	});

	test("Docker notifications remain rebuild-only", async () => {
		// Arrange
		installSpawnResult({
			...availableStatus,
			install_kind: "docker",
			recommended_action:
				"Set CODEMEM_VERSION=0.41.0, then run CODEMEM_VERSION=0.41.0 docker compose build --pull and docker compose up -d.",
		});
		const showToast = vi.fn().mockResolvedValue(undefined);

		// Act
		await startPlugin(showToast);
		await runStartupChecks();

		// Assert
		const message = showToast.mock.calls[0]?.[0]?.body?.message ?? "";
		expect(message).toContain("docker compose build --pull");
		expect(message).toContain("docker compose up -d");
		expect(message).not.toMatch(/npm install|codemem update install|self-update/i);
		expect(spawnMock.mock.calls.some((call) => call[1]?.includes("install"))).toBe(false);
	});
});
