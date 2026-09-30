import { collectSettingsPayload, isProtectedConfigKey } from "./config-loader";
import { diffSettingsPayload } from "./diff-payload";
import { settingsState } from "./state";

export function pendingRestartRequired(): boolean {
	try {
		const changed = diffSettingsPayload({
			current: collectSettingsPayload({ allowUntouchedParseErrors: true }),
			baseline: settingsState.baseline,
			envOverrides: settingsState.envOverrides,
			touchedKeys: settingsState.touchedKeys,
			isProtected: isProtectedConfigKey,
		});
		return Object.keys(changed).some(
			(key) => settingsState.restartRequiredKeys.has(key) && !(key in settingsState.envOverrides),
		);
	} catch {
		return false;
	}
}
