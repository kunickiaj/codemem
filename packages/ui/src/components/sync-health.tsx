import { formatRelativeTime, formatTimestamp } from "../lib/format";
import {
	type OverallSyncHealth,
	type PeerSyncHealth,
	type SyncDirectionHealth,
	syncHealthLabel,
	syncHealthReason,
	syncHealthSummary,
} from "../lib/sync-health";

export function SyncHealthState({ label, state }: { label: string; state?: string }) {
	const symbol = state === "needs_attention" ? "!" : "•";
	return (
		<span className="sync-health-state" data-state={state ?? "not_verified"}>
			<span aria-hidden="true" className="sync-health-state-icon">
				{symbol}
			</span>
			{label}
		</span>
	);
}

function summaryContext(health?: OverallSyncHealth | null): string {
	if (!health) return "Refresh to check sync";
	if (health.state === "disabled" || health.state === "no_peers") {
		return syncHealthSummary(health);
	}
	if (health.state === "needs_attention" && health.attention_count === 0)
		return "Sync service issue · Diagnostics in Advanced";
	if (health.state === "needs_attention") return "Review device sync details";
	if (health.state === "stale") return "Checks overdue for some devices";
	if (health.state === "not_verified") return "Some devices not verified";
	return "Recent checks passed";
}

function summaryHeadline(health?: OverallSyncHealth | null): string {
	if (health?.state === "needs_attention") return "Sync needs attention";
	if (health?.state === "disabled" || health?.state === "no_peers") return syncHealthLabel(health);
	return `Sync: ${syncHealthLabel(health)}`;
}

export function SyncHealthSummary({
	health,
	unavailable = false,
}: {
	health?: OverallSyncHealth | null;
	unavailable?: boolean;
}) {
	const current = unavailable ? null : health;
	const showCounts = current && current.state !== "disabled";
	return (
		<section
			className="sync-health-summary"
			data-state={current?.state ?? "not_verified"}
			aria-label="Sync health"
			role="status"
		>
			<div className="sync-health-overview">
				<div className="sync-health-heading">
					<strong>
						<SyncHealthState label={summaryHeadline(current)} state={current?.state} />
					</strong>
					<p>{summaryContext(current)}</p>
				</div>
				{showCounts ? (
					<dl className="sync-health-kpis">
						<div>
							<dt>Paired devices</dt>
							<dd>{current.peer_count.toLocaleString()}</dd>
						</div>
						<div data-state={current.attention_count > 0 ? "needs_attention" : undefined}>
							<dt>Need attention</dt>
							<dd>{current.attention_count.toLocaleString()}</dd>
						</div>
						<div>
							<dt>Not verified</dt>
							<dd>{current.unverified_count.toLocaleString()}</dd>
						</div>
					</dl>
				) : null}
			</div>
			<div className="sync-health-coverage">
				<span>Activity · Last 24h</span>
				{current && current.stale_count > 0 ? (
					<span>{current.stale_count.toLocaleString()} stale devices.</span>
				) : null}
			</div>
		</section>
	);
}

function directionFreshness(direction?: SyncDirectionHealth): string {
	if (!direction || direction.state === "not_verified") return "Not verified";
	const freshness = direction.last_success_at
		? formatRelativeTime(direction.last_success_at)
		: "No verified success";
	if (direction.state === "needs_attention") return "Needs attention";
	if (direction.state === "stale") return `Stale · ${freshness}`;
	return `OK · ${freshness}`;
}

function directionFailure(direction?: SyncDirectionHealth): string | null {
	if (direction?.state !== "needs_attention") return null;
	const reasons: Record<string, string> = {
		transfer_failed: "Transfer failed. Check connection and retry.",
		apply_failed: "Apply failed. Review sync diagnostics.",
		scope_rejected: "Access rejected. Review shared-space access.",
	};
	return reasons[direction.reason_code ?? ""] ?? "Exchange failed. Review sync diagnostics.";
}

function DirectionMetric({
	label,
	direction,
}: {
	label: "Sent" | "Received";
	direction?: SyncDirectionHealth;
}) {
	const method = label === "Sent" ? "Acknowledged" : "Applied";
	const failure = directionFailure(direction);
	return (
		<div className="device-sync-direction" data-state={direction?.state ?? "not_verified"}>
			<div className="device-sync-metric-heading">
				<span>{label}</span>
				<span>Last 24h</span>
			</div>
			<div
				className="device-sync-metric-value"
				title={`${method} unique operations in the last 24 hours since tracking began. Snapshot entries counted separately.`}
			>
				<strong>
					<span aria-hidden="true">{direction?.operations_24h?.toLocaleString() ?? "—"}</span>
					<span className="sr-only">
						{method} operations in 24 hours: {direction?.operations_24h ?? "Not verified"}
					</span>
				</strong>
				<span
					className="device-sync-freshness"
					title={
						direction?.last_success_at
							? `Last success: ${formatTimestamp(direction.last_success_at)}`
							: undefined
					}
				>
					{directionFreshness(direction)}
				</span>
			</div>
			{failure ? <p className="device-sync-failure">{failure}</p> : null}
		</div>
	);
}

function DirectionDetails({
	label,
	direction,
}: {
	label: "Sent" | "Received";
	direction?: SyncDirectionHealth;
}) {
	const reason = syncHealthReason(direction?.reason_code);
	const method = label === "Sent" ? "Acknowledged" : "Applied";
	return (
		<div className="device-sync-direction-details">
			<h4>
				{label}: {syncHealthLabel(direction)}
			</h4>
			<dl>
				<dt>Last success</dt>
				<dd>
					{direction?.last_success_at ? formatTimestamp(direction.last_success_at) : "Not verified"}
				</dd>
				<dt>Last attempt</dt>
				<dd>
					{direction?.last_attempt_at ? formatTimestamp(direction.last_attempt_at) : "Not verified"}
				</dd>
				<dt>{method} (24h)</dt>
				<dd>{direction?.operations_24h?.toLocaleString() ?? "Not verified"}</dd>
				<dt>Snapshot entries (24h)</dt>
				<dd>{direction?.snapshot_items_24h?.toLocaleString() ?? "Not verified"}</dd>
				<dt>Tracking began</dt>
				<dd>
					{direction?.observed_since ? formatTimestamp(direction.observed_since) : "Not verified"}
				</dd>
				<dt>Queued for sync</dt>
				<dd>
					{direction?.pending_count == null
						? "Unknown"
						: `${direction.pending_count.toLocaleString()} pending`}
				</dd>
			</dl>
			{reason ? <p>{reason}</p> : null}
		</div>
	);
}

export function DirectionalSyncHealth({ health }: { health?: PeerSyncHealth | null }) {
	return (
		<div className="device-sync-health">
			<div className="device-sync-directions">
				<DirectionMetric label="Sent" direction={health?.send} />
				<DirectionMetric label="Received" direction={health?.receive} />
			</div>
			<details className="device-sync-details">
				<summary>Sync details</summary>
				<div className="device-sync-details-content">
					<p>
						Sent shows unique operations acknowledged by the peer. Acknowledgment does not confirm
						remote import. Received shows unique operations applied here. Counts cover the last 24
						hours since tracking began. Snapshot entries are counted separately.
					</p>
					<DirectionDetails label="Sent" direction={health?.send} />
					<DirectionDetails label="Received" direction={health?.receive} />
				</div>
			</details>
		</div>
	);
}
