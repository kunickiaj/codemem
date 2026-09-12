import {
	boundedDelegatedBriefs,
	isBookkeepingOnlyBatch,
	isDelegatedBrief,
	isDelegatedBriefOnlyBatch,
	readCaptureContext,
} from "./capture-context.js";
import { columnExists, type Database, fromJson, fromJsonStrict } from "./db.js";

export interface RawEventContextRow {
	event_seq: number;
	event_type: string;
	ts_wall_ms: number | null;
	ts_mono_ms: number | null;
	payload_json: string;
	event_id: string | null;
	capture_context_json?: string | null;
}

interface FlushBatchRange {
	start_event_seq: number;
	end_event_seq: number;
}

interface AdjacentDelegatedContextOptions {
	source: string;
	streamId: string;
	opencodeSessionId: string;
	startEventSeq: number;
	extractorVersion: string;
}

interface AdjacentDelegatedContext {
	briefs: string[];
	hasDelegatedTask: boolean;
}

const MAX_CONTEXT_ONLY_BATCH_EVENTS = 16;

/** Rebuild an event without trusting similarly named fields inside its payload. */
export function hydrateRawEvent(
	row: RawEventContextRow,
	identity: { source: string; streamId: string },
): Record<string, unknown> {
	const payload = fromJson(row.payload_json) as Record<string, unknown>;
	return hydrateRawEventPayload(row, identity, payload);
}

/** Reject invalid payloads before a maintenance path can persist derived data. */
export function hydrateRawEventStrict(
	row: RawEventContextRow,
	identity: { source: string; streamId: string },
): Record<string, unknown> {
	if (row.payload_json.length === 0) {
		throw new Error(`hydrateRawEventStrict: empty payload_json for event_seq ${row.event_seq}`);
	}
	return hydrateRawEventPayload(row, identity, fromJsonStrict(row.payload_json));
}

function hydrateRawEventPayload(
	row: RawEventContextRow,
	identity: { source: string; streamId: string },
	payload: Record<string, unknown>,
): Record<string, unknown> {
	payload.type = payload.type || row.event_type;
	payload.timestamp_wall_ms = row.ts_wall_ms;
	payload.timestamp_mono_ms = row.ts_mono_ms;
	payload.event_seq = row.event_seq;
	payload.event_id = row.event_id;
	delete payload.capture_context;
	const context = readCaptureContext(row.capture_context_json ?? null, {
		...identity,
		eventType: row.event_type,
		payload,
	});
	if (context) payload.capture_context = context;
	return payload;
}

/** Legacy readers stay read-only: absent sidecar columns mean unknown provenance. */
export function rawEventCaptureContextProjection(db: Database): string {
	return columnExists(db, "raw_events", "capture_context_json")
		? "capture_context_json"
		: "NULL AS capture_context_json";
}

export function loadPriorDelegatedBriefEvents(
	db: Database,
	{
		source,
		streamId,
		beforeEventSeq,
	}: { source: string; streamId: string; beforeEventSeq: number },
): Record<string, unknown>[] {
	if (source !== "opencode" || !columnExists(db, "raw_events", "capture_context_json")) return [];
	const rows = db
		.prepare(`SELECT event_seq, event_type, ts_wall_ms, ts_mono_ms,
		payload_json, event_id, capture_context_json FROM raw_events
		WHERE source = ? AND stream_id = ? AND event_seq < ? AND capture_context_json IS NOT NULL
		ORDER BY event_seq DESC LIMIT 4`)
		.all(source, streamId, beforeEventSeq) as RawEventContextRow[];
	return rows.reverse().map((row) => hydrateRawEvent(row, { source, streamId }));
}

function completedBatchEndingAt(
	db: Database,
	identity: { source: string; streamId: string; opencodeSessionId: string },
	endEventSeq: number,
	extractorVersion: string,
): FlushBatchRange | null {
	const batch = db
		.prepare(
			`SELECT start_event_seq, end_event_seq FROM raw_event_flush_batches
			 WHERE source = ? AND stream_id = ? AND opencode_session_id = ?
			   AND end_event_seq = ? AND status = 'completed'
			   AND extractor_version = ?
			 ORDER BY id DESC LIMIT 1`,
		)
		.get(
			identity.source,
			identity.streamId,
			identity.opencodeSessionId,
			endEventSeq,
			extractorVersion,
		) as FlushBatchRange | undefined;
	return batch ?? null;
}

function loadBatchEvents(
	db: Database,
	identity: { source: string; streamId: string },
	batch: FlushBatchRange,
	maxEventCount: number,
): Record<string, unknown>[] {
	const eventCount = batch.end_event_seq - batch.start_event_seq + 1;
	if (eventCount < 1 || eventCount > maxEventCount) return [];
	const rows = db
		.prepare(
			`SELECT event_seq, event_type, ts_wall_ms, ts_mono_ms,
			 payload_json, event_id, capture_context_json FROM raw_events
			 WHERE source = ? AND stream_id = ? AND event_seq BETWEEN ? AND ?
			 ORDER BY event_seq LIMIT ?`,
		)
		.all(
			identity.source,
			identity.streamId,
			batch.start_event_seq,
			batch.end_event_seq,
			maxEventCount + 1,
		) as RawEventContextRow[];
	if (rows.length !== eventCount) return [];
	return rows.map((row) => hydrateRawEvent(row, identity));
}

/** Resolve delegated-task presence and observer-visible context across adjacent batches. */
export function resolveAdjacentDelegatedContext(
	db: Database,
	{
		source,
		streamId,
		opencodeSessionId,
		startEventSeq,
		extractorVersion,
	}: AdjacentDelegatedContextOptions,
): AdjacentDelegatedContext {
	if (
		source !== "opencode" ||
		!streamId ||
		streamId !== opencodeSessionId ||
		!Number.isSafeInteger(startEventSeq) ||
		startEventSeq <= 0 ||
		!extractorVersion ||
		!columnExists(db, "raw_events", "capture_context_json")
	) {
		return { briefs: [], hasDelegatedTask: false };
	}
	const identity = { source, streamId, opencodeSessionId };
	let remainingEventCount = MAX_CONTEXT_ONLY_BATCH_EVENTS;
	let precedingEventSeq = startEventSeq - 1;
	while (remainingEventCount > 0) {
		const batch = completedBatchEndingAt(db, identity, precedingEventSeq, extractorVersion);
		if (!batch) return { briefs: [], hasDelegatedTask: false };
		const events = loadBatchEvents(db, { source, streamId }, batch, remainingEventCount);
		if (events.length === 0) return { briefs: [], hasDelegatedTask: false };
		if (isDelegatedBriefOnlyBatch(events)) {
			const delegatedEvents = events.filter(isDelegatedBrief);
			return {
				briefs: boundedDelegatedBriefs(delegatedEvents.map((event) => String(event.prompt_text))),
				hasDelegatedTask: delegatedEvents.length > 0,
			};
		}
		if (!isBookkeepingOnlyBatch(events)) {
			return { briefs: [], hasDelegatedTask: false };
		}
		remainingEventCount -= events.length;
		precedingEventSeq = batch.start_event_seq - 1;
	}
	return { briefs: [], hasDelegatedTask: false };
}

/** Resolve bounded observer-visible delegated context across adjacent batches. */
export function resolveAdjacentDelegatedBriefs(
	db: Database,
	options: AdjacentDelegatedContextOptions,
): string[] {
	return resolveAdjacentDelegatedContext(db, options).briefs;
}
