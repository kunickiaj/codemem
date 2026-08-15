import {
	buildPiFlushSignalFromEvent,
	buildRawEventEnvelopeFromPiEvent,
	mapPiEventPayload,
} from "@codemem/core";
import { describe, expect, it } from "vitest";
import {
	buildBeforeCompactPayload,
	buildMessageEndPayload,
	buildSessionShutdownPayload,
	buildSessionStartPayload,
	buildToolCallPayload,
	buildToolResultPayload,
	CODEMEM_MEMORIES_HEADER,
	extractMessageRole,
	extractMessageText,
	formatPiInjectionBlock,
	stableMessageEntryId,
} from "./payloads.js";

describe("pi-extension payloads ↔ core adapter", () => {
	const sessionId = "sess-abc";
	const cwd = "/tmp/proj";

	it("session_start maps to source pi envelope", () => {
		const payload = buildSessionStartPayload({ sessionId, cwd, reason: "startup" });
		expect(payload.piEvent).toBe("session_start");
		expect(payload.sessionId).toBe(sessionId);

		const adapter = mapPiEventPayload(payload);
		expect(adapter).not.toBeNull();
		expect(adapter?.source).toBe("pi");
		expect(adapter?.event_type).toBe("session_start");
		expect(adapter?.event_id).toBe(`pi:${sessionId}:session_start`);

		const envelope = buildRawEventEnvelopeFromPiEvent(payload);
		expect(envelope?.source).toBe("pi");
		expect(envelope?.session_stream_id).toBe(sessionId);
	});

	it("session_shutdown maps to session_end", () => {
		const payload = buildSessionShutdownPayload({ sessionId, cwd, reason: "quit" });
		const adapter = mapPiEventPayload(payload);
		expect(adapter?.event_type).toBe("session_end");
		expect(adapter?.payload).toMatchObject({ reason: "quit" });
	});

	it("user message_end maps to prompt", () => {
		const payload = buildMessageEndPayload({
			sessionId,
			cwd,
			entryId: "entry-u1",
			role: "user",
			text: "fix the auth bug",
		});
		expect(payload).not.toBeNull();
		if (!payload) throw new Error("expected payload");
		const adapter = mapPiEventPayload(payload);
		expect(adapter?.event_type).toBe("prompt");
		expect(adapter?.payload).toMatchObject({ text: "fix the auth bug" });
		expect(adapter?.event_id).toBe(`pi:${sessionId}:entry-u1`);
	});

	it("assistant message_end maps to assistant", () => {
		const payload = buildMessageEndPayload({
			sessionId,
			cwd,
			entryId: "entry-a1",
			role: "assistant",
			text: "Looking into it.",
		});
		expect(payload).not.toBeNull();
		if (!payload) throw new Error("expected payload");
		const adapter = mapPiEventPayload(payload);
		expect(adapter?.event_type).toBe("assistant");
	});

	it("tool_call / tool_result pair with deterministic ids", () => {
		const call = buildToolCallPayload({
			sessionId,
			cwd,
			toolCallId: "tc-1",
			toolName: "read",
			toolInput: { path: "src/a.ts" },
		});
		const callAdapter = mapPiEventPayload(call);
		expect(callAdapter?.event_type).toBe("tool_call");
		expect(callAdapter?.event_id).toBe(`pi:${sessionId}:tc-1`);
		expect(callAdapter?.payload).toMatchObject({
			tool_name: "read",
			tool_input: { path: "src/a.ts" },
		});

		const result = buildToolResultPayload({
			sessionId,
			cwd,
			toolCallId: "tc-1",
			toolName: "read",
			toolInput: { path: "src/a.ts" },
			toolOutput: "file contents",
			isError: false,
		});
		const resultAdapter = mapPiEventPayload(result);
		expect(resultAdapter?.event_type).toBe("tool_result");
		expect(resultAdapter?.event_id).toBe(`pi:${sessionId}:tc-1:result`);
		expect(resultAdapter?.payload).toMatchObject({ status: "ok" });
	});

	it("tool_result isError maps status error", () => {
		const result = buildToolResultPayload({
			sessionId,
			toolCallId: "tc-err",
			toolName: "bash",
			isError: true,
			error: "boom",
		});
		const adapter = mapPiEventPayload(result);
		expect(adapter?.payload).toMatchObject({ status: "error", tool_name: "bash" });
	});

	it("session_before_compact is flush-only (no transcript event, no compaction object)", () => {
		const payload = buildBeforeCompactPayload({
			sessionId,
			cwd,
			reason: "threshold",
			entryId: "session_before_compact:2",
		});
		expect(payload.entryId).toBe("session_before_compact:2");
		expect(mapPiEventPayload(payload)).toBeNull();
		expect(buildRawEventEnvelopeFromPiEvent(payload)).toBeNull();

		const flush = buildPiFlushSignalFromEvent(payload);
		expect(flush).toMatchObject({
			kind: "flush",
			reason: "session_before_compact",
			source: "pi",
			session_id: sessionId,
		});
		// Ensure we never emit a compaction-shaped object from the payload builder.
		expect(payload).not.toHaveProperty("compaction");
		expect(payload).not.toHaveProperty("summary");
	});

	it("stableMessageEntryId is deterministic and content-sensitive", () => {
		const a = stableMessageEntryId("s1", "user", "hello");
		const b = stableMessageEntryId("s1", "user", "hello");
		const c = stableMessageEntryId("s1", "user", "hello!");
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^msg-[0-9a-f]{24}$/);
	});

	it("stableMessageEntryId includes discriminator so identical content can diverge", () => {
		const sameA = stableMessageEntryId("s1", "user", "ok", 1_700_000_000_001);
		const sameB = stableMessageEntryId("s1", "user", "ok", 1_700_000_000_001);
		const other = stableMessageEntryId("s1", "user", "ok", 1_700_000_000_002);
		const bySeq1 = stableMessageEntryId("s1", "user", "ok", "n:1");
		const bySeq2 = stableMessageEntryId("s1", "user", "ok", "n:2");
		const contentOnly = stableMessageEntryId("s1", "user", "ok");

		// True retry / identical timestamp discriminator → same id.
		expect(sameA).toBe(sameB);
		// Distinct timestamps / seq discriminators → distinct ids (even with identical text).
		expect(sameA).not.toBe(other);
		expect(bySeq1).not.toBe(bySeq2);
		// Content-only (no discriminator) differs from discriminated forms — callers must
		// always supply a discriminator; content hash alone is never used as an id.
		expect(contentOnly).not.toBe(sameA);
		expect(contentOnly).not.toBe(bySeq1);
		for (const id of [sameA, other, bySeq1, bySeq2, contentOnly]) {
			expect(id).toMatch(/^msg-[0-9a-f]{24}$/);
			expect(id).not.toMatch(/user-\d{10,}/);
		}
	});
});

describe("message text extraction", () => {
	it("extracts string content", () => {
		expect(extractMessageText({ role: "user", content: " hi " })).toBe("hi");
		expect(extractMessageRole({ role: "User" })).toBe("user");
	});

	it("extracts text blocks from array content", () => {
		expect(
			extractMessageText({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "..." },
					{ type: "text", text: "Hello" },
					{ type: "text", text: "world" },
				],
			}),
		).toBe("Hello\nworld");
	});
});

describe("injection block format", () => {
	it("uses the ## codemem memories header (CLI parity)", () => {
		expect(CODEMEM_MEMORIES_HEADER.startsWith("## codemem memories")).toBe(true);
		const block = formatPiInjectionBlock("remember X", 16_000);
		expect(block.startsWith("## codemem memories")).toBe(true);
		expect(block).toContain("remember X");
	});

	it("returns empty for empty pack", () => {
		expect(formatPiInjectionBlock("", 1000)).toBe("");
		expect(formatPiInjectionBlock("   ", 1000)).toBe("");
	});
});
