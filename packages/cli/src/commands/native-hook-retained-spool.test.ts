import * as disk from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHookIngestSpool } from "./hook-ingest-spool.js";
import {
	inspectNativeHookRejectedReceipt,
	listNativeHookRejectedReceipts,
	retainNativeHookReceipt,
} from "./native-hook-retained-spool.js";

vi.mock("node:fs", async (importActual) => {
	const actual = await importActual<typeof import("node:fs")>();
	return {
		...actual,
		linkSync: vi.fn(actual.linkSync),
		fsyncSync: vi.fn(actual.fsyncSync),
		unlinkSync: vi.fn(actual.unlinkSync),
		readSync: vi.fn(actual.readSync),
		readFileSync: vi.fn(actual.readFileSync),
		copyFileSync: vi.fn(actual.copyFileSync),
		fstatSync: vi.fn(actual.fstatSync),
		writeSync: vi.fn(actual.writeSync),
	};
});

const original = "hook-1730000000-123-1234.json";
const retained = `rejected-400-invalid_payload-${original}.retained`;
const bytes = Buffer.from(' \n{"session_id":"private-session","prompt":"café"}\n');
let home: string;
let dir: string;
let actualDisk: typeof import("node:fs");

beforeEach(async () => {
	vi.clearAllMocks();
	actualDisk = await vi.importActual<typeof import("node:fs")>("node:fs");
	vi.mocked(disk.linkSync).mockImplementation(actualDisk.linkSync);
	vi.mocked(disk.fsyncSync).mockImplementation(actualDisk.fsyncSync);
	vi.mocked(disk.unlinkSync).mockImplementation(actualDisk.unlinkSync);
	vi.mocked(disk.readSync).mockImplementation(actualDisk.readSync);
	vi.mocked(disk.readFileSync).mockImplementation(actualDisk.readFileSync);
	vi.mocked(disk.copyFileSync).mockImplementation(actualDisk.copyFileSync);
	vi.mocked(disk.fstatSync).mockImplementation(actualDisk.fstatSync);
	vi.mocked(disk.writeSync).mockImplementation(actualDisk.writeSync);
	home = await fs.mkdtemp(join(tmpdir(), "codemem-native-retain-"));
	dir = join(home, "spool");
	await fs.mkdir(dir, { mode: 0o755 });
	await fs.chmod(dir, 0o755);
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_CLAUDE_HOOK_SPOOL_DIR", dir);
	vi.stubEnv("CODEMEM_PLUGIN_LOG", "0");
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await fs.rm(home, { recursive: true, force: true });
});

async function fixture(name = original, mode = 0o644) {
	const path = join(dir, name);
	await fs.writeFile(path, bytes);
	await fs.chmod(path, mode);
	await fs.utimes(path, 1_730_000_000, 1_730_000_001);
	return { path, before: await fs.stat(path) };
}

function retain(receipt = original) {
	return retainNativeHookReceipt({ dir, receipt, status: 400, reason: "invalid_payload" });
}

it.each([
	original,
	"hook-recovered-1730000000-123-1234.json",
	"zz-hook-live-1730000000000-z00000000000000000001-123-1234.json",
])(
	"retains actual writer basename %s without changing legacy permissions or bytes",
	async (name) => {
		// Arrange: legacy 0755/0644 remains supported without permission repair.
		const { before } = await fixture(name);
		const destination = `rejected-400-invalid_payload-${name}.retained`;
		// Act
		const result = await retain(name);
		// Assert
		expect(result).toMatchObject({
			outcome: "retained",
			receipt: destination,
			bytes: bytes.length,
		});
		expect(await fs.readdir(dir)).toEqual([destination]);
		expect(await fs.readFile(join(dir, destination))).toEqual(bytes);
		expect(await fs.stat(join(dir, destination))).toMatchObject({
			dev: before.dev,
			ino: before.ino,
			mode: before.mode,
			mtimeMs: before.mtimeMs,
		});
		expect((await fs.stat(dir)).mode & 0o777).toBe(0o755);
	},
);

it("supports the distinct 413 payload-too-large receipt", async () => {
	// Arrange
	await fixture();
	// Act
	const result = await retainNativeHookReceipt({
		dir,
		receipt: original,
		status: 413,
		reason: "payload_too_large",
	});
	// Assert
	expect(result).toMatchObject({
		outcome: "retained",
		receipt: `rejected-413-payload_too_large-${original}.retained`,
	});
});

it("finishes an interrupted same-inode hard link and recognizes a completed retry", async () => {
	// Arrange
	const { path, before } = await fixture();
	await fs.link(path, join(dir, retained));
	// Act
	const resumed = await retain();
	const completed = await retain();
	// Assert
	expect(["retained", "already_retained"]).toContain(resumed.outcome);
	expect(completed).toMatchObject({ outcome: "already_retained", receipt: retained });
	expect(await fs.readdir(dir)).toEqual([retained]);
	expect((await fs.stat(join(dir, retained))).ino).toBe(before.ino);
});

it.each([retained, `rejected-413-payload_too_large-${original}.retained`])(
	"does not overwrite a different-inode collision at %s",
	async (destination) => {
		// Arrange
		await fixture();
		await fs.writeFile(join(dir, destination), "other retained bytes", { mode: 0o600 });
		// Act
		expect(() => retain()).toThrow();
		// Assert
		expect(await fs.readFile(join(dir, original))).toEqual(bytes);
		expect(await fs.readFile(join(dir, destination), "utf8")).toBe("other retained bytes");
	},
);

it.each([
	"../outside.json",
	"hook-1.json",
	"hook-1730000000-123-123.json",
	".hook-tmp-123.json",
	"arbitrary.json",
	retained,
])("rejects non-writer source names without modifying the queue (%s)", async (name) => {
	// Arrange
	await fixture();
	// Act
	expect(() => retain(name)).toThrow();
	// Assert
	expect(await fs.readdir(dir)).toEqual([original]);
	expect(await fs.readFile(join(dir, original))).toEqual(bytes);
});

it.each([0o775, 0o777])("refuses a writable spool directory (%s)", async (mode) => {
	// Arrange
	await fixture();
	await fs.chmod(dir, mode);
	// Act
	expect(() => retain()).toThrow();
	// Assert
	expect(await fs.readFile(join(dir, original))).toEqual(bytes);
	expect((await fs.stat(dir)).mode & 0o777).toBe(mode);
});

it.each(["symlink", "directory", "writable-file", "symlink-dir", "writable-parent"])(
	"refuses unsafe paths without losing source bytes (%s)",
	async (kind) => {
		// Arrange
		const outside = join(home, "outside");
		await fs.writeFile(outside, bytes, { mode: 0o600 });
		if (kind === "symlink") await fs.symlink(outside, join(dir, original));
		else if (kind === "directory") await fs.mkdir(join(dir, original));
		else {
			await fixture();
			if (kind === "writable-file") await fs.chmod(join(dir, original), 0o666);
			if (kind === "writable-parent") await fs.chmod(home, 0o777);
			if (kind === "symlink-dir") {
				await fs.rename(dir, join(home, "actual"));
				await fs.symlink(join(home, "actual"), dir);
			}
		}
		// Act
		expect(() => retain()).toThrow();
		// Assert
		expect(await fs.readFile(outside)).toEqual(bytes);
		expect(await fs.readdir(dir)).toEqual([original]);
	},
);

it.each(["busy", "dead", "unverifiable"])(
	"never steals an existing %s retention lock",
	async (owner) => {
		// Arrange: stale/dead metadata must not authorize destructive lock stealing.
		await fixture();
		const lock = join(dir, `.native-retain-${original}.lock`);
		const metadata = JSON.stringify({
			pid: owner === "busy" ? process.pid : 2147483647,
			token: owner === "unverifiable" ? "invalid" : "12345678-1234-4123-8123-123456789abc",
			purpose: "native-hook-receipt",
			version: 1,
			receipt: original,
		});
		vi.spyOn(process, "kill").mockImplementation(() => {
			if (owner === "dead") throw Object.assign(new Error("absent"), { code: "ESRCH" });
			return true;
		});
		await fs.writeFile(lock, metadata, { mode: 0o600 });
		await fs.utimes(lock, 1, 1);
		// Act
		expect(() => retain()).toThrow(
			expect.objectContaining({ code: owner === "busy" ? "lock_busy" : "lock_repair_required" }),
		);
		// Assert
		expect(await fs.readFile(lock, "utf8")).toBe(metadata);
		expect(await fs.readFile(join(dir, original))).toEqual(bytes);
	},
);

it("retains a 32 MiB sparse file without changing its inode or allocating a copy", async () => {
	// Arrange
	const handle = await fs.open(join(dir, original), "wx", 0o644);
	await handle.truncate(32 * 1024 * 1024);
	await handle.close();
	const before = await fs.stat(join(dir, original));
	vi.mocked(disk.readSync).mockImplementation((...args) => {
		if (actualDisk.fstatSync(args[0]).ino === before.ino)
			throw new Error("payload read prohibited");
		return Reflect.apply(actualDisk.readSync, actualDisk, args);
	});
	// Act
	const result = await retain();
	// Assert
	expect(result).toMatchObject({ outcome: "retained", bytes: before.size });
	expect(disk.readFileSync).not.toHaveBeenCalled();
	expect(disk.copyFileSync).not.toHaveBeenCalled();
	expect(disk.readSync).toHaveBeenCalled(); // Ownership checks may read only the small lock record.
	expect(await fs.stat(join(dir, retained))).toMatchObject({
		ino: before.ino,
		dev: before.dev,
		size: before.size,
		blocks: before.blocks,
	});
});

it("lists mode-000 and invalid payloads as metadata without validating contents", async () => {
	// Arrange
	await fs.writeFile(join(dir, retained), Buffer.from([0xff]));
	await fs.chmod(join(dir, retained), 0);
	// Act
	const entries = await listNativeHookRejectedReceipts({ provider: "claude" });
	// Assert
	expect(disk.readSync).not.toHaveBeenCalled();
	expect(disk.readFileSync).not.toHaveBeenCalled();
	expect(entries).toEqual([
		{
			receipt: retained,
			bytes: 1,
			status: 400,
			reason: "invalid_payload",
			validation: "not_checked",
		},
	]);
	expect((await fs.stat(join(dir, retained))).mode & 0o777).toBe(0);
});

it("does not create a missing directory while listing", async () => {
	// Arrange
	await fs.rmdir(dir);
	// Act
	const entries = await listNativeHookRejectedReceipts({ provider: "claude" });
	// Assert
	expect(entries).toEqual([]);
	expect(await fs.readdir(home)).toEqual([]);
});

it("keeps retained receipts and locks outside the actual drainer's active queue", async () => {
	// Arrange
	const spool = createHookIngestSpool({
		logPrefix: "test",
		spoolDirEnv: "CODEMEM_CLAUDE_HOOK_SPOOL_DIR",
		spoolDirDefault: dir,
		lockDirEnv: "CODEMEM_TEST_LOCK",
		lockDirDefault: join(home, "lock"),
		lockTtlEnv: "CODEMEM_TEST_TTL",
		lockTtlDefault: 30,
		lockGraceEnv: "CODEMEM_TEST_GRACE",
		lockGraceDefault: 1,
		lockAcquireAttempts: 1,
		lockBusyErrorName: "Busy",
		lockBusyErrorMessage: "busy",
	});
	await fs.writeFile(join(dir, retained), bytes);
	await fs.writeFile(join(dir, `.native-retain-${original}.lock`), "{}");
	const handler = vi.fn(() => true);
	// Act
	const inactive = spool.hasSpooledEntries();
	const ignored = await spool.drainSpool(handler);
	spool.spoolPayload({ session_id: "active" });
	const active = spool.hasSpooledEntries();
	const drained = await spool.drainSpool(handler);
	// Assert
	expect(inactive).toBe(false);
	expect(ignored).toEqual({ processed: 0, failed: 0 });
	expect(active).toBe(true);
	expect(drained).toEqual({ processed: 1, failed: 0 });
	expect(handler).toHaveBeenCalledTimes(1);
	expect((await fs.readdir(dir)).sort()).toEqual(
		[`.native-retain-${original}.lock`, retained].sort(),
	);
});

it.each(["null", "[]", "not-json"])(
	"reports invalid native envelopes without returning text (%s)",
	async (text) => {
		// Arrange
		await fs.writeFile(join(dir, retained), text, { mode: 0o600 });
		// Act
		const entry = await inspectNativeHookRejectedReceipt({ provider: "claude", receipt: retained });
		// Assert
		expect(entry).toMatchObject({ receipt: retained, validation: "invalid" });
		expect(entry).not.toHaveProperty("serialized");
		expect(await fs.readFile(join(dir, retained), "utf8")).toBe(text);
	},
);

it.each(["link", "source-fsync", "directory-fsync", "unlink", "final-fsync"])(
	"preserves at least one exact copy after %s fails",
	async (stage) => {
		// Arrange: fault only one concrete persistence operation, without touching fixtures.
		const { before } = await fixture();
		const failure = () => {
			throw Object.assign(new Error("private-fault-path"), { code: "EIO" });
		};
		if (stage === "link") vi.mocked(disk.linkSync).mockImplementationOnce(failure);
		if (stage === "unlink")
			vi.mocked(disk.unlinkSync).mockImplementation((path) => {
				if (path === join(dir, original)) return failure();
				actualDisk.unlinkSync(path);
			});
		let directorySyncs = 0;
		vi.mocked(disk.fsyncSync).mockImplementation((fd) => {
			const details = actualDisk.fstatSync(fd);
			if (stage === "source-fsync" && details.ino === before.ino) return failure();
			if (details.isDirectory()) {
				directorySyncs++;
				if (
					(stage === "directory-fsync" && directorySyncs === 1) ||
					(stage === "final-fsync" && directorySyncs === 2)
				)
					return failure();
			}
			actualDisk.fsyncSync(fd);
		});
		// Act
		expect(() => retain()).toThrow();
		// Assert
		const surviving = (await fs.readdir(dir)).filter(
			(name) => name === original || name === retained,
		);
		expect(surviving.length).toBeGreaterThan(0);
		for (const name of surviving) {
			expect(await fs.readFile(join(dir, name))).toEqual(bytes);
			expect(await fs.stat(join(dir, name))).toMatchObject({
				ino: before.ino,
				mode: before.mode,
				mtimeMs: before.mtimeMs,
			});
		}
	},
);

it.each(["source", "destination", "directory"])(
	"detects a replaced %s before removing the source",
	async (which) => {
		// Arrange: replace the name immediately after the hard link, before directory fsync/rechecks.
		await fixture();
		vi.mocked(disk.linkSync).mockImplementationOnce((source, target) => {
			actualDisk.linkSync(source, target);
			let path = String(source);
			if (which === "destination") path = String(target);
			if (which === "directory") path = dir;
			actualDisk.renameSync(path, `${path}.saved`);
			if (which === "directory") actualDisk.mkdirSync(path, { mode: 0o755 });
			else actualDisk.writeFileSync(path, "replacement", { mode: 0o644 });
		});
		// Act
		expect(() => retain()).toThrow();
		// Assert: the injected replacement and at least one exact original remain.
		if (which === "directory") {
			expect(await fs.readFile(join(`${dir}.saved`, original))).toEqual(bytes);
			expect(await fs.readFile(join(`${dir}.saved`, retained))).toEqual(bytes);
			expect(await fs.readdir(dir)).toEqual([]);
		} else {
			const replaced = which === "source" ? original : retained;
			expect(await fs.readFile(join(dir, replaced), "utf8")).toBe("replacement");
			expect(await fs.readFile(join(dir, `${replaced}.saved`))).toEqual(bytes);
			expect(await fs.readFile(join(dir, which === "source" ? retained : original))).toEqual(bytes);
		}
	},
);

it.each(["release-io", "replaced-owner", "primary-and-release"])(
	"reports lock failure without losing the primary outcome (%s)",
	async (stage) => {
		// Arrange
		await fixture();
		const lockPath = join(dir, `.native-retain-${original}.lock`);
		if (stage === "primary-and-release")
			await fs.writeFile(join(dir, retained), "collision", { mode: 0o600 });
		vi.mocked(disk.unlinkSync).mockImplementation((path) => {
			if (path === lockPath) throw Object.assign(new Error("private-lock-error"), { code: "EIO" });
			actualDisk.unlinkSync(path);
		});
		if (stage === "replaced-owner")
			vi.mocked(disk.linkSync).mockImplementationOnce((source, target) => {
				actualDisk.linkSync(source, target);
				actualDisk.renameSync(lockPath, `${lockPath}.saved`);
				actualDisk.writeFileSync(lockPath, "other owner", { mode: 0o600 });
			});
		// Act
		let error: unknown;
		let result: ReturnType<typeof retain> | undefined;
		try {
			result = retain();
		} catch (caught) {
			error = caught;
		}
		// Assert
		if (stage === "release-io") {
			expect(result).toMatchObject({ outcome: "retained", lock: "release_failed" });
			expect(await fs.readFile(join(dir, retained))).toEqual(bytes);
		} else {
			expect(error).toMatchObject({
				code: stage === "replaced-owner" ? "lock_repair_required" : "retention_conflict",
				lock: "release_failed",
			});
			expect(await fs.readFile(join(dir, original))).toEqual(bytes);
		}
		expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o600);
		if (stage === "replaced-owner") expect(await fs.readFile(lockPath, "utf8")).toBe("other owner");
	},
);

it("refuses a foreign-owned spool without changing permissions", async () => {
	// Arrange: simulate another effective user without requiring privileged chown.
	await fixture();
	const before = await fs.stat(dir);
	vi.spyOn(process, "geteuid").mockReturnValue(before.uid + 1);
	// Act
	expect(() => retain()).toThrow();
	expect(() => listNativeHookRejectedReceipts({ provider: "claude" })).toThrow();
	// Assert
	expect(await fs.stat(dir)).toMatchObject({ uid: before.uid, mode: before.mode });
	expect(await fs.readFile(join(dir, original))).toEqual(bytes);
});

it.each(["write", "fsync", "replaced-lock"])(
	"cleans up only its own newly-created partial lock after %s fails",
	async (stage) => {
		// Arrange: fail acquisition before any payload operation, after exclusive creation.
		const { path, before } = await fixture();
		const lockPath = join(dir, `.native-retain-${original}.lock`);
		const fail = () => {
			throw Object.assign(new Error("private-acquisition-error"), { code: "EIO" });
		};
		if (stage === "write") vi.mocked(disk.writeSync).mockImplementationOnce(fail);
		else
			vi.mocked(disk.fsyncSync).mockImplementationOnce(() => {
				if (stage === "replaced-lock") {
					actualDisk.renameSync(lockPath, `${lockPath}.saved`);
					actualDisk.writeFileSync(lockPath, "replacement owner", { mode: 0o600 });
				}
				fail();
			});
		// Act
		let failure: unknown;
		try {
			retain();
		} catch (error) {
			failure = error;
		}
		// Assert: uncertain ownership requires repair, while an owned partial lock permits retry.
		expect(failure).toMatchObject({
			code: stage === "replaced-lock" ? "lock_repair_required" : "lock_failed",
		});
		expect(await fs.readFile(path)).toEqual(bytes);
		expect(await fs.stat(path)).toMatchObject({
			mode: before.mode,
			ino: before.ino,
			mtimeMs: before.mtimeMs,
		});
		if (stage === "replaced-lock") {
			expect(await fs.readFile(lockPath, "utf8")).toBe("replacement owner");
			expect((await fs.readdir(dir)).sort()).toEqual(
				[
					original,
					`.native-retain-${original}.lock`,
					`.native-retain-${original}.lock.saved`,
				].sort(),
			);
		} else {
			expect(await fs.readdir(dir)).toEqual([original]);
			expect(retain()).toMatchObject({ outcome: "retained", receipt: retained });
			expect(await fs.readFile(join(dir, retained))).toEqual(bytes);
		}
	},
);

it.each(["ctime", "growing", "replacement"])(
	"withholds inspected content after %s changes during read",
	async (change) => {
		// Arrange
		await fs.writeFile(join(dir, retained), bytes, { mode: 0o644 });
		const path = join(dir, retained);
		let changed = false;
		vi.mocked(disk.fstatSync).mockImplementation((...args) => {
			const details = Reflect.apply(actualDisk.fstatSync, actualDisk, args);
			if (change === "ctime" && changed)
				return Object.assign(Object.create(details), { ctimeMs: Number(details.ctimeMs) + 1 });
			return details;
		});
		vi.mocked(disk.readSync).mockImplementation((...args) => {
			const count = Reflect.apply(actualDisk.readSync, actualDisk, args);
			if (!changed) {
				changed = true;
				if (change === "growing") actualDisk.truncateSync(path, 16 * 1024 * 1024 + 1);
				if (change === "replacement") {
					actualDisk.renameSync(path, `${path}.saved`);
					actualDisk.writeFileSync(path, bytes, { mode: 0o644 });
				}
			}
			return count;
		});
		// Act
		const result = inspectNativeHookRejectedReceipt({ provider: "claude", receipt: retained });
		// Assert
		expect(result).toMatchObject({ validation: "changed_during_read" });
		expect(result).not.toHaveProperty("serialized");
		const totalRead = vi
			.mocked(disk.readSync)
			.mock.results.reduce((sum, call) => sum + Number(call.value), 0);
		expect(totalRead).toBeLessThanOrEqual(16 * 1024 * 1024 + 1);
	},
);
