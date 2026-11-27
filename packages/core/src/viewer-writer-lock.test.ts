import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireViewerWriterLock,
	ViewerWriterLockHeldError,
	viewerWriterLockPath,
} from "./viewer-writer-lock.js";

let directory: string;
let dbPath: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-viewer-lock-"));
	dbPath = join(directory, "mem.sqlite");
});

afterEach(() => {
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
