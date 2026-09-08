import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../lib/state";

const openDiagnosticsDrawer = vi.hoisted(() => vi.fn());

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
	state.lastStatsPayload = {};
	state.lastUsagePayload = {};
	state.lastRawEventsPayload = {};
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
		state.lastRawEventsPayload = { pending: 200 };
		renderOverview();

		const trigger = findDiagnosticsAction();
		trigger.click();

		expect(openDiagnosticsDrawer).toHaveBeenCalledWith({ subsystem: "capture", trigger });
	});

	it("opens error-filtered maintenance diagnostics for an existing failed job", () => {
		state.lastStatsPayload = {
			maintenance_jobs: [
				{ kind: "cleanup", title: "Cleanup", status: "failed", error: "private path" },
			],
		};
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
