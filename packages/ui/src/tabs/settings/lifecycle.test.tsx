import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../lib/state";
import { settingsState } from "./data/state";

const openDiagnosticsDrawer = vi.hoisted(() => vi.fn());

vi.mock("../../components/diagnostics", () => ({ openDiagnosticsDrawer }));

import { openObserverDiagnosticsFromSettings } from "./lifecycle";

const observerDiagnosticsOptions = {
	severity: "error" as const,
	subsystem: "observer" as const,
};

beforeEach(() => {
	document.body.innerHTML = '<button id="settingsButton">Settings</button>';
	state.settingsDirty = false;
	settingsState.open = true;
	settingsState.previouslyFocused = null;
	settingsState.startPolling = vi.fn();
	settingsState.refresh = vi.fn();
	settingsState.controller = null;
	openDiagnosticsDrawer.mockReset();
});

afterEach(() => {
	document.body.innerHTML = "";
	settingsState.open = false;
	settingsState.startPolling = null;
	settingsState.refresh = null;
	settingsState.controller = null;
	state.settingsDirty = false;
	vi.restoreAllMocks();
});

describe("Settings observer diagnostics handoff", () => {
	it("closes Settings before opening diagnostics in a microtask", async () => {
		const startPolling = settingsState.startPolling;
		const refresh = settingsState.refresh;

		openObserverDiagnosticsFromSettings(observerDiagnosticsOptions);

		expect(settingsState.open).toBe(false);
		expect(startPolling).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
		expect(openDiagnosticsDrawer).not.toHaveBeenCalled();

		await Promise.resolve();

		expect(openDiagnosticsDrawer).toHaveBeenCalledWith({
			...observerDiagnosticsOptions,
			trigger: document.getElementById("settingsButton"),
		});
	});

	it("keeps Settings open when discarding dirty changes is declined", async () => {
		state.settingsDirty = true;
		vi.spyOn(globalThis, "confirm").mockReturnValue(false);

		openObserverDiagnosticsFromSettings(observerDiagnosticsOptions);
		await Promise.resolve();

		expect(settingsState.open).toBe(true);
		expect(settingsState.startPolling).not.toHaveBeenCalled();
		expect(settingsState.refresh).not.toHaveBeenCalled();
		expect(openDiagnosticsDrawer).not.toHaveBeenCalled();
	});
});
