import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spoolPayload, spoolPayloadWithReceipt } from "./claude-hook-ingest-spool.js";
import { trackHookSessionState } from "./claude-hook-session-state.js";
import { ingestCodexHookPayload } from "./codex-hook-ingest.js";
import { spoolCodexHookPayload } from "./codex-hook-ingest-spool.js";
import { spoolPiHookPayload } from "./pi-hook-ingest-spool.js";

// Every write of a captured hook payload to disk happens after private blocks are gone.

const S = "SYNTHETIC_PRIVATE";
const pluginScript = (path: string) => new URL(`../../../../plugins/${path}`, import.meta.url).href;

/** The three places a private block reaches a spool: a prompt, a tool output and `cwd`. */
const nativePayloads = () => [
	{
		hook_event_name: "UserPromptSubmit",
		session_id: "private-session",
		timestamp: "2026-01-01T00:00:00Z",
		prompt: `fix the queue <private reason="key">${S}</private> now`,
		cwd: `/work/<private>${S}</private>repo`,
	},
	{
		hook_event_name: "PostToolUse",
		session_id: "private-session",
		tool_use_id: "tool-1",
		timestamp: "2026-01-01T00:00:01Z",
		tool_name: "Bash",
		tool_input: { command: "cat notes" },
		tool_response: { stdout: `notes <PRIVATE>${S}` },
		cwd: `/work/<private>${S}</private>repo`,
	},
];

let root: string;
const readDirectory = (directory: string) =>
	readdirSync(directory).map((name) => readFileSync(join(directory, name), "utf8"));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codemem-private-spool-"));
	for (const name of ["CLAUDE", "CODEX", "PI"]) {
		vi.stubEnv(`CODEMEM_${name}_HOOK_SPOOL_DIR`, join(root, `${name.toLowerCase()}-spool`));
		vi.stubEnv(`CODEMEM_${name}_HOOK_LOCK_DIR`, join(root, `${name.toLowerCase()}-lock`));
	}
	vi.stubEnv("CODEMEM_CLAUDE_HOOK_CONTEXT_DIR", join(root, "claude-context"));
	vi.stubEnv("CODEMEM_CODEX_RAW_EVENT_SPOOL_DIR", join(root, "codex-raw-event-spool"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function expectCleanSpool(entries: string[], count: number) {
	expect(entries).toHaveLength(count);
	for (const entry of entries) {
		expect(entry).not.toContain(S);
		expect(JSON.parse(entry)).toMatchObject({ session_id: "private-session" });
	}
	expect(entries.map((entry) => JSON.parse(entry).cwd)).toEqual(Array(count).fill("/work/repo"));
}

describe("CLI hook spools", () => {
	for (const [name, spool, directory] of [
		["Claude", spoolPayload, "claude-spool"],
		["Codex", spoolCodexHookPayload, "codex-spool"],
		["Pi", spoolPiHookPayload, "pi-spool"],
	] as const) {
		it(`writes no private text to the ${name} hook spool`, () => {
			for (const payload of nativePayloads()) expect(spool(payload)).toBe(true);

			expectCleanSpool(readDirectory(join(root, directory)), 2);
		});
	}

	it("writes no private text to the live receipt spool", () => {
		for (const payload of nativePayloads()) expect(spoolPayloadWithReceipt(payload)).not.toBeNull();

		const entries = readDirectory(join(root, "claude-spool"));
		expectCleanSpool(entries, 2);
		expect(
			JSON.parse(entries.find((entry) => entry.includes("tool_response")) ?? "{}"),
		).toMatchObject({ tool_use_id: "tool-1", tool_response: { stdout: "notes " } });
	});

	it("sends the same cleaned payload it would spool", async () => {
		let sent: Record<string, unknown> | undefined;
		await ingestCodexHookPayload(
			nativePayloads()[0] as Record<string, unknown>,
			{ host: "127.0.0.1", port: 38888, db: join(root, "unused.sqlite") },
			{
				httpIngest: async (request) => {
					sent = request;
					return { ok: true, inserted: 1, skipped: 0 };
				},
				resolveDb: () => join(root, "unused.sqlite"),
			},
		);

		expect(JSON.stringify(sent)).not.toContain(S);
		expect(sent).toMatchObject({ prompt: "fix the queue  now", cwd: "/work/repo" });
	});

	it("saves no private text in the Claude session state", () => {
		trackHookSessionState(nativePayloads()[0] as Record<string, unknown>);
		trackHookSessionState({
			hook_event_name: "PostToolUse",
			session_id: "private-session",
			tool_name: "Write",
			tool_input: { file_path: `src/<private>${S}</private>a.ts` },
		});

		const [state] = readDirectory(join(root, "claude-context"));
		expect(state).not.toContain(S);
		expect(JSON.parse(state ?? "{}")).toMatchObject({
			first_prompt: "fix the queue  now",
			files_modified: ["src/a.ts"],
		});
	});
});

describe("plugin hook spools", () => {
	it("writes no private text to the Codex plugin's raw-event spool", async () => {
		const ingestHook = await import(pluginScript("codex/scripts/ingest-hook.mjs"));
		const spooled: string[] = [];
		for (const payload of nativePayloads()) {
			await ingestHook.runCodexIngestHook({
				readInput: async () => JSON.stringify(payload),
				postEnvelope: async () => false,
				spoolEnvelope: (body: string) => {
					spooled.push(body);
					return null;
				},
				runFallback: () => false,
				writeOutput: () => {},
			});
		}

		expect(spooled).toHaveLength(2);
		for (const body of spooled) {
			expect(body).not.toContain(S);
			expect(JSON.parse(body)).toMatchObject({ cwd: "/work/repo" });
		}
		expect(spooled.join("\n")).toContain("notes ");
	});

	it("writes no private text to the Codex plugin's hook spool", async () => {
		const promptHook = await import(pluginScript("codex/scripts/user-prompt-hook.mjs"));
		const directory = join(root, "codex-plugin-hook-spool");
		for (const payload of nativePayloads()) {
			promptHook.spoolPayload(JSON.stringify(payload), { CODEMEM_CODEX_HOOK_SPOOL_DIR: directory });
		}

		expectCleanSpool(readDirectory(directory), 2);
	});

	it("spools a Codex payload without markers byte for byte", async () => {
		const promptHook = await import(pluginScript("codex/scripts/user-prompt-hook.mjs"));
		const directory = join(root, "codex-plugin-plain-spool");
		const raw = '{ "hook_event_name": "UserPromptSubmit", "prompt": "plain", "timestamp": "t" }';
		promptHook.spoolPayload(raw, { CODEMEM_CODEX_HOOK_SPOOL_DIR: directory });

		expect(readDirectory(directory)).toEqual([raw]);
	});

	it("saves no private text in the Claude plugin's session state", async () => {
		const promptHook = await import(pluginScript("claude/scripts/user-prompt-hook.mjs"));
		const env = { CODEMEM_CLAUDE_HOOK_CONTEXT_DIR: join(root, "claude-plugin-context") };
		promptHook.trackClaudeSessionState(nativePayloads()[0], env);
		promptHook.trackClaudeSessionState(
			{
				hook_event_name: "PostToolUse",
				session_id: "private-session",
				tool_name: "Write",
				tool_input: { file_path: `src/<private>${S}</private>a.ts` },
			},
			env,
		);

		const [state] = readDirectory(join(root, "claude-plugin-context"));
		expect(state).not.toContain(S);
		expect(JSON.parse(state ?? "{}")).toMatchObject({
			first_prompt: "fix the queue  now",
			files_modified: ["src/a.ts"],
		});
	});
});
