import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireViewerWriterLock } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimViewerWriterLock } from "./serve.js";

let directory: string;
let previousExitCode: typeof process.exitCode;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-serve-lock-"));
	previousExitCode = process.exitCode;
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = previousExitCode;
	rmSync(directory, { recursive: true, force: true });
});

describe("serve writer lock", () => {
	it("refuses to start a second viewer on one database", () => {
		const dbPath = join(directory, "mem.sqlite");
		const running = acquireViewerWriterLock(dbPath);
		try {
			expect(claimViewerWriterLock(dbPath)).toBeNull();
			expect(process.exitCode).toBe(1);
		} finally {
			running.release();
		}
	});

	it("takes the lock when no other viewer holds it", () => {
		const lock = claimViewerWriterLock(join(directory, "mem.sqlite"));

		expect(lock).not.toBeNull();
		lock?.release();
	});
});
