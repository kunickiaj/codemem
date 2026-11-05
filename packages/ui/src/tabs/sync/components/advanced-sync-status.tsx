import { Chip } from "../../../components/primitives/chip";
import { PresencePip } from "../../../components/primitives/presence-pip";
import { SyncHealthSummary } from "../../../components/sync-health";
import { state } from "../../../lib/state";
import type { UiTeamSyncPrimaryStatus } from "../view-model";

export function AdvancedSyncStatus({ status }: { status: UiTeamSyncPrimaryStatus }) {
	if (status.state === "disabled") {
		return (
			<div className="advanced-sync-status-label">
				<PresencePip aria-label="Sync off" state="unknown" />
				<strong className="xl">Sync is off</strong>
				<Chip tone="badge-offline" variant="badge">
					Off
				</Chip>
			</div>
		);
	}
	if (status.state !== "needs-attention")
		return <SyncHealthSummary health={state.lastSyncStatus?.sync_health} />;
	return (
		<div className="advanced-sync-status-label">
			<PresencePip aria-label="Sync needs attention" state="degraded" />
			<strong className="xl">Sync needs attention</strong>
			<Chip tone="badge-offline" variant="badge">
				Attention
			</Chip>
		</div>
	);
}
