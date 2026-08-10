import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "../../../core/src/db.js";
import { buildMemoryPackWithTrace } from "../../../core/src/pack.js";
import { MemoryStore } from "../../../core/src/store.js";
import { getRetrievalAttempt } from "../../../core/src/retrieval-ledger.js";
import { initTestSchema } from "../../../core/src/test-utils.js";
import {
	handleInstrumentedPackLedger,
	handlePromptPackLedger,
	parseInternalLedgerPayload,
} from "../../src/commands/pack.js";

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

const jsonResponse = (status, body) => ({
	ok: status >= 200 && status < 300,
	status,
	json: vi.fn().mockResolvedValue(body),
});

const packResponse = (text = "## Summary\n[1] (feature) Viewer-backed context") => ({
	pack_text: text,
	metrics: { total_items: 1, pack_tokens: 24 },
});

const normalizeIdentityPath = (value, cwd = "/tmp/greenroom") => {
	const trimmed = String(value || "").trim();
	if (!trimmed) return null;
	const expanded = trimmed.startsWith("~/")
		? join(process.env.HOME?.trim() || homedir(), trimmed.slice(2))
		: trimmed;
	return resolve(cwd, expanded);
};

const viewerProfileResponse = () => jsonResponse(200, {
	service: "codemem-viewer",
	protocol_version: 1,
	db_path: resolve(
		normalizeIdentityPath(process.env.CODEMEM_DB) || join(homedir(), ".codemem", "mem.sqlite"),
	),
	identity_target: {
		device_id: process.env.CODEMEM_DEVICE_ID?.trim() || null,
		actor_id_present: Object.hasOwn(process.env, "CODEMEM_ACTOR_ID"),
		actor_id: process.env.CODEMEM_ACTOR_ID?.trim() || null,
		config_path: normalizeIdentityPath(process.env.CODEMEM_CONFIG),
		runtime_root: normalizeIdentityPath(process.env.CODEMEM_RUNTIME_ROOT),
		workspace_id: process.env.CODEMEM_WORKSPACE_ID?.trim() || null,
		home_dir: normalizeIdentityPath(process.env.HOME || homedir()),
		pack_compression: process.env.CODEMEM_PACK_COMPRESSION?.trim() || null,
		embedding_disabled: ["1", "true", "yes"].includes(
			String(process.env.CODEMEM_EMBEDDING_DISABLED || "").toLowerCase(),
		),
		embedding_model: process.env.CODEMEM_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5",
	},
});

const messageOutput = ({
	messageId = "user-viewer",
	sessionID = "sess-viewer",
	text = "use viewer transport",
} = {}) => ({
	messages: [
		{
			info: { id: messageId, sessionID, role: "user" },
			parts: [
				{
					id: `${messageId}-text`,
					sessionID,
					messageID: messageId,
					type: "text",
					text,
				},
			],
		},
	],
});

const fetchPostCalls = (fetchMock) =>
	fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");

const fetchBody = (fetchMock, callIndex) =>
	JSON.parse(fetchPostCalls(fetchMock)[callIndex][1].body);

const isPackOrLedgerSpawn = ([, args]) =>
	Array.isArray(args) && (args.includes("pack") || args.includes("prompt-pack-ledger"));

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
			await packCommand.parseAsync(
				args.slice(packIndex + 1).filter((arg) => arg !== "--internal-ledger"),
				{ from: "user" },
			);

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
		for (const key of [
			"CODEMEM_DB",
			"CODEMEM_DEVICE_ID",
			"CODEMEM_ACTOR_ID",
			"CODEMEM_CONFIG",
			"CODEMEM_RUNTIME_ROOT",
			"CODEMEM_WORKSPACE_ID",
			"CODEMEM_PACK_COMPRESSION",
			"CODEMEM_EMBEDDING_DISABLED",
			"CODEMEM_EMBEDDING_MODEL",
		]) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const tmpDir of tmpDirs.splice(0)) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
		process.env = originalEnv;
	});

	test("appends built memory pack to the latest user message by default", async () => {
		const ledgerPayloads = [];
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				const proc = makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Titanic artifact client shipped",
						metrics: { total_items: 1, pack_tokens: 42 },
					}),
				});
				proc.stdin.write = vi.fn((value) => ledgerPayloads.push(JSON.parse(String(value))));
				return proc;
			}
			const proc = makeProcess({ stdout: "" });
			proc.stdin.write = vi.fn((value) => ledgerPayloads.push(JSON.parse(String(value))));
			return proc;
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
		expect(spawnMock).toHaveBeenCalledTimes(2);
		expect(ledgerPayloads).toHaveLength(2);
		expect(ledgerPayloads[0].attempt_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(ledgerPayloads[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(ledgerPayloads[0].request_id).not.toBe(ledgerPayloads[0].attempt_id);
		expect(ledgerPayloads[1]).toMatchObject({
			action: "delivery",
			attempt_id: ledgerPayloads[0].attempt_id,
			delivery_status: "handed_off",
		});
	});

	test("retries pack without --internal-ledger when an older backend rejects the flag", async () => {
		const packArgs = [];
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				packArgs.push(args);
				if (args.includes("--internal-ledger")) {
					return makeProcess({
						stderr: "error: unknown option '--internal-ledger'",
						exitCode: 1,
					});
				}
				return makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Legacy backend context",
						metrics: { total_items: 1, pack_tokens: 20 },
					}),
				});
			}
			return makeProcess({ stdout: "" });
		});

		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const output = {
			messages: [
				{
					info: { id: "user-legacy-backend", sessionID: "sess-legacy-backend", role: "user" },
					parts: [{ type: "text", text: "legacy backend", messageID: "user-legacy-backend" }],
				},
			],
		};

		await hooks["experimental.chat.messages.transform"]({}, output);

		expect(packArgs).toHaveLength(2);
		expect(packArgs[0]).toContain("--internal-ledger");
		expect(packArgs[1]).not.toContain("--internal-ledger");
		expect(output.messages[0].parts.at(-1).text).toContain("Legacy backend context");
	});

	test("suppresses real zero-result packs without advancing delivery", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-plugin-empty-pack-"));
		tmpDirs.push(tmpDir);
		const dbPath = join(tmpDir, "mem.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		const store = new MemoryStore(dbPath);
		process.env.CODEMEM_DB = dbPath;
		const attempts = [];
		const deliveryPayloads = [];
		const packResponses = [];
		spawnMock.mockImplementation((_command, args) => {
			const proc = new EventEmitter();
			proc.stdout = new EventEmitter();
			proc.stderr = new EventEmitter();
			let stdinText = "";
			proc.stdin = {
				write: vi.fn((value) => {
					stdinText += String(value);
				}),
				end: vi.fn(),
			};
			queueMicrotask(() => {
				try {
					const payload = parseInternalLedgerPayload(stdinText);
					if (Array.isArray(args) && args.includes("pack")) {
						attempts.push(payload);
						const context = args[args.indexOf("pack") + 1];
						const artifacts = buildMemoryPackWithTrace(store, context, 10);
						packResponses.push(artifacts.response);
						handleInstrumentedPackLedger(
							store.db,
							payload,
							context,
							undefined,
							artifacts,
						);
						proc.stdout.emit("data", JSON.stringify(artifacts.response));
					} else {
						deliveryPayloads.push(payload);
						handlePromptPackLedger(store.db, payload);
					}
					proc.emit("exit", 0);
				} catch (error) {
					proc.stderr.emit("data", error instanceof Error ? error.message : String(error));
					proc.emit("exit", 1);
				}
			});
			return proc;
		});

		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const output = {
			messages: [
				{
					info: { id: "user-empty", sessionID: "sess-empty", role: "user" },
					parts: [{ type: "text", text: "nothing here", messageID: "user-empty" }],
				},
			],
		};

		await hooks["experimental.chat.messages.transform"]({}, output);
		await hooks["experimental.chat.messages.transform"]({}, output);

		expect(attempts).toHaveLength(2);
		expect(attempts[1].attempt_id).not.toBe(attempts[0].attempt_id);
		expect(attempts[1].request_id).not.toBe(attempts[0].request_id);
		expect(packResponses).toHaveLength(2);
		for (const response of packResponses) {
			expect(response.metrics.total_items).toBe(0);
			expect(response.pack_text).toContain("## Summary");
		}
		expect(output.messages[0].parts).toHaveLength(1);
		expect(deliveryPayloads).toEqual([]);
		for (const payload of attempts) {
			expect(getRetrievalAttempt(store.db, payload.attempt_id)).toMatchObject({
				retrievalStatus: "no_results",
				deliveryStatus: "not_attempted",
				candidateCount: 0,
				selectedCount: 0,
				exposures: [],
			});
		}
		store.close();
	});

	test("allocates fresh IDs when a failed pack transport succeeds on transform retry", async () => {
		const packPayloads = [];
		const ledgerPayloads = [];
		let packCalls = 0;
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				packCalls += 1;
				const proc = makeProcess(
					packCalls === 1
						? { stderr: "pack transport failed", exitCode: 1 }
						: {
								stdout: JSON.stringify({
									pack_text: "## Summary\n[1] (feature) Retry succeeded",
									metrics: { total_items: 1, pack_tokens: 12 },
								}),
							},
				);
				proc.stdin.write = vi.fn((value) => packPayloads.push(JSON.parse(String(value))));
				return proc;
			}
			const proc = makeProcess({ stdout: "" });
			proc.stdin.write = vi.fn((value) => ledgerPayloads.push(JSON.parse(String(value))));
			return proc;
		});

		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const output = {
			messages: [
				{
					info: { id: "user-retry", sessionID: "sess-retry", role: "user" },
					parts: [{ type: "text", text: "retry transport", messageID: "user-retry" }],
				},
			],
		};

		await hooks["experimental.chat.messages.transform"]({}, output);
		expect(output.messages[0].parts).toHaveLength(1);
		expect(ledgerPayloads.filter((payload) => payload.action === "delivery")).toHaveLength(0);
		await hooks["experimental.chat.messages.transform"]({}, output);

		expect(packCalls).toBe(2);
		expect(packPayloads).toHaveLength(2);
		expect(packPayloads[1].attempt_id).not.toBe(packPayloads[0].attempt_id);
		expect(packPayloads[1].request_id).not.toBe(packPayloads[0].request_id);
		expect(ledgerPayloads.filter((payload) => payload.action === "record")).toHaveLength(1);
		expect(ledgerPayloads).toContainEqual(
			expect.objectContaining({
				action: "record",
				attempt_id: packPayloads[0].attempt_id,
				request_id: packPayloads[0].request_id,
				retrieval_status: "failed",
				failure_stage: "transport",
			}),
		);
		expect(ledgerPayloads).toContainEqual({
			action: "delivery",
			attempt_id: packPayloads[1].attempt_id,
			delivery_status: "handed_off",
		});
		expect(output.messages[0].parts.at(-1).text).toContain("Retry succeeded");
	});

	test("records disabled injection once per session and surface until session deletion", async () => {
		process.env.CODEMEM_INJECT_CONTEXT = "0";
		spawnMock.mockImplementation(() => makeProcess({ stdout: "" }));
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const output = {
			messages: [
				{
					info: { id: "user-disabled", sessionID: "sess-disabled", role: "user" },
					parts: [{ type: "text", text: "disabled", messageID: "user-disabled" }],
				},
			],
		};

		await hooks["experimental.chat.messages.transform"]({}, output);
		await hooks["experimental.chat.messages.transform"]({}, output);
		expect(spawnMock).toHaveBeenCalledTimes(1);

		await hooks.event({
			event: { type: "session.deleted", properties: { sessionID: "sess-disabled" } },
		});
		await hooks["experimental.chat.messages.transform"]({}, output);
		expect(spawnMock).toHaveBeenCalledTimes(2);
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
		expect(spawnMock).toHaveBeenCalledTimes(1);

		await hooks["experimental.chat.messages.transform"]({ sessionID: "sess-compact" }, output);
		expect(output.messages[0].parts.at(-1).text).toBe(
			"[codemem context]\n## Summary\n[1] (feature) Normal turn context",
		);
		expect(packQueries).toEqual(["summarize this session greenroom"]);
		expect(spawnMock).toHaveBeenCalledTimes(3);
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

	test("gives changed legacy system rebuilds fresh identity while exact retries stay idempotent", async () => {
		process.env.CODEMEM_INJECT_SURFACE = "system";
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-plugin-system-rebuild-"));
		tmpDirs.push(tmpDir);
		const dbPath = join(tmpDir, "mem.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		const store = new MemoryStore(dbPath);
		const sessionId = insertSession(store.db, {
			cwd: tmpDir,
			project: "greenroom",
		});
		const firstMemoryId = store.remember(
			sessionId,
			"feature",
			"Legacy rebuild first",
			"legacy rebuild evidence first",
			0.9,
		);
		process.env.CODEMEM_DB = dbPath;
		const packPayloads = [];

		spawnMock.mockImplementation((_command, args) => {
			const proc = new EventEmitter();
			proc.stdout = new EventEmitter();
			proc.stderr = new EventEmitter();
			let stdinText = "";
			proc.stdin = {
				write: vi.fn((value) => {
					stdinText += String(value);
				}),
				end: vi.fn(),
			};
			queueMicrotask(() => {
				try {
					const payload = parseInternalLedgerPayload(stdinText);
					if (Array.isArray(args) && args.includes("pack")) {
						packPayloads.push(payload);
						const context = args[args.indexOf("pack") + 1];
						const artifacts = buildMemoryPackWithTrace(store, context, 10);
						handleInstrumentedPackLedger(
							store.db,
							payload,
							context,
							undefined,
							artifacts,
						);
						proc.stdout.emit("data", JSON.stringify(artifacts.response));
					} else {
						handlePromptPackLedger(store.db, payload);
					}
					proc.emit("exit", 0);
				} catch (error) {
					proc.stderr.emit("data", error instanceof Error ? error.message : String(error));
					proc.emit("exit", 1);
				}
			});
			return proc;
		});

		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: tmpDir,
			worktree: tmpDir,
		});
		const transform = hooks["experimental.chat.system.transform"];
		const input = { sessionID: "sess-legacy-rebuild", model: {} };
		const firstOutput = { system: [] };
		await transform(input, firstOutput);

		const secondMemoryId = store.remember(
			sessionId,
			"decision",
			"Legacy rebuild second",
			"legacy rebuild evidence second",
			0.95,
		);
		const changedOutput = { system: [] };
		await transform(input, changedOutput);
		const exactRetryOutput = { system: [] };
		await transform(input, exactRetryOutput);

		expect(packPayloads).toHaveLength(4);
		expect(packPayloads[1].attempt_id).toBe(packPayloads[0].attempt_id);
		expect(packPayloads[1].request_id).toBe(packPayloads[0].request_id);
		expect(packPayloads[2].attempt_id).not.toBe(packPayloads[0].attempt_id);
		expect(packPayloads[2].request_id).not.toBe(packPayloads[0].request_id);
		expect(packPayloads[3].attempt_id).toBe(packPayloads[2].attempt_id);
		expect(packPayloads[3].request_id).toBe(packPayloads[2].request_id);

		const firstAttempt = getRetrievalAttempt(store.db, packPayloads[0].attempt_id);
		const changedAttempt = getRetrievalAttempt(store.db, packPayloads[2].attempt_id);
		expect(
			store.db.prepare("SELECT COUNT(*) AS count FROM retrieval_attempts").get(),
		).toEqual({ count: 2 });
		expect(firstAttempt).toMatchObject({
			requestId: packPayloads[0].request_id,
			deliveryStatus: "handed_off",
			selectedCount: 1,
		});
		expect(firstAttempt?.exposures.map((exposure) => exposure.memoryId)).toEqual([
			firstMemoryId,
		]);
		expect(changedAttempt).toMatchObject({
			requestId: packPayloads[2].request_id,
			deliveryStatus: "handed_off",
			selectedCount: 2,
		});
		expect(changedAttempt?.exposures.map((exposure) => exposure.memoryId)).toEqual(
			expect.arrayContaining([firstMemoryId, secondMemoryId]),
		);
		expect(
			changedAttempt?.exposures.every(
				(exposure) => exposure.attemptId === packPayloads[2].attempt_id,
			),
		).toBe(true);
		expect(firstOutput.system.join("\n")).toContain("Legacy rebuild first");
		expect(firstOutput.system.join("\n")).not.toContain("Legacy rebuild second");
		expect(changedOutput.system.join("\n")).toContain("Legacy rebuild second");
		expect(exactRetryOutput.system).toEqual(changedOutput.system);
		store.close();
	});

	test("uses the complete ledger artifact fingerprint for legacy system retry identity", async () => {
		process.env.CODEMEM_INJECT_SURFACE = "system";
		const packPayloads = [];
		const ledgerPayloads = [];
		const fingerprints = ["1".repeat(64), "2".repeat(64), "2".repeat(64), "2".repeat(64)];
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				const fingerprint = fingerprints[packPayloads.length];
				const proc = makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Identical rendered text",
						metrics: { total_items: 1, pack_tokens: 12 },
						ledger_artifact_fingerprint: fingerprint,
					}),
				});
				proc.stdin.write = vi.fn((value) => packPayloads.push(JSON.parse(String(value))));
				return proc;
			}
			const proc = makeProcess({ stdout: "" });
			proc.stdin.write = vi.fn((value) => ledgerPayloads.push(JSON.parse(String(value))));
			return proc;
		});

		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const transform = hooks["experimental.chat.system.transform"];
		const input = { sessionID: "sess-ledger-fingerprint", model: {} };
		const firstOutput = { system: [] };
		const changedOutput = { system: [] };
		const exactRetryOutput = { system: [] };

		await transform(input, firstOutput);
		await transform(input, changedOutput);
		await transform(input, exactRetryOutput);

		expect(packPayloads).toHaveLength(4);
		expect(packPayloads[1].attempt_id).toBe(packPayloads[0].attempt_id);
		expect(packPayloads[2].attempt_id).not.toBe(packPayloads[0].attempt_id);
		expect(packPayloads[2].request_id).not.toBe(packPayloads[0].request_id);
		expect(packPayloads[3].attempt_id).toBe(packPayloads[2].attempt_id);
		expect(packPayloads[3].request_id).toBe(packPayloads[2].request_id);
		expect(changedOutput.system).toEqual(firstOutput.system);
		expect(exactRetryOutput.system).toEqual(changedOutput.system);
		expect(
			ledgerPayloads
				.filter((payload) => payload.action === "delivery")
				.map((payload) => payload.attempt_id),
		).toEqual([packPayloads[0].attempt_id, packPayloads[2].attempt_id, packPayloads[2].attempt_id]);
	});

	test("keeps unchanged restart retries idempotent before repairing changed artifacts", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-plugin-restart-conflict-"));
		tmpDirs.push(tmpDir);
		const dbPath = join(tmpDir, "mem.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		const sessionId = insertSession(db, { cwd: tmpDir, project: "greenroom" });
		db.close();
		const store = new MemoryStore(dbPath);
		const firstMemoryId = store.remember(
			sessionId,
			"feature",
			"Restart conflict first",
			"restart conflict evidence first",
			0.9,
		);
		process.env.CODEMEM_DB = dbPath;
		const packPayloads = [];
		const deliveryPayloads = [];

		spawnMock.mockImplementation((_command, args) => {
			const proc = new EventEmitter();
			proc.stdout = new EventEmitter();
			proc.stderr = new EventEmitter();
			let stdinText = "";
			proc.stdin = {
				write: vi.fn((value) => {
					stdinText += String(value);
				}),
				end: vi.fn(),
			};
			queueMicrotask(() => {
				try {
					const payload = parseInternalLedgerPayload(stdinText);
					if (Array.isArray(args) && args.includes("pack")) {
						packPayloads.push(payload);
						const context = args[args.indexOf("pack") + 1];
						const artifacts = buildMemoryPackWithTrace(store, context, 10);
						const ledgerOutcome = handleInstrumentedPackLedger(
							store.db,
							payload,
							context,
							undefined,
							artifacts,
						);
						proc.stdout.emit(
							"data",
							JSON.stringify({
								...artifacts.response,
								...(ledgerOutcome.ok ? {} : { ledger_outcome: ledgerOutcome }),
							}),
						);
					} else {
						deliveryPayloads.push(payload);
						handlePromptPackLedger(store.db, payload);
					}
					proc.emit("exit", 0);
				} catch (error) {
					proc.stderr.emit("data", error instanceof Error ? error.message : String(error));
					proc.emit("exit", 1);
				}
			});
			return proc;
		});

		const buildPlugin = async () => {
			vi.resetModules();
			const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
			return OpencodeMemPlugin({
				project: { name: "greenroom" },
				client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
				directory: tmpDir,
				worktree: tmpDir,
			});
		};
		const messageOutput = () => ({
			messages: [
				{
					info: { id: "user-restart", sessionID: "sess-restart", role: "user" },
					parts: [{ type: "text", text: "restart conflict", messageID: "user-restart" }],
				},
			],
		});

		const firstHooks = await buildPlugin();
		const firstOutput = messageOutput();
		await firstHooks["experimental.chat.messages.transform"]({}, firstOutput);
		vi.advanceTimersByTime(100);
		const unchangedRestartHooks = await buildPlugin();
		const unchangedRestartOutput = messageOutput();
		await unchangedRestartHooks["experimental.chat.messages.transform"](
			{},
			unchangedRestartOutput,
		);

		expect(packPayloads).toHaveLength(2);
		expect(packPayloads[1].attempt_id).toBe(packPayloads[0].attempt_id);
		expect(packPayloads[1].request_id).toBe(packPayloads[0].request_id);
		expect(packPayloads[1].started_at).not.toBe(packPayloads[0].started_at);
		expect(store.db.prepare("SELECT COUNT(*) AS count FROM retrieval_attempts").get()).toEqual({
			count: 1,
		});
		expect(unchangedRestartOutput.messages[0].parts.at(-1).text).toContain(
			"Restart conflict first",
		);

		const secondMemoryId = store.remember(
			sessionId,
			"decision",
			"Restart conflict second",
			"restart conflict evidence second",
			0.95,
		);
		const changedRestartHooks = await buildPlugin();
		const changedRestartOutput = messageOutput();
		await changedRestartHooks["experimental.chat.messages.transform"]({}, changedRestartOutput);

		expect(packPayloads).toHaveLength(4);
		expect(packPayloads[1].attempt_id).toBe(packPayloads[0].attempt_id);
		expect(packPayloads[2].attempt_id).toBe(packPayloads[0].attempt_id);
		expect(packPayloads[3].attempt_id).not.toBe(packPayloads[0].attempt_id);
		expect(
			deliveryPayloads
				.filter((payload) => payload.action === "delivery")
				.map((payload) => payload.attempt_id),
		).toEqual([
			packPayloads[0].attempt_id,
			packPayloads[0].attempt_id,
			packPayloads[3].attempt_id,
		]);
		expect(changedRestartOutput.messages[0].parts.at(-1).text).toContain(
			"Restart conflict second",
		);
		expect(getRetrievalAttempt(store.db, packPayloads[0].attempt_id)).toMatchObject({
			deliveryStatus: "handed_off",
			selectedCount: 1,
		});
		expect(getRetrievalAttempt(store.db, packPayloads[3].attempt_id)).toMatchObject({
			deliveryStatus: "handed_off",
			selectedCount: 2,
		});
		expect(
			getRetrievalAttempt(store.db, packPayloads[3].attempt_id)?.exposures.map((row) => row.memoryId),
		).toEqual(expect.arrayContaining([firstMemoryId, secondMemoryId]));
		store.close();
	});

	test.each([
		[
			"timeout",
			{ stderr: "repair timed out", exitCode: null },
			"Restart conflict fallback",
			"pack_command_failed",
			false,
		],
		[
			"nonzero transport failure",
			{ stderr: "repair transport failed", exitCode: 7 },
			"Restart conflict fallback",
			"pack_command_failed",
			false,
		],
		[
			"malformed success",
			{ stdout: "not-json", exitCode: 0 },
			"Restart conflict fallback",
			"pack_identity_repair_failed",
			false,
		],
		[
			"repeated conflict",
			{
				stdout: JSON.stringify({
					pack_text: "## Summary\n[2] (decision) Conflicting repair",
					metrics: { total_items: 1, pack_tokens: 12 },
					ledger_outcome: {
						ok: false,
						errorCode: "retrieval_ledger_write_failed",
						reason: "idempotency_conflict",
					},
				}),
			},
			"Restart conflict fallback",
			null,
			false,
		],
		[
			"successful replacement",
			{
				stdout: JSON.stringify({
					pack_text: "## Summary\n[2] (decision) Fresh replacement",
					metrics: { total_items: 1, pack_tokens: 12 },
				}),
			},
			"Fresh replacement",
			null,
			true,
		],
		[
			"successful zero results",
			{
				stdout: JSON.stringify({
					pack_text: "## Summary",
					metrics: { total_items: 0, pack_tokens: 0 },
				}),
			},
			null,
			null,
			false,
		],
	])(
		"handles restarted-plugin conflict repair with %s",
		async (_label, repairResult, expectedText, expectedFailureCode, expectsFreshDelivery) => {
			const packPayloads = [];
			const ledgerPayloads = [];
			let packCalls = 0;
			spawnMock.mockImplementation((_command, args) => {
				if (Array.isArray(args) && args.includes("pack")) {
					packCalls += 1;
					const response = packCalls === 1
						? {
								stdout: JSON.stringify({
									pack_text: "## Summary\n[1] (feature) Restart conflict fallback",
									metrics: { total_items: 1, pack_tokens: 10 },
									ledger_outcome: {
										ok: false,
										errorCode: "retrieval_ledger_write_failed",
										reason: "idempotency_conflict",
									},
								}),
							}
						: repairResult;
					const proc = makeProcess(response);
					proc.stdin.write = vi.fn((value) => packPayloads.push(JSON.parse(String(value))));
					return proc;
				}
				const proc = makeProcess({ stdout: "" });
				proc.stdin.write = vi.fn((value) => ledgerPayloads.push(JSON.parse(String(value))));
				return proc;
			});

			const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
			const hooks = await OpencodeMemPlugin({
				project: { name: "greenroom" },
				client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
				directory: "/tmp/greenroom",
				worktree: "/tmp/greenroom",
			});
			const transform = hooks["experimental.chat.messages.transform"];
			const messageOutput = () => ({
				messages: [
					{
						info: { id: "restart-fallback", sessionID: "sess-restart-fallback", role: "user" },
						parts: [{ type: "text", text: "restart fallback", messageID: "restart-fallback" }],
					},
				],
			});
			const output = messageOutput();

			await transform({}, output);

			expect(packPayloads).toHaveLength(2);
			expect(packPayloads[1].attempt_id).not.toBe(packPayloads[0].attempt_id);
			expect(packPayloads[1].request_id).not.toBe(packPayloads[0].request_id);
			const injectedText = output.messages[0].parts.find(
				(part) => String(part.id || "").startsWith("codemem-context-"),
			)?.text;
			if (expectedText) {
				expect(injectedText).toContain(expectedText);
			} else {
				expect(injectedText).toBeUndefined();
			}
			const deliveries = ledgerPayloads.filter((payload) => payload.action === "delivery");
			if (expectsFreshDelivery) {
				expect(deliveries).toEqual([
					{
						action: "delivery",
						attempt_id: packPayloads[1].attempt_id,
						delivery_status: "handed_off",
					},
				]);
			} else {
				expect(deliveries).toEqual([]);
			}
			if (expectedFailureCode) {
				expect(ledgerPayloads).toContainEqual(
					expect.objectContaining({
						action: "record",
						attempt_id: packPayloads[1].attempt_id,
						retrieval_status: "failed",
						failure_code: expectedFailureCode,
					}),
				);
			}

			if (expectedText === "Restart conflict fallback") {
				const replayOutput = messageOutput();
				await transform({}, replayOutput);
				expect(packPayloads).toHaveLength(2);
				expect(
					replayOutput.messages[0].parts.find(
						(part) => String(part.id || "").startsWith("codemem-context-"),
					)?.text,
				).toContain(expectedText);
				expect(ledgerPayloads.filter((payload) => payload.action === "delivery")).toEqual([]);
			}
		},
	);

	test.each([
		[
			"timeout",
			{ stderr: "timeout", exitCode: null },
			"command_failed",
			"pack_command_failed",
		],
		[
			"nonzero exit",
			{ stderr: "repair transport failed", exitCode: 7 },
			"command_failed",
			"pack_command_failed",
		],
		[
			"malformed success",
			{ stdout: "not-json", exitCode: 0 },
			"malformed_success",
			"pack_identity_repair_failed",
		],
	])(
		"injects the first usable changed artifact when fresh-identity repair returns %s",
		async (_label, repairResult, expectedReason, expectedFailureCode) => {
			process.env.CODEMEM_INJECT_SURFACE = "system";
			const packPayloads = [];
			const ledgerPayloads = [];
			const appLog = vi.fn().mockResolvedValue(undefined);
			let packCalls = 0;
			spawnMock.mockImplementation((_command, args) => {
				if (Array.isArray(args) && args.includes("pack")) {
					packCalls += 1;
					const response = packCalls === 1
						? {
								stdout: JSON.stringify({
									pack_text: "## Summary\n[1] (feature) Original artifact",
									metrics: { total_items: 1, pack_tokens: 10 },
									ledger_artifact_fingerprint: "1".repeat(64),
								}),
							}
						: packCalls === 2
							? {
									stdout: JSON.stringify({
										pack_text: "## Summary\n[2] (decision) Changed artifact fallback",
										metrics: { total_items: 1, pack_tokens: 11 },
										ledger_artifact_fingerprint: "2".repeat(64),
									}),
								}
							: repairResult;
					const proc = makeProcess(response);
					proc.stdin.write = vi.fn((value) => packPayloads.push(JSON.parse(String(value))));
					return proc;
				}
				const proc = makeProcess({ stdout: "" });
				proc.stdin.write = vi.fn((value) => ledgerPayloads.push(JSON.parse(String(value))));
				return proc;
			});

			const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
			const hooks = await OpencodeMemPlugin({
				project: { name: "greenroom" },
				client: { app: { log: appLog }, tui: {} },
				directory: "/tmp/greenroom",
				worktree: "/tmp/greenroom",
			});
			const transform = hooks["experimental.chat.system.transform"];
			const input = { sessionID: `sess-repair-${expectedReason}`, model: {} };
			const firstOutput = { system: [] };
			const changedOutput = { system: [] };

			await transform(input, firstOutput);
			await transform(input, changedOutput);

			expect(packPayloads).toHaveLength(3);
			expect(packPayloads[1].attempt_id).toBe(packPayloads[0].attempt_id);
			expect(packPayloads[2].attempt_id).not.toBe(packPayloads[0].attempt_id);
			expect(packPayloads[2].request_id).not.toBe(packPayloads[0].request_id);
			expect(firstOutput.system.join("\n")).toContain("Original artifact");
			expect(changedOutput.system).toEqual([
				"[codemem context]\n## Summary\n[2] (decision) Changed artifact fallback",
			]);
			expect(
				ledgerPayloads.filter((payload) => payload.action === "delivery"),
			).toEqual([
				{
					action: "delivery",
					attempt_id: packPayloads[0].attempt_id,
					delivery_status: "handed_off",
				},
			]);
			expect(ledgerPayloads).toContainEqual(
				expect.objectContaining({
					action: "record",
					attempt_id: packPayloads[2].attempt_id,
					request_id: packPayloads[2].request_id,
					retrieval_status: "failed",
					failure_code: expectedFailureCode,
				}),
			);
			expect(appLog).toHaveBeenCalledWith(
				expect.objectContaining({
					level: "warn",
					message: "codemem prompt-pack identity repair failed",
					extra: expect.objectContaining({ reason: expectedReason }),
				}),
			);
		},
	);

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
		expect(spawnMock).toHaveBeenCalledTimes(1);

		await hooks["experimental.chat.system.transform"](
			{ sessionID: "sess-legacy-compact", model: {} },
			output,
		);
		expect(output.system).toEqual([
			"base system prompt",
			"[codemem context]\n## Summary\n[1] (feature) Legacy context after compaction",
		]);
		expect(spawnMock).toHaveBeenCalledTimes(3);
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

	test("passes only normalized repository paths to pack retrieval and ledger recording", async () => {
		const packArgs = [];
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				packArgs.push(args);
				return makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Normalized working set",
						metrics: { total_items: 1, pack_tokens: 12 },
					}),
				});
			}
			return makeProcess({ stdout: "" });
		});

		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		for (const filePath of [
			"/tmp/greenroom/src/inside.ts",
			"src/relative.ts",
			"/tmp/greenroom-private/prefix-secret.ts",
			"/tmp/outside-secret.ts",
			"../traversal-secret.ts",
			"x".repeat(401),
		]) {
			await hooks["tool.execute.after"](
				{ tool: "write", args: { filePath }, sessionID: "sess-paths" },
				{},
			);
		}
		const output = {
			messages: [
				{
					info: { id: "user-paths", sessionID: "sess-paths", role: "user" },
					parts: [{ type: "text", text: "normalize paths", messageID: "user-paths" }],
				},
			],
		};

		await hooks["experimental.chat.messages.transform"]({}, output);

		const command = packArgs[0];
		const workingSetFiles = command.flatMap((arg, index) =>
			arg === "--working-set-file" ? [command[index + 1]] : [],
		);
		expect(workingSetFiles).toEqual(["src/inside.ts", "src/relative.ts"]);
		expect(command.join(" ")).not.toContain("secret");
		expect(command.join(" ")).not.toContain("/tmp/greenroom");
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

	test.each(["::1", "[::1]"])("uses bracketed IPv6 viewer URLs for %s", async (viewerHost) => {
		// Arrange
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "0";
		process.env.CODEMEM_RAW_EVENTS = "0";
		process.env.CODEMEM_VIEWER_HOST = viewerHost;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
			String(url).endsWith("/api/prompt-pack-profile")
				? viewerProfileResponse()
				: String(url).endsWith("/api/pack")
				? jsonResponse(200, packResponse())
				: jsonResponse(200, { ok: true }),
		);
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const output = messageOutput();

		// Act
		await hooks["experimental.chat.messages.transform"]({}, output);
		await vi.waitFor(() => expect(fetchPostCalls(fetchMock)).toHaveLength(2));

		// Assert
		expect(String(fetchMock.mock.calls[0][0])).toBe(
			"http://[::1]:38888/api/prompt-pack-profile",
		);
		expect(fetchPostCalls(fetchMock).map(([url, options]) => [String(url), options.method])).toEqual([
			["http://[::1]:38888/api/pack", "POST"],
			["http://[::1]:38888/api/prompt-pack-ledger", "POST"],
		]);
		expect(fetchBody(fetchMock, 1)).toMatchObject({
			action: "delivery",
			attempt_id: fetchBody(fetchMock, 0).attempt.attempt_id,
			delivery_status: "handed_off",
		});
		const defaultDbPath = join(homedir(), ".codemem", "mem.sqlite");
		expect(fetchBody(fetchMock, 0).db_path).toBe(defaultDbPath);
		expect(fetchBody(fetchMock, 1).db_path).toBe(defaultDbPath);
		expect(output.messages[0].parts.at(-1).text).toBe(
			"[codemem context]\n## Summary\n[1] (feature) Viewer-backed context",
		);
		expect(spawnMock.mock.calls.filter(isPackOrLedgerSpawn)).toEqual([]);
	});

	test("records a skipped injection through the healthy viewer without spawning ledger CLI", async () => {
		// Arrange
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "0";
		process.env.CODEMEM_RAW_EVENTS = "0";
		process.env.CODEMEM_INJECT_CONTEXT = "0";
		process.env.CODEMEM_DB = "~/greenroom.sqlite";
		process.env.CODEMEM_PACK_COMPRESSION = "off";
		process.env.CODEMEM_EMBEDDING_DISABLED = "true";
		process.env.CODEMEM_EMBEDDING_MODEL = "test-embedding-model";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
			String(url).endsWith("/api/prompt-pack-profile")
				? viewerProfileResponse()
				: jsonResponse(200, { ok: true }),
		);
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const output = messageOutput({ messageId: "user-skipped", sessionID: "sess-skipped" });

		// Act
		await hooks["experimental.chat.messages.transform"]({}, output);
		await vi.waitFor(() => expect(fetchPostCalls(fetchMock)).toHaveLength(1));

		// Assert
		expect(fetchPostCalls(fetchMock)[0][0]).toBe(
			"http://127.0.0.1:38888/api/prompt-pack-ledger",
		);
			expect(fetchBody(fetchMock, 0)).toMatchObject({
				action: "record",
				db_path: join(process.env.HOME?.trim() || homedir(), "greenroom.sqlite"),
				identity_target: {
					pack_compression: "off",
					embedding_disabled: true,
					embedding_model: "test-embedding-model",
				},
			retrieval_status: "skipped",
			failure_code: "injection_disabled",
		});
		expect(output.messages[0].parts).toHaveLength(1);
		expect(spawnMock.mock.calls.filter(isPackOrLedgerSpawn)).toEqual([]);
	});

	test("records cache reuse and delivery through the healthy viewer without spawning ledger CLI", async () => {
		// Arrange
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "0";
		process.env.CODEMEM_RAW_EVENTS = "0";
		process.env.CODEMEM_DB = "relative.sqlite";
		process.env.CODEMEM_CONFIG = "config/codemem.json";
		process.env.CODEMEM_RUNTIME_ROOT = "runtime";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
			String(url).endsWith("/api/prompt-pack-profile")
				? viewerProfileResponse()
				: String(url).endsWith("/api/pack")
				? jsonResponse(200, packResponse("## Summary\n[1] (decision) Cache-stable bytes"))
				: jsonResponse(200, { ok: true }),
		);
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const firstOutput = messageOutput({ messageId: "user-cache", sessionID: "sess-cache" });
		await hooks["experimental.chat.messages.transform"]({}, firstOutput);
		await vi.waitFor(() =>
			expect(fetchPostCalls(fetchMock).some(([url]) => String(url).endsWith("/api/pack"))).toBe(true),
		);
		const packCall = fetchPostCalls(fetchMock).find(([url]) => String(url).endsWith("/api/pack"));
		const originalAttemptId = JSON.parse(packCall[1].body).attempt.attempt_id;
		const cachedOutput = messageOutput({ messageId: "user-cache", sessionID: "sess-cache" });

		// Act
		await hooks["experimental.chat.messages.transform"]({}, cachedOutput);
		await vi.waitFor(() => {
			const bodies = fetchPostCalls(fetchMock)
				.filter(([url]) => String(url).endsWith("/api/prompt-pack-ledger"))
				.map(([, options]) => JSON.parse(options.body));
			const reuse = bodies.find((body) => body.action === "cache_reuse");
			expect(reuse?.original_attempt_id).toBe(originalAttemptId);
			expect(bodies.some((body) =>
				body.action === "delivery" && body.attempt_id === reuse?.attempt_id)).toBe(true);
		});

		// Assert
		const ledgerBodies = fetchPostCalls(fetchMock)
			.filter(([url]) => String(url).endsWith("/api/prompt-pack-ledger"))
			.map(([, options]) => JSON.parse(options.body));
		const cacheReuse = ledgerBodies.find((body) => body.action === "cache_reuse");
		const cacheDelivery = ledgerBodies.find((body) =>
			body.action === "delivery" && body.attempt_id === cacheReuse.attempt_id);
		expect(cacheReuse).toMatchObject({
			action: "cache_reuse",
			original_attempt_id: originalAttemptId,
		});
		expect(cacheReuse.attempt_id).not.toBe(originalAttemptId);
		expect(cacheDelivery).toEqual({
			action: "delivery",
			attempt_id: cacheReuse.attempt_id,
			db_path: "/tmp/greenroom/relative.sqlite",
			delivery_status: "handed_off",
			identity_target: {
				device_id: null,
				actor_id_present: false,
				actor_id: null,
				config_path: "/tmp/greenroom/config/codemem.json",
				runtime_root: "/tmp/greenroom/runtime",
				workspace_id: null,
				home_dir: resolve(process.env.HOME?.trim() || homedir()),
				pack_compression: null,
				embedding_disabled: false,
				embedding_model: "Xenova/bge-small-en-v1.5",
			},
		});
		expect(cachedOutput.messages[0].parts.at(-1).text).toBe(
			"[codemem context]\n## Summary\n[1] (decision) Cache-stable bytes",
		);
		expect(spawnMock.mock.calls.filter(isPackOrLedgerSpawn)).toEqual([]);
	});

	test("repairs a viewer pack idempotency conflict over HTTP with fresh identity and no CLI", async () => {
		// Arrange
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "0";
		process.env.CODEMEM_RAW_EVENTS = "0";
		let packCalls = 0;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (String(url).endsWith("/api/prompt-pack-profile")) return viewerProfileResponse();
			if (String(url).endsWith("/api/pack")) {
				packCalls += 1;
				return jsonResponse(200, packCalls === 1
					? {
						...packResponse("## Summary\n[1] (feature) Stale conflict bytes"),
						ledger_outcome: {
							ok: false,
							errorCode: "retrieval_ledger_write_failed",
							reason: "idempotency_conflict",
						},
					}
					: packResponse("## Summary\n[2] (decision) Fresh viewer identity"));
			}
			return jsonResponse(200, { ok: true });
		});
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const output = messageOutput({ messageId: "user-conflict", sessionID: "sess-conflict" });

		// Act
		await hooks["experimental.chat.messages.transform"]({}, output);
		await vi.waitFor(() => {
			const packBodies = fetchPostCalls(fetchMock)
				.filter(([url]) => String(url).endsWith("/api/pack"))
				.map(([, options]) => JSON.parse(options.body))
				.filter((body) => body.attempt?.stream_id === "sess-conflict");
			expect(packBodies).toHaveLength(2);
			const deliveries = fetchPostCalls(fetchMock)
				.filter(([url]) => String(url).endsWith("/api/prompt-pack-ledger"))
				.map(([, options]) => JSON.parse(options.body));
			expect(deliveries.some((body) =>
				body.action === "delivery" && body.attempt_id === packBodies[1].attempt.attempt_id)).toBe(true);
		});

		// Assert
		const conflictPackBodies = fetchPostCalls(fetchMock)
			.filter(([url]) => String(url).endsWith("/api/pack"))
			.map(([, options]) => JSON.parse(options.body))
			.filter((body) => body.attempt?.stream_id === "sess-conflict");
		const firstAttempt = conflictPackBodies[0].attempt;
		const repairedAttempt = conflictPackBodies[1].attempt;
		expect(firstAttempt.attempt_id).not.toBe(repairedAttempt.attempt_id);
		expect(firstAttempt.request_id).not.toBe(repairedAttempt.request_id);
		const repairedDelivery = fetchPostCalls(fetchMock)
			.filter(([url]) => String(url).endsWith("/api/prompt-pack-ledger"))
			.map(([, options]) => JSON.parse(options.body))
			.find((body) => body.action === "delivery" && body.attempt_id === repairedAttempt.attempt_id);
		expect(repairedDelivery).toMatchObject({
			action: "delivery",
			attempt_id: repairedAttempt.attempt_id,
		});
		expect(output.messages[0].parts.at(-1).text).toContain("Fresh viewer identity");
		expect(spawnMock.mock.calls.filter(isPackOrLedgerSpawn)).toEqual([]);
	});

	test.each([
		["foreign service", () => jsonResponse(200, { service: "not-codemem" })],
		["untrusted invalid-request response", () => jsonResponse(400, {
			error: { code: "invalid_request", message: "not your viewer" },
		})],
		["stale viewer identity", () => jsonResponse(409, {
			error: { code: "viewer_identity_mismatch", message: "viewer identity does not match request" },
		})],
		["redirect", () => new Response(null, {
			status: 307,
			headers: { Location: "http://127.0.0.1:39999/capture" },
		})],
	])("falls back before sending prompt data when the viewer profile handshake hits a %s", async (
		_label,
		profileResult,
	) => {
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "0";
		process.env.CODEMEM_RAW_EVENTS = "0";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (String(url).endsWith("/api/prompt-pack-profile")) return profileResult();
			throw new Error("prompt payload must not be sent before profile validation");
		});
		spawnMock.mockImplementation((_command, args) =>
			Array.isArray(args) && args.includes("pack")
				? makeProcess({ stdout: JSON.stringify(packResponse("## Summary\n[9] Safe CLI fallback")) })
				: makeProcess({ stdout: "" }),
		);
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const output = messageOutput({ messageId: "user-handshake", sessionID: "sess-handshake" });

		await hooks["experimental.chat.messages.transform"]({}, output);
		await vi.waitFor(() =>
			expect(spawnMock.mock.calls.filter(isPackOrLedgerSpawn)).toHaveLength(2),
		);

		expect(fetchPostCalls(fetchMock)).toEqual([]);
		expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "manual" });
		expect(output.messages[0].parts.at(-1).text).toContain("Safe CLI fallback");
	});

	test.each([
		["connection failure", () => Promise.reject(new Error("ECONNREFUSED"))],
		["timeout", () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))],
		["404", () => Promise.resolve(jsonResponse(404, { error: "not_found" }))],
		["405", () => Promise.resolve(jsonResponse(405, { error: "method_not_allowed" }))],
		["5xx", () => Promise.resolve(jsonResponse(503, { error: "unavailable" }))],
		["database mismatch", () => Promise.resolve(jsonResponse(409, {
			error: { code: "viewer_db_mismatch", message: "viewer database does not match request" },
		}))],
		["identity mismatch", () => Promise.resolve(jsonResponse(409, {
			error: { code: "viewer_identity_mismatch", message: "viewer identity does not match request" },
		}))],
		["contract mismatch", () => Promise.resolve(jsonResponse(409, {
			error: { code: "viewer_contract_unsupported", message: "viewer request contract is incompatible" },
		}))],
		["unrecognized 400", () => Promise.resolve(jsonResponse(400, { error: "bad_request" }))],
		["unrecognized 401", () => Promise.resolve(jsonResponse(401, { error: "unauthorized" }))],
		["malformed 2xx", () => Promise.resolve(jsonResponse(200, { pack_text: 42 }))],
	])("falls back to pack and ledger CLI after viewer %s while preserving output and ledger handoff", async (
		_label,
		viewerResult,
	) => {
		// Arrange
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "0";
		process.env.CODEMEM_RAW_EVENTS = "0";
		process.env.CODEMEM_DB = "/tmp/greenroom.sqlite";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((url) =>
			String(url).endsWith("/api/prompt-pack-profile")
				? Promise.resolve(viewerProfileResponse())
				: viewerResult(),
		);
		const packPayloads = [];
		const ledgerPayloads = [];
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				const proc = makeProcess({
					stdout: JSON.stringify(packResponse("## Summary\n[7] (feature) CLI fallback bytes")),
				});
				proc.stdin.write = vi.fn((value) => packPayloads.push(JSON.parse(String(value))));
				return proc;
			}
			const proc = makeProcess({ stdout: "" });
			if (Array.isArray(args) && args.includes("prompt-pack-ledger")) {
				proc.stdin.write = vi.fn((value) => ledgerPayloads.push(JSON.parse(String(value))));
			}
			return proc;
		});
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const output = messageOutput({ messageId: "user-fallback", sessionID: "sess-fallback" });

		// Act
		await hooks["experimental.chat.messages.transform"]({}, output);
		await vi.waitFor(() => expect(ledgerPayloads).toHaveLength(1));

		// Assert
		expect(fetchPostCalls(fetchMock)).toHaveLength(1);
		expect(packPayloads).toHaveLength(1);
		expect(ledgerPayloads).toEqual([
			{
				action: "delivery",
				attempt_id: packPayloads[0].attempt_id,
				delivery_status: "handed_off",
			},
		]);
		expect(output.messages[0].parts.at(-1).text).toBe(
			"[codemem context]\n## Summary\n[7] (feature) CLI fallback bytes",
		);
		expect(spawnMock.mock.calls.filter(isPackOrLedgerSpawn)).toHaveLength(2);
	});

	test.each([
		["connection failure", () => Promise.reject(new Error("ECONNREFUSED"))],
		["timeout", () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))],
		["404", () => Promise.resolve(jsonResponse(404, { error: "not_found" }))],
		["405", () => Promise.resolve(jsonResponse(405, { error: "method_not_allowed" }))],
		["unrecognized 401", () => Promise.resolve(jsonResponse(401, { error: "unauthorized" }))],
		["identity mismatch", () => Promise.resolve(jsonResponse(409, {
			error: { code: "viewer_identity_mismatch", message: "viewer identity does not match request" },
		}))],
		["5xx", () => Promise.resolve(jsonResponse(503, { error: "unavailable" }))],
		["malformed 2xx", () => Promise.resolve(jsonResponse(200, { ok: "yes" }))],
	])("falls back only the ledger transition after viewer ledger %s", async (
		_label,
		viewerLedgerResult,
	) => {
		// Arrange
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "0";
		process.env.CODEMEM_RAW_EVENTS = "0";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((url) =>
			String(url).endsWith("/api/prompt-pack-profile")
				? Promise.resolve(viewerProfileResponse())
				: String(url).endsWith("/api/pack")
				? Promise.resolve(jsonResponse(200, packResponse()))
				: viewerLedgerResult(),
		);
		const ledgerPayloads = [];
		spawnMock.mockImplementation((_command, args) => {
			const proc = makeProcess({ stdout: "" });
			if (Array.isArray(args) && args.includes("prompt-pack-ledger")) {
				proc.stdin.write = vi.fn((value) => ledgerPayloads.push(JSON.parse(String(value))));
			}
			return proc;
		});
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const output = messageOutput({ messageId: "user-ledger-fallback", sessionID: "sess-ledger-fallback" });

		// Act
		await hooks["experimental.chat.messages.transform"]({}, output);
		await vi.waitFor(() => expect(ledgerPayloads).toHaveLength(1));

		// Assert
		const viewerLedgerPayloads = fetchPostCalls(fetchMock)
			.filter(([url]) => String(url).endsWith("/api/prompt-pack-ledger"))
			.map(([, options]) => JSON.parse(options.body));
		const deliveryPayload = viewerLedgerPayloads.find((body) => body.action === "delivery");
		expect(deliveryPayload).toMatchObject({
			action: "delivery",
			delivery_status: "handed_off",
		});
		const {
			db_path: _viewerDbPath,
			identity_target: _viewerIdentityTarget,
			...cliLedgerPayload
		} = deliveryPayload;
		expect(ledgerPayloads).toEqual([cliLedgerPayload]);
		expect(output.messages[0].parts.at(-1).text).toContain("Viewer-backed context");
		expect(spawnMock.mock.calls.filter(isPackOrLedgerSpawn)).toHaveLength(1);
		expect(spawnMock.mock.calls.filter(isPackOrLedgerSpawn)[0][1]).toContain(
			"prompt-pack-ledger",
		);
	});

	test("treats viewer 400 responses as terminal without spawning pack or ledger CLI", async () => {
		// Arrange
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "0";
		process.env.CODEMEM_RAW_EVENTS = "0";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (String(url).endsWith("/api/prompt-pack-profile")) return viewerProfileResponse();
			return String(url).endsWith("/api/pack")
				? jsonResponse(400, { error: { code: "invalid_request", message: "context is required" } })
				: jsonResponse(400, {
						error: { code: "invalid_request", message: "attempt_id is required" },
					});
		});
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const output = messageOutput({ messageId: "user-invalid", sessionID: "sess-invalid" });

		// Act
		await hooks["experimental.chat.messages.transform"]({}, output);
		await vi.waitFor(() => expect(fetchPostCalls(fetchMock)).toHaveLength(2));

		// Assert
		expect(fetchPostCalls(fetchMock).map(([url]) => String(url))).toEqual([
			"http://127.0.0.1:38888/api/pack",
			"http://127.0.0.1:38888/api/prompt-pack-ledger",
		]);
		expect(fetchBody(fetchMock, 1)).toMatchObject({
			action: "record",
			retrieval_status: "failed",
			failure_code: "pack_command_failed",
		});
		expect(output.messages[0].parts).toHaveLength(1);
		expect(spawnMock.mock.calls.filter(isPackOrLedgerSpawn)).toEqual([]);
	});

	test.each([
		["write 404", 404, "retrieval_ledger_write_failed", "attempt_not_found"],
		["delivery 503", 503, "retrieval_ledger_delivery_write_failed", "storage_unavailable"],
	])("treats a structured ledger %s as terminal without arming pack backoff", async (
		_label,
		status,
		errorCode,
		reason,
	) => {
		// Arrange
		process.env.CODEMEM_VIEWER = "1";
		process.env.CODEMEM_VIEWER_AUTO = "0";
		process.env.CODEMEM_RAW_EVENTS = "0";
		let postCount = 0;
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (String(url).endsWith("/api/prompt-pack-profile")) return viewerProfileResponse();
			postCount += 1;
			if (postCount === 1) return jsonResponse(200, packResponse("## Summary\n[1] First pack"));
			if (postCount === 2) return jsonResponse(status, { ok: false, errorCode, reason });
			if (postCount === 3) return jsonResponse(200, packResponse("## Summary\n[2] Next pack"));
			return jsonResponse(200, { ok: true });
		});
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: { app: { log: vi.fn().mockResolvedValue(undefined) }, tui: {} },
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});

		// Act
		await hooks["experimental.chat.messages.transform"]({}, messageOutput({
			messageId: "user-ledger-terminal",
			sessionID: "sess-ledger-terminal",
		}));
		await vi.waitFor(() => expect(fetchPostCalls(fetchMock)).toHaveLength(2));
		await hooks["experimental.chat.messages.transform"]({}, messageOutput({
			messageId: "user-after-ledger-terminal",
			sessionID: "sess-ledger-terminal",
		}));
		await vi.waitFor(() => expect(fetchPostCalls(fetchMock)).toHaveLength(4));

		// Assert
		expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/pack"))).toHaveLength(2);
		expect(spawnMock.mock.calls.filter(isPackOrLedgerSpawn)).toEqual([]);
	});

	test("retries one SQLite-locked raw-event fallback with the identical envelope and marks it delivered", async () => {
		// Arrange
		process.env.CODEMEM_RAW_EVENTS = "1";
		process.env.CODEMEM_RAW_EVENTS_BACKOFF_MS = "1000";
		const enqueueBodies = [];
		let enqueueAttempt = 0;
		const appLog = vi.fn().mockResolvedValue(undefined);
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("viewer unavailable"));
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("enqueue-raw-event")) {
				enqueueAttempt += 1;
				const proc = makeProcess(
					enqueueAttempt === 1
						? {
								exitCode: 1,
								stdout: `${JSON.stringify({
									error: "enqueue_error",
									message: "database is locked",
								})}\n`,
							}
						: { exitCode: 0 },
				);
				proc.stdin.write = vi.fn((value) =>
					enqueueBodies.push(JSON.parse(String(value))),
				);
				return proc;
			}
			return makeProcess({ stdout: "" });
		});
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: {
				app: { log: appLog },
				tui: {},
			},
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});

		// Act
		await hooks["tool.execute.after"](
			{ tool: "read", args: { filePath: "src/raw-event.ts" }, sessionID: "sess-locked" },
			{},
		);
		const lockedBodies = () =>
			enqueueBodies.filter((body) => body.session_stream_id === "sess-locked");
		await vi.waitFor(() => expect(lockedBodies()).toHaveLength(2));
		await vi.waitFor(() =>
			expect(appLog).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "codemem stream unavailable; queued raw event via CLI fallback",
				}),
			),
		);
		await hooks.event({
			event: { type: "session.idle", properties: { sessionID: "sess-locked" } },
		});

		// Assert
		expect(lockedBodies()[0]).toEqual(lockedBodies()[1]);
		expect(lockedBodies()[0].event_id).toBeTruthy();
		expect(lockedBodies()).toHaveLength(2);
	});

	test("drops a SQLite-locked fallback after its one retry is exhausted", async () => {
		// Arrange
		process.env.CODEMEM_RAW_EVENTS = "1";
		process.env.CODEMEM_RAW_EVENTS_BACKOFF_MS = "1000";
		const sessionID = "sess-lock-exhausted";
		const enqueueBodies = [];
		const appLog = vi.fn().mockResolvedValue(undefined);
		const lockedResult = {
			exitCode: 1,
			stdout: `${JSON.stringify({ error: "enqueue_error", message: "database is locked" })}\n`,
		};
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("viewer unavailable"));
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("enqueue-raw-event")) {
				const proc = makeProcess(lockedResult);
				proc.stdin.write = vi.fn((value) =>
					enqueueBodies.push(JSON.parse(String(value))),
				);
				return proc;
			}
			return makeProcess({ stdout: "" });
		});
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: {
				app: { log: appLog },
				tui: {},
			},
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});

		// Act
		await hooks["tool.execute.after"](
			{ tool: "read", args: { filePath: "src/raw-event.ts" }, sessionID },
			{},
		);
		const exhaustedBodies = () =>
			enqueueBodies.filter((body) => body.session_stream_id === sessionID);
		await vi.waitFor(() => expect(exhaustedBodies()).toHaveLength(2));
		await vi.waitFor(() =>
			expect(appLog).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "codemem stream unavailable; fallback enqueue failed",
				}),
			),
		);
		await hooks.event({
			event: { type: "session.idle", properties: { sessionID } },
		});

		// Assert
		expect(exhaustedBodies()[0]).toEqual(exhaustedBodies()[1]);
		expect(exhaustedBodies()).toHaveLength(2);
	});

	test("clears the fallback-failure notification latch after a successful backoff enqueue", async () => {
		// Arrange
		vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
		process.env.CODEMEM_RAW_EVENTS = "1";
		process.env.CODEMEM_RAW_EVENTS_BACKOFF_MS = "120000";
		const sessionID = "sess-latch-recovery";
		const enqueueBodies = [];
		const appLog = vi.fn().mockResolvedValue(undefined);
		const showToast = vi.fn().mockResolvedValue(undefined);
		const fallbackResults = [
			{
				exitCode: 1,
				stdout: `${JSON.stringify({
					error: "validation_error",
					message: "event_type required",
				})}\n`,
			},
			{
				exitCode: 1,
				stdout: `${JSON.stringify({
					error: "validation_error",
					message: "event_type required",
				})}\n`,
			},
			{ exitCode: 0 },
			{
				exitCode: 1,
				stdout: `${JSON.stringify({
					error: "validation_error",
					message: "event_type required",
				})}\n`,
			},
		];
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("viewer unavailable"));
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("enqueue-raw-event")) {
				const proc = new EventEmitter();
				proc.stdout = new EventEmitter();
				proc.stderr = new EventEmitter();
				let result = { exitCode: 0 };
				proc.stdin = {
					write: vi.fn((value) => {
						const body = JSON.parse(String(value));
						if (body.session_stream_id !== sessionID) return;
						enqueueBodies.push(body);
						result = fallbackResults[enqueueBodies.length - 1] ?? fallbackResults.at(-1);
					}),
					end: vi.fn(() => {
						queueMicrotask(() => {
							if (result.stdout) proc.stdout.emit("data", result.stdout);
							if (result.stderr) proc.stderr.emit("data", result.stderr);
							proc.emit("exit", result.exitCode);
						});
					}),
				};
				return proc;
			}
			return makeProcess({ stdout: "" });
		});
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: {
				app: { log: appLog },
				tui: { showToast },
			},
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});
		const emitToolEvent = async (tool, expectedEnqueueCount) => {
			await hooks["tool.execute.after"](
				{ tool, args: {}, sessionID },
				{},
			);
			await vi.waitFor(() => expect(enqueueBodies).toHaveLength(expectedEnqueueCount));
		};
		const failureNotifications = () =>
			appLog.mock.calls.filter(([entry]) =>
				[
					"codemem stream unavailable; fallback enqueue failed",
					"codemem fallback enqueue failed during stream backoff",
				].includes(entry?.message),
			);
		const failureToasts = () =>
			showToast.mock.calls.filter(([entry]) => entry?.body?.variant === "error");

		// Act and assert: the first failure notifies, while another pre-recovery failure does not.
		await emitToolEvent("read", 1);
		await vi.waitFor(() => expect(failureNotifications()).toHaveLength(1));
		await emitToolEvent("write", 2);
		expect(failureNotifications()).toHaveLength(1);
		expect(failureToasts()).toHaveLength(1);

		// Act and assert: success clears the latch, allowing one later rate-limited notification.
		await emitToolEvent("edit", 3);
		expect(failureNotifications()).toHaveLength(1);
		expect(failureToasts()).toHaveLength(1);
		vi.setSystemTime(new Date("2026-08-09T12:01:00.001Z"));
		await emitToolEvent("read", 4);
		await vi.waitFor(() => expect(failureNotifications()).toHaveLength(2));
		expect(failureToasts()).toHaveLength(2);
	});

	test.each([
		[
			"validation",
			{
				exitCode: 1,
				stdout: `${JSON.stringify({
					error: "validation_error",
					message: "session id required",
				})}\n`,
			},
		],
		[
			"unknown-command",
			{ exitCode: 1, stderr: "error: unknown command 'enqueue-raw-event'" },
		],
	])("does not retry a terminal %s raw-event fallback", async (_label, failureResult) => {
		// Arrange
		process.env.CODEMEM_RAW_EVENTS = "1";
		process.env.CODEMEM_RAW_EVENTS_BACKOFF_MS = "1000";
		const enqueueBodies = [];
		const sessionID = `sess-terminal-${_label}`;
		const appLog = vi.fn().mockResolvedValue(undefined);
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("viewer unavailable"));
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("enqueue-raw-event")) {
				const proc = makeProcess(failureResult);
				proc.stdin.write = vi.fn((value) =>
					enqueueBodies.push(JSON.parse(String(value))),
				);
				return proc;
			}
			return makeProcess({ stdout: "" });
		});
		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: {
				app: { log: appLog },
				tui: {},
			},
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});

		// Act
		await hooks["tool.execute.after"](
			{ tool: "read", args: { filePath: "src/raw-event.ts" }, sessionID },
			{},
		);
		const terminalBodies = () =>
			enqueueBodies.filter((body) => body.session_stream_id === sessionID);
		await vi.waitFor(() => expect(terminalBodies()).toHaveLength(1));
		await vi.waitFor(() =>
			expect(appLog).toHaveBeenCalledWith(
				expect.objectContaining({
					message: "codemem stream unavailable; fallback enqueue failed",
				}),
			),
		);
		await hooks.event({
			event: { type: "session.idle", properties: { sessionID } },
		});

		// Assert
		expect(terminalBodies()).toHaveLength(1);
	});
});
