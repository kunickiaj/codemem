import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { ingestRawEvents, RawEventIngestValidationError } from "./raw-event-ingest.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

const cleanupPaths: string[] = [];

function createStore(): MemoryStore {
	return new MemoryStore(createDbPath());
}

function createDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-raw-event-ingest-"));
	cleanupPaths.push(dir);
	const dbPath = join(dir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	return dbPath;
}

function persistedRows(store: MemoryStore): unknown[] {
	return store.db
		.prepare(
			`SELECT source, stream_id, opencode_session_id, event_id, event_seq,
				event_type, ts_wall_ms, ts_mono_ms, payload_json
			 FROM raw_events ORDER BY source, stream_id, event_seq`,
		)
		.all();
}

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("ingestRawEvents", () => {
	it("matches the current MemoryStore batch and metadata persistence behavior", () => {
		const directStore = createStore();
		const referenceStore = createStore();
		try {
			const event = {
				source: "OpenCode",
				session_stream_id: "session-equivalent",
				session_id: "session-equivalent",
				event_id: "event-equivalent-1",
				event_type: "prompt",
				ts_wall_ms: 1_786_742_400_000,
				ts_mono_ms: 42.5,
				payload: { text: "same row" },
				cwd: "/tmp/project",
				project: "project",
			};

			const direct = ingestRawEvents(directStore, event);
			const reference = referenceStore.recordRawEventsBatch("session-equivalent", [event]);
			referenceStore.updateRawEventSessionMeta({
				opencodeSessionId: "session-equivalent",
				cwd: event.cwd,
				project: event.project,
				lastSeenTsWallMs: event.ts_wall_ms,
			});

			expect(direct).toEqual({
				...reference,
				received: 1,
				sessions: [{ source: "opencode", streamId: "session-equivalent" }],
			});
			expect(persistedRows(directStore)).toEqual(persistedRows(referenceStore));
			const session = directStore.db
				.prepare(
					`SELECT source, stream_id, cwd, project, last_seen_ts_wall_ms,
						last_received_event_seq
					 FROM raw_event_sessions`,
				)
				.get();
			expect(session).toEqual({
				source: "opencode",
				stream_id: "session-equivalent",
				cwd: "/tmp/project",
				project: "project",
				last_seen_ts_wall_ms: 1_786_742_400_000,
				last_received_event_seq: 0,
			});
		} finally {
			directStore.close();
			referenceStore.close();
		}
	});

	it("reports duplicate retries as skipped without allocating another sequence", () => {
		const store = createStore();
		try {
			const base = {
				source: "codex",
				session_id: "session-dedup",
				event_id: "event-dedup-1",
				event_type: "codex.hook",
				payload: { value: 1 },
			};
			expect(ingestRawEvents(store, base).inserted).toBe(1);
			expect(ingestRawEvents(store, base)).toMatchObject({ inserted: 0, skipped: 1 });
			expect(ingestRawEvents(store, { ...base, event_id: "event-dedup-2" })).toMatchObject({
				inserted: 1,
				skipped: 0,
			});

			const rows = store.db
				.prepare("SELECT event_id, event_seq FROM raw_events ORDER BY event_seq")
				.all() as Array<{ event_id: string; event_seq: number }>;
			expect(rows).toEqual([
				{ event_id: "event-dedup-1", event_seq: 0 },
				{ event_id: "event-dedup-2", event_seq: 1 },
			]);
		} finally {
			store.close();
		}
	});

	it("deduplicates candidate ids across bounded query chunks", () => {
		const store = createStore();
		try {
			const events = Array.from({ length: 501 }, (_, index) => ({
				event_id: `event-chunk-${index.toString().padStart(4, "0")}`,
				event_type: "tool_call",
				payload: { index },
			}));
			expect(
				ingestRawEvents(store, {
					source: "opencode",
					session_id: "session-chunks",
					events,
				}),
			).toMatchObject({ inserted: 501, skipped: 0 });
			expect(
				ingestRawEvents(store, {
					source: "opencode",
					session_id: "session-chunks",
					events,
				}),
			).toMatchObject({ inserted: 0, skipped: 501 });
		} finally {
			store.close();
		}
	});

	it("uses supplied sequences only for legacy identity and assigns contiguous DB sequences", () => {
		const store = createStore();
		try {
			const numeric = ingestRawEvents(store, {
				source: "opencode",
				session_id: "session-sequences",
				event_type: "prompt",
				event_seq: 7,
				payload: { text: "supplied" },
			});
			const string = ingestRawEvents(store, {
				source: "opencode",
				session_id: "session-sequences",
				event_type: "prompt",
				event_seq: "7",
				payload: { text: "supplied" },
			});
			ingestRawEvents(store, {
				source: "opencode",
				session_id: "session-sequences",
				event_id: "event-sequence-next",
				event_type: "assistant",
				payload: { text: "next" },
			});

			const rows = store.db
				.prepare("SELECT event_id, event_seq FROM raw_events ORDER BY event_seq")
				.all() as Array<{ event_id: string; event_seq: number }>;
			expect(numeric).toMatchObject({ inserted: 1, skipped: 0 });
			expect(string).toMatchObject({ inserted: 0, skipped: 1 });
			expect(rows).toHaveLength(2);
			expect(rows[0]).toMatchObject({ event_seq: 0 });
			expect(rows[0]?.event_id).toMatch(/^legacy-seq-7-/);
			expect(rows[1]).toEqual({ event_id: "event-sequence-next", event_seq: 1 });
		} finally {
			store.close();
		}
	});

	it("assigns unique contiguous sequences across two connections", () => {
		const dbPath = createDbPath();
		const firstStore = new MemoryStore(dbPath);
		const secondStore = new MemoryStore(dbPath);
		try {
			ingestRawEvents(firstStore, {
				source: "claude",
				session_id: "session-two-connections",
				event_id: "cld_evt_first0001",
				event_type: "claude.hook",
				payload: {},
			});
			ingestRawEvents(secondStore, {
				source: "claude",
				session_id: "session-two-connections",
				event_id: "cld_evt_second002",
				event_type: "claude.hook",
				payload: {},
			});

			const rows = firstStore.db
				.prepare("SELECT event_id, event_seq FROM raw_events ORDER BY event_seq")
				.all() as Array<{ event_id: string; event_seq: number }>;
			expect(rows).toEqual([
				{ event_id: "cld_evt_first0001", event_seq: 0 },
				{ event_id: "cld_evt_second002", event_seq: 1 },
			]);
		} finally {
			firstStore.close();
			secondStore.close();
		}
	});

	it.each([
		{
			source: "claude",
			eventId: "cld_evt_0123456789abcdef01234567",
			eventType: "claude.hook",
		},
		{
			source: "codex",
			eventId: "cdx_evt_0123456789abcdef01234567",
			eventType: "codex.hook",
		},
		{
			source: "opencode",
			eventId: "oc:session.fixture:tool_call:0123456789abcdef0123",
			eventType: "tool_call",
		},
	])("accepts real $source adapter event id and type forms", ({ source, eventId, eventType }) => {
		const store = createStore();
		try {
			expect(
				ingestRawEvents(store, {
					source,
					session_id: `session-${source}-fixture`,
					event_id: eventId,
					event_type: eventType,
					payload: {},
				}),
			).toMatchObject({ inserted: 1, skipped: 0 });
		} finally {
			store.close();
		}
	});

	it.each([
		"tool.execute.after",
		"message.part.updated",
		"session.idle",
	])("accepts OpenCode wire event type %s", (eventType) => {
		const store = createStore();
		try {
			expect(
				ingestRawEvents(store, {
					source: "opencode",
					session_id: "session-opencode-wire-types",
					event_id: `event-${eventType}`,
					event_type: eventType,
					payload: {},
				}),
			).toMatchObject({ inserted: 1, skipped: 0 });
		} finally {
			store.close();
		}
	});

	it("accepts legacy signed and zero-padded integer sequences without trusting them", () => {
		const store = createStore();
		try {
			const first = ingestRawEvents(store, {
				source: "opencode",
				session_id: "session-legacy-sequences",
				event_type: "message.updated",
				event_seq: "-1",
				payload: { text: "first" },
			});
			const second = ingestRawEvents(store, {
				source: "opencode",
				session_id: "session-legacy-sequences",
				event_type: "message.updated",
				event_seq: "07",
				payload: { text: "second" },
			});
			expect({ first, second }).toMatchObject({
				first: { inserted: 1 },
				second: { inserted: 1 },
			});
			const rows = store.db
				.prepare("SELECT event_id, event_seq FROM raw_events ORDER BY event_seq")
				.all() as Array<{ event_id: string; event_seq: number }>;
			expect(rows.map((row) => row.event_seq)).toEqual([0, 1]);
			expect(rows[0]?.event_id).toMatch(/^legacy-seq--1-/);
			expect(rows[1]?.event_id).toMatch(/^legacy-seq-7-/);
		} finally {
			store.close();
		}
	});

	it("supports per-event stream overrides with event metadata taking precedence", () => {
		const store = createStore();
		try {
			ingestRawEvents(store, {
				source: "codex",
				stream_id: "stream-default",
				cwd: "/request",
				project: "request-project",
				events: [
					{
						event_id: "cdx_evt_default001",
						event_type: "codex.hook",
						payload: {},
						cwd: "/event",
						project: "event-project",
					},
					{
						stream_id: "stream-override",
						event_id: "cdx_evt_override01",
						event_type: "codex.hook",
						payload: {},
					},
				],
			});

			const sessions = store.db
				.prepare("SELECT stream_id, cwd, project FROM raw_event_sessions ORDER BY stream_id")
				.all();
			expect(sessions).toEqual([
				{ stream_id: "stream-default", cwd: "/event", project: "event-project" },
				{ stream_id: "stream-override", cwd: null, project: null },
			]);
		} finally {
			store.close();
		}
	});

	it.each(["claude", "codex"])("starts a fresh %s stream at sequence zero", (source) => {
		const store = createStore();
		try {
			ingestRawEvents(store, {
				source,
				session_id: `session-${source}`,
				event_id: `event-${source}-first`,
				event_type: `${source}.hook`,
				payload: {},
			});
			const row = store.db.prepare("SELECT event_seq FROM raw_events").get() as {
				event_seq: number;
			};
			expect(row.event_seq).toBe(0);
		} finally {
			store.close();
		}
	});

	it.each([
		{
			name: "a malformed source",
			request: {
				source: "../claude",
				session_id: "session-invalid",
				event_id: "event-invalid-source",
				event_type: "prompt",
				payload: {},
			},
		},
		{
			name: "conflicting session aliases",
			request: {
				source: "claude",
				session_id: "session-one",
				stream_id: "session-two",
				event_id: "event-invalid-session",
				event_type: "prompt",
				payload: {},
			},
		},
		{
			name: "a malformed event id",
			request: {
				source: "claude",
				session_id: "session-invalid",
				event_id: "contains spaces",
				event_type: "prompt",
				payload: {},
			},
		},
		{
			name: "a malformed supplied sequence",
			request: {
				source: "opencode",
				session_id: "session-invalid",
				event_id: "event-invalid-sequence",
				event_type: "prompt",
				event_seq: " ",
				payload: {},
			},
		},
	])("rejects $name before any writes", ({ request }) => {
		const store = createStore();
		try {
			expect(() => ingestRawEvents(store, request)).toThrow(RawEventIngestValidationError);
			const rawCount = store.db.prepare("SELECT COUNT(*) AS count FROM raw_events").get() as {
				count: number;
			};
			const sessionCount = store.db
				.prepare("SELECT COUNT(*) AS count FROM raw_event_sessions")
				.get() as { count: number };
			const statsCount = store.db
				.prepare("SELECT COUNT(*) AS count FROM raw_event_ingest_stats")
				.get() as { count: number };
			expect({
				raw: rawCount.count,
				sessions: sessionCount.count,
				stats: statsCount.count,
			}).toEqual({
				raw: 0,
				sessions: 0,
				stats: 0,
			});
		} finally {
			store.close();
		}
	});

	it("strips private content and redacts sensitive fields before persistence", () => {
		const store = createStore();
		try {
			ingestRawEvents(store, {
				source: "claude",
				session_id: "session-private",
				event_id: "event-private-1",
				event_type: "assistant",
				payload: {
					text: "public <private>do not persist</private> visible",
					api_key: "do-not-persist",
					nested: { password: "also-private" },
				},
			});
			const row = store.db.prepare("SELECT payload_json FROM raw_events").get() as {
				payload_json: string;
			};
			const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
			expect(payload).toEqual({
				text: "public  visible",
				api_key: "[REDACTED]",
				nested: { password: "[REDACTED]" },
			});
			expect(row.payload_json).not.toContain("do not persist");
			expect(row.payload_json).not.toContain("also-private");
		} finally {
			store.close();
		}
	});
});
