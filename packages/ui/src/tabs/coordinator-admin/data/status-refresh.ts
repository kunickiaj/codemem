import * as api from "../../../lib/api";
import { state } from "../../../lib/state";
import {
	beginSurfaceRefresh,
	cancelSurfaceRefresh,
	completeSurfaceRefresh,
	failSurfaceRefresh,
} from "./recovery";
import {
	beginCoordinatorAdminLoadGeneration,
	coordinatorAdminState,
	isCurrentCoordinatorAdminLoadGeneration,
} from "./state";
import { coordinatorUrlForMatching } from "./target-group";

export type CoordinatorAdminStatusRefreshResult = "fresh" | "failed" | "superseded";

function invalidateCoordinatorScopedState(): void {
	state.lastCoordinatorAdminGroups = [];
	state.lastCoordinatorAdminJoinRequests = [];
	state.lastCoordinatorAdminDevices = [];
	state.lastTeamInvite = null;
	state.coordinatorAdminTargetGroup = "";
	failSurfaceRefresh(coordinatorAdminState.recovery, "groups", false);
	failSurfaceRefresh(coordinatorAdminState.recovery, "joinRequests", false);
	failSurfaceRefresh(coordinatorAdminState.recovery, "devices", false);
	coordinatorAdminState.joinRequestsSnapshotTarget = null;
	coordinatorAdminState.devicesSnapshotTarget = null;
	coordinatorAdminState.groupRenameDrafts.clear();
	coordinatorAdminState.groupPresentationAliases.clear();
	coordinatorAdminState.deviceRenameDrafts.clear();
	coordinatorAdminState.deviceRenameServerNames.clear();
	coordinatorAdminState.groupPreferencesOpen.clear();
	coordinatorAdminState.groupPreferencesDrafts.clear();
	coordinatorAdminState.groupScopeManagementOpen.clear();
	coordinatorAdminState.groupScopeManagementDrafts.clear();
	coordinatorAdminState.inviteGroup = "";
	coordinatorAdminState.teamSetupGuide = null;
}

export function beginStandaloneCoordinatorAdminStatusRefresh(): number {
	const generation = beginCoordinatorAdminLoadGeneration();
	beginSurfaceRefresh(coordinatorAdminState.recovery, "status");
	cancelSurfaceRefresh(coordinatorAdminState.recovery, "groups");
	cancelSurfaceRefresh(coordinatorAdminState.recovery, "joinRequests");
	cancelSurfaceRefresh(coordinatorAdminState.recovery, "devices");
	return generation;
}

export async function refreshCoordinatorAdminStatusForGeneration(
	generation: number,
): Promise<CoordinatorAdminStatusRefreshResult> {
	try {
		const status = await api.loadCoordinatorAdminStatus();
		if (!isCurrentCoordinatorAdminLoadGeneration(generation)) return "superseded";
		if (!status || typeof status !== "object") throw new Error("Invalid status payload");
		const previousStatus = state.lastCoordinatorAdminStatus;
		if (
			coordinatorUrlForMatching(previousStatus?.coordinator_url) !==
			coordinatorUrlForMatching((status as { coordinator_url?: unknown }).coordinator_url)
		) {
			invalidateCoordinatorScopedState();
		}
		state.lastCoordinatorAdminStatus = status as typeof state.lastCoordinatorAdminStatus;
		completeSurfaceRefresh(coordinatorAdminState.recovery, "status");
		return "fresh";
	} catch {
		if (!isCurrentCoordinatorAdminLoadGeneration(generation)) return "superseded";
		failSurfaceRefresh(coordinatorAdminState.recovery, "status");
		return "failed";
	}
}
