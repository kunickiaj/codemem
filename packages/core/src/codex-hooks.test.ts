import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildIngestPayloadFromCodexHook,
	buildRawEventEnvelopeFromCodexHook,
	mapCodexHookPayload,
} from "./codex-hooks.js";

const tempDirs: string[] = [];

function writeTranscript(lines: Array<Record<string, unknown>>): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-codex-transcript-"));
	tempDirs.push(dir);
	const path = join(dir, "transcript.jsonl");
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
	return path;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { recursive: true, force: true });
	}
});

describe("mapCodexHookPayload", () => {
	it("maps UserPromptSubmit to prompt", () => {
		const event = mapCodexHookPayload({
			hook_event_name: "UserPromptSubmit",
			session_id: " codex-session ",
			turn_id: "turn-1",
			prompt: "Run the tests",
			cwd: "/tmp/repo",
			custom_field: "preserve",
		});

		expect(event).not.toBeNull();
		expect(event?.source).toBe("codex");
		expect(event?.event_type).toBe("prompt");
		expect(event?.session_id).toBe("codex-session");
		expect(event?.payload.text).toBe("Run the tests");
		expect(event?.meta.turn_id).toBe("turn-1");
		expect((event?.meta.hook_fields as Record<string, unknown>).custom_field).toBe("preserve");
	});

	it("skips empty prompts", () => {
		expect(
			mapCodexHookPayload({
				hook_event_name: "UserPromptSubmit",
				session_id: "codex-session",
				prompt: "   ",
			}),
		).toBeNull();
	});

	it("maps SessionStart target metadata", () => {
		const event = mapCodexHookPayload({
			hook_event_name: "SessionStart",
			session_id: "codex-session",
			target: { source: "startup" },
		});

		expect(event).not.toBeNull();
		expect(event?.event_type).toBe("session_start");
		expect(event?.payload.source).toBe("startup");
		expect(event?.payload.target).toEqual({ source: "startup" });
	});

	it("maps PreToolUse to tool_call", () => {
		const event = mapCodexHookPayload({
			hook_event_name: "PreToolUse",
			session_id: "codex-session",
			turn_id: "turn-1",
			tool_use_id: "tool-1",
			tool_name: "Bash",
			tool_input: { command: "pnpm test" },
		});

		expect(event).not.toBeNull();
		expect(event?.event_type).toBe("tool_call");
		expect(event?.payload.tool_name).toBe("Bash");
		expect(event?.payload.tool_input).toEqual({ command: "pnpm test" });
		expect(event?.meta.tool_use_id).toBe("tool-1");
	});

	it("maps PostToolUse to ok tool_result", () => {
		const event = mapCodexHookPayload({
			hook_event_name: "PostToolUse",
			session_id: "codex-session",
			tool_name: "Read",
			tool_input: { filePath: "README.md" },
			tool_response: { content: "hello" },
		});

		expect(event).not.toBeNull();
		expect(event?.event_type).toBe("tool_result");
		expect(event?.payload.status).toBe("ok");
		expect(event?.payload.tool_output).toEqual({ content: "hello" });
		expect(event?.payload.tool_error).toBeNull();
	});

	it("maps Stop to assistant when assistant text is present", () => {
		const event = mapCodexHookPayload({
			hook_event_name: "Stop",
			session_id: "codex-session",
			turn_id: "turn-1",
			last_assistant_message: "Done",
		});

		expect(event).not.toBeNull();
		expect(event?.event_type).toBe("assistant");
		expect(event?.payload.text).toBe("Done");
	});

	it("maps Stop via transcript fallback when last_assistant_message is missing", () => {
		const transcriptPath = writeTranscript([
			{ role: "user", content: "do the thing" },
			{ role: "assistant", content: "Finished the thing" },
		]);
		const event = mapCodexHookPayload({
			hook_event_name: "Stop",
			session_id: "codex-session",
			transcript_path: transcriptPath,
		});

		expect(event).not.toBeNull();
		expect(event?.event_type).toBe("assistant");
		expect(event?.payload.text).toBe("Finished the thing");
	});

	it("keeps Stop event IDs stable across transcript-fallback retries", () => {
		const transcriptPath = writeTranscript([{ role: "assistant", content: "Finished the thing" }]);
		const payload = {
			hook_event_name: "Stop",
			session_id: "codex-session",
			transcript_path: transcriptPath,
		};
		expect(mapCodexHookPayload(payload)?.event_id).toBe(mapCodexHookPayload(payload)?.event_id);
	});

	it("skips Stop when neither assistant text nor transcript text is available", () => {
		expect(
			mapCodexHookPayload({ hook_event_name: "Stop", session_id: "codex-session" }),
		).toBeNull();
	});

	it("skips unsupported events and missing session IDs", () => {
		expect(
			mapCodexHookPayload({ hook_event_name: "PermissionRequest", session_id: "s" }),
		).toBeNull();
		expect(mapCodexHookPayload({ hook_event_name: "SessionStart" })).toBeNull();
		expect(mapCodexHookPayload({ hook_event_name: "SessionStart", session_id: "  " })).toBeNull();
	});

	it("produces stable event IDs for identical timestamped payloads", () => {
		const payload = {
			hook_event_name: "UserPromptSubmit",
			session_id: "codex-session",
			turn_id: "turn-1",
			prompt: "Run tests",
			timestamp: "2026-05-29T01:00:00Z",
		};
		expect(mapCodexHookPayload(payload)?.event_id).toBe(mapCodexHookPayload(payload)?.event_id);
	});

	it("uses generated timestamps to avoid collisions for repeated timestamp-less payloads", () => {
		const payload = {
			hook_event_name: "UserPromptSubmit",
			session_id: "codex-session",
			turn_id: "turn-1",
			prompt: "Run tests",
		};
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-05-29T01:00:00Z"));
			const first = mapCodexHookPayload(payload)?.event_id;
			vi.setSystemTime(new Date("2026-05-29T01:00:05Z"));
			const second = mapCodexHookPayload(payload)?.event_id;
			expect(first).not.toBe(second);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("buildRawEventEnvelopeFromCodexHook", () => {
	it("wraps Codex adapter events for raw-event ingestion", () => {
		const envelope = buildRawEventEnvelopeFromCodexHook({
			hook_event_name: "SessionStart",
			session_id: "codex-session",
			timestamp: "2026-05-29T01:00:00Z",
			cwd: "/tmp/repo",
			project: "repo",
		});

		expect(envelope).not.toBeNull();
		expect(envelope?.source).toBe("codex");
		expect(envelope?.event_type).toBe("codex.hook");
		expect(envelope?.session_stream_id).toBe("codex-session");
		expect(envelope?.started_at).toBe("2026-05-29T01:00:00Z");
		expect(envelope?.payload.type).toBe("codex.hook");
		expect((envelope?.payload._adapter as Record<string, unknown>).source).toBe("codex");
	});
});

describe("buildIngestPayloadFromCodexHook", () => {
	it("builds shared ingest payload shape", () => {
		const payload = buildIngestPayloadFromCodexHook({
			hook_event_name: "UserPromptSubmit",
			session_id: "codex-session",
			prompt: "Run tests",
		});

		expect(payload).not.toBeNull();
		expect(payload?.session_context).toEqual({
			source: "codex",
			stream_id: "codex-session",
			session_stream_id: "codex-session",
			session_id: "codex-session",
			opencode_session_id: "codex-session",
		});
		expect((payload?.events as Record<string, unknown>[])[0]?.type).toBe("codex.hook");
	});
});
