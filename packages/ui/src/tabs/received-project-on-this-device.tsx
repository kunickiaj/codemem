import { useState } from "preact/hooks";
import * as api from "../lib/api";
import { showGlobalNotice } from "../lib/notice";
import type { ReceivedProjectShare } from "./recipient-policy-projects";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

export interface ReceivedProjectActions {
	stop: (canonicalProjectIdentity: string) => Promise<unknown>;
	resume: (canonicalProjectIdentity: string) => Promise<unknown>;
	confirmStop: (share: ReceivedProjectShare) => Promise<boolean>;
}

function confirmStopReceiving(share: ReceivedProjectShare): Promise<boolean> {
	const kept = share.existingMemoryCount;
	return openSyncConfirmDialog({
		autoFocusAction: "cancel",
		title: `Stop receiving ${share.displayName} on this device?`,
		description: `This device stops getting new memories for ${share.displayName} and stops sending its own. It keeps the ${kept.toLocaleString()} ${kept === 1 ? "memory" : "memories"} it already has. You can resume at any time, and other devices aren't affected.`,
		confirmLabel: "Stop receiving",
		cancelLabel: "Keep receiving",
		tone: "danger",
	});
}

// Resolve the API at call time so importing this module does not read the API surface.
export const defaultReceivedProjectActions: ReceivedProjectActions = {
	stop: (identity) => api.stopProjectOnThisDevice(identity),
	resume: (identity) => api.resumeProjectOnThisDevice(identity),
	confirmStop: confirmStopReceiving,
};

function failureMessage(error: unknown, share: ReceivedProjectShare, stopping: boolean): string {
	const code = error instanceof Error ? error.message : "";
	if (code === "project_not_on_own_boundary")
		return `${share.displayName} was shared with this device the older way, so it can't be stopped here yet. Nothing changed.`;
	if (code === "project_not_stopped")
		return `${share.displayName} is already being received on this device. Refresh to see the current state.`;
	return `Couldn't ${stopping ? "stop" : "resume"} ${share.displayName} on this device. Nothing changed. Try again.`;
}

/** The "On this device" cell: whether this device receives the Project, and the switch. */
export function ReceivedProjectOnThisDevice({
	actions,
	disabled,
	onChanged,
	share,
}: {
	actions: ReceivedProjectActions;
	disabled?: boolean;
	onChanged?: () => Promise<unknown> | unknown;
	share: ReceivedProjectShare;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!share.onThisDevice) return <span className="small muted">Can't be stopped here</span>;
	const stopped = share.onThisDevice.stoppedAt !== null;

	async function change() {
		if (!stopped && !(await actions.confirmStop(share))) return;
		setBusy(true);
		setError(null);
		try {
			await (stopped ? actions.resume : actions.stop)(share.canonicalProjectIdentity);
			showGlobalNotice(
				stopped
					? `Resumed ${share.displayName}. This device catches up on its next sync.`
					: `Stopped receiving ${share.displayName} on this device.`,
			);
			await onChanged?.();
		} catch (failure) {
			setError(failureMessage(failure, share, !stopped));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="received-project-on-this-device">
			<span className="small">{stopped ? "Stopped" : "Receiving"}</span>
			<button
				className="settings-button recipient-policy-sharing-target-24"
				disabled={busy || disabled}
				onClick={() => void change()}
				type="button"
			>
				{stopped ? "Resume" : "Stop receiving…"}
			</button>
			{error ? (
				<p className="small recipient-policy-sharing-error" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
