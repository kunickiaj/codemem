import type { Database, OperationalStatusSnapshot } from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import { createServiceCommand, type ServiceDependencies } from "./service.js";
import { createStatusCommand, type StatusDependencies } from "./status.js";

function lifecycleHarness(overrides: Partial<ServiceDependencies> = {}) {
	const runInvocation = vi.fn<ServiceDependencies["runInvocation"]>().mockResolvedValue();
	const writeError = vi.fn();
	const setExitCode = vi.fn();
	const command = createServiceCommand({ runInvocation, writeError, setExitCode, ...overrides });
	command.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
	for (const child of command.commands) {
		child.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
	}
	return { command, runInvocation, writeError, setExitCode };
}

describe("service lifecycle routing", () => {
	it.each([
		["start", true],
		["stop", false],
		["restart", true],
	] as const)("routes %s with its existing background behavior", async (mode, background) => {
		// Arrange: environment defaults cannot alter the explicit command options.
		const { command, runInvocation, writeError, setExitCode } = lifecycleHarness();

		// Act: parse child options through Commander rather than process.argv.
		await command.parseAsync(
			[
				mode,
				"--db-path",
				"/test/mem.sqlite",
				"--config",
				"/test/config.json",
				"--host",
				"127.0.0.2",
				"--port",
				"39991",
			],
			{ from: "user" },
		);

		// Assert: only the resolved invocation crosses the lifecycle boundary.
		expect(runInvocation).toHaveBeenCalledExactlyOnceWith({
			mode,
			background,
			dbPath: "/test/mem.sqlite",
			configPath: "/test/config.json",
			host: "127.0.0.2",
			port: 39991,
		});
		expect(writeError).not.toHaveBeenCalled();
		expect(setExitCode).not.toHaveBeenCalled();
	});

	it.each(["-f", "--foreground"])("runs start in the foreground with %s", async (flag) => {
		// Arrange: the runner must remain mocked to avoid spawning a service.
		const { command, runInvocation } = lifecycleHarness();

		// Act: use the start-only foreground option.
		await command.parseAsync(["start", flag, "-d", "/test/mem.sqlite", "-c", "/test/config.json"], {
			from: "user",
		});

		// Assert: shared short aliases reach the resolver as well.
		expect(runInvocation).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				mode: "start",
				background: false,
				dbPath: "/test/mem.sqlite",
				configPath: "/test/config.json",
			}),
		);
	});

	it("uses shared viewer defaults when no host or port was parsed", async () => {
		// Arrange: use the same option helpers as the existing serve command.
		const { command, runInvocation } = lifecycleHarness();

		// Act: start without child options.
		await command.parseAsync(["start"], { from: "user" });

		// Assert: a bare service start stays in the background.
		expect(runInvocation).toHaveBeenCalledExactlyOnceWith({
			mode: "start",
			background: true,
			dbPath: null,
			configPath: null,
			host: "127.0.0.1",
			port: 38888,
		});
	});

	it.each([
		["stop", "-f"],
		["stop", "--foreground"],
		["restart", "-f"],
		["restart", "--foreground"],
	])("rejects unsupported foreground options on %s: %s", async (mode, flag) => {
		// Arrange: usage failures must never reach the runtime.
		const { command, runInvocation } = lifecycleHarness();

		// Act: attempt a start-only option on another lifecycle child.
		const result = command.parseAsync([mode, flag], { from: "user" });

		// Assert: Commander rejects the unsupported syntax before dispatch.
		await expect(result).rejects.toMatchObject({ code: "commander.unknownOption" });
		expect(runInvocation).not.toHaveBeenCalled();
	});

	it.each(["start", "stop", "restart"])(
		"reports invalid ports on %s without starting runtime work",
		async (mode) => {
			// Arrange: validation errors should use the same injected error boundary.
			const { command, runInvocation, writeError, setExitCode } = lifecycleHarness();

			// Act: parse an out-of-range port.
			await command.parseAsync([mode, "--port", "65536"], { from: "user" });

			// Assert: resolving options fails before any runtime effect.
			expect(runInvocation).not.toHaveBeenCalled();
			expect(writeError).toHaveBeenCalledExactlyOnceWith("Invalid port: 65536");
			expect(setExitCode).toHaveBeenCalledExactlyOnceWith(2);
		},
	);

	it.each([new Error("lifecycle failed"), "lifecycle failed"])(
		"reports runtime rejection without an uncaught error: %s",
		async (failure) => {
			// Arrange: both Error instances and other rejected values reach the boundary.
			const { command, writeError, setExitCode } = lifecycleHarness({
				runInvocation: vi.fn().mockRejectedValue(failure),
			});

			// Act: execute a failing lifecycle operation.
			await command.parseAsync(["restart"], { from: "user" });

			// Assert: callers receive a concise error and a failure exit code.
			expect(writeError).toHaveBeenCalledExactlyOnceWith("lifecycle failed");
			expect(setExitCode).toHaveBeenCalledExactlyOnceWith(1);
		},
	);
});

describe("service discovery", () => {
	it("shows help without launching a default lifecycle operation", async () => {
		// Arrange: a bare service group must be safe for discovery.
		const { command, runInvocation } = lifecycleHarness();

		// Act: request the group with no child command.
		const result = command.parseAsync([], { from: "user" });

		// Assert: Commander displays group help rather than starting the service.
		await expect(result).rejects.toMatchObject({ code: "commander.help" });
		expect(runInvocation).not.toHaveBeenCalled();
	});

	it("documents foreground only on start and shares lifecycle options", () => {
		// Arrange: build an isolated command tree.
		const { command, runInvocation } = lifecycleHarness();

		// Act: render help for each lifecycle child.
		const help = command.helpInformation();
		const children = command.commands.filter((child) => child.name() !== "status");

		// Assert: supported flags are discoverable without invoking runtime effects.
		for (const name of ["start", "stop", "restart", "status"]) expect(help).toContain(name);
		for (const child of children) {
			const childHelp = child.helpInformation();
			for (const flag of ["--db-path", "--config", "--host", "--port"])
				expect(childHelp).toContain(flag);
			expect(childHelp.includes("--foreground")).toBe(child.name() === "start");
		}
		expect(runInvocation).not.toHaveBeenCalled();
	});
});

const healthySnapshot: OperationalStatusSnapshot = {
	sync: { available: true, daemon_error: false, needs_attention: false, peer_errors: 0 },
	maintenance: { state: "idle", running: 0, failed: 0 },
	semantic_index: { state: "healthy", vector_table_present: true },
	raw_events: { available: true, pending: 0, failed_batches: 0 },
	observer: { available: true, failed_batches: 0, backoff_batches: 0, recent_failed_batches: 0 },
};

function statusHarness(offline: boolean) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const close = vi.fn();
	const deps: StatusDependencies = {
		now: () => new Date("2026-08-11T12:00:00.000Z"),
		exists: () => true,
		readText: () => JSON.stringify({ pid: 1234, host: "127.0.0.1", port: 38888 }),
		readConfig: vi.fn(() => ({ sync_enabled: true, observer_provider: "openai" })),
		resolveDbPath: vi.fn(() => "/test/mem.sqlite"),
		connectReadOnly: vi.fn(() => ({ close }) as unknown as Database),
		collectDatabase: vi.fn(() => healthySnapshot),
		embeddingDisabled: () => false,
		fetch: vi.fn<typeof fetch>().mockImplementation(async () => {
			if (offline) throw new Error("offline");
			return new Response(
				JSON.stringify({ service: "codemem-viewer", ready: true, database: { reachable: true } }),
			);
		}),
		isProcessRunning: () => !offline,
		env: {},
		writeStdout: (text) => stdout.push(text),
		writeStderr: (text) => stderr.push(text),
		setExitCode: vi.fn(),
	};
	return { deps, stdout, stderr, close };
}

describe("service status alias", () => {
	it.each([
		{ offline: false, json: true },
		{ offline: true, json: true },
		{ offline: false, json: false },
		{ offline: true, json: false },
	])("matches root status with $offline offline and $json JSON", async ({ offline, json }) => {
		// Arrange: independently inject every I/O boundary into both command entrypoints.
		const root = statusHarness(offline);
		const nested = statusHarness(offline);
		const { command, runInvocation } = lifecycleHarness({ statusDependencies: nested.deps });
		const args = ["--db-path", "/test/mem.sqlite", "--config", "/test/config.json"];
		if (json) args.push("--json");

		// Act: collect the same snapshot through each public spelling.
		await createStatusCommand(root.deps).parseAsync(args, { from: "user" });
		await command.parseAsync(["status", ...args], { from: "user" });

		// Assert: output and read-only database access are identical even when offline.
		expect(nested.stdout).toEqual(root.stdout);
		expect(nested.stdout).toHaveLength(1);
		expect(nested.stderr).toEqual([]);
		expect(nested.deps.setExitCode).toHaveBeenCalledExactlyOnceWith(0);
		expect(nested.deps.connectReadOnly).toHaveBeenCalledExactlyOnceWith(
			"/test/mem.sqlite",
			expect.any(Object),
		);
		expect(nested.deps.readConfig).toHaveBeenCalledWith("/test/config.json");
		expect(nested.close).toHaveBeenCalledOnce();
		expect(runInvocation).not.toHaveBeenCalled();
		if (json)
			expect(JSON.parse(nested.stdout[0] ?? "{}").runtime.viewer).toBe(
				offline ? "stopped" : "running",
			);
	});

	it("shares structured collection errors with root status", async () => {
		// Arrange: fail the read-only collector identically for both spellings.
		const root = statusHarness(false);
		const nested = statusHarness(false);
		for (const harness of [root, nested])
			harness.deps.collectDatabase = vi.fn(() => {
				throw new Error("private failure");
			});
		const { command, runInvocation } = lifecycleHarness({ statusDependencies: nested.deps });

		// Act: request machine-readable reports after collection fails.
		await createStatusCommand(root.deps).parseAsync(["--json"], { from: "user" });
		await command.parseAsync(["status", "--json"], { from: "user" });

		// Assert: the alias preserves error shape, privacy, cleanup, and exit semantics.
		expect(nested.stdout).toEqual(root.stdout);
		expect(JSON.parse(nested.stdout[0] ?? "{}")).toEqual({
			error: "status_failed",
			message: "Unable to collect operational status",
		});
		expect(nested.deps.setExitCode).toHaveBeenCalledExactlyOnceWith(1);
		expect(nested.close).toHaveBeenCalledOnce();
		expect(runInvocation).not.toHaveBeenCalled();
	});
});
