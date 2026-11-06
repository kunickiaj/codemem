import {
	advanceRawEventFlushCursor,
	isRawEventFlushPrefix,
	LIVE_RAW_EVENT_EXTRACTOR,
	type RawEventFlushRange,
	readLiveRawEventFlushRange,
} from "./raw-event-flush-cursor.js";
import type { MemoryStore } from "./store.js";

export function rawEventStuckBatchMs(): number {
	const parsed = Number.parseInt(process.env.CODEMEM_RAW_EVENTS_STUCK_BATCH_MS ?? "", 10);
	return Number.isFinite(parsed) ? parsed : 300_000;
}

/** Only live claims compete for the stream. Historical recovery has its own ownership. */
export function expireStuckRawEventFlushClaims(
	store: MemoryStore,
	stream: { source: string; streamId: string },
): void {
	const windowMs = rawEventStuckBatchMs();
	if (windowMs <= 0) return;
	const cutoff = new Date(Date.now() - windowMs).toISOString();
	// Keep the sweeper's timestamp ordering, including its future-clock policy.
	store.db
		.prepare(`UPDATE raw_event_flush_batches
		SET status = 'failed', updated_at = ?, error_type = 'RawEventBatchStuck',
			error_message = 'Flush retry timed out.', observer_provider = NULL,
			observer_model = NULL, observer_runtime = NULL, observer_auth_source = NULL,
			observer_auth_type = NULL, observer_error_code = NULL, observer_error_message = NULL
		WHERE extractor_version = ? AND status IN ('claimed', 'running') AND updated_at < ?
		AND source = ? AND stream_id = ?`)
		.run(
			new Date().toISOString(),
			LIVE_RAW_EVENT_EXTRACTOR,
			cutoff,
			stream.source,
			stream.streamId,
		);
}

function hasActiveRawEventFlush(
	store: MemoryStore,
	range: { source: string; streamId: string },
): boolean {
	expireStuckRawEventFlushClaims(store, range);
	return (
		store.db
			.prepare(`SELECT 1 FROM raw_event_flush_batches
		WHERE source = ? AND stream_id = ? AND extractor_version = ?
		AND status IN ('claimed', 'running') LIMIT 1`)
			.get(range.source, range.streamId, LIVE_RAW_EVENT_EXTRACTOR) != null
	);
}

export interface RawEventFlushClaim {
	batchId: number;
	generation: number;
	attemptCount: number;
}

export interface RawEventFlushPersistence {
	claim: RawEventFlushClaim;
	source: string;
	streamId: string;
	lastEventSeq: number;
}

export class RawEventFlushClaimLostError extends Error {
	constructor() {
		super("Raw-event flush claim is no longer current");
		this.name = "RawEventFlushClaimLostError";
	}
}

export function readRawEventFlushClaim(store: MemoryStore, batchId: number): RawEventFlushClaim {
	const row = store.db
		.prepare("SELECT claim_generation, attempt_count FROM raw_event_flush_batches WHERE id = ?")
		.get(batchId) as { claim_generation: number; attempt_count: number };
	return { batchId, generation: row.claim_generation, attemptCount: row.attempt_count };
}

export function getRawEventFlushBatchSnapshot(
	store: MemoryStore,
	...args: Parameters<MemoryStore["getOrCreateRawEventFlushBatch"]>
) {
	return store.db
		.transaction(() => {
			const [rawStreamId, rawSource, startEventSeq, lastEventSeq, extractor] = args;
			const streamId = rawStreamId.trim();
			const source = rawSource.trim().toLowerCase() || "opencode";
			const range = { source, streamId, startEventSeq, lastEventSeq };
			if (extractor !== LIVE_RAW_EVENT_EXTRACTOR) return null;
			if (hasActiveRawEventFlush(store, range) || !isRawEventFlushPrefix(store, range)) return null;
			const batch = store.getOrCreateRawEventFlushBatch(...args);
			return { ...batch, snapshot: readRawEventFlushClaim(store, batch.batchId) };
		})
		.immediate();
}

export function finalizeFailedRawEventFlush(
	store: MemoryStore,
	context: RawEventFlushPersistence,
	status: "completed" | "gave_up",
): boolean {
	return store.db
		.transaction(() => {
			const unchanged = store.db
				.prepare(`SELECT 1 FROM raw_event_flush_batches
				WHERE id = ? AND claim_generation = ? AND attempt_count = ?
				AND status IN ('failed', 'error')`)
				.get(context.claim.batchId, context.claim.generation, context.claim.attemptCount);
			if (!unchanged) return false;
			const range = persistenceRange(store, context);
			if (!range || hasActiveRawEventFlush(store, range) || !isRawEventFlushPrefix(store, range))
				return false;
			store.updateRawEventFlushBatchStatus(context.claim.batchId, status);
			advanceRawEventFlushCursor(store, range);
			return true;
		})
		.immediate();
}

export function claimRawEventFlush(store: MemoryStore, batchId: number): RawEventFlushClaim | null {
	return store.db
		.transaction(() => {
			const range = readLiveRawEventFlushRange(store, batchId);
			if (!range || hasActiveRawEventFlush(store, range) || !isRawEventFlushPrefix(store, range))
				return null;
			if (!store.claimRawEventFlushBatch(batchId)) return null;
			return readRawEventFlushClaim(store, batchId);
		})
		.immediate();
}

/** Call inside an immediate transaction so the checked row cannot change before writes. */
export function ownsRawEventFlushClaim(
	store: MemoryStore,
	claim: RawEventFlushClaim,
	status = "claimed",
): boolean {
	return (
		store.db
			.prepare(`SELECT 1 FROM raw_event_flush_batches
		WHERE id = ? AND status = ? AND claim_generation = ?`)
			.get(claim.batchId, status, claim.generation) != null
	);
}

export function requireRawEventFlushClaim(store: MemoryStore, claim: RawEventFlushClaim): void {
	if (!ownsRawEventFlushClaim(store, claim)) throw new RawEventFlushClaimLostError();
}

/** Complete inside the same transaction as content and usage, after checking ownership. */
export function completeRawEventFlush(
	store: MemoryStore,
	context: RawEventFlushPersistence,
): RawEventFlushClaim {
	requireRawEventFlushClaim(store, context.claim);
	const range = persistenceRange(store, context);
	if (!range || !isRawEventFlushPrefix(store, range)) throw new RawEventFlushClaimLostError();
	store.updateRawEventFlushBatchStatus(context.claim.batchId, "completed");
	advanceRawEventFlushCursor(store, range);
	return readRawEventFlushClaim(store, context.claim.batchId);
}

function persistenceRange(
	store: MemoryStore,
	context: RawEventFlushPersistence,
): RawEventFlushRange | null {
	const range = readLiveRawEventFlushRange(store, context.claim.batchId);
	if (
		!range ||
		range.source !== context.source ||
		range.streamId !== context.streamId ||
		range.lastEventSeq !== context.lastEventSeq
	)
		return null;
	return range;
}

export function repairCompletedRawEventFlush(
	store: MemoryStore,
	context: RawEventFlushPersistence,
): boolean {
	return store.db
		.transaction(() => {
			if (!ownsRawEventFlushClaim(store, context.claim, "completed")) return false;
			const range = persistenceRange(store, context);
			if (!range || hasActiveRawEventFlush(store, range) || !isRawEventFlushPrefix(store, range))
				return false;
			advanceRawEventFlushCursor(store, range);
			return true;
		})
		.immediate();
}
