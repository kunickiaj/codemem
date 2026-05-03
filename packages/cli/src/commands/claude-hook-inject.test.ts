import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildClaudeHookInjection,
	claudeHookInjectCommand,
	type PackResult,
} from "./claude-hook-inject.js";
import { saveSessionState, statePathForSession } from "./claude-hook-session-state.js";

const pack = (packText: string, items = 0, packTokens = 0): PackResult => ({
	packText,
	items,
	packTokens,
});

describe("claude-hook-inject command", () => {
	let stateDir: string;
	let pluginLogPath: string;
	let originalContextDir: string | undefined;
	let originalPluginLogPath: string | undefined;

	beforeEach(() => {
		originalContextDir = process.env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR;
		originalPluginLogPath = process.env.CODEMEM_PLUGIN_LOG_PATH;
		stateDir = mkdtempSync(join(tmpdir(), "codemem-cli-inject-state-"));
		pluginLogPath = join(stateDir, "plugin.log");
		process.env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR = stateDir;
		process.env.CODEMEM_PLUGIN_LOG_PATH = pluginLogPath;
	});

	afterEach(() => {
		if (originalContextDir === undefined) delete process.env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR;
		else process.env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR = originalContextDir;
		if (originalPluginLogPath === undefined) delete process.env.CODEMEM_PLUGIN_LOG_PATH;
		else process.env.CODEMEM_PLUGIN_LOG_PATH = originalPluginLogPath;
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("registers expected options and help text", () => {
		const longs = claudeHookInjectCommand.options.map((option) => option.long);
		expect(longs).toContain("--db");
		expect(longs).toContain("--db-path");

		const help = claudeHookInjectCommand.helpInformation();
		expect(help).toContain("additionalContext");
	});

	it("returns continue with local additionalContext when local pack succeeds", async () => {
		const result = await buildClaudeHookInjection(
			{
				hook_event_name: "UserPromptSubmit",
				session_id: "sess-1",
				prompt: "fix auth callback",
				cwd: "/tmp/codemem",
				project: "codemem",
			},
			{},
			{
				buildLocalPack: async (context, project, dbPath, workingSetPaths) => {
					// Rich query: first_prompt (just persisted) + project; current
					// prompt is identical to first_prompt and is therefore skipped.
					expect(context).toBe("fix auth callback codemem");
					expect(project).toBe("codemem");
					expect(dbPath).toBe("/tmp/test.sqlite");
					expect(workingSetPaths).toEqual([]);
					return pack("## Summary\n[1] (decision) Auth fix", 1, 42);
				},
				httpPack: async () => {
					throw new Error("http fallback should not run");
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result).toEqual({
			continue: true,
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: "## Summary\n[1] (decision) Auth fix",
			},
		});
	});

	it("falls back to HTTP pack generation when local generation fails", async () => {
		const originalFallback = process.env.CODEMEM_INJECT_HTTP_FALLBACK;
		const originalHttpMax = process.env.CODEMEM_INJECT_HTTP_MAX_TIME_S;
		process.env.CODEMEM_INJECT_HTTP_FALLBACK = "1";
		process.env.CODEMEM_INJECT_HTTP_MAX_TIME_S = "7";
		try {
			const result = await buildClaudeHookInjection(
				{
					hook_event_name: "UserPromptSubmit",
					session_id: "sess-2",
					prompt: "continue sync work",
					cwd: "/tmp/codemem",
					project: "codemem",
				},
				{},
				{
					buildLocalPack: async () => {
						throw new Error("local pack failed");
					},
					httpPack: async (context, project, maxTimeMs) => {
						// HTTP fallback receives the same rich query as the local path.
						expect(context).toBe("continue sync work codemem");
						expect(project).toBe("codemem");
						expect(maxTimeMs).toBe(7000);
						return pack("## Timeline\n[4] (feature) Sync continuation", 1, 53);
					},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);

			expect(result).toEqual({
				continue: true,
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: "## Timeline\n[4] (feature) Sync continuation",
				},
			});
		} finally {
			if (originalFallback === undefined) delete process.env.CODEMEM_INJECT_HTTP_FALLBACK;
			else process.env.CODEMEM_INJECT_HTTP_FALLBACK = originalFallback;
			if (originalHttpMax === undefined) delete process.env.CODEMEM_INJECT_HTTP_MAX_TIME_S;
			else process.env.CODEMEM_INJECT_HTTP_MAX_TIME_S = originalHttpMax;
		}
	});

	it("returns continue without additionalContext when CODEMEM_INJECT_CONTEXT disables injection", async () => {
		const originalInjectContext = process.env.CODEMEM_INJECT_CONTEXT;
		process.env.CODEMEM_INJECT_CONTEXT = "0";
		try {
			const result = await buildClaudeHookInjection(
				{
					hook_event_name: "UserPromptSubmit",
					session_id: "sess-disabled",
					prompt: "fix auth callback",
				},
				{},
				{
					buildLocalPack: async () => {
						throw new Error("should not build local pack when injection disabled");
					},
					httpPack: async () => {
						throw new Error("should not call http fallback when injection disabled");
					},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);

			expect(result).toEqual({ continue: true });
		} finally {
			if (originalInjectContext === undefined) delete process.env.CODEMEM_INJECT_CONTEXT;
			else process.env.CODEMEM_INJECT_CONTEXT = originalInjectContext;
		}
	});

	it("returns continue without additionalContext when no prompt is present", async () => {
		const result = await buildClaudeHookInjection(
			{
				hook_event_name: "SessionStart",
				session_id: "sess-3",
				cwd: "/tmp/codemem",
			},
			{},
			{
				buildLocalPack: async () => {
					throw new Error("should not build local pack");
				},
				httpPack: async () => {
					throw new Error("should not call http fallback");
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result).toEqual({ continue: true });
	});

	it("truncates additionalContext to CODEMEM_INJECT_MAX_CHARS", async () => {
		const originalMaxChars = process.env.CODEMEM_INJECT_MAX_CHARS;
		process.env.CODEMEM_INJECT_MAX_CHARS = "12";
		try {
			const result = await buildClaudeHookInjection(
				{
					hook_event_name: "UserPromptSubmit",
					session_id: "sess-4",
					prompt: "viewer cards",
				},
				{},
				{
					buildLocalPack: async () => pack("12345678901234567890"),
					httpPack: async () => pack(""),
					resolveDb: () => "/tmp/test.sqlite",
				},
			);

			expect(result).toEqual({
				continue: true,
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: "123456789012\n\n[pack truncated]",
				},
			});
		} finally {
			if (originalMaxChars === undefined) delete process.env.CODEMEM_INJECT_MAX_CHARS;
			else process.env.CODEMEM_INJECT_MAX_CHARS = originalMaxChars;
		}
	});

	it("always emits UserPromptSubmit hookEventName even when payload carries a different hook_event_name", async () => {
		// claude-hook-inject is wired exclusively to UserPromptSubmit and the
		// hookSpecificOutput.additionalContext field is UserPromptSubmit-specific.
		// Echoing a different event name would silently produce schema-invalid
		// output, so the emitted event name must be hardcoded regardless of
		// what the payload claims.
		const result = await buildClaudeHookInjection(
			{
				hook_event_name: "SessionStart",
				session_id: "sess-wrong-event",
				prompt: "investigate flaky test",
				cwd: "/tmp/codemem",
			},
			{},
			{
				buildLocalPack: async () => pack("Remember to run targeted tests."),
				httpPack: async () => pack(""),
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
		expect(result.hookSpecificOutput?.additionalContext).toContain(
			"Remember to run targeted tests.",
		);
	});

	it("emits UserPromptSubmit hookEventName when payload omits hook_event_name", async () => {
		// Resilience to payload-shape drift: even if Claude Code stops sending
		// hook_event_name on the inbound side, the emitted output stays valid.
		const result = await buildClaudeHookInjection(
			{
				session_id: "sess-missing-event",
				prompt: "plan retrieval improvements",
				cwd: "/tmp/codemem",
			},
			{},
			{
				buildLocalPack: async () => pack("## Summary\nmemory pack"),
				httpPack: async () => pack(""),
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
		expect(result.hookSpecificOutput?.additionalContext).toBe("## Summary\nmemory pack");
	});

	it("enriches the retrieval query with prior session state and propagates working_set_paths", async () => {
		// Pre-seed session state on disk so this prompt looks like the second
		// turn of an existing session: prior first_prompt + prior modified files.
		const sessionId = "sess-stateful";
		saveSessionState(sessionId, {
			first_prompt: "investigate flaky test",
			last_prompt: "investigate flaky test",
			files_modified: ["packages/cli/src/a.ts", "packages/cli/src/b.ts", "packages/cli/src/c.ts"],
			updated_at: "2026-04-09T00:00:00Z",
		});

		const result = await buildClaudeHookInjection(
			{
				hook_event_name: "UserPromptSubmit",
				session_id: sessionId,
				prompt: "now check the fixture",
				cwd: "/tmp/codemem",
				project: "codemem",
			},
			{},
			{
				buildLocalPack: async (context, project, _dbPath, workingSetPaths) => {
					// Query weaves: original first_prompt + new prompt + project
					// + recent file basenames (last 5 → all 3 here).
					expect(context).toBe(
						"investigate flaky test now check the fixture codemem a.ts b.ts c.ts",
					);
					expect(project).toBe("codemem");
					expect(workingSetPaths).toEqual([
						"packages/cli/src/a.ts",
						"packages/cli/src/b.ts",
						"packages/cli/src/c.ts",
					]);
					return pack("## Memory pack");
				},
				httpPack: async () => {
					throw new Error("http fallback should not run");
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result.hookSpecificOutput?.additionalContext).toBe("## Memory pack");
		// State persists across the call: last_prompt now reflects the new prompt.
		expect(statePathForSession(sessionId).startsWith(stateDir)).toBe(true);
	});

	it("appends [pack truncated] marker when additionalContext exceeds CODEMEM_INJECT_MAX_CHARS", async () => {
		const originalMaxChars = process.env.CODEMEM_INJECT_MAX_CHARS;
		// 22 cuts the source at "memory_one memory_two " (trailing space).
		// trimEnd should drop the trailing space before appending the marker.
		process.env.CODEMEM_INJECT_MAX_CHARS = "22";
		try {
			const result = await buildClaudeHookInjection(
				{
					hook_event_name: "UserPromptSubmit",
					session_id: "sess-marker",
					prompt: "any longer prompt",
				},
				{},
				{
					buildLocalPack: async () => pack("memory_one memory_two memory_three memory_four"),
					httpPack: async () => pack(""),
					resolveDb: () => "/tmp/test.sqlite",
				},
			);

			const additionalContext = result.hookSpecificOutput?.additionalContext ?? "";
			expect(additionalContext.endsWith("\n\n[pack truncated]")).toBe(true);
			expect(additionalContext).toBe("memory_one memory_two\n\n[pack truncated]");
		} finally {
			if (originalMaxChars === undefined) delete process.env.CODEMEM_INJECT_MAX_CHARS;
			else process.env.CODEMEM_INJECT_MAX_CHARS = originalMaxChars;
		}
	});

	it("returns continue without injection when CODEMEM_PLUGIN_IGNORE is truthy", async () => {
		const originalIgnore = process.env.CODEMEM_PLUGIN_IGNORE;
		process.env.CODEMEM_PLUGIN_IGNORE = "1";
		try {
			const result = await buildClaudeHookInjection(
				{
					hook_event_name: "UserPromptSubmit",
					session_id: "sess-ignored",
					prompt: "should be ignored",
				},
				{},
				{
					buildLocalPack: async () => {
						throw new Error("should not be called when plugin is ignored");
					},
					httpPack: async () => {
						throw new Error("should not be called when plugin is ignored");
					},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);
			expect(result).toEqual({ continue: true });
		} finally {
			if (originalIgnore === undefined) delete process.env.CODEMEM_PLUGIN_IGNORE;
			else process.env.CODEMEM_PLUGIN_IGNORE = originalIgnore;
		}
	});

	it("normalizes multi-line prompts before composing the rich query", async () => {
		// The session-state tracker stores first_prompt with newlines collapsed.
		// extractInjectContext must do the same so the second-turn comparison
		// `prompt !== first_prompt` works for multi-line prompts — otherwise
		// the current prompt would be appended on every turn.
		const sessionId = "sess-multiline";
		// Pre-seed first_prompt as the canonical (collapsed) form.
		saveSessionState(sessionId, {
			first_prompt: "fix the auth callback flow",
			last_prompt: "fix the auth callback flow",
			files_modified: [],
			updated_at: "2026-04-09T00:00:00Z",
		});

		const result = await buildClaudeHookInjection(
			{
				hook_event_name: "UserPromptSubmit",
				session_id: sessionId,
				// Same words, but with newlines — the bug would treat this as
				// a different prompt than the stored first_prompt.
				prompt: "fix the auth\ncallback flow",
				cwd: "/tmp/codemem",
				project: "codemem",
			},
			{},
			{
				buildLocalPack: async (context) => {
					// Newlines must be collapsed to spaces, AND the current
					// prompt must dedupe against first_prompt (skipped because
					// equal post-normalization).
					expect(context).not.toContain("\n");
					expect(context).toBe("fix the auth callback flow codemem");
					return pack("## Pack");
				},
				httpPack: async () => pack(""),
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result.hookSpecificOutput?.additionalContext).toBe("## Pack");
	});

	it("logs inject.pack.ok with metrics on local pack success", async () => {
		await buildClaudeHookInjection(
			{
				hook_event_name: "UserPromptSubmit",
				session_id: "sess-metrics",
				prompt: "ship the feature",
				cwd: "/tmp/codemem",
				project: "codemem",
			},
			{},
			{
				buildLocalPack: async () => pack("## Summary\nmemory pack body", 4, 137),
				httpPack: async () => {
					throw new Error("http fallback should not run");
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		const log = readFileSync(pluginLogPath, "utf8");
		const line = log.trim().split("\n").pop() ?? "";
		expect(line).toContain("inject.pack.ok");
		expect(line).toContain("source=claude");
		expect(line).toContain("origin=local");
		expect(line).toContain("items=4");
		expect(line).toContain("pack_tokens=137");
		expect(line).toContain('project="codemem"');
		expect(line).toContain("empty=false");
		expect(line).toMatch(/query_len=\d+/);
	});

	it("logs origin=http when local pack fails and http fallback succeeds", async () => {
		const originalFallback = process.env.CODEMEM_INJECT_HTTP_FALLBACK;
		process.env.CODEMEM_INJECT_HTTP_FALLBACK = "1";
		try {
			await buildClaudeHookInjection(
				{
					hook_event_name: "UserPromptSubmit",
					session_id: "sess-http-origin",
					prompt: "fallback path",
					cwd: "/tmp/codemem",
				},
				{},
				{
					buildLocalPack: async () => {
						throw new Error("local pack failed");
					},
					httpPack: async () => pack("## Timeline\nfallback pack", 2, 64),
					resolveDb: () => "/tmp/test.sqlite",
				},
			);

			const log = readFileSync(pluginLogPath, "utf8");
			const okLine =
				log
					.trim()
					.split("\n")
					.reverse()
					.find((l) => l.includes("inject.pack.ok")) ?? "";
			expect(okLine).toContain("origin=http");
			expect(okLine).toContain("items=2");
			expect(okLine).toContain("pack_tokens=64");
			expect(okLine).toContain("empty=false");
		} finally {
			if (originalFallback === undefined) delete process.env.CODEMEM_INJECT_HTTP_FALLBACK;
			else process.env.CODEMEM_INJECT_HTTP_FALLBACK = originalFallback;
		}
	});

	it("logs inject.pack.ok with empty=true when no pack is produced", async () => {
		const originalFallback = process.env.CODEMEM_INJECT_HTTP_FALLBACK;
		process.env.CODEMEM_INJECT_HTTP_FALLBACK = "0";
		try {
			await buildClaudeHookInjection(
				{
					hook_event_name: "UserPromptSubmit",
					session_id: "sess-empty",
					prompt: "no memories yet",
					cwd: "/tmp/codemem",
				},
				{},
				{
					buildLocalPack: async () => pack(""),
					httpPack: async () => {
						throw new Error("http fallback disabled");
					},
					resolveDb: () => "/tmp/test.sqlite",
				},
			);

			const log = readFileSync(pluginLogPath, "utf8");
			const line = log.trim().split("\n").pop() ?? "";
			expect(line).toContain("inject.pack.ok");
			expect(line).toContain("empty=true");
			expect(line).toContain("items=0");
		} finally {
			if (originalFallback === undefined) delete process.env.CODEMEM_INJECT_HTTP_FALLBACK;
			else process.env.CODEMEM_INJECT_HTTP_FALLBACK = originalFallback;
		}
	});

	it("returns continue without additionalContext when all generation paths fail", async () => {
		const originalFallback = process.env.CODEMEM_INJECT_HTTP_FALLBACK;
		process.env.CODEMEM_INJECT_HTTP_FALLBACK = "1";
		try {
			const result = await buildClaudeHookInjection(
				{
					hook_event_name: "UserPromptSubmit",
					session_id: "sess-5",
					prompt: "oauth follow-up",
				},
				{},
				{
					buildLocalPack: async () => {
						throw new Error("local pack failed");
					},
					httpPack: async () => pack(""),
					resolveDb: () => "/tmp/test.sqlite",
				},
			);

			expect(result).toEqual({ continue: true });
		} finally {
			if (originalFallback === undefined) delete process.env.CODEMEM_INJECT_HTTP_FALLBACK;
			else process.env.CODEMEM_INJECT_HTTP_FALLBACK = originalFallback;
		}
	});
});
