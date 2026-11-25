import { useState } from "preact/hooks";
import type { DeviceIdentityInventoryItemV1, DeviceIdentityInventoryV1 } from "../lib/api/sync";
import { formatTimestamp } from "../lib/format";
import type { DiscoveredDevice } from "../lib/state";

const STORAGE_PREFIX = "codemem.device-rejoin-notice.dismissed.v1:";
const MAX_DISMISSED = 200;

/** Display-only marker from the coordinator; anything else is not shown. */
export function validRejoin(
	item: Pick<DeviceIdentityInventoryItemV1, "rejoin">,
): { deviceId: string; rejoinedAtMs: number } | null {
	const rejoin = item.rejoin;
	if (!rejoin || typeof rejoin.deviceId !== "string" || rejoin.deviceId.length === 0) return null;
	const at = rejoin.rejoinedAtMs;
	const safe = Number.isSafeInteger(at) && at >= 0 && at <= 8.64e15;
	return safe ? { deviceId: rejoin.deviceId, rejoinedAtMs: at } : null;
}

/** One exact device and timestamp, so a fresh rejoin of the same device shows again. */
function dismissalKey(rejoin: { deviceId: string; rejoinedAtMs: number }): string {
	return JSON.stringify([rejoin.deviceId, rejoin.rejoinedAtMs]);
}

function readDismissed(localDeviceId: string): string[] {
	try {
		const parsed: unknown = JSON.parse(
			window.localStorage.getItem(`${STORAGE_PREFIX}${localDeviceId}`) ?? "[]",
		);
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		return [];
	}
}

function writeDismissed(localDeviceId: string, keys: string[]): void {
	try {
		window.localStorage.setItem(`${STORAGE_PREFIX}${localDeviceId}`, JSON.stringify(keys));
	} catch {
		// An unwritable store still hides the notice until the Viewer reloads.
	}
}

/** Supplement existing rows with display evidence. Discovery alone never creates an inventory row. */
export function withDiscoveredRejoinNotices(
	inventory: DeviceIdentityInventoryV1 | undefined,
	devices: readonly DiscoveredDevice[],
): DeviceIdentityInventoryV1 | undefined {
	if (!inventory || devices.length === 0) return inventory;
	const byId = new Map<string, DiscoveredDevice | null>();
	for (const device of devices) {
		const id = device.device_id;
		if (id) byId.set(id, byId.has(id) ? null : device);
	}
	const items = inventory.items.map((item) => {
		if (item.isLocal || ["retired", "service", "conflicted"].includes(item.state)) return item;
		const at = byId.get(item.deviceId)?.rejoined_at_ms;
		if (typeof at !== "number" || (item.rejoin && at <= item.rejoin.rejoinedAtMs)) return item;
		const rejoin = validRejoin({ rejoin: { deviceId: item.deviceId, rejoinedAtMs: at } });
		return rejoin ? { ...item, rejoin } : item;
	});
	return { ...inventory, items };
}

/**
 * Shows that Google sign-in rejoin wrote this device's current enrollment. It grants and
 * changes nothing. A person's dismissal is kept per own device, so a new rejoin reappears.
 */
export function DeviceRejoinNotice({
	item,
	localDeviceId,
}: {
	item: DeviceIdentityInventoryItemV1;
	localDeviceId: string | undefined;
}) {
	const [dismissed, setDismissed] = useState<{ localDeviceId: string; keys: string[] } | null>(
		null,
	);
	const rejoin = validRejoin(item);
	if (!rejoin) return null;
	const key = dismissalKey(rejoin);
	const keys = dismissed?.localDeviceId === localDeviceId ? (dismissed?.keys ?? []) : [];
	const known = localDeviceId ? [...keys, ...readDismissed(localDeviceId)] : [];
	if (known.includes(key)) return null;
	const dismiss = () => {
		if (!localDeviceId) return;
		const next = [...new Set([...known, ...readDismissed(localDeviceId), key])].slice(
			-MAX_DISMISSED,
		);
		writeDismissed(localDeviceId, next);
		setDismissed({ localDeviceId, keys: next });
	};
	return (
		<p className="small device-rejoin-notice" role="status">
			Rejoined by Google sign-in · {formatTimestamp(rejoin.rejoinedAtMs)}{" "}
			{localDeviceId ? (
				<button
					aria-label={`Dismiss rejoin notice for ${item.displayName}`}
					className="settings-button"
					onClick={dismiss}
					type="button"
				>
					Dismiss
				</button>
			) : null}
		</p>
	);
}
