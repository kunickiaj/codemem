import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	initTestSchema,
	MemoryStore,
	queryRetrievalAttempts,
	type RetrievalSurfaceRecordInput,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildClaudeFileContext,
	claudeHookFileContextCommand,
} from "./claude-hook-file-context.js";

type Row = {
	id: number;
	session_id: number;
	kind: string;
	title: string;
	subtitle: string | null;
	body_text: string;
	narrative: string | null;
	confidence: number;
	tags_text: string;
	created_at: string;
	updated_at: string;
	files_read: string | null;
	files_modified: string | null;
	concepts: string | null;
	metadata_json: string | null;
};

const baseRow = (overrides: Partial<Row>): Row => ({
	id: 1,
	session_id: 1,
	kind: "decision",
	title: "Untitled",
	subtitle: null,
	body_text: "",
	narrative: null,
	confidence: 0.5,
	tags_text: "",
	created_at: "2026-04-15T12:00:00Z",
	updated_at: "2026-04-15T12:00:00Z",
	files_read: null,
	files_modified: null,
	concepts: null,
	metadata_json: null,
	...overrides,
});

describe("claude-hook-file-context command", () => {
	let tmp: string;
	let pluginLogPath: string;
	let originalPluginLogPath: string | undefined;
	let originalProject: string | undefined;

	beforeEach(() => {
		originalPluginLogPath = process.env.CODEMEM_PLUGIN_LOG_PATH;
		originalProject = process.env.CODEMEM_PROJECT;
		tmp = mkdtempSync(join(tmpdir(), "codemem-cli-file-context-"));
		pluginLogPath = join(tmp, "plugin.log");
		process.env.CODEMEM_PLUGIN_LOG_PATH = pluginLogPath;
		// Pin the project so resolveHookProject doesn't fall through to a
		// directory-walk that climbs out of the tmp dir on CI machines.
		process.env.CODEMEM_PROJECT = "codemem";
	});

	afterEach(() => {
		if (originalPluginLogPath === undefined) delete process.env.CODEMEM_PLUGIN_LOG_PATH;
		else process.env.CODEMEM_PLUGIN_LOG_PATH = originalPluginLogPath;
		if (originalProject === undefined) delete process.env.CODEMEM_PROJECT;
		else process.env.CODEMEM_PROJECT = originalProject;
		rmSync(tmp, { recursive: true, force: true });
	});

	it("registers expected options and help text", () => {
		const longs = claudeHookFileContextCommand.options.map((option) => option.long);
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");
		const help = claudeHookFileContextCommand.helpInformation();
		expect(help).toContain("PreToolUse");
	});

	it("returns continue when payload has no file_path", async () => {
		const result = await buildClaudeFileContext(
			{ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} },
			{},
			{
				queryByFile: () => {
					throw new Error("should not be called");
				},
				resolveDb: () => "/tmp/test.sqlite",
				statFile: () => null,
			},
		);
		expect(result).toEqual({ continue: true });
	});

	it("returns continue when file is below the size gate", async () => {
		const file = join(tmp, "small.ts");
		writeFileSync(file, "x");

		const result = await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: file },
				cwd: tmp,
			},
			{},
			{
				queryByFile: () => {
					throw new Error("should not be called for small files");
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result).toEqual({ continue: true });
	});

	it("returns continue when file is missing from disk", async () => {
		const result = await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: join(tmp, "missing.ts") },
				cwd: tmp,
			},
			{},
			{
				queryByFile: () => {
					throw new Error("should not be called for missing files");
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result).toEqual({ continue: true });
	});

	it("annotates the timeline header when the file was modified after the newest observation", async () => {
		const file = join(tmp, "stale.ts");
		writeFileSync(file, "x".repeat(2000));
		const fileMtimeMs = Date.now();
		// 30 minutes — outside the 5-minute fresh tolerance, so the
		// staleness header should appear.
		const observationMs = fileMtimeMs - 30 * 60 * 1000;

		const result = await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: file },
				cwd: tmp,
			},
			{},
			{
				queryByFile: () => [
					baseRow({
						id: 7,
						kind: "decision",
						title: "Old decision about stale.ts",
						created_at: new Date(observationMs).toISOString(),
						files_modified: JSON.stringify(["stale.ts"]),
					}),
				],
				resolveDb: () => "/tmp/test.sqlite",
				statFile: () => ({ sizeBytes: 2000, mtimeMs: fileMtimeMs }),
			},
		);

		const ctx = result.hookSpecificOutput?.additionalContext ?? "";
		expect(ctx).toContain("Heads up");
		expect(ctx).toContain("Old decision about stale.ts");
		const log = readFileSync(pluginLogPath, "utf8");
		expect(log).toContain("file_context.ok");
		expect(log).toContain("stale=true");
	});

	it("does not annotate when the file mtime is within the fresh tolerance window", async () => {
		const file = join(tmp, "fresh.ts");
		writeFileSync(file, "x".repeat(2000));
		const fileMtimeMs = Date.now();
		// 1 minute drift — under the 5-minute tolerance.
		const observationMs = fileMtimeMs - 60 * 1000;

		const result = await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: file },
				cwd: tmp,
			},
			{},
			{
				queryByFile: () => [
					baseRow({
						id: 11,
						kind: "feature",
						title: "Recent feature touching fresh.ts",
						created_at: new Date(observationMs).toISOString(),
						files_modified: JSON.stringify(["fresh.ts"]),
					}),
				],
				resolveDb: () => "/tmp/test.sqlite",
				statFile: () => ({ sizeBytes: 2000, mtimeMs: fileMtimeMs }),
			},
		);

		const ctx = result.hookSpecificOutput?.additionalContext ?? "";
		expect(ctx).not.toContain("Heads up");
		const log = readFileSync(pluginLogPath, "utf8");
		expect(log).toContain("stale=false");
	});

	it("emits a PreToolUse additionalContext when observations exist and file is older", async () => {
		const file = join(tmp, "auth.ts");
		writeFileSync(file, "x".repeat(2000));
		const fileMtimeMs = Date.now() - 86_400_000;
		const newerObservationMs = fileMtimeMs + 3600_000;

		const result = await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: file },
				cwd: tmp,
				project: "codemem",
			},
			{},
			{
				queryByFile: (_db, path, project) => {
					expect(path).toBe("auth.ts");
					expect(project).toBe("codemem");
					return [
						baseRow({
							id: 101,
							session_id: 9,
							kind: "decision",
							title: "Switched auth callback to PKCE",
							created_at: new Date(newerObservationMs).toISOString(),
							files_modified: JSON.stringify(["auth.ts"]),
						}),
						baseRow({
							id: 102,
							session_id: 9, // same session — should dedupe
							kind: "bugfix",
							title: "Fixed redirect loop",
							created_at: new Date(newerObservationMs - 60_000).toISOString(),
							files_modified: JSON.stringify(["auth.ts"]),
						}),
						baseRow({
							id: 103,
							session_id: 10,
							kind: "feature",
							title: "Added refresh token rotation",
							created_at: new Date(newerObservationMs - 7200_000).toISOString(),
							files_modified: JSON.stringify(["auth.ts", "session.ts"]),
						}),
					];
				},
				resolveDb: () => "/tmp/test.sqlite",
				statFile: () => ({ sizeBytes: 2000, mtimeMs: fileMtimeMs }),
			},
		);

		expect(result.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
		expect(result.hookSpecificOutput?.permissionDecision).toBe("allow");
		const ctx = result.hookSpecificOutput?.additionalContext ?? "";
		expect(ctx).toContain("auth.ts");
		expect(ctx).toContain("memory.get_observations");
		expect(ctx).toContain("Switched auth callback to PKCE");
		expect(ctx).toContain("Added refresh token rotation");
		// session 9 dedupe: only one of 101/102 surfaces (the most-recent kept).
		expect(ctx.includes("Switched auth callback to PKCE")).toBe(true);
		expect(ctx.includes("Fixed redirect loop")).toBe(false);

		const log = readFileSync(pluginLogPath, "utf8");
		expect(log).toContain("file_context.ok");
	});

	it("returns continue when CODEMEM_PLUGIN_IGNORE is truthy", async () => {
		const original = process.env.CODEMEM_PLUGIN_IGNORE;
		process.env.CODEMEM_PLUGIN_IGNORE = "1";
		try {
			const result = await buildClaudeFileContext(
				{
					hook_event_name: "PreToolUse",
					tool_name: "Read",
					tool_input: { file_path: "/abs/path.ts" },
				},
				{},
				{
					queryByFile: () => {
						throw new Error("should not be called");
					},
					resolveDb: () => "/tmp/test.sqlite",
					statFile: () => ({ sizeBytes: 9999, mtimeMs: 0 }),
				},
			);
			expect(result).toEqual({ continue: true });
		} finally {
			if (original === undefined) delete process.env.CODEMEM_PLUGIN_IGNORE;
			else process.env.CODEMEM_PLUGIN_IGNORE = original;
		}
	});

	it("returns continue when CODEMEM_FILE_CONTEXT disables injection", async () => {
		const original = process.env.CODEMEM_FILE_CONTEXT;
		process.env.CODEMEM_FILE_CONTEXT = "0";
		try {
			const result = await buildClaudeFileContext(
				{
					hook_event_name: "PreToolUse",
					tool_name: "Read",
					tool_input: { file_path: "/abs/path.ts" },
				},
				{},
				{
					queryByFile: () => {
						throw new Error("should not be called");
					},
					resolveDb: () => "/tmp/test.sqlite",
					statFile: () => ({ sizeBytes: 9999, mtimeMs: 0 }),
				},
			);
			expect(result).toEqual({ continue: true });
		} finally {
			if (original === undefined) delete process.env.CODEMEM_FILE_CONTEXT;
			else process.env.CODEMEM_FILE_CONTEXT = original;
		}
	});

	it("bypasses the size gate for small config files (json/toml/yaml)", async () => {
		const file = join(tmp, "tsconfig.json");
		writeFileSync(file, '{"x":1}');

		const result = await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: file },
				cwd: tmp,
			},
			{},
			{
				queryByFile: () => [
					baseRow({
						id: 21,
						kind: "decision",
						title: "Switched moduleResolution to bundler",
						created_at: new Date(Date.now() - 86_400_000).toISOString(),
						files_modified: JSON.stringify(["tsconfig.json"]),
					}),
				],
				resolveDb: () => "/tmp/test.sqlite",
				statFile: () => ({ sizeBytes: 8, mtimeMs: Date.now() - 86_400_000 }),
			},
		);

		const ctx = result.hookSpecificOutput?.additionalContext ?? "";
		expect(ctx).toContain("Switched moduleResolution to bundler");
	});

	it("score-then-dedupe surfaces the highest-scoring observation per session", async () => {
		const file = join(tmp, "auth.ts");
		writeFileSync(file, "x".repeat(2000));
		const fileMtimeMs = Date.now() - 86_400_000;
		const obsMs = fileMtimeMs + 3600_000;

		const result = await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: file },
				cwd: tmp,
			},
			{},
			{
				queryByFile: () => [
					// Most-recent row from session 9 doesn't touch auth.ts —
					// score 0. Older row from same session targets auth.ts —
					// score 4. Score-then-dedupe should surface the older one.
					baseRow({
						id: 200,
						session_id: 9,
						kind: "discovery",
						title: "Sprawling crawl, no auth focus",
						created_at: new Date(obsMs).toISOString(),
						files_modified: JSON.stringify(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]),
					}),
					baseRow({
						id: 201,
						session_id: 9,
						kind: "decision",
						title: "Targeted auth fix",
						created_at: new Date(obsMs - 3600_000).toISOString(),
						files_modified: JSON.stringify(["auth.ts"]),
					}),
				],
				resolveDb: () => "/tmp/test.sqlite",
				statFile: () => ({ sizeBytes: 2000, mtimeMs: fileMtimeMs }),
			},
		);

		const ctx = result.hookSpecificOutput?.additionalContext ?? "";
		expect(ctx).toContain("Targeted auth fix");
		expect(ctx).not.toContain("Sprawling crawl, no auth focus");
	});

	it("logs file_context.skip when the file is below the size gate and not a small-config bypass", async () => {
		const file = join(tmp, "small.ts");
		writeFileSync(file, "x");

		await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: file },
				cwd: tmp,
			},
			{},
			{
				queryByFile: () => [],
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		const log = readFileSync(pluginLogPath, "utf8");
		expect(log).toContain("file_context.skip reason=below_size_gate");
	});

	it("does not classify in-repo basenames starting with .. as outside cwd", async () => {
		const file = join(tmp, "..hidden.json");
		writeFileSync(file, '{"x":1}');

		const result = await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: file },
				cwd: tmp,
			},
			{},
			{
				queryByFile: () => [
					baseRow({
						id: 31,
						kind: "decision",
						title: "Decision about ..hidden.json",
						created_at: new Date(Date.now() - 86_400_000).toISOString(),
						files_modified: JSON.stringify(["..hidden.json"]),
					}),
				],
				resolveDb: () => "/tmp/test.sqlite",
				statFile: () => ({ sizeBytes: 8, mtimeMs: Date.now() - 86_400_000 }),
			},
		);

		const ctx = result.hookSpecificOutput?.additionalContext ?? "";
		expect(ctx).toContain("Decision about ..hidden.json");
		const log = readFileSync(pluginLogPath, "utf8");
		expect(log).not.toContain("reason=outside_cwd");
	});

	it("logs file_context.skip when the file resolves outside cwd", async () => {
		await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: "/etc/passwd" },
				cwd: tmp,
			},
			{},
			{
				queryByFile: () => [],
				resolveDb: () => "/tmp/test.sqlite",
				statFile: () => ({ sizeBytes: 9999, mtimeMs: 0 }),
			},
		);

		const log = readFileSync(pluginLogPath, "utf8");
		expect(log).toContain("file_context.skip reason=outside_cwd");
	});

	it("logs file_context.skip when the query returns no observations", async () => {
		const file = join(tmp, "empty.ts");
		writeFileSync(file, "x".repeat(2000));

		const result = await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: file },
				cwd: tmp,
			},
			{},
			{
				queryByFile: () => [],
				resolveDb: () => "/tmp/test.sqlite",
				statFile: () => ({ sizeBytes: 2000, mtimeMs: Date.now() - 86_400_000 }),
			},
		);

		expect(result).toEqual({ continue: true });
		const log = readFileSync(pluginLogPath, "utf8");
		expect(log).toContain("file_context.skip reason=no_observations");
	});

	it.each([
		{
			name: "outside-cwd",
			filePath: "/private/forbidden.ts",
			stat: { sizeBytes: 2000, mtimeMs: 0 },
			status: "skipped",
			code: "outside_cwd",
			paths: undefined,
		},
		{
			name: "below-size-gate",
			filePath: "small.ts",
			stat: { sizeBytes: 1, mtimeMs: 0 },
			status: "skipped",
			code: "below_size_gate",
			paths: ["small.ts"],
		},
		{
			name: "no-observations",
			filePath: "empty.ts",
			stat: { sizeBytes: 2000, mtimeMs: 0 },
			status: "no_results",
			code: undefined,
			paths: ["empty.ts"],
		},
	])("records the $name lifecycle without absolute paths", async (fixture) => {
		const attempts: RetrievalSurfaceRecordInput[] = [];
		await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: fixture.filePath },
				cwd: tmp,
				session_id: "claude-session-1",
			},
			{},
			{
				queryByFile: () => [],
				resolveDb: () => join(tmp, "ledger.sqlite"),
				statFile: () => fixture.stat,
				recordAttempt: (_path, attempt) => attempts.push(attempt),
				now: () => new Date("2026-08-03T10:00:00.000Z"),
				createAttemptId: () => "018f2db4-f9d3-7a22-8d18-000000000001",
			},
		);

		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({
			surface: "file_context",
			retrievalStatus: fixture.status,
			sourceSessionId: "claude-session-1",
		});
		expect(attempts[0]?.failureCode).toBe(fixture.code);
		expect(attempts[0]?.repositoryPaths).toEqual(fixture.paths);
		expect(JSON.stringify(attempts)).not.toContain("/private/forbidden.ts");
		expect(JSON.stringify(attempts)).not.toContain(tmp);
	});

	it("records selected observations as handed off and correlates a known Claude session", async () => {
		const dbPath = join(tmp, "ledger.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		const now = "2026-08-03T10:00:00.000Z";
		const sessionId = Number(
			db
				.prepare(
					"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, ?, ?, ?, ?)",
				)
				.run(now, tmp, "codemem", "test", "test").lastInsertRowid,
		);
		db.prepare(
			"INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at) VALUES ('claude', ?, ?, ?, ?)",
		).run("claude-session-2", "claude-session-2", sessionId, now);
		db.prepare(
			`INSERT INTO memory_items(
				id, session_id, kind, title, body_text, created_at, updated_at,
				import_key, rev, active, scope_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			41,
			sessionId,
			"decision",
			"Selected observation",
			"snapshot body",
			now,
			now,
			"snapshot-41",
			7,
			1,
			"scope-test",
		);
		db.close();
		const file = join(tmp, "selected.ts");
		writeFileSync(file, "x".repeat(2000));
		const createStore = vi.fn((path: string) => new MemoryStore(path));

		const result = await buildClaudeFileContext(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: file },
				cwd: tmp,
				session_id: "claude-session-2",
			},
			{},
			{
				queryByFile: () => [
					baseRow({
						id: 41,
						session_id: sessionId,
						title: "Selected observation",
						files_modified: '["selected.ts"]',
					}),
				],
				resolveDb: () => dbPath,
				createStore,
				statFile: () => ({ sizeBytes: 2000, mtimeMs: 0 }),
			},
		);

		const readDb = connect(dbPath);
		const attempt = queryRetrievalAttempts(readDb, { surface: "file_context", limit: 1 })[0];
		readDb.close();
		expect(result.hookSpecificOutput?.additionalContext).toContain("Selected observation");
		expect(createStore).toHaveBeenCalledTimes(1);
		expect(attempt).toMatchObject({
			retrievalStatus: "succeeded",
			deliveryStatus: "handed_off",
			sessionId,
			sourceSessionId: "claude-session-2",
			workingSetFiles: ["selected.ts"],
		});
		expect(attempt?.exposures[0]).toMatchObject({
			memoryId: 41,
			memoryImportKey: "snapshot-41",
			memoryRev: 7,
			memoryUpdatedAt: now,
			memoryScopeId: "scope-test",
			memoryKind: "decision",
			memoryActive: true,
		});
	});

	it("uses the production store retrieval path when no query dependency is injected", async () => {
		const dbPath = join(tmp, "production.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		const sessionId = Number(
			db
				.prepare(
					"INSERT INTO sessions(started_at, cwd, project, user, tool_version) VALUES (?, ?, ?, ?, ?)",
				)
				.run(new Date().toISOString(), tmp, "codemem", "test", "test").lastInsertRowid,
		);
		db.close();
		const seedStore = new MemoryStore(dbPath);
		seedStore.remember(
			sessionId,
			"decision",
			"Production retrieval observation",
			"Production retrieval body",
			0.9,
			[],
			{ files_modified: ["production.ts"] },
		);
		seedStore.close();

		const result = await buildClaudeFileContext(
			{
				tool_input: { file_path: "production.ts" },
				cwd: tmp,
				project: "codemem",
			},
			{},
			{
				resolveDb: () => dbPath,
				statFile: () => ({ sizeBytes: 2000, mtimeMs: 0 }),
			},
		);

		expect(result.hookSpecificOutput?.additionalContext).toContain(
			"Production retrieval observation",
		);
	});

	it("keeps successful delivery fail-open when the ledger recorder throws", async () => {
		const file = join(tmp, "fail-open.ts");
		writeFileSync(file, "x".repeat(2000));
		const result = await buildClaudeFileContext(
			{ tool_input: { file_path: file }, cwd: tmp },
			{},
			{
				queryByFile: () => [baseRow({ id: 51, title: "Still delivered" })],
				resolveDb: () => join(tmp, "ledger.sqlite"),
				statFile: () => ({ sizeBytes: 2000, mtimeMs: 0 }),
				recordAttempt: () => {
					throw new Error("ledger unavailable");
				},
			},
		);
		expect(result.hookSpecificOutput?.additionalContext).toContain("Still delivered");
	});

	it("keeps successful hook output and handed-off delivery when store cleanup throws", async () => {
		const dbPath = join(tmp, "close-failure.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		const store = new MemoryStore(dbPath);
		const close = vi.spyOn(store, "close").mockImplementation(() => {
			throw new Error("close failed after success");
		});

		try {
			const result = await buildClaudeFileContext(
				{ tool_input: { file_path: "close-failure.ts" }, cwd: tmp },
				{},
				{
					queryByFile: () => [baseRow({ id: 52, title: "Delivered before cleanup" })],
					resolveDb: () => dbPath,
					createStore: () => store,
					statFile: () => ({ sizeBytes: 2000, mtimeMs: 0 }),
					createAttemptId: () => "018f2db4-f9d3-7a22-8d18-000000000052",
				},
			);

			const output = JSON.parse(JSON.stringify(result)) as typeof result;
			expect(output.hookSpecificOutput).toMatchObject({
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
			});
			expect(output.hookSpecificOutput?.additionalContext).toContain("Delivered before cleanup");
			expect(close).toHaveBeenCalledTimes(1);
			expect(
				queryRetrievalAttempts(store.db, { surface: "file_context", limit: 1 })[0],
			).toMatchObject({
				attemptId: "018f2db4-f9d3-7a22-8d18-000000000052",
				retrievalStatus: "succeeded",
				deliveryStatus: "handed_off",
			});
		} finally {
			close.mockRestore();
			store.close();
		}
	});

	it("records selection before formatting and confirms delivery afterward", async () => {
		const attempts: RetrievalSurfaceRecordInput[] = [];
		const deliveries: string[] = [];
		const result = await buildClaudeFileContext(
			{ tool_input: { file_path: "selected.ts" }, cwd: tmp },
			{},
			{
				queryByFile: () => [baseRow({ id: 61, title: "Selected then delivered" })],
				resolveDb: () => join(tmp, "ledger.sqlite"),
				statFile: () => ({ sizeBytes: 2000, mtimeMs: 0 }),
				recordAttempt: (_path, attempt) => attempts.push(attempt),
				updateDelivery: (_path, attemptId, status) => deliveries.push(`${attemptId}:${status}`),
				createAttemptId: () => "018f2db4-f9d3-7a22-8d18-000000000061",
			},
		);
		expect(result.hookSpecificOutput?.additionalContext).toContain("Selected then delivered");
		expect(attempts[0]).toMatchObject({
			retrievalStatus: "succeeded",
			deliveryStatus: "not_attempted",
			candidateIds: [61],
			selectedIds: [61],
		});
		expect(deliveries).toEqual(["018f2db4-f9d3-7a22-8d18-000000000061:handed_off"]);
	});

	it("records disabled file-context as one skipped attempt without changing hook output", async () => {
		const original = process.env.CODEMEM_FILE_CONTEXT;
		process.env.CODEMEM_FILE_CONTEXT = "0";
		const dbPath = join(tmp, "ledger.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		try {
			const result = await buildClaudeFileContext(
				{
					tool_input: { file_path: "disabled.ts" },
					cwd: tmp,
					session_id: "claude-session-disabled",
				},
				{},
				{
					resolveDb: () => dbPath,
					createAttemptId: () => "018f2db4-f9d3-7a22-8d18-000000000072",
				},
			);
			expect(result).toEqual({ continue: true });

			const readDb = connect(dbPath);
			const attempts = queryRetrievalAttempts(readDb, { surface: "file_context" });
			readDb.close();
			expect(attempts).toHaveLength(1);
			expect(attempts[0]).toMatchObject({
				attemptId: "018f2db4-f9d3-7a22-8d18-000000000072",
				retrievalStatus: "skipped",
				deliveryStatus: "not_attempted",
				failureCode: "file_context_disabled",
				failureStage: "configuration",
				candidateCount: 0,
				selectedCount: 0,
				exposures: [],
			});
		} finally {
			if (original === undefined) delete process.env.CODEMEM_FILE_CONTEXT;
			else process.env.CODEMEM_FILE_CONTEXT = original;
		}
	});

	it("keeps disabled file-context fail-open when the database cannot be resolved", async () => {
		const original = process.env.CODEMEM_FILE_CONTEXT;
		process.env.CODEMEM_FILE_CONTEXT = "0";
		const originalExitCode = process.exitCode;
		const resolveDb = vi.fn(() => {
			throw new Error("database unavailable");
		});
		try {
			const result = await buildClaudeFileContext(
				{ tool_input: { file_path: "disabled.ts" }, cwd: tmp },
				{},
				{ resolveDb },
			);

			expect(result).toEqual({ continue: true });
			expect(resolveDb).toHaveBeenCalledTimes(1);
			expect(process.exitCode).toBe(originalExitCode);
		} finally {
			if (original === undefined) delete process.env.CODEMEM_FILE_CONTEXT;
			else process.env.CODEMEM_FILE_CONTEXT = original;
		}
	});

	it("keeps disabled file-context fail-open when the ledger write fails", async () => {
		const original = process.env.CODEMEM_FILE_CONTEXT;
		process.env.CODEMEM_FILE_CONTEXT = "0";
		const originalExitCode = process.exitCode;
		const recordAttempt = vi.fn(() => {
			throw new Error("ledger unavailable");
		});
		try {
			const result = await buildClaudeFileContext(
				{ tool_input: { file_path: "disabled.ts" }, cwd: tmp },
				{},
				{
					resolveDb: () => join(tmp, "ledger.sqlite"),
					recordAttempt,
				},
			);

			expect(result).toEqual({ continue: true });
			expect(recordAttempt).toHaveBeenCalledTimes(1);
			expect(process.exitCode).toBe(originalExitCode);
		} finally {
			if (original === undefined) delete process.env.CODEMEM_FILE_CONTEXT;
			else process.env.CODEMEM_FILE_CONTEXT = original;
		}
	});

	it("delivers file context without recording when retrieval evidence capture is disabled", async () => {
		const original = process.env.CODEMEM_RETRIEVAL_LEDGER;
		process.env.CODEMEM_RETRIEVAL_LEDGER = "0";
		const recordAttempt = vi.fn();
		try {
			const result = await buildClaudeFileContext(
				{ tool_input: { file_path: "capture-disabled.ts" }, cwd: tmp },
				{},
				{
					queryByFile: () => [baseRow({ id: 71, title: "Still delivered" })],
					resolveDb: () => join(tmp, "ledger.sqlite"),
					statFile: () => ({ sizeBytes: 2000, mtimeMs: 0 }),
					recordAttempt,
				},
			);
			expect(result.hookSpecificOutput?.additionalContext).toContain("Still delivered");
			expect(recordAttempt).not.toHaveBeenCalled();
		} finally {
			if (original === undefined) delete process.env.CODEMEM_RETRIEVAL_LEDGER;
			else process.env.CODEMEM_RETRIEVAL_LEDGER = original;
		}
	});

	it("records file-context query failures with a stable code", async () => {
		const attempts: RetrievalSurfaceRecordInput[] = [];
		await buildClaudeFileContext(
			{ tool_input: { file_path: "failed.ts" }, cwd: tmp },
			{},
			{
				resolveDb: () => join(tmp, "ledger.sqlite"),
				statFile: () => ({ sizeBytes: 2000, mtimeMs: 0 }),
				queryByFile: () => {
					throw new Error("raw private database error");
				},
				recordAttempt: (_path, attempt) => attempts.push(attempt),
			},
		);
		expect(attempts[0]).toMatchObject({
			retrievalStatus: "failed",
			deliveryStatus: "not_attempted",
			failureCode: "query_failed",
			failureStage: "retrieval",
		});
		expect(JSON.stringify(attempts)).not.toContain("raw private database error");
	});
});
