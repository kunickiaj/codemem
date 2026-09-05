import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	buildViewerIdentityTarget,
	classifyPromptTransportFailure as classifyCorePromptTransportFailure,
	type PromptTransportFailure,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const hook = await import(
	new URL("../../../../plugins/claude/scripts/user-prompt-hook.mjs", import.meta.url).href
);
const ingestHook = await import(
	new URL("../../../../plugins/claude/scripts/ingest-hook.mjs", import.meta.url).href
);

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("dependency-free Claude user prompt hook", () => {
	let root: string;
	let env: Record<string, string>;
	let identity: Record<string, unknown>;
	let dbPath: string;
	let payload: Record<string, unknown>;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "codemem-claude-prompt-hook-"));
		dbPath = join(root, "mem.sqlite");
		env = {
			HOME: root,
			CODEMEM_DB: dbPath,
			CODEMEM_PROJECT: "codemem",
			CODEMEM_CLAUDE_HOOK_CONTEXT_DIR: join(root, "state"),
			CODEMEM_VIEWER_HOST: "127.0.0.1",
			CODEMEM_VIEWER_PORT: "38888",
		};
		identity = {
			device_id: null,
			actor_id_present: false,
			actor_id: null,
			config_path: null,
			runtime_root: null,
			workspace_id: null,
			home_dir: root,
			pack_compression: null,
			embedding_disabled: false,
			embedding_offline: false,
			embedding_model: "Xenova/bge-small-en-v1.5",
			embedding_revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
		};
		payload = {
			hook_event_name: "UserPromptSubmit",
			session_id: "claude-session",
			prompt: "now check the fixture",
			cwd: root,
			project: "codemem",
		};
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("builds Viewer URLs only for explicit loopback hosts", () => {
		expect(hook.viewerBaseUrl({ CODEMEM_VIEWER_PORT: "4000" })).toBe("http://127.0.0.1:4000");
		expect(
			hook.viewerBaseUrl({ CODEMEM_VIEWER_HOST: "localhost", CODEMEM_VIEWER_PORT: "4000" }),
		).toBe("http://localhost:4000");
		expect(
			hook.viewerBaseUrl({ CODEMEM_VIEWER_HOST: "127.0.0.2", CODEMEM_VIEWER_PORT: "4000" }),
		).toBe("http://127.0.0.2:4000");
		expect(hook.viewerBaseUrl({ CODEMEM_VIEWER_HOST: "::1", CODEMEM_VIEWER_PORT: "4000" })).toBe(
			"http://[::1]:4000",
		);
		expect(hook.viewerBaseUrl({ CODEMEM_VIEWER_HOST: "192.168.1.10" })).toBeNull();
		expect(hook.viewerBaseUrl({ CODEMEM_VIEWER_HOST: "viewer.example.com" })).toBeNull();
	});

	it("matches the core identity-target contract for absolute paths", () => {
		const controlledEnv = {
			HOME: join(root, "home"),
			CODEMEM_DEVICE_ID: "device-1",
			CODEMEM_ACTOR_ID: "actor-1",
			CODEMEM_CONFIG: join(root, "config.toml"),
			CODEMEM_RUNTIME_ROOT: join(root, "runtime"),
			CODEMEM_WORKSPACE_ID: "workspace-1",
			CODEMEM_PACK_COMPRESSION: "ids",
			CODEMEM_EMBEDDING_DISABLED: "true",
			CODEMEM_EMBEDDING_OFFLINE: "YeS",
			CODEMEM_EMBEDDING_MODEL: "model-1",
			CODEMEM_EMBEDDING_REVISION: "abcdef1234567890abcdef1234567890abcdef12",
		};
		expect(hook.identityTarget(root, controlledEnv)).toEqual(
			buildViewerIdentityTarget(controlledEnv),
		);
	});

	it("keeps a missing custom-model revision non-throwing and explicit", () => {
		expect(
			hook.identityTarget(root, {
				HOME: root,
				CODEMEM_EMBEDDING_MODEL: "custom/model",
				CODEMEM_EMBEDDING_REVISION: "   ",
			}),
		).toMatchObject({
			embedding_model: "custom/model",
			embedding_revision: null,
		});
	});

	it("retains a mutable revision to match the core identity target", () => {
		const mutableEnv = {
			HOME: root,
			CODEMEM_EMBEDDING_MODEL: "custom/model",
			CODEMEM_EMBEDDING_REVISION: "main",
		};
		expect(hook.identityTarget(root, mutableEnv)).toMatchObject({
			embedding_model: "custom/model",
			embedding_revision: "main",
		});
		expect(hook.identityTarget(root, mutableEnv)).toEqual(buildViewerIdentityTarget(mutableEnv));
	});

	it("rejects event-ingest redirects without following them", async () => {
		let requestInit: RequestInit | undefined;
		await expect(
			ingestHook.postEnvelope("{}", {
				env,
				fetchImpl: async (_input: string | URL, init?: RequestInit) => {
					requestInit = init;
					return new Response(null, {
						status: 307,
						headers: { Location: "https://example.com/events" },
					});
				},
			}),
		).resolves.toBe(false);
		expect(requestInit?.redirect).toBe("manual");
	});

	it("targets Claude raw-event requests at the configured database identity", async () => {
		let requestBody: Record<string, unknown> | undefined;
		await expect(
			ingestHook.postEnvelope(JSON.stringify({ cwd: root, event_type: "prompt" }), {
				env,
				fetchImpl: async (_input: string | URL, init?: RequestInit) => {
					requestBody = JSON.parse(String(init?.body));
					return jsonResponse({ inserted: 1, skipped: 0 });
				},
			}),
		).resolves.toBe(true);
		expect(requestBody).toMatchObject({ db_path: dbPath, identity_target: identity });
	});

	it("uses the Claude command fallback once without retrying a mismatched Viewer", async () => {
		let postCalls = 0;
		let fallbackCalls = 0;
		const result = await ingestHook.runClaudeIngestHook({
			env,
			readInput: async () =>
				JSON.stringify({ hook_event_name: "SessionEnd", session_id: "claude-session", cwd: root }),
			postEnvelope: async () => {
				postCalls += 1;
				return "target_mismatch";
			},
			runFallback: () => {
				fallbackCalls += 1;
				return true;
			},
		});

		expect(result).toBe(0);
		expect({ postCalls, fallbackCalls }).toEqual({ postCalls: 1, fallbackCalls: 1 });
	});

	it("marks only configured Claude boundary events for synchronous Viewer flushing", async () => {
		expect(ingestHook.shouldForceBoundaryFlush({ hook_event_name: "SessionEnd" }, {})).toBe(true);
		expect(
			ingestHook.shouldForceBoundaryFlush(
				{ hook_event_name: "SessionEnd" },
				{ CODEMEM_CLAUDE_HOOK_FLUSH: "0" },
			),
		).toBe(false);
		expect(
			ingestHook.shouldForceBoundaryFlush(
				{ hook_event_name: "Stop" },
				{ CODEMEM_CLAUDE_HOOK_FLUSH: "1", CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP: "1" },
			),
		).toBe(true);
		expect(
			ingestHook.shouldForceBoundaryFlush(
				{ hook_event_name: "SessionEnd" },
				{ CODEMEM_CLAUDE_HOOK_FLUSH: "" },
			),
		).toBe(true);

		let requestHeaders: Headers | undefined;
		await expect(
			ingestHook.postEnvelope("{}", {
				env,
				flushBoundary: true,
				fetchImpl: async (_input: string | URL, init?: RequestInit) => {
					requestHeaders = new Headers(init?.headers);
					return jsonResponse({ inserted: 1, skipped: 0 });
				},
			}),
		).resolves.toBe(true);
		expect(requestHeaders?.get("x-codemem-boundary-flush")).toBe("1");
		expect(ingestHook.boundaryTimeoutMs({ hook_event_name: "SessionEnd" }, {})).toBe(950);
		expect(
			ingestHook.boundaryTimeoutMs(
				{ hook_event_name: "SessionEnd" },
				{ CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "60000" },
			),
		).toBe(54_950);
		expect(ingestHook.boundaryTimeoutMs({ hook_event_name: "Stop" }, {})).toBe(119_950);
		expect(
			ingestHook.boundaryTimeoutMs(
				{ hook_event_name: "SessionEnd" },
				{ CODEMEM_CLAUDE_HOOK_BOUNDARY_TIMEOUT_MS: "60000" },
			),
		).toBe(950);
	});

	it("keeps the packaged Stop hook timeout above its boundary execution budget", () => {
		const manifest = JSON.parse(
			readFileSync(new URL("../../../../plugins/claude/hooks/hooks.json", import.meta.url), "utf8"),
		) as {
			hooks?: {
				Stop?: Array<{ hooks?: Array<{ type?: string; timeout?: number }> }>;
			};
		};
		const stopCommands =
			manifest.hooks?.Stop?.flatMap((group) => group.hooks ?? []).filter(
				(hook) => hook.type === "command",
			) ?? [];

		expect(stopCommands).toHaveLength(1);
		expect(stopCommands[0]?.timeout).toBe(130);
		const executionBudgetMs = ingestHook.boundaryExecutionBudgetMs({ hook_event_name: "Stop" }, {});
		expect((stopCommands[0]?.timeout ?? 0) * 1000 - executionBudgetMs).toBeGreaterThanOrEqual(5000);
	});

	it("keeps SessionEnd retries and command fallbacks inside the host execution budget", async () => {
		let elapsedMs = 0;
		const postTimeouts: number[] = [];
		const fallbackTimeouts: number[] = [];
		const result = await ingestHook.runClaudeIngestHook({
			env: { ...env, CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "1500" },
			readInput: async () =>
				JSON.stringify({ hook_event_name: "SessionEnd", session_id: "claude-session", cwd: root }),
			now: () => elapsedMs,
			postEnvelope: async (_body: string, options: { timeoutMs: number }) => {
				postTimeouts.push(options.timeoutMs);
				elapsedMs += postTimeouts.length === 1 ? options.timeoutMs : 100;
				return false;
			},
			runFallback: (_command: string, _args: string[], _body: string, timeoutMs: number) => {
				fallbackTimeouts.push(timeoutMs);
				elapsedMs += timeoutMs;
				return false;
			},
		});

		expect(result).toBe(1);
		expect(postTimeouts).toEqual([950]);
		expect(fallbackTimeouts).toEqual([500]);
		expect(elapsedMs).toBe(1450);
	});

	it("reserves command fallback time when a boundary retry stalls", async () => {
		let elapsedMs = 0;
		const postTimeouts: number[] = [];
		const fallbackTimeouts: number[] = [];
		const result = await ingestHook.runClaudeIngestHook({
			env: { ...env, CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "1500" },
			readInput: async () =>
				JSON.stringify({ hook_event_name: "SessionEnd", session_id: "claude-session", cwd: root }),
			now: () => elapsedMs,
			postEnvelope: async (_body: string, options: { timeoutMs: number }) => {
				postTimeouts.push(options.timeoutMs);
				elapsedMs += postTimeouts.length === 1 ? 100 : options.timeoutMs;
				return false;
			},
			runFallback: (_command: string, _args: string[], _body: string, timeoutMs: number) => {
				fallbackTimeouts.push(timeoutMs);
				elapsedMs += timeoutMs;
				return false;
			},
		});

		expect(result).toBe(1);
		expect(postTimeouts).toEqual([950, 850]);
		expect(fallbackTimeouts).toEqual([500]);
		expect(elapsedMs).toBe(1450);
	});

	it("reserves command fallback time after boundary preprocessing", async () => {
		let elapsedMs = 0;
		const postTimeouts: number[] = [];
		const fallbackTimeouts: number[] = [];
		const result = await ingestHook.runClaudeIngestHook({
			env: { ...env, CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "1500" },
			readInput: async () => {
				elapsedMs += 400;
				return JSON.stringify({
					hook_event_name: "SessionEnd",
					session_id: "claude-session",
					cwd: root,
				});
			},
			now: () => elapsedMs,
			postEnvelope: async (_body: string, options: { timeoutMs: number }) => {
				postTimeouts.push(options.timeoutMs);
				elapsedMs += options.timeoutMs;
				return false;
			},
			runFallback: (_command: string, _args: string[], _body: string, timeoutMs: number) => {
				fallbackTimeouts.push(timeoutMs);
				elapsedMs += timeoutMs;
				return false;
			},
		});

		expect(result).toBe(1);
		expect(postTimeouts).toEqual([550]);
		expect(fallbackTimeouts).toEqual([500]);
		expect(elapsedMs).toBe(1450);
	});

	it("preserves command fallback time with a sub-500ms host budget", async () => {
		let elapsedMs = 0;
		const postTimeouts: number[] = [];
		const fallbackTimeouts: number[] = [];
		const result = await ingestHook.runClaudeIngestHook({
			env: { ...env, CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: "300" },
			readInput: async () =>
				JSON.stringify({ hook_event_name: "SessionEnd", session_id: "claude-session", cwd: root }),
			now: () => elapsedMs,
			postEnvelope: async (_body: string, options: { timeoutMs: number }) => {
				postTimeouts.push(options.timeoutMs);
				elapsedMs += options.timeoutMs;
				return false;
			},
			runFallback: (_command: string, _args: string[], _body: string, timeoutMs: number) => {
				fallbackTimeouts.push(timeoutMs);
				elapsedMs += timeoutMs;
				return false;
			},
		});

		expect(result).toBe(1);
		expect(postTimeouts).toEqual([125]);
		expect(fallbackTimeouts).toEqual([125]);
		expect(elapsedMs).toBe(250);
	});

	it("uses only one HTTP attempt for ordinary non-boundary events", async () => {
		let postCalls = 0;
		let fallbackCalls = 0;
		const result = await ingestHook.runClaudeIngestHook({
			env,
			readInput: async () =>
				JSON.stringify({
					hook_event_name: "SessionStart",
					session_id: "claude-session",
					cwd: root,
				}),
			postEnvelope: async () => {
				postCalls += 1;
				return false;
			},
			runFallback: () => {
				fallbackCalls += 1;
				return true;
			},
		});

		expect(result).toBe(0);
		expect(postCalls).toBe(1);
		expect(fallbackCalls).toBe(1);
	});

	it("keeps opt-in Stop retries and fallbacks inside one boundary budget", async () => {
		let elapsedMs = 0;
		const postTimeouts: number[] = [];
		const fallbackTimeouts: number[] = [];
		const result = await ingestHook.runClaudeIngestHook({
			env: {
				...env,
				CODEMEM_CLAUDE_HOOK_FLUSH: "1",
				CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP: "1",
				CODEMEM_CLAUDE_HOOK_BOUNDARY_TIMEOUT_MS: "1000",
			},
			readInput: async () =>
				JSON.stringify({
					hook_event_name: "Stop",
					session_id: "claude-session",
					cwd: root,
					last_assistant_message: "finished",
				}),
			now: () => elapsedMs,
			postEnvelope: async (_body: string, options: { timeoutMs: number }) => {
				postTimeouts.push(options.timeoutMs);
				elapsedMs += options.timeoutMs;
				return false;
			},
			runFallback: (_command: string, _args: string[], _body: string, timeoutMs: number) => {
				fallbackTimeouts.push(timeoutMs);
				elapsedMs += timeoutMs;
				return false;
			},
		});

		expect(result).toBe(1);
		expect(postTimeouts).toEqual([475]);
		expect(fallbackTimeouts).toEqual([475]);
		expect(elapsedMs).toBe(950);
	});

	it("fails closed without fetching or falling back for a non-loopback Viewer host", async () => {
		env.CODEMEM_VIEWER_HOST = "viewer.example.com";
		const output: string[] = [];
		let fetchCalls = 0;
		let fallbackCalls = 0;
		await hook.runClaudeUserPromptHook(JSON.stringify(payload), {
			env,
			fetchImpl: async () => {
				fetchCalls += 1;
				return jsonResponse({});
			},
			writeOutput: (value: string) => output.push(value),
			spawnIngestion: () => {},
			runFallback: () => {
				fallbackCalls += 1;
				return { continue: true };
			},
		});

		expect({ output, fetchCalls, fallbackCalls }).toEqual({
			output: ['{"continue":true}'],
			fetchCalls: 0,
			fallbackCalls: 0,
		});
	});

	it("preserves query, working-set, truncation, output bytes, and ledger ordering", async () => {
		hook.trackClaudeSessionState(
			{
				hook_event_name: "UserPromptSubmit",
				session_id: "claude-session",
				prompt: "investigate flaky test",
			},
			env,
		);
		hook.trackClaudeSessionState(
			{
				hook_event_name: "PostToolUse",
				session_id: "claude-session",
				tool_name: "Edit",
				tool_input: { filePath: "packages/cli/src/example.ts" },
			},
			env,
		);
		env.CODEMEM_INJECT_MAX_CHARS = "12";

		const requests: Array<{
			path: string;
			body: Record<string, unknown> | null;
			signal: AbortSignal | null | undefined;
		}> = [];
		const output: string[] = [];
		let fallbackCalls = 0;
		let ingestionCalls = 0;
		const fetchImpl = async (input: string | URL, init?: RequestInit) => {
			const path = new URL(String(input)).pathname;
			const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
			requests.push({ path, body, signal: init?.signal });
			if (path === "/api/prompt-pack-profile") {
				return jsonResponse({
					service: "codemem-viewer",
					protocol_version: 1,
					min_supported_protocol_version: 1,
					db_path: dbPath,
					identity_target: identity,
				});
			}
			if (path === "/api/pack") {
				return jsonResponse({
					pack_text: "12345678901234567890",
					metrics: { total_items: 1, pack_tokens: 10 },
				});
			}
			expect(output).toEqual([
				'{"continue":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"123456789012\\n\\n[pack truncated]"}}',
			]);
			return jsonResponse({ ok: true });
		};

		await hook.runClaudeUserPromptHook(JSON.stringify(payload), {
			env,
			fetchImpl,
			writeOutput: (value: string) => output.push(value),
			spawnIngestion: () => {
				ingestionCalls += 1;
			},
			runFallback: () => {
				fallbackCalls += 1;
				return null;
			},
			now: () => new Date("2026-08-16T00:00:00.000Z"),
			uuid: (() => {
				const values = ["attempt-id", "request-id"];
				return () => values.shift() ?? "unexpected-id";
			})(),
		});

		expect(requests.map((request) => request.path)).toEqual([
			"/api/prompt-pack-profile",
			"/api/pack",
			"/api/prompt-pack-ledger",
		]);
		expect(requests[0]?.body).toBeNull();
		expect(requests[0]?.signal).not.toBe(requests[1]?.signal);
		expect(requests[1]?.body).toMatchObject({
			context: "investigate flaky test now check the fixture codemem example.ts",
			working_set_files: ["packages/cli/src/example.ts"],
			attempt: {
				attempt_id: "attempt-id",
				source: "claude",
				stream_id: "claude-session",
				request_id: "request-id",
			},
		});
		expect(requests[2]?.body).toMatchObject({
			action: "delivery",
			attempt_id: "attempt-id",
			delivery_status: "handed_off",
		});
		expect({ fallbackCalls, ingestionCalls }).toEqual({
			fallbackCalls: 0,
			ingestionCalls: 1,
		});
	});

	it.each([
		{
			label: "an old v1 client against a current Viewer range",
			clientRange: { minSupportedProtocolVersion: 1, protocolVersion: 1 },
			profile: { protocol_version: 2, min_supported_protocol_version: 1 },
		},
		{
			label: "a newer v2 client against a stale single-version Viewer",
			clientRange: { minSupportedProtocolVersion: 1, protocolVersion: 2 },
			profile: { protocol_version: 1 },
		},
	])("uses direct pack and ledger transport for $label", async ({ clientRange, profile }) => {
		const requestPaths: string[] = [];
		const output: string[] = [];
		let ledgerBody: Record<string, unknown> | null = null;
		let fallbackCalls = 0;
		await hook.runClaudeUserPromptHook(JSON.stringify(payload), {
			env,
			protocolRange: clientRange,
			fetchImpl: async (input: string | URL, init?: RequestInit) => {
				const path = new URL(String(input)).pathname;
				requestPaths.push(path);
				if (path.endsWith("profile")) {
					return jsonResponse({
						service: "codemem-viewer",
						...profile,
						db_path: dbPath,
						identity_target: identity,
					});
				}
				if (path.endsWith("pack")) {
					return jsonResponse({ pack_text: "SKEW_PACK", metrics: { total_items: 1 } });
				}
				ledgerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return jsonResponse({ ok: true });
			},
			writeOutput: (value: string) => output.push(value),
			spawnIngestion: () => {},
			runFallback: () => {
				fallbackCalls += 1;
				return { continue: true };
			},
		});

		expect(requestPaths).toEqual([
			"/api/prompt-pack-profile",
			"/api/pack",
			"/api/prompt-pack-ledger",
		]);
		expect(output[0]).toContain("SKEW_PACK");
		expect(ledgerBody).toMatchObject({ action: "delivery", delivery_status: "handed_off" });
		expect(fallbackCalls).toBe(0);
	});

	it("drops working-set paths that the Viewer would reject", async () => {
		for (const filePath of ["a/../../b", String.raw`C:\foo\bar`]) {
			hook.trackClaudeSessionState(
				{
					hook_event_name: "PostToolUse",
					session_id: "claude-session",
					tool_name: "Edit",
					tool_input: { filePath },
				},
				env,
			);
		}
		let packBody: Record<string, unknown> | null = null;
		await hook.runClaudeUserPromptHook(JSON.stringify(payload), {
			env,
			fetchImpl: async (input: string | URL, init?: RequestInit) => {
				const path = new URL(String(input)).pathname;
				if (path.endsWith("profile")) {
					return jsonResponse({
						service: "codemem-viewer",
						protocol_version: 1,
						min_supported_protocol_version: 1,
						db_path: dbPath,
						identity_target: identity,
					});
				}
				if (path.endsWith("pack")) {
					packBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return jsonResponse({ pack_text: "PACK_BYTES", metrics: { total_items: 1 } });
				}
				return jsonResponse({ ok: true });
			},
			writeOutput: () => {},
			spawnIngestion: () => {},
			runFallback: () => null,
		});

		expect(packBody).toMatchObject({ working_set_files: [] });
	});

	it.each([
		["delivered", { action: "delivery", delivery_status: "handed_off" }],
		["empty", { action: "delivery", delivery_status: "unknown" }],
		["skipped", { action: "record", retrieval_status: "skipped" }],
		["cached", { action: "cache_reuse", original_attempt_id: "original-attempt" }],
		["failed", { action: "record", retrieval_status: "failed" }],
	] as const)("sends the %s state to the ledger", async (state, expected) => {
		let ledgerBody: Record<string, unknown> | null = null;
		const ok = await hook.recordClaudePromptLedgerState(
			state,
			{
				attempt: {
					attempt_id: "attempt-id",
					started_at: "2026-08-16T00:00:00.000Z",
					source: "claude",
					request_id: "request-id",
				},
				details: { originalAttemptId: "original-attempt" },
				env,
				dbPath,
				identity,
			},
			{
				fetchImpl: async (_input: string | URL, init?: RequestInit) => {
					ledgerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return jsonResponse({ ok: true });
				},
			},
		);

		expect(ok).toBe(true);
		expect(ledgerBody).toMatchObject(expected);
	});

	it("falls back once for a stale profile and fails closed for a compatible contract defect", async () => {
		const fallbackPayloads: string[] = [];
		const output: string[] = [];
		const profile = {
			service: "codemem-viewer",
			protocol_version: 1,
			min_supported_protocol_version: 1,
			db_path: dbPath,
			identity_target: identity,
		};
		const runFallback = (raw: string) => {
			fallbackPayloads.push(raw);
			return { continue: true };
		};

		await hook.runClaudeUserPromptHook(JSON.stringify(payload), {
			env,
			fetchImpl: async () => jsonResponse({ error: { code: "not_found" } }, 404),
			writeOutput: (value: string) => output.push(value),
			spawnIngestion: () => {},
			runFallback,
		});
		expect(fallbackPayloads).toHaveLength(1);

		fallbackPayloads.length = 0;
		await hook.runClaudeUserPromptHook(JSON.stringify(payload), {
			env,
			fetchImpl: async (input: string | URL) =>
				new URL(String(input)).pathname.endsWith("profile")
					? jsonResponse(profile)
					: jsonResponse({ error: { code: "viewer_contract_unsupported" } }, 409),
			writeOutput: (value: string) => output.push(value),
			spawnIngestion: () => {},
			runFallback,
		});
		expect(fallbackPayloads).toHaveLength(0);
	});

	it.each([
		{ kind: "profile_absent" },
		{ kind: "profile_malformed" },
		{ kind: "protocol_range_mismatch" },
		{ kind: "network_unavailable" },
		{ kind: "network_timeout" },
		{ kind: "network_reset" },
		{ kind: "viewer_restart" },
		{ kind: "malformed_response" },
		{ kind: "database_mismatch" },
		{ kind: "runtime_identity_mismatch" },
		{ kind: "invalid_request", compatibleProfile: false },
		{ kind: "invalid_request", compatibleProfile: true },
		{ kind: "policy_failure" },
		{ kind: "authorization_failure" },
		{ kind: "viewer_contract_unsupported", compatibleProfile: false },
		{ kind: "viewer_contract_unsupported", compatibleProfile: true },
	] satisfies PromptTransportFailure[])('matches the core classifier for "$kind"', (failure) => {
		expect(hook.classifyPromptTransportFailure(failure)).toBe(
			classifyCorePromptTransportFailure(failure),
		);
	});

	it.each([
		["before", false, 1, ["/api/prompt-pack-profile"]],
		["after", true, 0, ["/api/prompt-pack-profile", "/api/pack", "/api/prompt-pack-ledger"]],
	] as const)(
		"handles invalid_request %s a compatible profile",
		async (_label, compatibleProfile, expectedFallbackCalls, expectedRequestPaths) => {
			// Arrange
			const requestPaths: string[] = [];
			let fallbackCalls = 0;

			// Act
			await hook.runClaudeUserPromptHook(JSON.stringify(payload), {
				env,
				fetchImpl: async (input: string | URL) => {
					const path = new URL(String(input)).pathname;
					requestPaths.push(path);
					if (compatibleProfile && path.endsWith("profile")) {
						return jsonResponse({
							service: "codemem-viewer",
							protocol_version: 1,
							min_supported_protocol_version: 1,
							db_path: dbPath,
							identity_target: identity,
						});
					}
					return jsonResponse({ error: { code: "invalid_request" } }, 400);
				},
				writeOutput: () => {},
				spawnIngestion: () => {},
				runFallback: () => {
					fallbackCalls += 1;
					return { continue: true };
				},
			});

			// Assert
			expect(requestPaths).toEqual(expectedRequestPaths);
			expect(fallbackCalls).toBe(expectedFallbackCalls);
		},
	);

	it("records disabled injection without probing the pack profile", async () => {
		env.CODEMEM_INJECT_CONTEXT = "0";
		const output: string[] = [];
		const requestPaths: string[] = [];
		await hook.runClaudeUserPromptHook(JSON.stringify(payload), {
			env,
			fetchImpl: async (input: string | URL) => {
				requestPaths.push(new URL(String(input)).pathname);
				expect(output).toEqual(['{"continue":true}']);
				return jsonResponse({ ok: true });
			},
			writeOutput: (value: string) => output.push(value),
			spawnIngestion: () => {},
		});

		expect(requestPaths).toEqual(["/api/prompt-pack-ledger"]);
	});

	it("writes host output before a ledger timeout and caps the deadline at 500 ms", async () => {
		const output: string[] = [];
		const scheduled: number[] = [];
		const profile = {
			service: "codemem-viewer",
			protocol_version: 1,
			min_supported_protocol_version: 1,
			db_path: dbPath,
			identity_target: identity,
		};

		await hook.runClaudeUserPromptHook(JSON.stringify(payload), {
			env,
			fetchImpl: async (input: string | URL) => {
				const path = new URL(String(input)).pathname;
				if (path.endsWith("profile")) return jsonResponse(profile);
				if (path.endsWith("pack")) {
					return jsonResponse({ pack_text: "PACK_BYTES", metrics: { total_items: 1 } });
				}
				expect(output).toEqual([
					'{"continue":true,"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"PACK_BYTES"}}',
				]);
				return new Promise<Response>(() => {});
			},
			writeOutput: (value: string) => output.push(value),
			spawnIngestion: () => {},
			runFallback: () => null,
			setTimer: (callback: () => void, milliseconds: number) => {
				scheduled.push(milliseconds);
				callback();
				return { unref() {} };
			},
			clearTimer: () => {},
		});

		expect(scheduled).toEqual([500]);
	});

	it("rejects redirects and invokes only the classified compatibility fallback", async () => {
		let fallbackCalls = 0;
		await hook.runClaudeUserPromptHook(JSON.stringify(payload), {
			env,
			fetchImpl: async () =>
				new Response(null, { status: 307, headers: { Location: "/elsewhere" } }),
			writeOutput: () => {},
			spawnIngestion: () => {},
			runFallback: () => {
				fallbackCalls += 1;
				return { continue: true };
			},
		});

		expect(fallbackCalls).toBe(1);
	});

	it("uses the same session-state filename contract as the CLI fallback", () => {
		hook.trackClaudeSessionState(payload, env, () => new Date("2026-08-16T00:00:00.000Z"));
		const stateDirectory = env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR;
		expect(stateDirectory).toBeTypeOf("string");
		if (!stateDirectory) throw new Error("Claude hook state directory was not configured");
		const stateFiles = readdirSync(stateDirectory).filter((name) => name.endsWith(".json"));
		expect(stateFiles[0]?.startsWith(`${basename(String(payload.session_id))}-`)).toBe(true);
	});
});
