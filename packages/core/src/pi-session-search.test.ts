/**
 * Tests for pi-session-search.ts — typed accessor over stored pi raw-event
 * envelopes (design D1) and the bounded lexical search (design D5/D6).
 *
 * Accessor tests round-trip REAL envelope fixtures through ingestRawEvents
 * (the same path live events and pi-sessions-import use) and read the
 * payload_json back from raw_events, so the pinned shapes are what storage
 * actually keeps.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connect, type Database } from "./db.js";
import { buildRawEventEnvelopeFromPiEvent } from "./pi-hooks.js";
import { extractPiSessionText, searchPiSessions } from "./pi-session-search.js";
import { ingestRawEvents } from "./raw-event-ingest.js";
import { initTestSchema } from "./test-utils.js";

const PROJECT_A = "pi-search-alpha";
const PROJECT_B = "pi-search-beta";

const cleanupPaths: string[] = [];

function makeDb(): Database {
	const dir = mkdtempSync(join(tmpdir(), "codemem-pi-session-search-"));
	cleanupPaths.push(dir);
	const dbPath = join(dir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	return db;
}

interface SeedMessage {
	sessionId: string;
	entryId: string;
	role: "user" | "assistant";
	text: string;
	ts: string;
	project?: string;
	cwd?: string;
}

function seedPiMessage(db: Database, seed: SeedMessage): void {
	const envelope = buildRawEventEnvelopeFromPiEvent({
		piEvent: "message_end",
		sessionId: seed.sessionId,
		entryId: seed.entryId,
		role: seed.role,
		text: seed.text,
		ts: seed.ts,
		...(seed.project ? { project: seed.project } : {}),
		...(seed.cwd ? { cwd: seed.cwd } : {}),
	});
	if (!envelope) throw new Error("expected envelope for fixture");
	ingestRawEvents(
		{ db },
		{
			source: "pi",
			session_stream_id: envelope.session_stream_id,
			session_id: envelope.session_id,
			opencode_session_id: envelope.opencode_session_id,
			cwd: envelope.cwd,
			project: envelope.project,
			events: [
				{
					event_type: envelope.event_type,
					event_id: envelope.event_id,
					payload: envelope.payload,
					ts_wall_ms: envelope.ts_wall_ms,
					cwd: envelope.cwd,
					project: envelope.project,
				},
			],
		},
	);
}

function seedPiToolCall(db: Database, sessionId: string): void {
	const envelope = buildRawEventEnvelopeFromPiEvent({
		piEvent: "tool_call",
		sessionId,
		toolCallId: "tc-1",
		toolName: "read",
		toolInput: { path: "alpha.txt" },
		ts: "2026-04-01T12:00:05.000Z",
	});
	if (!envelope) throw new Error("expected tool_call envelope");
	ingestRawEvents(
		{ db },
		{
			source: "pi",
			session_stream_id: sessionId,
			session_id: sessionId,
			opencode_session_id: sessionId,
			cwd: envelope.cwd,
			project: envelope.project,
			events: [
				{
					event_type: envelope.event_type,
					event_id: envelope.event_id,
					payload: envelope.payload,
					ts_wall_ms: envelope.ts_wall_ms,
					cwd: envelope.cwd,
					project: envelope.project,
				},
			],
		},
	);
}

/** Read the STORED payload back for one event — the accessor's real input. */
function storedPayload(db: Database, streamId: string): unknown {
	const row = db
		.prepare("SELECT payload_json FROM raw_events WHERE source = 'pi' AND stream_id = ? LIMIT 1")
		.get(streamId) as { payload_json: string } | undefined;
	if (!row) throw new Error(`no stored row for ${streamId}`);
	return JSON.parse(row.payload_json);
}

afterEach(() => {
	while (cleanupPaths.length > 0) {
		const dir = cleanupPaths.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("extractPiSessionText (stored envelope accessor)", () => {
	it("extracts user text from a stored message_end envelope", () => {
		const db = makeDb();
		seedPiMessage(db, {
			sessionId: "sess-acc-1",
			entryId: "e1",
			role: "user",
			text: "  hello accessor  ",
			ts: "2026-04-01T12:00:00.000Z",
		});
		const event = extractPiSessionText(storedPayload(db, "sess-acc-1"));
		expect(event).toEqual({ role: "user", text: "hello accessor" });
	});

	it("extracts assistant text and role from a stored assistant envelope", () => {
		const db = makeDb();
		seedPiMessage(db, {
			sessionId: "sess-acc-2",
			entryId: "e2",
			role: "assistant",
			text: "assistant reply text",
			ts: "2026-04-01T12:00:01.000Z",
		});
		const event = extractPiSessionText(storedPayload(db, "sess-acc-2"));
		expect(event).toEqual({ role: "assistant", text: "assistant reply text" });
	});

	it("returns no text for non-text events (tool_call, session_start)", () => {
		const db = makeDb();
		seedPiToolCall(db, "sess-acc-3");
		expect(extractPiSessionText(storedPayload(db, "sess-acc-3"))).toBeNull();

		const startEnvelope = buildRawEventEnvelopeFromPiEvent({
			piEvent: "session_start",
			sessionId: "sess-acc-3",
			ts: "2026-04-01T12:00:00.000Z",
		});
		expect(startEnvelope).not.toBeNull();
		expect(extractPiSessionText(startEnvelope?.payload)).toBeNull();
	});

	it("returns no text for malformed payloads", () => {
		expect(extractPiSessionText(null)).toBeNull();
		expect(extractPiSessionText(undefined)).toBeNull();
		expect(extractPiSessionText("pi.hook")).toBeNull();
		expect(extractPiSessionText([1, 2, 3])).toBeNull();
		expect(extractPiSessionText({ type: "opencode.event" })).toBeNull();
		expect(extractPiSessionText({ type: "pi.hook", _adapter: { source: "pi" } })).toBeNull();
		expect(
			extractPiSessionText({
				type: "pi.hook",
				_adapter: { source: "pi", event_type: "tool_call" },
			}),
		).toBeNull();
		expect(
			extractPiSessionText({
				type: "pi.hook",
				_adapter: { source: "pi", event_type: "prompt", payload: { text: "   " } },
			}),
		).toBeNull();
	});
});

describe("searchPiSessions matching", () => {
	it("matches by lexical query and orders most-recent-first", () => {
		const db = makeDb();
		seedPiMessage(db, {
			sessionId: "s1",
			entryId: "m1",
			role: "user",
			text: "deploy checklist for the gateway",
			ts: "2026-04-01T12:00:00.000Z",
			project: PROJECT_A,
		});
		seedPiMessage(db, {
			sessionId: "s2",
			entryId: "m2",
			role: "assistant",
			text: "gateway rollout finished cleanly",
			ts: "2026-04-02T12:00:00.000Z",
			project: PROJECT_A,
		});
		const response = searchPiSessions(db, "gateway");
		expect(response.returned).toBe(2);
		expect(response.total_matches).toBe(2);
		expect(response.truncated).toBe(false);
		expect(response.results.map((r) => r.session_id)).toEqual(["s2", "s1"]);
	});

	it("returns an explicit empty result for no matches", () => {
		const db = makeDb();
		seedPiMessage(db, {
			sessionId: "s1",
			entryId: "m1",
			role: "user",
			text: "completely unrelated content",
			ts: "2026-04-01T12:00:00.000Z",
		});
		const response = searchPiSessions(db, "xenoglossia");
		expect(response.results).toEqual([]);
		expect(response.returned).toBe(0);
		expect(response.total_matches).toBe(0);
		expect(response.truncated).toBe(false);
	});

	it("returns an explicit empty result for a tokenless query", () => {
		const db = makeDb();
		const response = searchPiSessions(db, "   !!!   ");
		expect(response.results).toEqual([]);
		expect(response.total_matches).toBe(0);
	});
});

describe("searchPiSessions filters and attribution", () => {
	it("filters by project and session id", () => {
		const db = makeDb();
		seedPiMessage(db, {
			sessionId: "sess-a",
			entryId: "m1",
			role: "user",
			text: "harbor planning notes",
			ts: "2026-04-01T12:00:00.000Z",
			project: PROJECT_A,
		});
		seedPiMessage(db, {
			sessionId: "sess-b",
			entryId: "m2",
			role: "user",
			text: "harbor planning notes elsewhere",
			ts: "2026-04-01T12:00:01.000Z",
			project: PROJECT_B,
		});

		const byProject = searchPiSessions(db, "harbor", { project: PROJECT_A });
		expect(byProject.returned).toBe(1);
		expect(byProject.results[0]?.session_id).toBe("sess-a");
		expect(byProject.results[0]?.project).toBe(PROJECT_A);

		const bySession = searchPiSessions(db, "harbor", { session_id: "sess-b" });
		expect(bySession.returned).toBe(1);
		expect(bySession.results[0]?.session_id).toBe("sess-b");

		const combined = searchPiSessions(db, "harbor", {
			project: PROJECT_B,
			session_id: "sess-a",
		});
		expect(combined.results).toEqual([]);
	});

	it("carries attribution fields from raw-event metadata", () => {
		const db = makeDb();
		seedPiMessage(db, {
			sessionId: "s-attr",
			entryId: "m1",
			role: "assistant",
			text: "attribution probe message",
			ts: "2026-04-01T12:00:00.000Z",
			project: PROJECT_A,
		});
		const match = searchPiSessions(db, "attribution").results[0];
		expect(match?.source).toBe("pi");
		expect(match?.session_id).toBe("s-attr");
		expect(match?.project).toBe(PROJECT_A);
		expect(match?.role).toBe("assistant");
		expect(match?.timestamp).toBe("2026-04-01T12:00:00.000Z");
	});

	it("ignores non-pi sources and non-text pi events", () => {
		const db = makeDb();
		seedPiMessage(db, {
			sessionId: "s-pi",
			entryId: "m1",
			role: "user",
			text: "verdigris query target",
			ts: "2026-04-01T12:00:00.000Z",
		});
		seedPiToolCall(db, "s-pi");
		db.prepare(
			"INSERT INTO raw_events(source, stream_id, opencode_session_id, event_id, event_seq, event_type, ts_wall_ms, payload_json, created_at) VALUES ('opencode', 'oc-1', 'oc-1', 'e1', 1, 'opencode.event', 0, ?, '2026-04-01T00:00:00.000Z')",
		).run(JSON.stringify({ type: "opencode.event", text: "verdigris query target" }));

		const response = searchPiSessions(db, "verdigris");
		expect(response.returned).toBe(1);
		expect(response.results[0]?.session_id).toBe("s-pi");
		expect(response.results[0]?.source).toBe("pi");
	});
});

it("requires a token in the conversation text, not just envelope metadata", () => {
	const db = makeDb();
	seedPiMessage(db, {
		sessionId: "s-meta",
		entryId: "m1",
		role: "user",
		text: "an entirely unrelated ordinary sentence",
		ts: "2026-04-01T12:00:00.000Z",
		cwd: "/repos/metadata-needle-check",
		project: "metadata-needle-project",
	});
	const response = searchPiSessions(db, "metadata needle");
	expect(response.results).toEqual([]);
	expect(response.total_matches).toBe(0);
	expect(searchPiSessions(db, "ordinary").returned).toBe(1);
});

describe("searchPiSessions bounds", () => {
	it("clamps limit to 1–20 and marks truncation when matches are dropped", () => {
		const db = makeDb();
		for (let i = 0; i < 5; i++) {
			seedPiMessage(db, {
				sessionId: "s-clamp",
				entryId: `m${i}`,
				role: "user",
				text: `quota checkpoint number ${i}`,
				ts: new Date(Date.UTC(2026, 3, 1, 12, 0, i)).toISOString(),
			});
		}
		// limit below the 1 clamp
		expect(searchPiSessions(db, "checkpoint", { limit: 0 }).returned).toBe(1);
		// limit above the 20 clamp
		expect(searchPiSessions(db, "checkpoint", { limit: 999 }).returned).toBe(5);

		const limited = searchPiSessions(db, "checkpoint", { limit: 2 });
		expect(limited.returned).toBe(2);
		expect(limited.total_matches).toBe(5);
		expect(limited.truncated).toBe(true);
	});

	it("clamps snippet chars to 100–4000 and reports full length", () => {
		const db = makeDb();
		const longText = `snippet marker ${"x".repeat(5000)}`;
		seedPiMessage(db, {
			sessionId: "s-snippet",
			entryId: "m1",
			role: "user",
			text: longText,
			ts: "2026-04-01T12:00:00.000Z",
		});

		const below = searchPiSessions(db, "snippet", { snippet_chars: 10 });
		expect(below.results[0]?.snippet.length).toBe(100);
		expect(below.results[0]?.snippet_truncated).toBe(true);
		expect(below.results[0]?.full_length).toBe(longText.length);

		const above = searchPiSessions(db, "snippet", { snippet_chars: 99999 });
		expect(above.results[0]?.snippet.length).toBe(4000);
		expect(above.results[0]?.snippet_truncated).toBe(true);
	});

	it("returns short text whole at the default snippet cap", () => {
		const db = makeDb();
		seedPiMessage(db, {
			sessionId: "s-short",
			entryId: "m2",
			role: "user",
			text: "shortmatch fits whole",
			ts: "2026-04-01T12:00:01.000Z",
		});
		const fit = searchPiSessions(db, "shortmatch", { snippet_chars: 1200 });
		expect(fit.results[0]?.snippet).toBe("shortmatch fits whole");
		expect(fit.results[0]?.snippet_truncated).toBe(false);
		expect(fit.results[0]?.full_length).toBe("shortmatch fits whole".length);
	});

	it("snippets center on the first matched token when truncating", () => {
		const db = makeDb();
		seedPiMessage(db, {
			sessionId: "s-window",
			entryId: "m1",
			role: "user",
			text: `${"y".repeat(3000)} needle ${"z".repeat(3000)}`,
			ts: "2026-04-01T12:00:00.000Z",
		});
		const response = searchPiSessions(db, "needle", { snippet_chars: 400 });
		const snippet = response.results[0]?.snippet ?? "";
		expect(snippet.length).toBe(400);
		expect(snippet).toContain("needle");
	});

	it("enforces the ~50KB total output cap with a truncation marker", () => {
		const db = makeDb();
		for (let i = 0; i < 20; i++) {
			seedPiMessage(db, {
				sessionId: "s-cap",
				entryId: `m${i}`,
				role: "user",
				text: `capoverflow ${"p".repeat(4200)}`,
				ts: new Date(Date.UTC(2026, 3, 1, 12, 0, i)).toISOString(),
			});
		}
		const response = searchPiSessions(db, "capoverflow", { limit: 20, snippet_chars: 4000 });
		expect(response.total_matches).toBe(20);
		expect(response.truncated).toBe(true);
		expect(JSON.stringify(response).length).toBeLessThanOrEqual(50_000);
		expect(response.returned).toBeLessThan(20);
	});

	it("applies the project filter before the scan window bound", () => {
		const db = makeDb();
		// 1,005 newer rows from another project would fill the whole scan window…
		for (let i = 0; i < 1005; i++) {
			seedPiMessage(db, {
				sessionId: `s-filler-${i}`,
				entryId: `filler-${i}`,
				role: "user",
				text: `harbor filler note ${i}`,
				ts: new Date(Date.UTC(2026, 3, 2, 12, 0, 0, i)).toISOString(),
				project: PROJECT_B,
			});
		}
		// …so the target project's only match is older than the window start.
		seedPiMessage(db, {
			sessionId: "s-target",
			entryId: "target-1",
			role: "user",
			text: "harbor legacy note",
			ts: "2026-04-01T12:00:00.000Z",
			project: PROJECT_A,
		});
		const response = searchPiSessions(db, "harbor", { project: PROJECT_A });
		expect(response.returned).toBe(1);
		expect(response.results[0]?.session_id).toBe("s-target");
	});
});
