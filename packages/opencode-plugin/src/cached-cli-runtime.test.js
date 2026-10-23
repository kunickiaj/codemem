import { EventEmitter } from "node:events";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	execFile: vi.fn(),
	execSync: vi.fn(() => "fixture"),
}));
vi.mock("node:child_process", () => mocks);
const { execFile: realExecFile } = await vi.importActual("node:child_process");
mocks.execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args) =>
	new Promise((resolve, reject) => {
		mocks.execFile(...args, (error, stdout, stderr) =>
			error ? reject(error) : resolve({ stdout, stderr }),
		);
	});
const { __testUtils } = await import("../.opencode/lib/runtime.js");
const PIN = __testUtils.PINNED_BACKEND_VERSION;
const CHANNEL = /-(alpha|beta|rc)\./u.exec(PIN)?.[1] || "latest";
const CROSS_CHANNEL = `${PIN.split("-")[0]}-${CHANNEL === "alpha" ? "beta" : "alpha"}.1`;
let root;
let bin;
let entry;
let runtime;
let originalEnv;
const processResult = ({ stdout = "ok", exitCode = 0 } = {}) => {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
	child.kill = vi.fn();
	child.unref = vi.fn();
	queueMicrotask(() => {
		child.emit("spawn");
		child.stdout.emit("data", stdout);
		child.emit("exit", exitCode);
	});
	return child;
};
const packageFixture = (version = PIN) => {
	const pkg = join(root, "node_modules", "codemem");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({ name: "codemem", version, type: "module", bin: { codemem: "cli.js" } }),
	);
	entry = join(pkg, "cli.js");
	writeFileSync(entry, `process.stdout.write('${version}');`);
	symlinkSync(entry, join(bin, "codemem"));
};
const shimFixture = ({ laterCandidate = false } = {}) => {
	packageFixture();
	rmSync(join(bin, "codemem"));
	writeFileSync(join(bin, "codemem"), `#!/bin/sh\nprintf '${PIN}\\n'\n`);
	chmodSync(join(bin, "codemem"), 0o700);
	if (laterCandidate) {
		const laterBin = join(root, "later-bin");
		mkdirSync(laterBin);
		symlinkSync(entry, join(laterBin, "codemem"));
		process.env.PATH = `${bin}${delimiter}${laterBin}`;
	}
	mocks.execSync.mockReturnValue(PIN);
};
const createRuntime = async () => {
	vi.resetModules();
	const { createCodememRuntime } = await import("../.opencode/lib/runtime.js");
	runtime = await createCodememRuntime({
		location: { project: { name: "fixture", root }, directory: root, worktree: root },
		host: { log: vi.fn(async () => {}), notify: null },
	});
	return runtime;
};

beforeEach(() => {
	vi.useFakeTimers();
	originalEnv = process.env;
	root = realpathSync(mkdtempSync(join(tmpdir(), "codemem-cached-runtime-")));
	bin = join(root, "bin");
	mkdirSync(bin);
	symlinkSync(process.execPath, join(bin, "node"));
	// Never read user configuration or contact a service. Only the fixture CLI's
	// --version runs for real; every operational command remains a fake process.
	process.env = {
		HOME: root,
		PATH: bin,
		CODEMEM_VIEWER: "0",
		CODEMEM_VIEWER_AUTO: "0",
		CODEMEM_RAW_EVENTS: "0",
		CODEMEM_PLUGIN_LOG: "0",
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
	};
	mocks.spawn.mockReset().mockImplementation(() => processResult());
	mocks.execSync.mockReset().mockReturnValue("fixture");
	mocks.execFile.mockReset().mockImplementation((command, args, options, callback) => {
		if (command !== "node") {
			queueMicrotask(() => callback(new Error("npm forbidden")));
			return;
		}
		return realExecFile(command, args, options, callback);
	});
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network forbidden")));
});

afterEach(async () => {
	await runtime?.dispose();
	runtime = null;
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	process.env = originalEnv;
	rmSync(root, { recursive: true, force: true });
});

test.each([PIN, PIN.replace(/\d+$/u, (value) => String(Number(value) + 1))])(
	"default runtime reuses compatible installed %s for multiple tools",
	async (version) => {
		// Arrange
		packageFixture(version);
		await createRuntime();
		// Act
		const stats = await runtime.tools["mem-stats"].execute();
		const recent = await runtime.tools["mem-recent"].execute({ limit: 2 });
		// Assert
		expect([stats, recent]).toEqual(["ok", "ok"]);
		expect(mocks.execFile).toHaveBeenCalledTimes(1);
		expect(mocks.spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
			[realpathSync(process.execPath), [entry, "stats"]],
			[realpathSync(process.execPath), [entry, "recent", "--limit", "2"]],
		]);
	},
);

test.each(["0.0.1", CROSS_CHANNEL])(
	"default runtime rejects incompatible installed %s without executing tools",
	async (version) => {
		// Arrange
		packageFixture(version);
		await createRuntime();
		// Act
		const result = await runtime.tools["mem-stats"].execute();
		// Assert
		expect(result).toContain("CLI runner unavailable");
		expect(mocks.execFile.mock.calls.map(([command]) => command)).toEqual(["node", "npx"]);
		expect(mocks.spawn).not.toHaveBeenCalled();
	},
);

test("never replays an executed failed command or bootstraps on its behalf", async () => {
	// Arrange
	packageFixture();
	mocks.spawn.mockImplementation(() => processResult({ exitCode: 1, stdout: "" }));
	await createRuntime();
	// Act
	const result = await runtime.tools["mem-stats"].execute();
	// Assert
	expect(result).toContain("Failed to fetch stats");
	expect(mocks.spawn).toHaveBeenCalledTimes(1);
	expect(mocks.execFile).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
	"selected installed shim stays on its legacy offline invocation (later candidate: %s)",
	async (laterCandidate) => {
		// Arrange: detectRunner accepts the shim, but its JS entrypoint is unavailable.
		shimFixture({ laterCandidate });
		await createRuntime();
		// Act
		const stats = await runtime.tools["mem-stats"].execute();
		const recent = await runtime.tools["mem-recent"].execute({ limit: 2 });
		// Assert: neither a later PATH executable nor npm replaces the selected shim.
		expect([stats, recent]).toEqual(["ok", "ok"]);
		expect(mocks.execSync).toHaveBeenCalledWith("codemem --version", expect.any(Object));
		expect(mocks.spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
			["codemem", ["stats"]],
			["codemem", ["recent", "--limit", "2"]],
		]);
		expect(mocks.execFile.mock.calls.map(([command, args]) => [command, args.slice(1)])).toEqual([
			["node", ["--selected"]],
		]);
	},
);

test.each([0, 1])(
	"shim autoupdate verifies the logical installed runner only after success (exit %s)",
	async (exitCode) => {
		// Arrange: a later PATH candidate remains on the old pin throughout installation.
		shimFixture({ laterCandidate: true });
		process.env.CODEMEM_BACKEND_UPDATE_POLICY = "auto";
		const newer = PIN.replace(/\d+$/u, (value) => String(Number(value) + 1));
		let installed = false;
		mocks.spawn.mockImplementation((command, args) => {
			if (command === "npm") {
				installed = exitCode === 0;
				return processResult({ exitCode });
			}
			if (command !== "codemem") return processResult({ exitCode: 1 });
			if (args.includes("version")) return processResult({ stdout: installed ? newer : PIN });
			return processResult({
				stdout: JSON.stringify({
					latest_version: newer,
					channel: CHANNEL,
					update_available: true,
					auto_update_eligible: true,
					recommended_action: `npm install -g codemem@${newer}`,
				}),
			});
		});
		await createRuntime();
		// Act
		await vi.advanceTimersByTimeAsync(1500);
		await vi.waitFor(() =>
			expect(mocks.spawn.mock.calls.some(([command]) => command === "npm")).toBe(true),
		);
		await vi.advanceTimersByTimeAsync(0);
		await runtime.tools["mem-stats"].execute();
		// Assert
		expect(
			mocks.spawn.mock.calls
				.filter(([, args]) => args.includes("version"))
				.map(([command, args]) => [command, args]),
		).toEqual(Array.from({ length: exitCode === 0 ? 2 : 1 }, () => ["codemem", ["version"]]));
		expect(mocks.execFile.mock.calls.map(([command, args]) => [command, args.slice(1)])).toEqual(
			Array.from({ length: exitCode === 0 ? 2 : 1 }, () => ["node", ["--selected"]]),
		);
		expect(mocks.spawn.mock.calls.at(-1).slice(0, 2)).toEqual(["codemem", ["stats"]]);
	},
);

test.each(["success", "timeout", "overflow"])(
	"version validation enforces child process limits: %s",
	async (outcome) => {
		// Arrange
		packageFixture();
		const { probeCliCandidate } = await import("../.opencode/lib/cached-cli-runner.js");
		mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
			if (outcome === "success") callback(null, PIN, "");
			else callback(new Error(outcome));
		});
		// Act
		const candidate = await probeCliCandidate({
			path: bin,
			nodePath: process.execPath,
			bootstrap: true,
		});
		// Assert
		expect(Boolean(candidate)).toBe(outcome === "success");
		expect(mocks.execFile.mock.calls[0][2]).toMatchObject({
			timeout: expect.any(Number),
			maxBuffer: 16_384,
			killSignal: "SIGKILL",
		});
		expect(mocks.execFile.mock.calls[0][2].timeout).toBeGreaterThan(0);
		expect(mocks.execFile.mock.calls[0][2].timeout).toBeLessThanOrEqual(4_000);
	},
);

test.each([
	[{ CODEMEM_RUNNER: "custom-runner" }, "custom-runner", []],
	[
		{ CODEMEM_RUNNER: "npx" },
		"npx",
		["-y", "--package", `codemem@${PIN}`, "--package", `@codemem/embeddings@${PIN}`, "codemem"],
	],
	[
		{ CODEMEM_RUNNER: "" },
		"npx",
		["-y", "--package", `codemem@${PIN}`, "--package", `@codemem/embeddings@${PIN}`, "codemem"],
	],
	[
		{ CODEMEM_RUNNER_FROM: "codemem@0.0.1" },
		"npx",
		["-y", "--package", "codemem@0.0.1", "--package", "@codemem/embeddings@0.0.1", "codemem"],
	],
	[
		{ CODEMEM_RUNNER_FROM: "" },
		"npx",
		["-y", "--package", `codemem@${PIN}`, "--package", `@codemem/embeddings@${PIN}`, "codemem"],
	],
])(
	"explicit settings %j preserve legacy invocation without probing",
	async (settings, command, prefix) => {
		// Arrange
		Object.assign(process.env, settings);
		await createRuntime();
		// Act
		await runtime.tools["mem-stats"].execute();
		// Assert
		expect(mocks.spawn.mock.calls[0].slice(0, 2)).toEqual([command, [...prefix, "stats"]]);
		expect(mocks.execFile).not.toHaveBeenCalled();
	},
);

test.each([0, 1])(
	"autoupdate invalidates the resolved CLI only on success (exit %s)",
	async (exitCode) => {
		// Arrange
		packageFixture();
		process.env.CODEMEM_BACKEND_UPDATE_POLICY = "auto";
		mocks.execSync.mockReturnValue(PIN);
		const newer = PIN.replace(/\d+$/u, (value) => String(Number(value) + 1));
		mocks.spawn.mockImplementation((command, args) => {
			if (args.includes("update"))
				return processResult({
					stdout: JSON.stringify({
						current_version: PIN,
						latest_version: newer,
						channel: CHANNEL,
						update_available: true,
						install_kind: "npm-global",
						auto_update_eligible: true,
						stale: false,
						error: null,
						recommended_action: `npm install -g codemem@${newer}`,
					}),
				});
			if (command === "npm") return processResult({ exitCode });
			if (args.includes("version")) return processResult({ stdout: newer });
			return processResult();
		});
		await createRuntime();
		// Act
		await runtime.tools["mem-stats"].execute();
		await vi.advanceTimersByTimeAsync(1500);
		await vi.waitFor(() =>
			expect(mocks.spawn.mock.calls.some(([command]) => command === "npm")).toBe(true),
		);
		await runtime.tools["mem-stats"].execute();
		// Assert
		expect(mocks.execFile.mock.calls.map(([command]) => command)).toEqual(
			exitCode === 0 ? ["node", "node"] : ["node"],
		);
	},
);

test("resolving to Node does not turn the logical npx runner into an updatable global install", async () => {
	// Arrange
	packageFixture();
	process.env.CODEMEM_BACKEND_UPDATE_POLICY = "auto";
	const newer = PIN.replace(/\d+$/u, (value) => String(Number(value) + 1));
	mocks.spawn.mockImplementation((_command, args) => {
		if (args.includes("update"))
			return processResult({
				stdout: JSON.stringify({
					latest_version: newer,
					channel: CHANNEL,
					update_available: true,
					auto_update_eligible: true,
					recommended_action: `npm install -g codemem@${newer}`,
				}),
			});
		return processResult({ stdout: PIN });
	});
	await createRuntime();
	await runtime.tools["mem-stats"].execute();
	// Act
	await vi.advanceTimersByTimeAsync(1500);
	await vi.waitFor(() =>
		expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("update"))).toBe(true),
	);
	await vi.advanceTimersByTimeAsync(0);
	// Assert
	expect(mocks.spawn.mock.calls.some(([command]) => command === "npm")).toBe(false);
	expect(mocks.execFile).toHaveBeenCalledTimes(1);
});

test("default viewer start uses the same resolved Node and CLI as tools", async () => {
	// Arrange
	process.env.CODEMEM_VIEWER = "1";
	process.env.CODEMEM_VIEWER_AUTO = "1";
	packageFixture();
	await createRuntime();
	// Act
	await runtime.tools["mem-stats"].execute();
	await vi.waitFor(() =>
		expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("start"))).toBe(true),
	);
	// Assert
	expect(
		mocks.spawn.mock.calls.every(
			([command, args]) => command === realpathSync(process.execPath) && args[0] === entry,
		),
	).toBe(true);
	expect(mocks.execFile).toHaveBeenCalledTimes(1);
});

test("disposal during default resolution prevents a delayed viewer start", async () => {
	// Arrange
	process.env.CODEMEM_VIEWER = "1";
	process.env.CODEMEM_VIEWER_AUTO = "1";
	packageFixture();
	const candidate = await new Promise((resolve, reject) => {
		realExecFile(
			"node",
			[new URL("../.opencode/lib/cli-runner-probe.js", import.meta.url).pathname],
			{ env: process.env },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		);
	});
	let release;
	mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
		release = callback;
	});
	await createRuntime();
	// Act
	await runtime.dispose();
	release(null, candidate, "");
	await vi.advanceTimersByTimeAsync(0);
	// Assert
	expect(mocks.spawn).not.toHaveBeenCalled();
});
