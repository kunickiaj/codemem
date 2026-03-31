import { RateLimiter } from "limiter";

export interface InMemoryRequestRateLimiter {
	check(key: string, limit: number): { allowed: boolean; retryAfterS: number };
}

export function createInMemoryRequestRateLimiter(windowMs = 60_000): InMemoryRequestRateLimiter {
	const safeWindowMs = Math.max(1000, Math.trunc(windowMs));
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
			if (!bucket) {
				bucket = {
					limiter: new RateLimiter({
						tokensPerInterval: safeLimit,
						interval: safeWindowMs,
						fireImmediately: true,
					}),
					lastUsedAt: currentNow,
				};
				buckets.set(bucketKey, bucket);
			}
			bucket.lastUsedAt = currentNow;
			if (bucket.limiter.tryRemoveTokens(1)) {
				return { allowed: true, retryAfterS: 0 };
			}
			return { allowed: false, retryAfterS: estimatedRetryAfterS(safeLimit) };
		},
	};
}
