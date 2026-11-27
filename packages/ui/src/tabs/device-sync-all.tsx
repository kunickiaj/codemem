import { useState } from "preact/hooks";
import { isManualSyncPending } from "../lib/manual-sync";

/**
 * Syncs every paired device. The result appears in the header status, so the person can
 * keep browsing while it runs. Until the signed-in person is known, a click explains that
 * and starts nothing. The button cannot show that wait itself, because the person loads
 * separately and does not redraw Devices.
 */
export function SyncAllDevicesButton({
	disabled,
	onSyncAll,
}: {
	disabled: boolean;
	onSyncAll: () => Promise<unknown>;
}) {
	const [busy, setBusy] = useState(false);
	async function run() {
		if (busy || isManualSyncPending()) return;
		setBusy(true);
		try {
			await onSyncAll();
		} finally {
			setBusy(false);
		}
	}
	return (
		<button
			aria-busy={busy}
			className="settings-button"
			disabled={disabled || busy}
			onClick={() => void run()}
			type="button"
		>
			{busy ? "Syncing…" : "Sync all devices"}
		</button>
	);
}
