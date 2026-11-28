import { RateLimiter } from "limiter";

export interface InMemoryRequestRateLimiter {
	check(key: string, limit: number): { allowed: boolean; retryAfterS: number };
	/** Buckets held now, not counting overflow budgets. Never more than the bucket ceiling. */
	bucketCount?(): number;
}

/** Enough for every key a personal device sees, small enough that key churn stays cheap. */
export const DEFAULT_MAX_RATE_LIMIT_BUCKETS = 10_000;

type Bucket = { limiter: RateLimiter; lastUsedAt: number };

/**
 * A token bucket per key, at most maxBuckets of them.
 *
 * A full map never evicts a bucket that may still be depleted, because a key
 * could then refill its budget by churning other keys through the map. Only a
 * bucket unused for a whole window, which has refilled anyway, can make room.
 * When none can, a new key draws from one overflow budget per limit that
 * every such key shares, so churn spends that budget instead of minting fresh
 * ones.
 */
export function createInMemoryRequestRateLimiter(
	windowMs = 60_000,
	options: { maxBuckets?: number } = {},
): InMemoryRequestRateLimiter {
	const safeWindowMs = Math.max(1000, Math.trunc(windowMs));
	const maxBuckets = Math.max(1, Math.trunc(options.maxBuckets ?? DEFAULT_MAX_RATE_LIMIT_BUCKETS));
	// Map order is least recently used first.
	const buckets = new Map<string, Bucket>();
	const overflow = new Map<number, Bucket>();
	let checks = 0;

	// The limiter package measures its windows with the global performance.now, so this does too.
	const newBucket = (limit: number, now: number): Bucket => ({
		limiter: new RateLimiter({
			tokensPerInterval: limit,
			interval: safeWindowMs,
			fireImmediately: true,
		}),
		lastUsedAt: now,
	});

	function estimatedRetryAfterS(limit: number): number {
		return Math.max(1, Math.ceil(safeWindowMs / Math.max(1, limit) / 1000));
	}

	function cleanupExpiredBuckets(now: number): void {
		if (buckets.size < 64 || checks % 64 !== 0) return;
		const staleBefore = now - safeWindowMs * 10;
		for (const [key, bucket] of buckets) {
			if (bucket.lastUsedAt < staleBefore) buckets.delete(key);
		}
	}

	/** Frees the stalest slot only if that bucket sat unused for a full window. */
	function makeRoom(now: number): boolean {
		if (buckets.size < maxBuckets) return true;
		const [stalestKey, stalest] = buckets.entries().next().value ?? [];
		if (stalestKey === undefined || !stalest || now - stalest.lastUsedAt < safeWindowMs)
			return false;
		buckets.delete(stalestKey);
		return true;
	}

	function bucketFor(bucketKey: string, limit: number, now: number): Bucket {
		const existing = buckets.get(bucketKey);
		if (existing) {
			buckets.delete(bucketKey);
			buckets.set(bucketKey, existing);
			return existing;
		}
		if (makeRoom(now)) {
			const created = newBucket(limit, now);
			buckets.set(bucketKey, created);
			return created;
		}
		const shared = overflow.get(limit) ?? newBucket(limit, now);
		overflow.set(limit, shared);
		return shared;
	}

	return {
		check(key: string, limit: number) {
			checks += 1;
			const now = performance.now();
			cleanupExpiredBuckets(now);
			const safeLimit = Math.max(1, Math.trunc(limit));
			const bucket = bucketFor(`${safeLimit}:${key}`, safeLimit, now);
			bucket.lastUsedAt = now;
			if (bucket.limiter.tryRemoveTokens(1)) return { allowed: true, retryAfterS: 0 };
			return { allowed: false, retryAfterS: estimatedRetryAfterS(safeLimit) };
		},
		bucketCount: () => buckets.size,
	};
}
