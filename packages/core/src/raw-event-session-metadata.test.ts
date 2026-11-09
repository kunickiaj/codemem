import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { ingestRawEvents } from "./raw-event-ingest.js";
import { initTestSchema } from "./test-utils.js";

const oldMeta = { cwd: "/fixture/old", project: "old", started_at: "2026-01-01T00:00:00Z" };
const newMeta = { cwd: "/fixture/new", project: "new", started_at: "2026-02-01T00:00:00Z" };
const stores: ReturnType<typeof fixture>[] = [];

function fixture() {
	const db = connect(":memory:");
	initTestSchema(db);
	const store = { db };
	const ingest = (request: object) => ingestRawEvents(store, request);
	const session = (source = "opencode", streamId = "stream") =>
		db
			.prepare(
				`SELECT cwd, project, started_at, last_received_event_seq, last_seen_ts_wall_ms
			 FROM raw_event_sessions WHERE source = ? AND stream_id = ?`,
			)
			.get(source, streamId);
	const f = { db, ingest, session };
	stores.push(f);
	return f;
}

function event(eventId: string, metadata: object = {}, overrides: object = {}) {
	return {
		source: "opencode",
		stream_id: "stream",
		event_id: eventId,
		event_type: "prompt",
		payload: {},
		...metadata,
		...overrides,
	};
}

function seedChangedContext(f: ReturnType<typeof fixture>) {
	f.ingest(event("a", oldMeta, { ts_wall_ms: 100 }));
	f.ingest(event("b", newMeta, { ts_wall_ms: 200 }));
}

afterEach(() => {
	for (const f of stores.splice(0)) f.db.close();
});

describe("raw-event session metadata replay", () => {
	it.each(["event", "request"])("preserves populated fields on %s metadata replay", (level) => {
		// Arrange: a distinct event has already moved the session to a new context.
		const f = fixture();
		seedChangedContext(f);
		const replay =
			level === "event"
				? event("a", oldMeta, { ts_wall_ms: 100 })
				: { source: "opencode", stream_id: "stream", ...oldMeta, events: [event("a")] };
		// Act
		const result = f.ingest(replay);
		// Assert: replay does not allocate a sequence or move the maximum timestamp backward.
		expect(result).toEqual({
			inserted: 0,
			skipped: 1,
			received: 1,
			sessions: [{ source: "opencode", streamId: "stream" }],
		});
		expect(f.session()).toEqual({
			...newMeta,
			last_received_event_seq: 1,
			last_seen_ts_wall_ms: 200,
		});
	});

	it("keeps an identical retry stable without an intervening update", () => {
		// Arrange
		const f = fixture();
		const request = event("a", oldMeta);
		f.ingest(request);
		const before = f.session();
		// Act
		const result = f.ingest(request);
		// Assert
		expect(result).toMatchObject({ inserted: 0, skipped: 1 });
		expect(f.session()).toEqual(before);
	});

	it.each(["cwd", "project", "started_at"] as const)(
		"fills missing %s without replacing other fields",
		(field) => {
			// Arrange: only one context field is missing on the stored session.
			const f = fixture();
			f.ingest(event("a", { ...oldMeta, [field]: null }));
			// Act
			const result = f.ingest(event("a", newMeta));
			// Assert: duplicate enrichment remains compatible, field by field.
			expect(result).toMatchObject({ inserted: 0, skipped: 1 });
			expect(f.session()).toMatchObject({ ...oldMeta, [field]: newMeta[field] });
		},
	);

	it.each([false, true])(
		"uses new candidates in a mixed batch with duplicate last=%s",
		(duplicateLast) => {
			// Arrange
			const f = fixture();
			seedChangedContext(f);
			const events = [event("a", oldMeta), event("c", newMeta)];
			if (duplicateLast) events.reverse();
			// Act
			const result = f.ingest({ source: "opencode", stream_id: "stream", events });
			// Assert
			expect(result).toMatchObject({ inserted: 1, skipped: 1, received: 2 });
			expect(f.session()).toEqual({
				...newMeta,
				last_received_event_seq: 2,
				last_seen_ts_wall_ms: 200,
			});
		},
	);

	it("excludes a later copy of the same ID within its first batch", () => {
		// Arrange
		const f = fixture();
		const request = {
			source: "opencode",
			stream_id: "stream",
			events: [event("a", newMeta), event("a", oldMeta)],
		};
		// Act
		const result = f.ingest(request);
		// Assert: only the first copy was inserted and supplies event metadata.
		expect(result).toMatchObject({ inserted: 1, skipped: 1 });
		expect(f.session()).toMatchObject({ ...newMeta, last_received_event_seq: 0 });
	});

	it("retains request fallback when the new candidate omits context", () => {
		// Arrange
		const f = fixture();
		f.ingest(event("a", oldMeta));
		// Act
		const result = f.ingest({
			source: "opencode",
			stream_id: "stream",
			...newMeta,
			events: [event("b"), event("a", oldMeta)],
		});
		// Assert: the duplicate's metadata cannot hide the request fallback.
		expect(result).toMatchObject({ inserted: 1, skipped: 1 });
		expect(f.session()).toMatchObject(newMeta);
	});
});

describe("raw-event metadata compatibility", () => {
	it("keeps arrival-order updates for first-time historical events", () => {
		// Arrange
		const f = fixture();
		f.ingest(event("newer", newMeta, { ts_wall_ms: 200 }));
		// Act
		const result = f.ingest(event("historical", oldMeta, { ts_wall_ms: 100 }));
		// Assert: fixing replay does not introduce timestamp ordering for context.
		expect(result).toMatchObject({ inserted: 1, skipped: 0 });
		expect(f.session()).toEqual({
			...oldMeta,
			last_received_event_seq: 1,
			last_seen_ts_wall_ms: 200,
		});
	});

	it("keeps started_at as the last supplied literal string", () => {
		// Arrange
		const f = fixture();
		f.ingest(event("a", oldMeta));
		// Act
		const result = f.ingest(event("b", { started_at: "not-a-date" }));
		// Assert: no date parsing or earliest-date policy is introduced.
		expect(result.inserted).toBe(1);
		expect(f.session()).toMatchObject({ ...oldMeta, started_at: "not-a-date" });
	});

	it("preserves existing fields when a new unique event omits metadata", () => {
		// Arrange
		const f = fixture();
		f.ingest(event("a", newMeta));
		// Act
		const result = f.ingest(event("b"));
		// Assert
		expect(result.inserted).toBe(1);
		expect(f.session()).toMatchObject({ ...newMeta, last_received_event_seq: 1 });
	});

	it.each(["source", "stream"])("isolates duplicate identity by %s", (dimension) => {
		// Arrange
		const f = fixture();
		seedChangedContext(f);
		const source = dimension === "source" ? "codex" : "opencode";
		const stream = dimension === "stream" ? "other" : "stream";
		const request = event("a", oldMeta, { source, stream_id: stream });
		// Act
		const first = f.ingest(request);
		const retry = f.ingest({ ...request, ...newMeta });
		// Assert
		expect(first).toMatchObject({ inserted: 1, skipped: 0 });
		expect(retry).toMatchObject({ inserted: 0, skipped: 1 });
		expect(f.session(source, stream)).toMatchObject({ ...oldMeta, last_received_event_seq: 0 });
		expect(f.session()).toMatchObject({ ...newMeta, last_received_event_seq: 1 });
	});

	it("protects context when a string sequence matches a legacy ID alias", () => {
		// Arrange: seed the identity used before string sequences were normalized.
		const f = fixture();
		const payload = { text: "supplied" };
		const digest = createHash("sha256")
			.update(JSON.stringify({ p: payload, s: "7", t: "prompt" }))
			.digest("hex")
			.slice(0, 16);
		f.ingest(event(`legacy-seq-7-${digest}`, oldMeta, { payload }));
		f.ingest(event("b", newMeta));
		// Act
		const result = f.ingest({
			source: "opencode",
			stream_id: "stream",
			event_type: "prompt",
			event_seq: "7",
			payload,
			...oldMeta,
		});
		// Assert
		expect(result).toMatchObject({ inserted: 0, skipped: 1 });
		expect(f.session()).toMatchObject({ ...newMeta, last_received_event_seq: 1 });
	});
});
