import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as spool from "../.opencode/lib/raw-event-spool.js";

const io = vi.hoisted(() => ({
	reads: 0,
	opens: 0,
	flags: 0,
	bytes: 0,
	grow: false,
	fail: false,
	target: "",
	noFollow: "native",
	replace: false,
	changed: null,
}));
vi.mock("node:fs", async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		constants: new Proxy(
			{ ...actual.constants },
			{
				get(target, key) {
					if (key === "O_NOFOLLOW" && io.noFollow !== "native") return io.noFollow;
					return target[key];
				},
			},
		),
	};
});
vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual();
	return {
		...actual,
		readFile: async (...args) => {
			io.reads += 1;
			return actual.readFile(...args);
		},
		readdir: async (...args) => {
			if (io.fail) throw new Error(`private diagnostic ${io.target} private-payload`);
			return actual.readdir(...args);
		},
		open: async (...args) => {
			io.opens += 1;
			io.flags = args[1];
			if (io.fail) throw new Error(`private diagnostic ${io.target} private-payload`);
			if (io.replace && args[0] === io.target) {
				await actual.rename(io.target, `${io.target}.original`);
				await actual.writeFile(io.target, serialized, { mode: 0o600 });
			}
			const handle = await actual.open(...args);
			const read = handle.read.bind(handle);
			const readAll = handle.readFile.bind(handle);
			const details = await handle.stat();
			if (io.changed) {
				handle.stat = async () => {
					if (!io.reads) return details;
					return Object.assign(Object.create(details), { [io.changed]: details[io.changed] + 1 });
				};
			}
			// Simulate growth after fstat. Both stat calls report the original size,
			// so only a limit enforced while reading can stop this content.
			if (io.grow && args[0] === io.target) {
				await actual.appendFile(io.target, " ".repeat(1024));
				handle.stat = async () => details;
			}
			handle.read = async (...readArgs) => {
				io.reads += 1;
				const result = await read(...readArgs);
				io.bytes += result.bytesRead;
				return result;
			};
			handle.readFile = async (...readArgs) => {
				io.reads += 1;
				return readAll(...readArgs);
			};
			return handle;
		},
	};
});

const eventId = "inspection-fixture-event";
const receipt = `rejected-${createHash("sha256").update(eventId).digest("hex")}-400-invalid_payload.json`;
const serialized = ` ${JSON.stringify({ event_id: eventId, payload: "private-payload café" })}\n`;
let home;
let directory;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "codemem-inspection-io-"));
	directory = spool.resolveSpoolDirectory(home);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	Object.assign(io, {
		reads: 0,
		opens: 0,
		bytes: 0,
		grow: false,
		fail: false,
		target: join(directory, receipt),
		noFollow: "native",
		replace: false,
		changed: null,
	});
});
afterEach(async () => {
	io.fail = false;
	io.grow = false;
	await rm(home, { recursive: true, force: true });
});

test.each([serialized, "{private-payload malformed JSON", Buffer.from([0xff])])(
	"metadata listing never opens or reads payloads (%s)",
	async (bytes) => {
		// Arrange
		await writeFile(io.target, bytes, { mode: 0o600 });
		// Act
		const entries = await spool.listRejectedRawEventSpoolEntries({
			homeDir: home,
			validation: "metadata",
		});
		// Assert
		expect(entries).toEqual([
			{
				receipt,
				bytes: Buffer.byteLength(bytes),
				status: 400,
				reason: "invalid_payload",
				validation: "not_checked",
			},
		]);
		expect(io.opens).toBe(0);
		expect(io.reads).toBe(0);
	},
);

test("inspection returns original UTF-8 bytes at the exact read limit", async () => {
	// Arrange
	await writeFile(io.target, serialized, { mode: 0o600 });
	const maxBytes = Buffer.byteLength(serialized);
	// Act
	const result = await spool.inspectRejectedRawEventSpoolEntry({
		receipt,
		homeDir: home,
		maxBytes,
	});
	// Assert
	expect(result).toMatchObject({ receipt, validation: "valid", serialized, bytes: maxBytes });
	expect(io.bytes).toBe(maxBytes);
	const { constants } = await vi.importActual("node:fs");
	expect(io.flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
	expect(await readFile(io.target, "utf8")).toBe(serialized);
});

test("inspection refuses an oversized file before reading its payload", async () => {
	// Arrange
	await writeFile(io.target, serialized, { mode: 0o600 });
	// Act
	const result = await spool.inspectRejectedRawEventSpoolEntry({
		receipt,
		homeDir: home,
		maxBytes: 8,
	});
	// Assert
	expect(result.validation).toBe("read_limit_exceeded");
	expect(result).not.toHaveProperty("serialized");
	expect(io.reads).toBe(0);
	expect(await readFile(io.target, "utf8")).toBe(serialized);
});

test("inspection caps reads even when a file grows after the size check", async () => {
	// Arrange
	await writeFile(io.target, serialized, { mode: 0o600 });
	io.grow = true;
	const maxBytes = Buffer.byteLength(serialized);
	// Act
	const result = await spool.inspectRejectedRawEventSpoolEntry({
		receipt,
		homeDir: home,
		maxBytes,
	});
	// Assert: one sentinel byte detects growth without consuming the appended content.
	expect(result.validation).toBe("read_limit_exceeded");
	expect(result).not.toHaveProperty("serialized");
	expect(io.bytes).toBe(maxBytes + 1);
});

test.each(["size", "mtimeMs", "ctimeMs"])(
	"reports %s changes during reading without returning bytes",
	async (changed) => {
		// Arrange: ctime-only changes model chmod without changing size or payload bytes.
		await writeFile(io.target, serialized, { mode: 0o600 });
		io.changed = changed;
		// Act
		const result = await spool.inspectRejectedRawEventSpoolEntry({ receipt, homeDir: home });
		// Assert
		expect(result.validation).toBe("changed_during_read");
		expect(result).not.toHaveProperty("serialized");
		expect(await readFile(io.target, "utf8")).toBe(serialized);
	},
);

test("read limit takes precedence over a change detected after reading", async () => {
	// Arrange
	await writeFile(io.target, serialized, { mode: 0o600 });
	io.changed = "size";
	// Act
	const result = await spool.inspectRejectedRawEventSpoolEntry({
		receipt,
		homeDir: home,
		maxBytes: Buffer.byteLength(serialized),
	});
	// Assert
	expect(result.validation).toBe("read_limit_exceeded");
	expect(result).not.toHaveProperty("serialized");
});

test.each([undefined, 0])("regular files work without O_NOFOLLOW (%s)", async (noFollow) => {
	// Arrange
	io.noFollow = noFollow;
	await writeFile(io.target, serialized, { mode: 0o600 });
	// Act
	const result = await spool.inspectRejectedRawEventSpoolEntry({ receipt, homeDir: home });
	// Assert
	expect(result).toMatchObject({ validation: "valid", serialized });
	expect(io.opens).toBe(1);
	expect(io.bytes).toBe(Buffer.byteLength(serialized));
});

test.each([undefined, 0])(
	"rejects symlinks without O_NOFOLLOW (%s) before opening or reading",
	async (noFollow) => {
		// Arrange
		io.noFollow = noFollow;
		const outside = join(home, "outside.json");
		await writeFile(outside, serialized, { mode: 0o600 });
		await symlink(outside, io.target);
		// Act / Assert
		await expect(
			spool.inspectRejectedRawEventSpoolEntry({ receipt, homeDir: home }),
		).rejects.toMatchObject({ code: "unsafe_entry" });
		expect(io.opens).toBe(0);
		expect(io.reads).toBe(0);
		expect(await readFile(outside, "utf8")).toBe(serialized);
	},
);

test.each([undefined, 0])(
	"rejects replacement between lstat and open without O_NOFOLLOW (%s) before reading",
	async (noFollow) => {
		// Arrange
		io.noFollow = noFollow;
		io.replace = true;
		await writeFile(io.target, serialized, { mode: 0o600 });
		// Act / Assert
		await expect(
			spool.inspectRejectedRawEventSpoolEntry({ receipt, homeDir: home }),
		).rejects.toMatchObject({ code: "unsafe_entry" });
		expect(io.opens).toBe(1);
		expect(io.reads).toBe(0);
		expect(await readFile(`${io.target}.original`, "utf8")).toBe(serialized);
	},
);

test("rejects a receipt with a trailing newline before opening or reading", async () => {
	// Arrange
	await writeFile(io.target, serialized, { mode: 0o600 });
	// Act / Assert
	await expect(
		spool.inspectRejectedRawEventSpoolEntry({ receipt: `${receipt}\n`, homeDir: home }),
	).rejects.toMatchObject({ code: "invalid_receipt" });
	expect(io.opens).toBe(0);
	expect(io.reads).toBe(0);
});

test.each([0, -1, 1.5, Number.NaN, 16 * 1024 * 1024 + 1])(
	"rejects invalid inspection limit %s before opening a file",
	async (maxBytes) => {
		// Arrange
		await writeFile(io.target, serialized, { mode: 0o600 });
		// Act / Assert
		await expect(
			spool.inspectRejectedRawEventSpoolEntry({ receipt, homeDir: home, maxBytes }),
		).rejects.toMatchObject({ code: "invalid_limit" });
		expect(io.opens).toBe(0);
		expect(io.reads).toBe(0);
	},
);

test("listing sanitizes unexpected disk errors", async () => {
	// Arrange
	io.fail = true;
	// Act / Assert
	await expect(
		spool.listRejectedRawEventSpoolEntries({ homeDir: home, validation: "metadata" }),
	).rejects.toMatchObject({
		code: "inspection_failed",
		message: "Could not inspect retained events. Files were left untouched.",
	});
});

test("inspection sanitizes unexpected disk errors", async () => {
	// Arrange
	await writeFile(io.target, serialized, { mode: 0o600 });
	io.fail = true;
	// Act / Assert
	await expect(
		spool.inspectRejectedRawEventSpoolEntry({ receipt, homeDir: home }),
	).rejects.toMatchObject({
		code: "inspection_failed",
		message: "Could not inspect retained events. Files were left untouched.",
	});
	expect(await readFile(io.target, "utf8")).toBe(serialized);
});
