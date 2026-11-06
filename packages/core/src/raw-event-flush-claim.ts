import type { MemoryStore } from "./store.js";

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
			store.updateRawEventFlushBatchStatus(context.claim.batchId, status);
			store.updateRawEventFlushState(context.streamId, context.lastEventSeq, context.source);
			return true;
		})
		.immediate();
}

export function claimRawEventFlush(store: MemoryStore, batchId: number): RawEventFlushClaim | null {
	return store.db
		.transaction(() => {
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
	store.updateRawEventFlushBatchStatus(context.claim.batchId, "completed");
	store.updateRawEventFlushState(context.streamId, context.lastEventSeq, context.source);
	return readRawEventFlushClaim(store, context.claim.batchId);
}
