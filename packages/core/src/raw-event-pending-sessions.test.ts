import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObserverClient } from "./observer-client.js";
import { capturePlans, recordPlans, statementsScanning } from "./query-plan-test-fixtures.js";
import { RawEventSweeper } from "./raw-event-sweeper.js";
import { MemoryStore } from "./store.js";

vi.mock("./observer-config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./observer-config.js")>()),
	readCodememConfigFile: vi.fn(() => ({})),
}));

let store: MemoryStore;

interface SessionInput {
	stream: string;
	source?: string;
	/** Event sequences stored for the stream. */
	events: number[];
	flushed: number;
	/** Defaults to the newest stored event, as every writer leaves it. */
	received?: number;
	lastSeen?: number | null;
}

function addSession(input: SessionInput): void {
	const source = input.source ?? "opencode";
	const received = input.received ?? Math.max(-1, ...input.events);
	store.db
		.prepare(
			`INSERT INTO raw_event_sessions(source, stream_id, opencode_session_id,
				last_flushed_event_seq, last_received_event_seq, last_seen_ts_wall_ms, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, '2026-01-01')`,
		)
		.run(
			source,
			input.stream,
			input.stream,
			input.flushed,
			received,
			input.lastSeen === undefined ? 1_000 : input.lastSeen,
		);
	const insertEvent = store.db.prepare(
		`INSERT INTO raw_events(source, stream_id, opencode_session_id, event_seq, event_type,
			payload_json, created_at)
		 VALUES (?, ?, ?, ?, 'fixture', '{}', '2026-01-01')`,
	);
	for (const seq of input.events) insertEvent.run(source, input.stream, input.stream, seq);
}

function addBatch(stream: string, status: string, range: [number, number], updatedAt: string) {
	store.db
		.prepare(
			`INSERT INTO raw_event_flush_batches(source, stream_id, opencode_session_id,
				start_event_seq, end_event_seq, extractor_version, status, created_at, updated_at)
			 VALUES ('opencode', ?, ?, ?, ?, 'fixture', ?, ?, ?)`,
		)
		.run(stream, stream, range[0], range[1], status, updatedAt, updatedAt);
}

const streams = (rows: Array<{ streamId: string }>) => rows.map((row) => row.streamId);

/** Holds only sessions with events past their cursor, so reading all of it is the intent. */
const PENDING_SESSIONS = { exceptIndexes: ["idx_raw_event_sessions_pending_updated"] };

beforeEach(() => {
	store = new MemoryStore(":memory:");
});

afterEach(() => {
	store.close();
});

describe("rawEventSessionsPendingFlush", () => {
	it("lists sessions with stored events past their cursor, oldest activity first", () => {
		addSession({ stream: "newer", events: [0, 1, 2], flushed: 0, lastSeen: 2_000 });
		addSession({ stream: "older", events: [0, 1], flushed: -1, lastSeen: 1_000 });
		addSession({ stream: "flushed", events: [0, 1], flushed: 1 });
		addSession({ stream: "no-activity-time", events: [0], flushed: -1, lastSeen: null });
		// Retention removed the events this session received after its cursor.
		addSession({ stream: "purged", events: [0], flushed: 0, received: 5 });
		addSession({ stream: "pi-session", source: "pi", events: [0], flushed: -1, lastSeen: 500 });

		expect(streams(store.rawEventSessionsPendingFlush())).toEqual(["pi-session", "older", "newer"]);
		expect(streams(store.rawEventSessionsPendingFlush(1))).toEqual(["pi-session"]);
		expect(streams(store.rawEventSessionsPendingFlush(null, "opencode"))).toEqual([
			"older",
			"newer",
		]);
		expect(streams(store.rawEventSessionsPendingIdleFlush(1_000))).toEqual(["pi-session", "older"]);
	});

	it("reads the sessions with work and not every stored event", () => {
		addSession({ stream: "pending", events: [0, 1], flushed: 0 });

		const plans = capturePlans(store.db, () => store.rawEventSessionsPendingFlush());

		expect(statementsScanning(plans, "raw_event_sessions", PENDING_SESSIONS)).toEqual([]);
		expect(statementsScanning(plans, "raw_events")).toEqual([]);
	});
});

describe("rawEventSessionsWithPendingQueue", () => {
	it("lists sessions with unflushed events and a batch waiting for a retry", () => {
		addSession({ stream: "retry-later", events: [0, 1, 2], flushed: 0 });
		addBatch("retry-later", "failed", [1, 2], "2026-02-02");
		addSession({ stream: "retry-first", events: [0, 1], flushed: -1 });
		addBatch("retry-first", "pending", [0, 1], "2026-02-01");
		addSession({ stream: "no-batch", events: [0], flushed: -1 });
		addSession({ stream: "done-batch", events: [0, 1], flushed: 0 });
		addBatch("done-batch", "completed", [0, 0], "2026-01-15");

		expect(streams(store.rawEventSessionsWithPendingQueue())).toEqual([
			"retry-first",
			"retry-later",
		]);
		expect(streams(store.rawEventSessionsWithPendingQueue(1))).toEqual(["retry-first"]);
	});

	it("leaves out a failed batch whose session has nothing left to flush", () => {
		// The stream was flushed through another range; the failed batch is history.
		addSession({ stream: "flushed", events: [0, 1, 2], flushed: 2 });
		addBatch("flushed", "failed", [0, 1], "2026-02-01");

		expect(store.rawEventSessionsWithPendingQueue()).toEqual([]);
	});

	it("selects a batch requeued by the retry command once its session has events to flush", () => {
		addSession({ stream: "requeued", events: [0, 1, 2], flushed: 0 });
		addBatch("requeued", "failed", [1, 2], "2026-02-01");
		store.db.prepare("UPDATE raw_event_flush_batches SET status = 'pending'").run();

		expect(streams(store.rawEventSessionsWithPendingQueue())).toEqual(["requeued"]);
	});

	it("does not read the flush batches or events of sessions with nothing to flush", () => {
		addSession({ stream: "pending", events: [0, 1], flushed: 0 });
		addBatch("pending", "failed", [1, 1], "2026-02-01");

		const plans = capturePlans(store.db, () => store.rawEventSessionsWithPendingQueue());

		expect(statementsScanning(plans, "raw_event_sessions", PENDING_SESSIONS)).toEqual([]);
		expect(statementsScanning(plans, "raw_event_flush_batches")).toEqual([]);
		expect(statementsScanning(plans, "raw_events")).toEqual([]);
	});
});

describe("RawEventSweeper tick", () => {
	it("reads no table in full when there is nothing to flush or recover", async () => {
		addSession({ stream: "flushed", events: [0, 1, 2], flushed: 2 });
		addBatch("flushed", "failed", [0, 1], "2026-02-01");
		const sweeper = new RawEventSweeper(store, { observer: new ObserverClient() });

		const recording = recordPlans(store.db);
		await sweeper.tick();
		const plans = recording.stop();

		expect(plans.length).toBeGreaterThan(0);
		expect(statementsScanning(plans, "raw_events")).toEqual([]);
		expect(statementsScanning(plans, "memory_items")).toEqual([]);
		expect(statementsScanning(plans, "raw_event_sessions", PENDING_SESSIONS)).toEqual([]);
		// History recovery reads its two partial indexes, which hold only batches it can act on.
		expect(
			statementsScanning(plans, "raw_event_flush_batches", {
				exceptIndexes: ["idx_flush_batches_auth_missing", "idx_flush_batches_recovery_attempts"],
			}),
		).toEqual([]);
	});
});
