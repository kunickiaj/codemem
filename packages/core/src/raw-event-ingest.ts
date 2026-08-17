import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import { stripPrivateObj } from "./ingest-sanitize.js";

const SESSION_ID_KEYS = [
	"session_stream_id",
	"session_id",
	"stream_id",
	"opencode_session_id",
] as const;
const SOURCE_PATTERN = /^[a-z][a-z0-9._-]*$/;
const EVENT_FIELD_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_SOURCE_LENGTH = 64;
const MAX_EVENT_FIELD_LENGTH = 128;

export interface RawEventIngestStore {
	db: Database;
}

export interface RawEventIngestSession {
	source: string;
	streamId: string;
}

export interface RawEventIngestResult {
	inserted: number;
	skipped: number;
	received: number;
	sessions: RawEventIngestSession[];
}

interface NormalizedEvent {
	streamId: string;
	eventId: string;
	eventIdAliases: string[];
	eventType: string;
	payload: Record<string, unknown>;
	tsWallMs: number | null;
	tsMonoMs: number | null;
	cwd: string | null;
	project: string | null;
	startedAt: string | null;
}

interface NormalizedRequest {
	source: string;
	defaultStreamId: string | null;
	events: NormalizedEvent[];
	received: number;
	requestMeta: Pick<NormalizedEvent, "cwd" | "project" | "startedAt">;
}

export class RawEventIngestValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RawEventIngestValidationError";
	}
}

function validationError(message: string): never {
	throw new RawEventIngestValidationError(message);
}

function normalizeSource(value: unknown): string {
	if (value == null) return "opencode";
	if (typeof value !== "string") validationError("source must be string");
	const source = value.trim().toLowerCase();
	if (!source) validationError("source is required");
	if (source.length > MAX_SOURCE_LENGTH || !SOURCE_PATTERN.test(source)) {
		validationError("source must use 1-64 letters, digits, dots, underscores, or hyphens");
	}
	return source;
}

function resolveStreamId(value: Record<string, unknown>): string | null {
	const aliases = new Map<string, string>();
	for (const key of SESSION_ID_KEYS) {
		const raw = value[key];
		if (raw == null) continue;
		if (typeof raw !== "string") validationError(`${key} must be string`);
		const normalized = raw.trim();
		if (normalized) aliases.set(key, normalized);
	}
	if (aliases.size === 0) return null;
	if (new Set(aliases.values()).size !== 1) validationError("conflicting session id fields");
	const streamId = aliases.values().next().value;
	if (!streamId) return null;
	if (streamId.startsWith("msg_")) validationError("invalid session id");
	return streamId;
}

function optionalString(value: Record<string, unknown>, key: string): string | null {
	const raw = value[key];
	if (raw == null) return null;
	if (typeof raw !== "string") validationError(`${key} must be string`);
	return raw || null;
}

function optionalNumber(value: Record<string, unknown>, key: string): number | null {
	const raw = value[key];
	if (raw == null) return null;
	if (typeof raw !== "number" && typeof raw !== "string") {
		validationError(`${key} must be number`);
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) validationError(`${key} must be number`);
	return parsed;
}

function optionalEventSeq(value: Record<string, unknown>): number | null {
	const raw = value.event_seq;
	if (raw == null) return null;
	if (typeof raw !== "number" && typeof raw !== "string") {
		validationError("event_seq must be int");
	}
	if (typeof raw === "string" && !/^-?\d+$/.test(raw)) {
		validationError("event_seq must be int");
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) validationError("event_seq must be int");
	return parsed;
}

function validateEventField(value: unknown, field: "event_id" | "event_type"): string {
	if (typeof value !== "string") validationError(`${field} must be string`);
	const normalized = value.trim();
	if (!normalized) validationError(`${field} required`);
	if (normalized.length > MAX_EVENT_FIELD_LENGTH || !EVENT_FIELD_PATTERN.test(normalized)) {
		validationError(`${field} has invalid syntax`);
	}
	return normalized;
}

function stableStringify(value: unknown): string {
	return (
		JSON.stringify(value, (_key, item) => {
			if (item == null || typeof item !== "object" || Array.isArray(item)) return item;
			const sorted: Record<string, unknown> = {};
			for (const key of Object.keys(item as Record<string, unknown>).sort()) {
				sorted[key] = (item as Record<string, unknown>)[key];
			}
			return sorted;
		}) ?? ""
	);
}

/** Legacy normalized senders may omit event_id until Viewer ingress migrates in PR 3. */
function generatedEventId(
	eventType: string,
	payload: Record<string, unknown>,
	eventSeq: number | null,
	tsWallMs: number | null,
	tsMonoMs: number | null,
): string {
	const seed =
		eventSeq == null
			? { m: tsMonoMs, p: payload, t: eventType, w: tsWallMs }
			: { p: payload, s: eventSeq, t: eventType };
	const digest = createHash("sha256")
		.update(stableStringify(seed), "utf8")
		.digest("hex")
		.slice(0, 16);
	return eventSeq == null ? `legacy-${digest}` : `legacy-seq-${eventSeq}-${digest}`;
}

function legacyStringSequenceEventId(
	eventType: string,
	payload: Record<string, unknown>,
	eventSeq: string,
): string {
	const digest = createHash("sha256")
		.update(stableStringify({ p: payload, s: eventSeq, t: eventType }), "utf8")
		.digest("hex")
		.slice(0, 16);
	return `legacy-seq-${eventSeq}-${digest}`;
}

function normalizeEvent(
	item: Record<string, unknown>,
	defaultStreamId: string | null,
	source: string,
): NormalizedEvent {
	if (item.source != null && normalizeSource(item.source) !== source) {
		validationError("event source conflicts with request source");
	}
	const streamId = resolveStreamId(item) ?? defaultStreamId;
	if (!streamId) validationError("session id required");
	const eventType = validateEventField(item.event_type, "event_type");
	const eventSeq = optionalEventSeq(item);
	const tsWallMsValue = optionalNumber(item, "ts_wall_ms");
	const tsWallMs = tsWallMsValue == null ? null : Math.floor(tsWallMsValue);
	const tsMonoMs = optionalNumber(item, "ts_mono_ms");
	const rawPayload = item.payload ?? {};
	if (typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
		validationError("payload must be an object");
	}
	const payload = stripPrivateObj(rawPayload) as Record<string, unknown>;
	const rawEventId = item.event_id;
	const eventId =
		rawEventId == null || rawEventId === ""
			? generatedEventId(eventType, payload, eventSeq, tsWallMs, tsMonoMs)
			: validateEventField(rawEventId, "event_id");
	const eventIdAliases = [eventId];
	if ((rawEventId == null || rawEventId === "") && typeof item.event_seq === "string") {
		const legacyEventId = legacyStringSequenceEventId(eventType, payload, item.event_seq);
		if (legacyEventId !== eventId) eventIdAliases.push(legacyEventId);
	}
	return {
		streamId,
		eventId,
		eventIdAliases,
		eventType,
		payload,
		tsWallMs,
		tsMonoMs,
		cwd: optionalString(item, "cwd"),
		project: optionalString(item, "project"),
		startedAt: optionalString(item, "started_at"),
	};
}

function normalizeRequest(request: Record<string, unknown>): NormalizedRequest {
	const source = normalizeSource(request.source);
	const defaultStreamId = resolveStreamId(request);
	const rawEvents = request.events == null ? [request] : request.events;
	if (!Array.isArray(rawEvents)) validationError("events must be a list");
	const events: NormalizedEvent[] = [];
	for (const rawEvent of rawEvents) {
		if (rawEvent == null || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
			validationError("event must be an object");
		}
		events.push(normalizeEvent(rawEvent as Record<string, unknown>, defaultStreamId, source));
	}
	return {
		source,
		defaultStreamId,
		events,
		received: rawEvents.length,
		requestMeta: {
			cwd: optionalString(request, "cwd"),
			project: optionalString(request, "project"),
			startedAt: optionalString(request, "started_at"),
		},
	};
}

function persistStream(
	store: RawEventIngestStore,
	source: string,
	streamId: string,
	events: NormalizedEvent[],
	request: NormalizedRequest,
	singleStream: boolean,
): { inserted: number; skippedDuplicate: number } {
	let skippedDuplicate = 0;
	const seenIds = new Set<string>();
	const uniqueCandidates = events.filter((event) => {
		if (event.eventIdAliases.some((eventId) => seenIds.has(eventId))) {
			skippedDuplicate++;
			return false;
		}
		for (const eventId of event.eventIdAliases) seenIds.add(eventId);
		return true;
	});
	const existingIds = new Set<string>();
	const candidateEventIds = [...new Set(uniqueCandidates.flatMap((event) => event.eventIdAliases))];
	for (let offset = 0; offset < candidateEventIds.length; offset += 500) {
		const eventIds = candidateEventIds.slice(offset, offset + 500);
		const placeholders = eventIds.map(() => "?").join(", ");
		const rows = store.db
			.prepare(
				`SELECT event_id FROM raw_events
				 WHERE source = ? AND stream_id = ? AND event_id IN (${placeholders})`,
			)
			.all(source, streamId, ...eventIds) as Array<{ event_id: string | null }>;
		for (const row of rows) {
			if (row.event_id) existingIds.add(row.event_id);
		}
	}
	const candidates = uniqueCandidates.filter(
		(event) => !event.eventIdAliases.some((eventId) => existingIds.has(eventId)),
	);
	skippedDuplicate += uniqueCandidates.length - candidates.length;

	const sessionRow = store.db
		.prepare(
			"SELECT last_received_event_seq FROM raw_event_sessions WHERE source = ? AND stream_id = ?",
		)
		.get(source, streamId) as { last_received_event_seq: number } | undefined;
	const maxRow = store.db
		.prepare(
			"SELECT MAX(event_seq) AS max_event_seq FROM raw_events WHERE source = ? AND stream_id = ?",
		)
		.get(source, streamId) as { max_event_seq: number | null };
	let lastReceived = Math.max(
		Number(sessionRow?.last_received_event_seq ?? -1),
		Number(maxRow.max_event_seq ?? -1),
	);

	const now = new Date().toISOString();
	const insertEvent = store.db.prepare(
		`INSERT INTO raw_events(
			source, stream_id, opencode_session_id, event_id, event_seq,
			event_type, ts_wall_ms, ts_mono_ms, payload_json, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	let inserted = 0;
	for (const event of candidates) {
		const assignedSeq = lastReceived + 1;
		insertEvent.run(
			source,
			streamId,
			streamId,
			event.eventId,
			assignedSeq,
			event.eventType,
			event.tsWallMs,
			event.tsMonoMs,
			JSON.stringify(event.payload),
			now,
		);
		inserted++;
		lastReceived = assignedSeq;
	}

	const applyRequestMeta = singleStream || request.defaultStreamId === streamId;
	const eventMeta = events.reduce(
		(meta, event) => ({
			cwd: event.cwd ?? meta.cwd,
			project: event.project ?? meta.project,
			startedAt: event.startedAt ?? meta.startedAt,
		}),
		{ cwd: null, project: null, startedAt: null } as Pick<
			NormalizedEvent,
			"cwd" | "project" | "startedAt"
		>,
	);
	const cwd = eventMeta.cwd ?? (applyRequestMeta ? request.requestMeta.cwd : null);
	const project = eventMeta.project ?? (applyRequestMeta ? request.requestMeta.project : null);
	const startedAt =
		eventMeta.startedAt ?? (applyRequestMeta ? request.requestMeta.startedAt : null);
	const lastSeen = events.reduce<number | null>(
		(max, event) =>
			event.tsWallMs == null ? max : Math.max(max ?? event.tsWallMs, event.tsWallMs),
		null,
	);
	store.db
		.prepare(
			`INSERT INTO raw_event_sessions(
				source, stream_id, opencode_session_id, cwd, project, started_at,
				last_seen_ts_wall_ms, last_received_event_seq, last_flushed_event_seq, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, -1, ?)
			 ON CONFLICT(source, stream_id) DO UPDATE SET
				opencode_session_id = excluded.opencode_session_id,
				cwd = COALESCE(excluded.cwd, raw_event_sessions.cwd),
				project = COALESCE(excluded.project, raw_event_sessions.project),
				started_at = COALESCE(excluded.started_at, raw_event_sessions.started_at),
				last_seen_ts_wall_ms = CASE
					WHEN excluded.last_seen_ts_wall_ms IS NULL THEN raw_event_sessions.last_seen_ts_wall_ms
					WHEN raw_event_sessions.last_seen_ts_wall_ms IS NULL THEN excluded.last_seen_ts_wall_ms
					ELSE MAX(excluded.last_seen_ts_wall_ms, raw_event_sessions.last_seen_ts_wall_ms)
				END,
				last_received_event_seq = MAX(
					excluded.last_received_event_seq,
					raw_event_sessions.last_received_event_seq
				),
				updated_at = excluded.updated_at`,
		)
		.run(source, streamId, streamId, cwd, project, startedAt, lastSeen, lastReceived, now);
	return { inserted, skippedDuplicate };
}

function recordIngestOutcome(
	store: RawEventIngestStore,
	inserted: number,
	skippedDuplicate: number,
): void {
	const now = new Date().toISOString();
	const skipped = skippedDuplicate;
	store.db
		.prepare(
			`INSERT INTO raw_event_ingest_samples(
				created_at, inserted_events, skipped_invalid, skipped_duplicate, skipped_conflict
			 ) VALUES (?, ?, 0, ?, ?)`,
		)
		.run(now, inserted, skippedDuplicate, 0);
	store.db
		.prepare(
			`INSERT INTO raw_event_ingest_stats(
				id, inserted_events, skipped_events, skipped_invalid,
				skipped_duplicate, skipped_conflict, updated_at
			 ) VALUES (1, ?, ?, 0, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				inserted_events = raw_event_ingest_stats.inserted_events + excluded.inserted_events,
				skipped_events = raw_event_ingest_stats.skipped_events + excluded.skipped_events,
				skipped_invalid = raw_event_ingest_stats.skipped_invalid + excluded.skipped_invalid,
				skipped_duplicate = raw_event_ingest_stats.skipped_duplicate + excluded.skipped_duplicate,
				skipped_conflict = raw_event_ingest_stats.skipped_conflict + excluded.skipped_conflict,
				updated_at = excluded.updated_at`,
		)
		.run(inserted, skipped, skippedDuplicate, 0, now);
}

export function ingestRawEvents(store: RawEventIngestStore, request: object): RawEventIngestResult {
	const normalized = normalizeRequest(request as Record<string, unknown>);
	return store.db
		.transaction(() => {
			const byStream = new Map<string, NormalizedEvent[]>();
			for (const event of normalized.events) {
				const events = byStream.get(event.streamId) ?? [];
				events.push(event);
				byStream.set(event.streamId, events);
			}
			let inserted = 0;
			let skippedDuplicate = 0;
			const sessions: RawEventIngestSession[] = [];
			const singleStream = byStream.size === 1;
			for (const [streamId, events] of byStream) {
				const result = persistStream(
					store,
					normalized.source,
					streamId,
					events,
					normalized,
					singleStream,
				);
				inserted += result.inserted;
				skippedDuplicate += result.skippedDuplicate;
				sessions.push({ source: normalized.source, streamId });
			}
			recordIngestOutcome(store, inserted, skippedDuplicate);
			return {
				inserted,
				skipped: skippedDuplicate,
				received: normalized.received,
				sessions,
			};
		})
		.immediate();
}
