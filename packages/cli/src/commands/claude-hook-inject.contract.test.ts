/**
 * Golden contract fixtures for `buildClaudeHookInjection`.
 *
 * Each fixture pairs a Claude Code hook payload (and optional env
 * overrides) with the EXACT JSON output the command must emit. Mocks
 * for pack generation are deterministic so the assertions are
 * deep-equal on the full result object — this is the test pattern that
 * catches "someone forgot a field in the output helper" regressions
 * the next time the inject command is touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildClaudeHookInjection } from "./claude-hook-inject.js";

type ExpectedResult = {
	continue: true;
	hookSpecificOutput?: {
		hookEventName: "UserPromptSubmit";
		additionalContext: string;
	};
};

type DepsOverride = {
	buildLocalPack?: (
		context: string,
		project: string | null,
		dbPath: string,
		workingSetPaths?: string[],
	) => Promise<string> | string;
	httpPack?: (
		context: string,
		project: string | null,
		maxTimeMs?: number,
	) => Promise<string> | string;
};

type Fixture = {
	name: string;
	payload: Record<string, unknown>;
	envOverrides?: Record<string, string | undefined>;
	deps?: DepsOverride;
	expected: ExpectedResult;
};

const fixtures: Fixture[] = [
	{
		name: "UserPromptSubmit with non-empty prompt → emits hookSpecificOutput",
		payload: {
			hook_event_name: "UserPromptSubmit",
			session_id: "contract-1",
			prompt: "rebuild the auth callback flow",
			cwd: "/tmp/contract",
			project: "codemem",
		},
		deps: {
			buildLocalPack: () => "GOLDEN_PACK_BODY",
			httpPack: () => "",
		},
		expected: {
			continue: true,
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: "GOLDEN_PACK_BODY",
			},
		},
	},
	{
		name: "UserPromptSubmit invariance: payload carries SessionStart, output still UserPromptSubmit",
		payload: {
			hook_event_name: "SessionStart",
			session_id: "contract-invariance",
			prompt: "investigate retrieval drift",
			cwd: "/tmp/contract",
		},
		deps: {
			buildLocalPack: () => "INVARIANT_PACK",
			httpPack: () => "",
		},
		expected: {
			continue: true,
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: "INVARIANT_PACK",
			},
		},
	},
	{
		name: "UserPromptSubmit with no hook_event_name field → still emits UserPromptSubmit",
		payload: {
			session_id: "contract-missing-event",
			prompt: "ship retrieval improvements",
		},
		deps: {
			buildLocalPack: () => "RESILIENT_PACK",
			httpPack: () => "",
		},
		expected: {
			continue: true,
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: "RESILIENT_PACK",
			},
		},
	},
	{
		name: "UserPromptSubmit with empty string prompt → continue without hookSpecificOutput",
		payload: {
			hook_event_name: "UserPromptSubmit",
			session_id: "contract-empty-prompt",
			prompt: "",
		},
		deps: {
			buildLocalPack: () => "should-not-be-emitted",
			httpPack: () => "",
		},
		expected: { continue: true },
	},
	{
		name: "UserPromptSubmit with no prompt key → continue without hookSpecificOutput",
		payload: {
			hook_event_name: "UserPromptSubmit",
			session_id: "contract-no-prompt",
		},
		deps: {
			buildLocalPack: () => "should-not-be-emitted",
			httpPack: () => "",
		},
		expected: { continue: true },
	},
	{
		name: "Injection disabled via CODEMEM_INJECT_CONTEXT=0 → continue without hookSpecificOutput",
		payload: {
			hook_event_name: "UserPromptSubmit",
			session_id: "contract-disabled",
			prompt: "should be ignored",
		},
		envOverrides: { CODEMEM_INJECT_CONTEXT: "0" },
		deps: {
			buildLocalPack: () => "should-not-be-emitted",
			httpPack: () => "",
		},
		expected: { continue: true },
	},
	{
		name: "Local pack throws → HTTP fallback wins",
		payload: {
			hook_event_name: "UserPromptSubmit",
			session_id: "contract-fallback",
			prompt: "fall back to http",
			cwd: "/tmp/contract",
			project: "codemem",
		},
		envOverrides: { CODEMEM_INJECT_HTTP_FALLBACK: "1" },
		deps: {
			buildLocalPack: () => {
				throw new Error("simulated local pack failure");
			},
			httpPack: () => "HTTP_FALLBACK_PACK",
		},
		expected: {
			continue: true,
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: "HTTP_FALLBACK_PACK",
			},
		},
	},
	{
		name: "Truncation: pack longer than CODEMEM_INJECT_MAX_CHARS gets [pack truncated] marker",
		payload: {
			hook_event_name: "UserPromptSubmit",
			session_id: "contract-truncate",
			prompt: "any longer prompt for truncation",
		},
		envOverrides: { CODEMEM_INJECT_MAX_CHARS: "22" },
		deps: {
			buildLocalPack: () => "memory_one memory_two memory_three memory_four",
			httpPack: () => "",
		},
		expected: {
			continue: true,
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: "memory_one memory_two\n\n[pack truncated]",
			},
		},
	},
	{
		name: "SessionStart payload (no prompt) → continue without hookSpecificOutput",
		payload: {
			hook_event_name: "SessionStart",
			session_id: "contract-session-start",
			cwd: "/tmp/contract",
		},
		deps: {
			buildLocalPack: () => "should-not-be-emitted",
			httpPack: () => "",
		},
		expected: { continue: true },
	},
	{
		name: "PostToolUse payload (no prompt) → continue without hookSpecificOutput",
		payload: {
			hook_event_name: "PostToolUse",
			session_id: "contract-post-tool-use",
			tool_name: "edit",
			tool_input: { filePath: "packages/cli/src/example.ts" },
		},
		deps: {
			buildLocalPack: () => "should-not-be-emitted",
			httpPack: () => "",
		},
		expected: { continue: true },
	},
	{
		name: "SessionEnd payload → continue without hookSpecificOutput (state cleared as side effect)",
		payload: {
			hook_event_name: "SessionEnd",
			session_id: "contract-session-end",
		},
		deps: {
			buildLocalPack: () => "should-not-be-emitted",
			httpPack: () => "",
		},
		expected: { continue: true },
	},
];

describe("claude-hook-inject contract fixtures", () => {
	let stateDir: string;
	let pluginLogPath: string;
	const sandboxedEnvKeys = [
		"CODEMEM_CLAUDE_HOOK_CONTEXT_DIR",
		"CODEMEM_PLUGIN_LOG_PATH",
		"CODEMEM_PLUGIN_LOG",
		"CODEMEM_INJECT_CONTEXT",
		"CODEMEM_INJECT_HTTP_FALLBACK",
		"CODEMEM_INJECT_MAX_CHARS",
		"CODEMEM_INJECT_LIMIT",
		"CODEMEM_INJECT_TOKEN_BUDGET",
	];
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "codemem-cli-contract-"));
		pluginLogPath = join(stateDir, "plugin.log");
		for (const key of sandboxedEnvKeys) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR = stateDir;
		process.env.CODEMEM_PLUGIN_LOG_PATH = pluginLogPath;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(stateDir, { recursive: true, force: true });
	});

	it.each(fixtures)("$name", async ({ payload, envOverrides, deps, expected }) => {
		const localOverrides: Record<string, string | undefined> = {};
		if (envOverrides) {
			for (const [key, value] of Object.entries(envOverrides)) {
				localOverrides[key] = process.env[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}

		try {
			const toPack = (text: string) => ({
				packText: text,
				items: text ? 1 : 0,
				packTokens: text ? text.length : 0,
			});
			const buildLocalPack = deps?.buildLocalPack
				? async (
						context: string,
						project: string | null,
						dbPath: string,
						workingSetPaths: string[] = [],
					) => {
						const result = deps.buildLocalPack?.(context, project, dbPath, workingSetPaths);
						return toPack(await Promise.resolve(result ?? ""));
					}
				: async () => toPack("");
			const httpPack = deps?.httpPack
				? async (context: string, project: string | null, maxTimeMs?: number) => {
						const result = deps.httpPack?.(context, project, maxTimeMs);
						return toPack(await Promise.resolve(result ?? ""));
					}
				: async () => toPack("");

			const result = await buildClaudeHookInjection(
				payload,
				{},
				{
					buildLocalPack,
					httpPack,
					resolveDb: () => "/tmp/contract.sqlite",
				},
			);

			expect(result).toEqual(expected);
		} finally {
			for (const [key, value] of Object.entries(localOverrides)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
