import { formatTimestamp } from "../lib/format";
import {
	type OverallSyncHealth,
	type PeerSyncHealth,
	type SyncDirectionHealth,
	syncHealthLabel,
	syncHealthReason,
	syncHealthSummary,
} from "../lib/sync-health";

export function SyncHealthSummary({
	health,
	unavailable = false,
}: {
	health?: OverallSyncHealth | null;
	unavailable?: boolean;
}) {
	const current = unavailable ? null : health;
	return (
		<div className="device-identity-setup-summary" role="status">
			<strong>Sync: {syncHealthLabel(current)}</strong>
			<span className="small">{syncHealthSummary(current)}</span>
		</div>
	);
}

function DirectionEvidence({
	label,
	direction,
}: {
	label: "Sending" | "Receiving";
	direction?: SyncDirectionHealth;
}) {
	const reason = syncHealthReason(direction?.reason_code);
	const operationLabel = label === "Sending" ? "Acknowledged" : "Applied";
	return (
		<div className="device-sync-direction small">
			<strong>
				{label}: {syncHealthLabel(direction)}
			</strong>
			<div>
				Last success:{" "}
				{direction?.last_success_at ? formatTimestamp(direction.last_success_at) : "Not verified"}
			</div>
			{direction?.state === "needs_attention" ? (
				<div>Last attempt: {formatTimestamp(direction.last_attempt_at)}</div>
			) : null}
			<div title="Unique operations observed in the last 24 hours since tracking began. Snapshot entries are counted separately. Acknowledgment does not confirm remote import.">
				{operationLabel} (24h): {direction?.operations_24h?.toLocaleString() ?? "Not verified"}
			</div>
			{direction?.snapshot_items_24h ? (
				<div>Snapshot entries (24h): {direction.snapshot_items_24h.toLocaleString()}</div>
			) : null}
			<div>
				Backlog:{" "}
				{direction?.pending_count == null
					? "Not verified"
					: `${direction.pending_count.toLocaleString()} pending`}
			</div>
			{reason ? <div>{reason}</div> : null}
		</div>
	);
}

export function DirectionalSyncHealth({ health }: { health?: PeerSyncHealth | null }) {
	return (
		<div className="device-sync-directions">
			<DirectionEvidence label="Sending" direction={health?.send} />
			<DirectionEvidence label="Receiving" direction={health?.receive} />
		</div>
	);
}
