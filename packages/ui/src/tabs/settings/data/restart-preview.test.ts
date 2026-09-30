import { afterEach, expect, it } from "vitest";
import { renderConfigModal } from "./config-loader";
import { pendingRestartRequired } from "./restart-preview";
import { settingsState } from "./state";
import { updateFormState } from "./state-ops";

afterEach(() => renderConfigModal({}));

it("tracks actual restart-required edits, not touched fields or hot-applied observer edits", () => {
	renderConfigModal({
		config: { sync_port: 7337, observer_model: "existing" },
		restart_required_keys: ["sync_port"],
	});
	settingsState.touchedKeys.add("sync_port");
	updateFormState({ syncPort: "7444" });
	expect(pendingRestartRequired()).toBe(true);
	updateFormState({ syncPort: "7337", observerModel: "new-model" });
	expect(pendingRestartRequired()).toBe(false);
});

it("does not predict a restart for environment-controlled edits", () => {
	renderConfigModal({
		config: { sync_port: 7337 },
		effective: { sync_port: 7444 },
		env_overrides: { sync_port: "CODEMEM_SYNC_PORT" },
		restart_required_keys: ["sync_port"],
	});
	settingsState.touchedKeys.add("sync_port");
	updateFormState({ syncPort: "7555" });
	expect(pendingRestartRequired()).toBe(false);
});
