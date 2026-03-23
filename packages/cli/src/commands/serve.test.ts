import { describe, expect, it } from "vitest";
import {
	buildForegroundRunnerArgs,
	isSqliteVecLoadFailure,
	sqliteVecFailureDiagnostics,
} from "./serve.js";
import {
	resolveLegacyServeInvocation,
	resolveServeInvocation,
	resolveStartServeInvocation,
	resolveStopRestartInvocation,
} from "./serve-invocation.js";

describe("serve command option resolution", () => {
	it("treats bare serve as a foreground start", () => {
		const resolved = resolveLegacyServeInvocation({ host: "127.0.0.1", port: "38888" });
		expect(resolved).toEqual({
			mode: "start",
			dbPath: null,
			host: "127.0.0.1",
			port: 38888,
			background: false,
		});
	});

	it("treats serve --background as a background start", () => {
		const resolved = resolveLegacyServeInvocation({
			host: "127.0.0.1",
			port: "38888",
			background: true,
		});
		expect(resolved.mode).toBe("start");
		expect(resolved.background).toBe(true);
	});

	it("maps serve --stop to stop mode", () => {
		const resolved = resolveLegacyServeInvocation({
			host: "127.0.0.1",
			port: "38888",
			stop: true,
		});
		expect(resolved.mode).toBe("stop");
		expect(resolved.background).toBe(false);
	});

	it("maps serve --restart to restart mode", () => {
		const resolved = resolveLegacyServeInvocation({
			host: "127.0.0.1",
			port: "38888",
			restart: true,
		});
		expect(resolved.mode).toBe("restart");
		expect(resolved.background).toBe(true);
	});

	it("rejects conflicting legacy stop and restart flags", () => {
		expect(() =>
			resolveLegacyServeInvocation({
				host: "127.0.0.1",
				port: "38888",
				stop: true,
				restart: true,
			}),
		).toThrow("Use only one of --stop or --restart");
	});

	it("maps serve stop to stop mode", () => {
		const resolved = resolveStopRestartInvocation("stop", {
			host: "127.0.0.1",
			port: "38888",
		});
		expect(resolved.mode).toBe("stop");
		expect(resolved.background).toBe(false);
	});

	it("maps serve restart to restart mode", () => {
		const resolved = resolveStopRestartInvocation("restart", {
			host: "127.0.0.1",
			port: "38888",
		});
		expect(resolved.mode).toBe("restart");
		expect(resolved.background).toBe(true);
	});

	it("defaults serve start to background mode", () => {
		const resolved = resolveStartServeInvocation({ host: "127.0.0.1", port: "38888" });
		expect(resolved.mode).toBe("start");
		expect(resolved.background).toBe(true);
	});

	it("supports serve start --foreground", () => {
		const resolved = resolveStartServeInvocation({
			host: "127.0.0.1",
			port: "38888",
			foreground: true,
		});
		expect(resolved.mode).toBe("start");
		expect(resolved.background).toBe(false);
	});

	it("supports serve start through the shared action resolver", () => {
		const resolved = resolveServeInvocation("start", {
			host: "127.0.0.1",
			port: "38888",
			foreground: true,
		});
		expect(resolved.mode).toBe("start");
		expect(resolved.background).toBe(false);
	});

	it("builds background child args from the current runner", () => {
		const args = buildForegroundRunnerArgs(
			"/repo/packages/cli/src/index.ts",
			{
				mode: "start",
				dbPath: "/tmp/test.sqlite",
				host: "127.0.0.1",
				port: 38991,
				background: true,
			},
			["--conditions", "source"],
		);
		expect(args).toEqual([
			"--conditions",
			"source",
			"/repo/packages/cli/src/index.ts",
			"serve",
			"start",
			"--foreground",
			"--host",
			"127.0.0.1",
			"--port",
			"38991",
			"--db-path",
			"/tmp/test.sqlite",
		]);
	});

	it("detects sqlite-vec load errors for viewer startup fallback", () => {
		expect(isSqliteVecLoadFailure(new Error("sqlite-vec loaded but version check failed"))).toBe(
			true,
		);
		expect(isSqliteVecLoadFailure(new Error("no such function: vec_version"))).toBe(true);
		expect(isSqliteVecLoadFailure(new Error("database is locked"))).toBe(false);
	});

	it("formats sqlite-vec diagnostics with runtime context", () => {
		const lines = sqliteVecFailureDiagnostics(new Error("vec0 load failed"), "/tmp/mem.sqlite");
		expect(lines.some((line) => line.startsWith("db=/tmp/mem.sqlite"))).toBe(true);
		expect(lines.some((line) => line.startsWith("node="))).toBe(true);
		expect(lines.some((line) => line.startsWith("exec="))).toBe(true);
		expect(lines.some((line) => line.startsWith("error=vec0 load failed"))).toBe(true);
	});
});
