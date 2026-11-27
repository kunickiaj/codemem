import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	holdViewerLockInAnotherProcess,
	stopHolder,
} from "../../../core/src/viewer-writer-lock-test-holder.js";
import { runServeInvocation, stopExistingViewer } from "./serve.js";
import { resolveServeInvocation, resolveStopRestartInvocation } from "./serve-invocation.js";

/*
 * A Viewer from beta.3 or earlier wrote viewer.pid beside the database path it
 * was given, and took no database lock. Started through a file symlink, that is
 * not the canonical folder this release uses, so start and stop also read the
 * older location.
 */

let directory: string;
let linkedDbPath: string;
let legacyPidPath: string;
let previousExitCode: typeof process.exitCode;
const processes: ChildProcess[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-serve-legacy-"));
	mkdirSync(join(directory, "real"));
	mkdirSync(join(directory, "links"));
	const realDbPath = join(directory, "real", "mem.sqlite");
	writeFileSync(realDbPath, "");
	linkedDbPath = join(directory, "links", "alias.sqlite");
	symlinkSync(realDbPath, linkedDbPath);
	legacyPidPath = join(directory, "links", "viewer.pid");
	previousExitCode = process.exitCode;
	process.exitCode = undefined;
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
	vi.restoreAllMocks();
	process.exitCode = previousExitCode;
	await Promise.all(processes.splice(0).map(stopHolder));
	rmSync(directory, { recursive: true, force: true });
});

function printed(): string {
	return vi
		.mocked(process.stdout.write)
		.mock.calls.map(([chunk]) => String(chunk))
		.join("");
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

/** A running beta.3 Viewer started through the symlink: it answers, holds no lock, and wrote its record beside the link. */
async function beta3Viewer(): Promise<{ viewer: ChildProcess; port: number }> {
	const port = await freePort();
	const viewer = await holdViewerLockInAnotherProcess(linkedDbPath, {
		lock: false,
		answerAsViewer: { host: "127.0.0.1", port },
		extraArgs: ["codemem", "serve", "start", "--foreground"],
	});
	processes.push(viewer);
	writeFileSync(legacyPidPath, JSON.stringify({ pid: viewer.pid, host: "127.0.0.1", port }));
	return { viewer, port };
}

const allowNativeRuntime = async () => true;

describe("a running Viewer from before the database lock", () => {
	it("refuses a start on another port instead of running beside it", async () => {
		const { viewer, port } = await beta3Viewer();
		const startViewer = vi.fn(async () => {});
		const otherPort = String(await freePort());

		await runServeInvocation(
			resolveServeInvocation("start", {
				dbPath: linkedDbPath,
				host: "127.0.0.1",
				port: otherPort,
			}),
			{ nativeRuntimeAllowsServeStart: allowNativeRuntime, stopExistingViewer, startViewer },
		);

		expect(startViewer).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
		expect(printed()).toContain(`already managed by viewer 127.0.0.1:${port} (pid ${viewer.pid})`);
	});

	it("is stopped by `serve stop` on its port, which also removes its old record", async () => {
		const { viewer, port } = await beta3Viewer();
		const exited = once(viewer, "exit");

		await runServeInvocation(
			resolveStopRestartInvocation("stop", {
				dbPath: linkedDbPath,
				host: "127.0.0.1",
				port: String(port),
			}),
			{ nativeRuntimeAllowsServeStart: allowNativeRuntime, stopExistingViewer },
		);
		await exited;

		expect(viewer.signalCode).toBe("SIGTERM");
		expect(printed()).toContain(`Stopped viewer (pid ${viewer.pid})`);
		expect(existsSync(legacyPidPath)).toBe(false);
	});
});
