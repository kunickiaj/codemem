import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as database from "./db.js";
import { withDiagnosticStoreSnapshot } from "./diagnostic-store-snapshot.js";
import { MemoryStore } from "./store.js";

let directory: string;
let sourcePath: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-snapshot-test-"));
	sourcePath = join(directory, "source.sqlite");
	new MemoryStore(sourcePath).close();
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

it.each(["success", "failure"])(
	"isolates callback writes in a private copy and closes and removes it after %s",
	async (outcome) => {
		// Arrange: observe real connections rather than replacing SQLite or MemoryStore.
		const sourceConnection = vi.spyOn(database, "connectReadOnly");
		const originalBytes = readFileSync(sourcePath);
		const callbackError = new Error("diagnosis failed");
		const snapshots: MemoryStore[] = [];
		let snapshotPath = "";
		let snapshotDirectoryMode = 0;
		let sourceClosedDuringCallback = false;
		let snapshotOpenDuringCallback = false;
		let callbackRows: unknown[] = [];

		// Act: callback writes must be disposable even if diagnosis rejects afterward.
		const result = withDiagnosticStoreSnapshot(sourcePath, async (store) => {
			snapshots.push(store);
			snapshotPath = store.db.name;
			snapshotDirectoryMode = statSync(dirname(snapshotPath)).mode & 0o777;
			sourceClosedDuringCallback = sourceConnection.mock.results[0]?.value.open === false;
			snapshotOpenDuringCallback = store.db.open;
			store.db.exec("CREATE TABLE diagnosis_only (value TEXT NOT NULL)");
			store.db.prepare("INSERT INTO diagnosis_only(value) VALUES (?)").run("copy-only");
			callbackRows = store.db.prepare("SELECT value FROM diagnosis_only").all();
			if (outcome === "failure") throw callbackError;
			return { diagnosis: "complete" };
		});

		// Assert: preserve the result or original error and clean both connection lifetimes.
		if (outcome === "failure") {
			await expect(result).rejects.toBe(callbackError);
		} else {
			await expect(result).resolves.toEqual({ diagnosis: "complete" });
		}
		expect(sourceConnection).toHaveBeenCalledExactlyOnceWith(sourcePath);
		expect(snapshotPath).not.toBe(sourcePath);
		expect(snapshotDirectoryMode).toBe(0o700);
		expect(sourceClosedDuringCallback).toBe(true);
		expect(snapshotOpenDuringCallback).toBe(true);
		expect(callbackRows).toEqual([{ value: "copy-only" }]);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.db.open).toBe(false);
		expect(sourceConnection.mock.results[0]?.value.open).toBe(false);
		expect(existsSync(snapshotPath)).toBe(false);
		expect(existsSync(dirname(snapshotPath))).toBe(false);
		expect(readFileSync(sourcePath).equals(originalBytes)).toBe(true);
	},
);
