import { cleanText } from "./internal";
import { derivePeerScopeSyncView, derivePeerTrustSummary } from "./peer-status";
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

type PrimaryStatusInput = {
	status?: SyncStatusLike | null;
	coordinator?: CoordinatorLike | null;
	peers?: PeerLike[];
	shareOperations?: ProjectShareOperationLike[];
	shareOperationsLoadError?: boolean;
	reconciliation?: RecipientPolicyReconciliationLike | null;
};

type NormalizedPrimaryStatusInput = {
	status?: SyncStatusLike | null;
	coordinator?: CoordinatorLike | null;
	peers: PeerLike[];
	operations: ProjectShareOperationLike[];
	reconciliationItems: NonNullable<RecipientPolicyReconciliationLike["items"]>;
	shareOperationsLoadError: boolean;
	label: string;
};

const PENDING_OPERATION_STATES: ReadonlySet<TeamSyncProjectOperationState> = new Set([
	"pending_setup",
	"waiting_for_acceptance",
	"provisioning",
	"initial_sync",
	"waiting_for_device",
	"revoking",
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
			peer.status?.sync_status === "ok" &&
			derivePeerTrustSummary(peer).state === "mutual-trust" &&
			!derivePeerScopeSyncView(peer).rows.some((scope) => scope.status === "pending"),
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

function normalizeInput(input: PrimaryStatusInput): NormalizedPrimaryStatusInput {
	return {
		status: input.status,
		coordinator: input.coordinator,
		peers: Array.isArray(input.peers) ? input.peers : [],
		operations: Array.isArray(input.shareOperations) ? input.shareOperations : [],
		reconciliationItems: Array.isArray(input.reconciliation?.items)
			? input.reconciliation.items
			: [],
		shareOperationsLoadError: input.shareOperationsLoadError === true,
		label: teamLabel(input.coordinator),
	};
}

function derivePolicyStatus(input: NormalizedPrimaryStatusInput): UiTeamSyncPrimaryStatus | null {
	if (input.status?.enabled === false || input.coordinator?.sync_enabled === false) {
		return {
			state: "disabled",
			badgeLabel: "Sync off",
			meta: `Team: ${input.label}. Coordinator presence does not move Project data while sync is off.`,
			nextAction: "Open Settings and turn on sync before expecting Team or Project data to update.",
		};
	}
	if (input.shareOperationsLoadError) {
		return {
			state: "needs-attention",
			badgeLabel: "Refresh needed",
			meta: `Team: ${input.label}. Device diagnostics are available, but Project sharing status could not be refreshed.`,
			nextAction: "Refresh Team sync to retry loading Project sharing status.",
		};
	}
	const operationAttention = input.operations.find(
		(operation) => operation.lifecycle?.state === "needs_attention",
	);
	const reconciliationAttention = input.reconciliationItems.find(
		(item) => item.state === "needs_attention",
	);
	if (operationAttention) {
		return {
			state: "needs-attention",
			badgeLabel: "Needs attention",
			meta: `Team: ${input.label}. A Project access update stopped and needs a retry.`,
			nextAction: "Retry the stopped Project access update below.",
		};
	}
	if (reconciliationAttention) {
		return {
			state: "needs-attention",
			badgeLabel: "Needs attention",
			meta: `Team: ${input.label}. A Project access reconciliation needs review.`,
			nextAction: "Open Sharing, review this Project's access decision, then sync again.",
		};
	}
	return null;
}

function pendingNextAction(
	operation: ProjectShareOperationLike | undefined,
	project: string,
): string {
	if (operation?.lifecycle?.state === "revoking") {
		return `Keep both devices online, then sync again to finish removing future access for ${project}.`;
	}
	const action = operation?.lifecycle?.primary_action?.kind;
	if (action === "retry_setup") return `Open Project sharing below and retry setup for ${project}.`;
	if (action === "copy_invite") {
		return `Copy the invitation for ${project} and send it to the recipient.`;
	}
	return `Keep both devices online, then sync again to finish setup for ${project}.`;
}

function derivePendingStatus(input: NormalizedPrimaryStatusInput): UiTeamSyncPrimaryStatus | null {
	const pendingOperation = input.operations.find((operation) => {
		const state = operation.lifecycle?.state;
		return state !== undefined && PENDING_OPERATION_STATES.has(state);
	});
	const pendingReconciliation = input.reconciliationItems.find((item) => {
		const state = item.state;
		return state !== undefined && PENDING_RECONCILIATION_STATES.has(state);
	});
	if (!pendingOperation && !pendingReconciliation) return null;
	const project = pendingOperation ? projectLabel(pendingOperation) : "the shared Project";
	const revoking = pendingOperation?.lifecycle?.state === "revoking";
	return {
		state: "pending-setup",
		badgeLabel: revoking ? "Removal pending" : "Setup pending",
		meta: revoking
			? `Team: ${input.label}. Future access removal for ${project} is still pending.`
			: `Team: ${input.label}. Exact-Project setup is still pending and data delivery is not confirmed.`,
		nextAction: pendingNextAction(pendingOperation, project),
	};
}

function deriveRuntimeStatus(input: NormalizedPrimaryStatusInput): UiTeamSyncPrimaryStatus | null {
	if (hasDaemonAttention(input.status)) {
		return {
			state: "needs-attention",
			badgeLabel: "Sync needs attention",
			meta: `Team: ${input.label}. The local sync service is not healthy, so Project data delivery is not confirmed.`,
			nextAction:
				"Review the sync status below, restart codemem if needed, then run Sync now again.",
		};
	}
	if (hasTrustBlocker(input.peers, input.coordinator)) {
		return {
			state: "trust-blocked",
			badgeLabel: "Pairing needed",
			meta: `Team: ${input.label}. A device still needs two-way trust before Project data can sync.`,
			nextAction: "Review the device below and finish pairing or approval on both devices.",
		};
	}
	return null;
}

function derivePresenceStatus(input: NormalizedPrimaryStatusInput): UiTeamSyncPrimaryStatus | null {
	const presence = cleanText(input.coordinator?.presence_status);
	if (presence === "not_enrolled") {
		return {
			state: "not-enrolled",
			badgeLabel: "Not enrolled",
			meta: `Team: ${input.label}. This device is not enrolled with the coordinator.`,
			nextAction: "Paste a Team invite below, or ask a Team admin to enroll this device.",
		};
	}
	if (presence !== "posted") {
		const configured = input.coordinator?.configured === true;
		return {
			state: "unreachable",
			badgeLabel: configured ? "Unreachable" : "Setup needed",
			meta: configured
				? `Team: ${input.label}. The coordinator is not currently reachable and no healthy data-plane sync is confirmed.`
				: "Configure or join a Team before expecting Project data to sync.",
			nextAction: configured
				? "Check the coordinator connection, then refresh Team sync."
				: "Paste a Team invite below, or set a coordinator URL in Settings → Device Sync.",
		};
	}
	return null;
}

function deriveDataPlaneStatus(input: NormalizedPrimaryStatusInput): UiTeamSyncPrimaryStatus {
	if (hasDeviceConnectivityProblem(input.peers, input.status)) {
		return {
			state: "reachable",
			badgeLabel: "Check devices",
			meta: `Team: ${input.label}. The coordinator is reachable, but one or more paired devices are offline or degraded.`,
			nextAction:
				"Bring the paired devices online, check their sync errors, then run Sync now again.",
		};
	}
	if (input.coordinator?.sync_enabled === true && hasHealthyDataPlane(input.peers, input.status)) {
		return {
			state: "healthy",
			badgeLabel: "Healthy",
			meta: `Team: ${input.label}. Sync is enabled and a trusted device has a healthy data-plane connection.`,
			nextAction: null,
		};
	}
	if (hasReachableTrustedPeer(input.peers)) {
		return {
			state: "reachable",
			badgeLabel: "Reachable",
			meta: `Team: ${input.label}. The coordinator and a paired device are reachable, but successful Project sync is not confirmed.`,
			nextAction:
				"Run Sync now, then review the device sync status below if delivery is still pending.",
		};
	}

	return {
		state: "reachable",
		badgeLabel: "Reachable",
		meta: `Team: ${input.label}. The coordinator is reachable, but healthy Project data sync is not confirmed.`,
		nextAction: "Pair and approve a device, then run Sync now to confirm data delivery.",
	};
}

export function deriveTeamSyncPrimaryStatus(input: PrimaryStatusInput): UiTeamSyncPrimaryStatus {
	const normalized = normalizeInput(input);
	return (
		derivePolicyStatus(normalized) ??
		derivePendingStatus(normalized) ??
		deriveRuntimeStatus(normalized) ??
		derivePresenceStatus(normalized) ??
		deriveDataPlaneStatus(normalized)
	);
}
