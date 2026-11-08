import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryStore } from "./store.js";

vi.mock("./observer-config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./observer-config.js")>()),
	readCodememConfigFile: vi.fn(() => ({})),
}));

type Stream = { source: string; stream: string };
type Session = Stream & { cursor: number; received: number };
type Event = Stream & { seq: number };
const session = (cursor = -1, received = 99, source = "opencode", stream = "main"): Session => ({
	source,
	stream,
	cursor,
	received,
});
const events = (seqs: number[], source = "opencode", stream = "main"): Event[] =>
	seqs.map((seq) => ({ source, stream, seq }));

function expectedTotals(sessions: Session[], rows: Event[]) {
	let pending = 0;
	let count = 0;
	for (const s of sessions) {
		const seqs = rows
			.filter((e) => e.source === s.source && e.stream === s.stream)
			.map((e) => e.seq);
		if (seqs.length === 0) continue;
		const maximum = Math.max(...seqs);
		if (maximum <= s.cursor) continue;
		count += 1;
		pending += maximum - s.cursor;
	}
	return { sessions: count, pending };
}

let store: MemoryStore;
beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Network disabled in backlog tests");
		}),
	);
	store = new MemoryStore(":memory:");
});
afterEach(() => {
	vi.restoreAllMocks();
	store?.close();
	vi.unstubAllGlobals();
});

function populate(sessions: Session[], rows: Event[]) {
	const insertSession = store.db.prepare(`INSERT INTO raw_event_sessions
			(source, stream_id, opencode_session_id, last_flushed_event_seq, last_received_event_seq, updated_at)
			VALUES (?, ?, 'shared-session', ?, ?, '2026-01-01')`);
	const insertEvent = store.db.prepare(`INSERT INTO raw_events
			(source, stream_id, opencode_session_id, event_seq, event_type, payload_json, created_at)
			VALUES (?, ?, 'shared-session', ?, 'fixture', '{}', '2026-01-01')`);
	for (const s of sessions) insertSession.run(s.source, s.stream, s.cursor, s.received);
	for (const e of rows) insertEvent.run(e.source, e.stream, e.seq);
}

it.each([
	{ name: "empty database", sessions: [], rows: [], expected: { sessions: 0, pending: 0 } },
	{
		name: "orphan events",
		sessions: [],
		rows: events([0, 20]),
		expected: { sessions: 0, pending: 0 },
	},
	{
		name: "stream without events despite received cursor",
		sessions: [session()],
		rows: [],
		expected: { sessions: 0, pending: 0 },
	},
	{
		name: "initial cursor includes sequence zero",
		sessions: [session()],
		rows: events([0]),
		expected: { sessions: 1, pending: 1 },
	},
	{
		name: "zero cursor behind contiguous events",
		sessions: [session(0)],
		rows: events([0, 1, 2]),
		expected: { sessions: 1, pending: 2 },
	},
	{
		name: "sparse sequences use distance rather than COUNT",
		sessions: [session(2)],
		rows: events([1, 7, 30]),
		expected: { sessions: 1, pending: 28 },
	},
	{
		name: "cursor equal to maximum",
		sessions: [session(30)],
		rows: events([1, 7, 30]),
		expected: { sessions: 0, pending: 0 },
	},
	{
		name: "cursor ahead of maximum",
		sessions: [session(40)],
		rows: events([1, 7, 30]),
		expected: { sessions: 0, pending: 0 },
	},
	{
		name: "received behind actual events",
		sessions: [session(0, -1)],
		rows: events([10]),
		expected: { sessions: 1, pending: 10 },
	},
	{
		name: "received ahead of actual events",
		sessions: [session(0, 500)],
		rows: events([10]),
		expected: { sessions: 1, pending: 10 },
	},
])("returns normalized totals for $name", ({ sessions, rows, expected }) => {
	// Arrange: all rows use the real schema, including its uniqueness constraints.
	populate(sessions, rows);
	// Act
	const actual = store.rawEventBacklogTotals();
	// Assert: both fields must be numbers, including when SUM has no input rows.
	expect(actual).toEqual(expected);
});

it("uses schema defaults and accepts nullable metadata without changing totals", () => {
	// Arrange: omit nullable metadata and both cursors instead of relaxing constraints.
	store.db.exec(`INSERT INTO raw_event_sessions(opencode_session_id, updated_at)
			VALUES ('fixture', '2026-01-01');
			INSERT INTO raw_events(opencode_session_id, event_seq, event_type, payload_json, created_at)
			VALUES ('different-session', 0, 'fixture', '{}', '2026-01-01')`);
	// Act
	const actual = store.rawEventBacklogTotals();
	// Assert: pairing uses source/stream rather than opencode_session_id.
	expect(actual).toEqual({ sessions: 1, pending: 1 });
});

it("keeps sources and exact stream variants separate", () => {
	// Arrange: all pairs share an opencode_session_id to detect incorrect join keys.
	populate(
		[
			session(0),
			session(3, 99, "other"),
			session(0, 99, "opencode", "Main"),
			session(0, 99, "opencode", ""),
			session(0, 99, "opencode", "main "),
			session(0, 99, "", "main"),
			session(0, 99, "OPENCODE"),
		],
		[
			...events([10]),
			...events([6], "other"),
			...events([2], "opencode", "Main"),
			...events([8], "opencode", ""),
			...events([4], "opencode", "main "),
			...events([5], "", "main"),
			...events([7], "OPENCODE"),
			...events([999], "orphan"),
		],
	);
	// Act
	const actual = store.rawEventBacklogTotals();
	// Assert: orphan maxima and other source/stream pairs cannot inflate a session.
	expect(actual).toEqual({ sessions: 7, pending: 39 });
});

const generatedCases = [[], [0], [0, 1, 2], [1, 7, 30], [-5, -2], [100, 1000]].flatMap((seqs) =>
	[-6, -1, 0, 2, 7, 30, 1001].flatMap((cursor) =>
		[-1, 7, 5000].map((received) => ({ seqs, cursor, received })),
	),
);
it.each(generatedCases)("matches an independent oracle for %j", ({ seqs, cursor, received }) => {
	// Arrange: deterministic combinations include gaps, empty streams, and ignored orphans.
	const sessions = [
		session(cursor, received),
		session(2, 3, "other"),
		session(-1, 99, "opencode", "empty"),
	];
	const rows = [...events(seqs), ...events([1, 5], "other"), ...events([900], "orphan")];
	populate(sessions, rows);
	const expected = expectedTotals(sessions, rows);
	// Act
	const actual = store.rawEventBacklogTotals();
	// Assert: this oracle never uses SQL, event counts, or the received cursor.
	expect(actual).toEqual(expected);
});

it.each([
	{ name: "low events purged", predicate: "event_seq < 30", pending: 28, sessions: 1 },
	{ name: "all events purged", predicate: "1 = 1", pending: 0, sessions: 0 },
])("recomputes after retention with $name", ({ predicate, pending, sessions }) => {
	// Arrange: last_received remains ahead even when all events are removed.
	populate([session(2, 500)], events([1, 7, 30]));
	const before = store.rawEventBacklogTotals();
	// Act
	store.db.exec(`DELETE FROM raw_events WHERE ${predicate}`);
	const after = store.rawEventBacklogTotals();
	// Assert: retention preserves the high-water distance only while a maximum exists.
	expect(before).toEqual({ sessions: 1, pending: 28 });
	expect(after).toEqual({ sessions, pending });
});

it.each([30, 40])("recomputes after the flushed cursor advances to %i", (cursor) => {
	// Arrange
	populate([session(2)], events([1, 7, 30]));
	const before = store.rawEventBacklogTotals();
	// Act
	store.db.prepare("UPDATE raw_event_sessions SET last_flushed_event_seq = ?").run(cursor);
	const after = store.rawEventBacklogTotals();
	// Assert: neither equality nor an ahead cursor contributes negative backlog.
	expect(before).toEqual({ sessions: 1, pending: 28 });
	expect(after).toEqual({ sessions: 0, pending: 0 });
});

it("seeks the existing source/stream/sequence index without scanning all raw events", () => {
	// Arrange: capture the actual method's SQL rather than explaining a test-only rewrite.
	populate([session(2)], [...events([1, 7, 30]), ...events([999], "orphan")]);
	const prepare = vi.spyOn(store.db, "prepare");
	// Act
	store.rawEventBacklogTotals();
	const query = prepare.mock.calls.find(([sql]) => sql.includes("max_seq"))?.[0];
	prepare.mockRestore();
	if (!query) throw new Error("Backlog query was not captured");
	const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[];
	const details = plan.map((row) => row.detail).join("\n");
	// Assert: planner text is checked for access strategy, without timing or node IDs.
	expect(details).toMatch(
		/SEARCH .*USING COVERING INDEX idx_raw_events_source_stream_seq \(source=\? AND stream_id=\?\)/,
	);
	expect(details).not.toMatch(/\bSCAN (?:e|raw_events)\b/i);
});
