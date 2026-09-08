import { describe, expect, it } from "vitest";
import type { DiagnosticEvent } from "../../lib/api/diagnostics";
import { diagnosticsDrawerReducer, initialDiagnosticsDrawerState } from "./state";

function event(id: string, occurredAt: string): DiagnosticEvent {
	return {
		id,
		occurred_at: occurredAt,
		severity: "warning",
		subsystem: "viewer",
		code: "viewer_connection_lost",
		message: "The viewer connection was interrupted. Automatic recovery started.",
	};
}

describe("diagnostics drawer session queue", () => {
	it("queues a recorded session event while older rows are being read", () => {
		// Arrange: the visible session row must keep its current position.
		const visible = event("visible", "2026-09-08T12:00:00.000Z");
		const incoming = event("incoming", "2026-09-08T12:01:00.000Z");
		const state = {
			...initialDiagnosticsDrawerState(),
			open: true,
			sessionRows: [visible],
		};

		// Act
		const queued = diagnosticsDrawerReducer(state, {
			type: "session_event_recorded",
			event: incoming,
			readingOlder: true,
		});

		// Assert
		expect(queued.sessionRows).toEqual([visible]);
		expect(queued.queuedSessionRows).toEqual([incoming]);
	});

	it("queues refreshed session rows without shifting visible rows", () => {
		// Arrange: refresh includes both an already-visible event and a new event.
		const visible = event("visible", "2026-09-08T12:00:00.000Z");
		const incoming = event("incoming", "2026-09-08T12:01:00.000Z");
		const state = {
			...initialDiagnosticsDrawerState(),
			open: true,
			sessionRows: [visible],
		};

		// Act
		const queued = diagnosticsDrawerReducer(state, {
			type: "refresh_session_rows",
			events: [incoming, visible],
			readingOlder: true,
		});

		// Assert
		expect(queued.sessionRows).toEqual([visible]);
		expect(queued.queuedSessionRows).toEqual([incoming]);
	});

	it("promotes queued session rows when the reader shows queued events", () => {
		// Arrange
		const visible = event("visible", "2026-09-08T12:00:00.000Z");
		const incoming = event("incoming", "2026-09-08T12:01:00.000Z");
		const state = {
			...initialDiagnosticsDrawerState(),
			open: true,
			sessionRows: [visible],
			queuedSessionRows: [incoming],
		};

		// Act
		const shown = diagnosticsDrawerReducer(state, { type: "show_queued" });

		// Assert
		expect(shown.sessionRows).toEqual([incoming, visible]);
		expect(shown.queuedSessionRows).toEqual([]);
	});

	it("does not queue session events while updates are paused", () => {
		// Arrange
		const state = {
			...initialDiagnosticsDrawerState(),
			open: true,
			paused: true,
		};

		// Act
		const unchanged = diagnosticsDrawerReducer(state, {
			type: "session_event_recorded",
			event: event("incoming", "2026-09-08T12:01:00.000Z"),
			readingOlder: true,
		});

		// Assert
		expect(unchanged).toBe(state);
	});

	it("keeps cleared session events hidden when a later refresh repeats them", () => {
		// Arrange: clear both visible and queued session events from the view.
		const visible = event("visible", "2026-09-08T12:00:00.000Z");
		const queued = event("queued", "2026-09-08T12:01:00.000Z");
		const cleared = diagnosticsDrawerReducer(
			{
				...initialDiagnosticsDrawerState(),
				open: true,
				sessionRows: [visible],
				queuedSessionRows: [queued],
			},
			{ type: "clear_view", sessionEvents: [visible, queued] },
		);

		// Act
		const refreshed = diagnosticsDrawerReducer(cleared, {
			type: "refresh_session_rows",
			events: [queued, visible],
			readingOlder: true,
		});

		// Assert
		expect(refreshed.sessionRows).toEqual([]);
		expect(refreshed.queuedSessionRows).toEqual([]);
		expect(refreshed.hiddenSessionIds).toEqual(["visible", "queued"]);
	});
});
