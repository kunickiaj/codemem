/* Device-name derivations — resolve the friendly display string for a
 * discovered device (prefer local rename, then coordinator display
 * name, then a short id fallback) and detect the "id-only" case where
 * the UI should prompt the operator to name the device. */

import { cleanText, friendlyDeviceFallback } from "./internal";

export function resolveFriendlyDeviceName(input: {
	localName?: unknown;
	coordinatorName?: unknown;
	deviceId?: unknown;
}): string {
	const localName = cleanText(input.localName);
	if (localName) return localName;
	const coordinatorName = cleanText(input.coordinatorName);
	if (coordinatorName) return coordinatorName;
	return friendlyDeviceFallback(cleanText(input.deviceId));
}

export function deviceNeedsFriendlyName(input: {
	localName?: unknown;
	coordinatorName?: unknown;
	deviceId?: unknown;
}): boolean {
	const localName = cleanText(input.localName);
	const coordinatorName = cleanText(input.coordinatorName);
	if (localName || coordinatorName) return false;
	return Boolean(cleanText(input.deviceId));
}
