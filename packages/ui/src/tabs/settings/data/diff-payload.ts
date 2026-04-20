/* Compute the subset of settings that actually changed versus the
 * baseline — skipping protected keys and env-override-managed keys
 * the user didn't touch. */

import { hasOwn, isEqualValue } from "./value-helpers";

export interface DiffSettingsPayloadInput {
	current: Record<string, unknown>;
	baseline: Record<string, unknown>;
	envOverrides: Record<string, unknown>;
	touchedKeys: Set<string>;
	isProtected: (key: string) => boolean;
}

export function diffSettingsPayload(input: DiffSettingsPayloadInput): Record<string, unknown> {
	const { current, baseline, envOverrides, touchedKeys, isProtected } = input;
	const changed: Record<string, unknown> = {};
	Object.entries(current).forEach(([key, value]) => {
		if (isProtected(key)) return;
		if (hasOwn(envOverrides, key) && !touchedKeys.has(key)) return;
		if (!isEqualValue(value, baseline[key])) {
			changed[key] = value;
		}
	});
	return changed;
}
