/**
 * Who may run the Viewer for a database, and how a start reports whether it got
 * there. The database's Viewer lock (see `viewer-writer-lock.ts` in core) is the
 * only authority: the process that holds it records itself as the owner, writes
 * the PID record once it serves, and is the one `serve stop` stops.
 */
import type { ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import {
	acquireViewerWriterLock,
	canonicalViewerDbPath,
	readViewerWriterLockOwner,
	type ViewerWriterLock,
	ViewerWriterLockHeldError,
	type ViewerWriterLockOwner,
	ViewerWriterLockUnavailableError,
} from "@codemem/core";

export interface ViewerLockOwnerChecks {
	isProcessRunning(pid: number): boolean;
	processStartIdentity(pid: number): string | null;
	readProcessCommand(pid: number): string | null;
	isViewerCommand(command: string): boolean;
	isLockHeld(dbPath: string): boolean;
}

/**
 * The recorded lock owner, only while that exact process still holds the lock:
 * same pid and start time, a Viewer command line, and the lock is held now. A
 * stale record from an exited holder, or a reused pid, never verifies.
 */
export function verifiedViewerLockOwner(
	dbPath: string,
	checks: ViewerLockOwnerChecks,
): ViewerWriterLockOwner | null {
	const owner = readViewerWriterLockOwner(dbPath);
	if (!owner?.started || owner.db_path !== canonicalViewerDbPath(dbPath)) return null;
	if (!checks.isProcessRunning(owner.pid)) return null;
	if (checks.processStartIdentity(owner.pid) !== owner.started) return null;
	const command = checks.readProcessCommand(owner.pid);
	if (!command || !checks.isViewerCommand(command)) return null;
	return checks.isLockHeld(dbPath) ? owner : null;
}

export interface ViewerLockClaimDependencies extends ViewerLockOwnerChecks {
	isLiveViewer(owner: ViewerWriterLockOwner): Promise<boolean>;
	sleep(ms: number): Promise<void>;
}

export type ViewerLockClaim =
	| { status: "acquired"; lock: ViewerWriterLock }
	| { status: "refused"; message: string };

/** How long a start waits for a holder that is not serving, such as one shutting down. */
export const VIEWER_LOCK_WAIT_MS = 10_000;

function heldMessage(dbPath: string, owner: ViewerWriterLockOwner | null): string {
	if (!owner) {
		return `Another process holds the viewer lock for ${dbPath}. Stop the other codemem viewer, or use a separate database.`;
	}
	return `codemem viewer pid ${owner.pid} holds ${dbPath} but is not answering at ${owner.host}:${owner.port}. Stop it with \`codemem service stop\`, then start again.`;
}

function unavailableMessage(error: ViewerWriterLockUnavailableError): string {
	return `Cannot create the viewer lock at ${error.path} (${error.code}). Check that ${dirname(error.path)} exists and is writable.`;
}

/** One attempt: the claim's result, or null while another process holds the lock. */
function tryClaim(dbPath: string, target: { host: string; port: number }): ViewerLockClaim | null {
	try {
		return { status: "acquired", lock: acquireViewerWriterLock(dbPath, { owner: target }) };
	} catch (error) {
		if (error instanceof ViewerWriterLockUnavailableError) {
			return { status: "refused", message: unavailableMessage(error) };
		}
		if (error instanceof ViewerWriterLockHeldError) return null;
		throw error;
	}
}

/**
 * Takes the database's Viewer lock and records this process as its owner. A live
 * Viewer refuses the start at once. Any other holder, such as a Viewer still
 * shutting down, gets `waitMs` to release it.
 */
export async function claimViewerWriterLock(
	dbPath: string,
	target: { host: string; port: number },
	dependencies: ViewerLockClaimDependencies,
	options: { waitMs?: number; pollMs?: number } = {},
): Promise<ViewerLockClaim> {
	const deadline = Date.now() + (options.waitMs ?? VIEWER_LOCK_WAIT_MS);
	for (;;) {
		const attempt = tryClaim(dbPath, target);
		if (attempt) return attempt;
		const owner = verifiedViewerLockOwner(dbPath, dependencies);
		if (owner && (await dependencies.isLiveViewer(owner))) {
			return {
				status: "refused",
				message: `Another codemem viewer is already using ${dbPath} (pid ${owner.pid} at ${owner.host}:${owner.port}). Stop it with \`codemem service stop\`, or use a separate database for another viewer.`,
			};
		}
		if (Date.now() >= deadline) return { status: "refused", message: heldMessage(dbPath, owner) };
		await dependencies.sleep(options.pollMs ?? 250);
	}
}

/** Waits until no process holds the database's Viewer lock. */
export async function waitForViewerWriterLockRelease(
	dbPath: string,
	dependencies: Pick<ViewerLockClaimDependencies, "isLockHeld" | "sleep">,
	options: { timeoutMs: number; pollMs?: number },
): Promise<boolean> {
	const deadline = Date.now() + options.timeoutMs;
	while (dependencies.isLockHeld(dbPath)) {
		if (Date.now() >= deadline) return false;
		await dependencies.sleep(options.pollMs ?? 200);
	}
	return true;
}

const STARTUP_MESSAGE_TYPE = "codemem-viewer-startup";

/**
 * Set only by a background start for the Viewer it spawns. Any other parent with
 * an IPC channel, such as a test runner's worker pool, gets no startup messages.
 */
export const VIEWER_STARTUP_REPORT_ENV = "CODEMEM_VIEWER_STARTUP_REPORT";

export type ViewerStartupEvent =
	| { state: "lock_acquired" }
	| { state: "listening" }
	| { state: "failed"; message: string };

/**
 * Tells a waiting background parent how this start went. A no-op unless a
 * background start spawned this process. The channel closes after the final
 * result, so the Viewer does not depend on the parent.
 */
export function reportViewerStartup(event: ViewerStartupEvent): void {
	if (process.env[VIEWER_STARTUP_REPORT_ENV] !== "1") return;
	if (!process.send || !process.connected) return;
	const final = event.state !== "lock_acquired";
	process.send({ type: STARTUP_MESSAGE_TYPE, ...event }, undefined, {}, () => {
		if (final && process.connected) process.disconnect();
	});
}

export type BackgroundViewerStartup =
	| { state: "listening" }
	| { state: "starting" }
	| { state: "failed"; message: string };

function startupEvent(message: unknown): ViewerStartupEvent | null {
	const event = message as { type?: unknown; state?: unknown; message?: unknown } | null;
	if (event?.type !== STARTUP_MESSAGE_TYPE) return null;
	if (event.state === "lock_acquired" || event.state === "listening") return { state: event.state };
	if (event.state === "failed") {
		return {
			state: "failed",
			message: typeof event.message === "string" ? event.message : "Viewer failed to start",
		};
	}
	return null;
}

/**
 * Waits for a background Viewer's startup result. `starting`: it holds the lock
 * but was not serving yet when the wait ended.
 */
export function waitForViewerStartup(
	child: Pick<ChildProcess, "on" | "off" | "connected" | "disconnect">,
	timeoutMs: number,
): Promise<BackgroundViewerStartup> {
	return new Promise((resolve) => {
		let lockAcquired = false;
		const finish = (result: BackgroundViewerStartup) => {
			clearTimeout(timer);
			child.off("message", onMessage);
			child.off("exit", onExit);
			child.off("error", onError);
			if (child.connected) child.disconnect();
			resolve(result);
		};
		const onMessage = (message: unknown) => {
			const event = startupEvent(message);
			if (event?.state === "lock_acquired") lockAcquired = true;
			else if (event) finish(event);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
			finish({
				state: "failed",
				message: `The viewer exited during startup (${signal ?? `exit code ${code ?? "unknown"}`}).`,
			});
		const onError = (error: Error) =>
			finish({ state: "failed", message: `Could not start the viewer: ${error.message}` });
		const timer = setTimeout(() => {
			if (lockAcquired) finish({ state: "starting" });
			else
				finish({
					state: "failed",
					message: `The viewer did not report startup within ${Math.ceil(timeoutMs / 1000)}s.`,
				});
		}, timeoutMs);
		child.on("message", onMessage);
		child.on("exit", onExit);
		child.on("error", onError);
	});
}
