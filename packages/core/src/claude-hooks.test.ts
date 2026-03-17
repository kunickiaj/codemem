/**
 * Tests for claude-hooks.ts — port of tests/test_claude_hooks.py.
 *
 * Covers:
 *  - mapClaudeHookPayload: all mappable event types, skip cases, stable IDs,
 *    transcript fallback, unknown field forwarding
 *  - buildRawEventEnvelopeFromHook: required fields, project resolution
 *  - buildIngestPayloadFromHook: session context fields
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildIngestPayloadFromHook,
	buildRawEventEnvelopeFromHook,
	mapClaudeHookPayload,
} from "./claude-hooks.js";

// ---------------------------------------------------------------------------
// mapClaudeHookPayload — event type mapping
// ---------------------------------------------------------------------------

describe("mapClaudeHookPayload", () => {
	describe("UserPromptSubmit → prompt", () => {
		it("maps prompt text and meta", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "UserPromptSubmit",
				session_id: "sess-123",
				prompt: "Run tests",
				cwd: "/tmp/repo",
				custom_field: "keep-me",
			});

			expect(event).not.toBeNull();
			expect(event?.source).toBe("claude");
			expect(event?.event_type).toBe("prompt");
			expect(event?.payload.text).toBe("Run tests");
			expect(event?.meta.hook_event_name).toBe("UserPromptSubmit");
			expect((event?.meta.hook_fields as Record<string, unknown>).custom_field).toBe("keep-me");
		});

		it("returns null for empty prompt", () => {
			expect(
				mapClaudeHookPayload({
					hook_event_name: "UserPromptSubmit",
					session_id: "sess-123",
					prompt: "  ",
				}),
			).toBeNull();
		});

		it("returns null for missing prompt", () => {
			expect(
				mapClaudeHookPayload({
					hook_event_name: "UserPromptSubmit",
					session_id: "sess-123",
				}),
			).toBeNull();
		});
	});

	describe("PreToolUse → tool_call", () => {
		it("maps tool name, input, and tool_use_id", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "PreToolUse",
				session_id: "sess-abc",
				tool_use_id: "toolu_1",
				tool_name: "Bash",
				tool_input: { command: "uv run pytest" },
			});

			expect(event).not.toBeNull();
			expect(event?.event_type).toBe("tool_call");
			expect(event?.payload.tool_name).toBe("Bash");
			expect(event?.payload.tool_input).toEqual({ command: "uv run pytest" });
			expect(event?.meta.tool_use_id).toBe("toolu_1");
		});

		it("defaults tool_input to {} when missing", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "PreToolUse",
				session_id: "sess-abc",
				tool_name: "Read",
			});

			expect(event).not.toBeNull();
			expect(event?.payload.tool_input).toEqual({});
		});

		it("returns null for missing tool_name", () => {
			expect(
				mapClaudeHookPayload({
					hook_event_name: "PreToolUse",
					session_id: "sess-abc",
					tool_input: {},
				}),
			).toBeNull();
		});
	});

	describe("PostToolUse → tool_result ok", () => {
		it("maps tool response with status ok", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "PostToolUse",
				session_id: "sess-abc",
				tool_name: "Bash",
				tool_input: { command: "uv run pytest" },
				tool_response: { exit_code: 0 },
			});

			expect(event).not.toBeNull();
			expect(event?.event_type).toBe("tool_result");
			expect(event?.payload.status).toBe("ok");
			expect(event?.payload.tool_output).toEqual({ exit_code: 0 });
			expect(event?.payload.tool_error).toBeNull();
		});
	});

	describe("PostToolUseFailure → tool_result error", () => {
		it("maps error payload with status error", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "PostToolUseFailure",
				session_id: "sess-abc",
				tool_name: "Bash",
				tool_input: { command: "uv run pytest" },
				error: { message: "1 failed" },
			});

			expect(event).not.toBeNull();
			expect(event?.event_type).toBe("tool_result");
			expect(event?.payload.status).toBe("error");
			expect(event?.payload.error).toEqual({ message: "1 failed" });
		});

		it("returns null for missing tool_name", () => {
			expect(
				mapClaudeHookPayload({
					hook_event_name: "PostToolUseFailure",
					session_id: "sess-abc",
					error: "boom",
				}),
			).toBeNull();
		});
	});

	describe("SessionStart → session_start", () => {
		it("maps source field", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "SessionStart",
				session_id: "sess-start",
				source: "startup",
			});

			expect(event).not.toBeNull();
			expect(event?.event_type).toBe("session_start");
			expect(event?.payload.source).toBe("startup");
		});
	});

	describe("SessionEnd → session_end", () => {
		it("maps reason field", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "SessionEnd",
				session_id: "sess-end",
				reason: "user_exit",
			});

			expect(event).not.toBeNull();
			expect(event?.event_type).toBe("session_end");
			expect(event?.payload.reason).toBe("user_exit");
		});
	});

	describe("Stop → assistant", () => {
		it("maps last_assistant_message text", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "Stop",
				session_id: "sess-stop",
				last_assistant_message: "All done!",
				usage: { input_tokens: 100, output_tokens: 50 },
			});

			expect(event).not.toBeNull();
			expect(event?.event_type).toBe("assistant");
			expect(event?.payload.text).toBe("All done!");
			expect((event?.payload.usage as Record<string, number>).input_tokens).toBe(100);
		});

		it("returns null when no text and no transcript", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "Stop",
				session_id: "sess-stop",
				last_assistant_message: "",
			});
			expect(event).toBeNull();
		});

		it("falls back to transcript when last_assistant_message is empty", () => {
			const dir = mkdtempSync(join(tmpdir(), "codemem-test-"));
			const transcriptPath = join(dir, "transcript.jsonl");
			writeFileSync(
				transcriptPath,
				'{"message":{"role":"assistant","content":"assistant from transcript"}}\n',
				"utf-8",
			);

			const event = mapClaudeHookPayload({
				hook_event_name: "Stop",
				session_id: "sess-stop",
				last_assistant_message: "",
				transcript_path: transcriptPath,
			});

			expect(event).not.toBeNull();
			expect(event?.event_type).toBe("assistant");
			expect(event?.payload.text).toBe("assistant from transcript");
		});

		it("uses relative transcript path with cwd", () => {
			const dir = mkdtempSync(join(tmpdir(), "codemem-test-"));
			const transcriptPath = join(dir, "transcript.jsonl");
			writeFileSync(
				transcriptPath,
				'{"role":"assistant","content":"relative transcript text"}\n',
				"utf-8",
			);

			const event = mapClaudeHookPayload({
				hook_event_name: "Stop",
				session_id: "sess-stop-rel",
				last_assistant_message: "",
				transcript_path: "transcript.jsonl",
				cwd: dir,
			});

			expect(event).not.toBeNull();
			expect(event?.payload.text).toBe("relative transcript text");
		});

		it("extracts usage from transcript when payload usage is missing", () => {
			const dir = mkdtempSync(join(tmpdir(), "codemem-test-"));
			const transcriptPath = join(dir, "transcript.jsonl");
			writeFileSync(
				transcriptPath,
				'{"message":{"role":"assistant","content":"done","usage":{"input_tokens":100,"output_tokens":50}}}\n',
				"utf-8",
			);

			const event = mapClaudeHookPayload({
				hook_event_name: "Stop",
				session_id: "sess-stop-usage",
				last_assistant_message: "done",
				// no usage in payload — should fall back to transcript
				transcript_path: transcriptPath,
			});

			expect(event).not.toBeNull();
			const usage = event?.payload.usage as Record<string, number>;
			expect(usage.input_tokens).toBe(100);
			expect(usage.output_tokens).toBe(50);
		});

		it("extracts usage from transcript via tokenUsage alias", () => {
			const dir = mkdtempSync(join(tmpdir(), "codemem-test-"));
			const transcriptPath = join(dir, "transcript.jsonl");
			writeFileSync(
				transcriptPath,
				'{"role":"assistant","text":"hi","tokenUsage":{"input_tokens":42,"output_tokens":7}}\n',
				"utf-8",
			);

			const event = mapClaudeHookPayload({
				hook_event_name: "Stop",
				session_id: "sess-stop-tokenUsage",
				last_assistant_message: "hi",
				transcript_path: transcriptPath,
			});

			expect(event).not.toBeNull();
			const usage = event?.payload.usage as Record<string, number>;
			expect(usage.input_tokens).toBe(42);
			expect(usage.output_tokens).toBe(7);
		});

		it("does not use relative transcript path without cwd", () => {
			const dir = mkdtempSync(join(tmpdir(), "codemem-test-"));
			const transcriptPath = join(dir, "transcript.jsonl");
			writeFileSync(
				transcriptPath,
				'{"role":"assistant","content":"should not appear"}\n',
				"utf-8",
			);

			// Pass relative path but no cwd
			const event = mapClaudeHookPayload({
				hook_event_name: "Stop",
				session_id: "sess-stop-no-cwd",
				last_assistant_message: "",
				transcript_path: "transcript.jsonl",
				// no cwd
			});

			expect(event).toBeNull();
		});
	});

	describe("skip cases", () => {
		it("returns null for unsupported event type", () => {
			expect(
				mapClaudeHookPayload({
					hook_event_name: "SomeUnknownEvent",
					session_id: "sess-123",
				}),
			).toBeNull();
		});

		it("returns null for missing session_id", () => {
			expect(
				mapClaudeHookPayload({
					hook_event_name: "SessionStart",
					source: "startup",
				}),
			).toBeNull();
		});

		it("returns null for empty session_id", () => {
			expect(
				mapClaudeHookPayload({
					hook_event_name: "SessionStart",
					session_id: "   ",
					source: "startup",
				}),
			).toBeNull();
		});
	});

	describe("stable event id", () => {
		it("produces identical ids for identical payloads with explicit timestamp", () => {
			const payload = {
				hook_event_name: "SessionStart",
				session_id: "sess-stable",
				source: "startup",
				ts: "2026-03-02T20:00:00Z",
			};

			const first = mapClaudeHookPayload(payload);
			const second = mapClaudeHookPayload(payload);

			expect(first).not.toBeNull();
			expect(second).not.toBeNull();
			expect(first?.event_id).toBe(second?.event_id);
		});

		it("marks generated timestamp in meta when ts is absent", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "SessionStart",
				session_id: "sess-no-ts",
				source: "startup",
			});

			expect(event).not.toBeNull();
			expect(event?.meta.ts_normalized).toBe("generated");
			expect(event?.event_id).toMatch(/^cld_evt_/);
		});

		it("produces different ids when generated timestamps differ", () => {
			vi.useFakeTimers();
			try {
				vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
				const first = mapClaudeHookPayload({
					hook_event_name: "SessionStart",
					session_id: "sess-time-distinct",
					source: "startup",
				});

				vi.setSystemTime(new Date("2026-03-01T00:00:01Z"));
				const second = mapClaudeHookPayload({
					hook_event_name: "SessionStart",
					session_id: "sess-time-distinct",
					source: "startup",
				});

				expect(first).not.toBeNull();
				expect(second).not.toBeNull();
				expect(first?.ts).not.toBe(second?.ts);
				expect(first?.event_id).not.toBe(second?.event_id);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("timestamp format parity with Python", () => {
		it("preserves absence of fractional seconds (matches Python isoformat)", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "SessionStart",
				session_id: "sess-ts-nofrac",
				ts: "2026-03-04T01:00:00Z",
			});

			// Python: datetime.fromisoformat("2026-03-04T01:00:00+00:00").isoformat().replace("+00:00", "Z")
			// → "2026-03-04T01:00:00Z" (no .000)
			expect(event?.ts).toBe("2026-03-04T01:00:00Z");
		});

		it("expands fractional seconds to microsecond precision (matches Python isoformat)", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "SessionStart",
				session_id: "sess-ts-frac",
				ts: "2026-03-04T01:00:00.123Z",
			});

			// Python: "2026-03-04T01:00:00.123000Z" (6 digits)
			expect(event?.ts).toBe("2026-03-04T01:00:00.123000Z");
		});

		it("treats naive timestamps (no timezone) as UTC (matches Python)", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "SessionStart",
				session_id: "sess-ts-naive",
				ts: "2026-03-04T01:00:00",
			});

			// Python: datetime.fromisoformat("2026-03-04T01:00:00")
			//   → tzinfo is None → replace(tzinfo=UTC) → "2026-03-04T01:00:00Z"
			// JS without fix: new Date("2026-03-04T01:00:00") → local time (WRONG)
			expect(event?.ts).toBe("2026-03-04T01:00:00Z");
		});
	});

	describe("schema_version and source", () => {
		it("sets schema_version to 1.0 and source to claude", () => {
			const event = mapClaudeHookPayload({
				hook_event_name: "SessionStart",
				session_id: "sess-schema",
				ts: "2026-01-01T00:00:00Z",
			});

			expect(event?.schema_version).toBe("1.0");
			expect(event?.source).toBe("claude");
		});
	});
});

// ---------------------------------------------------------------------------
// buildRawEventEnvelopeFromHook
// ---------------------------------------------------------------------------

describe("buildRawEventEnvelopeFromHook", () => {
	it("returns null for unsupported event", () => {
		expect(
			buildRawEventEnvelopeFromHook({
				hook_event_name: "UnknownEvent",
				session_id: "sess-123",
			}),
		).toBeNull();
	});

	it("includes all required envelope fields", () => {
		const envelope = buildRawEventEnvelopeFromHook({
			hook_event_name: "SessionStart",
			session_id: "sess-enqueue",
			source: "startup",
			cwd: "/tmp/repo",
			project: "codemem",
			ts: "2026-03-04T01:00:00Z",
		});

		expect(envelope).not.toBeNull();
		expect(envelope?.session_stream_id).toBe("sess-enqueue");
		expect(envelope?.session_id).toBe("sess-enqueue");
		expect(envelope?.opencode_session_id).toBe("sess-enqueue");
		expect(envelope?.source).toBe("claude");
		expect(envelope?.event_type).toBe("claude.hook");
		expect(envelope?.started_at).toBe("2026-03-04T01:00:00Z");
		expect(envelope?.payload._adapter).toBeDefined();
		expect((envelope?.payload._adapter as Record<string, unknown>).event_type).toBe(
			"session_start",
		);
		// 2026-03-04T01:00:00Z in ms
		expect(envelope?.ts_wall_ms).toBe(new Date("2026-03-04T01:00:00Z").getTime());
	});

	it("started_at is null for non-SessionStart events", () => {
		const envelope = buildRawEventEnvelopeFromHook({
			hook_event_name: "UserPromptSubmit",
			session_id: "sess-prompt",
			prompt: "hello",
			ts: "2026-01-01T00:00:00Z",
		});

		expect(envelope).not.toBeNull();
		expect(envelope?.started_at).toBeNull();
	});

	describe("project resolution", () => {
		let savedEnv: string | undefined;

		beforeEach(() => {
			savedEnv = process.env.CODEMEM_PROJECT;
			delete process.env.CODEMEM_PROJECT;
		});

		afterEach(() => {
			if (savedEnv !== undefined) {
				process.env.CODEMEM_PROJECT = savedEnv;
			} else {
				delete process.env.CODEMEM_PROJECT;
			}
		});

		it("prefers CODEMEM_PROJECT env var", () => {
			process.env.CODEMEM_PROJECT = "env-project";

			const envelope = buildRawEventEnvelopeFromHook({
				hook_event_name: "UserPromptSubmit",
				session_id: "sess-env",
				prompt: "ship it",
				cwd: "/tmp/repo",
				project: "payload-project",
				ts: "2026-01-01T00:00:00Z",
			});

			expect(envelope?.project).toBe("env-project");
		});

		it("infers project from cwd git root", () => {
			const dir = mkdtempSync(join(tmpdir(), "codemem-test-"));
			const repoRoot = join(dir, "codemem-main");
			mkdirSync(repoRoot);
			mkdirSync(join(repoRoot, ".git"));
			const subdir = join(repoRoot, "subdir");
			mkdirSync(subdir);

			const envelope = buildRawEventEnvelopeFromHook({
				hook_event_name: "UserPromptSubmit",
				session_id: "sess-cwd",
				prompt: "ship it",
				cwd: subdir,
				ts: "2026-01-01T00:00:00Z",
			});

			expect(envelope?.project).toBe("codemem-main");
		});

		it("prefers cwd git-root over payload project when different", () => {
			const dir = mkdtempSync(join(tmpdir(), "codemem-test-"));
			const repoRoot = join(dir, "codemem");
			mkdirSync(repoRoot);
			mkdirSync(join(repoRoot, ".git"));
			const pkg = join(repoRoot, "pkg");
			mkdirSync(pkg);

			const envelope = buildRawEventEnvelopeFromHook({
				hook_event_name: "UserPromptSubmit",
				session_id: "sess-cwd-over-payload",
				prompt: "ship it",
				cwd: pkg,
				project: "main",
				ts: "2026-01-01T00:00:00Z",
			});

			expect(envelope?.project).toBe("codemem");
		});

		it("falls back to payload project when cwd is missing", () => {
			const envelope = buildRawEventEnvelopeFromHook({
				hook_event_name: "UserPromptSubmit",
				session_id: "sess-payload",
				prompt: "ship it",
				project: "payload-project",
				ts: "2026-01-01T00:00:00Z",
			});

			expect(envelope?.project).toBe("payload-project");
		});

		it("falls back to payload project when cwd does not exist", () => {
			const envelope = buildRawEventEnvelopeFromHook({
				hook_event_name: "UserPromptSubmit",
				session_id: "sess-bad-cwd",
				prompt: "ship it",
				cwd: "/tmp/does-not-exist/codemem-xyz-12345",
				project: "payload-project",
				ts: "2026-01-01T00:00:00Z",
			});

			expect(envelope?.project).toBe("payload-project");
		});

		it("falls back to payload project when cwd is relative", () => {
			const envelope = buildRawEventEnvelopeFromHook({
				hook_event_name: "UserPromptSubmit",
				session_id: "sess-rel-cwd",
				prompt: "ship it",
				cwd: "codemem",
				project: "payload-project",
				ts: "2026-01-01T00:00:00Z",
			});

			expect(envelope?.project).toBe("payload-project");
		});

		it("infers project from absolute tool_input filePath", () => {
			const dir = mkdtempSync(join(tmpdir(), "codemem-test-"));
			const repoRoot = join(dir, "greenroom");
			mkdirSync(repoRoot);
			mkdirSync(join(repoRoot, ".git"));
			const srcDir = join(repoRoot, "src");
			mkdirSync(srcDir);
			const targetFile = join(srcDir, "feature.py");
			writeFileSync(targetFile, "print('ok')\n", "utf-8");

			const envelope = buildRawEventEnvelopeFromHook({
				hook_event_name: "PostToolUse",
				session_id: "sess-tool-path",
				tool_name: "Edit",
				tool_input: { filePath: targetFile },
				tool_response: { ok: true },
				ts: "2026-01-01T00:00:00Z",
			});

			expect(envelope?.project).toBe("greenroom");
		});

		it("infers project from relative tool_input filePath with cwd", () => {
			const dir = mkdtempSync(join(tmpdir(), "codemem-test-"));
			const repoRoot = join(dir, "greenroom");
			mkdirSync(repoRoot);
			mkdirSync(join(repoRoot, ".git"));
			const srcDir = join(repoRoot, "src");
			mkdirSync(srcDir);
			writeFileSync(join(srcDir, "feature.py"), "print('ok')\n", "utf-8");

			const envelope = buildRawEventEnvelopeFromHook({
				hook_event_name: "PostToolUse",
				session_id: "sess-rel-tool-path",
				tool_name: "Edit",
				tool_input: { filePath: "src/feature.py" },
				tool_response: { ok: true },
				cwd: repoRoot,
				ts: "2026-01-01T00:00:00Z",
			});

			expect(envelope?.project).toBe("greenroom");
		});

		it("does not infer project from relative tool path without cwd", () => {
			const envelope = buildRawEventEnvelopeFromHook({
				hook_event_name: "PostToolUse",
				session_id: "sess-rel-tool-no-cwd",
				tool_name: "Edit",
				tool_input: { filePath: "src/feature.py" },
				tool_response: { ok: true },
				ts: "2026-01-01T00:00:00Z",
			});

			expect(envelope?.project).toBeNull();
		});

		it("project is null when nothing can be inferred", () => {
			const envelope = buildRawEventEnvelopeFromHook({
				hook_event_name: "SessionStart",
				session_id: "sess-no-project",
				ts: "2026-01-01T00:00:00Z",
			});

			expect(envelope?.project).toBeNull();
		});
	});
});

// ---------------------------------------------------------------------------
// buildIngestPayloadFromHook
// ---------------------------------------------------------------------------

describe("buildIngestPayloadFromHook", () => {
	it("returns null for unsupported event", () => {
		expect(
			buildIngestPayloadFromHook({
				hook_event_name: "UnknownEvent",
				session_id: "sess-123",
			}),
		).toBeNull();
	});

	it("wraps adapter event in session_context with all aliases", () => {
		const ingest = buildIngestPayloadFromHook({
			hook_event_name: "SessionStart",
			session_id: "sess-xyz",
			source: "startup",
			cwd: "/tmp/repo",
		});

		expect(ingest).not.toBeNull();
		const ctx = ingest?.session_context as Record<string, unknown>;
		expect(ctx.source).toBe("claude");
		expect(ctx.stream_id).toBe("sess-xyz");
		expect(ctx.session_stream_id).toBe("sess-xyz");
		expect(ctx.session_id).toBe("sess-xyz");
		expect(ctx.opencode_session_id).toBe("sess-xyz");

		const events = ingest?.events as Array<Record<string, unknown>>;
		expect(events).toHaveLength(1);
		expect((events[0]?._adapter as Record<string, unknown>).event_type).toBe("session_start");
	});

	it("sets cwd from hook payload", () => {
		const ingest = buildIngestPayloadFromHook({
			hook_event_name: "UserPromptSubmit",
			session_id: "sess-cwd",
			prompt: "hello",
			cwd: "/home/user/myrepo",
		});

		expect(ingest?.cwd).toBe("/home/user/myrepo");
	});
});

// ---------------------------------------------------------------------------
// HTTP route integration (POST /api/claude-hooks via viewer-server)
// ---------------------------------------------------------------------------

describe("POST /api/claude-hooks via viewer-server", () => {
	/** Build a minimal store stub + Hono app for HTTP-level tests. */
	async function makeTestApp() {
		const { createApp } = await import("../../viewer-server/src/index.js");
		const { initTestSchema } = await import("./index.js");
		const Database = (await import("better-sqlite3")).default;
		const rawDb = new Database(":memory:");
		initTestSchema(rawDb);
		// biome-ignore lint/suspicious/noExplicitAny: minimal test stub
		const store: any = {
			db: rawDb,
			dbPath: ":memory:",
			deviceId: "test-device",
			stats: () => ({ database: {} }),
			close: () => rawDb.close(),
			rawEventBacklogTotals: () => ({}),
		};
		return createApp({ storeFactory: () => store });
	}

	// POST mutations require a loopback Origin header to pass the origin guard.
	const LOOPBACK_HEADERS = {
		"Content-Type": "application/json",
		Origin: "http://localhost",
	};

	it("returns {inserted:0, skipped:1} for unsupported hook event", async () => {
		const app = await makeTestApp();
		const res = await app.request("/api/claude-hooks", {
			method: "POST",
			headers: LOOPBACK_HEADERS,
			body: JSON.stringify({ hook_event_name: "SomeUnknown", session_id: "s1" }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ inserted: 0, skipped: 1 });
	});

	it("returns 400 for invalid JSON", async () => {
		const app = await makeTestApp();
		const res = await app.request("/api/claude-hooks", {
			method: "POST",
			headers: LOOPBACK_HEADERS,
			body: "not-json{",
		});

		expect(res.status).toBe(400);
	});

	it("allows POST without Origin header (CLI callers)", async () => {
		const app = await makeTestApp();
		const res = await app.request("/api/claude-hooks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hook_event_name: "SomeUnknown", session_id: "s1" }),
		});

		// Should NOT be 403 — CLI callers don't send Origin
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ inserted: 0, skipped: 1 });
	});
});
