import * as disk from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recoverNativeHookReceipt } from "./native-hook-retained-spool.js";

vi.mock("node:fs", async (importActual) => {
	const actual = await importActual<typeof import("node:fs")>();
	return { ...actual, unlinkSync: vi.fn(actual.unlinkSync), fsyncSync: vi.fn(actual.fsyncSync) };
});

const original = "hook-1730000000-123-1234.json";
const receipt = `rejected-400-invalid_payload-${original}.retained`;
const serialized = ' \n{"session_id":"private-session","prompt":"café"}\t\n';
const ack = { acknowledged: true, acknowledgement: "queued" } as const;
let home: string;
let dir: string;
let path: string;
let lock: string;
let actual: typeof disk;

beforeEach(async () => {
	actual = await vi.importActual<typeof disk>("node:fs");
	vi.mocked(disk.unlinkSync).mockImplementation(actual.unlinkSync);
	vi.mocked(disk.fsyncSync).mockImplementation(actual.fsyncSync);
	home = await fs.mkdtemp(join(tmpdir(), "codemem-native-recovery-"));
	dir = join(home, "spool");
	path = join(dir, receipt);
	lock = join(dir, `.native-retain-${original}.lock`);
	await fs.mkdir(dir, { mode: 0o755 });
	await fs.writeFile(path, serialized, { mode: 0o644 });
	vi.stubEnv("HOME", home);
	for (const provider of ["CLAUDE", "CODEX", "PI"])
		vi.stubEnv(`CODEMEM_${provider}_HOOK_SPOOL_DIR`, dir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await fs.rm(home, { recursive: true, force: true });
});

it.each(["claude", "codex", "pi"] as const)(
	"recovers %s with exact serialized bytes and legacy modes",
	async (provider) => {
		// Arrange: an active alias must survive removal of its retained hard link.
		await fs.link(path, join(dir, original));
		const deliver = vi.fn(async () => ack);
		// Act
		const result = await recoverNativeHookReceipt({ provider, receipt, deliver });
		// Assert
		expect(result).toEqual({
			delivery: "accepted",
			acknowledgement: "queued",
			cleanup: "removed",
			lock: "released",
		});
		expect(deliver).toHaveBeenCalledExactlyOnceWith({ serialized });
		expect(await fs.readdir(dir)).toEqual([original]);
		expect(await fs.readFile(join(dir, original), "utf8")).toBe(serialized);
		expect((await fs.stat(join(dir, original))).mode & 0o777).toBe(0o644);
		expect((await fs.stat(dir)).mode & 0o777).toBe(0o755);
	},
);

it.each(["queued", "ingested"] as const)(
	"keeps an explicitly retained %s acknowledgement",
	async (acknowledgement) => {
		// Arrange
		const before = await fs.stat(path);
		// Act
		const result = await recoverNativeHookReceipt({
			provider: "claude",
			receipt,
			keepReceipt: true,
			deliver: async () => ({ acknowledged: true, acknowledgement }),
		});
		// Assert
		expect(result).toEqual({
			delivery: "accepted",
			acknowledgement,
			cleanup: "kept",
			lock: "released",
		});
		expect(await fs.stat(path)).toMatchObject({
			ino: before.ino,
			mode: before.mode,
			mtimeMs: before.mtimeMs,
		});
		expect(await fs.readFile(path, "utf8")).toBe(serialized);
	},
);

it.each([
	[false, "delivery_rejected"],
	[{ acknowledged: false }, "delivery_rejected"],
	[{ acknowledged: true, acknowledgement: "unknown" }, "invalid_acknowledgement"],
	[{ ...ack, extra: true }, "invalid_acknowledgement"],
	[null, "invalid_acknowledgement"],
	[
		{
			get acknowledged() {
				throw new Error("private detail");
			},
			acknowledgement: "queued",
		},
		"invalid_acknowledgement",
	],
])("retains bytes for an untrusted callback result %#", async (value, reason) => {
	// Arrange: JSON.parse represents a runtime callback result without a type assertion.
	const deliver = async () => {
		const descriptor =
			value && typeof value === "object"
				? Object.getOwnPropertyDescriptor(value, "acknowledged")
				: undefined;
		if (descriptor?.get) return Object.defineProperty(JSON.parse("{}"), "acknowledged", descriptor);
		return JSON.parse(JSON.stringify(value));
	};
	// Act
	const result = await recoverNativeHookReceipt({
		provider: "claude",
		receipt,
		deliver,
	});
	// Assert
	expect(result).toMatchObject({
		delivery: "unacknowledged",
		reason,
		cleanup: "not_attempted",
		lock: "released",
	});
	expect(await fs.readFile(path, "utf8")).toBe(serialized);
});

it("reports callback failure without exposing its message or losing bytes", async () => {
	// Arrange
	const deliver = async () => {
		throw new Error("private-session secret");
	};
	// Act
	const result = await recoverNativeHookReceipt({ provider: "claude", receipt, deliver });
	// Assert
	expect(result).toEqual({
		delivery: "unacknowledged",
		cleanup: "not_attempted",
		reason: "delivery_failed",
		lock: "released",
	});
	expect(JSON.stringify(result)).not.toContain("secret");
	expect(await fs.readFile(path, "utf8")).toBe(serialized);
});

it("holds the canonical lock across an asynchronous callback", async () => {
	// Arrange
	let release = () => {};
	const pending = new Promise<typeof ack>((resolve) => {
		release = () => resolve(ack);
	});
	const first = recoverNativeHookReceipt({ provider: "claude", receipt, deliver: () => pending });
	const secondDelivery = vi.fn(async () => ack);
	// Act
	const second = await recoverNativeHookReceipt({
		provider: "claude",
		receipt,
		deliver: secondDelivery,
	});
	release();
	const completed = await first;
	// Assert
	expect(second).toMatchObject({
		delivery: "not_attempted",
		reason: "lock_busy",
		lock: "not_acquired",
	});
	expect(secondDelivery).not.toHaveBeenCalled();
	expect(completed).toMatchObject({ delivery: "accepted", cleanup: "removed", lock: "released" });
});

it.each(["replace", "rewrite", "directory", "lock"] as const)(
	"preserves changed evidence after ACK (%s)",
	async (change) => {
		// Arrange
		const deliver = async () => {
			if (change === "replace") {
				await fs.rename(path, `${path}.old`);
				await fs.writeFile(path, serialized);
			}
			if (change === "rewrite") await fs.writeFile(path, serialized.replace("café", "safe"));
			if (change === "directory") {
				await fs.rename(dir, `${dir}.old`);
				await fs.mkdir(dir);
				await fs.writeFile(path, "replacement");
			}
			if (change === "lock") {
				await fs.rename(lock, `${lock}.old`);
				await fs.writeFile(lock, "replacement");
			}
			return ack;
		};
		// Act
		const result = await recoverNativeHookReceipt({ provider: "claude", receipt, deliver });
		// Assert
		expect(result).toMatchObject({ delivery: "accepted", cleanup: "changed" });
		const expected = {
			directory: "replacement",
			rewrite: serialized.replace("café", "safe"),
			replace: serialized,
			lock: serialized,
		};
		expect(await fs.readFile(path, "utf8")).toBe(expected[change]);
		if (change === "lock") {
			expect(result.lock).toBe("release_failed");
			expect(await fs.readFile(lock, "utf8")).toBe("replacement");
		}
	},
);

it.each(["cleanup", "release", "durability"])(
	"reports %s failure independently of accepted delivery",
	async (failure) => {
		// Arrange: inject only the relevant filesystem operation after delivery.
		const deliver = async () => {
			vi.mocked(disk.unlinkSync).mockImplementation((name) => {
				if (String(name) === (failure === "release" ? lock : path) && failure !== "durability")
					throw new Error("disk failure");
				return actual.unlinkSync(name);
			});
			if (failure === "durability")
				vi.mocked(disk.fsyncSync).mockImplementationOnce(() => {
					throw new Error("disk failure");
				});
			return ack;
		};
		// Act
		const result = await recoverNativeHookReceipt({ provider: "claude", receipt, deliver });
		// Assert
		expect(result).toMatchObject({
			delivery: "accepted",
			cleanup: { cleanup: "failed", durability: "uncertain", release: "removed" }[failure],
			lock: failure === "release" ? "release_failed" : "released",
		});
		if (failure === "cleanup") expect(await fs.readFile(path, "utf8")).toBe(serialized);
		else await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	},
);
