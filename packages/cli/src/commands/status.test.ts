import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database, type OperationalStatusSnapshot, VERSION } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	boundAttention,
	createStatusCommand,
	type OperationalStatusReport,
	type StatusDependencies,
} from "./status.js";

const healthySnapshot: OperationalStatusSnapshot = {
	sync: { available: true, daemon_error: false, needs_attention: false, peer_errors: 0 },
	maintenance: { state: "idle", running: 0, failed: 0 },
	semantic_index: { state: "healthy", vector_table_present: true },
	raw_events: { available: true, pending: 0, failed_batches: 0 },
	observer: { available: true, failed_batches: 0, backoff_batches: 0 },
};

function harness(
	overrides: Partial<StatusDependencies> & { snapshot?: OperationalStatusSnapshot } = {},
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCodes: number[] = [];
	const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
		new Response(
			JSON.stringify({
				service: "codemem-viewer",
				ready: true,
				database: { reachable: true },
			}),
			{
				status: 200,
				headers: { "content-type": "application/json" },
			},
		),
	);
	const fakeDb = { close: vi.fn() } as unknown as Database;
	const { snapshot = healthySnapshot, ...deps } = overrides;
	const command = createStatusCommand({
		now: () => new Date("2026-08-11T12:00:00.000Z"),
		exists: () => true,
		readText: () => JSON.stringify({ pid: 1234, host: "127.0.0.1", port: 38_888 }),
		readConfig: () => ({ sync_enabled: true, observer_provider: "openai" }),
		resolveDbPath: () => "/safe/test.sqlite",
		connectReadOnly: () => fakeDb,
		collectDatabase: () => snapshot,
		embeddingDisabled: () => false,
		fetch: fetchMock,
		isProcessRunning: () => true,
		env: {},
		writeStdout: (text) => stdout.push(text),
		writeStderr: (text) => stderr.push(text),
		setExitCode: (code) => exitCodes.push(code),
		...deps,
	});
	return { command, stdout, stderr, exitCodes, fetchMock };
}

describe("status command", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("reports a missing database without creating it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-status-missing-"));
		tempDirs.push(dir);
		const dbPath = join(dir, "missing.sqlite");
		const collected = vi.fn();
		const { command, stdout, exitCodes } = harness({
			exists: () => false,
			resolveDbPath: () => dbPath,
			collectDatabase: collected,
		});

		await command.parseAsync(["--db-path", dbPath, "--json"], { from: "user" });

		expect(existsSync(dbPath)).toBe(false);
		expect(collected).not.toHaveBeenCalled();
		expect(JSON.parse(stdout[0] ?? "{}").database.state).toBe("missing");
		expect(exitCodes).toEqual([0]);
	});

	it("emits the exact required healthy JSON shape with one stdout object", async () => {
		const { command, stdout, stderr, exitCodes } = harness();
		await command.parseAsync(["--json"], { from: "user" });

		const report = JSON.parse(stdout[0] ?? "{}") as OperationalStatusReport;
		expect(stdout).toHaveLength(1);
		expect(stderr).toEqual([]);
		expect(exitCodes).toEqual([0]);
		expect(Object.keys(report)).toEqual([
			"checked_at",
			"ok",
			"version",
			"database",
			"runtime",
			"sync",
			"maintenance",
			"semantic_index",
			"raw_events",
			"observer",
			"attention",
		]);
		expect(report).toMatchObject({
			checked_at: "2026-08-11T12:00:00.000Z",
			ok: true,
			version: VERSION,
			database: { state: "ready" },
			runtime: { viewer: "running", pid: 1234 },
			sync: { state: "healthy" },
			maintenance: { state: "idle" },
			semantic_index: { state: "healthy" },
			raw_events: { state: "healthy", pending: 0 },
			observer: { state: "idle" },
			attention: [],
		});
	});

	it("suppresses newer-schema compatibility warnings in JSON mode", async () => {
		const close = vi.fn();
		const { command, stdout, stderr } = harness({
			connectReadOnly: (_path, options) => {
				options?.warn?.("newer schema compatibility warning");
				return { close } as unknown as Database;
			},
		});

		await command.parseAsync(["--json"], { from: "user" });

		expect(stdout).toHaveLength(1);
		expect(stderr).toEqual([]);
		expect(close).toHaveBeenCalledOnce();
	});

	it("keeps warnings successful and exits zero for degraded reports", async () => {
		const snapshot = structuredClone(healthySnapshot);
		snapshot.sync.peer_errors = 2;
		const { command, stdout, exitCodes } = harness({ snapshot });
		await command.parseAsync(["--json"], { from: "user" });
		const report = JSON.parse(stdout[0] ?? "{}") as OperationalStatusReport;
		expect(report.sync.state).toBe("degraded");
		expect(report.ok).toBe(true);
		expect(report.attention[0]?.severity).toBe("warning");
		expect(exitCodes).toEqual([0]);
	});

	it("keeps an unready viewer running and reports its readiness warning", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					service: "codemem-viewer",
					ready: false,
					database: { reachable: false },
				}),
			),
		);
		const { command, stdout } = harness({ fetch: fetchMock });
		await command.parseAsync(["--json"], { from: "user" });
		const report = JSON.parse(stdout[0] ?? "{}") as OperationalStatusReport;
		expect(report.runtime.viewer).toBe("running");
		expect(report.attention).toContainEqual(
			expect.objectContaining({ code: "viewer_not_ready", severity: "warning" }),
		);
	});

	it("uses configured loopback viewer defaults when no PID record exists", async () => {
		const { command, fetchMock } = harness({
			exists: (path) => !path.endsWith("viewer.pid"),
			env: { CODEMEM_VIEWER_HOST: "127.0.0.2", CODEMEM_VIEWER_PORT: "39999" },
		});
		await command.parseAsync(["--json"], { from: "user" });
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.2:39999/api/health");
	});

	it("sets ok false for error attention while still exiting zero", async () => {
		const snapshot = structuredClone(healthySnapshot);
		snapshot.maintenance = { state: "failed", running: 0, failed: 1 };
		const { command, stdout, exitCodes } = harness({ snapshot });
		await command.parseAsync(["--json"], { from: "user" });
		const report = JSON.parse(stdout[0] ?? "{}") as OperationalStatusReport;
		expect(report.ok).toBe(false);
		expect(report.attention).toContainEqual(
			expect.objectContaining({ code: "maintenance_failed", severity: "error" }),
		);
		expect(exitCodes).toEqual([0]);
	});

	it("projects disabled sync, unconfigured observer, and subsystem failures", async () => {
		const snapshot = structuredClone(healthySnapshot);
		snapshot.semantic_index.state = "failed";
		snapshot.raw_events = { available: true, pending: 2_000_000, failed_batches: 1 };
		snapshot.observer.failed_batches = 1;
		const { command, stdout } = harness({
			snapshot,
			readConfig: () => ({ sync_enabled: false }),
		});
		await command.parseAsync(["--json"], { from: "user" });
		const report = JSON.parse(stdout[0] ?? "{}") as OperationalStatusReport;
		expect(report.sync.state).toBe("disabled");
		expect(report.observer.state).toBe("unconfigured");
		expect(report.semantic_index.state).toBe("failed");
		expect(report.raw_events).toEqual({ state: "failing", pending: 2_000_000 });
	});

	it("reads sync and observer presence from environment evidence", async () => {
		const { command, stdout } = harness({
			readConfig: () => ({}),
			env: { CODEMEM_SYNC_ENABLED: "true", CODEMEM_OBSERVER_PROVIDER: "openai" },
		});
		await command.parseAsync(["--json"], { from: "user" });
		const report = JSON.parse(stdout[0] ?? "{}") as OperationalStatusReport;
		expect(report.sync.state).toBe("healthy");
		expect(report.observer.state).toBe("idle");
	});

	it("does not treat observer tuning alone as configured", async () => {
		const { command, stdout } = harness({
			readConfig: () => ({ observer_tier_routing_enabled: false, observer_temperature: 0.2 }),
		});
		await command.parseAsync(["--json"], { from: "user" });
		const report = JSON.parse(stdout[0] ?? "{}") as OperationalStatusReport;
		expect(report.observer.state).toBe("unconfigured");
	});

	it("reports retryable observer failures as backoff warnings", async () => {
		const snapshot = structuredClone(healthySnapshot);
		snapshot.observer.backoff_batches = 1;
		const { command, stdout } = harness({ snapshot });
		await command.parseAsync(["--json"], { from: "user" });
		const report = JSON.parse(stdout[0] ?? "{}") as OperationalStatusReport;
		expect(report.observer.state).toBe("backoff");
		expect(report.attention).toContainEqual(
			expect.objectContaining({ code: "observer_backoff", severity: "warning" }),
		);
	});

	it("renders compact human output and detailed command suggestions", async () => {
		const snapshot = structuredClone(healthySnapshot);
		snapshot.raw_events.pending = 3;
		const { command, stdout } = harness({ snapshot });
		await command.parseAsync([], { from: "user" });
		expect(stdout).toHaveLength(1);
		expect(stdout[0]).toContain("codemem status OK");
		expect(stdout[0]).toContain("Raw events:     backlogged (3 pending)");
		expect(stdout[0]).toContain("codemem db raw-events-status");
	});

	it("emits one structured error and exits one on collection failure", async () => {
		const close = vi.fn();
		const { command, stdout, stderr, exitCodes } = harness({
			connectReadOnly: () => ({ close }) as unknown as Database,
			collectDatabase: () => {
				throw new Error("sensitive database failure");
			},
		});
		await command.parseAsync(["--json"], { from: "user" });
		expect(stdout).toEqual([
			JSON.stringify({ error: "status_failed", message: "Unable to collect operational status" }),
		]);
		expect(stderr).toEqual([]);
		expect(exitCodes).toEqual([1]);
		expect(stdout[0]).not.toContain("sensitive");
		expect(close).toHaveBeenCalledOnce();
	});

	it("rejects positional arguments as usage errors", async () => {
		const { command, stdout, exitCodes } = harness();
		await command.parseAsync(["unexpected", "--json"], { from: "user" });
		expect(JSON.parse(stdout[0] ?? "{}").error).toBe("usage_error");
		expect(exitCodes).toEqual([2]);
	});

	it("rejects unknown options as usage errors", async () => {
		const { command, stdout, exitCodes } = harness();
		await command.parseAsync(["--json", "--bogus"], { from: "user" });
		expect(JSON.parse(stdout[0] ?? "{}").error).toBe("usage_error");
		expect(exitCodes).toEqual([2]);
	});

	it("registers shared options and no positional arguments", () => {
		const { command } = harness();
		expect(command.registeredArguments).toHaveLength(0);
		expect(command.options.map((option) => option.flags)).toEqual([
			"-d, --db-path <path>",
			"--db <path>",
			"-c, --config <path>",
			"-j, --json",
		]);
		expect(command.helpInformation()).toContain("status [options]");
	});

	it("caps and bounds attention entries", () => {
		const attention = boundAttention(
			Array.from({ length: 25 }, (_, index) => ({
				code: `unsafe code ${index}${"x".repeat(80)}`,
				severity: "warning" as const,
				message: "m".repeat(600),
			})),
		);
		expect(attention).toHaveLength(20);
		expect(attention.every((item) => item.code.length <= 64 && item.message.length <= 500)).toBe(
			true,
		);
	});
});
