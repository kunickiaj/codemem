import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalViewerDbPath, isViewerWriterLockHeld } from "@codemem/core";
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
import { readProcessIdentity } from "./viewer-stop-verification.js";

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

type HolderOptions = Parameters<typeof holdViewerLockInAnotherProcess>[1];

/**
 * A Viewer stand-in answering at a free port, with a codemem Viewer's command line. It
 * holds the lock of `database` and records itself as its owner unless `lock` is false,
 * as a Viewer from before the lock does.
 */
async function viewerServing(database: string, options: HolderOptions = {}) {
	const address = { host: "127.0.0.1", port: await freePort() };
	const holder = await holdViewerLockInAnotherProcess(database, {
		...(options?.lock === false ? {} : { owner: address }),
		...options,
		answerAsViewer: address,
		extraArgs: ["codemem", "serve", "start", "--foreground", ...(options?.extraArgs ?? [])],
	});
	holders.push(holder);
	return { holder, address };
}

/** A Viewer from before the lock that serves this database: listening, reporting it, holding it open. */
function preLockViewer(options: HolderOptions = {}) {
	return viewerServing(dbPath, {
		lock: false,
		profileDbPath: dbPath,
		openFile: dbPath,
		...options,
	});
}

/** Where `name` is on this machine's PATH. */
function commandPath(name: string): string {
	return spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf-8" }).stdout.trim();
}

/** A PATH with `ps` and, when given, an `lsof` replaced by `script` (a shell script body). */
function pathWithLsof(script: string | null, options: { executable?: boolean } = {}) {
	const bin = mkdtempSync(join(directory, "bin-"));
	symlinkSync(commandPath("ps"), join(bin, "ps"));
	if (script !== null) {
		writeFileSync(join(bin, "lsof"), `#!/bin/sh\n${script}\n`);
		chmodSync(join(bin, "lsof"), options.executable === false ? 0o644 : 0o755);
	}
	return bin;
}

const quick = { gracefulMs: 300, forceMs: 2000 };

describe("confirming a Viewer that holds this database's lock", () => {
	it.each(["stop", "restart"] as const)(
		"%s never signals a Viewer on the port that serves another database",
		async (mode) => {
			// Arrange: the Viewer at the port serves database B, and the command names A.
			const other = join(directory, "other.sqlite");
			const { holder, address } = await viewerServing(other, { profileDbPath: other });
			const startViewer = vi.fn(async () => {});

			// Act
			await runServeInvocation(
				resolveStopRestartInvocation(mode, {
					dbPath,
					host: address.host,
					port: String(address.port),
				}),
				{ nativeRuntimeAllowsServeStart: async () => true, stopExistingViewer, startViewer },
			);

			// Assert
			expect(holder.exitCode).toBeNull();
			expect(holder.signalCode).toBeNull();
			expect(startViewer).not.toHaveBeenCalled();
			expect(printed()).toContain(
				`The viewer at ${address.host}:${address.port} (pid ${holder.pid}) could not be confirmed to serve ${dbPath}: `,
			);
			expect(printed()).toContain("Nothing was stopped.");
			expect(process.exitCode).toBe(1);
		},
	);

	it("stops the Viewer on the port that holds this database's lock, reached through a symlink", async () => {
		const { holder, address } = await viewerServing(dbPath);
		const link = join(directory, "link.sqlite");
		symlinkSync(dbPath, link);
		const exited = new Promise((resolve) => holder.once("exit", resolve));

		const result = await stopExistingViewer(link, address);

		expect(result).toEqual({ stopped: true, pid: holder.pid });
		await exited;
		expect(holder.signalCode).toBe("SIGTERM");
	});

	/** Rewrites this database's lock owner record, as a stale or copied record would read. */
	function forgeOwner(change: Record<string, unknown>) {
		const path = `${canonicalViewerDbPath(dbPath)}.viewer-lock.owner`;
		const owner = JSON.parse(readFileSync(path, "utf-8"));
		writeFileSync(path, JSON.stringify({ ...owner, ...change }));
	}

	it.each([
		["another start time", { started: "Thu Jan  1 00:00:00 2026" }],
		["another database", { db_path: "/elsewhere/other.sqlite" }],
	])("never signals a Viewer whose owner record shows %s", async (_label, change) => {
		const { holder, address } = await viewerServing(dbPath);
		forgeOwner(change);

		const result = await stopExistingViewer(dbPath, address);

		expect(result.refused?.pid).toBe(holder.pid);
		expect(result.refused?.reason).toContain("lock record");
		expect(holder.signalCode).toBeNull();
	});

	it("never signals a Viewer named by an owner record whose lock nobody holds", async () => {
		// Arrange: the Viewer locks another database; this database's record names it anyway.
		const other = join(directory, "other.sqlite");
		const { holder, address } = await viewerServing(other);
		const record = JSON.parse(
			readFileSync(`${canonicalViewerDbPath(other)}.viewer-lock.owner`, "utf-8"),
		);
		writeFileSync(
			`${canonicalViewerDbPath(dbPath)}.viewer-lock.owner`,
			JSON.stringify({ ...record, db_path: canonicalViewerDbPath(dbPath) }),
		);

		const result = await stopExistingViewer(dbPath, address);

		expect(isViewerWriterLockHeld(dbPath)).toBe(false);
		expect(result.refused?.pid).toBe(holder.pid);
		expect(holder.signalCode).toBeNull();
	});

	it("never signals a Viewer from before the lock while another process holds this database's lock", async () => {
		await viewerServing(dbPath);
		const preLock = await viewerServing(join(directory, "named.sqlite"), {
			lock: false,
			profileDbPath: dbPath,
			openFile: dbPath,
		});

		const result = await stopExistingViewer(dbPath, preLock.address);

		expect(result.refused).toMatchObject({
			pid: preLock.holder.pid,
			reason: "another process holds the database's lock",
		});
		expect(preLock.holder.signalCode).toBeNull();
	});

	it("never signals the Viewer of another database in the same folder through the shared PID record", async () => {
		const other = join(directory, "other.sqlite");
		const { holder, address } = await viewerServing(other, { profileDbPath: other });
		writeFileSync(join(directory, "viewer.pid"), JSON.stringify({ pid: holder.pid, ...address }));

		// Nothing answers at the port the command names, so the record is tried.
		const result = await stopExistingViewer(dbPath, { host: "127.0.0.1", port: await freePort() });

		expect(result).toMatchObject({ stopped: false, pid: null, refused: { pid: holder.pid } });
		expect(holder.signalCode).toBeNull();
	});
});

describe("choosing and signalling a Viewer that holds this database's lock", () => {
	it("never signals a lock holder that is not the listener its PID record names", async () => {
		// Arrange: the lock holder serves nothing; a Viewer for this database listens at the
		// port its record gives.
		const lockHolder = await holdViewerLockInAnotherProcess(dbPath, {
			owner: UNSERVED,
			extraArgs: ["codemem", "serve", "start", "--foreground"],
		});
		holders.push(lockHolder);
		const listener = await viewerServing(join(directory, "listener.sqlite"), {
			lock: false,
			profileDbPath: dbPath,
			openFile: dbPath,
		});
		writeFileSync(
			join(directory, "viewer.pid"),
			JSON.stringify({ pid: lockHolder.pid, ...listener.address }),
		);

		// Act
		const result = await stopExistingViewer(dbPath, { host: "127.0.0.1", port: await freePort() });

		// Assert
		expect(result.refused).toMatchObject({
			pid: lockHolder.pid,
			reason: `it is not the process listening on port ${listener.address.port}`,
		});
		expect(lockHolder.signalCode).toBeNull();
	});

	it("leaves an unrelated process on the port alone and reports no Viewer", async () => {
		// Arrange: it answers like a Viewer, but its command line is not a codemem Viewer's.
		const address = { host: "127.0.0.1", port: await freePort() };
		const unrelated = await holdViewerLockInAnotherProcess(join(directory, "x.sqlite"), {
			lock: false,
			answerAsViewer: address,
		});
		holders.push(unrelated);

		// Act
		const result = await stopExistingViewer(dbPath, address);

		// Assert
		expect(result).toEqual({ stopped: false, pid: null });
		expect(unrelated.signalCode).toBeNull();
	});

	it("force-stops a stuck Viewer that still holds this database's lock", async () => {
		const { holder, address } = await viewerServing(dbPath, { onSigterm: "ignore" });
		const exited = new Promise((resolve) => holder.once("exit", resolve));

		const result = await stopExistingViewer(dbPath, address, quick);

		await exited;
		expect(result).toEqual({ stopped: true, pid: holder.pid });
		expect(holder.signalCode).toBe("SIGKILL");
	});

	it("keeps to the lock proof before SIGKILL, even when the open-database proof would pass", async () => {
		// Arrange: on SIGTERM it releases the lock but keeps listening, reporting and holding
		// the database open, which would satisfy the proof for a Viewer from before the lock.
		const { holder, address } = await viewerServing(dbPath, {
			profileDbPath: dbPath,
			openFile: dbPath,
			onSigterm: "release-lock",
		});

		// Act
		const result = await stopExistingViewer(dbPath, address, quick);

		// Assert
		expect(result).toEqual({ stopped: false, pid: holder.pid });
		expect(holder.signalCode).toBeNull();
	});
});

describe("confirming a Viewer from before the lock", () => {
	it("stops one that listens on the port, reports this database and has it open", async () => {
		const { holder, address } = await preLockViewer();

		const result = await stopExistingViewer(dbPath, address);

		expect(result).toEqual({ stopped: true, pid: holder.pid });
	});

	it("counts the write-ahead log as having the database open", async () => {
		const { holder, address } = await preLockViewer({ openFile: `${dbPath}-wal` });

		const result = await stopExistingViewer(dbPath, address);

		expect(result).toEqual({ stopped: true, pid: holder.pid });
	});

	it.each([
		[
			"a foreign Viewer with both databases open",
			{
				profileDbPath: join("{dir}", "other.sqlite"),
				openFile: [join("{dir}", "other.sqlite"), "{db}"],
			},
			"it reports another database",
		],
		[
			"one that reports no database",
			{ profileDbPath: undefined },
			"it did not report which database it serves",
		],
		[
			"one that does not have it open",
			{ openFile: join("{dir}", "other.sqlite") },
			"it does not have the database open",
		],
	])("refuses %s", async (_label, change, reason) => {
		// Arrange: paths are filled in once the test folder exists.
		const fill = (value: string) => value.replace("{dir}", directory).replace("{db}", dbPath);
		const options: HolderOptions = {};
		if ("profileDbPath" in change)
			options.profileDbPath =
				change.profileDbPath === undefined ? undefined : fill(change.profileDbPath);
		if ("openFile" in change) options.openFile = [change.openFile].flat().map(fill);
		const { holder, address } = await preLockViewer(options);

		// Act
		const result = await stopExistingViewer(dbPath, address);

		// Assert
		expect(result.refused).toEqual({ pid: holder.pid, ...address, reason });
		expect(holder.signalCode).toBeNull();
	});

	it("never signals a process that has this database open but is not the listener its record names", async () => {
		// Arrange: a CLI-like process holds the database open and a Viewer for this database
		// answers at the port the record gives, but that process is not the one listening.
		const listener = await preLockViewer();
		const bystander = await holdViewerLockInAnotherProcess(dbPath, {
			lock: false,
			openFile: dbPath,
			extraArgs: ["codemem", "serve", "start", "--foreground"],
		});
		holders.push(bystander);
		writeFileSync(
			join(directory, "viewer.pid"),
			JSON.stringify({ pid: bystander.pid, ...listener.address }),
		);

		// Act
		const result = await stopExistingViewer(dbPath, { host: "127.0.0.1", port: await freePort() });

		// Assert
		expect(result.refused).toMatchObject({
			pid: bystander.pid,
			reason: `it is not the process listening on port ${listener.address.port}`,
		});
		expect(bystander.signalCode).toBeNull();
		expect(listener.holder.signalCode).toBeNull();
	});

	it("stops the listener, never another process its answer names", async () => {
		// Arrange: a CLI-like process holds the database open, and the Viewer's stats answer
		// names it instead of the Viewer.
		const bystander = await holdViewerLockInAnotherProcess(dbPath, {
			lock: false,
			openFile: dbPath,
			extraArgs: ["codemem", "serve", "start", "--foreground"],
		});
		holders.push(bystander);
		const { holder, address } = await preLockViewer({ reportedPid: bystander.pid });

		// Act
		const result = await stopExistingViewer(dbPath, address);

		// Assert
		expect(result).toEqual({ stopped: true, pid: holder.pid });
		expect(bystander.signalCode).toBeNull();
	});

	it("does not count a file lsof marks as deleted", async () => {
		// Arrange: Linux names a file removed while open with a " (deleted)" suffix.
		const { holder, address } = await preLockViewer();
		const canonical = canonicalViewerDbPath(dbPath);
		const bin = pathWithLsof(
			`case "$*" in *-iTCP*) echo ${holder.pid} ;; *) printf 'p${holder.pid}\\nn${canonical} (deleted)\\n' ;; esac`,
		);
		vi.stubEnv("PATH", bin);

		// Act
		const result = await stopExistingViewer(dbPath, address);

		// Assert
		expect(result.refused?.reason).toBe("it does not have the database open");
		expect(holder.signalCode).toBeNull();
	});

	it("force-stops a stuck one that still has this database open", async () => {
		const { holder, address } = await preLockViewer({ onSigterm: "ignore" });
		const exited = new Promise((resolve) => holder.once("exit", resolve));

		const result = await stopExistingViewer(dbPath, address, quick);

		await exited;
		expect(result).toEqual({ stopped: true, pid: holder.pid });
		expect(holder.signalCode).toBe("SIGKILL");
	});

	it.each(["port", "record"] as const)(
		"does not force-stop one that closed this database before the escalation (found by %s)",
		async (via) => {
			// Arrange: on SIGTERM it closes the database and keeps running.
			const { holder, address } = await preLockViewer({ onSigterm: "close-file" });
			let target = address;
			if (via === "record") {
				writeFileSync(
					join(directory, "viewer.pid"),
					JSON.stringify({ pid: holder.pid, ...address }),
				);
				target = { host: "127.0.0.1", port: await freePort() };
			}

			// Act
			const result = await stopExistingViewer(dbPath, target, quick);

			// Assert
			expect(result).toEqual({ stopped: false, pid: holder.pid });
			expect(holder.signalCode).toBeNull();
		},
	);
});

describe("refusing when the process list cannot be read", () => {
	it.each([
		["is missing", null, {}, "lsof is not installed or not on PATH"],
		[
			"cannot be executed",
			"exit 0",
			{ executable: false },
			"lsof could not be run (permission denied)",
		],
		[
			"does not answer in time",
			`${commandPath("sleep")} 5`,
			{},
			"lsof did not answer within 2000 ms",
		],
		[
			"fails",
			"echo 'lsof: no permission' >&2; exit 1",
			{},
			"lsof failed with status 1: lsof: no permission",
		],
	] as const)(
		"refuses on macOS and Linux when lsof %s",
		async (_label, script, options, reason) => {
			const { holder, address } = await preLockViewer();
			vi.stubEnv("PATH", pathWithLsof(script, options));

			const result = await stopExistingViewer(dbPath, address);

			expect(result.refused).toEqual({ pid: holder.pid, ...address, reason });
			expect(holder.signalCode).toBeNull();
		},
	);

	it("refuses a Viewer found through its PID record when lsof cannot run", async () => {
		// Arrange: nothing answers at the port the command names, so the record is tried.
		const { holder, address } = await preLockViewer();
		writeFileSync(join(directory, "viewer.pid"), JSON.stringify({ pid: holder.pid, ...address }));
		const elsewhere = { host: "127.0.0.1", port: await freePort() };
		vi.stubEnv("PATH", pathWithLsof(null));

		// Act
		const result = await stopExistingViewer(dbPath, elsewhere);

		// Assert
		expect(result.refused).toEqual({
			pid: holder.pid,
			...address,
			reason: "lsof is not installed or not on PATH",
		});
		expect(holder.signalCode).toBeNull();
	});

	it("stops on port and command line alone only on native Windows, where nothing else can be read", async () => {
		// Arrange: no lsof. The Viewer has another database open and reports it.
		const other = join(directory, "other.sqlite");
		const { holder, address } = await preLockViewer({ profileDbPath: other, openFile: other });
		vi.stubEnv("PATH", pathWithLsof(null));

		// Act
		const onLinux = await stopExistingViewer(dbPath, address, { platform: "linux" });
		const onWindows = await stopExistingViewer(dbPath, address, { platform: "win32" });

		// Assert
		expect(onLinux.refused?.reason).toBe("lsof is not installed or not on PATH");
		expect(onWindows).toEqual({ stopped: true, pid: holder.pid });
	});
});

describe("binding each signal to the verified process", () => {
	/** Reads the real identity, except that from read `from` on the pid names another process. */
	function replacedFrom(from: number) {
		let reads = 0;
		return (pid: number) => {
			reads += 1;
			if (reads >= from) return { started: "Thu Jan  1 00:00:00 2026", command: "/usr/bin/vim" };
			return readProcessIdentity(pid);
		};
	}

	it("sends nothing when the pid names another process between verification and SIGTERM", async () => {
		// Reads: choosing the candidate, verification, then right before SIGTERM.
		const { holder, address } = await preLockViewer();

		const result = await stopExistingViewer(dbPath, address, { readIdentity: replacedFrom(3) });

		expect(result.refused?.reason).toBe(
			"its process changed or stopped serving the database before it could be signalled",
		);
		expect(holder.signalCode).toBeNull();
	});

	it("does not SIGKILL when the pid names another process between SIGTERM and SIGKILL", async () => {
		const { holder, address } = await preLockViewer({ onSigterm: "ignore" });

		await stopExistingViewer(dbPath, address, { ...quick, readIdentity: replacedFrom(4) });

		expect(holder.signalCode).toBeNull();
		expect(holder.exitCode).toBeNull();
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
