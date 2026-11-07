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
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as spool from "../.opencode/lib/raw-event-spool.js";

// Keep real files and handles. Inject failures only during the transition under test.
const fault = vi.hoisted(() => ({ stage: null, directory: null, active: null, calls: [] }));
vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual();
	const fail = () => {
		throw Object.assign(new Error("synthetic private diagnostic"), { code: "EIO" });
	};
	return {
		...actual,
		link: async (source, destination) => {
			if (fault.stage && destination.includes("rejected-")) {
				fault.calls.push("link");
				if (fault.stage === "link") fail();
			}
			return actual.link(source, destination);
		},
		open: async (...args) => {
			const handle = await actual.open(...args);
			if (args[0] === fault.directory && fault.stage) {
				const sync = handle.sync.bind(handle);
				handle.sync = async () => {
					fault.calls.push("directory_sync");
					const count = fault.calls.filter((call) => call === "directory_sync").length;
					if (fault.stage === `sync_${count}`) fail();
					return sync();
				};
			}
			return handle;
		},
		rm: async (path, ...args) => {
			if (fault.stage && path === fault.active) {
				fault.calls.push("remove_active");
				if (fault.stage === "remove") fail();
			}
			return actual.rm(path, ...args);
		},
	};
});

let home;
let directory;
const event = (id = "private-event") => ({
	event_id: id,
	event_type: "user_prompt",
	session_id: "private-session",
	ts_wall_ms: 1,
	ts_mono_ms: 0.1,
	payload: { prompt_text: "private payload: café" },
});
const digest = (id) => createHash("sha256").update(id).digest("hex");
const activePath = (id = "private-event") => join(directory, `${digest(id)}.json`);
const receipt = (id = "private-event", status = 400, reason = "invalid_payload") =>
	`rejected-${digest(id)}-${status}-${reason}.json`;
const retain = (options = {}) =>
	spool.retainRejectedRawEventSpoolEntry({
		homeDir: home,
		eventId: "private-event",
		status: 400,
		reason: "invalid_payload",
		...options,
	});
const list = () => spool.listRejectedRawEventSpoolEntries({ homeDir: home });
const write = (envelope = event(), options = {}) =>
	spool.writeRawEventSpoolEntry({
		homeDir: home,
		envelope,
		...options,
	});

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "codemem-rejected-test-"));
	directory = spool.resolveSpoolDirectory(home);
	fault.stage = null;
	fault.calls = [];
	fault.directory = directory;
	fault.active = activePath();
});
afterEach(async () => {
	fault.stage = null;
	await rm(home, { recursive: true, force: true });
});

test.each([
	[400, "invalid_payload"],
	[413, "payload_too_large"],
])(
	"retains exact bytes privately for %s / %s and exposes only safe metadata",
	async (status, reason) => {
		// Arrange: whitespace and multibyte text must survive without JSON reserialization.
		const serialized = ` ${JSON.stringify(event(), null, 2)}\n`;
		await write(event(), { serialized });
		await chmod(directory, 0o755);
		await chmod(activePath(), 0o644);
		// Act
		await retain({ status, reason });
		const entries = await list();
		// Assert
		expect(entries).toEqual([
			{
				receipt: receipt("private-event", status, reason),
				bytes: Buffer.byteLength(serialized),
				status,
				reason,
			},
		]);
		const retained = join(directory, entries[0].receipt);
		expect(await readFile(retained, "utf8")).toBe(serialized);
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect((await stat(retained)).mode & 0o777).toBe(0o600);
		await expect(stat(activePath())).rejects.toMatchObject({ code: "ENOENT" });
		expect(await spool.loadRawEventSpoolEntries({ homeDir: home })).toEqual({
			entries: [],
			corruptCount: 0,
		});
	},
);

test.each([
	[400, "payload_too_large"],
	[413, "invalid_payload"],
	[401, "invalid_payload"],
	[500, "invalid_payload"],
	["400", "invalid_payload"],
	[400, "private diagnostic"],
	[400, "../invalid_payload"],
])("rejects unsupported status/reason %s / %s without changing bytes", async (status, reason) => {
	// Arrange
	const { serialized } = await write();
	// Act / Assert
	await expect(retain({ status, reason })).rejects.toThrow();
	expect(await readFile(activePath(), "utf8")).toBe(serialized);
	expect(await list()).toEqual([]);
});

test("requires an existing active entry instead of creating retained data", async () => {
	// Arrange: a new synthetic home has no active bytes.
	// Act / Assert
	await expect(retain()).rejects.toThrow();
	expect(await list()).toEqual([]);
});

test("repeated retention and delivery-time replay preserve the first bytes without reactivation", async () => {
	// Arrange
	const { serialized } = await write();
	await retain();
	// Act
	await retain();
	const replay = await write({ ...event(), ts_wall_ms: 99, ts_mono_ms: 9.9 });
	// Assert
	expect(replay.serialized).toBe(serialized);
	expect(await readdir(directory)).toEqual([receipt()]);
	expect(await readFile(join(directory, receipt()), "utf8")).toBe(serialized);
	expect(await spool.loadRawEventSpoolEntries({ homeDir: home })).toEqual({
		entries: [],
		corruptCount: 0,
	});
});

test("replay rejects different content for a retained event", async () => {
	// Arrange
	const { serialized } = await write();
	await retain();
	// Act / Assert
	await expect(write({ ...event(), payload: { prompt_text: "different" } })).rejects.toMatchObject({
		code: "raw_event_spool_conflict",
	});
	expect(await readFile(join(directory, receipt()), "utf8")).toBe(serialized);
	expect(await readdir(directory)).toEqual([receipt()]);
});

test("finishes a crash state with active and retained hard links idempotently", async () => {
	// Arrange
	const { serialized } = await write();
	await link(activePath(), join(directory, receipt()));
	// Act
	await retain();
	await retain();
	// Assert
	expect(await readdir(directory)).toEqual([receipt()]);
	expect(await readFile(join(directory, receipt()), "utf8")).toBe(serialized);
});

test("does not overwrite a retained collision or remove conflicting active bytes", async () => {
	// Arrange
	const { serialized } = await write();
	const conflicting = JSON.stringify({ ...event(), payload: { prompt_text: "other bytes" } });
	await writeFile(join(directory, receipt()), conflicting, { mode: 0o600 });
	// Act / Assert
	await expect(retain()).rejects.toMatchObject({ code: "raw_event_spool_conflict" });
	expect(await readFile(activePath(), "utf8")).toBe(serialized);
	expect(await readFile(join(directory, receipt()), "utf8")).toBe(conflicting);
});

test("does not accept a delivery-time-equivalent collision as exact-byte retention", async () => {
	// Arrange
	const { serialized } = await write();
	const otherBytes = JSON.stringify({ ...event(), ts_wall_ms: 2 });
	await writeFile(join(directory, receipt()), otherBytes, { mode: 0o600 });
	// Act / Assert
	await expect(retain()).rejects.toMatchObject({ code: "raw_event_spool_conflict" });
	expect(await readFile(activePath(), "utf8")).toBe(serialized);
	expect(await readFile(join(directory, receipt()), "utf8")).toBe(otherBytes);
});

test("retained entries do not consume drain slots or count as corrupt", async () => {
	// Arrange
	await write();
	await retain();
	for (let index = 0; index < 21; index += 1) await write(event(`active-${index}`));
	// Act
	const drained = await spool.loadRawEventSpoolEntries({ homeDir: home });
	// Assert
	expect(drained.entries).toHaveLength(20);
	expect(drained.entries.every((entry) => entry.eventId.startsWith("active-"))).toBe(true);
	expect(drained.corruptCount).toBe(0);
	expect(await list()).toHaveLength(1);
});

test("all regular JSON files count toward capacity, but duplicates are checked first", async () => {
	// Arrange
	const { serialized } = await write();
	await retain();
	await write(event("active"));
	await writeFile(join(directory, "unrecognized.json"), "{}", { mode: 0o600 });
	// Act
	const replay = await write({ ...event(), ts_wall_ms: 3 }, { maxEntries: 3 });
	const activeReplay = await write(event("active"), { maxEntries: 3 });
	// Assert
	expect(replay.serialized).toBe(serialized);
	expect(activeReplay.eventId).toBe("active");
	await expect(write(event("new"), { maxEntries: 3 })).rejects.toMatchObject({
		code: "raw_event_spool_full",
	});
	await expect(
		write({ ...event(), event_type: "changed" }, { maxEntries: 3 }),
	).rejects.toMatchObject({ code: "raw_event_spool_conflict" });
	expect(await readdir(directory)).toHaveLength(3);
});

test("the default 2000-file capacity includes retained entries", async () => {
	// Arrange: quota counts regular JSON files even when their contents are corrupt.
	await write();
	await retain();
	await Promise.all(
		Array.from({ length: 1999 }, (_, index) =>
			writeFile(join(directory, `quota-${index}.json`), "{}"),
		),
	);
	// Act / Assert
	await expect(write(event("over-default-quota"))).rejects.toMatchObject({
		code: "raw_event_spool_full",
	});
	expect((await write()).eventId).toBe("private-event");
	expect(await readdir(directory)).toHaveLength(2000);
});

test("lists only strict receipts with matching identities and no payload fields", async () => {
	// Arrange
	await write();
	await retain();
	const malformed = [
		`rejected-${digest("private-event")}-400-payload_too_large.json`,
		`rejected-${digest("private-event")}-500-invalid_payload.json`,
		`rejected-${digest("private-event").toUpperCase()}-400-invalid_payload.json`,
		`rejected-${digest("private-event")}-400-invalid_payload-extra.json`,
		receipt("wrong-identity"),
	];
	await Promise.all(
		malformed.map((name) => writeFile(join(directory, name), JSON.stringify(event()))),
	);
	await writeFile(join(directory, receipt("corrupt")), "private arbitrary error text");
	// Act
	const entries = await list();
	// Assert
	expect(entries).toHaveLength(1);
	expect(Object.keys(entries[0]).sort()).toEqual(["bytes", "reason", "receipt", "status"]);
	expect(JSON.stringify(entries)).not.toMatch(
		/private-event|private-session|private payload|arbitrary error|event_id|session_id|"payload"|"path"/,
	);
});

test.each(["active", "retained"])(
	"rejects a %s symlink without changing its target",
	async (kind) => {
		// Arrange
		const { serialized } = await write();
		const outside = join(home, "unrelated.json");
		await writeFile(outside, serialized, { mode: 0o600 });
		const destination = kind === "active" ? activePath() : join(directory, receipt());
		if (kind === "active") await rm(destination);
		await symlink(outside, destination);
		// Act / Assert
		await expect(retain()).rejects.toThrow();
		expect(await readFile(outside, "utf8")).toBe(serialized);
		expect(await list()).toEqual([]);
	},
);

test.each([".codemem", "opencode-raw-event-spool"])(
	"normal capture, duplicate replay, and loading support a symlinked %s directory",
	async (name) => {
		// Arrange: both the link and its target belong to this synthetic home.
		const target = join(home, "linked-directory-target");
		await mkdir(target, { mode: 0o700 });
		const linked = name === ".codemem" ? dirname(directory) : directory;
		if (name !== ".codemem") await mkdir(dirname(directory), { mode: 0o700 });
		await symlink(target, linked);
		const serialized = ` ${JSON.stringify(event(), null, 2)}\n`;
		// Act
		const original = await write(event(), { serialized });
		const duplicate = await write({ ...event(), ts_wall_ms: 22, ts_mono_ms: 2.2 });
		const loaded = await spool.loadRawEventSpoolEntries({ homeDir: home });
		// Assert: keep the existing capture behavior without reserializing duplicates.
		expect(original.serialized).toBe(serialized);
		expect(duplicate.serialized).toBe(serialized);
		expect(loaded).toEqual({
			entries: [{ eventId: "private-event", envelope: event(), serialized }],
			corruptCount: 0,
		});
		await expect(
			write({ ...event(), payload: { prompt_text: "different" } }),
		).rejects.toMatchObject({
			code: "raw_event_spool_conflict",
			spoolStage: "existing_entry",
		});
		expect(await readFile(activePath(), "utf8")).toBe(serialized);
	},
);

test.each([".codemem", "opencode-raw-event-spool"])(
	"retention and inspection reject a symlinked %s directory",
	async (name) => {
		// Arrange
		const { serialized } = await write();
		const linked = name === ".codemem" ? dirname(directory) : directory;
		const target = join(home, "moved-directory");
		await rename(linked, target);
		await symlink(target, linked);
		// Act / Assert: the stricter new APIs must leave normal capture bytes alone.
		await expect(retain()).rejects.toThrow("requires a real directory");
		await expect(list()).rejects.toThrow("requires a real directory");
		expect(await readFile(activePath(), "utf8")).toBe(serialized);
		expect(await readdir(directory)).toEqual([`${digest("private-event")}.json`]);
	},
);

test.each(["invalid UTF-8", "invalid JSON", "symlink"])(
	"reports existing_entry when replay encounters retained %s",
	async (kind) => {
		// Arrange
		const { serialized } = await write();
		await retain();
		const retainedPath = join(directory, receipt());
		const invalid = kind === "invalid UTF-8" ? Buffer.from([0xff]) : Buffer.from("{invalid JSON");
		if (kind === "symlink") {
			const target = join(home, "retained-link-target.json");
			await writeFile(target, serialized, { mode: 0o600 });
			await rm(retainedPath);
			await symlink(target, retainedPath);
		} else {
			await writeFile(retainedPath, invalid);
		}
		// Act / Assert
		await expect(write()).rejects.toMatchObject({ spoolStage: "existing_entry" });
		expect(await list()).toEqual([]);
		await expect(stat(activePath())).rejects.toMatchObject({ code: "ENOENT" });
		if (kind === "symlink") {
			expect(await readFile(retainedPath, "utf8")).toBe(serialized);
		} else {
			expect(await readFile(retainedPath)).toEqual(invalid);
		}
	},
);

test.each(["link", "sync_1", "remove", "sync_2"])(
	"preserves at least one exact copy when %s fails, then recovers",
	async (stage) => {
		// Arrange
		const { serialized } = await write();
		fault.stage = stage;
		// Act
		await expect(retain()).rejects.toThrow("synthetic private diagnostic");
		fault.stage = null;
		const names = await readdir(directory);
		// Assert: the first directory sync must complete before active deletion.
		const copies = await Promise.all(names.map((name) => readFile(join(directory, name), "utf8")));
		expect(copies.length).toBeGreaterThan(0);
		expect(copies.every((bytes) => bytes === serialized)).toBe(true);
		if (stage !== "sync_2") expect(names).toContain(`${digest("private-event")}.json`);
		if (stage === "remove" || stage === "sync_2") {
			expect(fault.calls.slice(0, 3)).toEqual(["link", "directory_sync", "remove_active"]);
		}
		await retain();
		expect(await readdir(directory)).toEqual([receipt()]);
		expect(await readFile(join(directory, receipt()), "utf8")).toBe(serialized);
	},
);
