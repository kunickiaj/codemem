import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
beforeEach(() => {
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
function child(args: string[], input = "") {
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
	return spawnSync(
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
			input,
			encoding: "utf8",
			timeout: 30_000,
		},
	);
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

describe("real CLI transport entrypoint", () => {
	it.each(["", " \t\r\n", "not valid JSON"])(
		"returns the capability profile without reading stdin %j or creating a database",
		(input) => {
			// Arrange
			const args = [
				"--transport-profile",
				"--db-path",
				join(directory, "missing-parent", "memory.sqlite"),
			];
			// Act
			const result = child(args, input);
			// Assert
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout)).toEqual({
				file_context_transport: 1,
				visibility_enforced: true,
				deferred_delivery: true,
			});
			expect(readdirSync(directory)).toEqual([]);
		},
	);
	it.each(["", " \t\r\n"])(
		"rejects blank transport input %j before creating a database",
		(input) => {
			// Arrange: transport requires a request, even when legacy mode would continue.
			const args = ["--transport", "--db-path", join(directory, "memory.sqlite")];
			// Act
			const result = child(args, input);
			// Assert
			expect(result.error).toBeUndefined();
			expect(readdirSync(directory)).toEqual([]);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(JSON.parse(result.stderr)).toEqual({
				error: "parse_error",
				message: "transport request required",
			});
		},
	);
	it.each(["", " \t\r\n"])(
		"preserves legacy continuation for blank input %j without creating a database",
		(input) => {
			// Arrange
			const args = ["--db-path", join(directory, "memory.sqlite")];
			// Act
			const result = child(args, input);
			// Assert
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout)).toEqual({ continue: true });
			expect(readdirSync(directory)).toEqual([]);
		},
	);
	it.each(["{", "[]", JSON.stringify({ action: "lookup" }), " ".repeat(16_385)])(
		"rejects malformed/oversized transport input before creating a database",
		(input) => {
			// Arrange
			const args = ["--transport", "--db-path", join(directory, "memory.sqlite")];
			// Act
			const result = child(args, input);
			// Assert
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(readdirSync(directory)).toEqual([]);
		},
	);
	it("preserves legacy continuation output for a payload without a file", () => {
		// Arrange
		const input = JSON.stringify({
			hook_event_name: "PreToolUse",
			tool_name: "Read",
			tool_input: {},
		});
		// Act
		const result = child([], input);
		// Assert
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ continue: true });
		expect(readdirSync(directory)).toEqual([]);
	});
});
