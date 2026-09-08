import { describe, expect, it, vi } from "vitest";
import type { DiagnosticEvent, DiagnosticEventsResponse } from "../../lib/api/diagnostics";
import { loadPollCatchup } from "./poll-catchup";

function event(id: string): DiagnosticEvent {
	return {
		id,
		occurred_at: "2026-09-07T12:00:00.000Z",
		severity: "warning",
		subsystem: "capture",
		code: "capture_backlog_growing",
		message: "The capture queue is growing.",
	};
}

function response(ids: string[], nextCursor: string | null): DiagnosticEventsResponse {
	return {
		contract_version: 1,
		items: ids.map(event),
		next_cursor: nextCursor,
		redacted: true,
		generated_at: "2026-09-07T12:00:01.000Z",
	};
}

describe("diagnostics poll catch-up", () => {
	it("fetches bounded pages until reaching the existing contiguous history", async () => {
		const first = Array.from({ length: 50 }, (_, index) => `new-${100 - index}`);
		const second = Array.from({ length: 50 }, (_, index) => `new-${50 - index}`);
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(response(first, "page-two"))
			.mockResolvedValueOnce(response(second, "page-three"))
			.mockResolvedValueOnce(response(["known"], "below-known"));

		const result = await loadPollCatchup({
			loadEvents,
			request: { limit: 50 },
			existingRows: [event("known")],
			existingNextCursor: "existing-older",
		});

		expect(loadEvents).toHaveBeenCalledTimes(3);
		expect(loadEvents.mock.calls[1]?.[0].cursor).toBe("page-two");
		expect(loadEvents.mock.calls[2]?.[0].cursor).toBe("page-three");
		expect(result.items).toHaveLength(101);
		expect(result.next_cursor).toBe("existing-older");
	});

	it("continues past a mutable known row that moved into the first page", async () => {
		const movedKnown = {
			...event("known"),
			occurred_at: "2026-09-07T12:05:00.000Z",
		};
		const first = Array.from({ length: 49 }, (_, index) => `new-first-${index}`);
		const second = Array.from({ length: 50 }, (_, index) => `new-second-${index}`);
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce({
				...response(first, "page-two"),
				items: [movedKnown, ...first.map(event)],
			})
			.mockResolvedValueOnce(response(second, "page-three"))
			.mockResolvedValueOnce(response(["known"], "below-known"));

		const result = await loadPollCatchup({
			loadEvents,
			request: { limit: 50 },
			existingRows: [event("known")],
			existingNextCursor: "existing-older",
		});

		expect(loadEvents).toHaveBeenCalledTimes(3);
		expect(loadEvents.mock.calls[1]?.[0].cursor).toBe("page-two");
		expect(loadEvents.mock.calls[2]?.[0].cursor).toBe("page-three");
		expect(result.items.find((item) => item.id === "known")?.occurred_at).toBe(
			movedKnown.occurred_at,
		);
		expect(result.next_cursor).toBe("existing-older");
	});

	it("returns a gap cursor when a burst fills the client cap before overlap", async () => {
		const loadEvents = vi.fn();
		for (let page = 0; page < 4; page += 1) {
			const ids = Array.from({ length: 50 }, (_, index) => `new-${page}-${index}`);
			loadEvents.mockResolvedValueOnce(response(ids, `page-${page + 2}`));
		}

		const result = await loadPollCatchup({
			loadEvents,
			request: { limit: 50 },
			existingRows: [event("known")],
			existingNextCursor: "existing-older",
		});

		expect(loadEvents).toHaveBeenCalledTimes(4);
		expect(result.items).toHaveLength(200);
		expect(result.next_cursor).toBe("page-5");
	});

	it("keeps the catch-up cursor when merging would trim cached rows", async () => {
		const newRows = Array.from({ length: 50 }, (_, index) => `new-${index}`);
		const knownRows = Array.from({ length: 50 }, (_, index) => `known-${index}`);
		const loadEvents = vi.fn().mockResolvedValue(response([...newRows, ...knownRows], "gap"));
		const existingRows = Array.from({ length: 200 }, (_, index) => event(`known-${index}`));

		const result = await loadPollCatchup({
			loadEvents,
			request: { limit: 100 },
			existingRows,
			existingNextCursor: "below-cache",
		});

		expect(result.next_cursor).toBe("gap");
	});
});
