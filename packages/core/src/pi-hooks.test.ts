/**
 * Tests for pi-hooks.ts — AdapterEvent v1 mapping for pi extension events.
 *
 * Covers:
 *  - mapPiEventPayload: all mappable event types, skip cases, deterministic ids,
 *    tool_result isError, fork → new stream identity
 *  - buildPiFlushSignalFromEvent: session_before_compact flush-only contract
 *  - buildRawEventEnvelopeFromPiEvent: envelope shape + source "pi"
 *  - buildIngestPayloadFromPiEvent: session context fields
 *  - store attribution: pi-ingested rows carry source = "pi" (no opencode rows)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import {
	buildIngestPayloadFromPiEvent,
	buildPiFlushSignalFromEvent,
	buildRawEventEnvelopeFromPiEvent,
	MAPPABLE_PI_EVENTS,
	mapPiEventPayload,
} from "./pi-hooks.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

function requireEnvelope(envelope: ReturnType<typeof buildRawEventEnvelopeFromPiEvent>) {
	if (envelope === null) {
		throw new Error("expected pi envelope");
	}
	return envelope;
}

// ---------------------------------------------------------------------------
// mapPiEventPayload — event type mapping
// ---------------------------------------------------------------------------

describe("mapPiEventPayload", () => {
	describe("session_start → session_start", () => {
		it("maps session start with deterministic id", () => {
			const event = mapPiEventPayload({
				piEvent: "session_start",
				sessionId: "pi-sess-1",
				cwd: "/tmp/repo",
				ts: "2026-06-01T12:00:00Z",
			});

			expect(event).not.toBeNull();
			expect(event?.schema_version).toBe("1.0");
			expect(event?.source).toBe("pi");
			expect(event?.event_type).toBe("session_start");
			expect(event?.session_id).toBe("pi-sess-1");
			expect(event?.event_id).toBe("pi:pi-sess-1:session_start");
			expect(event?.cwd).toBe("/tmp/repo");
			expect(event?.ts).toBe("2026-06-01T12:00:00Z");
		});

		it("prefers entryId for the event id suffix when present", () => {
			const event = mapPiEventPayload({
				piEvent: "session_start",
				sessionId: "pi-sess-1",
				entryId: "entry-start-1",
				ts: "2026-06-01T12:00:00Z",
			});
			expect(event?.event_id).toBe("pi:pi-sess-1:entry-start-1");
		});
	});

	describe("session_shutdown → session_end", () => {
		it("maps reason field", () => {
			const event = mapPiEventPayload({
				piEvent: "session_shutdown",
				sessionId: "pi-sess-end",
				reason: "user_exit",
				ts: "2026-06-01T13:00:00Z",
			});

			expect(event).not.toBeNull();
			expect(event?.event_type).toBe("session_end");
			expect(event?.payload.reason).toBe("user_exit");
			expect(event?.event_id).toBe("pi:pi-sess-end:session_end");
			expect(event?.source).toBe("pi");
		});
	});

	describe("message_end role=user → prompt", () => {
		it("maps prompt text and meta", () => {
			const event = mapPiEventPayload({
				piEvent: "message_end",
				sessionId: "pi-sess-msg",
				entryId: "entry-u1",
				role: "user",
				text: "Run tests",
				cwd: "/tmp/repo",
				custom_field: "keep-me",
				ts: "2026-06-01T12:01:00Z",
			});

			expect(event).not.toBeNull();
			expect(event?.source).toBe("pi");
			expect(event?.event_type).toBe("prompt");
			expect(event?.payload.text).toBe("Run tests");
			expect(event?.event_id).toBe("pi:pi-sess-msg:entry-u1");
			expect(event?.meta.pi_event).toBe("message_end");
			expect(event?.meta.entry_id).toBe("entry-u1");
			expect((event?.meta.pi_fields as Record<string, unknown>).custom_field).toBe("keep-me");
		});

		it("returns null for empty text", () => {
			expect(
				mapPiEventPayload({
					piEvent: "message_end",
					sessionId: "pi-sess-msg",
					entryId: "entry-u1",
					role: "user",
					text: "  ",
				}),
			).toBeNull();
		});

		it("returns null without entryId", () => {
			expect(
				mapPiEventPayload({
					piEvent: "message_end",
					sessionId: "pi-sess-msg",
					role: "user",
					text: "hello",
				}),
			).toBeNull();
		});
	});

	describe("message_end role=assistant → assistant", () => {
		it("maps assistant text", () => {
			const event = mapPiEventPayload({
				piEvent: "message_end",
				sessionId: "pi-sess-msg",
				entryId: "entry-a1",
				role: "assistant",
				text: "All done",
				ts: "2026-06-01T12:02:00Z",
			});

			expect(event).not.toBeNull();
			expect(event?.event_type).toBe("assistant");
			expect(event?.payload.text).toBe("All done");
			expect(event?.event_id).toBe("pi:pi-sess-msg:entry-a1");
		});
	});

	describe("turn_end → assistant", () => {
		it("maps turn_end text", () => {
			const event = mapPiEventPayload({
				piEvent: "turn_end",
				sessionId: "pi-sess-turn",
				entryId: "entry-t1",
				text: "Turn complete",
				ts: "2026-06-01T12:03:00Z",
			});
			expect(event?.event_type).toBe("assistant");
			expect(event?.payload.text).toBe("Turn complete");
			expect(event?.event_id).toBe("pi:pi-sess-turn:entry-t1");
		});

		it("does not map agent_end (D2: extension emits message_end only)", () => {
			expect(MAPPABLE_PI_EVENTS.has("agent_end")).toBe(false);
			expect(
				mapPiEventPayload({
					piEvent: "agent_end",
					sessionId: "pi-sess-agent",
					entryId: "entry-ag1",
					text: "Agent finished",
					ts: "2026-06-01T12:04:00Z",
				}),
			).toBeNull();
		});
	});

	describe("tool_call → tool_call", () => {
		it("maps tool name, input, and toolCallId", () => {
			const event = mapPiEventPayload({
				piEvent: "tool_call",
				sessionId: "pi-sess-tool",
				toolCallId: "tc-1",
				toolName: "bash",
				toolInput: { command: "pnpm test" },
				ts: "2026-06-01T12:05:00Z",
			});

			expect(event).not.toBeNull();
			expect(event?.event_type).toBe("tool_call");
			expect(event?.payload.tool_name).toBe("bash");
			expect(event?.payload.tool_input).toEqual({ command: "pnpm test" });
			expect(event?.event_id).toBe("pi:pi-sess-tool:tc-1");
			expect(event?.meta.tool_call_id).toBe("tc-1");
		});

		it("defaults tool_input to {} when missing", () => {
			const event = mapPiEventPayload({
				piEvent: "tool_call",
				sessionId: "pi-sess-tool",
				toolCallId: "tc-2",
				toolName: "read",
				ts: "2026-06-01T12:05:00Z",
			});
			expect(event?.payload.tool_input).toEqual({});
		});

		it("returns null for missing toolName", () => {
			expect(
				mapPiEventPayload({
					piEvent: "tool_call",
					sessionId: "pi-sess-tool",
					toolCallId: "tc-3",
				}),
			).toBeNull();
		});

		it("returns null without toolCallId or entryId", () => {
			expect(
				mapPiEventPayload({
					piEvent: "tool_call",
					sessionId: "pi-sess-tool",
					toolName: "bash",
				}),
			).toBeNull();
		});
	});

	describe("tool_result → tool_result (isError)", () => {
		it("maps ok result", () => {
			const event = mapPiEventPayload({
				piEvent: "tool_result",
				sessionId: "pi-sess-tool",
				toolCallId: "tc-1",
				toolName: "bash",
				toolOutput: { exit_code: 0 },
				isError: false,
				ts: "2026-06-01T12:06:00Z",
			});

			expect(event).not.toBeNull();
			expect(event?.event_type).toBe("tool_result");
			expect(event?.payload.status).toBe("ok");
			expect(event?.payload.tool_output).toEqual({ exit_code: 0 });
			expect(event?.payload.tool_error).toBeNull();
			expect(event?.event_id).toBe("pi:pi-sess-tool:tc-1:result");
		});

		it("maps isError result", () => {
			const event = mapPiEventPayload({
				piEvent: "tool_result",
				sessionId: "pi-sess-tool",
				toolCallId: "tc-err",
				toolName: "bash",
				isError: true,
				error: { message: "1 failed" },
				ts: "2026-06-01T12:07:00Z",
			});

			expect(event).not.toBeNull();
			expect(event?.event_type).toBe("tool_result");
			expect(event?.payload.status).toBe("error");
			expect(event?.payload.tool_output).toBeNull();
			expect(event?.payload.error).toEqual({ message: "1 failed" });
			expect(event?.payload.tool_error).toEqual({ message: "1 failed" });
			expect(event?.event_id).toBe("pi:pi-sess-tool:tc-err:result");
		});
	});

	describe("skip cases", () => {
		it("returns null for unsupported event type", () => {
			expect(
				mapPiEventPayload({
					piEvent: "before_agent_start",
					sessionId: "pi-sess-1",
				}),
			).toBeNull();
		});

		it("returns null for missing sessionId", () => {
			expect(
				mapPiEventPayload({
					piEvent: "session_start",
				}),
			).toBeNull();
		});

		it("returns null for empty sessionId", () => {
			expect(
				mapPiEventPayload({
					piEvent: "session_start",
					sessionId: "   ",
				}),
			).toBeNull();
		});

		it("returns null for session_before_compact (flush-only, not transcript)", () => {
			expect(
				mapPiEventPayload({
					piEvent: "session_before_compact",
					sessionId: "pi-sess-1",
					ts: "2026-06-01T12:00:00Z",
				}),
			).toBeNull();
		});

		it("returns null for unknown role on message_end", () => {
			expect(
				mapPiEventPayload({
					piEvent: "message_end",
					sessionId: "pi-sess-1",
					entryId: "e1",
					role: "system",
					text: "nope",
				}),
			).toBeNull();
		});
	});

	describe("deterministic event ids", () => {
		it("produces identical ids for identical payloads", () => {
			const payload = {
				piEvent: "message_end",
				sessionId: "pi-sess-stable",
				entryId: "entry-stable-1",
				role: "user",
				text: "hello",
				ts: "2026-06-01T12:00:00Z",
			};
			const first = mapPiEventPayload(payload);
			const second = mapPiEventPayload(payload);
			expect(first?.event_id).toBe(second?.event_id);
			expect(first?.event_id).toBe("pi:pi-sess-stable:entry-stable-1");
		});

		it("event_id is invariant to ts (different or absent)", () => {
			// Dedup key must not incorporate wall-clock ts — retries with a fresh
			// clock or missing ts must collapse to the same raw-event identity.
			const base = {
				piEvent: "message_end",
				sessionId: "pi-sess-ts-invariant",
				entryId: "entry-ts-1",
				role: "assistant",
				text: "same logical message",
			};
			const withTsA = mapPiEventPayload({ ...base, ts: "2026-01-01T00:00:00Z" });
			const withTsB = mapPiEventPayload({ ...base, ts: "2026-12-31T23:59:59Z" });
			const withoutTs = mapPiEventPayload({ ...base });
			expect(withTsA?.event_id).toBe("pi:pi-sess-ts-invariant:entry-ts-1");
			expect(withTsB?.event_id).toBe(withTsA?.event_id);
			expect(withoutTs?.event_id).toBe(withTsA?.event_id);
			// ts itself may differ; only event_id must be stable.
			expect(withTsA?.ts).not.toBe(withTsB?.ts);
		});

		it("uses the pi:<sessionId>:<id> format", () => {
			const event = mapPiEventPayload({
				piEvent: "tool_call",
				sessionId: "S",
				toolCallId: "T",
				toolName: "read",
				ts: "2026-06-01T12:00:00Z",
			});
			expect(event?.event_id).toMatch(/^pi:[^:]+:.+$/);
			expect(event?.event_id).toBe("pi:S:T");
		});
	});

	describe("fork id change → new stream identity", () => {
		it("different sessionId yields different event_id and session_id", () => {
			const base = {
				piEvent: "message_end" as const,
				entryId: "entry-same",
				role: "user",
				text: "same text",
				ts: "2026-06-01T12:00:00Z",
			};
			const parent = mapPiEventPayload({ ...base, sessionId: "sess-parent" });
			const fork = mapPiEventPayload({ ...base, sessionId: "sess-fork" });

			expect(parent?.session_id).toBe("sess-parent");
			expect(fork?.session_id).toBe("sess-fork");
			expect(parent?.event_id).toBe("pi:sess-parent:entry-same");
			expect(fork?.event_id).toBe("pi:sess-fork:entry-same");
			expect(parent?.event_id).not.toBe(fork?.event_id);
		});

		it("envelope stream identity follows the forked session id", () => {
			const parentEnv = buildRawEventEnvelopeFromPiEvent({
				piEvent: "session_start",
				sessionId: "sess-parent",
				ts: "2026-06-01T12:00:00Z",
			});
			const forkEnv = buildRawEventEnvelopeFromPiEvent({
				piEvent: "session_start",
				sessionId: "sess-fork",
				ts: "2026-06-01T12:00:00Z",
			});

			expect(parentEnv?.session_stream_id).toBe("sess-parent");
			expect(forkEnv?.session_stream_id).toBe("sess-fork");
			expect(parentEnv?.session_stream_id).not.toBe(forkEnv?.session_stream_id);
			expect(parentEnv?.source).toBe("pi");
			expect(forkEnv?.source).toBe("pi");
		});
	});

	describe("snake_case field aliases", () => {
		it("accepts session_id / pi_event / entry_id aliases", () => {
			const event = mapPiEventPayload({
				pi_event: "message_end",
				session_id: "pi-snake",
				entry_id: "e-snake",
				role: "user",
				text: "aliased",
				ts: "2026-06-01T12:00:00Z",
			});
			expect(event?.session_id).toBe("pi-snake");
			expect(event?.event_id).toBe("pi:pi-snake:e-snake");
			expect(event?.source).toBe("pi");
		});
	});
});

// ---------------------------------------------------------------------------
// buildPiFlushSignalFromEvent
// ---------------------------------------------------------------------------

describe("buildPiFlushSignalFromEvent", () => {
	it("returns a flush signal for session_before_compact", () => {
		const signal = buildPiFlushSignalFromEvent({
			piEvent: "session_before_compact",
			sessionId: "pi-sess-compact",
			cwd: "/tmp/repo",
			project: "repo",
			ts: "2026-06-01T14:00:00Z",
		});

		expect(signal).not.toBeNull();
		expect(signal?.kind).toBe("flush");
		expect(signal?.reason).toBe("session_before_compact");
		expect(signal?.source).toBe("pi");
		expect(signal?.session_id).toBe("pi-sess-compact");
		expect(signal?.ts).toBe("2026-06-01T14:00:00Z");
		// Must never look like a compaction object for pi to apply.
		expect(signal && "compaction" in signal).toBe(false);
	});

	it("returns null for transcript events", () => {
		expect(
			buildPiFlushSignalFromEvent({
				piEvent: "session_start",
				sessionId: "pi-sess-1",
			}),
		).toBeNull();
	});

	it("returns null without sessionId", () => {
		expect(
			buildPiFlushSignalFromEvent({
				piEvent: "session_before_compact",
			}),
		).toBeNull();
	});

	it("does not produce a raw envelope or ingest payload for compaction", () => {
		const payload = {
			piEvent: "session_before_compact",
			sessionId: "pi-sess-compact",
			ts: "2026-06-01T14:00:00Z",
		};
		expect(mapPiEventPayload(payload)).toBeNull();
		expect(buildRawEventEnvelopeFromPiEvent(payload)).toBeNull();
		expect(buildIngestPayloadFromPiEvent(payload)).toBeNull();
		expect(buildPiFlushSignalFromEvent(payload)).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// buildRawEventEnvelopeFromPiEvent
// ---------------------------------------------------------------------------

describe("buildRawEventEnvelopeFromPiEvent", () => {
	it("returns null for unsupported event", () => {
		expect(
			buildRawEventEnvelopeFromPiEvent({
				piEvent: "before_agent_start",
				sessionId: "pi-sess-1",
			}),
		).toBeNull();
	});

	it("wraps adapter events for raw-event ingestion with source pi", () => {
		const envelope = buildRawEventEnvelopeFromPiEvent({
			piEvent: "session_start",
			sessionId: "pi-sess-env",
			ts: "2026-06-01T12:00:00Z",
			cwd: "/tmp/repo",
			project: "repo",
		});

		expect(envelope).not.toBeNull();
		expect(envelope?.source).toBe("pi");
		expect(envelope?.event_type).toBe("pi.hook");
		expect(envelope?.session_stream_id).toBe("pi-sess-env");
		expect(envelope?.session_id).toBe("pi-sess-env");
		expect(envelope?.opencode_session_id).toBe("pi-sess-env");
		expect(envelope?.started_at).toBe("2026-06-01T12:00:00Z");
		expect(envelope?.event_id).toBe("pi:pi-sess-env:session_start");
		expect(envelope?.payload.type).toBe("pi.hook");
		expect((envelope?.payload._adapter as Record<string, unknown>).source).toBe("pi");
		expect((envelope?.payload._adapter as Record<string, unknown>).schema_version).toBe("1.0");
		expect((envelope?.payload._adapter as Record<string, unknown>).event_type).toBe(
			"session_start",
		);
	});

	it("sets started_at only for session_start", () => {
		const envelope = buildRawEventEnvelopeFromPiEvent({
			piEvent: "message_end",
			sessionId: "pi-sess-env",
			entryId: "e1",
			role: "user",
			text: "hi",
			ts: "2026-06-01T12:01:00Z",
		});
		expect(envelope?.started_at).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// buildIngestPayloadFromPiEvent
// ---------------------------------------------------------------------------

describe("buildIngestPayloadFromPiEvent", () => {
	it("returns null for unsupported event", () => {
		expect(
			buildIngestPayloadFromPiEvent({
				piEvent: "unknown",
				sessionId: "pi-sess-1",
			}),
		).toBeNull();
	});

	it("wraps adapter event in session_context with source pi and all aliases", () => {
		const ingest = buildIngestPayloadFromPiEvent({
			piEvent: "session_start",
			sessionId: "pi-sess-xyz",
			cwd: "/tmp/repo",
			ts: "2026-06-01T12:00:00Z",
		});

		expect(ingest).not.toBeNull();
		const ctx = ingest?.session_context as Record<string, unknown>;
		expect(ctx.source).toBe("pi");
		expect(ctx.stream_id).toBe("pi-sess-xyz");
		expect(ctx.session_stream_id).toBe("pi-sess-xyz");
		expect(ctx.session_id).toBe("pi-sess-xyz");
		expect(ctx.opencode_session_id).toBe("pi-sess-xyz");

		const events = ingest?.events as Array<Record<string, unknown>>;
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe("pi.hook");
		expect((events[0]?._adapter as Record<string, unknown>).source).toBe("pi");
		expect((events[0]?._adapter as Record<string, unknown>).event_type).toBe("session_start");
	});

	it("sets cwd from pi payload", () => {
		const ingest = buildIngestPayloadFromPiEvent({
			piEvent: "message_end",
			sessionId: "pi-sess-cwd",
			entryId: "e-cwd",
			role: "user",
			text: "hello",
			cwd: "/home/user/myrepo",
			ts: "2026-06-01T12:00:00Z",
		});
		expect(ingest?.cwd).toBe("/home/user/myrepo");
	});
});

// ---------------------------------------------------------------------------
// Attribution: pi-ingested rows carry source = "pi"
// ---------------------------------------------------------------------------

describe("pi source attribution via recordRawEvent", () => {
	let tmpDir: string;
	let store: MemoryStore;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-pi-hooks-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("stores raw events with source=pi and creates no opencode rows", () => {
		const envelope = requireEnvelope(
			buildRawEventEnvelopeFromPiEvent({
				piEvent: "message_end",
				sessionId: "pi-attr-sess",
				entryId: "entry-attr-1",
				role: "user",
				text: "attribute me to pi",
				ts: "2026-06-01T15:00:00Z",
				cwd: tmpDir,
				project: "codemem",
			}),
		);
		// Explicit source from envelope — never rely on recordRawEvent default.
		expect(envelope.source).toBe("pi");

		const inserted = store.recordRawEvent({
			opencodeSessionId: envelope.session_stream_id,
			source: envelope.source,
			eventId: envelope.event_id,
			eventType: envelope.event_type,
			payload: envelope.payload,
			tsWallMs: envelope.ts_wall_ms,
		});
		expect(inserted).toBe(true);

		const piRows = store.db
			.prepare(`SELECT source, stream_id, event_id, event_type FROM raw_events WHERE source = ?`)
			.all("pi") as Array<{
			source: string;
			stream_id: string;
			event_id: string;
			event_type: string;
		}>;
		expect(piRows).toHaveLength(1);
		expect(piRows[0]?.source).toBe("pi");
		expect(piRows[0]?.stream_id).toBe("pi-attr-sess");
		expect(piRows[0]?.event_id).toBe("pi:pi-attr-sess:entry-attr-1");
		expect(piRows[0]?.event_type).toBe("pi.hook");

		const opencodeRows = store.db
			.prepare(`SELECT COUNT(*) AS n FROM raw_events WHERE source = ?`)
			.get("opencode") as { n: number };
		expect(Number(opencodeRows.n)).toBe(0);

		const sessionRows = store.db
			.prepare(`SELECT source, stream_id FROM raw_event_sessions`)
			.all() as Array<{ source: string; stream_id: string }>;
		expect(sessionRows).toHaveLength(1);
		expect(sessionRows[0]?.source).toBe("pi");
		expect(sessionRows[0]?.stream_id).toBe("pi-attr-sess");
	});

	it("dedupes retries by (source, stream, event_id) for pi", () => {
		const envelope = requireEnvelope(
			buildRawEventEnvelopeFromPiEvent({
				piEvent: "tool_call",
				sessionId: "pi-dedupe-sess",
				toolCallId: "tc-dedupe",
				toolName: "read",
				toolInput: { path: "README.md" },
				ts: "2026-06-01T15:01:00Z",
			}),
		);

		const write = () =>
			store.recordRawEvent({
				opencodeSessionId: envelope.session_stream_id,
				source: envelope.source,
				eventId: envelope.event_id,
				eventType: envelope.event_type,
				payload: envelope.payload,
				tsWallMs: envelope.ts_wall_ms,
			});
		expect(write()).toBe(true);
		expect(write()).toBe(false);

		const count = store.db
			.prepare(`SELECT COUNT(*) AS n FROM raw_events WHERE source = ? AND stream_id = ?`)
			.get("pi", "pi-dedupe-sess") as { n: number };
		expect(Number(count.n)).toBe(1);
	});

	it("forked session id creates a separate pi stream partition", () => {
		for (const sessionId of ["sess-parent", "sess-fork"]) {
			const envelope = requireEnvelope(
				buildRawEventEnvelopeFromPiEvent({
					piEvent: "message_end",
					sessionId,
					entryId: "entry-shared-logical",
					role: "user",
					text: "fork test",
					ts: "2026-06-01T15:02:00Z",
				}),
			);
			store.recordRawEvent({
				opencodeSessionId: envelope.session_stream_id,
				source: envelope.source,
				eventId: envelope.event_id,
				eventType: envelope.event_type,
				payload: envelope.payload,
				tsWallMs: envelope.ts_wall_ms,
			});
		}

		const rows = store.db
			.prepare(
				`SELECT source, stream_id, event_id FROM raw_events WHERE source = ? ORDER BY stream_id`,
			)
			.all("pi") as Array<{ source: string; stream_id: string; event_id: string }>;
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.stream_id).sort()).toEqual(["sess-fork", "sess-parent"]);
		expect(rows.every((r) => r.source === "pi")).toBe(true);
		expect(new Set(rows.map((r) => r.event_id)).size).toBe(2);

		const opencodeCount = store.db
			.prepare(`SELECT COUNT(*) AS n FROM raw_events WHERE source = ?`)
			.get("opencode") as { n: number };
		expect(Number(opencodeCount.n)).toBe(0);
	});
});
