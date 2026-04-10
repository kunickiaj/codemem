import { describe, expect, it } from "vitest";
import { buildClaudeHookInjection, claudeHookInjectCommand } from "./claude-hook-inject.js";

describe("claude-hook-inject command", () => {
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
				buildLocalPack: async (context, project, dbPath) => {
					expect(context).toBe("fix auth callback");
					expect(project).toBe("codemem");
					expect(dbPath).toBe("/tmp/test.sqlite");
					return "## Summary\n[1] (decision) Auth fix";
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
						expect(context).toBe("continue sync work");
						expect(project).toBe("codemem");
						expect(maxTimeMs).toBe(7000);
						return "## Timeline\n[4] (feature) Sync continuation";
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
					buildLocalPack: async () => "12345678901234567890",
					httpPack: async () => "",
					resolveDb: () => "/tmp/test.sqlite",
				},
			);

			expect(result).toEqual({
				continue: true,
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: "123456789012",
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
				buildLocalPack: async () => "Remember to run targeted tests.",
				httpPack: async () => "",
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
				buildLocalPack: async () => "## Summary\nmemory pack",
				httpPack: async () => "",
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
		expect(result.hookSpecificOutput?.additionalContext).toBe("## Summary\nmemory pack");
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
					httpPack: async () => "",
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
