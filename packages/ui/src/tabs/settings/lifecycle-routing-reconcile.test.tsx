import type { ComponentType } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { renderConfigModal } from "./data/config-loader";
import { updateObserverApply } from "./data/observer-apply";
import { settingsState, settingsView } from "./data/state";
import type { SettingsPanelProps } from "./data/types";
import { initSettings } from "./lifecycle";

const captured = vi.hoisted(() => ({ props: null as SettingsPanelProps | null }));
vi.mock("./components/SettingsDialogShell", () => ({
	SettingsDialogShell: ({ DialogContent }: { DialogContent: ComponentType }) => <DialogContent />,
}));
vi.mock("./components/SettingsModalContent", () => ({
	SettingsModalContent: ({ panelProps }: { panelProps: SettingsPanelProps }) => {
		captured.props = panelProps;
		return null;
	},
}));

afterEach(() => {
	const mount = document.getElementById("settingsDialogMount");
	if (mount) act(() => render(null, mount));
	document.body.innerHTML = "";
	settingsState.shellMounted = false;
	captured.props = null;
});

it("reconciles routing through the lifecycle-bound provider change handler", () => {
	document.body.innerHTML = '<div id="settingsDialogMount"></div>';
	renderConfigModal({ config: {}, observer_apply: { state: "applying" } });
	act(() => initSettings(vi.fn(), vi.fn(), vi.fn()));
	act(() => captured.props?.onSelectValueChange("observerProvider")("anthropic"));
	act(() =>
		updateObserverApply({
			observer_apply: { state: "active", active: { tierRoutingEnabled: true } },
		}),
	);
	expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(false);
	act(() => captured.props?.onSelectValueChange("observerProvider")(""));
	expect(settingsView.value.renderState.values.observerTierRoutingEnabled).toBe(true);
});
