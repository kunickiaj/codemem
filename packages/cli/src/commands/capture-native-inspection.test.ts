import {
	chmod,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerRootCommands } from "../command-tree.js";

const services = vi.hoisted(() => ({
	store: vi.fn(() => {
		throw new Error("unexpected database access");
	}),
	connect: vi.fn(() => {
		throw new Error("unexpected database access");
	}),
}));
vi.mock("@codemem/core", async (importActual) => ({
	...(await importActual<typeof import("@codemem/core")>()),
	MemoryStore: services.store,
	connect: services.connect,
	connectReadOnly: services.connect,
}));

const providers = ["claude", "codex", "pi"] as const;
const receipt = "rejected-400-invalid_payload-hook-1730000000-123-1234.json.retained";
const serialized = ` ${JSON.stringify({ session_id: "private-session", prompt: "private-payload café\u001b\n\t\u0085\u202e\u2066" })}\n`;
let home: string;
let dirs: Record<(typeof providers)[number], string>;
const savedExitCode = process.exitCode;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "codemem-native-inspection-"));
	dirs = { claude: join(home, "claude"), codex: join(home, "codex"), pi: join(home, "pi") };
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_DB", join(home, "must-not-create.sqlite"));
	for (const provider of providers) {
		await mkdir(dirs[provider], { mode: 0o755 });
		await chmod(dirs[provider], 0o755);
		vi.stubEnv(`CODEMEM_${provider.toUpperCase()}_HOOK_SPOOL_DIR`, dirs[provider]);
	}
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected HTTP")));
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	services.store.mockClear();
	services.connect.mockClear();
	process.exitCode = undefined;
});

afterEach(async () => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(services.store).not.toHaveBeenCalled();
	expect(services.connect).not.toHaveBeenCalled();
	process.exitCode = savedExitCode;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	await rm(home, { recursive: true, force: true });
});

async function run(args: string[]) {
	const command = registerRootCommands(new Command("codemem")).exitOverride();
	await command.parseAsync(["capture", ...args], { from: "user" });
	return vi
		.mocked(process.stdout.write)
		.mock.calls.map(([text]) => String(text))
		.join("");
}

function flags(provider: string) {
	return ["--format", "native-hook-v1", "--provider", provider];
}

function expectSafe(text: string) {
	expect(text).not.toContain(home);
	expect(text).not.toMatch(
		/private-session|private-payload|"(?:raw|serialized|payload|session_id|path)"/,
	);
}

it.each(providers)("lists only %s retained receipts as safe metadata", async (provider) => {
	// Arrange
	for (const current of providers)
		await writeFile(join(dirs[current], receipt), current === provider ? serialized : "{}", {
			mode: 0o644,
		});
	await writeFile(join(dirs[provider], "hook-1730000000-123-1234.json"), serialized);
	// Act
	const text = await run(["list-rejected", ...flags(provider), "--json"]);
	// Assert
	expect(JSON.parse(text)).toMatchObject({
		format: "native-hook-v1",
		entries: [
			{
				receipt,
				bytes: Buffer.byteLength(serialized),
				status: 400,
				reason: "invalid_payload",
				validation: "not_checked",
			},
		],
	});
	expect(JSON.parse(text).entries).toHaveLength(1);
	expectSafe(text);
	expect(process.exitCode ?? 0).toBe(0);
	expect(process.stderr.write).not.toHaveBeenCalled();
});

it.each(providers)(
	"shows valid %s native payload metadata without private content",
	async (provider) => {
		// Arrange
		await writeFile(join(dirs[provider], receipt), serialized, { mode: 0o644 });
		await chmod(join(dirs[provider], receipt), 0o644);
		const before = await stat(join(dirs[provider], receipt));
		// Act
		const text = await run(["show-rejected", receipt, ...flags(provider), "-j"]);
		// Assert
		expect(JSON.parse(text)).toMatchObject({
			format: "native-hook-v1",
			receipt,
			validation: "valid",
		});
		expectSafe(text);
		expect(await readFile(join(dirs[provider], receipt), "utf8")).toBe(serialized);
		expect((await stat(join(dirs[provider], receipt))).mtimeMs).toBe(before.mtimeMs);
		expect((await stat(dirs[provider])).mode & 0o777).toBe(0o755);
		expect((await stat(join(dirs[provider], receipt))).mode & 0o777).toBe(0o644);
	},
);

it.each(providers)(
	"escapes raw %s Unicode controls and preserves exact serialized text",
	async (provider) => {
		// Arrange
		await writeFile(join(dirs[provider], receipt), serialized, { mode: 0o600 });
		// Act
		const text = await run(["show-rejected", receipt, ...flags(provider), "--raw"]);
		// Assert
		expect(JSON.parse(text)).toMatchObject({
			format: "native-hook-v1",
			validation: "valid",
			raw: serialized,
		});
		const containsControl = [...text.trimEnd()].some((character) => {
			const point = character.codePointAt(0) ?? 0;
			return (
				point < 0x20 ||
				(point >= 0x7f && point <= 0x9f) ||
				(point >= 0x2028 && point <= 0x202e) ||
				(point >= 0x2066 && point <= 0x2069)
			);
		});
		expect(containsControl).toBe(false);
		expect(text).not.toContain(home);
		expect(process.exitCode ?? 0).toBe(0);
	},
);

it.each(
	[
		["--format", "native-hook-v1"],
		["--provider", "claude"],
		["--format", "opencode-raw-event-v1", "--provider", "claude"],
		["--format", "private-invalid-format"],
		["--format", "native-hook-v1", "--provider", "private-invalid-provider"],
	].map((options) => ({ options })),
)("returns a fixed safe usage error for flag combination $options", async ({ options }) => {
	// Arrange
	await writeFile(join(dirs.claude, receipt), serialized);
	// Act
	const text = await run(["list-rejected", ...options, "--json"]);
	// Assert
	expect(JSON.parse(text)).toMatchObject({ error: "usage_error", message: expect.any(String) });
	expect(process.exitCode).toBe(2);
	expectSafe(text);
	expect(text).not.toMatch(/private-invalid/);
	expect(process.stderr.write).not.toHaveBeenCalled();
});

it("keeps default inspection on the OpenCode format", async () => {
	// Arrange
	await writeFile(join(dirs.claude, receipt), serialized);
	// Act
	const text = await run(["list-rejected", "--json"]);
	// Assert
	expect(JSON.parse(text)).toEqual({ format: "opencode-raw-event-v1", entries: [] });
	expect(await readFile(join(dirs.claude, receipt), "utf8")).toBe(serialized);
});

it.each(
	[
		{ action: "list-rejected", unsafe: "directory" },
		{ action: "show-rejected", unsafe: "directory" },
		{ action: "list-rejected", unsafe: "parent" },
		{ action: "show-rejected", unsafe: "parent" },
		{ action: "list-rejected", unsafe: "file" },
		{ action: "show-rejected", unsafe: "file" },
	].flatMap((entry) => [
		{ ...entry, json: true },
		{ ...entry, json: false },
	]),
)(
	"rejects $unsafe group-write permissions in $action (JSON: $json) without repairing files",
	async ({ action, unsafe, json }) => {
		// Arrange
		const path = join(dirs.claude, receipt);
		await writeFile(path, serialized, { mode: 0o644 });
		let unsafePath = dirs.claude;
		if (unsafe === "parent") unsafePath = home;
		if (unsafe === "file") unsafePath = path;
		const unsafeMode = unsafe === "file" ? 0o664 : 0o775;
		await chmod(unsafePath, unsafeMode);
		const before = await stat(path);
		// Act
		const args = [action];
		if (action === "show-rejected") args.push(receipt);
		const stdout = await run([...args, ...flags("claude"), ...(json ? ["--json"] : [])]);
		const text = json
			? stdout
			: vi
					.mocked(process.stderr.write)
					.mock.calls.map(([chunk]) => String(chunk))
					.join("");
		// Assert
		if (json)
			expect(JSON.parse(text)).toMatchObject({
				error: unsafe === "file" ? "unsafe_entry" : "unsafe_directory",
				message: expect.any(String),
			});
		expect(text).toMatch(/group.*other.*writ/i);
		expect(process.exitCode).toBe(1);
		expectSafe(text);
		expect(await readFile(path, "utf8")).toBe(serialized);
		expect(await stat(path)).toMatchObject({
			mode: before.mode,
			ino: before.ino,
			mtimeMs: before.mtimeMs,
		});
		expect((await stat(unsafePath)).mode & 0o777).toBe(unsafeMode);
	},
);

it("does not create a provider directory while listing a missing spool", async () => {
	// Arrange
	await rm(dirs.pi, { recursive: true });
	// Act
	const text = await run(["list-rejected", ...flags("pi"), "--json"]);
	// Assert
	expect(JSON.parse(text).entries).toEqual([]);
	expect(await readdir(home)).not.toContain("pi");
});

it.each(["../private-session", "rejected-invalid.json", receipt])(
	"returns safe errors for absent or invalid receipt %s",
	async (input) => {
		// Arrange: no retained source exists.
		const before = await readdir(dirs.claude);
		// Act
		const text = await run(["show-rejected", input, ...flags("claude"), "--raw"]);
		// Assert
		expect(JSON.parse(text)).toMatchObject({
			error: expect.any(String),
			message: expect.any(String),
		});
		expect(process.exitCode).toBeGreaterThan(0);
		expectSafe(text);
		expect(await readdir(dirs.claude)).toEqual(before);
	},
);

it.each(["invalid JSON", "invalid UTF-8", "invalid envelope", "oversized"])(
	"withholds raw text for %s",
	async (kind) => {
		// Arrange
		const path = join(dirs.claude, receipt);
		if (kind === "oversized") {
			const handle = await open(path, "wx", 0o600);
			await handle.truncate(16 * 1024 * 1024 + 1);
			await handle.close();
		} else {
			const contents = {
				"invalid JSON": Buffer.from("private-payload {"),
				"invalid UTF-8": Buffer.from([0xff]),
				"invalid envelope": Buffer.from("[]"),
			};
			await writeFile(path, contents[kind as keyof typeof contents], { mode: 0o600 });
		}
		const before = await stat(path);
		// Act
		const text = await run(["show-rejected", receipt, ...flags("claude"), "--raw", "--json"]);
		// Assert
		expect(JSON.parse(text)).toMatchObject({
			error: "raw_unavailable",
			validation: kind === "oversized" ? "read_limit_exceeded" : "invalid",
		});
		expectSafe(text);
		expect(process.exitCode).toBe(1);
		expect(await stat(path)).toMatchObject({
			size: before.size,
			ino: before.ino,
			mtimeMs: before.mtimeMs,
		});
	},
);
