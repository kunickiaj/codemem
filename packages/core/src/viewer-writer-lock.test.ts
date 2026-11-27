import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireViewerWriterLock,
	canonicalViewerDbPath,
	isViewerWriterLockHeld,
	processStartIdentity,
	readViewerWriterLockOwner,
	ViewerWriterLockHeldError,
	ViewerWriterLockUnavailableError,
	viewerRuntimeDir,
	viewerWriterLockOwnerPath,
	viewerWriterLockPath,
} from "./viewer-writer-lock.js";
import { holdViewerLockInAnotherProcess, stopHolder } from "./viewer-writer-lock-test-holder.js";

let directory: string;
let dbPath: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-viewer-lock-"));
	dbPath = join(directory, "mem.sqlite");
});

afterEach(() => {
	chmodSync(directory, 0o700);
	rmSync(directory, { recursive: true, force: true });
});

/** Tries to take the lock from a separate Node process; returns its exit code. */
function lockFromAnotherProcess(): number {
	const sqlite = createRequire(import.meta.url).resolve("better-sqlite3");
	const script = `
		const Database = require(${JSON.stringify(sqlite)});
		const lock = new Database(${JSON.stringify(viewerWriterLockPath(dbPath))}, { timeout: 0 });
		try { lock.exec("BEGIN EXCLUSIVE"); process.exit(0); }
		catch (error) { process.exit(error.code === "SQLITE_BUSY" ? 3 : 1); }
	`;
	try {
		execFileSync(process.execPath, ["-e", script], { stdio: "ignore" });
		return 0;
	} catch (error) {
		return (error as { status?: number }).status ?? -1;
	}
}

describe("viewer writer lock", () => {
	it("refuses a second holder in this process and in another one", () => {
		const lock = acquireViewerWriterLock(dbPath);
		try {
			expect(() => acquireViewerWriterLock(dbPath)).toThrow(ViewerWriterLockHeldError);
			expect(lockFromAnotherProcess()).toBe(3);
		} finally {
			lock.release();
		}
	});

	it("can be taken again once released", () => {
		acquireViewerWriterLock(dbPath).release();

		const again = acquireViewerWriterLock(dbPath);
		again.release();

		expect(lockFromAnotherProcess()).toBe(0);
	});
});

describe("viewer writer lock through symlinks", () => {
	function symlinkedPaths() {
		const realDir = join(directory, "real");
		mkdirSync(realDir);
		const realPath = join(realDir, "mem.sqlite");
		writeFileSync(realPath, "");
		const fileLink = join(directory, "alias.sqlite");
		symlinkSync(realPath, fileLink);
		const dirLink = join(directory, "linked");
		symlinkSync(realDir, dirLink);
		return { realPath, fileLink, dirLinkPath: join(dirLink, "mem.sqlite") };
	}

	it("gives a symlinked database the same lock and runtime folder as its real path", () => {
		const { realPath, fileLink, dirLinkPath } = symlinkedPaths();

		const canonical = canonicalViewerDbPath(realPath);
		expect(canonicalViewerDbPath(fileLink)).toBe(canonical);
		expect(canonicalViewerDbPath(dirLinkPath)).toBe(canonical);
		expect(viewerRuntimeDir(fileLink)).toBe(viewerRuntimeDir(realPath));
		expect(canonicalViewerDbPath(join(directory, "new", "mem.sqlite"))).toBe(
			join(canonicalViewerDbPath(directory), "new", "mem.sqlite"),
		);
	});

	it("refuses the real path while another process holds the symlink, and the reverse", async () => {
		const { realPath, fileLink, dirLinkPath } = symlinkedPaths();

		const throughLink = await holdViewerLockInAnotherProcess(fileLink);
		try {
			expect(() => acquireViewerWriterLock(realPath)).toThrow(ViewerWriterLockHeldError);
			expect(() => acquireViewerWriterLock(dirLinkPath)).toThrow(ViewerWriterLockHeldError);
		} finally {
			await stopHolder(throughLink);
		}
		const throughRealPath = await holdViewerLockInAnotherProcess(realPath);
		try {
			expect(() => acquireViewerWriterLock(fileLink)).toThrow(ViewerWriterLockHeldError);
		} finally {
			await stopHolder(throughRealPath);
		}
		acquireViewerWriterLock(fileLink).release();
	});
});

describe("viewer writer lock through a symlink to a database not created yet", () => {
	it("uses the link target's lock before the database file exists", async () => {
		mkdirSync(join(directory, "real"));
		const realPath = join(directory, "real", "mem.sqlite");
		const link = join(directory, "alias.sqlite");
		symlinkSync(realPath, link);

		expect(canonicalViewerDbPath(link)).toBe(canonicalViewerDbPath(realPath));
		const throughLink = await holdViewerLockInAnotherProcess(link);
		try {
			expect(() => acquireViewerWriterLock(realPath)).toThrow(ViewerWriterLockHeldError);
		} finally {
			await stopHolder(throughLink);
		}
	});
});

describe("viewer writer lock owner", () => {
	it("records this process as the owner when it takes the lock, and removes it on release", () => {
		const lock = acquireViewerWriterLock(dbPath, { owner: { host: "127.0.0.1", port: 38_999 } });
		try {
			expect(readViewerWriterLockOwner(dbPath)).toEqual({
				pid: process.pid,
				started: processStartIdentity(process.pid),
				db_path: canonicalViewerDbPath(dbPath),
				host: "127.0.0.1",
				port: 38_999,
			});
		} finally {
			lock.release();
		}
		expect(existsSync(viewerWriterLockOwnerPath(dbPath))).toBe(false);
	});

	it("reports whether another process holds the lock without leaving it taken", async () => {
		expect(isViewerWriterLockHeld(dbPath)).toBe(false);
		const holder = await holdViewerLockInAnotherProcess(dbPath);
		try {
			expect(isViewerWriterLockHeld(dbPath)).toBe(true);
		} finally {
			await stopHolder(holder);
		}
		expect(isViewerWriterLockHeld(dbPath)).toBe(false);
		acquireViewerWriterLock(dbPath).release();
	});

	it.skipIf(process.getuid?.() === 0)(
		"fails clearly when the database folder is not writable",
		() => {
			chmodSync(directory, 0o500);

			const attempt = () => acquireViewerWriterLock(dbPath, { owner: { host: "h", port: 1 } });

			expect(attempt).toThrow(ViewerWriterLockUnavailableError);
			expect(attempt).toThrow(viewerWriterLockPath(dbPath));
		},
	);
});
