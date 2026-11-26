import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTieredObserverConfig } from "./extraction-tier-routing.js";
import { loadObserverConfig, ObserverAuthError, ObserverClient } from "./observer-client.js";

/*
 * The Claude session runtime runs a fake `claude` executable that records its argv,
 * stdin, working directory and environment, then answers like `claude -p
 * --output-format json`. No real Claude call is made.
 */

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
	const argv = process.argv.slice(2);
	appendFileSync(process.env.FAKE_CLAUDE_CAPTURE, JSON.stringify({
		argv,
		stdin: input,
		cwd: process.cwd(),
		pluginIgnore: process.env.CODEMEM_PLUGIN_IGNORE ?? null,
		claudeCode: process.env.CLAUDECODE ?? null,
	}) + "\\n");
	const mode = process.env.FAKE_CLAUDE_MODE;
	if (mode === "expired") {
		process.stdout.write(JSON.stringify({
			type: "result", is_error: true,
			result: "this login reached its time limit and cannot be renewed",
		}));
		process.exit(1);
	}
	if (mode === "old-cli" && argv.includes("--safe-mode")) {
		process.stderr.write("error: unknown option '--no-session-persistence'\\n");
		process.exit(1);
	}
	if (mode === "reject-effort" && argv.includes("--effort")) {
		process.stderr.write("error: --effort is not supported for this model\\n");
		process.exit(1);
	}
	process.stdout.write(JSON.stringify({
		type: "result", subtype: "success", is_error: false,
		result: "<skip_summary reason=\\"low-signal\\"/>",
		model: "claude-sonnet-4-6",
		usage: {
			input_tokens: 1200, output_tokens: 40,
			cache_read_input_tokens: 300, cache_creation_input_tokens: 50,
		},
	}));
});
`;

interface Captured {
	argv: string[];
	stdin: string;
	cwd: string;
	pluginIgnore: string | null;
	claudeCode: string | null;
}

let home: string;
let capture: string;
let executable: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codemem-claude-sidecar-"));
	capture = join(home, "capture.jsonl");
	executable = join(home, "claude");
	writeFileSync(executable, FAKE_CLAUDE);
	chmodSync(executable, 0o755);
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_CONFIG", join(home, "config.json"));
	vi.stubEnv("FAKE_CLAUDE_CAPTURE", capture);
	vi.stubEnv("CLAUDECODE", "1");
	for (const key of [
		"CODEMEM_OBSERVER_RUNTIME",
		"CODEMEM_OBSERVER_REASONING_EFFORT",
		"CODEMEM_OBSERVER_RICH_REASONING_EFFORT",
		"FAKE_CLAUDE_MODE",
	])
		vi.stubEnv(key, undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

function claudeObserver(settings: Record<string, unknown> = {}) {
	return new ObserverClient(
		loadObserverConfig({
			observer_runtime: "claude_sidecar",
			observer_provider: "anthropic",
			observer_model: "claude-sonnet-4-6",
			observer_tier_routing_enabled: false,
			claude_command: [executable],
			...settings,
		}),
	);
}

const calls = (): Captured[] =>
	readFileSync(capture, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Captured);

describe.skipIf(process.platform === "win32")("the Claude session runtime", () => {
	it("sends the prompt on stdin and keeps argv to flags", async () => {
		await claudeObserver().observe("SYSTEM_PROMPT", "USER_PROMPT");

		const [call] = calls();
		expect(call?.stdin).toBe("SYSTEM_PROMPT\n\nUSER_PROMPT");
		expect(call?.argv.join(" ")).not.toContain("PROMPT");
		expect(call?.argv).toEqual(
			expect.arrayContaining(["-p", "--output-format", "json", "--model", "claude-sonnet-4-6"]),
		);
	});

	it("runs isolated from the user's sessions, instructions, tools and MCP servers", async () => {
		await claudeObserver().observe("system", "user");

		const [call] = calls();
		expect(call?.argv).toEqual(
			expect.arrayContaining(["--no-session-persistence", "--safe-mode", "--tools", ""]),
		);
		expect(call?.cwd).toBe(realpathSync(join(home, ".codemem", "claude-observer")));
		expect(call?.pluginIgnore).toBe("1");
		expect(call?.claudeCode).toBeNull();
	});

	it("keeps the token usage the CLI reports", async () => {
		const result = await claudeObserver().observe("system", "user");

		expect(result.usage).toEqual({
			inputTokens: 1200,
			outputTokens: 40,
			cacheReadInputTokens: 300,
			cacheCreationInputTokens: 50,
		});
	});

	it("passes a configured effort and sends none when unset", async () => {
		const configured = claudeObserver({ observer_reasoning_effort: "high" });
		await configured.observe("system", "user");
		await claudeObserver().observe("system", "user");

		const [withEffort, withoutEffort] = calls();
		expect(withEffort?.argv.slice(withEffort.argv.indexOf("--effort"))).toEqual([
			"--effort",
			"high",
		]);
		expect(withoutEffort?.argv).not.toContain("--effort");
		expect(configured.getStatus()).toMatchObject({
			requestedReasoningEffort: "high",
			actualReasoningEffort: "high",
			reasoningEffortFallbackApplied: false,
		});
	});

	it("passes the rich tier's configured effort, never a tier default", async () => {
		const base = claudeObserver({
			observer_tier_routing_enabled: true,
			observer_rich_reasoning_effort: "xhigh",
		}).toConfig();
		const rich = new ObserverClient(
			buildTieredObserverConfig(base, { tier: "rich", observer: {}, reasons: [] }),
		);
		const simple = new ObserverClient(
			buildTieredObserverConfig(base, { tier: "simple", observer: {}, reasons: [] }),
		);

		await rich.observe("system", "user");
		await simple.observe("system", "user");

		const [richCall, simpleCall] = calls();
		expect(richCall?.argv).toEqual(expect.arrayContaining(["--effort", "xhigh"]));
		expect(simpleCall?.argv).not.toContain("--effort");
	});

	it("retries once without an effort the CLI refuses and reports the fallback", async () => {
		vi.stubEnv("FAKE_CLAUDE_MODE", "reject-effort");
		const observer = claudeObserver({ observer_reasoning_effort: "max" });

		const result = await observer.observe("system", "user");

		expect(result.raw).toContain("skip_summary");
		expect(calls().map((call) => call.argv.includes("--effort"))).toEqual([true, false]);
		expect(observer.getStatus()).toMatchObject({
			requestedReasoningEffort: "max",
			attemptedReasoningEffort: "max",
			actualReasoningEffort: null,
			reasoningEffortFallbackApplied: true,
			reasoningEffortFallbackReason: "effort_rejected",
		});
	});

	it("reports an effort the CLI has no value for without sending it", async () => {
		const observer = claudeObserver({ observer_reasoning_effort: "none" });

		await observer.observe("system", "user");

		expect(calls()[0]?.argv).not.toContain("--effort");
		expect(observer.getStatus()).toMatchObject({
			reasoningEffortFallbackApplied: true,
			reasoningEffortFallbackReason: "effort_not_supported",
		});
	});

	it("retries once without the isolation flags on a CLI too old to know them", async () => {
		vi.stubEnv("FAKE_CLAUDE_MODE", "old-cli");
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await claudeObserver().observe("system", "user");

		expect(result.raw).toContain("skip_summary");
		expect(calls().map((call) => call.argv.includes("--safe-mode"))).toEqual([true, false]);
		expect(calls()[1]?.stdin).toBe("system\n\nuser");
	});

	it("says plainly that the CLI is not signed in", async () => {
		vi.stubEnv("FAKE_CLAUDE_MODE", "expired");
		const observer = claudeObserver();

		await expect(observer.observe("system", "user")).rejects.toBeInstanceOf(ObserverAuthError);

		expect(observer.getStatus().lastError).toMatchObject({
			code: "auth_failed",
			message: "Claude CLI is not signed in; run `claude auth login`.",
		});
	});
});
