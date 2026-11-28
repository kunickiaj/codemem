import { useState } from "preact/hooks";
import { Chip } from "../components/primitives/chip";
import { friendlyError } from "../lib/form";
import { confirmAndDisconnectDevice, type DeviceDisconnectDependencies } from "./device-disconnect";
import type { SyncActionFeedback } from "./sync/components/sync-inline-feedback";
import { SyncInlineFeedback } from "./sync/components/sync-inline-feedback";
import { openSyncInputDialog } from "./sync/sync-dialogs";
import {
	submitDiscoveredDeviceReview,
	type TeamSyncDiscoveredRow,
} from "./sync/team-sync/discovered-devices";

/** Rows the person can act on or needs to know about. Paired and idle devices have their own cards. */
export function reviewableDiscoveredRows(rows: TeamSyncDiscoveredRow[]): TeamSyncDiscoveredRow[] {
	return rows.filter(
		(row) => row.mode !== "paired" && row.mode !== "none" && row.mode !== "scope-pending",
	);
}

export interface DiscoveredDevicesApi {
	/** Asks for the name, then pairs or approves. Returns null when the person cancels. */
	review: (row: TeamSyncDiscoveredRow) => Promise<SyncActionFeedback | null>;
	disconnect: (row: TeamSyncDiscoveredRow) => Promise<SyncActionFeedback | null>;
}

export function discoveredDevicesApi(
	onApprovalSent?: () => void,
	disconnectDependencies?: Partial<DeviceDisconnectDependencies>,
): DiscoveredDevicesApi {
	return {
		review: async (row) => {
			const name = await openSyncInputDialog({
				title: "Pair with this device",
				description: "Choose a friendly name for this device before pairing it on this machine.",
				initialValue: row.displayName,
				placeholder: "Desk Mini",
				confirmLabel: "Pair",
				cancelLabel: "Cancel",
				validate: (value) => (value.trim() ? null : "Enter a device name to pair this device."),
			});
			if (!name) return null;
			try {
				return await submitDiscoveredDeviceReview(row, name, { onApprovalSent });
			} catch (error) {
				return {
					message: friendlyError(
						error,
						"Could not pair this device. Wait for a fresh presence update and try again.",
					),
					tone: "warning",
				};
			}
		},
		disconnect: (row) => confirmAndDisconnectDevice(row, disconnectDependencies),
	};
}

function ReviewAction({
	api,
	onDone,
	onFeedback,
	row,
}: {
	api: DiscoveredDevicesApi;
	onDone: () => unknown;
	onFeedback: (feedback: SyncActionFeedback | null) => void;
	row: TeamSyncDiscoveredRow;
}) {
	const [busy, setBusy] = useState(false);
	const idle = row.actionLabel || "Pair with this device";
	const [label, setLabel] = useState(idle);
	async function run() {
		setBusy(true);
		setLabel("Pairing…");
		onFeedback({
			message: `Pairing ${row.displayName}. Keep this page open while the device is approved and refreshed.`,
			tone: "success",
		});
		try {
			const next = await api.review(row);
			onFeedback(next);
			setLabel(next?.tone === "warning" ? "Retry" : idle);
			if (next) await Promise.resolve(onDone()).catch(() => undefined);
		} catch {
			onFeedback({ message: `Pairing ${row.displayName} failed. Try again.`, tone: "warning" });
			setLabel("Retry");
		} finally {
			setBusy(false);
		}
	}
	return (
		<button
			aria-label={`${label} for ${row.displayName}`}
			className="settings-button"
			disabled={busy}
			onClick={() => void run()}
			type="button"
		>
			{label}
		</button>
	);
}

function ConflictAction({
	api,
	onDone,
	onFeedback,
	row,
}: {
	api: DiscoveredDevicesApi;
	onDone: () => unknown;
	onFeedback: (feedback: SyncActionFeedback | null) => void;
	row: TeamSyncDiscoveredRow;
}) {
	const [busy, setBusy] = useState(false);
	async function run() {
		setBusy(true);
		try {
			const next = await api.disconnect(row);
			onFeedback(next);
			if (next?.tone === "success") await Promise.resolve(onDone()).catch(() => undefined);
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<p className="peer-meta">
				The pairing saved on this device does not match the device your team lists. Unpair it here,
				then pair {row.displayName} again.
			</p>
			<button
				aria-label={`Unpair ${row.displayName}`}
				className="settings-button danger"
				disabled={busy}
				onClick={() => void run()}
				type="button"
			>
				Unpair device…
			</button>
		</>
	);
}

function DiscoveredRow({
	api,
	onDone,
	onFeedback,
	row,
}: {
	api: DiscoveredDevicesApi;
	onDone: () => unknown;
	onFeedback: (feedback: SyncActionFeedback | null) => void;
	row: TeamSyncDiscoveredRow;
}) {
	return (
		<li
			className="peer-card peer-card--padded devices-discovered-row"
			data-discovered-device-id={row.deviceId}
		>
			<div className="peer-title">
				<strong title={row.displayTitle || undefined}>{row.displayName}</strong>
				<Chip
					variant="badge"
					tone={row.availabilityLabel === "Offline" ? "actor-badge" : "actor-badge local"}
				>
					{row.availabilityLabel}
				</Chip>
				<Chip variant="badge" tone="actor-badge">
					{row.connectionLabel}
				</Chip>
				{row.approvalBadgeLabel ? (
					<Chip variant="badge" tone="actor-badge">
						{row.approvalBadgeLabel}
					</Chip>
				) : null}
			</div>
			<div className="peer-meta">{row.note}</div>
			<div className="peer-actions">
				{row.mode === "accept" ? (
					<ReviewAction api={api} onDone={onDone} onFeedback={onFeedback} row={row} />
				) : null}
				{row.actionMessage ? <div className="peer-meta">{row.actionMessage}</div> : null}
				{row.mode === "conflict" ? (
					<ConflictAction api={api} onDone={onDone} onFeedback={onFeedback} row={row} />
				) : null}
			</div>
		</li>
	);
}

/**
 * Team devices the coordinator lists that this device can pair with or approve. Pairing and
 * approval start here, with no trip to Advanced. The result of an action is kept at this level
 * rather than in the row, because the row leaves the list once the pairing is saved.
 */
export function DevicesToReview({
	api,
	onDone,
	rows,
}: {
	api: DiscoveredDevicesApi;
	/** Refreshes Devices after a pairing, approval or disconnect. */
	onDone: () => unknown;
	rows: TeamSyncDiscoveredRow[];
}) {
	const [feedback, setFeedback] = useState<SyncActionFeedback | null>(null);
	const visible = reviewableDiscoveredRows(rows);
	if (visible.length === 0 && !feedback) return null;
	return (
		<section aria-labelledby="devices-to-review-heading" className="devices-to-review">
			<h3 id="devices-to-review-heading">
				Devices waiting for review{" "}
				{visible.length > 0 ? (
					<span className="devices-heading-count">· {visible.length}</span>
				) : null}
			</h3>
			<SyncInlineFeedback feedback={feedback} />
			{visible.length > 0 ? (
				<p className="small">
					Pair with a teammate's device so it appears in Devices and starts syncing.
				</p>
			) : null}
			<ul className="devices-to-review-list">
				{visible.map((row) => (
					<DiscoveredRow
						api={api}
						key={`${row.deviceId}:${row.incomingRequestId}:${row.fingerprint}`}
						onDone={onDone}
						onFeedback={setFeedback}
						row={row}
					/>
				))}
			</ul>
		</section>
	);
}
