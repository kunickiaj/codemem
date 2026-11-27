import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isViewerWriterLockHeld } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	holdViewerLockInAnotherProcess,
	stopHolder,
} from "../../../core/src/viewer-writer-lock-test-holder.js";
import { runServeInvocation, stopExistingViewer, viewerLockDependencies } from "./serve.js";
import { resolveServeInvocation, resolveStopRestartInvocation } from "./serve-invocation.js";
import {
	claimViewerWriterLock,
	viewerLockHolderHint,
	waitForViewerStartup,
} from "./viewer-lock-claim.js";

let directory: string;
let dbPath: string;
let previousExitCode: typeof process.exitCode;
const holders: ChildProcess[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-serve-lock-"));
	dbPath = join(directory, "mem.sqlite");
	previousExitCode = process.exitCode;
	process.exitCode = undefined;
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

/** Everything the command printed. */
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

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	process.exitCode = previousExitCode;
	await Promise.all(holders.splice(0).map(stopHolder));
	chmodSync(directory, 0o700);
	rmSync(directory, { recursive: true, force: true });
});

/** The address nothing listens on, recorded as where a holder meant to serve. */
const UNSERVED = { host: "127.0.0.1", port: 1 };

/** A holder whose command line looks like `codemem serve start`, as a real Viewer's does. */
async function viewerLikeHolder(): Promise<ChildProcess> {
	const holder = await holdViewerLockInAnotherProcess(dbPath, {
		owner: UNSERVED,
		extraArgs: ["codemem", "serve", "start", "--foreground"],
	});
	holders.push(holder);
	return holder;
}

const target = { host: "127.0.0.1", port: 38_901 };

describe("claiming the Viewer lock", () => {
	it("refuses at once while a live Viewer holds the database", async () => {
		const holder = await viewerLikeHolder();
		const started = Date.now();

		const claim = await claimViewerWriterLock(dbPath, target, {
			...viewerLockDependencies,
			isLiveViewer: async (owner) => owner.pid === holder.pid,
		});

		expect(claim).toEqual({ status: "refused", message: expect.any(String) });
		const message = claim.status === "refused" ? claim.message : "";
		expect(message).toContain(`Another codemem viewer is already using ${dbPath}.`);
		expect(message).toContain(`Recorded holder (unverified): pid ${holder.pid}, started `);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("waits for a holder that releases the lock, as a Viewer shutting down does", async () => {
		const holder = await holdViewerLockInAnotherProcess(dbPath);
		holders.push(holder);
		setTimeout(() => void stopHolder(holder), 400);

		const claim = await claimViewerWriterLock(dbPath, target, viewerLockDependencies, {
			waitMs: 5_000,
		});

		expect(claim.status).toBe("acquired");
		if (claim.status === "acquired") claim.lock.release();
	});

	it("names the holder that never serves once the wait ends", async () => {
		const holder = await viewerLikeHolder();

		const claim = await claimViewerWriterLock(dbPath, target, viewerLockDependencies, {
			waitMs: 300,
		});

		expect(claim).toEqual({ status: "refused", message: expect.any(String) });
		const message = claim.status === "refused" ? claim.message : "";
		expect(message).toContain(`Another process holds the viewer lock for ${dbPath}.`);
		expect(message).toContain(`Recorded holder (unverified): pid ${holder.pid}, started `);
		expect(message).toContain(`port ${UNSERVED.port}`);
		expect(message).toContain(`\`kill ${holder.pid}\``);
	});

	it.skipIf(process.getuid?.() === 0)(
		"explains a database folder it cannot write the lock in",
		async () => {
			chmodSync(directory, 0o500);

			const claim = await claimViewerWriterLock(dbPath, target, viewerLockDependencies);

			expect(claim).toEqual({
				status: "refused",
				message: expect.stringMatching(
					/^Cannot create the viewer lock at .*Check that .* writable\.$/,
				),
			});
		},
	);
});

describe("refusing a start while the lock is held", () => {
	it("gives a bare `codemem serve` the recorded holder and how to stop it", async () => {
		const viewerPort = await freePort();
		const address = { host: "127.0.0.1", port: viewerPort };
		const holder = await holdViewerLockInAnotherProcess(dbPath, {
			owner: address,
			answerAsViewer: address,
		});
		holders.push(holder);
		// The foreground start sets these for the store it would open.
		vi.stubEnv("CODEMEM_DB", process.env.CODEMEM_DB);
		vi.stubEnv("CODEMEM_CONFIG", process.env.CODEMEM_CONFIG);
		const startPort = String(await freePort());
		// A start that got the lock would run a whole Viewer in this test process.
		expect(isViewerWriterLockHeld(dbPath)).toBe(true);

		await runServeInvocation(
			resolveServeInvocation(undefined, { dbPath, host: "127.0.0.1", port: startPort }),
			{ nativeRuntimeAllowsServeStart: async () => true, stopExistingViewer },
		);

		expect(process.exitCode).toBe(1);
		expect(printed()).toContain(`Another codemem viewer is already using ${dbPath}.`);
		expect(printed()).toContain(`Recorded holder (unverified): pid ${holder.pid}, started `);
		expect(printed()).toContain(`port ${viewerPort}`);
		expect(holder.exitCode).toBeNull();
	});

	it("says how to end the recorded holder on each platform", () => {
		const owner = { pid: 4321, started: "", db_path: dbPath, host: "127.0.0.1", port: 38_888 };

		expect(viewerLockHolderHint(owner, "darwin")).toContain("(`kill 4321`)");
		expect(viewerLockHolderHint(owner, "linux")).toContain("(`kill 4321`)");
		expect(viewerLockHolderHint(owner, "win32")).toContain("(`taskkill /PID 4321`)");
		// Without `ps`, as on Windows, no start time is recorded and none is shown.
		expect(viewerLockHolderHint(owner, "win32")).toContain("pid 4321, port 38888.");
		expect(viewerLockHolderHint(null, "win32")).toContain("No holder was recorded.");
	});
});

describe("stopping and restarting the Viewer by its lock", () => {
	it("never signals the recorded lock holder, and reports it as unverified", async () => {
		const holder = await viewerLikeHolder();

		await runServeInvocation(
			resolveStopRestartInvocation("stop", { dbPath, host: "127.0.0.1", port: "38902" }),
			{ nativeRuntimeAllowsServeStart: async () => true, stopExistingViewer },
		);

		expect(holder.exitCode).toBeNull();
		expect(holder.signalCode).toBeNull();
		expect(isViewerWriterLockHeld(dbPath)).toBe(true);
		expect(printed()).toContain(
			`The database is locked by another process (pid ${holder.pid}, unverified).`,
		);
		expect(printed()).not.toContain("No background viewer found");
		expect(process.exitCode).toBe(1);
	});

	it("starts the new Viewer only after the stopped one releases the lock", async () => {
		const holder = await holdViewerLockInAnotherProcess(dbPath);
		holders.push(holder);
		const lockHeldAtStart: boolean[] = [];
		const startViewer = vi.fn(async () => {
			lockHeldAtStart.push(isViewerWriterLockHeld(dbPath));
		});
		const stopExistingViewer = vi.fn(async () => {
			// The stop returns before the old process has exited.
			setTimeout(() => void stopHolder(holder), 400);
			return { stopped: true, pid: holder.pid ?? null };
		});

		await runServeInvocation(
			resolveStopRestartInvocation("restart", { dbPath, host: "127.0.0.1", port: "38903" }),
			{ nativeRuntimeAllowsServeStart: async () => true, stopExistingViewer, startViewer },
		);

		expect(startViewer).toHaveBeenCalledOnce();
		expect(lockHeldAtStart).toEqual([false]);
	});
});

/** A spawned Viewer stand-in that the test drives through its IPC events. */
function fakeChild() {
	const child = Object.assign(new EventEmitter(), {
		connected: true,
		disconnect: vi.fn(() => {
			child.connected = false;
		}),
	});
	return child;
}

describe("waiting for a background Viewer's startup", () => {
	const message = (state: string, extra: object = {}) => ({
		type: "codemem-viewer-startup",
		state,
		...extra,
	});

	it("reports the Viewer's refusal and closes the channel", async () => {
		const child = fakeChild();
		const waiting = waitForViewerStartup(child as never, 5_000);

		child.emit("message", message("lock_acquired"));
		child.emit(
			"message",
			message("failed", { message: "Another codemem viewer is already using x" }),
		);

		await expect(waiting).resolves.toEqual({
			state: "failed",
			message: "Another codemem viewer is already using x",
		});
		expect(child.disconnect).toHaveBeenCalled();
	});

	it("reports a Viewer that exits before its result", async () => {
		const child = fakeChild();
		const waiting = waitForViewerStartup(child as never, 5_000);

		child.emit("exit", 1, null);

		await expect(waiting).resolves.toEqual({
			state: "failed",
			message: "The viewer exited during startup (exit code 1).",
		});
	});

	it("counts a Viewer that holds the lock but is not serving yet as starting", async () => {
		const child = fakeChild();
		const waiting = waitForViewerStartup(child as never, 50);

		child.emit("message", message("lock_acquired"));

		await expect(waiting).resolves.toEqual({ state: "starting" });
	});

	it("fails a Viewer that never reports", async () => {
		await expect(waitForViewerStartup(fakeChild() as never, 50)).resolves.toEqual({
			state: "failed",
			message: "The viewer did not report startup within 1s.",
		});
	});

	it("reports a Viewer that is serving", async () => {
		const child = fakeChild();
		const waiting = waitForViewerStartup(child as never, 5_000);

		child.emit("message", message("listening"));

		await expect(waiting).resolves.toEqual({ state: "listening" });
	});
});
