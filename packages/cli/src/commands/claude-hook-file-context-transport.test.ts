import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeHookFileContextCommand } from "./claude-hook-file-context.js";
import { runClaudeFileContextTransport } from "./claude-hook-file-context-transport.js";

const mocks = vi.hoisted(() => {
	const store = { hasCurrentIdentity: vi.fn(() => true), close: vi.fn() };
	return {
		store,
		open: vi.fn(
			class SyntheticMemoryStore {
				hasCurrentIdentity = store.hasCurrentIdentity;
				close = store.close;
			},
		),
		dispatch: vi.fn((_store: unknown, _request: unknown) => ({
			ok: true,
			result: { continue: true },
			delivery_pending: false,
		})),
		identity: { device_id: "synthetic-device" },
	};
});
vi.mock("@codemem/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@codemem/core")>()),
	MemoryStore: mocks.open,
	dispatchFileContextTransport: mocks.dispatch,
	buildViewerIdentityTarget: () => mocks.identity,
}));
let directory: string;
let originalExitCode: typeof process.exitCode;
beforeEach(() => {
	originalExitCode = process.exitCode;
	process.exitCode = undefined;
	vi.clearAllMocks();
	mocks.store.hasCurrentIdentity.mockReturnValue(true);
	mocks.store.close.mockReset();
	mocks.dispatch
		.mockReset()
		.mockReturnValue({ ok: true, result: { continue: true }, delivery_pending: false });
	directory = mkdtempSync(join(tmpdir(), "codemem-cli-transport-"));
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("CODEMEM_")) vi.stubEnv(key, undefined);
	}
	vi.stubEnv("HOME", directory);
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", join(directory, "keys"));
});
afterEach(() => {
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});
const attemptId = "018f2db4-f9d3-7a22-8d18-000000000001";
const payload = () => ({
	action: "lookup",
	attempt_id: attemptId,
	request_id: `claude-file-context/cli/${attemptId}`,
	source_session_id: "synthetic-session",
	ledger_enabled: true,
	db_path: join(directory, "memory.sqlite"),
	identity_target: { ...mocks.identity },
	relative_path: "src/security.ts",
	project: "test-project",
	file_mtime_ms: 0,
});
function run(body = payload()) {
	return runClaudeFileContextTransport(body, { dbPath: join(directory, "memory.sqlite") });
}
async function command(args: string[], input: string) {
	let stdout = "";
	let stderr = "";
	vi.spyOn(console, "log").mockImplementation((value) => {
		stdout += `${value}\n`;
	});
	vi.spyOn(process.stdout, "write").mockImplementation((value) => {
		stdout += String(value);
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((value) => {
		stderr += String(value);
		return true;
	});
	const stream = Readable.from([input]);
	const stdin = vi
		.spyOn(process.stdin, Symbol.asyncIterator)
		.mockImplementation(() => stream[Symbol.asyncIterator]());
	await createClaudeHookFileContextCommand().parseAsync(args, { from: "user" });
	return { stdout, stderr, status: process.exitCode ?? 0, stdin };
}

async function child(args: string[], options: { input?: string } = {}) {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("CODEMEM_")) env[key] = value;
	}
	Object.assign(env, {
		HOME: directory,
		XDG_CONFIG_HOME: join(directory, "config"),
		CODEMEM_CONFIG: join(directory, "config.json"),
		CODEMEM_DB: join(directory, "memory.sqlite"),
		CODEMEM_KEYS_DIR: join(directory, "keys"),
		CODEMEM_SYNC_KEY_STORE: "file",
		CODEMEM_EMBEDDING_DISABLED: "1",
		CODEMEM_EMBEDDING_OFFLINE: "1",
		CODEMEM_PLUGIN_LOG_PATH: join(directory, "plugin.log"),
	});
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--conditions",
			"source",
			resolve(import.meta.dirname, "../index.ts"),
			"claude-hook-file-context",
			...args,
		],
		{
			cwd: resolve(import.meta.dirname, "../../../.."),
			env,
			stdio: "pipe",
			timeout: 10_000,
		},
	);
	let stdout = "";
	let stderr = "";
	let stdinError: Error | undefined;
	child.stdin.on("error", (error: Error) => {
		stdinError = error;
	});
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk) => {
		stderr += chunk;
	});
	// Omit input for the profile probe so stdin stays unwritten and open until exit.
	if (options.input !== undefined) child.stdin.end(options.input);
	const [status, signal] = await once(child, "close");
	return { stdout, stderr, status, signal, stdinError };
}

describe("CLI transport validates before opening the database", () => {
	it.each([
		{ action: "execute" },
		{ relative_path: undefined },
		{ relative_path: "../secret" },
		{ source_session_id: undefined },
		{ source_session_id: "/session" },
		{ db_path: undefined },
		{ identity_target: undefined },
		{ authorized: true },
	])("rejects invalid shape %j before store acquisition", (changes) => {
		// Arrange
		const body = { ...payload(), ...changes };
		// Act / Assert
		expect(() => run(body as ReturnType<typeof payload>)).toThrow(
			"invalid file-context transport request",
		);
		expect(mocks.open).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});
	it.each(["database", "identity"])("rejects a mismatched %s before store acquisition", (field) => {
		// Arrange
		const body = payload();
		if (field === "database") body.db_path = join(directory, "other.sqlite");
		if (field === "identity") body.identity_target.device_id = "other-device";
		// Act / Assert
		expect(() => run(body)).toThrow("file-context target mismatch");
		expect(mocks.open).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});
	it("dispatches a matching target and always closes its store", () => {
		// Arrange
		const body = payload();
		// Act
		const result = run(body);
		// Assert
		expect(mocks.open).toHaveBeenCalledWith(body.db_path);
		expect(mocks.dispatch).toHaveBeenCalledWith(mocks.store, body);
		expect(mocks.store.close).toHaveBeenCalledOnce();
		expect(result).toMatchObject({ ok: true });
	});
	it("rejects a changed current store identity without querying", () => {
		// Arrange
		mocks.store.hasCurrentIdentity.mockReturnValue(false);
		// Act / Assert
		expect(() => run()).toThrow("file-context identity changed");
		expect(mocks.dispatch).not.toHaveBeenCalled();
		expect(mocks.store.close).toHaveBeenCalledOnce();
	});
	it("closes after dispatch failure without replacing the original failure", () => {
		// Arrange
		mocks.dispatch.mockImplementation(() => {
			throw new Error("synthetic dispatch failure");
		});
		mocks.store.close.mockImplementation(() => {
			throw new Error("synthetic cleanup failure");
		});
		// Act / Assert
		expect(() => run()).toThrow("synthetic dispatch failure");
		expect(mocks.store.close).toHaveBeenCalledOnce();
	});
	it("preserves successful output when cleanup fails", () => {
		// Arrange
		mocks.store.close.mockImplementation(() => {
			throw new Error("synthetic cleanup failure");
		});
		// Act
		const result = run();
		// Assert
		expect(result).toEqual({ ok: true, result: { continue: true }, delivery_pending: false });
	});
	it.each(["1", " TRUE ", "yes", "on"])(
		"honors CODEMEM_PLUGIN_IGNORE=%s without opening a store",
		(value) => {
			// Arrange
			vi.stubEnv("CODEMEM_PLUGIN_IGNORE", value);
			// Act
			const result = run();
			// Assert
			expect(result).toMatchObject({
				ok: true,
				result: { continue: true },
				delivery_pending: false,
			});
			expect(mocks.open).not.toHaveBeenCalled();
			expect(mocks.dispatch).not.toHaveBeenCalled();
		},
	);
	it("does not interpret a false ignore flag as enabled", () => {
		// Arrange
		vi.stubEnv("CODEMEM_PLUGIN_IGNORE", "0");
		// Act
		run();
		// Assert
		expect(mocks.dispatch).toHaveBeenCalledOnce();
	});
	it("applies the runtime ledger disable flag even if a client requests capture", () => {
		// Arrange
		vi.stubEnv("CODEMEM_RETRIEVAL_LEDGER", "off");
		// Act
		run();
		// Assert
		expect(mocks.dispatch).toHaveBeenCalledWith(
			mocks.store,
			expect.objectContaining({ ledger_enabled: false }),
		);
	});
	it("records disabled file context as a skip instead of performing lookup", () => {
		// Arrange
		vi.stubEnv("CODEMEM_FILE_CONTEXT", "false");
		// Act
		run();
		// Assert
		const request = mocks.dispatch.mock.calls[0]?.[1];
		expect(request).toMatchObject({ action: "skip", reason: "file_context_disabled" });
		expect(request).not.toHaveProperty("relative_path");
	});
});

describe("CLI transport command input", () => {
	it("returns the capability profile without reading stdin or creating a database", async () => {
		// Arrange
		const args = [
			"--transport-profile",
			"--db-path",
			join(directory, "missing-parent", "memory.sqlite"),
		];
		// Act
		const result = await command(args, "not valid JSON");
		// Assert
		expect(result.stdin).not.toHaveBeenCalled();
		expect(mocks.open).not.toHaveBeenCalled();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			file_context_transport: 1,
			visibility_enforced: true,
			deferred_delivery: true,
		});
		expect(readdirSync(directory)).toEqual([]);
	});
	it.each(["", " \t\r\n"])(
		"rejects blank transport input %j before creating a database",
		async (input) => {
			// Arrange: transport requires a request, even when legacy mode would continue.
			const args = ["--transport", "--db-path", join(directory, "memory.sqlite")];
			// Act
			const result = await command(args, input);
			// Assert
			expect(mocks.open).not.toHaveBeenCalled();
			expect(readdirSync(directory)).toEqual([]);
			expect(result.status).toBe(1);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout)).toEqual({
				error: "parse_error",
				message: "transport request required",
			});
		},
	);
	it.each(["", " \t\r\n"])(
		"preserves legacy continuation for blank input %j without creating a database",
		async (input) => {
			// Arrange
			const args = ["--db-path", join(directory, "memory.sqlite")];
			// Act
			const result = await command(args, input);
			// Assert
			expect(mocks.open).not.toHaveBeenCalled();
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout)).toEqual({ continue: true });
			expect(readdirSync(directory)).toEqual([]);
		},
	);
	it.each([
		{ input: "{", error: "parse_error", message: "invalid JSON" },
		{ input: "[]", error: "parse_error", message: "payload must be a JSON object" },
		{
			input: JSON.stringify({ action: "lookup" }),
			error: "file_context_failed",
			message: "file context unavailable",
		},
		{ input: " ".repeat(16_385), error: "parse_error", message: "transport payload too large" },
	])(
		"rejects malformed/oversized transport input before creating a database",
		async ({ input, error, message }) => {
			// Arrange
			const args = ["--transport", "--db-path", join(directory, "memory.sqlite")];
			// Act
			const result = await command(args, input);
			// Assert
			expect(mocks.open).not.toHaveBeenCalled();
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(JSON.parse(result.stderr)).toEqual({ error, message });
			expect(readdirSync(directory)).toEqual([]);
		},
	);
	it("preserves legacy continuation output for a payload without a file", async () => {
		// Arrange
		const input = JSON.stringify({
			hook_event_name: "PreToolUse",
			tool_name: "Read",
			tool_input: {},
		});
		// Act
		const result = await command([], input);
		// Assert
		expect(mocks.open).not.toHaveBeenCalled();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({ continue: true });
		expect(readdirSync(directory)).toEqual([]);
	});
});

// Full source startup is covered here. Input permutations above use real Commander actions.
describe("real CLI transport entrypoint", () => {
	it("returns the capability profile while stdin remains open without creating a database", async () => {
		// Arrange
		const args = [
			"--transport-profile",
			"--db-path",
			join(directory, "missing-parent", "memory.sqlite"),
		];
		// Act
		const result = await child(args);
		// Assert
		expect(result.stdinError).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			file_context_transport: 1,
			visibility_enforced: true,
			deferred_delivery: true,
		});
		expect(readdirSync(directory)).toEqual([]);
	}, 15_000);

	it("rejects malformed transport input without creating a database", async () => {
		// Arrange
		const args = ["--transport", "--db-path", join(directory, "memory.sqlite")];
		// Act
		const result = await child(args, { input: "{" });
		// Assert
		expect(result.stdinError).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr)).toEqual({ error: "parse_error", message: "invalid JSON" });
		expect(readdirSync(directory)).toEqual([]);
	}, 15_000);

	it("preserves legacy continuation without creating a database", async () => {
		// Arrange
		const args = ["--db-path", join(directory, "memory.sqlite")];
		const input = JSON.stringify({
			hook_event_name: "PreToolUse",
			tool_name: "Read",
			tool_input: {},
		});
		// Act
		const result = await child(args, { input });
		// Assert
		expect(result.stdinError).toBeUndefined();
		expect(result.signal).toBeNull();
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({ continue: true });
		expect(readdirSync(directory)).toEqual([]);
	}, 15_000);
});
