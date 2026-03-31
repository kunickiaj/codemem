import { RateLimiter } from "limiter";

export interface InMemoryRequestRateLimiter {
	check(key: string, limit: number): { allowed: boolean; retryAfterS: number };
}

export interface CreateInMemoryRequestRateLimiterOptions {
	windowMs?: number;
	now?: () => number;
}

export function createInMemoryRequestRateLimiter(
	options: CreateInMemoryRequestRateLimiterOptions = {},
): InMemoryRequestRateLimiter {
	const windowMs = Math.max(1000, Math.trunc(options.windowMs ?? 60_000));
	const now = options.now ?? (() => Date.now());
	const buckets = new Map<string, { limiter: RateLimiter; lastUsedAt: number }>();
	let checks = 0;

	function estimatedRetryAfterS(limit: number): number {
		return Math.max(1, Math.ceil(windowMs / Math.max(1, limit) / 1000));
	}

	function cleanupExpiredBuckets(currentNow: number): void {
		if (buckets.size < 64 || checks % 64 !== 0) return;
		const staleBefore = currentNow - windowMs * 10;
		for (const [key, bucket] of buckets) {
			if (bucket.lastUsedAt < staleBefore) buckets.delete(key);
		}
	}

	return {
		check(key: string, limit: number) {
			const safeLimit = Math.max(1, Math.trunc(limit));
			checks += 1;
			const currentNow = now();
			cleanupExpiredBuckets(currentNow);
			const bucketKey = `${safeLimit}:${key}`;
			let bucket = buckets.get(bucketKey);
			if (!bucket) {
				bucket = {
					limiter: new RateLimiter({
						tokensPerInterval: safeLimit,
						interval: windowMs,
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
