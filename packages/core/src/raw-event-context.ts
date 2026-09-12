import { readCaptureContext } from "./capture-context.js";
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
