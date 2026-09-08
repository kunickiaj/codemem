import { afterEach, describe, expect, it } from "vitest";
import {
	diagnosticsDrawerReducer,
	initialDiagnosticsDrawerState,
	visibleDiagnosticRows,
} from "./state";
import {
	getViewerConnectionEvents,
	MAX_VIEWER_CONNECTION_EVENTS,
	recordViewerConnectionEvent,
	resetViewerConnectionEventsForTests,
} from "./viewer-connection-events";

afterEach(() => resetViewerConnectionEventsForTests());

describe("viewer connection diagnostic events", () => {
	it("constructs fixed safe fields and deduplicates loss during one incident", () => {
		recordViewerConnectionEvent("caller supplied text" as never);
		recordViewerConnectionEvent("constructor" as never);
		recordViewerConnectionEvent("toString" as never);
		recordViewerConnectionEvent("connection_lost");
		recordViewerConnectionEvent("connection_lost");

		expect(getViewerConnectionEvents()).toEqual([
			expect.objectContaining({
				severity: "warning",
				subsystem: "viewer",
				code: "viewer_connection_lost",
				message: "The viewer connection was interrupted. Automatic recovery started.",
			}),
		]);
		expect(Object.keys(getViewerConnectionEvents()[0] ?? {}).sort()).toEqual([
			"code",
			"id",
			"message",
			"occurred_at",
			"severity",
			"subsystem",
		]);
	});

	it("deduplicates consecutive reconnect requests", () => {
		recordViewerConnectionEvent("reconnect_requested");
		recordViewerConnectionEvent("reconnect_requested");

		expect(getViewerConnectionEvents()).toHaveLength(1);
		recordViewerConnectionEvent("connection_lost");
		recordViewerConnectionEvent("reconnect_requested");
		expect(getViewerConnectionEvents()).toHaveLength(3);
	});

	it("keeps the newest twenty events and starts a new incident after restoration", () => {
		for (let index = 0; index < 12; index += 1) {
			recordViewerConnectionEvent("connection_lost");
			recordViewerConnectionEvent("connection_restored");
		}

		const events = getViewerConnectionEvents();
		expect(events).toHaveLength(MAX_VIEWER_CONNECTION_EVENTS);
		expect(events[0]?.code).toBe("viewer_connection_restored");
		expect(events[1]?.code).toBe("viewer_connection_lost");
	});

	it("applies active severity and subsystem filters to session rows locally", () => {
		recordViewerConnectionEvent("connection_lost");
		const openState = diagnosticsDrawerReducer(initialDiagnosticsDrawerState(), {
			type: "open",
			severity: "error",
			subsystem: "viewer",
			sessionRows: getViewerConnectionEvents(),
		});

		expect(visibleDiagnosticRows(openState)).toEqual([]);
		expect(
			visibleDiagnosticRows({ ...openState, severity: "warning", subsystem: "capture" }),
		).toEqual([]);
		expect(visibleDiagnosticRows({ ...openState, severity: "warning" })).toHaveLength(1);
	});
});
