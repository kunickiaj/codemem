import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DatabaseFileIdentity,
	databaseFileAt,
	databaseFileOpened,
	fileIdentityOf,
	isDatabaseFileUnchanged,
	isSameDatabaseFile,
} from "./database-file-identity.js";

// Above 2^53 a JavaScript number cannot tell these two inodes apart.
const LARGE_INODE = 9_007_199_254_740_992n;
const NEXT_INODE = LARGE_INODE + 1n;

function identified(ino: bigint, wal: bigint | null = null): DatabaseFileIdentity {
	return {
		path: "/store/mem.sqlite",
		fileIdentity: fileIdentityOf({ dev: 16_777_234n, ino }),
		walIdentity: wal === null ? null : fileIdentityOf({ dev: 16_777_234n, ino: wal }),
	};
}

describe("comparing file identities", () => {
	it("tells two large inodes apart that are equal as numbers", () => {
		expect(Number(LARGE_INODE)).toBe(Number(NEXT_INODE));

		expect(fileIdentityOf({ dev: 1n, ino: LARGE_INODE })).not.toBe(
			fileIdentityOf({ dev: 1n, ino: NEXT_INODE }),
		);
		expect(isSameDatabaseFile(identified(LARGE_INODE), identified(NEXT_INODE))).toBe(false);
		expect(isSameDatabaseFile(identified(LARGE_INODE), identified(LARGE_INODE))).toBe(true);
	});

	it("tells two large device numbers apart that are equal as numbers", () => {
		expect(fileIdentityOf({ dev: LARGE_INODE, ino: 7n })).not.toBe(
			fileIdentityOf({ dev: NEXT_INODE, ino: 7n }),
		);
	});

	it("compares the write-ahead log that was identified, large inodes included", () => {
		const opened = identified(5n, LARGE_INODE);

		expect(isSameDatabaseFile(opened, identified(5n, LARGE_INODE))).toBe(true);
		expect(isSameDatabaseFile(opened, identified(5n, NEXT_INODE))).toBe(false);
		expect(isSameDatabaseFile(opened, identified(5n, null))).toBe(false);
	});

	it("does not compare a log that appeared after the file was identified", () => {
		expect(isSameDatabaseFile(identified(5n, null), identified(5n, 9n))).toBe(true);
	});

	it("is never the same file as nothing, or as a file at another path", () => {
		expect(isSameDatabaseFile(identified(5n), null)).toBe(false);
		expect(
			isSameDatabaseFile(identified(5n), { ...identified(5n), path: "/other/mem.sqlite" }),
		).toBe(false);
	});
});

describe("identifying a store file on disk", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codemem-file-identity-"));
		path = join(dir, "mem.sqlite");
		writeFileSync(path, "database");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("includes the write-ahead log when there is one", () => {
		const withoutLog = databaseFileAt(path);
		writeFileSync(`${path}-wal`, "log");
		const withLog = databaseFileAt(path);

		expect(withoutLog?.walIdentity).toBeNull();
		expect(withLog?.walIdentity).toMatch(/^\d+:\d+$/u);
		expect(withLog?.fileIdentity).toBe(withoutLog?.fileIdentity);
	});

	it("sees a replaced write-ahead log as another file", () => {
		writeFileSync(`${path}-wal`, "log");
		const opened = databaseFileAt(path);
		if (!opened) throw new Error("no file identified");
		writeFileSync(join(dir, "other-wal"), "another log");

		renameSync(join(dir, "other-wal"), `${path}-wal`);

		expect(isDatabaseFileUnchanged(opened)).toBe(false);
	});

	it("sees a removed write-ahead log as another file", () => {
		writeFileSync(`${path}-wal`, "log");
		const opened = databaseFileAt(path);
		if (!opened) throw new Error("no file identified");

		rmSync(`${path}-wal`);

		expect(isDatabaseFileUnchanged(opened)).toBe(false);
	});

	it("takes the log as it is after the open, which may have created it", () => {
		const before = databaseFileAt(path);
		writeFileSync(`${path}-wal`, "log");

		const opened = databaseFileOpened(before, path);

		expect(before?.walIdentity).toBeNull();
		expect(opened?.walIdentity).toMatch(/^\d+:\d+$/u);
		expect(opened && isDatabaseFileUnchanged(opened)).toBe(true);
	});
});
