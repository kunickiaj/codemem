/* Sharing review renderer for the team-sync card — renders the
 * "Teammates are receiving your memories" review surface and routes
 * the "Review" CTA back to the Feed tab filtered by the current actor. */

import { h } from "preact";
import { setFeedScopeFilter, state } from "../../../../lib/state";
import { clearSyncMount, renderIntoSyncMount } from "../../components/render-root";
import {
	SyncSharingReview,
	type SyncSharingReviewItem,
} from "../../components/sync-sharing-review";

function openFeedSharingReview() {
	setFeedScopeFilter("mine");
	state.feedQuery = "";
	window.location.hash = "feed";
}

function openProjectsReview() {
	window.location.hash = "projects";
}

export function renderSyncSharingReview() {
	const panel = document.getElementById("syncSharingReview");
	const meta = document.getElementById("syncSharingReviewMeta");
	const list = document.getElementById("syncSharingReviewList") as HTMLElement | null;
	if (!panel || !meta || !list) return;
	const title = panel.querySelector<HTMLElement>(".settings-group-title");
	const items = Array.isArray(state.lastSyncSharingReview) ? state.lastSyncSharingReview : [];
	const legacyRaw = state.lastSyncLegacySharedReview;
	const legacyCount = Math.max(0, Number(legacyRaw?.memory_count ?? 0));
	const legacyReview = legacyRaw?.has_data
		? {
				groups: Array.isArray(legacyRaw.groups)
					? legacyRaw.groups.map((group) => {
							const raw = group as Record<string, unknown>;
							return {
								displayProject: String(raw.display_project || raw.project || "Unknown project"),
								identitySource: String(raw.identity_source || "unknown"),
								lastUpdatedAt: typeof raw.last_updated_at === "string" ? raw.last_updated_at : null,
								memoryCount: Number(raw.memory_count || 0),
								suggestedScopeId:
									typeof raw.suggested_scope_id === "string" ? raw.suggested_scope_id : null,
								suggestionReason:
									typeof raw.suggestion_reason === "string" ? raw.suggestion_reason : null,
								workspaceIdentity: String(
									raw.workspace_identity || raw.display_project || "unknown",
								),
							};
						})
					: [],
				memoryCount: legacyCount,
				scopeId: String(legacyRaw.scope_id || "legacy-shared-review"),
			}
		: null;
	if (!items.length && !legacyReview) {
		clearSyncMount(list);
		panel.hidden = true;
		return;
	}
	panel.hidden = false;
	if (title) title.textContent = legacyReview ? "Sharing review" : "What teammates will receive";
	const scopeLabel = state.currentProject
		? `current project (${state.currentProject})`
		: "all allowed projects";
	meta.textContent = legacyReview
		? `Review conservative upgrade state before promoting historical shared data. Teammates receive memories from ${scopeLabel} by default once Sharing-domain grants allow it.`
		: `Teammates receive memories from ${scopeLabel} by default. Use Only me on a memory when it should stay local.`;
	const reviewItems: SyncSharingReviewItem[] = items.map((item) => ({
		actorDisplayName: String(item.actor_display_name || item.actor_id || "unknown"),
		actorId: String(item.actor_id || "unknown"),
		peerName: String(item.peer_name || item.peer_device_id || "Device"),
		privateCount: Number(item.private_count || 0),
		scopeLabel: String(item.scope_label || "All allowed projects"),
		shareableCount: Number(item.shareable_count || 0),
	}));
	renderIntoSyncMount(
		list,
		h(SyncSharingReview, {
			items: reviewItems,
			legacyReview,
			onLegacyReview: openProjectsReview,
			onReview: openFeedSharingReview,
		}),
	);
}
