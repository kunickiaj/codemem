import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerRootCommands } from "../command-tree.js";

// These commands must never need a database, a running viewer, or a delivery attempt.
const services = vi.hoisted(() => ({
	changed: false,
	store: vi.fn(() => {
		throw new Error("unexpected database access");
	}),
	connect: vi.fn(() => {
		throw new Error("unexpected database access");
	}),
}));
vi.mock("node:fs/promises", async (importActual) => {
	const actual = await importActual<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			let read = false;
			return new Proxy(handle, {
				get(target, key) {
					if (key === "read")
						return async (...readArgs: unknown[]) => {
							read = true;
							return Reflect.apply(target.read, target, readArgs);
						};
					if (key === "stat")
						return async () => {
							const details = await target.stat();
							if (services.changed && read)
								return Object.assign(Object.create(details), { ctimeMs: details.ctimeMs + 1 });
							return details;
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	};
});
vi.mock("@codemem/core", async (importActual) => ({
	...(await importActual<typeof import("@codemem/core")>()),
	MemoryStore: services.store,
	connect: services.connect,
	connectReadOnly: services.connect,
}));

const eventId = "fixture-private-event";
const envelope = {
	event_id: eventId,
	event_type: "user_prompt",
	session_id: "fixture-private-session",
	payload: { prompt_text: "fixture-private-payload café\u001b[31m\n\t\u0085\u202e" },
};
const receipt = (id = eventId) =>
	`rejected-${createHash("sha256").update(id).digest("hex")}-400-invalid_payload.json`;
const serialized = ` ${JSON.stringify(envelope, null, 2)}\n`;
const savedExitCode = process.exitCode;
let home: string;
let directory: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "codemem-capture-inspection-"));
	directory = join(home, ".codemem", "opencode-raw-event-spool");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_DB", join(home, "must-not-create.sqlite"));
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected HTTP request")));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	services.store.mockClear();
	services.changed = false;
	services.connect.mockClear();
	process.exitCode = undefined;
});

afterEach(async () => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(services.store).not.toHaveBeenCalled();
	expect(services.connect).not.toHaveBeenCalled();
	process.exitCode = savedExitCode;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await rm(home, { recursive: true, force: true });
});

async function run(args: string[], options = { textOnly: false }) {
	const command = registerRootCommands(new Command("codemem")).exitOverride();
	await command.parseAsync(["capture", ...args], { from: "user" });
	const calls = vi.mocked(process.stdout.write).mock.calls;
	expect(calls).toHaveLength(1);
	const text = String(calls[0]?.[0]);
	return { text, result: options.textOnly ? undefined : JSON.parse(text) };
}

function expectPrivateMetadata(text: string) {
	expect(text).not.toContain(home);
	expect(text).not.toMatch(/fixture-private-event|fixture-private-session|fixture-private-payload/);
	expect(text).not.toMatch(/"(?:path|event_id|session_id|payload|serialized|raw)"/);
}

it.each(["--json", "-j"])("lists safe receipt metadata with %s", async (jsonFlag) => {
	// Arrange: bytes include whitespace that must not be reformatted or disclosed.
	await writeFile(join(directory, receipt()), serialized, { mode: 0o600 });
	const before = await stat(join(directory, receipt()));
	// Act
	const { result, text } = await run(["list-rejected", jsonFlag]);
	// Assert
	expect(result).toMatchObject({
		format: "opencode-raw-event-v1",
		entries: [
			{
				receipt: receipt(),
				bytes: Buffer.byteLength(serialized),
				status: 400,
				reason: "invalid_payload",
				validation: "not_checked",
			},
		],
	});
	expectPrivateMetadata(text);
	expect(process.exitCode ?? 0).toBe(0);
	expect(console.error).not.toHaveBeenCalled();
	expect(process.stderr.write).not.toHaveBeenCalled();
	expect(await readFile(join(directory, receipt()), "utf8")).toBe(serialized);
	expect((await stat(join(directory, receipt()))).mtimeMs).toBe(before.mtimeMs);
	expect(await readdir(directory)).toEqual([receipt()]);
});

it("lists corrupt payloads without validating or omitting their receipts", async () => {
	// Arrange
	await writeFile(join(directory, receipt()), Buffer.from([0xff, 0x1b]));
	// Act
	const { result, text } = await run(["list-rejected", "--json"]);
	// Assert
	expect(result.entries).toEqual([
		{
			receipt: receipt(),
			bytes: 2,
			status: 400,
			reason: "invalid_payload",
			validation: "not_checked",
		},
	]);
	expectPrivateMetadata(text);
});

it("lists oversized retained files without reading or omitting them", async () => {
	// Arrange: a sparse file exercises the CLI cap without allocating a large payload.
	const handle = await open(join(directory, receipt()), "wx", 0o600);
	await handle.truncate(16 * 1024 * 1024 + 1);
	await handle.close();
	// Act
	const { result } = await run(["list-rejected", "--json"]);
	// Assert
	expect(result.entries).toEqual([
		{
			receipt: receipt(),
			bytes: 16 * 1024 * 1024 + 1,
			status: 400,
			reason: "invalid_payload",
			validation: "not_checked",
		},
	]);
});

it("excludes malformed names and symlinks from metadata listing", async () => {
	// Arrange
	await writeFile(join(home, "outside.json"), serialized, { mode: 0o600 });
	await symlink(join(home, "outside.json"), join(directory, receipt()));
	await writeFile(join(directory, "rejected-private-diagnostic.json"), serialized);
	await writeFile(
		join(directory, receipt().replace("400-invalid_payload", "413-invalid_payload")),
		serialized,
	);
	// Act
	const { result, text } = await run(["list-rejected", "--json"]);
	// Assert
	expect(result.entries).toEqual([]);
	expectPrivateMetadata(text);
	expect(await readFile(join(home, "outside.json"), "utf8")).toBe(serialized);
});

it("returns an empty list for a missing spool without creating it", async () => {
	// Arrange
	await rm(join(home, ".codemem"), { recursive: true });
	// Act
	const { result } = await run(["list-rejected", "--json"]);
	// Assert
	expect(result.entries).toEqual([]);
	expect(await readdir(home)).toEqual([]);
});

it.each([undefined, "--json"])(
	"shows validation metadata without exposing payload by default (%j)",
	async (jsonFlag) => {
		// Arrange
		await writeFile(join(directory, receipt()), serialized, { mode: 0o600 });
		// Act
		const flags = jsonFlag ? [jsonFlag] : [];
		const { text, result } = await run(["show-rejected", receipt(), ...flags], {
			textOnly: !jsonFlag,
		});
		// Assert
		if (jsonFlag)
			expect(result).toEqual({
				format: "opencode-raw-event-v1",
				receipt: receipt(),
				bytes: Buffer.byteLength(serialized),
				status: 400,
				reason: "invalid_payload",
				validation: "valid",
			});
		else {
			expect(text).toContain("valid");
			expect(text).toContain(`${Buffer.byteLength(serialized)} bytes`);
			expect(() => JSON.parse(text)).toThrow();
		}
		expectPrivateMetadata(text);
		expect(text).toContain(receipt());
		expect(process.exitCode ?? 0).toBe(0);
		expect(await readFile(join(directory, receipt()), "utf8")).toBe(serialized);
	},
);

it.each(["human", "json", "raw"])(
	"reports a ctime-only change safely in %s output",
	async (mode) => {
		// Arrange
		await writeFile(join(directory, receipt()), serialized, { mode: 0o600 });
		services.changed = true;
		const flags: string[] = [];
		if (mode === "json") flags.push("--json");
		if (mode === "raw") flags.push("--raw");
		// Act
		const { text, result } = await run(["show-rejected", receipt(), ...flags], {
			textOnly: mode === "human",
		});
		// Assert
		expectPrivateMetadata(text);
		expect(text).toContain("changed_during_read");
		if (mode !== "human") expect(result.validation).toBe("changed_during_read");
		if (mode === "raw") {
			expect(result.error).toBe("raw_unavailable");
			expect(result.message).toMatch(/changed.*read/i);
			expect(result.message).not.toMatch(/failed validation|exceeds/);
			expect(process.exitCode).toBe(1);
		} else expect(process.exitCode ?? 0).toBe(0);
		expect(await readFile(join(directory, receipt()), "utf8")).toBe(serialized);
	},
);

it.each(["--json", "-j", undefined])(
	"reveals original bytes only as an escaped JSON string with --raw %s",
	async (jsonFlag) => {
		// Arrange
		await writeFile(join(directory, receipt()), serialized, { mode: 0o600 });
		// Act
		const flags = jsonFlag ? [jsonFlag] : [];
		const { result, text } = await run(["show-rejected", receipt(), "--raw", ...flags]);
		// Assert: the serialized envelope stays a string, including its original whitespace.
		expect(result.format).toBe("opencode-raw-event-v1");
		expect(result.raw).toBe(serialized);
		expect(text).not.toContain("\u001b");
		expect(text).not.toMatch(/[\u0080-\u009f\u2028-\u202e\u2066-\u2069]/);
		expect(text).not.toContain(home);
		expect(await readFile(join(directory, receipt()), "utf8")).toBe(serialized);
		expect(await readdir(directory)).toEqual([receipt()]);
	},
);

it.each([
	"../fixture-private-payload",
	"/fixture-private-payload",
	"rejected-invalid.json",
	receipt("missing"),
])("returns a fixed safe JSON error for an invalid or absent receipt (%s)", async (input) => {
	// Arrange
	await writeFile(join(directory, receipt()), serialized, { mode: 0o600 });
	// Act
	const { result, text } = await run(["show-rejected", input, "--raw", "--json"]);
	// Assert
	expect(result).toMatchObject({ error: expect.any(String), message: expect.any(String) });
	expect(process.exitCode).toBeGreaterThan(0);
	expectPrivateMetadata(text);
	expect(text).not.toContain(input);
	expect(console.error).not.toHaveBeenCalled();
	expect(await readFile(join(directory, receipt()), "utf8")).toBe(serialized);
});

it.each(["invalid UTF-8", "invalid JSON", "digest mismatch", "symlink", "directory"])(
	"does not disclose raw data for %s",
	async (kind) => {
		// Arrange
		const path = join(directory, receipt());
		const contents = {
			"invalid UTF-8": Buffer.from([0xff]),
			"invalid JSON": Buffer.from("fixture-private-payload {broken"),
			"digest mismatch": Buffer.from(JSON.stringify({ ...envelope, event_id: "other" })),
		};
		if (kind === "symlink") {
			await writeFile(join(home, "outside.json"), serialized, { mode: 0o600 });
			await symlink(join(home, "outside.json"), path);
		} else if (kind === "directory") {
			await mkdir(path, { mode: 0o700 });
		} else {
			await writeFile(path, contents[kind as keyof typeof contents], { mode: 0o600 });
		}
		// Act
		const { text, result } = await run(["show-rejected", receipt(), "--raw", "--json"]);
		// Assert
		expectPrivateMetadata(text);
		expect(text).not.toContain("other");
		expect(process.exitCode).toBe(1);
		if (kind === "symlink" || kind === "directory") {
			expect(result.error).toEqual(expect.any(String));
		} else {
			expect(result).toMatchObject({ validation: "invalid", error: "raw_unavailable" });
		}
		expect(await readdir(directory)).toEqual([receipt()]);
	},
);

it("reports the fixed 16 MiB read limit without disclosing oversized bytes", async () => {
	// Arrange
	const handle = await open(join(directory, receipt()), "wx", 0o600);
	await handle.truncate(16 * 1024 * 1024 + 1);
	await handle.close();
	// Act
	const { text } = await run(["show-rejected", receipt(), "--raw", "--json"]);
	// Assert
	expect(text).toContain("read_limit_exceeded");
	expectPrivateMetadata(text);
	expect((await stat(join(directory, receipt()))).size).toBe(16 * 1024 * 1024 + 1);
});
