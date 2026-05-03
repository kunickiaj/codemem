import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	it("returns continue when file mtime is newer than the newest observation", async () => {
		const file = join(tmp, "stale.ts");
		writeFileSync(file, "x".repeat(2000));
		const fileMtimeMs = Date.now();
		const observationMs = fileMtimeMs - 60_000;

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
						id: 1,
						kind: "decision",
						created_at: new Date(observationMs).toISOString(),
						files_modified: JSON.stringify(["stale.ts"]),
					}),
				],
				resolveDb: () => "/tmp/test.sqlite",
				statFile: () => ({ sizeBytes: 2000, mtimeMs: fileMtimeMs }),
			},
		);

		expect(result).toEqual({ continue: true });
		const log = readFileSync(pluginLogPath, "utf8");
		expect(log).toContain("file_context.skip reason=file_newer");
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
});
