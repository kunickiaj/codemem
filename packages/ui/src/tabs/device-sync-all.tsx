import { useState } from "preact/hooks";
import { isManualSyncPending } from "../lib/manual-sync";
import { state } from "../lib/state";

/**
 * Syncs every paired device. The result appears in the header status, so the person can
 * keep browsing while it runs. It waits for the signed-in person to be known, because the
 * result is only shown for the person who started it.
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
		if (busy || isManualSyncPending() || state.viewerActorId === null) return;
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
			disabled={disabled || busy || state.viewerActorId === null}
			onClick={() => void run()}
			type="button"
		>
			{busy ? "Syncing…" : "Sync all devices"}
		</button>
	);
}
