import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Database } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkpointWalWithoutBlocking, SLOW_WAL_CHECKPOINT_MS } from "./wal-checkpoint.js";

let directory: string;
let dbPath: string;
let db: Database;
let other: Database;
const logger = { step: vi.fn(), warn: vi.fn() };

function walBytes(): number {
	return statSync(`${dbPath}-wal`).size;
}

function writeRows(connection: Database, count: number): void {
	const insert = connection.prepare("INSERT INTO wal_probe(value) VALUES (?)");
	connection.transaction(() => {
		for (let index = 0; index < count; index++) insert.run("x".repeat(512));
	})();
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-wal-checkpoint-"));
	dbPath = join(directory, "mem.sqlite");
	db = connect(dbPath);
	db.pragma("wal_autocheckpoint = 0");
	db.exec("CREATE TABLE wal_probe(value TEXT)");
	other = connect(dbPath);
	other.pragma("wal_autocheckpoint = 0");
	logger.step.mockReset();
	logger.warn.mockReset();
});

afterEach(() => {
	if (other.inTransaction) other.exec("ROLLBACK");
	other.close();
	db.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("checkpointWalWithoutBlocking", () => {
	it("copies and truncates the WAL when no other connection is using it", () => {
		// Arrange
		writeRows(db, 200);
		expect(walBytes()).toBeGreaterThan(0);

		// Act
		const result = checkpointWalWithoutBlocking(db, logger);

		// Assert
		expect(result).toMatchObject({ remainingFrames: 0, truncated: true });
		expect(walBytes()).toBe(0);
	});

	it("skips the truncate immediately while another connection holds the write lock", () => {
		// Arrange: busy_timeout is 5 s, so a waiting TRUNCATE would take that long.
		writeRows(db, 200);
		other.exec("BEGIN IMMEDIATE");
		other.prepare("INSERT INTO wal_probe(value) VALUES ('pending')").run();

		// Act
		const started = performance.now();
		const result = checkpointWalWithoutBlocking(db, logger);
		const elapsed = performance.now() - started;

		// Assert
		expect(result.truncated).toBe(false);
		expect(result.remainingFrames).toBe(0);
		expect(elapsed).toBeLessThan(1_000);
		expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
		other.exec("COMMIT");
	});

	it("leaves frames behind an open reader without attempting the truncate", () => {
		// Arrange: the reader pins a snapshot taken before the newest frames.
		writeRows(db, 50);
		other.exec("BEGIN");
		other.prepare("SELECT COUNT(*) FROM wal_probe").get();
		writeRows(db, 50);

		// Act
		const result = checkpointWalWithoutBlocking(db, logger);

		// Assert
		expect(result.truncated).toBe(false);
		expect(result.remainingFrames).toBeGreaterThan(0);
		other.exec("COMMIT");
	});

	it("logs the time when a checkpoint is slow", () => {
		// Arrange
		writeRows(db, 10);
		const times = [0, SLOW_WAL_CHECKPOINT_MS + 50];
		const now = () => times.shift() ?? 0;

		// Act
		checkpointWalWithoutBlocking(db, logger, now);

		// Assert
		expect(logger.step).toHaveBeenCalledExactlyOnceWith(
			"WAL checkpoint took 300 ms (0 frames left, truncated: yes)",
		);
	});

	it("does not log a fast checkpoint", () => {
		// Arrange
		writeRows(db, 10);
		const times = [0, 5];

		// Act
		checkpointWalWithoutBlocking(db, logger, () => times.shift() ?? 0);

		// Assert
		expect(logger.step).not.toHaveBeenCalled();
	});
});
