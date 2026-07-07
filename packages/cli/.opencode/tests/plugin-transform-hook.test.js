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

describe("OpenCode transform-time injection", () => {
	const originalEnv = { ...process.env };
	const tmpDirs = [];

	beforeEach(() => {
		// The plugin schedules a delayed compatibility check that can emit its own
		// toast if a slow pack command crosses the timer boundary. These tests only
		// cover transform-time injection, so keep that background timer inert.
		vi.useFakeTimers();
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
		vi.clearAllTimers();
		vi.useRealTimers();
		for (const tmpDir of tmpDirs.splice(0)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
		process.env = originalEnv;
	});

	test("appends built memory pack to the latest user message by default", async () => {
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				return makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Titanic artifact client shipped",
						metrics: { total_items: 1, pack_tokens: 42 },
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

		expect(typeof hooks["experimental.chat.messages.transform"]).toBe("function");

		const output = {
			messages: [
				{
					info: { id: "user-1", sessionID: "sess-1", role: "user" },
					parts: [
						{
							id: "user-1-text",
							sessionID: "sess-1",
							messageID: "user-1",
							type: "text",
							text: "ship the Titanic artifact client",
						},
					],
				},
			],
		};
		await hooks["experimental.chat.messages.transform"]({}, output);

		expect(output.messages[0].parts.at(-1)).toEqual({
			id: "codemem-context-user-1",
			sessionID: "sess-1",
			messageID: "user-1",
			type: "text",
			text: "[codemem context]\n## Summary\n[1] (feature) Titanic artifact client shipped",
			synthetic: true,
		});
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	test("skips message injection for the transform immediately following compaction", async () => {
		const packQueries = [];
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				packQueries.push(args[args.indexOf("pack") + 1]);
				return makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Normal turn context",
						metrics: { total_items: 1, pack_tokens: 42 },
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

		expect(typeof hooks["experimental.session.compacting"]).toBe("function");
		await hooks["experimental.session.compacting"]({ sessionID: "sess-compact" }, { context: [] });

		const output = {
			messages: [
				{
					info: { id: "user-compact", sessionID: "sess-compact", role: "user" },
					parts: [
						{
							id: "user-compact-text",
							sessionID: "sess-compact",
							messageID: "user-compact",
							type: "text",
							text: "summarize this session",
						},
					],
				},
			],
		};

		await hooks["experimental.chat.messages.transform"]({ sessionID: "sess-compact" }, output);
		expect(output.messages[0].parts).toHaveLength(1);
		expect(spawnMock).not.toHaveBeenCalled();

		await hooks["experimental.chat.messages.transform"]({ sessionID: "sess-compact" }, output);
		expect(output.messages[0].parts.at(-1).text).toBe(
			"[codemem context]\n## Summary\n[1] (feature) Normal turn context",
		);
		expect(packQueries).toEqual(["summarize this session greenroom"]);
	});

	test("keeps legacy system prompt injection when CODEMEM_INJECT_SURFACE=system", async () => {
		process.env.CODEMEM_INJECT_SURFACE = "system";
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				return makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Legacy system injection",
						metrics: { total_items: 1, pack_tokens: 42 },
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

		const output = { system: ["base system prompt"] };
		await hooks["experimental.chat.system.transform"](
			{ sessionID: "sess-legacy", model: {} },
			output,
		);

		expect(output.system).toEqual([
			"base system prompt",
			"[codemem context]\n## Summary\n[1] (feature) Legacy system injection",
		]);
	});

	test("skips legacy system injection for the transform immediately following compaction", async () => {
		process.env.CODEMEM_INJECT_SURFACE = "system";
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				return makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Legacy context after compaction",
						metrics: { total_items: 1, pack_tokens: 42 },
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

		await hooks["experimental.session.compacting"]({ sessionID: "sess-legacy-compact" }, { context: [] });

		const output = { system: ["base system prompt"] };
		await hooks["experimental.chat.system.transform"](
			{ sessionID: "sess-legacy-compact", model: {} },
			output,
		);
		expect(output.system).toEqual(["base system prompt"]);
		expect(spawnMock).not.toHaveBeenCalled();

		await hooks["experimental.chat.system.transform"](
			{ sessionID: "sess-legacy-compact", model: {} },
			output,
		);
		expect(output.system).toEqual([
			"base system prompt",
			"[codemem context]\n## Summary\n[1] (feature) Legacy context after compaction",
		]);
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	test("does not inject into system prompt in default message mode", async () => {
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				return makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Should not be used",
						metrics: { total_items: 1, pack_tokens: 42 },
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

		const output = { system: ["base system prompt"] };
		await hooks["experimental.chat.system.transform"](
			{ sessionID: "sess-default-system", model: {} },
			output,
		);

		expect(output.system).toEqual(["base system prompt"]);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	test("does not inject into messages in legacy system mode", async () => {
		process.env.CODEMEM_INJECT_SURFACE = "system";
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				return makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Should not be used",
						metrics: { total_items: 1, pack_tokens: 42 },
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

		const output = {
			messages: [
				{
					info: { id: "user-legacy", sessionID: "sess-legacy", role: "user" },
					parts: [
						{
							id: "user-legacy-text",
							sessionID: "sess-legacy",
							messageID: "user-legacy",
							type: "text",
							text: "legacy mode prompt",
						},
					],
				},
			],
		};
		await hooks["experimental.chat.messages.transform"]({}, output);

		expect(output.messages[0].parts).toHaveLength(1);
		expect(output.messages[0].parts[0].text).toBe("legacy mode prompt");
		expect(spawnMock).not.toHaveBeenCalled();
	});

	test("honors empty prompt overrides instead of falling back to stale captured prompts", async () => {
		process.env.CODEMEM_RAW_EVENTS = "0";
		const packQueries = [];
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				packQueries.push(args[args.indexOf("pack") + 1]);
				return makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Empty prompt override respected",
						metrics: { total_items: 1, pack_tokens: 42 },
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

		await hooks.event({
			event: {
				type: "message.updated",
				properties: {
					sessionID: "sess-empty-override",
					info: { id: "user-stale", role: "user" },
				},
			},
		});
		await hooks.event({
			event: {
				type: "message.part.updated",
				properties: {
					sessionID: "sess-empty-override",
					part: { messageID: "user-stale", type: "text", text: "stale captured prompt" },
				},
			},
		});

		const output = {
			messages: [
				{
					info: { id: "user-empty", sessionID: "sess-empty-override", role: "user" },
					parts: [
						{
							id: "user-empty-text",
							sessionID: "sess-empty-override",
							messageID: "user-empty",
							type: "text",
							text: "   ",
						},
					],
				},
			],
		};

		await hooks["experimental.chat.messages.transform"]({ sessionID: "sess-empty-override" }, output);

		expect(packQueries).toEqual(["greenroom"]);
		expect(output.messages[0].parts.at(-1).text).toBe(
			"[codemem context]\n## Summary\n[1] (feature) Empty prompt override respected",
		);
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

		const output = {
			messages: [
				{
					info: { id: "user-scope", sessionID: "sess-scope-a", role: "user" },
					parts: [
						{
							id: "user-scope-text",
							sessionID: "sess-scope-a",
							messageID: "user-scope",
							type: "text",
							text: "greenroom scope safety",
						},
					],
				},
			],
		};
		await hooks["experimental.chat.messages.transform"]({}, output);

		const userPrompt = output.messages[0].parts.map((part) => part.text || "").join("\n");
		expect(userPrompt).toContain("Greenroom authorized scope note");
		expect(userPrompt).not.toContain("Greenroom forbidden payroll secret");
		expect(userPrompt).not.toContain("forbidden payroll details");
		expect(showToast).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(showToast.mock.calls)).not.toContain("forbidden payroll");
	});
});
