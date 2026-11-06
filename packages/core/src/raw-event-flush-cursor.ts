import type { MemoryStore } from "./store.js";

export const LIVE_RAW_EVENT_EXTRACTOR = "raw_events_v1";

export interface RawEventFlushRange {
	source: string;
	streamId: string;
	startEventSeq: number;
	lastEventSeq: number;
}

export function readLiveRawEventFlushRange(
	store: MemoryStore,
	batchId: number,
): RawEventFlushRange | null {
	const row = store.db
		.prepare(`SELECT source, stream_id, start_event_seq, end_event_seq
			FROM raw_event_flush_batches WHERE id = ? AND extractor_version = ?`)
		.get(batchId, LIVE_RAW_EVENT_EXTRACTOR) as
		| { source: string; stream_id: string; start_event_seq: number; end_event_seq: number }
		| undefined;
	if (!row) return null;
	return {
		source: row.source,
		streamId: row.stream_id,
		startEventSeq: row.start_event_seq,
		lastEventSeq: row.end_event_seq,
	};
}

/** Call inside IMMEDIATE, including when validating a previously read range. */
export function isRawEventFlushPrefix(store: MemoryStore, range: RawEventFlushRange): boolean {
	const cursor = store.rawEventFlushState(range.streamId, range.source);
	if (range.startEventSeq <= cursor || range.lastEventSeq <= cursor) return false;
	if (range.lastEventSeq < range.startEventSeq) return false;
	// Purged sequence gaps are safe. A stored earlier event still needs its own commit.
	return !store.db
		.prepare(`SELECT 1 FROM raw_events
			WHERE source = ? AND stream_id = ? AND event_seq > ? AND event_seq < ? LIMIT 1`)
		.get(range.source, range.streamId, cursor, range.startEventSeq);
}

/** Caller checks generation/status and prefix within the same IMMEDIATE transaction. */
export function advanceRawEventFlushCursor(store: MemoryStore, range: RawEventFlushRange): void {
	store.updateRawEventFlushState(range.streamId, range.lastEventSeq, range.source);
}
