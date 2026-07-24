import { cleanText } from "./internal";
import { derivePeerTrustSummary } from "./peer-status";
import type {
	DiscoveredDeviceLike,
	PeerLike,
	ProjectShareOperationLike,
	RecipientPolicyReconciliationLike,
	TeamSyncDaemonState,
	TeamSyncPresenceState,
	TeamSyncProjectOperationState,
	TeamSyncReconciliationState,
	UiTeamSyncPrimaryStatus,
} from "./types";

type CoordinatorLike = {
	configured?: boolean;
	sync_enabled?: boolean;
	presence_status?: TeamSyncPresenceState;
	groups?: unknown[];
	discovered_devices?: DiscoveredDeviceLike[];
};

type SyncStatusLike = {
	enabled?: boolean;
	daemon_state?: TeamSyncDaemonState;
	daemon_running?: boolean;
};

const PENDING_OPERATION_STATES: ReadonlySet<TeamSyncProjectOperationState> = new Set([
	"pending_setup",
	"waiting_for_acceptance",
	"provisioning",
	"initial_sync",
	"waiting_for_device",
]);
const PENDING_RECONCILIATION_STATES: ReadonlySet<TeamSyncReconciliationState> = new Set([
	"pending",
	"verifying",
	"waiting",
]);

function teamLabel(coordinator?: CoordinatorLike | null): string {
	const groups = Array.isArray(coordinator?.groups)
		? coordinator.groups.map((group) => cleanText(group)).filter(Boolean)
		: [];
	return groups.join(", ") || "none";
}

function projectLabel(operation?: ProjectShareOperationLike): string {
	return cleanText(operation?.projects?.[0]?.display_name) || "the shared Project";
}

function reconciliationProjectLabel(reconciliation?: RecipientPolicyReconciliationLike): string {
	const blocked = reconciliation?.items?.find((item) => item.state !== "active");
	return cleanText(blocked?.canonicalProjectIdentity) || "the shared Project";
}

function hasTrustBlocker(peers: PeerLike[], coordinator?: CoordinatorLike | null): boolean {
	if (
		coordinator?.discovered_devices?.some(
			(device) => device.needs_local_approval || device.waiting_for_peer_approval,
		)
	) {
		return true;
	}
	return peers.some((peer) => {
		const trust = derivePeerTrustSummary(peer).state;
		return trust === "trusted-by-you" || trust === "needs-repairing";
	});
}

function hasHealthyDataPlane(peers: PeerLike[], status?: SyncStatusLike | null): boolean {
	if (status?.enabled !== true || status.daemon_state !== "ok" || status.daemon_running === false) {
		return false;
	}
	return peers.some(
		(peer) =>
			peer.status?.sync_status === "ok" && derivePeerTrustSummary(peer).state === "mutual-trust",
	);
}

function hasReachableTrustedPeer(peers: PeerLike[]): boolean {
	return peers.some(
		(peer) =>
			cleanText(peer.status?.peer_state) === "online" &&
			derivePeerTrustSummary(peer).state === "mutual-trust",
	);
}

function hasDeviceConnectivityProblem(peers: PeerLike[], status?: SyncStatusLike | null): boolean {
	if (
		status?.daemon_state === "offline-peers" ||
		status?.daemon_state === "stale" ||
		status?.daemon_state === "degraded"
	) {
		return true;
	}
	return peers.some((peer) => {
		const peerState = cleanText(peer.status?.peer_state);
		const trustState = derivePeerTrustSummary(peer).state;
		return (
			(peer.has_error === true && trustState !== "needs-repairing") ||
			trustState === "offline" ||
			trustState === "needs-review" ||
			peerState === "offline" ||
			peerState === "stale" ||
			peerState === "degraded"
		);
	});
}

function hasDaemonAttention(status?: SyncStatusLike | null): boolean {
	if (status?.daemon_running === false) return true;
	const state = status?.daemon_state;
	return (
		state !== undefined &&
		state !== "ok" &&
		state !== "offline-peers" &&
		state !== "stale" &&
		state !== "degraded"
	);
}

export function deriveTeamSyncPrimaryStatus(input: {
	status?: SyncStatusLike | null;
	coordinator?: CoordinatorLike | null;
	peers?: PeerLike[];
	shareOperations?: ProjectShareOperationLike[];
	shareOperationsLoadError?: boolean;
	reconciliation?: RecipientPolicyReconciliationLike | null;
}): UiTeamSyncPrimaryStatus {
	const coordinator = input.coordinator;
	const peers = Array.isArray(input.peers) ? input.peers : [];
	const operations = Array.isArray(input.shareOperations) ? input.shareOperations : [];
	const reconciliationItems = Array.isArray(input.reconciliation?.items)
		? input.reconciliation.items
		: [];
	const label = teamLabel(coordinator);
	const syncDisabled = input.status?.enabled === false || coordinator?.sync_enabled === false;

	if (syncDisabled) {
		return {
			state: "disabled",
			badgeLabel: "Sync off",
			meta: `Team: ${label}. Coordinator presence does not move Project data while sync is off.`,
			nextAction: "Open Settings and turn on sync before expecting Team or Project data to update.",
		};
	}

	if (input.shareOperationsLoadError) {
		return {
			state: "needs-attention",
			badgeLabel: "Refresh needed",
			meta: `Team: ${label}. Device diagnostics are available, but Project sharing status could not be refreshed.`,
			nextAction: "Refresh Team sync to retry loading Project sharing status.",
		};
	}

	const operationAttention = operations.find(
		(operation) => operation.lifecycle?.state === "needs_attention",
	);
	const reconciliationAttention = reconciliationItems.find(
		(item) => item.state === "needs_attention",
	);
	if (operationAttention || reconciliationAttention) {
		const project = operationAttention
			? projectLabel(operationAttention)
			: cleanText(reconciliationAttention?.canonicalProjectIdentity) || "the shared Project";
		return {
			state: "needs-attention",
			badgeLabel: "Needs attention",
			meta: `Team: ${label}. Exact-Project setup has not converged, so coordinator presence is not a healthy sync signal.`,
			nextAction: `Open Project sharing below and retry setup for ${project}.`,
		};
	}

	const pendingOperation = operations.find((operation) => {
		const state = operation.lifecycle?.state;
		return state !== undefined && PENDING_OPERATION_STATES.has(state);
	});
	const pendingReconciliation = reconciliationItems.find((item) => {
		const state = item.state;
		return state !== undefined && PENDING_RECONCILIATION_STATES.has(state);
	});
	if (pendingOperation || pendingReconciliation) {
		const project = pendingOperation
			? projectLabel(pendingOperation)
			: reconciliationProjectLabel(input.reconciliation ?? undefined);
		const primaryAction = pendingOperation?.lifecycle?.primary_action?.kind;
		return {
			state: "pending-setup",
			badgeLabel: "Setup pending",
			meta: `Team: ${label}. Exact-Project setup is still pending and data delivery is not confirmed.`,
			nextAction:
				primaryAction === "retry_setup"
					? `Open Project sharing below and retry setup for ${project}.`
					: primaryAction === "copy_invite"
						? `Copy the invitation for ${project} and send it to the recipient.`
						: `Keep both devices online, then sync again to finish setup for ${project}.`,
		};
	}

	if (hasDaemonAttention(input.status)) {
		return {
			state: "needs-attention",
			badgeLabel: "Sync needs attention",
			meta: `Team: ${label}. The local sync service is not healthy, so Project data delivery is not confirmed.`,
			nextAction:
				"Review the sync status below, restart codemem if needed, then run Sync now again.",
		};
	}

	if (hasTrustBlocker(peers, coordinator)) {
		return {
			state: "trust-blocked",
			badgeLabel: "Pairing needed",
			meta: `Team: ${label}. A device still needs two-way trust before Project data can sync.`,
			nextAction: "Review the device below and finish pairing or approval on both devices.",
		};
	}

	const presence = cleanText(coordinator?.presence_status);
	if (presence === "not_enrolled") {
		return {
			state: "not-enrolled",
			badgeLabel: "Not enrolled",
			meta: `Team: ${label}. This device is not enrolled with the coordinator.`,
			nextAction: "Paste a Team invite below, or ask a Team admin to enroll this device.",
		};
	}
	if (presence !== "posted") {
		return {
			state: "unreachable",
			badgeLabel: coordinator?.configured ? "Unreachable" : "Setup needed",
			meta: coordinator?.configured
				? `Team: ${label}. The coordinator is not currently reachable and no healthy data-plane sync is confirmed.`
				: "Configure or join a Team before expecting Project data to sync.",
			nextAction: coordinator?.configured
				? "Check the coordinator connection, then refresh Team sync."
				: "Paste a Team invite below, or configure a coordinator in Advanced settings.",
		};
	}

	if (hasDeviceConnectivityProblem(peers, input.status)) {
		return {
			state: "reachable",
			badgeLabel: "Check devices",
			meta: `Team: ${label}. The coordinator is reachable, but one or more paired devices are offline or degraded.`,
			nextAction:
				"Bring the paired devices online, check their sync errors, then run Sync now again.",
		};
	}

	if (coordinator?.sync_enabled === true && hasHealthyDataPlane(peers, input.status)) {
		return {
			state: "healthy",
			badgeLabel: "Healthy",
			meta: `Team: ${label}. Sync is enabled and a trusted device has a healthy data-plane connection.`,
			nextAction: null,
		};
	}
	if (hasReachableTrustedPeer(peers)) {
		return {
			state: "reachable",
			badgeLabel: "Reachable",
			meta: `Team: ${label}. The coordinator and a paired device are reachable, but successful Project sync is not confirmed.`,
			nextAction:
				"Run Sync now, then review the device sync status below if delivery is still pending.",
		};
	}

	return {
		state: "reachable",
		badgeLabel: "Reachable",
		meta: `Team: ${label}. The coordinator is reachable, but healthy Project data sync is not confirmed.`,
		nextAction: "Pair and approve a device, then run Sync now to confirm data delivery.",
	};
}
