import { Chip } from "../../../components/primitives/chip";
import { PresencePip } from "../../../components/primitives/presence-pip";
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
	if (status.state === "healthy") {
		return (
			<div className="advanced-sync-status-label">
				<PresencePip aria-label="Sync on" state="online" />
				<strong className="xl">Sync is on</strong>
				<Chip tone="badge-online" variant="badge">
					On
				</Chip>
			</div>
		);
	}
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
