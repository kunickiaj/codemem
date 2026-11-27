import { useState } from "preact/hooks";
import { claimLegacyDeviceIdentity } from "../lib/api/sync";
import { friendlyError } from "../lib/form";
import { formatTimestamp } from "../lib/format";
import {
	type SyncActionFeedback,
	SyncInlineFeedback,
} from "./sync/components/sync-inline-feedback";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

export interface LegacyDeviceHistory {
	originDeviceId: string;
	memoryCount: number;
	lastSeenAt: string;
}

export interface DeviceHistoryApi {
	confirm: typeof openSyncConfirmDialog;
	attach: (originDeviceId: string) => Promise<unknown>;
}

const defaultApi: DeviceHistoryApi = {
	confirm: openSyncConfirmDialog,
	attach: claimLegacyDeviceIdentity,
};

/** Older devices whose synced memories are not attached to a current device, from sync status. */
export function legacyDeviceHistories(raw: unknown): LegacyDeviceHistory[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item) => {
		const device = (item ?? {}) as {
			origin_device_id?: unknown;
			memory_count?: unknown;
			last_seen_at?: unknown;
		};
		const originDeviceId =
			typeof device.origin_device_id === "string" ? device.origin_device_id.trim() : "";
		if (!originDeviceId) return [];
		return [
			{
				originDeviceId,
				memoryCount: Math.max(0, Number(device.memory_count) || 0),
				lastSeenAt: typeof device.last_seen_at === "string" ? device.last_seen_at.trim() : "",
			},
		];
	});
}

function HistoryRow({
	api,
	device,
	onAttached,
	onFeedback,
}: {
	api: DeviceHistoryApi;
	device: LegacyDeviceHistory;
	onAttached: () => unknown;
	onFeedback: (feedback: SyncActionFeedback | null) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [label, setLabel] = useState("Attach history");
	async function run() {
		const confirmed = await api.confirm({
			title: `Attach history from ${device.originDeviceId}?`,
			description:
				"This updates legacy provenance so the older device history is attached to you on this device.",
			confirmLabel: "Attach history",
			cancelLabel: "Cancel",
			autoFocusAction: "cancel",
			tone: "danger",
		});
		if (!confirmed) return;
		setBusy(true);
		setLabel("Attaching…");
		onFeedback(null);
		try {
			await api.attach(device.originDeviceId);
			onFeedback({ message: "Old device history attached to you.", tone: "success" });
			setLabel("Attach history");
			await Promise.resolve(onAttached()).catch(() => undefined);
		} catch (error) {
			onFeedback({
				message: friendlyError(error, "Could not attach old device history."),
				tone: "warning",
			});
			setLabel("Retry");
		} finally {
			setBusy(false);
		}
	}
	return (
		<li className="devices-history-row">
			<div className="devices-history-identity">
				<strong>{device.originDeviceId}</strong>
				<span className="small">
					{device.memoryCount > 0
						? `${device.memoryCount.toLocaleString()} ${device.memoryCount === 1 ? "memory" : "memories"}`
						: "No memories counted"}
					{device.lastSeenAt ? ` · latest ${formatTimestamp(device.lastSeenAt)}` : ""}
				</span>
			</div>
			<button
				aria-label={`${label} from ${device.originDeviceId}`}
				className="settings-button"
				disabled={busy}
				onClick={() => void run()}
				type="button"
			>
				{label}
			</button>
		</li>
	);
}

/**
 * Memories that older versions synced from a device this install no longer knows. Attaching
 * them makes them yours on this device. The result stays here after the row leaves the list.
 */
export function DeviceHistoryAttach({
	api = defaultApi,
	devices,
	onAttached,
}: {
	api?: DeviceHistoryApi;
	devices: LegacyDeviceHistory[];
	/** Refreshes Devices after history is attached. */
	onAttached: () => unknown;
}) {
	const [feedback, setFeedback] = useState<SyncActionFeedback | null>(null);
	if (devices.length === 0 && !feedback) return null;
	return (
		<section aria-labelledby="devices-history-heading" className="devices-history">
			<h3 id="devices-history-heading">Older device history</h3>
			<SyncInlineFeedback feedback={feedback} />
			{devices.length > 0 ? (
				<>
					<p className="small">
						These memories came from older synced devices that are not attached to a current device.
					</p>
					<ul className="devices-history-list">
						{devices.map((device) => (
							<HistoryRow
								api={api}
								device={device}
								key={device.originDeviceId}
								onAttached={onAttached}
								onFeedback={setFeedback}
							/>
						))}
					</ul>
				</>
			) : null}
		</section>
	);
}
