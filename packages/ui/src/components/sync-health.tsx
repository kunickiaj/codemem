import { formatRelativeTime, formatTimestamp } from "../lib/format";
import {
	hasSyncAttemptFailure,
	type OverallSyncHealth,
	type PeerSyncHealth,
	type SyncDirectionHealth,
	syncDirectionActivity,
	syncDirectionLabel,
	syncHealthLabel,
	syncHealthReason,
	syncHealthSummary,
} from "../lib/sync-health";
import { Tooltip, TooltipProvider } from "./primitives/tooltip";

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

function directionFailure(direction?: SyncDirectionHealth): string | null {
	if (direction?.state !== "needs_attention") return null;
	return syncHealthReason(direction.reason_code) ?? "Review sync diagnostics, then retry sync.";
}

function DirectionMetric({
	label,
	direction,
}: {
	label: "Send" | "Receive";
	direction?: SyncDirectionHealth;
}) {
	return (
		<div className="device-sync-direction" data-state={direction?.state ?? "not_verified"}>
			<div className="device-sync-metric-heading">{label}</div>
			<SyncHealthState label={syncDirectionLabel(label, direction)} state={direction?.state} />
			<span
				className="device-sync-freshness"
				title={
					direction?.last_success_at
						? `Last success: ${formatTimestamp(direction.last_success_at)}`
						: undefined
				}
			>
				{direction?.last_success_at
					? `Last success ${formatRelativeTime(direction.last_success_at)}`
					: "No verified success"}
			</span>
			<span className="device-sync-activity">{syncDirectionActivity(label, direction)}</span>
		</div>
	);
}

function SyncTerm({ label, description }: { label: string; description: string }) {
	return (
		<Tooltip label={description} openOnClick>
			<button className="device-sync-term" type="button" aria-label={`About ${label}`}>
				{label}
			</button>
		</Tooltip>
	);
}

function countDefinition(label: "Send" | "Receive", direction?: SyncDirectionHealth): string {
	const meaning =
		label === "Send"
			? "Unique operations acknowledged by the paired device. Remote import is not confirmed."
			: "Unique operations applied on this device.";
	const start = direction?.observed_since
		? ` Tracking began ${formatTimestamp(direction.observed_since)}.`
		: "";
	return `${meaning} Counts cover the last 24 hours since tracking began. Zero does not confirm that devices are caught up.${start}`;
}

function DirectionDetails({
	label,
	direction,
}: {
	label: "Send" | "Receive";
	direction?: SyncDirectionHealth;
}) {
	const reason = directionFailure(direction) ?? syncHealthReason(direction?.reason_code);
	const method = label === "Send" ? "Acknowledged operations (24h)" : "Applied operations (24h)";
	return (
		<div className="device-sync-direction-details">
			<h4>{label}</h4>
			<dl>
				<dt>
					<SyncTerm
						label="Last success"
						description="Last successful exchange. A successful exchange can transfer zero operations."
					/>
				</dt>
				<dd>
					{direction?.last_success_at ? formatTimestamp(direction.last_success_at) : "Not verified"}
				</dd>
				<dt>Last attempt</dt>
				<dd>
					{direction?.last_attempt_at ? formatTimestamp(direction.last_attempt_at) : "Not verified"}
				</dd>
				<dt>
					<SyncTerm label={method} description={countDefinition(label, direction)} />
				</dt>
				<dd>{direction?.operations_24h?.toLocaleString() ?? "Not recorded"}</dd>
				<dt>
					<SyncTerm
						label="Snapshot entries (24h)"
						description="Entries transferred in snapshots during the last 24 hours. Snapshot entries are counted separately from operations."
					/>
				</dt>
				<dd>{direction?.snapshot_items_24h?.toLocaleString() ?? "Not recorded"}</dd>
				{reason ? <dt>Failure</dt> : null}
				{reason ? <dd>{reason}</dd> : null}
			</dl>
		</div>
	);
}

function ConnectionSummary({ health }: { health?: PeerSyncHealth | null }) {
	const connection = health?.last_successful_connection;
	let label = "Not recorded";
	if (!health) label = "Not verified";
	if (connection?.transport === "direct") label = "Direct";
	if (connection?.transport === "relay") label = "Relay";
	return (
		<div className="device-sync-connection">
			<SyncTerm
				label="Last successful connection"
				description="Connection used by the latest successful sync started from this device. Incoming connections are not recorded."
			/>
			<strong>{label}</strong>
			{connection?.transport && connection.at ? (
				<span title={formatTimestamp(connection.at)}>{formatRelativeTime(connection.at)}</span>
			) : null}
		</div>
	);
}

export function DirectionalSyncHealth({ health }: { health?: PeerSyncHealth | null }) {
	return (
		<TooltipProvider delayDuration={700}>
			<div className="device-sync-health">
				<ConnectionSummary health={health} />
				{hasSyncAttemptFailure(health) ? (
					<SyncHealthState label="Latest sync attempt failed" state="needs_attention" />
				) : null}
				<div className="device-sync-directions">
					<DirectionMetric label="Send" direction={health?.send} />
					<DirectionMetric label="Receive" direction={health?.receive} />
				</div>
				<details className="device-sync-details">
					<summary>Sync details</summary>
					<div className="device-sync-details-content">
						<DirectionDetails label="Send" direction={health?.send} />
						<DirectionDetails label="Receive" direction={health?.receive} />
					</div>
				</details>
			</div>
		</TooltipProvider>
	);
}
