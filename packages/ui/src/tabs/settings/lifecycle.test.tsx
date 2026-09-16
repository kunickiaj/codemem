import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsState, settingsView } from "./data/state";

const openDiagnosticsDrawer = vi.hoisted(() => vi.fn());
const saveConfig = vi.hoisted(() => vi.fn());

vi.mock("../../components/diagnostics", () => ({ openDiagnosticsDrawer }));
vi.mock("../../lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/api")>()),
	saveConfig,
}));

import { collectSettingsPayload } from "./data/config-loader";
import { setDirty, updateFormState } from "./data/state-ops";
import { closeSettings, openObserverDiagnosticsFromSettings, saveSettings } from "./lifecycle";

const observerDiagnosticsOptions = {
	severity: "error" as const,
	subsystem: "observer" as const,
};

beforeEach(() => {
	document.body.innerHTML = '<button id="settingsButton">Settings</button>';
	settingsView.value = { ...settingsView.value, dirty: false, open: true };
	settingsState.previouslyFocused = null;
	settingsState.startPolling = vi.fn();
	settingsState.refresh = vi.fn();
	settingsState.hideTooltip = null;
	openDiagnosticsDrawer.mockReset();
	saveConfig.mockReset();
});

function editSyncEnabled() {
	const baseline = collectSettingsPayload({ allowUntouchedParseErrors: true });
	settingsState.baseline = baseline;
	settingsState.touchedKeys = new Set(["sync_enabled"]);
	updateFormState({ syncEnabled: !baseline.sync_enabled });
	setDirty(true);
}

afterEach(() => {
	document.body.innerHTML = "";
	settingsView.value = { ...settingsView.value, dirty: false, open: false };
	settingsState.startPolling = null;
	settingsState.refresh = null;
	settingsState.hideTooltip = null;
	vi.restoreAllMocks();
});

describe("Settings observer diagnostics handoff", () => {
	it("closes Settings before opening diagnostics in a microtask", async () => {
		const startPolling = settingsState.startPolling;
		const refresh = settingsState.refresh;

		openObserverDiagnosticsFromSettings(observerDiagnosticsOptions);

		expect(settingsView.value.open).toBe(false);
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
		settingsView.value = { ...settingsView.value, dirty: true };
		vi.spyOn(globalThis, "confirm").mockReturnValue(false);

		openObserverDiagnosticsFromSettings(observerDiagnosticsOptions);
		await Promise.resolve();

		expect(settingsView.value.open).toBe(true);
		expect(settingsState.startPolling).not.toHaveBeenCalled();
		expect(settingsState.refresh).not.toHaveBeenCalled();
		expect(openDiagnosticsDrawer).not.toHaveBeenCalled();
	});

	it("closes dirty settings and resumes polling when discard is confirmed", () => {
		settingsView.value = { ...settingsView.value, dirty: true };
		vi.spyOn(globalThis, "confirm").mockReturnValue(true);
		const startPolling = vi.fn();
		const refresh = vi.fn();

		closeSettings(startPolling, refresh);

		expect(settingsView.value.open).toBe(false);
		expect(settingsState.touchedKeys).toEqual(new Set());
		expect(startPolling).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("keeps edits after a save failure and closes after a successful retry", async () => {
		editSyncEnabled();
		const startPolling = vi.fn();
		const refresh = vi.fn();
		saveConfig.mockRejectedValueOnce(new Error("network down"));

		await saveSettings(startPolling, refresh);

		expect(settingsView.value).toMatchObject({ dirty: true, open: true });
		expect(settingsView.value.renderState).toMatchObject({
			isSaving: false,
			statusText: "Save failed: network down",
		});
		expect(startPolling).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();

		saveConfig.mockResolvedValueOnce({});
		await saveSettings(startPolling, refresh);

		expect(saveConfig).toHaveBeenCalledTimes(2);
		expect(settingsView.value).toMatchObject({ dirty: false, open: false });
		expect(startPolling).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
	});
});
