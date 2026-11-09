import { describe, expect, it } from "vitest";
import type { PaginatedResponse } from "../../../lib/api/types";
import { feedPagingOptions, initialFeedProgress, nextFeedProgress } from "./pagination";

function cursorPage(next: string | null): PaginatedResponse {
	return {
		items: [],
		pagination: {
			limit: 20,
			offset: null,
			next_offset: null,
			paging: "cursor",
			has_more: next !== null,
			next_cursor: next,
		},
	};
}
describe("Feed paging options", () => {
	it("negotiates unknown mode and uses an opaque continuation only for older pages", () => {
		// Arrange
		const progress = {
			...initialFeedProgress("cursor"),
			nextCursor: "opaque:/?&+",
			advanced: true,
		};
		// Act / Assert
		expect(feedPagingOptions(initialFeedProgress(), { head: true })).toEqual({ paging: "cursor" });
		expect(feedPagingOptions(progress, { head: true })).toEqual({ paging: "cursor" });
		expect(feedPagingOptions(progress, { head: false })).toEqual({
			paging: "cursor",
			cursor: "opaque:/?&+",
		});
	});

	it.each([true, false])(
		"rejects ambiguous older-page requests with no continuation, hasMore=%s",
		(hasMore) => {
			// Arrange
			const progress = { ...initialFeedProgress("cursor"), hasMore };
			// Act / Assert
			expect(() => feedPagingOptions(progress, { head: false })).toThrow();
		},
	);

	it("omits cursor flags for both legacy head and older requests", () => {
		// Arrange
		const progress = { ...initialFeedProgress("offset"), offset: 40 };
		// Act / Assert
		expect(feedPagingOptions(progress, { head: true })).toEqual({ offset: 0 });
		expect(feedPagingOptions(progress, { head: false })).toEqual({ offset: 40 });
	});
});

describe("Feed progress transitions", () => {
	it.each(["next", null])("applies a cursor continuation or exhaustion: %s", (next) => {
		// Arrange
		const previous = initialFeedProgress();
		// Act
		const result = nextFeedProgress({ previous, payload: cursorPage(next), limit: 20, head: true });
		// Assert
		expect(result).toEqual({
			mode: "cursor",
			offset: 0,
			hasMore: next !== null,
			nextCursor: next,
			advanced: false,
		});
		expect(previous).toEqual(initialFeedProgress());
	});

	it.each(["cursor", "offset"] as const)(
		"preserves advanced %s progress during head refresh",
		(mode) => {
			// Arrange
			const previous = {
				...initialFeedProgress(mode),
				offset: 40,
				nextCursor: "deep",
				hasMore: false,
				advanced: true,
			};
			// Act
			const result = nextFeedProgress({
				previous,
				payload: cursorPage("head"),
				limit: 20,
				head: true,
			});
			// Assert
			expect(result).toEqual(previous);
		},
	);

	it.each([0, 1, 2])(
		"uses item count when an older response omits pagination: %i rows",
		(count) => {
			// Arrange
			const previous = { ...initialFeedProgress("offset"), offset: 40 };
			const payload = { items: Array.from({ length: count }, (_, id) => ({ id })) };
			// Act
			const result = nextFeedProgress({ previous, payload, limit: 2, head: false });
			// Assert
			expect(result).toEqual({
				mode: "offset",
				offset: 40 + count,
				hasMore: count >= 2,
				nextCursor: null,
				advanced: true,
			});
		},
	);

	it("rejects malformed head metadata even when advanced progress would otherwise be preserved", () => {
		// Arrange
		const previous = { ...initialFeedProgress("cursor"), nextCursor: "deep", advanced: true };
		const payload = cursorPage(null);
		payload.pagination = { ...payload.pagination, has_more: true };
		// Act / Assert
		expect(() => nextFeedProgress({ previous, payload, limit: 20, head: true })).toThrow();
		expect(previous.nextCursor).toBe("deep");
	});
});
