import { RateLimiter } from "limiter";

export interface InMemoryRequestRateLimiter {
	check(key: string, limit: number): { allowed: boolean; retryAfterS: number };
	/** Buckets held now. Never more than the limiter's bucket ceiling. */
	bucketCount?(): number;
}

/** Enough for every key a personal device sees, small enough that key churn stays cheap. */
export const DEFAULT_MAX_RATE_LIMIT_BUCKETS = 10_000;

export function createInMemoryRequestRateLimiter(
	windowMs = 60_000,
	options: { maxBuckets?: number } = {},
): InMemoryRequestRateLimiter {
	const safeWindowMs = Math.max(1000, Math.trunc(windowMs));
	const maxBuckets = Math.max(1, Math.trunc(options.maxBuckets ?? DEFAULT_MAX_RATE_LIMIT_BUCKETS));
	// Map order is least recently used first, so the ceiling evicts the stalest bucket.
	const buckets = new Map<string, { limiter: RateLimiter; lastUsedAt: number }>();
	let checks = 0;

	function estimatedRetryAfterS(limit: number): number {
		return Math.max(1, Math.ceil(safeWindowMs / Math.max(1, limit) / 1000));
	}

	function cleanupExpiredBuckets(currentNow: number): void {
		if (buckets.size < 64 || checks % 64 !== 0) return;
		const staleBefore = currentNow - safeWindowMs * 10;
		for (const [key, bucket] of buckets) {
			if (bucket.lastUsedAt < staleBefore) buckets.delete(key);
		}
	}

	return {
		check(key: string, limit: number) {
			checks += 1;
			const currentNow = Date.now();
			cleanupExpiredBuckets(currentNow);
			const safeLimit = Math.max(1, Math.trunc(limit));
			const bucketKey = `${safeLimit}:${key}`;
			let bucket = buckets.get(bucketKey);
			if (bucket) buckets.delete(bucketKey);
			else {
				if (buckets.size >= maxBuckets) {
					const stalest = buckets.keys().next().value;
					if (stalest !== undefined) buckets.delete(stalest);
				}
				bucket = {
					limiter: new RateLimiter({
						tokensPerInterval: safeLimit,
						interval: safeWindowMs,
						fireImmediately: true,
					}),
					lastUsedAt: currentNow,
				};
			}
			buckets.set(bucketKey, bucket);
			bucket.lastUsedAt = currentNow;
			if (bucket.limiter.tryRemoveTokens(1)) {
				return { allowed: true, retryAfterS: 0 };
			}
			return { allowed: false, retryAfterS: estimatedRetryAfterS(safeLimit) };
		},
		bucketCount: () => buckets.size,
	};
}
