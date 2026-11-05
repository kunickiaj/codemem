import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawn: (...args) => spawnMock(...args),
	execSync: () => "test-version",
}));

const HEALTH_URL = "http://127.0.0.1:38888/api/health";
const VIEWER_TARGET = ["--host", "127.0.0.1", "--port", "38888"];

function makeProcess({ exitCode = 0, emitSpawn = false, stdout = "" } = {}) {
	const proc = new EventEmitter();
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdin = { write: vi.fn(), end: vi.fn() };
	proc.kill = vi.fn();
	proc.unref = vi.fn();
	queueMicrotask(() => {
		if (emitSpawn) proc.emit("spawn");
		if (stdout) proc.stdout.emit("data", stdout);
		proc.emit("exit", exitCode);
	});
	return proc;
}

/** What a captured `serve start` prints, as the CLI does in each case. */
const startOutput = { text: "" };
const LAUNCHED = "Viewer started in background (pid 4242) at http://127.0.0.1:38888";
const ALREADY_RUNNING = "Viewer already running at http://127.0.0.1:38888";

function installSpawn() {
	spawnMock.mockImplementation((_command, args, options) =>
		makeProcess({
			emitSpawn: Boolean(options?.detached),
			stdout: !options?.detached && args?.[1] === "start" ? startOutput.text : "",
		}),
	);
}

/** Serves the health route with a status the test can change between probes. */
function mockViewerHealth(initialStatus) {
	const viewer = { status: initialStatus };
	const body = () => JSON.stringify({ service: "codemem-viewer", ready: true });
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url !== HEALTH_URL) throw new Error(`Unexpected fetch URL: ${url}`);
		return new Response(viewer.status === 200 ? body() : null, { status: viewer.status });
	});
	return viewer;
}

const serveCalls = (action) =>
	spawnMock.mock.calls.filter((call) => call[1]?.[0] === "serve" && call[1]?.[1] === action);

async function startPlugin() {
	const { CodememPlugin } = await import("../plugins/codemem.js");
	const hooks = await CodememPlugin({
		project: { name: "codemem" },
		client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
		directory: "/tmp/codemem",
		worktree: "/tmp/codemem",
	});
	await vi.advanceTimersByTimeAsync(0);
	return hooks;
}

const deleteSession = (hooks) =>
	hooks.event({ event: { type: "session.deleted", properties: { info: { id: "sess-1" } } } });

describe("OpenCode shared viewer lifecycle", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		spawnMock.mockReset();
		startOutput.text = LAUNCHED;
		installSpawn();
		process.env = {
			...originalEnv,
			CODEMEM_RUNNER: "codemem",
			CODEMEM_VIEWER: "1",
			CODEMEM_VIEWER_AUTO: "1",
			CODEMEM_PLUGIN_LOG: "0",
			CODEMEM_INJECT_CONTEXT: "0",
			CODEMEM_RAW_EVENTS: "0",
			CODEMEM_BACKEND_UPDATE_POLICY: "off",
		};
		for (const key of [
			"CODEMEM_VIEWER_AUTO_STOP",
			"CODEMEM_VIEWER_HOST",
			"CODEMEM_VIEWER_PORT",
			"CODEMEM_DB",
			"CODEMEM_CONFIG",
			"CODEMEM_RUNNER_FROM",
		]) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		process.env = originalEnv;
	});

	test("session deletion leaves a plugin-started viewer running by default", async () => {
		mockViewerHealth(503);
		const hooks = await startPlugin();
		expect(serveCalls("start")).toHaveLength(1);

		await deleteSession(hooks);

		expect(serveCalls("stop")).toHaveLength(0);
	});

	test("session deletion stops a plugin-started viewer when CODEMEM_VIEWER_AUTO_STOP=1", async () => {
		process.env.CODEMEM_VIEWER_AUTO_STOP = "1";
		mockViewerHealth(503);
		const hooks = await startPlugin();
		expect(serveCalls("start")).toHaveLength(1);

		await deleteSession(hooks);

		expect(serveCalls("stop")).toEqual([
			["codemem", ["serve", "stop", ...VIEWER_TARGET], expect.anything()],
		]);
	});

	test("an instance that found a running viewer still monitors it and recovers with serve start", async () => {
		const viewer = mockViewerHealth(200);
		await startPlugin();
		expect(serveCalls("start")).toHaveLength(0);

		viewer.status = 500;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(serveCalls("start")).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(serveCalls("start")).toEqual([
			[
				"codemem",
				["serve", "start", ...VIEWER_TARGET],
				expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
			],
		]);
		expect(serveCalls("restart")).toHaveLength(0);
	});

	test.each([
		["launched the replacement", LAUNCHED, 1],
		["found another instance's viewer", ALREADY_RUNNING, 0],
	])("after a recovery start that %s, AUTO_STOP stops the viewer only if this instance owns it", async (_name, output, stops) => {
		// Arrange: this instance found a running viewer, so it does not own it yet.
		process.env.CODEMEM_VIEWER_AUTO_STOP = "1";
		startOutput.text = output;
		const viewer = mockViewerHealth(200);
		const hooks = await startPlugin();
		viewer.status = 500;
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(serveCalls("start")).toHaveLength(1);
		// Act
		await deleteSession(hooks);
		// Assert
		expect(serveCalls("stop")).toHaveLength(stops);
	});

	test("repeated health failures never run serve restart and respect the cooldown", async () => {
		const viewer = mockViewerHealth(200);
		await startPlugin();
		viewer.status = 500;

		await vi.advanceTimersByTimeAsync(10 * 60_000);

		// Ten failed probes over ten minutes: recovery at minute 2, then once more
		// after the five-minute cooldown.
		expect(serveCalls("start")).toHaveLength(2);
		expect(serveCalls("restart")).toHaveLength(0);
	});

	test("does not monitor the viewer when auto-start is disabled", async () => {
		process.env.CODEMEM_VIEWER_AUTO = "0";
		const viewer = mockViewerHealth(200);
		await startPlugin();
		viewer.status = 500;

		await vi.advanceTimersByTimeAsync(10 * 60_000);

		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(serveCalls("start")).toHaveLength(0);
	});
});
