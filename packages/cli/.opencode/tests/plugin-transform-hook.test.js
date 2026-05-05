import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../../../core/src/db.js";
import { initTestSchema } from "../../../core/src/test-utils.js";

const spawnMock = vi.fn();
const execSyncMock = vi.fn(() => "test-version");

vi.mock("node:child_process", () => ({
	spawn: (...args) => spawnMock(...args),
	execSync: (...args) => execSyncMock(...args),
}));

const makeProcess = ({ stdout = "", stderr = "", exitCode = 0 }) => {
	const proc = new EventEmitter();
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdin = {
		write: vi.fn(),
		end: vi.fn(),
	};
	queueMicrotask(() => {
		if (stdout) proc.stdout.emit("data", stdout);
		if (stderr) proc.stderr.emit("data", stderr);
		proc.emit("exit", exitCode);
	});
	return proc;
};

const makeProcessFromPackCommand = (args, options = {}) => {
	const proc = new EventEmitter();
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdin = {
		write: vi.fn(),
		end: vi.fn(),
	};
	queueMicrotask(async () => {
		const stdout = [];
		const stderr = [];
		const originalCwd = process.cwd();
		const originalExitCode = process.exitCode;
		const originalLog = console.log;
		const originalError = console.error;
		try {
			const cwd = options.cwd;
			if (cwd) process.chdir(cwd);
			process.exitCode = 0;
			console.log = (...values) => {
				stdout.push(values.join(" "));
			};
			console.error = (...values) => {
				stderr.push(values.join(" "));
			};

			const packIndex = args.indexOf("pack");
			if (packIndex < 0) throw new Error(`pack command missing from ${args.join(" ")}`);
			const { packCommand } = await import("../../src/commands/pack.js");
			await packCommand.parseAsync(args.slice(packIndex + 1), { from: "user" });

			const out = stdout.length > 0 ? `${stdout.join("\n")}\n` : "";
			const err = stderr.length > 0 ? `${stderr.join("\n")}\n` : "";
			if (out) proc.stdout.emit("data", out);
			if (err) proc.stderr.emit("data", err);
			proc.emit("exit", typeof process.exitCode === "number" ? process.exitCode : 0);
		} catch (error) {
			proc.stderr.emit("data", error instanceof Error ? error.message : String(error));
			proc.emit("exit", 1);
		} finally {
			console.log = originalLog;
			console.error = originalError;
			process.exitCode = originalExitCode;
			if (process.cwd() !== originalCwd) process.chdir(originalCwd);
		}
	});
	return proc;
};

const insertSession = (db, { cwd, project }) => {
	const now = new Date().toISOString();
	const info = db
		.prepare("INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, ?, ?, ?, ?)")
		.run(now, cwd, project, "plugin-test", "test");
	return Number(info.lastInsertRowid);
};

const insertCoordinatorScope = (db, scopeId) => {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT OR REPLACE INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id,
			membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, 'team', 'coordinator', 'coord-test', 'group-test', 0, 'active', ?, ?)`,
	).run(scopeId, scopeId, now, now);
};

const grantScopeToDevice = (db, scopeId, deviceId) => {
	insertCoordinatorScope(db, scopeId);
	db.prepare(
		`INSERT OR REPLACE INTO scope_memberships(
			scope_id, device_id, role, status, membership_epoch,
			coordinator_id, group_id, updated_at
		 ) VALUES (?, ?, 'member', 'active', 0, 'coord-test', 'group-test', ?)`,
	).run(scopeId, deviceId, new Date().toISOString());
};

const insertScopedMemory = (
	db,
	{ sessionId, scopeId, title, bodyText },
) => {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_items(session_id, kind, title, body_text, confidence,
			tags_text, active, created_at, updated_at, metadata_json, rev, visibility, scope_id)
		 VALUES (?, 'discovery', ?, ?, 0.9, '', 1, ?, ?, '{}', 1, 'shared', ?)`,
	).run(sessionId, title, bodyText, now, now, scopeId);
};

describe("experimental.chat.system.transform", () => {
	const originalEnv = { ...process.env };
	const tmpDirs = [];

	beforeEach(() => {
		vi.resetModules();
		spawnMock.mockReset();
		execSyncMock.mockClear();
		process.env = {
			...originalEnv,
			CODEMEM_VIEWER: "0",
			CODEMEM_PLUGIN_DEBUG: "1",
			CODEMEM_PLUGIN_LOG: "0",
			CODEMEM_INJECT_CONTEXT: "1",
		};
	});

	afterEach(() => {
		for (const tmpDir of tmpDirs.splice(0)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
		process.env = originalEnv;
	});

	test("appends built memory pack to output.system", async () => {
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				return makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Titanic artifact client shipped",
						metrics: { items: 1, pack_tokens: 42 },
					}),
				});
			}
			return makeProcess({ stdout: "" });
		});

		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: {
				app: { log: vi.fn().mockResolvedValue(undefined) },
				tui: {},
			},
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});

		expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");

		const output = { system: ["base system prompt"] };
		await hooks["experimental.chat.system.transform"](
			{ sessionID: "sess-1", model: {} },
			output,
		);

		expect(output.system).toEqual([
			"base system prompt",
			"[codemem context]\n## Summary\n[1] (feature) Titanic artifact client shipped",
		]);
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	test("injects the CLI-scoped pack without unauthorized scope memories", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-plugin-scope-"));
		tmpDirs.push(tmpDir);
		const worktree = join(tmpDir, "greenroom");
		mkdirSync(worktree);
		const dbPath = join(tmpDir, "mem.sqlite");
		const deviceId = "plugin-scope-device";
		const db = connect(dbPath);
		initTestSchema(db);
		const sessionId = insertSession(db, { cwd: worktree, project: "greenroom" });
		grantScopeToDevice(db, "scope-a", deviceId);
		insertCoordinatorScope(db, "scope-b");
		insertScopedMemory(db, {
			sessionId,
			scopeId: "scope-a",
			title: "Greenroom authorized scope note",
			bodyText: "greenroom scope safety can use the authorized deployment note",
		});
		insertScopedMemory(db, {
			sessionId,
			scopeId: "scope-b",
			title: "Greenroom forbidden payroll secret",
			bodyText: "greenroom scope safety must not inject forbidden payroll details",
		});
		db.close();

		process.env.CODEMEM_DB = dbPath;
		process.env.CODEMEM_DEVICE_ID = deviceId;
		process.env.CODEMEM_RUNNER = "codemem-test-runner";
		const showToast = vi.fn().mockResolvedValue(undefined);
		spawnMock.mockImplementation((_command, args, options) => {
			if (Array.isArray(args) && args.includes("pack")) {
				return makeProcessFromPackCommand(args, options);
			}
			return makeProcess({ stdout: "" });
		});

		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: {
				app: { log: vi.fn().mockResolvedValue(undefined) },
				tui: { showToast },
			},
			directory: worktree,
			worktree,
		});

		const output = { system: ["base system prompt"] };
		await hooks["experimental.chat.system.transform"](
			{ sessionID: "sess-scope-a", model: {} },
			output,
		);

		const systemPrompt = output.system.join("\n");
		expect(systemPrompt).toContain("Greenroom authorized scope note");
		expect(systemPrompt).not.toContain("Greenroom forbidden payroll secret");
		expect(systemPrompt).not.toContain("forbidden payroll details");
		expect(showToast).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(showToast.mock.calls)).not.toContain("forbidden payroll");
	});
});
