/* API fetch wrappers — barrel re-export of the split modules. The
 * viewer HTTP endpoints were broken up into api/ (types.ts,
 * internal.ts, runtime.ts, stats.ts, memories.ts, config.ts, sync.ts,
 * coordinator-admin.ts) during the decomposition; this file now only
 * keeps the public API stable for `import * as api from "../lib/api"`
 * call sites. */

export { loadConfig, loadObserverStatus, saveConfig } from "./api/config";
export {
	archiveCoordinatorAdminGroup,
	createCoordinatorAdminGroup,
	createCoordinatorAdminScope,
	createCoordinatorInvite,
	disableCoordinatorAdminDevice,
	enableCoordinatorAdminDevice,
	grantCoordinatorAdminScopeMember,
	loadCoordinatorAdminDevices,
	loadCoordinatorAdminGroups,
	loadCoordinatorAdminGroupsFiltered,
	loadCoordinatorAdminJoinRequests,
	loadCoordinatorAdminScopeMembers,
	loadCoordinatorAdminScopes,
	loadCoordinatorAdminStatus,
	removeCoordinatorAdminDevice,
	renameCoordinatorAdminDevice,
	renameCoordinatorAdminGroup,
	reviewCoordinatorAdminJoinRequest,
	revokeCoordinatorAdminScopeMember,
	unarchiveCoordinatorAdminGroup,
	updateCoordinatorAdminScope,
} from "./api/coordinator-admin";
export {
	forgetMemory,
	loadMemories,
	loadMemoriesPage,
	loadSummaries,
	loadSummariesPage,
	moveMemoryProject,
	tracePack,
	updateMemoryVisibility,
} from "./api/memories";
export { loadProjects, loadRuntimeInfo, pingViewerReady } from "./api/runtime";
export { loadRawEvents, loadSession, loadStats, loadUsage } from "./api/stats";
export {
	acceptDiscoveredPeer,
	assignPeerActor,
	claimLegacyDeviceIdentity,
	createActor,
	deactivateActor,
	deletePeer,
	deleteSharingDomainProjectMapping,
	enrollPeer,
	importCoordinatorInvite,
	loadCoordinatorGroupPreferences,
	loadPairing,
	loadSharingDomainSettings,
	loadSyncActors,
	loadSyncStatus,
	mergeActor,
	renameActor,
	renamePeer,
	saveCoordinatorGroupPreferences,
	saveSharingDomainProjectMapping,
	triggerSync,
	updatePeerIdentity,
	updatePeerScope,
} from "./api/sync";
export type {
	AcceptDiscoveredPeerResult,
	CoordinatorInviteResult,
	ImportInviteResult,
	PackTrace,
	PackTraceCandidate,
	PaginatedResponse,
	RuntimeInfo,
	SyncRunItem,
	SyncRunResponse,
} from "./api/types";
