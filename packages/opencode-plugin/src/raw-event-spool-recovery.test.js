import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	truncate,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as spool from "../.opencode/lib/raw-event-spool.js";

const fault = vi.hoisted(() => ({
	target: "",
	directory: "",
	stage: "",
	removed: false,
	calls: [],
	payloadClosed: false,
	releaseStage: "",
	lockRemoved: false,
	primaryError: null,
	releaseCalls: [],
}));
vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual();
	const fail = () => {
		throw Object.assign(new Error("private-payload diagnostic"), { code: "EIO" });
	};
	return {
		...actual,
		link: async (source, destination) => {
			if (destination === fault.target && fault.primaryError) throw fault.primaryError;
			return actual.link(source, destination);
		},
		rm: async (path, ...args) => {
			if (String(path).endsWith(".lock") && fault.releaseStage) {
				fault.releaseCalls.push("unlink");
				if (fault.releaseStage === "unlink") fail();
				await actual.rm(path, ...args);
				fault.lockRemoved = true;
				return;
			}
			if (path === fault.target) {
				if (fault.stage === "unlink") fail();
				await actual.rm(path, ...args);
				fault.removed = true;
				return;
			}
			return actual.rm(path, ...args);
		},
		open: async (...args) => {
			const handle = await actual.open(...args);
			if (args[0] === fault.target) {
				fault.calls.push("payload_open");
				const close = handle.close.bind(handle);
				handle.close = async () => {
					fault.payloadClosed = true;
					return close();
				};
			}
			if (String(args[0]).endsWith(".lock") && ["wx", "wx+"].includes(args[1])) {
				fault.calls.push("exclusive_lock_open");
				const sync = handle.sync.bind(handle);
				handle.sync = async () => {
					fault.calls.push("lock_sync");
					if (fault.stage === "lock_sync") fail();
					return sync();
				};
			}
			if (args[0] === fault.directory) {
				const sync = handle.sync.bind(handle);
				handle.sync = async () => {
					if (fault.lockRemoved && fault.releaseStage) {
						fault.releaseCalls.push("sync");
						if (fault.releaseStage === "sync") fail();
					}
					if (fault.stage === "sync" && fault.removed) fail();
					return sync();
				};
			}
			return handle;
		},
	};
});

const eventId = "recovery-private-event";
const digest = createHash("sha256").update(eventId).digest("hex");
const receipt = `rejected-${digest}-400-invalid_payload.json`;
const otherReceipt = `rejected-${digest}-413-payload_too_large.json`;
const envelope = {
	event_id: eventId,
	session_id: "private-session",
	payload: "private-payload café",
};
const serialized = ` ${JSON.stringify(envelope, null, 2)}\n`;
let home;
let directory;
let target;
const children = [];
const recover = (deliver, options = {}) =>
	spool.recoverRejectedRawEventSpoolEntry({ homeDir: home, receipt, deliver, ...options });
const ack = (acknowledgement = "queued") => ({ acknowledged: true, acknowledgement });
const safe = (result) => {
	expect(JSON.stringify(result)).not.toMatch(
		/private-payload|private-session|recovery-private-event|diagnostic|serialized|event_id|session_id/,
	);
	expect(JSON.stringify(result)).not.toContain(home);
};

// IPC messages, rather than sleeps, establish that the child holds the lock.
function child(mode, selectedReceipt = receipt) {
	const process = fork(
		fileURLToPath(new URL("./raw-event-spool-recovery-child.fixture.mjs", import.meta.url)),
		[home, selectedReceipt, mode, eventId],
		{ stdio: ["ignore", "ignore", "pipe", "ipc"] },
	);
	const messages = [];
	const waiting = new Map();
	process.on("message", (message) => {
		const waiter = waiting.get(message.type);
		if (waiter) {
			waiting.delete(message.type);
			waiter.resolve(message);
		} else messages.push(message);
	});
	const exited = new Promise((resolve) =>
		process.once("exit", (code, signal) => {
			for (const waiter of waiting.values())
				waiter.reject(new Error(`fixture exited: ${code}/${signal}`));
			waiting.clear();
			resolve();
		}),
	);
	const controller = {
		process,
		exited,
		wait(type) {
			const index = messages.findIndex((message) => message.type === type);
			if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
			return new Promise((resolve, reject) => waiting.set(type, { resolve, reject }));
		},
	};
	children.push(controller);
	return controller;
}

async function currentLock() {
	const names = (await readdir(directory)).filter(
		(name) => name.includes(digest) && !name.endsWith(".json"),
	);
	expect(names).toHaveLength(1);
	const path = join(directory, names[0]);
	return { path, bytes: await readFile(path), details: await stat(path) };
}

async function lockTemplate() {
	let lock;
	await recover(async () => {
		lock = await currentLock();
		return false;
	});
	return lock;
}

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "codemem-recovery-test-"));
	directory = spool.resolveSpoolDirectory(home);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	target = join(directory, receipt);
	await writeFile(target, serialized, { mode: 0o600 });
	Object.assign(fault, {
		target,
		directory,
		stage: "",
		removed: false,
		calls: [],
		payloadClosed: false,
		releaseStage: "",
		lockRemoved: false,
		primaryError: null,
		releaseCalls: [],
	});
});
afterEach(async () => {
	vi.restoreAllMocks();
	fault.stage = "";
	fault.releaseStage = "";
	fault.primaryError = null;
	for (const running of children.splice(0)) {
		if (running.process.exitCode === null && running.process.signalCode === null)
			running.process.kill("SIGKILL");
		await running.exited;
	}
	await rm(home, { recursive: true, force: true });
});

test.each(["queued", "ingested"])(
	"removes only the selected receipt after %s acknowledgement",
	async (acknowledgement) => {
		// Arrange: aliases may belong to normal capture or another rejection receipt.
		await link(target, join(directory, `${digest}.json`));
		await link(target, join(directory, otherReceipt));
		const deliver = vi.fn(async () => ack(acknowledgement));
		// Act
		const result = await recover(deliver);
		// Assert
		expect(deliver).toHaveBeenCalledExactlyOnceWith({ serialized });
		expect(result).toEqual({
			delivery: "accepted",
			acknowledgement,
			cleanup: "removed",
			lock: "released",
		});
		safe(result);
		expect((await readdir(directory)).sort()).toEqual([`${digest}.json`, otherReceipt].sort());
		expect(await readFile(join(directory, otherReceipt), "utf8")).toBe(serialized);
		expect(await recover(deliver, { receipt: otherReceipt })).toEqual(result);
		expect(await readdir(directory)).toEqual([`${digest}.json`]);
		expect(await readFile(join(directory, `${digest}.json`), "utf8")).toBe(serialized);
	},
);

test.each(["queued", "ingested"])(
	"keeps a %s receipt and its active alias on request",
	async (acknowledgement) => {
		// Arrange: the active alias shares the receipt inode.
		const active = join(directory, `${digest}.json`);
		await link(target, active);
		const before = await stat(target);
		const deliver = vi.fn(async () => ack(acknowledgement));
		// Act
		const result = await recover(deliver, { keepReceipt: true });
		// Assert
		expect(result).toEqual({
			delivery: "accepted",
			acknowledgement,
			cleanup: "kept",
			lock: "released",
		});
		expect(deliver).toHaveBeenCalledExactlyOnceWith({ serialized });
		expect(await stat(target)).toMatchObject({ ino: before.ino, mode: before.mode });
		expect(await stat(active)).toMatchObject({ ino: before.ino, mode: before.mode });
		expect(await readFile(target, "utf8")).toBe(serialized);
		expect(await readFile(active, "utf8")).toBe(serialized);
		expect((await readdir(directory)).sort()).toEqual([receipt, `${digest}.json`].sort());
		safe(result);
	},
);

test("keepReceipt cannot turn a non-ACK into accepted delivery", async () => {
	// Arrange
	const deliver = vi.fn(async () => ({ acknowledged: true, acknowledgement: "unknown" }));
	// Act
	const result = await recover(deliver, { keepReceipt: true });
	// Assert
	expect(result).toMatchObject({
		delivery: "unacknowledged",
		cleanup: "not_attempted",
		lock: "released",
	});
	expect(await readFile(target, "utf8")).toBe(serialized);
	expect(await readdir(directory)).toEqual([receipt]);
	safe(result);
});

test.each(["snapshot", "lock"])(
	"keepReceipt still rejects a changed %s after ACK",
	async (change) => {
		// Arrange: inject changes after the initial validation, while delivery owns the lock.
		const deliver = vi.fn(async () => {
			if (change === "snapshot") await chmod(target, 0o640);
			else {
				const lock = await currentLock();
				await rename(lock.path, `${lock.path}.original`);
				await writeFile(lock.path, lock.bytes, { mode: 0o600 });
			}
			return ack();
		});
		// Act
		const result = await recover(deliver, { keepReceipt: true });
		// Assert
		expect(result).toEqual({
			delivery: "accepted",
			acknowledgement: "queued",
			cleanup: change === "snapshot" ? "changed" : "failed",
			lock: change === "snapshot" ? "released" : "release_failed",
		});
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(await readFile(target, "utf8")).toBe(serialized);
		safe(result);
	},
);

test.each([
	false,
	undefined,
	null,
	true,
	{},
	{ acknowledged: true },
	{ acknowledged: true, acknowledgement: "unknown" },
	{ acknowledged: false },
	{ acknowledged: false, acknowledgement: "queued" },
	{ acknowledged: true, acknowledgement: "queued", extra: "private-payload" },
	[{ acknowledged: true, acknowledgement: "queued" }],
])("keeps bytes for a non-accepting acknowledgement: %j", async (answer) => {
	// Arrange
	const deliver = vi.fn(async () => answer);
	// Act
	const result = await recover(deliver);
	// Assert
	expect(deliver).toHaveBeenCalledExactlyOnceWith({ serialized });
	expect(result).toMatchObject({
		delivery: "unacknowledged",
		cleanup: "not_attempted",
		lock: "released",
	});
	safe(result);
	expect(await readFile(target, "utf8")).toBe(serialized);
	expect(await readdir(directory)).toEqual([receipt]);
});

test("delivery exceptions return a fixed safe result and leave the payload", async () => {
	// Arrange
	const deliver = vi.fn(async () => {
		throw new Error(`private-payload diagnostic ${target}`);
	});
	// Act
	const result = await recover(deliver);
	// Assert
	expect(result).toEqual({
		delivery: "unacknowledged",
		cleanup: "not_attempted",
		reason: "delivery_failed",
		lock: "released",
	});
	safe(result);
	expect(await readFile(target, "utf8")).toBe(serialized);
});

test.each(["edit", "same-bytes-replace", "different-bytes-replace", "chmod", "symlink"])(
	"keeps a receipt changed by %s during delivery",
	async (change) => {
		// Arrange
		const changed = serialized.replace("private-payload", "changed-payload");
		const deliver = async () => {
			if (change === "edit") await writeFile(target, changed);
			else if (change === "chmod") await chmod(target, 0o640);
			else {
				await rename(target, `${target}.original`);
				if (change === "symlink") await symlink(`${target}.original`, target);
				else
					await writeFile(target, change === "same-bytes-replace" ? serialized : changed, {
						mode: 0o600,
					});
			}
			return ack();
		};
		// Act
		const result = await recover(deliver);
		// Assert
		expect(result).toEqual({
			delivery: "accepted",
			acknowledgement: "queued",
			cleanup: "changed",
			lock: "released",
		});
		safe(result);
		expect(await readFile(target, "utf8")).toBe(
			change === "edit" || change === "different-bytes-replace" ? changed : serialized,
		);
	},
);

test.each([
	["unlink", "failed"],
	["sync", "uncertain"],
])("reports %s cleanup failure without retrying delivery", async (stage, outcome) => {
	// Arrange
	fault.stage = stage;
	const deliver = vi.fn(async () => ack());
	// Act
	const result = await recover(deliver);
	// Assert
	expect(result).toMatchObject({
		delivery: "accepted",
		acknowledgement: "queued",
		cleanup: outcome,
	});
	expect(deliver).toHaveBeenCalledTimes(1);
	safe(result);
	if (stage === "unlink") expect(await readFile(target, "utf8")).toBe(serialized);
	else await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["../escape.json", receipt.replace("400-invalid_payload", "400-payload_too_large")])(
	"rejects an invalid receipt before delivery: %s",
	async (invalidReceipt) => {
		// Arrange
		const deliver = vi.fn();
		// Act / Assert
		expect(await recover(deliver, { receipt: invalidReceipt })).toEqual({
			delivery: "not_attempted",
			cleanup: "not_attempted",
			reason: "invalid_receipt",
			lock: "not_acquired",
		});
		expect(deliver).not.toHaveBeenCalled();
		expect(await readFile(target, "utf8")).toBe(serialized);
	},
);

test.each(["JSON", "UTF-8", "identity", "symlink", "oversized"])(
	"does not deliver invalid retained %s",
	async (kind) => {
		// Arrange
		if (kind === "JSON") await writeFile(target, "{private-payload");
		if (kind === "UTF-8") await writeFile(target, Buffer.from([0xff]));
		if (kind === "identity") await writeFile(target, JSON.stringify({ event_id: "another-event" }));
		if (kind === "oversized")
			await truncate(target, spool.MAX_REJECTED_RAW_EVENT_INSPECTION_BYTES + 1);
		if (kind === "symlink") {
			await rename(target, `${target}.original`);
			await symlink(`${target}.original`, target);
		}
		const deliver = vi.fn();
		// Act
		const result = await recover(deliver);
		// Assert
		expect(deliver).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			delivery: "not_attempted",
			cleanup: "not_attempted",
			lock: "released",
		});
		safe(result);
		expect(await readdir(directory)).toContain(receipt);
	},
);

test("a lock is durable and private before delivery, then removed after a normal release", async () => {
	// Arrange
	let observed;
	// Act
	await recover(async () => {
		expect(fault.payloadClosed).toBe(false);
		observed = await currentLock();
		return false;
	});
	// Assert
	expect(observed.details.mode & 0o777).toBe(0o600);
	const record = JSON.parse(observed.bytes);
	expect(record).toMatchObject({ version: 1, digest, pid: process.pid });
	expect(record.purpose).toEqual(expect.any(String));
	expect(record.token).toMatch(/^[0-9a-f-]{36}$/i);
	expect(fault.calls.slice(0, 3)).toEqual(["exclusive_lock_open", "lock_sync", "payload_open"]);
	expect(fault.payloadClosed).toBe(true);
	expect(await readdir(directory)).toEqual([receipt]);
});

test("a lock sync failure prevents payload reads and leaves its record for repair", async () => {
	// Arrange
	fault.stage = "lock_sync";
	const deliver = vi.fn();
	// Act
	const result = await recover(deliver);
	// Assert
	expect(result).toMatchObject({
		delivery: "not_attempted",
		reason: "lock_repair_required",
		lock: "not_acquired",
	});
	expect(fault.calls).toEqual(["exclusive_lock_open", "lock_sync"]);
	expect(deliver).not.toHaveBeenCalled();
	expect((await currentLock()).bytes.length).toBeGreaterThan(0);
	expect(await readFile(target, "utf8")).toBe(serialized);
});

test("a child holding retain excludes recovery until it releases the shared lock", async () => {
	// Arrange
	await link(target, join(directory, `${digest}.json`));
	const owner = child("retain-hold");
	await owner.wait("retain-locked");
	// Act
	const competing = child("recover");
	const result = await competing.wait("result");
	// Assert
	expect(result.result).toMatchObject({ delivery: "not_attempted", reason: "lock_busy" });
	expect(await readFile(target, "utf8")).toBe(serialized);
	owner.process.send("release");
	expect((await owner.wait("result")).result.receipt).toBe(receipt);
	expect(await recover(async () => ack())).toMatchObject({
		delivery: "accepted",
		cleanup: "removed",
	});
});

test.each(["same-receipt", "other-receipt", "retain"])(
	"a child holding recovery excludes %s mutation across processes",
	async (contender) => {
		// Arrange
		await link(target, join(directory, otherReceipt));
		await writeFile(join(directory, `${digest}.json`), serialized, { mode: 0o600 });
		const owner = child("hold");
		await owner.wait("before-delivery");
		const lock = await currentLock();
		// Act
		const competing = child(
			contender === "retain" ? "retain" : "recover",
			contender === "other-receipt" ? otherReceipt : receipt,
		);
		const result = await competing.wait("result");
		// Assert
		expect(result.result?.reason ?? result.error?.code).toBe("lock_busy");
		expect(await readFile(lock.path)).toEqual(lock.bytes);
		expect(await readFile(target, "utf8")).toBe(serialized);
		owner.process.send("release");
		expect((await owner.wait("result")).result).toMatchObject({
			delivery: "accepted",
			cleanup: "removed",
		});
	},
);

test.each(["before-delivery", "before-unlink"])(
	"a child crash at %s leaves bytes and a repair-required lock",
	async (point) => {
		// Arrange
		const owner = child(point === "before-delivery" ? "hold" : "after-ack");
		await owner.wait(point);
		const lock = await currentLock();
		// Act: kill only the child created by this test, after its explicit barrier.
		owner.process.kill("SIGKILL");
		await owner.exited;
		const deliver = vi.fn();
		const result = await recover(deliver);
		// Assert
		expect(result).toMatchObject({
			delivery: "not_attempted",
			reason: "lock_repair_required",
			lock: "not_acquired",
		});
		expect(deliver).not.toHaveBeenCalled();
		expect(await readFile(target, "utf8")).toBe(serialized);
		expect(await readFile(lock.path)).toEqual(lock.bytes);
	},
);

test("a live PID stays busy even when its lock timestamp is old", async () => {
	// Arrange
	const lock = await lockTemplate();
	await writeFile(lock.path, lock.bytes, { mode: 0o600 });
	await utimes(lock.path, new Date(0), new Date(0));
	const deliver = vi.fn();
	// Act
	const result = await recover(deliver);
	// Assert
	expect(result).toMatchObject({
		delivery: "not_attempted",
		reason: "lock_busy",
		lock: "not_acquired",
	});
	expect(deliver).not.toHaveBeenCalled();
	expect(await readFile(lock.path)).toEqual(lock.bytes);
	expect(await readFile(target, "utf8")).toBe(serialized);
});

test("normal capture replay and active acknowledgements keep working with a live recovery lock", async () => {
	// Arrange
	const lock = await lockTemplate();
	await writeFile(lock.path, lock.bytes, { mode: 0o600 });
	const active = join(directory, `${digest}.json`);
	await writeFile(active, serialized, { mode: 0o600 });
	// Act
	const replay = await spool.writeRawEventSpoolEntry({ homeDir: home, envelope, serialized });
	await spool.removeRawEventSpoolEntry({ homeDir: home, eventId });
	// Assert
	expect(replay.serialized).toBe(serialized);
	await expect(stat(active)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readFile(target, "utf8")).toBe(serialized);
	expect(await readFile(lock.path)).toEqual(lock.bytes);
});

test("an uncertain PID check stays busy without reclaiming the lock", async () => {
	// Arrange
	const lock = await lockTemplate();
	const owner = child("pid-holder");
	await owner.wait("ready");
	const record = { ...JSON.parse(lock.bytes), pid: owner.process.pid };
	const bytes = JSON.stringify(record);
	await writeFile(lock.path, bytes, { mode: 0o600 });
	const kill = process.kill.bind(process);
	const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
		if (pid === owner.process.pid && signal === 0)
			throw Object.assign(new Error("private diagnostic"), { code: "EPERM" });
		return kill(pid, signal);
	});
	const deliver = vi.fn();
	// Act
	const result = await recover(deliver);
	// Assert
	expect(probe).toHaveBeenCalledWith(owner.process.pid, 0);
	expect(result).toMatchObject({
		delivery: "not_attempted",
		reason: "lock_busy",
		lock: "not_acquired",
	});
	expect(deliver).not.toHaveBeenCalled();
	expect(await readFile(lock.path, "utf8")).toBe(bytes);
	expect(await readFile(target, "utf8")).toBe(serialized);
	safe(result);
});

test.each([
	"empty",
	"partial",
	"malformed",
	"oversized",
	"symlink",
	"wrong-purpose",
	"wrong-version",
	"wrong-digest",
	"wrong-pid",
	"wrong-token",
])("requires repair for a %s lock without touching payload bytes", async (kind) => {
	// Arrange
	const lock = await lockTemplate();
	let bytes = Buffer.from("{not-a-lock");
	if (kind === "empty") bytes = Buffer.alloc(0);
	if (kind === "partial") bytes = lock.bytes.subarray(0, 20);
	if (kind === "oversized") bytes = Buffer.alloc(1024 * 1024, 0x20);
	const invalidField = {
		"wrong-purpose": ["purpose", "other"],
		"wrong-version": ["version", 2],
		"wrong-digest": ["digest", "0".repeat(64)],
		"wrong-pid": ["pid", -1],
		"wrong-token": ["token", "invalid"],
	}[kind];
	if (invalidField)
		bytes = Buffer.from(
			JSON.stringify({ ...JSON.parse(lock.bytes), [invalidField[0]]: invalidField[1] }),
		);
	if (kind === "symlink") {
		const outside = join(home, "lock-link-target");
		await writeFile(outside, lock.bytes, { mode: 0o600 });
		await symlink(outside, lock.path);
	} else await writeFile(lock.path, bytes, { mode: 0o600 });
	const deliver = vi.fn();
	// Act
	const result = await recover(deliver);
	// Assert
	expect(result).toMatchObject({
		delivery: "not_attempted",
		reason: "lock_repair_required",
		lock: "not_acquired",
	});
	expect(deliver).not.toHaveBeenCalled();
	expect(await readFile(lock.path)).toEqual(kind === "symlink" ? lock.bytes : bytes);
	expect(await readFile(target, "utf8")).toBe(serialized);
	safe(result);
});

test.each(["same-bytes-new-inode", "changed-record", "changed-token"])(
	"lock release preserves a %s replacement",
	async (change) => {
		// Arrange
		let lock;
		let replacement;
		const deliver = async () => {
			lock = await currentLock();
			replacement = lock.bytes;
			if (change === "same-bytes-new-inode") {
				await rename(lock.path, `${lock.path}.original`);
				await writeFile(lock.path, replacement, { mode: 0o600 });
			} else {
				if (change === "changed-token")
					replacement = Buffer.from(
						JSON.stringify({
							...JSON.parse(lock.bytes),
							token: "00000000-0000-4000-8000-000000000000",
						}),
					);
				else replacement = Buffer.concat([lock.bytes, Buffer.from(" ")]);
				await writeFile(lock.path, replacement);
			}
			return ack();
		};
		// Act
		const result = await recover(deliver);
		// Assert
		expect(result).toEqual({
			delivery: "accepted",
			acknowledgement: "queued",
			cleanup: "failed",
			lock: "release_failed",
		});
		safe(result);
		expect(await readFile(lock.path)).toEqual(replacement);
		expect(await readFile(target, "utf8")).toBe(serialized);
	},
);

const retain = () =>
	spool.retainRejectedRawEventSpoolEntry({
		homeDir: home,
		eventId,
		status: 400,
		reason: "invalid_payload",
	});

test("successful retention preserves the existing metadata shape when its lock releases", async () => {
	// Arrange
	const active = join(directory, `${digest}.json`);
	await writeFile(active, serialized, { mode: 0o600 });
	// Act
	const result = await retain();
	// Assert
	expect(result).toEqual({
		receipt,
		bytes: Buffer.byteLength(serialized),
		status: 400,
		reason: "invalid_payload",
	});
	safe(result);
	expect(await readdir(directory)).toEqual([receipt]);
	expect(await readFile(target, "utf8")).toBe(serialized);
	await expect(stat(active)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["unlink", "sync"])(
	"durable retention returns metadata plus a warning when lock release %s fails",
	async (stage) => {
		// Arrange: publish a new receipt rather than reusing the retained fixture.
		await rm(target);
		const active = join(directory, `${digest}.json`);
		await writeFile(active, serialized, { mode: 0o600 });
		fault.releaseStage = stage;
		// Act
		const result = await retain();
		// Assert: cleanup failure cannot turn a completed durable retention into a failure.
		expect(result).toEqual({
			receipt,
			bytes: Buffer.byteLength(serialized),
			status: 400,
			reason: "invalid_payload",
			lock: "release_failed",
		});
		safe(result);
		expect(fault.releaseCalls).toEqual(stage === "unlink" ? ["unlink"] : ["unlink", "sync"]);
		expect(await readFile(target, "utf8")).toBe(serialized);
		await expect(stat(active)).rejects.toMatchObject({ code: "ENOENT" });
		const names = await readdir(directory);
		expect(names).toContain(receipt);
		expect(names.filter((name) => name.endsWith(".lock"))).toHaveLength(stage === "unlink" ? 1 : 0);
	},
);

test.each(["unlink", "sync"])(
	"a retention conflict remains the primary error when lock release %s fails",
	async (stage) => {
		// Arrange: the retained receipt and active event have genuinely different payloads.
		const active = join(directory, `${digest}.json`);
		const conflicting = serialized.replace("private-payload", "different-payload");
		await writeFile(active, conflicting, { mode: 0o600 });
		fault.releaseStage = stage;
		// Act
		const error = await retain().catch((caught) => caught);
		// Assert
		expect(error).toMatchObject({
			code: "raw_event_spool_conflict",
			message: "raw event spool entry conflicts with existing event_id",
		});
		expect(error.code).not.toBe("lock_release_failed");
		expect(fault.releaseCalls).toEqual(stage === "unlink" ? ["unlink"] : ["unlink", "sync"]);
		expect(await readFile(active, "utf8")).toBe(conflicting);
		expect(await readFile(target, "utf8")).toBe(serialized);
	},
);

test.each(["mutable", "frozen"])(
	"preserves the identical %s primary exception when retention and lock release both fail",
	async (kind) => {
		// Arrange: inject at the publication boundary, after the shared lock was acquired.
		const active = join(directory, `${digest}.json`);
		await writeFile(active, serialized, { mode: 0o600 });
		const primary = Object.assign(new Error("private-payload publication diagnostic"), {
			code: "EIO",
			spoolStage: "publish",
		});
		if (kind === "frozen") Object.freeze(primary);
		fault.primaryError = primary;
		fault.releaseStage = "unlink";
		// Act
		const error = await retain().catch((caught) => caught);
		// Assert: secondary cleanup cannot replace the original exception or its diagnostic fields.
		expect(error).toBe(primary);
		expect(error).toMatchObject({
			code: "EIO",
			spoolStage: "publish",
			message: "private-payload publication diagnostic",
		});
		expect(fault.releaseCalls).toEqual(["unlink"]);
		expect(await readFile(active, "utf8")).toBe(serialized);
		expect(await readFile(target, "utf8")).toBe(serialized);
	},
);
