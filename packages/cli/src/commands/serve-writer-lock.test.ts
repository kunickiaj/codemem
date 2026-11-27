import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isViewerWriterLockHeld } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	holdViewerLockInAnotherProcess,
	stopHolder,
} from "../../../core/src/viewer-writer-lock-test-holder.js";
import { runServeInvocation, stopExistingViewer, viewerLockDependencies } from "./serve.js";
import { resolveStopRestartInvocation } from "./serve-invocation.js";
import { claimViewerWriterLock, waitForViewerStartup } from "./viewer-lock-claim.js";

let directory: string;
let dbPath: string;
let previousExitCode: typeof process.exitCode;
const holders: ChildProcess[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-serve-lock-"));
	dbPath = join(directory, "mem.sqlite");
	previousExitCode = process.exitCode;
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
	vi.restoreAllMocks();
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

		expect(claim).toEqual({
			status: "refused",
			message: expect.stringContaining(`Another codemem viewer is already using ${dbPath}`),
		});
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

		expect(claim).toEqual({
			status: "refused",
			message: expect.stringContaining(`codemem viewer pid ${holder.pid} holds ${dbPath}`),
		});
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

describe("stopping and restarting the Viewer by its lock", () => {
	it("stops a Viewer that holds the lock but never started serving", async () => {
		const holder = await viewerLikeHolder();

		await runServeInvocation(
			resolveStopRestartInvocation("stop", { dbPath, host: "127.0.0.1", port: "38902" }),
			{
				nativeRuntimeAllowsServeStart: async () => true,
				stopExistingViewer,
			},
		);

		expect(holder.signalCode).toBe("SIGTERM");
		expect(isViewerWriterLockHeld(dbPath)).toBe(false);
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
