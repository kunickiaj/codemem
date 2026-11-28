import { afterEach, expect, it, vi } from "vitest";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";

afterEach(() => vi.useRealTimers());

const spend = (
	limiter: ReturnType<typeof createInMemoryRequestRateLimiter>,
	key: string,
	n: number,
) => Array.from({ length: n }, () => limiter.check(key, 2).allowed);

it("does not let address churn refill an exhausted bucket", () => {
	const limiter = createInMemoryRequestRateLimiter(60_000, { maxBuckets: 4 });
	expect(spend(limiter, "exhausted", 3)).toEqual([true, true, false]);

	for (let i = 0; i < 1_000; i++) limiter.check(`churn-${i}`, 2);

	expect(limiter.check("exhausted", 2).allowed).toBe(false);
	expect(limiter.bucketCount?.()).toBe(4);
});

it("gives new keys one shared overflow budget while the map is full", () => {
	const limiter = createInMemoryRequestRateLimiter(60_000, { maxBuckets: 2 });
	limiter.check("first", 3);
	limiter.check("second", 3);

	const newcomers = ["n1", "n2", "n3", "n4", "n5"].map((key) => limiter.check(key, 3).allowed);

	expect(newcomers).toEqual([true, true, true, false, false]);
	// The keys that hold buckets keep their own budgets.
	expect(limiter.check("first", 3).allowed).toBe(true);
});

it("frees a slot only from a bucket unused for a whole window", () => {
	vi.useFakeTimers({ toFake: ["performance", "Date"] });
	const limiter = createInMemoryRequestRateLimiter(60_000, { maxBuckets: 1 });
	expect(spend(limiter, "old", 3)).toEqual([true, true, false]);

	vi.advanceTimersByTime(59_000);
	expect(spend(limiter, "early", 3)).toEqual([true, true, false]);
	vi.advanceTimersByTime(1_000);
	// "old" sat unused for a full window, so it has refilled and can make room.
	expect(spend(limiter, "late", 3)).toEqual([true, true, false]);
	expect(limiter.check("late", 2).allowed).toBe(false);
	expect(limiter.bucketCount?.()).toBe(1);
});
