import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageTotals } from "../lib/state";
import { completeHealthLoad, state } from "../lib/state";

const openDiagnosticsDrawer = vi.hoisted(() => vi.fn());
const usageTotals: UsageTotals = {
	tokens_read: 0,
	tokens_written: 0,
	tokens_saved: 0,
	count: 0,
	token_unit: "tokens",
	measured_count: 0,
	estimated_count: 0,
	unavailable_count: 0,
	legacy_text_length_count: 0,
	legacy_unclassified_count: 0,
};

vi.mock("../components/diagnostics", () => ({ openDiagnosticsDrawer }));
vi.mock("../components/primitives/tooltip", () => ({
	Tooltip: ({ children }: { children?: unknown }) => children,
	TooltipProvider: ({ children }: { children?: unknown }) => children,
}));

import { renderHealthOverview } from "./health";

function renderOverview(): void {
	act(() => renderHealthOverview());
}

function findDiagnosticsAction(): HTMLButtonElement {
	const action = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent === "View diagnostics",
	);
	if (!action) throw new Error("diagnostics action missing");
	return action;
}

beforeEach(() => {
	document.body.innerHTML = `
		<div id="healthGrid"></div>
		<div id="healthMeta"></div>
		<div id="healthActions"></div>
		<div id="healthDot"></div>
	`;
	state.healthStats = completeHealthLoad({
		automatic_recall: null,
		database: {
			path: "/data/codemem.db",
			size_bytes: 0,
			active_memory_items: 0,
			vector_coverage: 0,
			tags_coverage: 0,
		},
		maintenance_jobs: [],
	});
	state.healthUsage = completeHealthLoad({
		events: [],
		events_global: [],
		events_filtered: null,
		totals: usageTotals,
		totals_global: usageTotals,
		totals_filtered: null,
		recent_packs: [],
	});
	state.healthRawEvents = completeHealthLoad({ pending: 0, sessions: 0 });
	state.lastSyncStatus = { enabled: false, daemon_state: "disabled" };
	state.lastSyncPeers = [];
	openDiagnosticsDrawer.mockReset();
});

afterEach(() => {
	for (const id of ["healthGrid", "healthActions"]) {
		const element = document.getElementById(id);
		if (element) act(() => render(null, element));
	}
	document.body.innerHTML = "";
});

describe("Health diagnostics actions", () => {
	it("opens capture diagnostics from the existing backlog threshold", () => {
		state.healthRawEvents = completeHealthLoad({ pending: 200, sessions: 1 });
		renderOverview();

		const trigger = findDiagnosticsAction();
		trigger.click();

		expect(openDiagnosticsDrawer).toHaveBeenCalledWith({ subsystem: "capture", trigger });
	});

	it("opens error-filtered maintenance diagnostics for an existing failed job", () => {
		state.healthStats = completeHealthLoad({
			automatic_recall: null,
			database: {
				path: "/data/codemem.db",
				size_bytes: 0,
				active_memory_items: 0,
				vector_coverage: 0,
				tags_coverage: 0,
			},
			maintenance_jobs: [
				{
					kind: "cleanup",
					title: "Cleanup",
					status: "failed",
					message: null,
					error: "private path",
					progress: { current: 0, total: null, unit: "items" },
				},
			],
		});
		renderOverview();

		const trigger = findDiagnosticsAction();
		trigger.click();

		expect(openDiagnosticsDrawer).toHaveBeenCalledWith({
			severity: "error",
			subsystem: "maintenance",
			trigger,
		});
	});
});
