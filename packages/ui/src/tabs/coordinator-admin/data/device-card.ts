import type { CachedCoordinatorAdminDevice } from "../../../lib/state";

export interface CoordinatorAdminDeviceCardCopy {
	deviceId: string;
	displayName: string;
	teamId: string;
	statusLabel: string;
	advancedDetail: string;
}

interface DeviceAliasCandidate {
	device_id?: string;
	display_name?: string | null;
}

export interface UnnamedDeviceAliasRegistry {
	aliases: Map<string, string>;
	duplicateDisplayNames: Map<string, { sourceName: string; displayName: string }>;
	reservedDisplayNames: Set<string>;
}

export function createUnnamedDeviceAliasRegistry(): UnnamedDeviceAliasRegistry {
	return { aliases: new Map(), duplicateDisplayNames: new Map(), reservedDisplayNames: new Set() };
}

export function stableUnnamedDeviceAliases(
	devices: DeviceAliasCandidate[],
	registry = createUnnamedDeviceAliasRegistry(),
): Map<string, string> {
	for (const device of devices) {
		const displayName = String(device.display_name || "").trim();
		if (displayName) registry.reservedDisplayNames.add(displayName);
	}
	for (const [deviceId, alias] of registry.aliases) {
		if (registry.reservedDisplayNames.has(alias)) registry.aliases.delete(deviceId);
	}
	const usedNames = new Set([...registry.reservedDisplayNames, ...registry.aliases.values()]);
	const unnamedDeviceIds = devices
		.filter((device) => !String(device.display_name || "").trim())
		.map((device) => String(device.device_id || "").trim())
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));
	let nextOrdinal = Math.max(
		0,
		...[...registry.aliases.values()].map((alias) => {
			const match = /^Unnamed device (\d+)$/.exec(alias);
			return match ? Number(match[1]) : 0;
		}),
	);
	for (const deviceId of unnamedDeviceIds) {
		if (registry.aliases.has(deviceId)) continue;
		let alias: string;
		do {
			nextOrdinal += 1;
			alias = `Unnamed device ${nextOrdinal}`;
		} while (usedNames.has(alias));
		registry.aliases.set(deviceId, alias);
		usedNames.add(alias);
	}
	return registry.aliases;
}

export function stableDeviceDisplayNames(
	devices: DeviceAliasCandidate[],
	registry = createUnnamedDeviceAliasRegistry(),
): Map<string, string> {
	const unnamedAliases = stableUnnamedDeviceAliases(devices, registry);
	const names = new Map<string, string>();
	const namedDevicesByDisplayName = new Map<string, string[]>();
	const currentNamesByDeviceId = new Map<string, string>();
	const rawDisplayNames = new Set<string>();
	for (const device of devices) {
		const deviceId = String(device.device_id || "").trim();
		const displayName = String(device.display_name || "").trim();
		if (!deviceId) continue;
		if (!displayName) {
			names.set(deviceId, unnamedAliases.get(deviceId) || "Unnamed device");
			continue;
		}
		currentNamesByDeviceId.set(deviceId, displayName);
		rawDisplayNames.add(displayName);
		const matchingDevices = namedDevicesByDisplayName.get(displayName) ?? [];
		matchingDevices.push(deviceId);
		namedDevicesByDisplayName.set(displayName, matchingDevices);
	}
	for (const [deviceId, entry] of registry.duplicateDisplayNames) {
		const currentName = currentNamesByDeviceId.get(deviceId);
		if (
			(currentName && currentName !== entry.sourceName) ||
			rawDisplayNames.has(entry.displayName)
		) {
			registry.duplicateDisplayNames.delete(deviceId);
		}
	}
	const usedNames = new Set([
		...rawDisplayNames,
		...[...registry.duplicateDisplayNames.values()].map((entry) => entry.displayName),
	]);
	for (const [displayName, deviceIds] of namedDevicesByDisplayName) {
		for (const deviceId of deviceIds.sort((a, b) => a.localeCompare(b))) {
			const existing = registry.duplicateDisplayNames.get(deviceId);
			if (existing?.sourceName === displayName) {
				names.set(deviceId, existing.displayName);
				continue;
			}
			if (deviceIds.length === 1) {
				names.set(deviceId, displayName);
				continue;
			}
			let ordinal = 0;
			let disambiguatedName: string;
			do {
				ordinal += 1;
				disambiguatedName = `${displayName} · Device ${ordinal}`;
			} while (usedNames.has(disambiguatedName));
			names.set(deviceId, disambiguatedName);
			registry.duplicateDisplayNames.set(deviceId, {
				displayName: disambiguatedName,
				sourceName: displayName,
			});
			usedNames.add(disambiguatedName);
		}
	}
	return names;
}

export function coordinatorAdminDeviceCardCopy(
	device: CachedCoordinatorAdminDevice,
	fallbackTeamId: string,
	displayNameOverride = "",
): CoordinatorAdminDeviceCardCopy {
	const deviceId = String(device.device_id || "").trim();
	const teamId = String(device.group_id || fallbackTeamId || "").trim();
	const displayName =
		displayNameOverride || String(device.display_name || "").trim() || "Unnamed device";
	const enabled = device.enabled !== false && device.enabled !== 0;
	const advancedParts = [`Device ID ${deviceId || "unknown"}`];
	if (teamId) advancedParts.push(`Group ID ${teamId}`);
	return {
		advancedDetail: `Advanced: ${advancedParts.join(" · ")}`,
		deviceId,
		displayName,
		statusLabel: enabled
			? "Enabled in this coordinator group"
			: "Disabled in this coordinator group",
		teamId,
	};
}
