import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@codemem/core";
import { describe, expect, it } from "vitest";
import {
	buildForegroundRunnerArgs,
	extractViewerPid,
	isLikelyViewerCommand,
	isLocalHost,
	isLoopbackOnlyHost,
	isSqliteVecLoadFailure,
	pickViewerPidCandidate,
	prepareViewerDatabase,
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
			configPath: null,
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
			config: "/tmp/workspace-config.json",
		});
		expect(resolved.mode).toBe("start");
		expect(resolved.background).toBe(false);
		expect(resolved.configPath).toBe("/tmp/workspace-config.json");
	});

	it("builds background child args from the current runner", () => {
		const args = buildForegroundRunnerArgs(
			"/repo/packages/cli/src/index.ts",
			{
				mode: "start",
				dbPath: "/tmp/test.sqlite",
				configPath: null,
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

	it("extracts viewer_pid from stats payload", () => {
		expect(extractViewerPid({ viewer_pid: 12345 })).toBe(12345);
		expect(extractViewerPid({ viewer_pid: -1 })).toBeNull();
		expect(extractViewerPid({ viewer_pid: "12345" })).toBeNull();
		expect(extractViewerPid({})).toBeNull();
	});

	it("selects pid candidate from stats and listener with mismatch protection", () => {
		expect(pickViewerPidCandidate(123, 123)).toBe(123);
		expect(pickViewerPidCandidate(null, 456)).toBe(456);
		expect(pickViewerPidCandidate(123, null)).toBe(123);
		expect(pickViewerPidCandidate(111, 222)).toBeNull();
	});

	it("recognizes local hosts for safe process control", () => {
		expect(isLocalHost("127.0.0.1")).toBe(true);
		expect(isLocalHost("localhost")).toBe(true);
		expect(isLocalHost("::1")).toBe(true);
		expect(isLocalHost("0.0.0.0")).toBe(true);
		expect(isLocalHost("example.com")).toBe(false);
	});

	it("prepares a fresh viewer database before startup", () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-serve-"));
		const dbPath = join(dir, "viewer.sqlite");
		try {
			const prepared = prepareViewerDatabase(dbPath);
			expect(prepared).toBe(dbPath);

			process.env.CODEMEM_EMBEDDING_DISABLED = "1";
			const db = new MemoryStore(dbPath);
			try {
				expect(db.dbPath).toBe(dbPath);
			} finally {
				db.close();
				delete process.env.CODEMEM_EMBEDDING_DISABLED;
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("distinguishes loopback-only viewer binds from network-exposed binds", () => {
		expect(isLoopbackOnlyHost("127.0.0.1")).toBe(true);
		expect(isLoopbackOnlyHost("127.0.0.2")).toBe(true);
		expect(isLoopbackOnlyHost("127.1")).toBe(true);
		expect(isLoopbackOnlyHost("localhost")).toBe(true);
		expect(isLoopbackOnlyHost("::1")).toBe(true);
		expect(isLoopbackOnlyHost("0:0:0:0:0:0:0:1")).toBe(true);
		expect(isLoopbackOnlyHost("0.0.0.0")).toBe(false);
		expect(isLoopbackOnlyHost("::")).toBe(false);
		expect(isLoopbackOnlyHost("example.com")).toBe(false);
	});

	it("matches likely codemem viewer command lines", () => {
		expect(
			isLikelyViewerCommand(
				"node /Users/adam/.local/share/mise/installs/node/24.14.0/bin/codemem serve start --foreground --host 127.0.0.1 --port 38888",
			),
		).toBe(true);
		expect(
			isLikelyViewerCommand("node /repo/packages/cli/dist/index.js serve start --foreground"),
		).toBe(true);
		expect(isLikelyViewerCommand("node /usr/bin/python -m http.server 38888")).toBe(false);
	});
});
