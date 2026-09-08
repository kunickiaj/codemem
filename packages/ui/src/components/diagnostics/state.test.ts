import { describe, expect, it } from "vitest";
import type { DiagnosticEvent } from "../../lib/api/diagnostics";
import { diagnosticsDrawerReducer, initialDiagnosticsDrawerState } from "./state";

function event(id: string, occurredAt = "2026-09-07T12:00:00.000Z"): DiagnosticEvent {
	return {
		id,
		occurred_at: occurredAt,
		severity: "warning",
		subsystem: "capture",
		code: "capture_backlog_growing",
		message: "The capture queue is growing.",
	};
}

describe("diagnostics drawer request failures", () => {
	it("preserves history and pagination after an ordinary older-page failure", () => {
		const state = {
			...initialDiagnosticsDrawerState(),
			open: true,
			rows: [event("one")],
			nextCursor: "older",
			queryRevision: 3,
		};

		const failed = diagnosticsDrawerReducer(state, {
			type: "request_failed",
			mode: "older",
			restartQuery: false,
		});

		expect(failed.rows).toEqual(state.rows);
		expect(failed.nextCursor).toBe("older");
		expect(failed.queryRevision).toBe(3);
		expect(failed.error).toBe(true);
	});

	it("restarts pagination after an invalid older-page cursor", () => {
		const state = {
			...initialDiagnosticsDrawerState(),
			open: true,
			rows: [event("one")],
			nextCursor: "stale",
			queryRevision: 3,
		};

		const failed = diagnosticsDrawerReducer(state, {
			type: "request_failed",
			mode: "older",
			restartQuery: true,
		});

		expect(failed.nextCursor).toBeNull();
		expect(failed.queryRevision).toBe(4);
	});
});

describe("diagnostics drawer queued catch-up", () => {
	it("discards an obsolete queue when a top poll replaces the bounded newest window", () => {
		const latest = Array.from({ length: 200 }, (_, index) => event(`latest-${index}`));
		const polled = diagnosticsDrawerReducer(
			{
				...initialDiagnosticsDrawerState(),
				open: true,
				rows: [event("previous")],
				queuedRows: [event("stale-queued")],
			},
			{
				type: "request_succeeded",
				mode: "poll",
				response: {
					items: latest,
					contract_version: 1,
					redacted: true,
					next_cursor: "latest-cursor",
					generated_at: "2026-09-07T12:01:00.000Z",
				},
				readingOlder: false,
			},
		);

		const shown = diagnosticsDrawerReducer(polled, { type: "show_queued" });

		expect(shown.rows.map((row) => row.id)).toEqual(latest.map((row) => row.id));
		expect(shown.queuedRows).toEqual([]);
	});

	it("preserves the loaded-history cursor when showing queued rows does not trim", () => {
		const state = {
			...initialDiagnosticsDrawerState(),
			open: true,
			rows: [event("known")],
			queuedRows: [event("new")],
			queuedNextCursor: "continue-gap",
			nextCursor: "below-known",
		};

		const shown = diagnosticsDrawerReducer(state, { type: "show_queued" });

		expect(shown.rows.map((row) => row.id)).toEqual(["new", "known"]);
		expect(shown.nextCursor).toBe("below-known");
		expect(shown.queuedNextCursor).toBeUndefined();
	});

	it("adopts the bounded catch-up cursor when showing queued rows trims history", () => {
		const state = {
			...initialDiagnosticsDrawerState(),
			open: true,
			rows: Array.from({ length: 200 }, (_, index) => event(`known-${index}`)),
			queuedRows: [event("new")],
			queuedNextCursor: "continue-gap",
			nextCursor: "below-known",
		};

		const shown = diagnosticsDrawerReducer(state, { type: "show_queued" });

		expect(shown.rows).toHaveLength(200);
		expect(shown.rows[0]?.id).toBe("new");
		expect(shown.nextCursor).toBe("continue-gap");
	});

	it("preserves an older response cursor when queued rows are shown", () => {
		const initial = {
			...initialDiagnosticsDrawerState(),
			open: true,
			rows: [event("known")],
			nextCursor: "below-known",
		};
		const polled = diagnosticsDrawerReducer(initial, {
			type: "request_succeeded",
			mode: "poll",
			response: {
				items: [event("new")],
				contract_version: 1,
				redacted: true,
				next_cursor: "continue-gap",
				generated_at: "2026-09-07T12:01:00.000Z",
			},
			readingOlder: true,
		});
		const loadedOlder = diagnosticsDrawerReducer(polled, {
			type: "request_succeeded",
			mode: "older",
			response: {
				items: [event("older")],
				contract_version: 1,
				redacted: true,
				next_cursor: "after-older",
				generated_at: "2026-09-07T12:02:00.000Z",
			},
			readingOlder: true,
		});
		expect(loadedOlder.queuedNextCursor).toBe("continue-gap");

		const shown = diagnosticsDrawerReducer(loadedOlder, { type: "show_queued" });

		expect(shown.rows.map((row) => row.id)).toEqual(["new", "known", "older"]);
		expect(shown.nextCursor).toBe("after-older");
		expect(shown.queuedNextCursor).toBeUndefined();
	});

	it("reconciles technical details into queued rows before they are shown", () => {
		const queued = event("queued");
		const detailed = { ...queued, technical_detail: { available: true, text: "detail" } };
		const state = {
			...initialDiagnosticsDrawerState(),
			open: true,
			queuedRows: [queued],
		};

		const refreshed = diagnosticsDrawerReducer(state, {
			type: "request_succeeded",
			mode: "technical",
			response: {
				items: [detailed],
				contract_version: 1,
				redacted: false,
				next_cursor: null,
				generated_at: "2026-09-07T12:01:00.000Z",
			},
			readingOlder: true,
		});

		expect(refreshed.queuedRows).toEqual([detailed]);
	});
});

describe("diagnostics drawer mutable relocation", () => {
	it("queues a known row whose timestamp moves until queued events are shown", () => {
		const initial = {
			...initialDiagnosticsDrawerState(),
			open: true,
			rows: [
				event("newer", "2026-09-07T12:04:00.000Z"),
				event("mutable", "2026-09-07T12:00:00.000Z"),
				event("older", "2026-09-07T11:00:00.000Z"),
			],
		};
		const moved: DiagnosticEvent = {
			...event("mutable", "2026-09-07T12:05:00.000Z"),
			severity: "error",
			code: "capture_backlog_blocked",
			message: "The capture queue is blocked.",
		};

		const polled = diagnosticsDrawerReducer(initial, {
			type: "request_succeeded",
			mode: "poll",
			response: {
				items: [moved],
				contract_version: 1,
				redacted: true,
				next_cursor: null,
				generated_at: "2026-09-07T12:06:00.000Z",
			},
			readingOlder: true,
		});

		expect(polled.rows[1]).toEqual({
			...moved,
			occurred_at: initial.rows[1]?.occurred_at,
		});
		expect(polled.queuedRows).toEqual([moved]);

		const shown = diagnosticsDrawerReducer(polled, { type: "show_queued" });

		expect(shown.rows.map((row) => row.id)).toEqual(["mutable", "newer", "older"]);
		expect(shown.rows.filter((row) => row.id === "mutable")).toEqual([moved]);
	});

	it("keeps queued relocation results unique and within the row cap", () => {
		const rows = Array.from({ length: 200 }, (_, index) => event(`known-${index}`));
		const moved = event("known-199", "2026-09-07T12:05:00.000Z");
		const polled = diagnosticsDrawerReducer(
			{ ...initialDiagnosticsDrawerState(), open: true, rows },
			{
				type: "request_succeeded",
				mode: "poll",
				response: {
					items: [event("new"), moved],
					contract_version: 1,
					redacted: true,
					next_cursor: null,
					generated_at: "2026-09-07T12:06:00.000Z",
				},
				readingOlder: true,
			},
		);

		const shown = diagnosticsDrawerReducer(polled, { type: "show_queued" });

		expect(shown.rows).toHaveLength(200);
		expect(new Set(shown.rows.map((row) => row.id)).size).toBe(200);
		expect(shown.rows.filter((row) => row.id === moved.id)).toEqual([moved]);
	});
});

describe("diagnostics drawer technical history", () => {
	it("merges technical versions into loaded rows without changing history or its cursor", () => {
		const older = event("older", "2026-09-07T11:00:00.000Z");
		const state = {
			...initialDiagnosticsDrawerState(),
			open: true,
			includeTechnical: true,
			rows: [event("newer"), older],
			nextCursor: "after-loaded-history",
		};
		const detailedOlder = { ...older, technical_detail: { available: true, text: "detail" } };

		const refreshed = diagnosticsDrawerReducer(state, {
			type: "request_succeeded",
			mode: "technical",
			response: {
				items: [event("inserted"), detailedOlder],
				contract_version: 1,
				redacted: false,
				next_cursor: "technical-cursor",
				generated_at: "2026-09-07T12:01:00.000Z",
			},
			readingOlder: true,
		});

		expect(refreshed.rows).toEqual([state.rows[0], detailedOlder]);
		expect(refreshed.nextCursor).toBe("after-loaded-history");
	});

	it("keeps loaded history and permits another reveal after an incomplete refresh", () => {
		const state = {
			...initialDiagnosticsDrawerState(),
			open: true,
			includeTechnical: true,
			rows: [event("loaded")],
			nextCursor: "older",
		};

		const failed = diagnosticsDrawerReducer(state, {
			type: "request_failed",
			mode: "technical",
			restartQuery: false,
		});

		expect(failed.rows).toEqual(state.rows);
		expect(failed.nextCursor).toBe("older");
		expect(failed.includeTechnical).toBe(false);
		expect(failed.error).toBe(true);
	});
});
