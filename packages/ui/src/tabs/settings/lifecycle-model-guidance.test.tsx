import type { ComponentType } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { renderConfigModal } from "./data/config-loader";
import { settingsState } from "./data/state";
import { updateFormState } from "./data/state-ops";
import type { SettingsPanelProps } from "./data/types";
import { initSettings } from "./lifecycle";

vi.mock("./components/SettingsDialogShell", () => ({
	SettingsDialogShell: ({ DialogContent }: { DialogContent: ComponentType }) => <DialogContent />,
}));
vi.mock("./components/SettingsModalContent", () => ({
	SettingsModalContent: ({ panelProps }: { panelProps: SettingsPanelProps }) => (
		<span id="previewHint">{panelProps.getObserverModelHint()}</span>
	),
}));

afterEach(() => {
	const mount = document.getElementById("settingsDialogMount");
	if (mount) act(() => render(null, mount));
	document.body.innerHTML = "";
	settingsState.shellMounted = false;
	settingsState.touchedKeys.clear();
	settingsState.resolvedObserverRuntime = null;
	settingsState.observerRuntimeByAuthSource = {};
});

it.each([
	["claude_sidecar", "auto"],
	["codex_sidecar", "auto"],
	["claude_sidecar", "command"],
	["codex_sidecar", "command"],
])(
	"uses provider model guidance from automatic %s with %s authentication",
	(runtime, authSource) => {
		document.body.innerHTML = '<div id="settingsDialogMount"></div>';
		renderConfigModal({
			config: {},
			resolved_observer_runtime: runtime,
			observer_runtime_by_auth_source: { command: "api_http", auto: runtime },
		});
		settingsState.touchedKeys.add("observer_auth_source");
		updateFormState({ observerProvider: "anthropic", observerAuthSource: authSource });
		act(() => initSettings(vi.fn(), vi.fn(), vi.fn()));
		expect(document.getElementById("previewHint")?.textContent).toBe(
			"Recommended (Anthropic provider): claude-4.5-haiku",
		);
	},
);
