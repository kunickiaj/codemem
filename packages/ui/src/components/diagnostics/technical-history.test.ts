import { describe, expect, it, vi } from "vitest";
import type { DiagnosticEvent, DiagnosticEventsResponse } from "../../lib/api/diagnostics";
import { loadTechnicalHistory } from "./technical-history";

function event(id: string, detail?: string): DiagnosticEvent {
	return {
		id,
		occurred_at: "2026-09-07T12:00:00.000Z",
		severity: "warning",
		subsystem: "capture",
		code: "capture_backlog_growing",
		message: "The capture queue is growing.",
		...(detail ? { technical_detail: { available: true, text: detail } } : {}),
	};
}

function response(items: DiagnosticEvent[], cursor: string | null): DiagnosticEventsResponse {
	return {
		contract_version: 1,
		items,
		next_cursor: cursor,
		redacted: false,
		generated_at: "2026-09-07T12:01:00.000Z",
	};
}

describe("technical diagnostic history", () => {
	it("pages past newly inserted events until every loaded row has a technical version", async () => {
		const loadEvents = vi
			.fn()
			.mockResolvedValueOnce(response([event("new"), event("loaded-new", "new detail")], "next"))
			.mockResolvedValueOnce(response([event("loaded-old", "old detail")], "unused"));

		const result = await loadTechnicalHistory({
			loadEvents,
			request: { includeTechnical: true, limit: 50 },
			existingRows: [event("loaded-new"), event("loaded-old")],
		});

		expect(result.items.map((item) => item.id)).toEqual(["new", "loaded-new", "loaded-old"]);
		expect(loadEvents).toHaveBeenLastCalledWith(
			expect.objectContaining({ cursor: "next", includeTechnical: true }),
		);
	});

	it("rejects an incomplete bounded refresh instead of reporting partial history as current", async () => {
		const pages = Array.from({ length: 4 }, (_, page) =>
			response(
				Array.from({ length: 50 }, (_, index) => event(`new-${page}-${index}`)),
				`cursor-${page}`,
			),
		);
		const loadEvents = vi.fn();
		for (const page of pages) loadEvents.mockResolvedValueOnce(page);

		await expect(
			loadTechnicalHistory({
				loadEvents,
				request: { includeTechnical: true, limit: 50 },
				existingRows: [event("loaded-target")],
			}),
		).rejects.toThrow("could not be refreshed completely");
		expect(loadEvents).toHaveBeenCalledTimes(4);
	});

	it("fails when retained visible plus queued rows exceed the bounded refresh window", async () => {
		const retained = Array.from({ length: 201 }, (_, index) => event(`retained-${index}`));
		const loadEvents = vi.fn();
		for (let page = 0; page < 4; page += 1) {
			loadEvents.mockResolvedValueOnce(
				response(
					retained.slice(page * 50, page * 50 + 50).map((row) => event(row.id, "detail")),
					`cursor-${page}`,
				),
			);
		}

		await expect(
			loadTechnicalHistory({
				loadEvents,
				request: { includeTechnical: true, limit: 50 },
				existingRows: retained,
			}),
		).rejects.toThrow("could not be refreshed completely");
	});
});
