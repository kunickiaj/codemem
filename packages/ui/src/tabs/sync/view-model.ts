/* Derived sync view-model — barrel re-export of the split modules.
 * The view-model was broken up into view-model/ (types.ts, internal.ts,
 * device-names.ts, peer-status.ts, coordinator-approval.ts,
 * people-derivations.ts, sync-view-model.ts) during the UI god-file
 * decomposition; this file now only re-exports the public API so
 * call sites in the sync tabs, state.ts, and the test file stay on
 * the same import path. */

export {
	deriveCoordinatorApprovalSummary,
	shouldShowCoordinatorReviewAction,
	summarizeSyncRunResult,
} from "./view-model/coordinator-approval";
export { deviceNeedsFriendlyName, resolveFriendlyDeviceName } from "./view-model/device-names";
export {
	derivePeerAuthorizedDomainsView,
	derivePeerDirection,
	derivePeerProjectNarrowingView,
	derivePeerScopeRejectionsView,
	derivePeerTrustSummary,
	derivePeerUiStatus,
	type PeerAuthorizedDomainsView,
	type PeerAuthorizedDomainViewItem,
	type PeerProjectNarrowingView,
	type PeerScopeRejectionsView,
} from "./view-model/peer-status";
export {
	deriveDuplicatePeople,
	deriveVisiblePeopleActors,
} from "./view-model/people-derivations";
export { deriveSyncViewModel } from "./view-model/sync-view-model";
export {
	type ActorLike,
	type DiscoveredDeviceLike,
	type PeerAuthorizedScopeLike,
	type PeerClaimedLocalActorScopeLike,
	type PeerDirection,
	type PeerLike,
	type PeerProjectScopeLike,
	type PeerRecentOps,
	type PeerScopeRejectionReason,
	type PeerScopeRejectionsSummary,
	SYNC_TERMINOLOGY,
	type UiCoordinatorApprovalState,
	type UiCoordinatorApprovalSummary,
	type UiDuplicatePersonCandidate,
	type UiPeerTrustSummary,
	type UiSyncAttentionItem,
	type UiSyncRunItem,
	type UiSyncRunResponse,
	type UiSyncStatus,
	type UiSyncViewModel,
	type UiTrustState,
	type VisiblePeopleResult,
} from "./view-model/types";
