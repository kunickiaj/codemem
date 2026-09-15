import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReadTimeoutError } from "./read-request";
import { createRefreshSessionOwner } from "./refresh-session";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("refresh session ownership", () => {
	it("bounds one active generation and releases it after completion", () => {
		// Arrange
		const owner = createRefreshSessionOwner(100);

		// Act
		const session = owner.begin();

		// Assert
		expect(session.isCurrent()).toBe(true);
		expect(owner.outstanding()).toBe(1);
		owner.finish(session);
		expect(session.isCurrent()).toBe(false);
		expect(owner.outstanding()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("marks a stalled generation timed out at the configured deadline", async () => {
		// Arrange
		const owner = createRefreshSessionOwner(100);
		const session = owner.begin();

		// Act
		await vi.advanceTimersByTimeAsync(100);

		// Assert
		expect(session.signal.aborted).toBe(true);
		expect(session.signal.reason).toEqual(expect.any(ReadTimeoutError));
		expect(session.isCurrent()).toBe(false);
		expect(session.isOwned()).toBe(true);
		owner.cancel();
		expect(session.isOwned()).toBe(false);
		owner.finish(session);
		expect(owner.outstanding()).toBe(0);
	});

	it("cancels an obsolete generation without affecting its replacement", () => {
		// Arrange
		const owner = createRefreshSessionOwner(100);
		const first = owner.begin();

		// Act
		owner.cancel(new DOMException("project changed", "AbortError"));
		const second = owner.begin();
		owner.finish(first);

		// Assert
		expect(first.isCurrent()).toBe(false);
		expect(first.signal.reason).toEqual(expect.objectContaining({ name: "AbortError" }));
		expect(second.isCurrent()).toBe(true);
		expect(owner.outstanding()).toBe(1);
		owner.finish(second);
		expect(owner.outstanding()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
